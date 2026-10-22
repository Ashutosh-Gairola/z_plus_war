/**
 * Game state management
 */

// Column order of a compact zombie row (z_plus/server.js zombiesForSnapshot).
function decodeZombie(r) {
  return {
    id: r[0],
    t: r[1],
    x: r[2],
    y: r[3],
    z: r[4],
    yaw: r[5],
    hp: r[6],
    st: r[7],
    alive: r[8] === 1,
    atkMs: r[9] || undefined,
    scrMs: r[10] || undefined,
    em: r[11] || undefined,
    dp: r[8] === 1 ? undefined : r[12],
    boss: r[13] === 1 || undefined,
  };
}

export class GameState {
  constructor() {
    this.myId = null;
    this.joined = false;
    this.worldMeta = null;
    this.latestState = null;
    this.isScoped = false;
    this.pointerLocked = false;
    this.pingMs = null;

    this.stateBuffer = [];
    this.offsetSamples = [];
    this.MAX_BUFFER = 44;
    this.INTERP_DELAY_MS = 95;
    this.serverOffset = 0;

    this.seenShotIds = new Set();
    this.tracers = [];

    this.input = {
      forward: false,
      back: false,
      left: false,
      right: false,
      sprint: false,
      jump: false,
      crouch: false,
    };

    this.camera = {
      yaw: 0,
      pitch: 0,
      recoilPitchKick: 0,
      recoilYawKick: 0,
    };

    this.lastFrame = performance.now();
    this.lastFiredAt = 0;
    this.lastMeleeAt = 0;
  }

  setPlayerId(id) {
    this.myId = id;
  }

  setJoined(joined) {
    this.joined = joined;
  }

  setWorldMeta(meta) {
    this.worldMeta = meta;
  }

  setLatestState(state) {
    this.latestState = state;
  }

  setScoped(scoped) {
    this.isScoped = scoped;
  }

  setPointerLocked(locked) {
    this.pointerLocked = locked;
  }

  setPingMs(ping) {
    this.pingMs = ping;
  }

  recordOffset(serverTime) {
    const sample = Date.now() - serverTime;
    this.offsetSamples.push(sample);
    if (this.offsetSamples.length > 30) this.offsetSamples.shift();
    this.serverOffset = Math.min(...this.offsetSamples);
  }

  pushState(state) {
    if (!state || typeof state.serverTime !== "number") return;
    state._recvAt = performance.now(); // (vehicle prediction replays from here)
    // Z+ zombies arrive as compact rows; expand to objects once, here.
    if (state.zc) {
      state.zombies = state.zc.map(decodeZombie);
      delete state.zc;
    }
    // Vehicles arrive as deltas (only the ones that changed) between 1s
    // keyframes: fill in the rest from the last known full list.
    if (state.vehiclesPartial && this.knownVehicles) {
      const byId = new Map(this.knownVehicles.map((v) => [v.id, v]));
      for (const v of state.vehicles || []) byId.set(v.id, v);
      state.vehicles = Array.from(byId.values());
    }
    if (state.vehicles) this.knownVehicles = state.vehicles;
    this.recordOffset(state.serverTime);
    this.adaptInterpDelay(state.serverTime);
    this.stateBuffer.push(state);
    if (this.stateBuffer.length > this.MAX_BUFFER) {
      this.stateBuffer.splice(0, this.stateBuffer.length - this.MAX_BUFFER);
    }
  }

  /**
   * Size the interpolation delay to the connection. A fixed 95ms only covered
   * ~1 snapshot at 15Hz, so any network jitter (normal on phones) emptied the
   * buffer and everything froze then jumped. Delay = snapshot spacing + how
   * late snapshots actually arrive (90th percentile) + a little margin.
   */
  adaptInterpDelay(serverTime) {
    const lateness = Date.now() - serverTime - this.serverOffset; // >= 0
    this.latenessSamples = this.latenessSamples || [];
    this.latenessSamples.push(Math.max(0, lateness));
    if (this.latenessSamples.length > 60) this.latenessSamples.shift();
    if (this.lastSnapshotTime) {
      const gap = serverTime - this.lastSnapshotTime;
      if (gap > 0 && gap < 500) this.snapshotGap = this.snapshotGap ? this.snapshotGap * 0.9 + gap * 0.1 : gap;
    }
    this.lastSnapshotTime = serverTime;
    if (this.latenessSamples.length < 8) return;
    const sorted = [...this.latenessSamples].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const target = Math.max(80, Math.min(280, (this.snapshotGap || 60) + p90 + 12));
    // Ease toward the target so the view doesn't lurch when it changes.
    this.INTERP_DELAY_MS += (target - this.INTERP_DELAY_MS) * 0.1;
  }

  addShotId(id) {
    this.seenShotIds.add(id);
  }

  hasShotId(id) {
    return this.seenShotIds.has(id);
  }

  addTracer(tracer) {
    this.tracers.push(tracer);
  }

  getTracers() {
    return this.tracers;
  }

  removeTracer(index) {
    this.tracers.splice(index, 1);
  }

  getStateBuffer() {
    return this.stateBuffer;
  }

  updateLastFrame() {
    this.lastFrame = performance.now();
  }

  getLastFrame() {
    return this.lastFrame;
  }

  reset() {
    this.stateBuffer.length = 0;
    this.latestState = null;
    this.pingMs = null;
    this.joined = false;
    this.seenShotIds.clear();
    this.tracers.length = 0;
  }
}
