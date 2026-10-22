const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { initFragMode } = require("./frag/server");
const { initZPlusMode } = require("./frag/z_plus/server");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

const server = http.createServer(app);
const io = new Server(server, {
  path: "/socket.io",
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
  allowEIO3: true,
  // A 5s pong timeout dropped players whenever a phone stalled briefly (app
  // switch, shader compile, weak signal) — they then reconnected and
  // re-downloaded the whole world. 20s rides those out.
  pingInterval: 15000,
  pingTimeout: 20000,
  // Compress ONLY big messages (the ~700KB world sent on join -> ~100KB);
  // the 15-20Hz snapshots stay below the threshold, so no per-tick CPU cost.
  httpCompression: { threshold: 64 * 1024 },
  perMessageDeflate: {
    threshold: 64 * 1024,
    zlibDeflateOptions: { level: 4, memLevel: 7 },
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
  },
});

// CRITICAL: Use prependListener so this runs BEFORE Socket.io's own listeners
const rewriteSocketPath = (req) => {
  if (req.url.includes("/socket.io/")) {
    const sIdx = req.url.indexOf("/socket.io/");
    if (sIdx > 0) {
      const oldUrl = req.url;
      req.url = req.url.substring(sIdx);
      // Only log in dev or periodically to avoid flooding
      if (process.env.DEBUG_SOCKET) console.log(`Rewrote: ${oldUrl} -> ${req.url}`);
    }
  }
};

server.prependListener("request", rewriteSocketPath);
server.prependListener("upgrade", rewriteSocketPath);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const PITCH_WIDTH = 800;
const PITCH_HEIGHT = 500;
const PLAYER_RADIUS = 20;
const BALL_RADIUS = 12;
const GOAL_SIZE = 120;
const TICK_RATE = 45; // Lowered from 60 to reduce CPU load

const PLAYER_SPEED = 260;
const PLAYER_JUMP_VELOCITY = 420;
const PLAYER_GRAVITY = 950;

const BALL_FRICTION = 0.96;
const BALL_BOUNCE = 0.78;
const BALL_GRAVITY = 560;
const BALL_HIT_POWER = 390;

const PLAY_TIME_MS = 5 * 60 * 1000;
const COOLDOWN_TIME_MS = 1 * 60 * 1000;
// 30 Hz: at 22 Hz (≈45 ms spacing) the client's 100 ms interpolation buffer
// held only ~2 packets, so any network jitter underran it and remote players
// visibly stuttered/snapped. 30 Hz (≈33 ms) keeps ~3 packets buffered — much
// smoother others — at modest extra bandwidth (positions are rounded + volatile).
const STATE_BROADCAST_RATE = 30;
const GOAL_FREEZE_MS = 1000;
const STATIC_META = {
  width: PITCH_WIDTH,
  height: PITCH_HEIGHT,
  playerRadius: PLAYER_RADIUS,
  ballRadius: BALL_RADIUS,
  goalSize: GOAL_SIZE,
  tickRate: TICK_RATE,
};

const players = new Map();
const votes = new Set();
let score = { red: 0, blue: 0 };
let phase = "playing";
let phaseStartedAt = Date.now();
let phaseDurationMs = PLAY_TIME_MS;
let lastTickAt = Date.now();
let lastStateBroadcastAt = 0;
let kickoffAt = 0;
let goalSequence = 0;
let latestGoalEvent = null;

function createInitialBall() {
  return {
    x: PITCH_WIDTH / 2,
    y: PITCH_HEIGHT / 2,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
  };
}

function sanitizeName(raw) {
  if (typeof raw !== "string") {
    return "";
  }

  return raw.replace(/\s+/g, " ").trim().slice(0, 18);
}

function chooseTeam() {
  let redCount = 0;
  let blueCount = 0;
  for (const player of players.values()) {
    if (player.team === "red") redCount += 1;
    if (player.team === "blue") blueCount += 1;
  }
  return redCount <= blueCount ? "red" : "blue";
}

function resetBall() {
  ball = createInitialBall();
}

function getSpawnForTeam(team) {
  return {
    x: team === "red" ? 110 : PITCH_WIDTH - 110,
    y: PITCH_HEIGHT / 2,
  };
}

function resetPlayersToInitialPositions() {
  let redOffset = -30;
  let blueOffset = -30;

  for (const player of players.values()) {
    const spawn = getSpawnForTeam(player.team);
    const laneOffset = player.team === "red" ? redOffset : blueOffset;

    player.x = spawn.x;
    player.y = Math.max(
      PLAYER_RADIUS,
      Math.min(PITCH_HEIGHT - PLAYER_RADIUS, spawn.y + laneOffset),
    );
    player.z = 0;
    player.vx = 0;
    player.vy = 0;
    player.vz = 0;
    player.lastJumpPressed = false;

    if (player.team === "red") redOffset += 20;
    else blueOffset += 20;
  }
}

function currentPhaseTimeRemainingMs(now) {
  return Math.max(0, phaseStartedAt + phaseDurationMs - now);
}

function switchPhase(nextPhase, now) {
  phase = nextPhase;
  phaseStartedAt = now;
  phaseDurationMs = nextPhase === "playing" ? PLAY_TIME_MS : COOLDOWN_TIME_MS;
  kickoffAt = 0;
  votes.clear();

  if (nextPhase === "playing") {
    score = { red: 0, blue: 0 };
  }
  latestGoalEvent = null;
  resetBall();
  resetPlayersToInitialPositions();
}

function isKickoffPending(now) {
  return kickoffAt > now;
}

function startGoalFreeze(now) {
  kickoffAt = now + GOAL_FREEZE_MS;
  ball.vx = 0;
  ball.vy = 0;
  ball.vz = 0;
}

function registerGoal(scoringTeam, now) {
  goalSequence += 1;
  latestGoalEvent = { seq: goalSequence, team: scoringTeam, at: now };
  startGoalFreeze(now);
  emitGameState(now, true);
}

function maybeRunKickoffReset(now) {
  if (!kickoffAt || kickoffAt > now) return;
  kickoffAt = 0;
  latestGoalEvent = null;
  resetBall();
  resetPlayersToInitialPositions();
}

function maybeAdvancePhase(now) {
  while (currentPhaseTimeRemainingMs(now) <= 0) {
    if (phase === "playing") {
      switchPhase("cooldown", now);
    } else {
      switchPhase("playing", now);
    }
  }
}

let ball = createInitialBall();

function applyPlayerPhysics(player, dtSec) {
  const input = player.input;
  let dirX = 0;
  let dirY = 0;

  if (input.left) dirX -= 1;
  if (input.right) dirX += 1;
  if (input.up) dirY -= 1;
  if (input.down) dirY += 1;

  if (dirX !== 0 || dirY !== 0) {
    const mag = Math.hypot(dirX, dirY);
    player.vx = (dirX / mag) * PLAYER_SPEED;
    player.vy = (dirY / mag) * PLAYER_SPEED;
  } else {
    player.vx = 0;
    player.vy = 0;
  }

  if (input.jump && !player.lastJumpPressed && player.z === 0) {
    player.vz = PLAYER_JUMP_VELOCITY;
  }
  player.lastJumpPressed = input.jump;

  player.x += player.vx * dtSec;
  player.y += player.vy * dtSec;
  player.z += player.vz * dtSec;
  player.vz -= PLAYER_GRAVITY * dtSec;

  if (player.z <= 0) {
    player.z = 0;
    if (player.vz < 0) player.vz = 0;
  }

  player.x = Math.max(PLAYER_RADIUS, Math.min(PITCH_WIDTH - PLAYER_RADIUS, player.x));
  player.y = Math.max(PLAYER_RADIUS, Math.min(PITCH_HEIGHT - PLAYER_RADIUS, player.y));
}

function applyBallPhysics(dtSec, now) {
  ball.x += ball.vx * dtSec;
  ball.y += ball.vy * dtSec;
  ball.z += ball.vz * dtSec;

  ball.vz -= BALL_GRAVITY * dtSec;

  if (ball.z <= 0) {
    ball.z = 0;
    if (Math.abs(ball.vz) < 40) {
      ball.vz = 0;
    } else {
      ball.vz = -ball.vz * 0.5;
    }
    ball.vx *= BALL_FRICTION;
    ball.vy *= BALL_FRICTION;
  }

  if (ball.x < BALL_RADIUS) {
    if (Math.abs(ball.y - PITCH_HEIGHT / 2) <= GOAL_SIZE / 2) {
      score.blue += 1;
      registerGoal("blue", now);
      return;
    }
    ball.x = BALL_RADIUS;
    ball.vx = Math.abs(ball.vx) * BALL_BOUNCE;
  }

  if (ball.x > PITCH_WIDTH - BALL_RADIUS) {
    if (Math.abs(ball.y - PITCH_HEIGHT / 2) <= GOAL_SIZE / 2) {
      score.red += 1;
      registerGoal("red", now);
      return;
    }
    ball.x = PITCH_WIDTH - BALL_RADIUS;
    ball.vx = -Math.abs(ball.vx) * BALL_BOUNCE;
  }

  if (ball.y < BALL_RADIUS) {
    ball.y = BALL_RADIUS;
    ball.vy = Math.abs(ball.vy) * BALL_BOUNCE;
  }

  if (ball.y > PITCH_HEIGHT - BALL_RADIUS) {
    ball.y = PITCH_HEIGHT - BALL_RADIUS;
    ball.vy = -Math.abs(ball.vy) * BALL_BOUNCE;
  }
}

function processBallCollisions() {
  for (const player of players.values()) {
    const dx = ball.x - player.x;
    const dy = ball.y - player.y;
    const dist = Math.hypot(dx, dy);
    const contactDist = PLAYER_RADIUS + BALL_RADIUS;

    if (dist >= contactDist || Math.abs(ball.z - player.z) > 35) {
      continue;
    }

    const nx = dist > 0 ? dx / dist : 1;
    const ny = dist > 0 ? dy / dist : 0;
    const push = contactDist - dist;

    ball.x += nx * push;
    ball.y += ny * push;

    ball.vx = nx * BALL_HIT_POWER + player.vx * 0.35;
    ball.vy = ny * BALL_HIT_POWER + player.vy * 0.35;
    if (player.z > 6) {
      ball.vz = 260;
    }
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function getStateSnapshot(now = Date.now(), includeMeta = false) {
  const kickoffCountdownMs = Math.max(0, kickoffAt - now);
  const snapshot = {
    gameState: phase,
    kickoffCountdownMs,
    timerMs: currentPhaseTimeRemainingMs(now),
    score: { red: score.red, blue: score.blue },
    goalEvent: latestGoalEvent,
    voteStatus: {
      count: votes.size,
      total: players.size,
    },
    ball: {
      x: round2(ball.x),
      y: round2(ball.y),
      z: round2(ball.z),
      vx: round2(ball.vx),
      vy: round2(ball.vy),
      vz: round2(ball.vz),
    },
    players: Array.from(players.values()).map((player) => ({
      id: player.id,
      name: player.name,
      team: player.team,
      x: round2(player.x),
      y: round2(player.y),
      z: round2(player.z),
      vx: round2(player.vx),
      vy: round2(player.vy),
      vz: round2(player.vz),
    })),
    serverTime: now,
  };
  if (includeMeta) snapshot.meta = STATIC_META;
  return snapshot;
}

function emitGameState(now = Date.now(), reliable = false, includeMeta = false) {
  const payload = getStateSnapshot(now, includeMeta || reliable);
  if (reliable) {
    io.emit("state", payload);
    return;
  }
  io.volatile.emit("state", payload);
}

function gameLoop() {
  const now = Date.now();
  const dtSec = Math.min(0.05, (now - lastTickAt) / 1000);
  lastTickAt = now;

  maybeAdvancePhase(now);
  maybeRunKickoffReset(now);

  if (phase === "playing" && !isKickoffPending(now)) {
    for (const player of players.values()) {
      applyPlayerPhysics(player, dtSec);
    }
    processBallCollisions();
    applyBallPhysics(dtSec, now);
  }

  if (now - lastStateBroadcastAt >= Math.floor(1000 / STATE_BROADCAST_RATE)) {
    lastStateBroadcastAt = now;
    emitGameState(now, false);
  }
}

setInterval(gameLoop, Math.floor(1000 / TICK_RATE));

io.on("connection", (socket) => {
  socket.on("join", (rawName, ack) => {
    if (players.has(socket.id)) {
      if (typeof ack === "function") ack({ ok: true, id: socket.id });
      return;
    }

    const team = chooseTeam();
    const name = sanitizeName(rawName) || `Player-${socket.id.slice(0, 4)}`;

    const spawn = getSpawnForTeam(team);
    const spawnY = spawn.y + (Math.random() * 80 - 40);

    players.set(socket.id, {
      id: socket.id,
      name,
      team,
      x: spawn.x,
      y: Math.max(PLAYER_RADIUS, Math.min(PITCH_HEIGHT - PLAYER_RADIUS, spawnY)),
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      lastJumpPressed: false,
      input: {
        left: false,
        right: false,
        up: false,
        down: false,
        jump: false,
      },
    });

    socket.emit("joined", getStateSnapshot(Date.now(), true));
    if (typeof ack === "function") ack({ ok: true, id: socket.id });
    emitGameState(Date.now(), true);
  });

  socket.on("move", (input) => {
    const player = players.get(socket.id);
    if (!player || !input || typeof input !== "object") return;

    player.input.left = Boolean(input.left);
    player.input.right = Boolean(input.right);
    player.input.up = Boolean(input.up);
    player.input.down = Boolean(input.down);
    player.input.jump = Boolean(input.jump);
  });

  socket.on("vote_skip", () => {
    if (phase !== "cooldown" || !players.has(socket.id)) return;
    votes.add(socket.id);
    const now = Date.now();
    const remaining = currentPhaseTimeRemainingMs(now);
    if (votes.size >= players.size && players.size > 0 && remaining > 30000) {
      phaseDurationMs = (now - phaseStartedAt) + 4000;
    }
    emitGameState(now, true);
  });

  socket.on("ping_check", (ack) => {
    if (typeof ack === "function") {
      ack({ serverTime: Date.now() });
    }
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);
    votes.delete(socket.id);
    emitGameState(Date.now(), true);
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    players: players.size,
    gameState: phase,
  });
});

app.get("/favicon.ico", (_req, res) => {
  res.status(204).end();
});

app.get("/", (_req, res) => {
  res.redirect("/micro");
});

// Football routes: local (/micro) + prod-prefixed (/demo/micro)
app.get("/micro", (_req, res) => {
  if (!_req.path.endsWith("/")) {
    res.redirect("/micro/");
    return;
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/micro/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.use("/micro", express.static(path.join(__dirname, "public")));

app.get("/demo", (_req, res) => {
  res.redirect("/demo/micro");
});
app.get("/demo/micro", (_req, res) => {
  if (!_req.path.endsWith("/")) {
    res.redirect("/demo/micro/");
    return;
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/demo/micro/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.use("/demo/micro", express.static(path.join(__dirname, "public")));
initZPlusMode(app, io, __dirname);
initFragMode(app, io, __dirname);

server.listen(PORT, HOST, () => {
  console.log(`micro-football listening on http://${HOST}:${PORT}`);
});
