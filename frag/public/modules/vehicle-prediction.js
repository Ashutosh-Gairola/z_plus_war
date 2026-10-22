/**
 * Client-side prediction for the ground vehicle I'm driving.
 *
 * Without it, my own car was drawn from interpolated server snapshots: every
 * steer / throttle input took (send interval + round trip + interpolation
 * delay) ~200-350ms to show up, which feels like driving through mud.
 *
 * Now: start from the newest server state of my vehicle, replay the inputs
 * I sent that the server hasn't applied yet (the last ~RTT + time since that
 * snapshot arrived) with a copy of the server's car model
 * (vehicle-system.js updateCar), and draw that. When a new snapshot disagrees
 * (a crash, another car, a wall that didn't break), the difference is eased
 * out over a few frames instead of snapping.
 *
 * Mirrors vehicle-system.js — keep TUNING / GROUND_TYPES in sync.
 */

const TUNING = {
  ACCEL: 30,
  BRAKE: 44,
  REVERSE_ACCEL: 16,
  MAX_SPEED: 32,
  MAX_REVERSE: 11,
  DRAG: 1.15,
  PARK_DRAG: 3.4,
  TURN_RATE: 2.25,
  STEER_RESPONSE: 9,
  CRASH_MIN_SPEED: 7,
};
const GROUND_TYPES = {
  car: { accel: 1, maxSpeed: 1, turn: 1, radius: 2.2 },
  sports: { accel: 1.35, maxSpeed: 1.38, turn: 1.12, radius: 2.15 },
  suv: { accel: 0.92, maxSpeed: 0.94, turn: 0.92, radius: 2.4 },
  pickup: { accel: 0.95, maxSpeed: 0.97, turn: 0.9, radius: 2.5 },
  truck: { accel: 0.55, maxSpeed: 0.75, turn: 0.6, radius: 3.3 },
  bike: { accel: 1.3, maxSpeed: 1.25, turn: 1.45, radius: 1.1 },
  apc: { accel: 0.5, maxSpeed: 0.68, turn: 0.62, radius: 3.0 },
};
const STEP = 1 / 60;
const MAX_REPLAY_MS = 600;
const SNAP_DIST = 8;

function gripOf(w) {
  if (!w) return 1;
  const g = (k) => (k === "snow" ? 0.62 : k === "rain" || k === "storm" ? 0.8 : 1);
  const t = Math.max(0, Math.min(1, w.t ?? 1));
  return g(w.prev || w.kind) + (g(w.kind) - g(w.prev || w.kind)) * t;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class VehiclePredictor {
  constructor() {
    this.history = []; // { t, forward, back, left, right, dt }
    this.vehicleId = null;
    this.base = null; // server snapshot we last replayed from
    this.pred = null; // predicted state "now"
    this.err = { x: 0, z: 0, yaw: 0 }; // visual correction being eased out
    this.lastFrameAt = 0;
  }

  reset() {
    this.vehicleId = null;
    this.pred = null;
    this.base = null;
    this.history.length = 0;
    this.err = { x: 0, z: 0, yaw: 0 };
  }

  /** One server-identical car step. */
  step(v, inp, dt, grip, collide) {
    const spec = GROUND_TYPES[v.type] || GROUND_TYPES.car;
    let throttle = 0;
    if (inp.forward) throttle += 1;
    if (inp.back) throttle -= 1;
    if (v.disabled) throttle = 0;
    if (inp.back && v.speed > 1) {
      v.speed = Math.max(0, v.speed - TUNING.BRAKE * dt);
    } else if (throttle !== 0) {
      const accel = (throttle > 0 ? TUNING.ACCEL : TUNING.REVERSE_ACCEL) * spec.accel * (0.4 + 0.6 * grip);
      v.speed += throttle * accel * dt;
    }
    const drag = throttle !== 0 ? TUNING.DRAG : TUNING.PARK_DRAG;
    v.speed *= Math.exp(-drag * dt);
    v.speed = clamp(v.speed, -TUNING.MAX_REVERSE, TUNING.MAX_SPEED * spec.maxSpeed);
    if (Math.abs(v.speed) < 0.05) v.speed = 0;
    let steerInput = 0;
    if (inp.left) steerInput += 1;
    if (inp.right) steerInput -= 1;
    v.steer += (steerInput - v.steer) * Math.min(1, dt * TUNING.STEER_RESPONSE);
    const speedAbs = Math.abs(v.speed);
    const g = clamp(speedAbs / 6, 0, 1) * (1 - clamp((speedAbs - 18) / 40, 0, 0.4)) * (0.35 + 0.65 * grip);
    v.yaw += v.steer * TUNING.TURN_RATE * spec.turn * g * dt * Math.sign(v.speed || 1);
    const nx = v.x - Math.sin(v.yaw) * v.speed * dt;
    const nz = v.z - Math.cos(v.yaw) * v.speed * dt;
    const r = collide(nx, nz, spec.radius, speedAbs);
    if (r.hit) v.speed *= r.hard ? -0.24 : 0.9;
    v.x = r.x;
    v.z = r.z;
  }

  /**
   * Call every frame. Returns the pose to draw for my vehicle, or null when
   * I'm not driving a ground vehicle.
   */
  update({ me, snapshot, input, dt, rttMs, predictor, weather, half }) {
    const now = performance.now();
    const vid = me && me.alive && me.seat === "driver" ? me.inVehicle : null;
    const sv = vid ? (snapshot?.vehicles || []).find((v) => v.id === vid) : null;
    if (!sv || sv.destroyed || !GROUND_TYPES[sv.type]) {
      this.reset();
      return null;
    }
    if (vid !== this.vehicleId) {
      this.reset();
      this.vehicleId = vid;
    }

    // Record this frame's input.
    this.history.push({ t: now, forward: !!input.forward, back: !!input.back, left: !!input.left, right: !!input.right, dt });
    while (this.history.length && now - this.history[0].t > 2000) this.history.shift();

    const grip = gripOf(weather);
    const lim = (half || 640) - 3;
    const collide = (x, z, radius, speed) => {
      x = clamp(x, -lim, lim);
      z = clamp(z, -lim, lim);
      let hit = false;
      let hard = false;
      for (const p of predictor ? predictor.near(x, z) : []) {
        if (p.collidable === false || (p.py || 0) > 1.4 || p.sy <= 0.45) continue;
        const hx = p.sx / 2 + radius;
        const hz = p.sz / 2 + radius;
        const dx = x - p.x;
        const dz = z - p.z;
        const ox = hx - Math.abs(dx);
        const oz = hz - Math.abs(dz);
        if (ox <= 0 || oz <= 0) continue;
        // A hard ram usually smashes a breakable panel: drive on (the server
        // has the final word; a correction follows if it held).
        if (p.breakable && speed >= TUNING.CRASH_MIN_SPEED + 2) continue;
        if (ox < oz) x += dx >= 0 ? ox : -ox;
        else z += dz >= 0 ? oz : -oz;
        hit = true;
        hard = speed >= TUNING.CRASH_MIN_SPEED;
        break;
      }
      return { x, z, hit, hard };
    };

    // Replay from the newest authoritative state over the inputs the server
    // hasn't seen yet: those sent within ~RTT before that snapshot arrived,
    // plus everything since.
    const recvAt = snapshot._recvAt || now;
    const from = recvAt - clamp(rttMs || 80, 20, 400);
    const v = {
      type: sv.type,
      x: sv.x,
      z: sv.z,
      yaw: sv.yaw,
      speed: sv.speed || 0,
      steer: sv.steer || 0,
      disabled: (sv.health ?? 100) <= 0 || (sv.fuel ?? 100) <= 0,
    };
    let acc = 0;
    let simulated = 0;
    for (const h of this.history) {
      if (h.t < from) continue;
      acc += h.dt;
      while (acc >= STEP && simulated < MAX_REPLAY_MS / 1000) {
        this.step(v, h, STEP, grip, collide);
        acc -= STEP;
        simulated += STEP;
      }
    }
    if (acc > 0 && simulated < MAX_REPLAY_MS / 1000) {
      const last = this.history[this.history.length - 1];
      this.step(v, last, acc, grip, collide);
    }

    // Ease out any jump between where last frame's prediction would be now
    // (advanced by this frame's input) and the fresh replay.
    if (this.pred) {
      const adv = { ...this.pred };
      const cur = this.history[this.history.length - 1];
      this.step(adv, cur, dt, grip, collide);
      const ex = adv.x + this.err.x - v.x;
      const ez = adv.z + this.err.z - v.z;
      if (Math.hypot(ex, ez) > SNAP_DIST) {
        this.err = { x: 0, z: 0, yaw: 0 };
      } else {
        this.err = { x: ex, z: ez, yaw: wrap(adv.yaw + this.err.yaw - v.yaw) };
      }
    }
    const k = Math.exp(-dt * 12);
    this.err.x *= k;
    this.err.z *= k;
    this.err.yaw *= k;
    this.pred = { ...v };
    return {
      id: vid,
      x: v.x + this.err.x,
      z: v.z + this.err.z,
      yaw: v.yaw + this.err.yaw,
      speed: v.speed,
      steer: v.steer,
    };
  }
}

/** Put the predicted pose into a render state (vehicle + me in my seat). */
export function applyVehiclePose(state, pose, myId) {
  if (!pose || !state?.vehicles) return state;
  const vehicles = state.vehicles.map((v) =>
    v.id === pose.id ? { ...v, x: pose.x, z: pose.z, yaw: pose.yaw, speed: pose.speed, steer: pose.steer } : v,
  );
  const sv = state.vehicles.find((v) => v.id === pose.id);
  const players = (state.players || []).map((p) => {
    if (p.id !== myId || !sv) return p;
    // Carry me along with the car's predicted displacement.
    return { ...p, x: p.x + (pose.x - sv.x), z: p.z + (pose.z - sv.z) };
  });
  return { ...state, vehicles, players };
}
