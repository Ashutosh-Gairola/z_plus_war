/**
 * Client-side prediction for the local player (frag + Z+).
 *
 * Without it, your own movement only showed up after a full round trip:
 * input -> server tick -> snapshot -> interpolation delay. On phones (100-150ms
 * ping, jittery Wi-Fi/4G) that was ~300ms between touching the stick and
 * moving — the "heavy / laggy" feel. Now the local player is simulated here
 * every frame with the same rules as the server's applyMovement (speeds,
 * acceleration, friction, gravity, jumping, step-up and prop collisions), and
 * the server stays authoritative: each new snapshot is compared with where we
 * predicted we were one round trip ago, and any difference is blended out
 * over a few frames (or snapped if it's large — respawn, vehicle exit...).
 */

// Mirrors frag/server.js movement constants.
const C = {
  WORLD_HALF_SIZE: 320,
  PLAYER_RADIUS: 0.55,
  PLAYER_STEP_HEIGHT: 0.62,
  PLAYER_HEIGHT: 1.8,
  PLAYER_ACCEL: 66,
  PLAYER_GROUND_FRICTION: 10,
  PLAYER_GRAVITY: 34,
  PLAYER_JUMP_VELOCITY: 9.4,
  EYE: 1.7,
  CROUCH_EYE: 1.18,
  GRID: 16,
};

const SNAP_DISTANCE = 3.5; // beyond this the server position wins outright
const DEADBAND = 0.04; // ignore centimetre-level disagreement
const CORRECTION_RATE = 9; // per second: how fast a correction is blended in
const HISTORY_MS = 1200; // must cover the worst round trip we expect

import { resolveCircleVsVehicles } from "./vehicle-shapes.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---- Collision helpers (same maths as the server) ----

function pointInside(x, z, r, o) {
  if (o.collidable === false) return false;
  return Math.abs(x - o.x) < o.sx / 2 + r && Math.abs(z - o.z) < o.sz / 2 + r;
}

function blocksPlayer(o, feetY) {
  if (o.collidable === false) return false;
  const base = o.py || 0;
  const top = base + o.sy;
  if (top <= feetY + C.PLAYER_STEP_HEIGHT) return false;
  if (base >= feetY + C.PLAYER_HEIGHT - 0.1) return false;
  return true;
}

function resolve(x, z, r, o) {
  const dx = x - o.x;
  const dz = z - o.z;
  const ox = o.sx / 2 + r - Math.abs(dx);
  const oz = o.sz / 2 + r - Math.abs(dz);
  if (ox <= 0 || oz <= 0) return { x, z };
  if (ox < oz) x += dx >= 0 ? ox : -ox;
  else z += dz >= 0 ? oz : -oz;
  return { x, z };
}

export class LocalPredictor {
  constructor() {
    this.props = [];
    this.grid = new Map();
    this.p = null; // predicted state
    this.history = []; // { t, x, y, z }
    this.pending = { x: 0, y: 0, z: 0 }; // correction still to blend in
    this.lastSnapshotTime = 0;
    this.active = false;
  }

  // ---------------------------------------------------------------------------
  // World
  // ---------------------------------------------------------------------------

  setWorld(meta) {
    if (meta?.worldHalfSize) C.WORLD_HALF_SIZE = meta.worldHalfSize;
    this.props = (meta?.props || []).filter((p) => p.collidable !== false && p.type !== "glass");
    this.rebuildGrid();
  }

  rebuildGrid() {
    this.grid = new Map();
    for (const p of this.props) {
      const x0 = Math.floor((p.x - p.sx / 2) / C.GRID);
      const x1 = Math.floor((p.x + p.sx / 2) / C.GRID);
      const z0 = Math.floor((p.z - p.sz / 2) / C.GRID);
      const z1 = Math.floor((p.z + p.sz / 2) / C.GRID);
      for (let gx = x0; gx <= x1; gx += 1) {
        for (let gz = z0; gz <= z1; gz += 1) {
          const k = `${gx}:${gz}`;
          if (!this.grid.has(k)) this.grid.set(k, []);
          this.grid.get(k).push(p);
        }
      }
    }
  }

  near(x, z) {
    const gx = Math.floor(x / C.GRID);
    const gz = Math.floor(z / C.GRID);
    const out = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        const cell = this.grid.get(`${gx + dx}:${gz + dz}`);
        if (cell) for (const p of cell) out.push(p);
      }
    }
    return out;
  }

  supportAt(x, z, feetY) {
    let support = 0;
    for (const p of this.near(x, z)) {
      if (p.collidable === false) continue;
      if (Math.abs(x - p.x) > p.sx / 2 + 0.12 || Math.abs(z - p.z) > p.sz / 2 + 0.12) continue;
      const top = (p.py || 0) + p.sy;
      if (top <= feetY + C.PLAYER_STEP_HEIGHT && top > support) support = top;
    }
    return support;
  }

  /** Keep collision in sync with destruction (broken walls, felled trees, rubble). */
  applyStructure(payload) {
    if (!payload) return;
    const broken = new Set(payload.broken || []);
    for (const p of this.props) {
      if (p.buildingId && broken.has(p.id)) p.collidable = false;
      else if (p.buildingId && p.collidable === false && !broken.has(p.id)) p.collidable = true; // round reset
    }
    this.props = this.props.filter((p) => p.type !== "rubble");
    for (const r of payload.rubble || []) this.props.push({ ...r, py: 0, type: "rubble", collidable: true });
    this.rebuildGrid();
  }

  markDestroyed(ids) {
    if (!ids || !ids.length) return;
    const set = new Set(ids);
    for (const p of this.props) if (set.has(p.id)) p.collidable = false;
  }

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------

  /** One movement step — a copy of the server's applyMovement. */
  simulate(input, yaw, dt, legPenalty) {
    const p = this.p;
    let fwd = 0;
    let side = 0;
    if (input.forward) fwd += 1;
    if (input.back) fwd -= 1;
    if (input.right) side += 1;
    if (input.left) side -= 1;
    const mag = Math.hypot(fwd, side);
    p.crouching = Boolean(input.crouch);
    const speed = (p.crouching ? 4.1 : input.sprint ? 10.6 : 7.5) * legPenalty;
    let dvx = 0;
    let dvz = 0;
    if (mag > 0.001) {
      const nf = fwd / mag;
      const ns = side / mag;
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      dvx = (-sin * nf + cos * ns) * speed;
      dvz = (-cos * nf - sin * ns) * speed;
    }
    const a = 1 - Math.exp(-C.PLAYER_ACCEL * dt);
    p.vx += (dvx - p.vx) * a;
    p.vz += (dvz - p.vz) * a;
    if (mag < 0.001) {
      const drag = Math.exp(-C.PLAYER_GROUND_FRICTION * dt);
      p.vx *= drag;
      p.vz *= drag;
    }

    const eye = p.crouching ? C.CROUCH_EYE : C.EYE;
    const feet = p.y - eye;
    const onGround = feet <= this.supportAt(p.x, p.z, feet) + 0.03;
    if (input.jump && !p.lastJump && onGround && !p.crouching) p.vy = C.PLAYER_JUMP_VELOCITY;
    p.lastJump = Boolean(input.jump);
    p.vy -= C.PLAYER_GRAVITY * dt;
    p.y += p.vy * dt;

    const lim = C.WORLD_HALF_SIZE - C.PLAYER_RADIUS;
    let nx = clamp(p.x + p.vx * dt, -lim, lim);
    let nz = clamp(p.z + p.vz * dt, -lim, lim);
    const curFeet = p.y - eye;
    for (let i = 0; i < 2; i += 1) {
      for (const o of this.near(nx, nz)) {
        if (!blocksPlayer(o, curFeet) || !pointInside(nx, nz, C.PLAYER_RADIUS, o)) continue;
        ({ x: nx, z: nz } = resolve(nx, nz, C.PLAYER_RADIUS, o));
      }
    }
    // Vehicles are solid (same rule as the server).
    ({ x: nx, z: nz } = resolveCircleVsVehicles(nx, nz, C.PLAYER_RADIUS, this.vehicles, curFeet));
    const support = this.supportAt(nx, nz, curFeet);
    if (p.vy <= 0 && p.y < support + eye) {
      p.y = support + eye;
      p.vy = 0;
    }
    p.x = nx;
    p.z = nz;
  }

  /**
   * Advance one frame. serverMe: my entry in the newest raw snapshot;
   * snapshot: that snapshot (for its timestamp); rttMs: measured ping.
   * Returns the predicted pose, or null when prediction is off (dead, in a
   * vehicle, between rounds) and the server position should be used as-is.
   */
  update({ input, yaw, dt, serverMe, snapshot, rttMs, canMove }) {
    const now = performance.now();
    if (!serverMe || !serverMe.alive || serverMe.inVehicle || !canMove) {
      this.lastUpdateAt = 0;
      this.active = false;
      this.p = null;
      this.history.length = 0;
      return null;
    }
    if (!this.p) {
      this.p = {
        x: serverMe.x,
        y: serverMe.y,
        z: serverMe.z,
        vx: serverMe.vx || 0,
        vy: serverMe.vy || 0,
        vz: serverMe.vz || 0,
        crouching: Boolean(serverMe.crouching),
        lastJump: false,
      };
      this.pending = { x: 0, y: 0, z: 0 };
    }
    this.active = true;
    this.vehicles = snapshot?.vehicles || [];

    // Real elapsed time, not the render loop's clamped dt: on a slow phone
    // (<20fps) a 50ms cap made us walk slower than the server and get yanked
    // forward. Fixed 1/60s substeps keep collisions stable.
    const realDt = this.lastUpdateAt ? Math.min(0.25, (now - this.lastUpdateAt) / 1000) : dt;
    this.lastUpdateAt = now;
    const legPenalty = (serverMe.movementPenaltyMs || 0) > 0 ? 0.78 : 1;
    let left = realDt;
    while (left > 1e-4) {
      const step = Math.min(left, 1 / 60);
      this.simulate(input, yaw, step, legPenalty);
      left -= step;
    }

    // Reconcile when a new snapshot has arrived.
    if (snapshot && snapshot.serverTime !== this.lastSnapshotTime) {
      this.lastSnapshotTime = snapshot.serverTime;
      this.reconcile(serverMe);
    }

    // Blend the outstanding correction in smoothly (and keep history in step).
    const k = Math.min(1, realDt * CORRECTION_RATE);
    const cx = this.pending.x * k;
    const cy = this.pending.y * k;
    const cz = this.pending.z * k;
    this.pending.x -= cx;
    this.pending.y -= cy;
    this.pending.z -= cz;
    this.p.x += cx;
    this.p.y += cy;
    this.p.z += cz;
    for (const h of this.history) {
      h.x += cx;
      h.y += cy;
      h.z += cz;
    }

    this.history.push({ t: now, x: this.p.x, y: this.p.y, z: this.p.z });
    while (this.history.length && now - this.history[0].t > HISTORY_MS) this.history.shift();
    return this.p;
  }

  /**
   * Compare the server's position with our own recent path. The server is
   * always a little behind us (latency), so instead of guessing exactly which
   * moment it describes, find the closest point on the path we predicted over
   * the last ~1.2s: if the server lies on that path we agree (no correction);
   * only a real divergence — server blocked us, knocked us back, respawned
   * us — leaves a gap, and that gap is what gets blended out.
   */
  reconcile(serverMe) {
    const hist = this.history;
    if (hist.length < 2) return;
    let best = Infinity;
    let bx = hist[hist.length - 1].x;
    let by = hist[hist.length - 1].y;
    let bz = hist[hist.length - 1].z;
    for (let i = 1; i < hist.length; i += 1) {
      const a = hist[i - 1];
      const b = hist[i];
      // Closest point on segment a-b (xz), y interpolated along it.
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const len2 = abx * abx + abz * abz;
      const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((serverMe.x - a.x) * abx + (serverMe.z - a.z) * abz) / len2)) : 0;
      const px = a.x + abx * t;
      const pz = a.z + abz * t;
      const py = a.y + (b.y - a.y) * t;
      const d = (serverMe.x - px) ** 2 + (serverMe.z - pz) ** 2 + ((serverMe.y - py) * 0.5) ** 2;
      if (d < best) {
        best = d;
        bx = px;
        by = py;
        bz = pz;
      }
    }
    const ex = serverMe.x - bx;
    const ey = serverMe.y - by;
    const ez = serverMe.z - bz;
    const err = Math.hypot(ex, ez);
    if (err > SNAP_DISTANCE || Math.abs(ey) > SNAP_DISTANCE) {
      // Way off (respawn, teleport, knocked back): trust the server now.
      this.p.x = serverMe.x;
      this.p.y = serverMe.y;
      this.p.z = serverMe.z;
      this.p.vx = serverMe.vx || 0;
      this.p.vz = serverMe.vz || 0;
      this.p.vy = 0;
      this.pending = { x: 0, y: 0, z: 0 };
      this.history.length = 0;
      return;
    }
    if (err < DEADBAND && Math.abs(ey) < 0.25) return;
    this.pending = { x: ex, y: Math.abs(ey) > 0.25 ? ey : 0, z: ez };
  }

  /**
   * The interpolated state with "me" replaced by the predicted pose. Returns a
   * new object: interpState can hand back a raw snapshot, which must stay
   * untouched for reconciliation.
   */
  applyTo(state, myId) {
    if (!this.active || !this.p || !state?.players) return state;
    const pose = {
      x: this.p.x,
      y: this.p.y,
      z: this.p.z,
      vx: this.p.vx,
      vy: this.p.vy,
      vz: this.p.vz,
      crouching: this.p.crouching,
    };
    return { ...state, players: state.players.map((pl) => (pl.id === myId ? { ...pl, ...pose } : pl)) };
  }
}
