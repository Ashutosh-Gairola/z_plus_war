const getSocketPath = () => {
  const p = window.location.pathname;
  if (p.includes("/demo/micro")) return "/demo/micro/socket.io";
  if (p.includes("/micro")) return "/micro/socket.io";
  return "/socket.io";
};

const socket = io({
  path: getSocketPath(),
  transports: ["websocket", "polling"],
  upgrade: true,
  rememberUpgrade: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 10000,
  // Disable perMessageDeflate on client too for lower CPU overhead
  perMessageDeflate: false,
});

const loginPanel = document.getElementById("loginPanel");
const gamePanel = document.getElementById("gamePanel");
const loginForm = document.getElementById("loginForm");
const nameInput = document.getElementById("nameInput");
const statusEl = document.getElementById("status");
const redScoreEl = document.getElementById("redScore");
const blueScoreEl = document.getElementById("blueScore");
const pingEl = document.getElementById("ping");
const timerEl = document.getElementById("timer");
const canvas = document.getElementById("gameCanvas");
const gameStage = document.querySelector(".game-stage");
const orientationOverlay = document.getElementById("orientationOverlay");
const cooldownOverlay = document.getElementById("cooldownOverlay");
const cooldownPlayerList = document.getElementById("cooldownPlayerList");
const voteSkipButton = document.getElementById("voteSkipButton");
const goalBanner = document.getElementById("goalBanner");
const mobileControls = document.getElementById("mobileControls");
const joystickBase = document.getElementById("joystickBase");
const joystickKnob = document.getElementById("joystickKnob");
const jumpButton = document.getElementById("jumpButton");
const ctx = canvas.getContext("2d");

let votedToSkip = false;

function detectMobileClient() {
  const ua = navigator.userAgent || "";
  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const isMobileUA = /iPhone|iPod|Android.*Mobile|Windows Phone|webOS|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua);
  const forceMobile = window.location.search.includes("mobile=true");

  return forceMobile || isMobileUA || isTouchDevice;
}

const isMobileClient = detectMobileClient();
if (isMobileClient) {
  document.body.classList.add("mobile-mode");
}

const input = {
  left: false,
  right: false,
  up: false,
  down: false,
  jump: false,
};

const keyboardInput = {
  left: false,
  right: false,
  up: false,
  down: false,
  jump: false,
};

const touchInput = {
  left: false,
  right: false,
  up: false,
  down: false,
  jump: false,
};

const keyMap = new Map([
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
  ["a", "left"],
  ["d", "right"],
  ["w", "up"],
  ["s", "down"],
  [" ", "jump"],
]);

let myId = null;
let joined = false;
let serverState = null;
let predictedPlayer = null;
let renderedBall = null;
let lastFrameAt = performance.now();
let lastInputHash = "";
let joystickPointerId = null;
let lastGoalSeq = 0;
let goalBannerHideAt = 0;
const stateBuffer = [];
const serverOffsetSamples = [];
let serverClockOffsetMs = 0;
let hasServerClockOffset = false;
let pingMs = null;
let worldMeta = null;
let lastCooldownRenderAt = 0;

const JOYSTICK_RADIUS = 36;
const INTERPOLATION_DELAY_MS = isMobileClient ? 90 : 100;
const MAX_EXTRAPOLATION_MS = 250;
const MAX_STATE_BUFFER = 60; // Slightly larger buffer for state snapshots
const MAX_OFFSET_SAMPLES = 32;

async function requestMobileFullscreen() {
  if (!isMobileClient || document.fullscreenElement) return;
  const root = document.documentElement;
  if (root.requestFullscreen) {
    try {
      await root.requestFullscreen({ navigationUI: "hide" });
    } catch (_err) {
      // Some mobile browsers disallow fullscreen; continue without blocking gameplay.
    }
  }
}

function hashInputState(state) {
  return `${Number(state.left)}${Number(state.right)}${Number(state.up)}${Number(state.down)}${Number(state.jump)}`;
}

function emitInputNow() {
  if (!joined) return;
  lastInputHash = hashInputState(input);
  socket.volatile.emit("move", input);
}

function applyMergedInput() {
  const next = {
    left: keyboardInput.left || touchInput.left,
    right: keyboardInput.right || touchInput.right,
    up: keyboardInput.up || touchInput.up,
    down: keyboardInput.down || touchInput.down,
    jump: keyboardInput.jump || touchInput.jump,
  };

  const changed =
    next.left !== input.left ||
    next.right !== input.right ||
    next.up !== input.up ||
    next.down !== input.down ||
    next.jump !== input.jump;

  if (!changed) return;
  input.left = next.left;
  input.right = next.right;
  input.up = next.up;
  input.down = next.down;
  input.jump = next.jump;
  emitInputNow();
}

function resetJoystick() {
  joystickKnob.style.transform = "translate(-50%, -50%)";
  touchInput.left = false;
  touchInput.right = false;
  touchInput.up = false;
  touchInput.down = false;
  applyMergedInput();
}

function setJoystickFromPoint(clientX, clientY) {
  const rect = joystickBase.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  let dx = clientX - centerX;
  let dy = clientY - centerY;
  const mag = Math.hypot(dx, dy);

  if (mag > JOYSTICK_RADIUS) {
    const ratio = JOYSTICK_RADIUS / mag;
    dx *= ratio;
    dy *= ratio;
  }

  joystickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

  const nx = dx / JOYSTICK_RADIUS;
  const ny = dy / JOYSTICK_RADIUS;
  // Smaller deadzone => movement engages with less thumb travel, so the stick
  // feels more responsive (was 0.24, which needed a deliberate shove).
  const threshold = 0.18;
  touchInput.left = nx < -threshold;
  touchInput.right = nx > threshold;
  touchInput.up = ny < -threshold;
  touchInput.down = ny > threshold;
  applyMergedInput();
}

function updateOrientationGate() {
  if (!isMobileClient) {
    orientationOverlay.classList.add("hidden");
    mobileControls.classList.add("hidden");
    sizeCanvasForViewport();
    return;
  }

  // Mobile/Touch Client logic: only show orientation warning if they are orientation locked.
  // We'll keep it simple for now and just show controls whenever they are joined.
  mobileControls.classList.toggle("hidden", !joined);

  // Show orientation hint only if they are joined AND in portrait (optional but helps UX)
  const isPortrait = window.innerHeight > window.innerWidth;
  orientationOverlay.classList.toggle("hidden", !(isPortrait && joined));

  sizeCanvasForViewport();
}

function formatTime(ms) {
  const totalSeconds = Math.ceil(Math.max(0, ms) / 1000);
  const min = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const sec = String(totalSeconds % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

function updatePingDisplay() {
  const text = typeof pingMs === "number" ? `${Math.round(pingMs)} ms` : "-- ms";
  pingEl.textContent = `Ping: ${text}`;
}

function recordServerClockOffset(serverTime) {
  if (typeof serverTime !== "number") return;
  const sample = Date.now() - serverTime;
  serverOffsetSamples.push(sample);
  if (serverOffsetSamples.length > MAX_OFFSET_SAMPLES) {
    serverOffsetSamples.shift();
  }
  const sorted = [...serverOffsetSamples].sort((a, b) => a - b);
  const medianSample = sorted[Math.floor(sorted.length / 2)];
  serverClockOffsetMs = Number.isFinite(medianSample) ? medianSample : 0;
  hasServerClockOffset = true;
}

function applyPrediction(dtSec) {
  if (!predictedPlayer || !serverState || serverState.gameState !== "playing") return;
  const meta = serverState.meta || worldMeta;
  if (!meta) return;

  const speed = 260;
  let dirX = 0;
  let dirY = 0;

  if (input.left) dirX -= 1;
  if (input.right) dirX += 1;
  if (input.up) dirY -= 1;
  if (input.down) dirY += 1;

  if (dirX !== 0 || dirY !== 0) {
    const mag = Math.hypot(dirX, dirY);
    predictedPlayer.x += (dirX / mag) * speed * dtSec;
    predictedPlayer.y += (dirY / mag) * speed * dtSec;
  }

  predictedPlayer.x = Math.max(20, Math.min(meta.width - 20, predictedPlayer.x));
  predictedPlayer.y = Math.max(20, Math.min(meta.height - 20, predictedPlayer.y));
}

function syncPredictionFromServer() {
  if (!serverState || !myId) return;
  const me = serverState.players.find((p) => p.id === myId);
  if (!me) return;
  if (!predictedPlayer) {
    predictedPlayer = { x: me.x, y: me.y, z: me.z, team: me.team, name: me.name };
    return;
  }

  const dx = me.x - predictedPlayer.x;
  const dy = me.y - predictedPlayer.y;
  const dist = Math.hypot(dx, dy);
  if (dist > 180) {
    // Way out of sync (teleport / big desync): snap.
    predictedPlayer.x = me.x;
    predictedPlayer.y = me.y;
  } else if (dist > 6) {
    // Deadzone: the authoritative position always trails our prediction by ~1
    // RTT because it hasn't yet applied our latest inputs. Constantly pulling
    // toward it — even by a few px each packet — is what made the local player
    // feel "heavy"/rubber-bandy. Only reconcile once the gap is real (>6px),
    // and gently, so small lag never fights the player's own movement.
    const correctionFactor = dist > 90 ? 0.22 : 0.12;
    predictedPlayer.x += dx * correctionFactor;
    predictedPlayer.y += dy * correctionFactor;
  }
  predictedPlayer.z = me.z;
  predictedPlayer.team = me.team;
  predictedPlayer.name = me.name;
}

function cloneSnapshot(state) {
  return {
    ...state,
    meta: state.meta ? { ...state.meta } : (worldMeta ? { ...worldMeta } : null),
    score: state.score ? { ...state.score } : { red: 0, blue: 0 },
    goalEvent: state.goalEvent ? { ...state.goalEvent } : null,
    ball: state.ball ? { ...state.ball } : null,
    players: Array.isArray(state.players) ? state.players.map((p) => ({ ...p })) : [],
  };
}

function pushStateSnapshot(state) {
  if (!state || typeof state.serverTime !== "number") return;
  if (state.meta) worldMeta = state.meta;
  recordServerClockOffset(state.serverTime);

  const snapshot = cloneSnapshot(state);
  const last = stateBuffer[stateBuffer.length - 1];

  if (last && snapshot.serverTime <= last.serverTime) {
    if (snapshot.serverTime === last.serverTime) {
      stateBuffer[stateBuffer.length - 1] = snapshot;
    } else {
      stateBuffer.push(snapshot);
      stateBuffer.sort((a, b) => a.serverTime - b.serverTime);
    }
  } else {
    stateBuffer.push(snapshot);
  }

  if (stateBuffer.length > MAX_STATE_BUFFER) {
    stateBuffer.splice(0, stateBuffer.length - MAX_STATE_BUFFER);
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function interpolateBall(a, b, t) {
  if (!a && !b) return null;
  if (!a) return { ...b };
  if (!b) return { ...a };
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    z: lerp(a.z, b.z, t),
    vx: lerp(a.vx, b.vx, t),
    vy: lerp(a.vy, b.vy, t),
    vz: lerp(a.vz, b.vz, t),
  };
}

function interpolatePlayers(older, newer, t) {
  const oldMap = new Map((older.players || []).map((p) => [p.id, p]));
  const newMap = new Map((newer.players || []).map((p) => [p.id, p]));
  const ids = new Set([...newMap.keys(), ...oldMap.keys()]);
  const result = [];

  for (const id of ids) {
    const a = oldMap.get(id) || newMap.get(id);
    const b = newMap.get(id) || a;
    if (!a || !b) continue;
    result.push({
      id,
      name: b.name || a.name,
      team: b.team || a.team,
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      z: lerp(a.z, b.z, t),
      vx: lerp(a.vx ?? 0, b.vx ?? 0, t),
      vy: lerp(a.vy ?? 0, b.vy ?? 0, t),
      vz: lerp(a.vz ?? 0, b.vz ?? 0, t),
    });
  }

  return result;
}

function extrapolateBall(ball, dtSec) {
  if (!ball) return null;
  return {
    ...ball,
    x: ball.x + (ball.vx || 0) * dtSec,
    y: ball.y + (ball.vy || 0) * dtSec,
    z: Math.max(0, ball.z + (ball.vz || 0) * dtSec),
  };
}

function extrapolatePlayers(players, dtSec, meta) {
  if (!meta) return players || [];
  return (players || []).map((p) => {
    const x = p.x + (p.vx || 0) * dtSec;
    const y = p.y + (p.vy || 0) * dtSec;
    return {
      ...p,
      x: Math.max(20, Math.min(meta.width - 20, x)),
      y: Math.max(20, Math.min(meta.height - 20, y)),
      z: Math.max(0, p.z + (p.vz || 0) * dtSec),
    };
  });
}

function getInterpolatedState(nowMs) {
  if (stateBuffer.length === 0) return null;
  if (stateBuffer.length === 1) {
    const only = stateBuffer[0];
    return {
      ...only,
      meta: only.meta || worldMeta || null,
    };
  }

  const estimatedServerNow = hasServerClockOffset ? nowMs - serverClockOffsetMs : nowMs;
  const targetServerTime = estimatedServerNow - INTERPOLATION_DELAY_MS;
  const first = stateBuffer[0];
  const last = stateBuffer[stateBuffer.length - 1];

  if (targetServerTime <= first.serverTime) {
    return {
      ...first,
      meta: first.meta || worldMeta || null,
    };
  }
  if (targetServerTime >= last.serverTime) {
    const extraMs = Math.min(MAX_EXTRAPOLATION_MS, targetServerTime - last.serverTime);
    if (extraMs <= 0) return last;
    const dtSec = extraMs / 1000;
    const meta = last.meta || worldMeta || null;
    return {
      ...last,
      meta,
      ball: extrapolateBall(last.ball, dtSec),
      players: extrapolatePlayers(last.players, dtSec, meta),
      serverTime: last.serverTime + extraMs,
    };
  }

  for (let i = 0; i < stateBuffer.length - 1; i += 1) {
    const older = stateBuffer[i];
    const newer = stateBuffer[i + 1];
    if (targetServerTime < older.serverTime || targetServerTime > newer.serverTime) {
      continue;
    }

    const span = Math.max(1, newer.serverTime - older.serverTime);
    const t = Math.max(0, Math.min(1, (targetServerTime - older.serverTime) / span));

    return {
      meta: newer.meta || older.meta || worldMeta || null,
      gameState: newer.gameState,
      kickoffCountdownMs: Math.round(lerp(older.kickoffCountdownMs || 0, newer.kickoffCountdownMs || 0, t)),
      timerMs: Math.round(lerp(older.timerMs || 0, newer.timerMs || 0, t)),
      score: newer.score || older.score,
      goalEvent: newer.goalEvent || older.goalEvent,
      ball: interpolateBall(older.ball, newer.ball, t),
      players: interpolatePlayers(older, newer, t),
      serverTime: Math.round(lerp(older.serverTime, newer.serverTime, t)),
    };
  }

  return last;
}

function sizeCanvasForViewport() {
  const meta = serverState?.meta || worldMeta;
  if (!isMobileClient || !joined || !meta || !gameStage) {
    canvas.style.width = "";
    canvas.style.height = "";
    return;
  }

  const ratio = meta.width / meta.height;
  const stageRect = gameStage.getBoundingClientRect();
  let targetW = stageRect.width;
  let targetH = targetW / ratio;

  if (targetH > stageRect.height) {
    targetH = stageRect.height;
    targetW = targetH * ratio;
  }

  canvas.style.width = `${Math.max(1, Math.floor(targetW))}px`;
  canvas.style.height = `${Math.max(1, Math.floor(targetH))}px`;
}

function showGoalBanner(message) {
  goalBanner.textContent = message;
  goalBanner.classList.remove("hidden");
  goalBannerHideAt = performance.now() + 1600;
}

function renderCooldownPlayerList(players) {
  if (!cooldownPlayerList) return;
  cooldownPlayerList.innerHTML = "";

  if (!Array.isArray(players) || players.length === 0) {
    cooldownPlayerList.textContent = "No players connected.";
    return;
  }

  const sorted = [...players].sort((a, b) => {
    if (a.team !== b.team) return a.team.localeCompare(b.team);
    return a.name.localeCompare(b.name);
  });

  for (const player of sorted) {
    const row = document.createElement("div");
    row.className = `cooldown-player-item${player.id === myId ? " me" : ""}`;

    const left = document.createElement("span");
    left.textContent = player.id === myId ? `${player.name} (You)` : player.name;

    const right = document.createElement("span");
    right.className = `cooldown-player-team ${player.team === "red" ? "red" : "blue"}`;
    right.textContent = player.team === "red" ? "RED" : "BLUE";

    row.appendChild(left);
    row.appendChild(right);
    cooldownPlayerList.appendChild(row);
  }
}

function updateCooldownOverlay(state) {
  const inCooldown = Boolean(joined && state && state.gameState === "cooldown");
  cooldownOverlay.classList.toggle("hidden", !inCooldown);
  
  if (!inCooldown) {
    votedToSkip = false;
    voteSkipButton.classList.remove("hidden");
    return;
  }

  if (votedToSkip) {
    voteSkipButton.classList.add("hidden");
  }

  if (state.voteStatus) {
    voteSkipButton.textContent = `Vote to Start (${state.voteStatus.count}/${state.voteStatus.total})`;
  }

  const now = performance.now();
  if (now - lastCooldownRenderAt < 250) return;
  lastCooldownRenderAt = now;
  renderCooldownPlayerList(state.players);
}

voteSkipButton.addEventListener("click", () => {
  if (!joined || votedToSkip) return;
  socket.emit("vote_skip");
  votedToSkip = true;
  voteSkipButton.classList.add("hidden");
});

function drawField(meta) {
  const w = meta.width;
  const h = meta.height;
  const centerY = h / 2;
  const goalHalf = meta.goalSize / 2;
  const goalY = centerY - goalHalf;

  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(218,245,224,0.94)";
  ctx.lineWidth = 2;
  ctx.strokeRect(10, 10, w - 20, h - 20);

  ctx.beginPath();
  ctx.moveTo(w / 2, 10);
  ctx.lineTo(w / 2, h - 10);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(w / 2, h / 2, 68, 0, Math.PI * 2);
  ctx.stroke();

  // High-contrast goal zones so scoring lanes are obvious.
  ctx.fillStyle = "rgba(255, 88, 88, 0.22)";
  ctx.fillRect(0, goalY, 22, meta.goalSize);
  ctx.fillStyle = "rgba(98, 199, 255, 0.22)";
  ctx.fillRect(w - 22, goalY, 22, meta.goalSize);

  ctx.strokeStyle = "rgba(244, 255, 246, 0.95)";
  ctx.lineWidth = 3;
  ctx.strokeRect(2, goalY, 20, meta.goalSize);
  ctx.strokeRect(w - 22, goalY, 20, meta.goalSize);

  ctx.strokeStyle = "rgba(240, 255, 243, 0.35)";
  ctx.lineWidth = 1;
  for (let y = goalY + 8; y < goalY + meta.goalSize; y += 12) {
    ctx.beginPath();
    ctx.moveTo(2, y);
    ctx.lineTo(22, y);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(w - 22, y);
    ctx.lineTo(w - 2, y);
    ctx.stroke();
  }
}

// --- Character visuals ---------------------------------------------------
// Per-player render state (smoothed facing + run-cycle phase), keyed by id.
const charViz = new Map();

function hashId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}
// Stable per-player jersey number (1..99) and accent hue, so teammates on the
// same color are visually distinct instead of identical blobs.
function jerseyNumber(id) {
  return (hashId(id) % 99) + 1;
}
function accentColor(id) {
  return `hsl(${hashId(id) % 360}, 62%, 56%)`;
}
function getViz(id) {
  let v = charViz.get(id);
  if (!v) {
    v = { facing: -Math.PI / 2, phase: Math.random() * Math.PI * 2 };
    charViz.set(id, v);
  }
  return v;
}

const PLAYER_BODY_R = 15;

function drawPlayer(player, isMe, dtSec) {
  const viz = getViz(player.id);
  const zLift = player.z * 0.35;
  const speed = Math.hypot(player.vx || 0, player.vy || 0);
  const moving = speed > 12;

  // Turn smoothly to face the direction of travel.
  if (moving) {
    const target = Math.atan2(player.vy, player.vx);
    let d = target - viz.facing;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    viz.facing += d * Math.min(1, dtSec * 12);
  }
  // Advance the run cycle faster the quicker they move.
  viz.phase += moving ? speed * 0.018 + 0.05 : 0.02;
  const bob = moving ? Math.sin(viz.phase) : 0;

  const cx = player.x;
  const cy = player.y - zLift;
  const fx = Math.cos(viz.facing);
  const fy = Math.sin(viz.facing);
  const px = -fy; // perpendicular (for feet offset)
  const py = fx;

  const teamColor = player.team === "red" ? "#ff5b5b" : "#4aa8ff";
  const teamDark = player.team === "red" ? "#c62f2f" : "#1f6fd0";
  const accent = accentColor(player.id);

  // Ground shadow — shrinks and fades as the player jumps.
  ctx.fillStyle = `rgba(0,0,0,${(0.3 - Math.min(0.2, player.z * 0.006)).toFixed(3)})`;
  ctx.beginPath();
  ctx.ellipse(player.x, player.y + 9, PLAYER_BODY_R * 0.95, PLAYER_BODY_R * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();

  // Running feet — alternate fore/aft with the run cycle.
  ctx.fillStyle = "#20242b";
  for (const s of [-1, 1]) {
    const swing = bob * s * 5;
    const footX = cx + px * s * 6 + fx * swing;
    const footY = cy + py * s * 6 + fy * swing + 5;
    ctx.beginPath();
    ctx.ellipse(footX, footY, 3.6, 2.6, viz.facing, 0, Math.PI * 2);
    ctx.fill();
  }

  // Jersey body — radial gradient gives a lit, rounded look.
  const grad = ctx.createRadialGradient(cx - 4, cy - 5, 2, cx, cy, PLAYER_BODY_R);
  grad.addColorStop(0, teamColor);
  grad.addColorStop(1, teamDark);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, PLAYER_BODY_R, 0, Math.PI * 2);
  ctx.fill();

  // Per-player accent band across the shoulders.
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, PLAYER_BODY_R - 2, viz.facing + 0.7, viz.facing - 0.7);
  ctx.stroke();

  // Jersey number.
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  ctx.font = "bold 11px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(jerseyNumber(player.id)), cx, cy + 0.5);
  ctx.textBaseline = "alphabetic";

  // Head — hair (accent) with the face (skin) offset toward the facing
  // direction, so you can read which way the player is looking.
  const hx = cx + fx * 4.5;
  const hy = cy + fy * 4.5;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(hx, hy, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f0c69b";
  ctx.beginPath();
  ctx.arc(hx + fx * 1.7, hy + fy * 1.7, 5, 0, Math.PI * 2);
  ctx.fill();

  // "You" highlight ring.
  if (isMe) {
    ctx.strokeStyle = "#f5ff8f";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, PLAYER_BODY_R + 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Name tag.
  ctx.fillStyle = "#e9fff1";
  ctx.font = "12px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(player.name, cx, cy - PLAYER_BODY_R - 8);
}

function drawBall(ball) {
  const zLift = ball.z * 0.35;
  const cx = ball.x;
  const cy = ball.y - zLift;
  const r = 10;

  ctx.fillStyle = `rgba(0,0,0,${(0.26 - Math.min(0.16, ball.z * 0.006)).toFixed(3)})`;
  ctx.beginPath();
  ctx.ellipse(ball.x, ball.y + 6, 9, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  // Shaded white sphere.
  const grad = ctx.createRadialGradient(cx - 3, cy - 4, 1, cx, cy, r);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(1, "#c9cfd6");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // Classic pentagon spots (center + a ring of five).
  ctx.fillStyle = "#20242b";
  ctx.beginPath();
  ctx.arc(cx, cy, 2.6, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 5; i += 1) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * 5.6, cy + Math.sin(a) * 5.6, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = "rgba(30,40,50,0.55)";
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
}

function getRenderedBall(ballTarget, dtSec) {
  if (!ballTarget) return null;

  if (!renderedBall) {
    renderedBall = { ...ballTarget };
    return renderedBall;
  }

  const desyncDist = Math.hypot(ballTarget.x - renderedBall.x, ballTarget.y - renderedBall.y);
  if (desyncDist > 140 || Math.abs(ballTarget.z - renderedBall.z) > 80) {
    renderedBall = { ...ballTarget };
    return renderedBall;
  }

  // Small forward estimate from latest velocity, then blend for smooth motion.
  const leadX = ballTarget.x + ballTarget.vx * dtSec;
  const leadY = ballTarget.y + ballTarget.vy * dtSec;
  const leadZ = Math.max(0, ballTarget.z + ballTarget.vz * dtSec);
  const blend = Math.min(1, dtSec * 14);

  renderedBall.x += (leadX - renderedBall.x) * blend;
  renderedBall.y += (leadY - renderedBall.y) * blend;
  renderedBall.z += (leadZ - renderedBall.z) * blend;
  return renderedBall;
}

function render(now) {
  const dtSec = Math.min(0.05, (now - lastFrameAt) / 1000);
  lastFrameAt = now;
  const renderState = getInterpolatedState(Date.now());

  if (renderState) {
    applyPrediction(dtSec);
    const ballToRender = getRenderedBall(renderState.ball, dtSec);

    const meta = renderState.meta || worldMeta;
    if (!meta) {
      requestAnimationFrame(render);
      return;
    }
    drawField(meta);
    if (ballToRender) {
      drawBall(ballToRender);
    }
    for (const p of renderState.players) {
      if (predictedPlayer && p.id === myId) {
        drawPlayer(
          {
            ...p,
            x: predictedPlayer.x,
            y: predictedPlayer.y,
            z: predictedPlayer.z,
          },
          true,
          dtSec,
        );
        continue;
      }
      drawPlayer(p, false, dtSec);
    }
  }

  if (goalBannerHideAt && now >= goalBannerHideAt) {
    goalBanner.classList.add("hidden");
    goalBannerHideAt = 0;
  }

  requestAnimationFrame(render);
}

requestAnimationFrame(render);

setInterval(() => {
  if (!joined) return;
  const inputHash = hashInputState(input);
  if (inputHash === lastInputHash) {
    // Keepalive at low rate so server has a fresh input state.
    socket.volatile.emit("move", input);
    return;
  }
  lastInputHash = inputHash;
  socket.volatile.emit("move", input);
}, 1000 / 5);

setInterval(() => {
  if (!joined || !socket.connected) return;
  const startedAt = performance.now();
  socket.emit("ping_check", (payload) => {
    const rtt = performance.now() - startedAt;
    pingMs = rtt;
    if (payload && typeof payload.serverTime === "number") {
      recordServerClockOffset(payload.serverTime - rtt / 2);
    }
    updatePingDisplay();
  });
}, 2000);

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;

  socket.emit("join", name, (result) => {
    if (!result || !result.ok) {
      statusEl.textContent = "Unable to join match.";
      return;
    }
    joined = true;
    myId = result.id;
    lastInputHash = "";
    requestMobileFullscreen();
    loginPanel.classList.add("hidden");
    gamePanel.classList.remove("hidden");
    statusEl.textContent = "Connected";
    updateOrientationGate();
    setTimeout(updateOrientationGate, 250);
  });
});

window.addEventListener("keydown", (e) => {
  if (!joined) return;
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)
  ) {
    return;
  }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const mapped = keyMap.get(key);
  if (!mapped) return;
  if (keyboardInput[mapped]) return;
  keyboardInput[mapped] = true;
  applyMergedInput();
  e.preventDefault();
});

window.addEventListener("keyup", (e) => {
  if (!joined) return;
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)
  ) {
    return;
  }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const mapped = keyMap.get(key);
  if (!mapped) return;
  if (!keyboardInput[mapped]) return;
  keyboardInput[mapped] = false;
  applyMergedInput();
  e.preventDefault();
});

if (isMobileClient) {
  joystickBase.addEventListener("pointerdown", (e) => {
    if (!joined) return;
    joystickPointerId = e.pointerId;
    joystickBase.setPointerCapture(e.pointerId);
    setJoystickFromPoint(e.clientX, e.clientY);
    e.preventDefault();
  });

  joystickBase.addEventListener("pointermove", (e) => {
    if (joystickPointerId !== e.pointerId) return;
    setJoystickFromPoint(e.clientX, e.clientY);
    e.preventDefault();
  });

  const releaseJoystick = (e) => {
    if (joystickPointerId !== e.pointerId) return;
    joystickPointerId = null;
    resetJoystick();
    e.preventDefault();
  };

  joystickBase.addEventListener("pointerup", releaseJoystick);
  joystickBase.addEventListener("pointercancel", releaseJoystick);

  jumpButton.addEventListener("pointerdown", (e) => {
    if (!joined) return;
    touchInput.jump = true;
    applyMergedInput();
    e.preventDefault();
  });

  const releaseJump = (e) => {
    touchInput.jump = false;
    applyMergedInput();
    e.preventDefault();
  };

  jumpButton.addEventListener("pointerup", releaseJump);
  jumpButton.addEventListener("pointercancel", releaseJump);
  jumpButton.addEventListener("pointerleave", releaseJump);

  window.addEventListener("orientationchange", () => setTimeout(updateOrientationGate, 100));
  window.addEventListener("resize", updateOrientationGate);
  window.visualViewport?.addEventListener("resize", updateOrientationGate);
  document.addEventListener("fullscreenchange", updateOrientationGate);
}

socket.on("connect", () => {
  statusEl.textContent = "Connected to server.";
  updatePingDisplay();
});

socket.on("disconnect", () => {
  statusEl.textContent = "Disconnected. Refresh to rejoin.";
  joined = false;
  lastInputHash = "";
  renderedBall = null;
  charViz.clear();
  stateBuffer.length = 0;
  serverOffsetSamples.length = 0;
  hasServerClockOffset = false;
  worldMeta = null;
  pingMs = null;
  updatePingDisplay();
  resetJoystick();
  touchInput.jump = false;
  keyboardInput.jump = false;
  updateCooldownOverlay(null);
  updateOrientationGate();
});

socket.on("joined", (state) => {
  serverState = state;
  if (state?.meta) worldMeta = state.meta;
  renderedBall = state?.ball ? { ...state.ball } : null;
  pushStateSnapshot(state);
  syncPredictionFromServer();
  updateCooldownOverlay(state);
  updateOrientationGate();
});

socket.on("state", (state) => {
  serverState = state;
  if (state?.meta) worldMeta = state.meta;
  pushStateSnapshot(state);
  redScoreEl.textContent = String(state.score.red);
  blueScoreEl.textContent = String(state.score.blue);
  timerEl.textContent = formatTime(state.timerMs);

  if (state.kickoffCountdownMs > 0) {
    statusEl.textContent = `Goal! Kickoff in ${(state.kickoffCountdownMs / 1000).toFixed(1)}s`;
  } else if (state.gameState === "cooldown") {
    statusEl.textContent = "Cooldown...";
  } else if (joined) {
    statusEl.textContent = "Live match";
  }

  if (state.goalEvent?.seq && state.goalEvent.seq !== lastGoalSeq) {
    lastGoalSeq = state.goalEvent.seq;
    const teamLabel = state.goalEvent.team === "red" ? "RED" : "BLUE";
    showGoalBanner(`Goal! ${teamLabel} Team`);
  }

  updateCooldownOverlay(state);
  syncPredictionFromServer();
});

updateOrientationGate();
updatePingDisplay();
