/**
 * Procedural audio for the FPS: gunshots, reloads, footsteps, vehicle engine,
 * hit feedback. Everything is synthesized with WebAudio so no asset files are
 * required. All play* methods are safe to call before the context unlocks.
 */

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.engine = null;

    const unlock = () => this.ensureContext();
    window.addEventListener("pointerdown", unlock, { once: false });
    window.addEventListener("keydown", unlock, { once: false });
  }

  ensureContext() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(this.ctx.destination);

    // 1 second of white noise, reused by every noise-based effect.
    const len = this.ctx.sampleRate;
    this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
  }

  get ready() {
    return Boolean(this.ctx && this.ctx.state === "running");
  }

  noiseBurst({ duration = 0.1, filterType = "lowpass", freq = 1200, q = 1, gain = 0.5, attack = 0.001, detuneSweep = 0 }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(freq, t);
    if (detuneSweep) filter.frequency.exponentialRampToValueAtTime(Math.max(60, freq + detuneSweep), t + duration);
    filter.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + duration + 0.05);
  }

  tone({ freq = 440, endFreq = 0, duration = 0.1, type = "sine", gain = 0.3, attack = 0.002 }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq > 0) osc.frequency.exponentialRampToValueAtTime(endFreq, t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  /** Gunshot. distance (meters) attenuates and muffles remote shots. */
  playGunshot(weaponKey, distance = 0) {
    if (!this.ready) return;
    const dist = Math.max(0, distance);
    const atten = 1 / (1 + dist * 0.045);
    if (atten < 0.03) return;
    const muffle = 1 / (1 + dist * 0.02);

    if (weaponKey === "sniper") {
      this.noiseBurst({ duration: 0.34, freq: 2600 * muffle, gain: 0.85 * atten, detuneSweep: -2200, q: 0.6 });
      this.tone({ freq: 110, endFreq: 38, duration: 0.3, type: "triangle", gain: 0.7 * atten });
    } else if (weaponKey === "smg") {
      this.noiseBurst({ duration: 0.09, freq: 3400 * muffle, gain: 0.42 * atten, detuneSweep: -2400, q: 0.8 });
      this.tone({ freq: 190, endFreq: 70, duration: 0.07, type: "square", gain: 0.16 * atten });
    } else if (weaponKey === "shotgun") {
      // Wide boom, then the pump rack.
      this.noiseBurst({ duration: 0.32, freq: 1800 * muffle, gain: 0.95 * atten, detuneSweep: -1500, q: 0.5 });
      this.tone({ freq: 90, endFreq: 32, duration: 0.28, type: "triangle", gain: 0.75 * atten });
      if (dist < 25) {
        setTimeout(() => this.noiseBurst({ duration: 0.06, freq: 1100, gain: 0.3 * atten, filterType: "bandpass", q: 2.5 }), 200);
        setTimeout(() => this.noiseBurst({ duration: 0.05, freq: 1500, gain: 0.32 * atten, filterType: "bandpass", q: 2.5 }), 330);
      }
    } else if (weaponKey === "revolver") {
      this.noiseBurst({ duration: 0.22, freq: 2400 * muffle, gain: 0.8 * atten, detuneSweep: -1900, q: 0.6 });
      this.tone({ freq: 130, endFreq: 45, duration: 0.2, type: "triangle", gain: 0.5 * atten });
    } else if (weaponKey === "lmg") {
      this.noiseBurst({ duration: 0.12, freq: 2600 * muffle, gain: 0.6 * atten, detuneSweep: -2000, q: 0.7 });
      this.tone({ freq: 120, endFreq: 48, duration: 0.1, type: "square", gain: 0.24 * atten });
    } else if (weaponKey === "burst") {
      this.noiseBurst({ duration: 0.12, freq: 3200 * muffle, gain: 0.5 * atten, detuneSweep: -2400, q: 0.7 });
      this.tone({ freq: 170, endFreq: 60, duration: 0.1, type: "triangle", gain: 0.26 * atten });
    } else if (weaponKey === "spread") {
      // Arcade "pew" — a falling square chirp per volley.
      this.tone({ freq: 900 * muffle, endFreq: 220, duration: 0.16, type: "square", gain: 0.28 * atten });
      this.noiseBurst({ duration: 0.08, freq: 2000 * muffle, gain: 0.25 * atten, q: 0.8 });
    } else if (weaponKey === "laser") {
      this.tone({ freq: 1800 * muffle, endFreq: 380, duration: 0.24, type: "sawtooth", gain: 0.22 * atten });
      this.tone({ freq: 2600 * muffle, endFreq: 1400, duration: 0.12, type: "sine", gain: 0.18 * atten });
    } else if (weaponKey === "launcher") {
      // Launch whoosh (the blast comes from the explosion event).
      this.noiseBurst({ duration: 0.5, freq: 900 * muffle, gain: 0.8 * atten, detuneSweep: 1400, q: 0.5 });
      this.tone({ freq: 70, endFreq: 40, duration: 0.35, type: "triangle", gain: 0.5 * atten });
    } else {
      this.noiseBurst({ duration: 0.14, freq: 3000 * muffle, gain: 0.55 * atten, detuneSweep: -2300, q: 0.7 });
      this.tone({ freq: 150, endFreq: 52, duration: 0.12, type: "triangle", gain: 0.3 * atten });
    }
  }

  playDryFire() {
    this.noiseBurst({ duration: 0.03, freq: 2200, gain: 0.18, filterType: "bandpass", q: 3 });
  }

  /** stage: "out" | "in" | "charge" */
  playReloadStage(stage) {
    if (stage === "out") {
      this.noiseBurst({ duration: 0.06, freq: 900, gain: 0.3, filterType: "bandpass", q: 2.5 });
    } else if (stage === "in") {
      this.noiseBurst({ duration: 0.05, freq: 1400, gain: 0.35, filterType: "bandpass", q: 2.5 });
      this.tone({ freq: 320, endFreq: 200, duration: 0.05, type: "square", gain: 0.08 });
    } else {
      this.noiseBurst({ duration: 0.08, freq: 2400, gain: 0.32, filterType: "bandpass", q: 3.5 });
      this.tone({ freq: 620, endFreq: 380, duration: 0.06, type: "square", gain: 0.07 });
    }
  }

  playWeaponSwitch() {
    this.noiseBurst({ duration: 0.09, freq: 700, gain: 0.22, filterType: "bandpass", q: 1.4 });
    this.tone({ freq: 260, endFreq: 180, duration: 0.08, type: "triangle", gain: 0.08 });
  }

  playMelee() {
    this.noiseBurst({ duration: 0.14, freq: 500, gain: 0.3, filterType: "bandpass", q: 0.8, detuneSweep: 900 });
  }

  playHitMarker(critical = false) {
    this.tone({ freq: critical ? 1150 : 780, endFreq: critical ? 900 : 620, duration: 0.06, type: "sine", gain: 0.24 });
  }

  playKill() {
    this.tone({ freq: 520, endFreq: 780, duration: 0.1, type: "sine", gain: 0.22 });
    setTimeout(() => this.tone({ freq: 780, endFreq: 1040, duration: 0.14, type: "sine", gain: 0.2 }), 90);
  }

  playDamage() {
    this.noiseBurst({ duration: 0.12, freq: 420, gain: 0.32, filterType: "lowpass", q: 0.7 });
  }

  playFootstep(sprinting = false) {
    this.noiseBurst({
      duration: 0.05,
      freq: sprinting ? 520 : 400,
      gain: sprinting ? 0.13 : 0.09,
      filterType: "lowpass",
      q: 0.6,
    });
  }

  playLand() {
    this.noiseBurst({ duration: 0.1, freq: 340, gain: 0.24, filterType: "lowpass", q: 0.6 });
  }

  playVehicleDoor() {
    this.noiseBurst({ duration: 0.08, freq: 900, gain: 0.3, filterType: "bandpass", q: 1.6 });
    this.tone({ freq: 180, endFreq: 120, duration: 0.1, type: "triangle", gain: 0.14 });
  }

  /** Metallic crash: bang + clatter, scaled by impact power and distance. */
  playCrash(power = 10, distance = 0) {
    const atten = Math.min(1, power / 18) / (1 + Math.max(0, distance) * 0.05);
    if (atten < 0.04) return;
    this.noiseBurst({ duration: 0.28, freq: 700, gain: 0.55 * atten, filterType: "bandpass", q: 0.7, detuneSweep: -500 });
    this.tone({ freq: 95, endFreq: 40, duration: 0.3, type: "triangle", gain: 0.4 * atten });
    this.tone({ freq: 2400, endFreq: 1500, duration: 0.09, type: "square", gain: 0.08 * atten });
  }

  /** A wall panel breaking: crunch of masonry. */
  playWallBreak(distance = 0) {
    const atten = 1 / (1 + Math.max(0, distance) * 0.05);
    if (atten < 0.05) return;
    this.noiseBurst({ duration: 0.35, freq: 520, gain: 0.6 * atten, filterType: "lowpass", q: 0.6 });
    this.noiseBurst({ duration: 0.18, freq: 1900, gain: 0.25 * atten, filterType: "bandpass", q: 1.2, detuneSweep: -900 });
    this.tone({ freq: 70, endFreq: 38, duration: 0.3, type: "triangle", gain: 0.35 * atten });
  }

  /** Structural groan of a building about to give way. */
  playCreak(distance = 0) {
    const atten = 1 / (1 + Math.max(0, distance) * 0.04);
    if (atten < 0.05) return;
    this.tone({ freq: 60, endFreq: 95, duration: 1.2, type: "sawtooth", gain: 0.12 * atten });
    this.tone({ freq: 140, endFreq: 90, duration: 0.9, type: "triangle", gain: 0.1 * atten });
  }

  /** Whole building collapsing: long rumble with crashing debris. */
  playCollapse(distance = 0) {
    const atten = 1 / (1 + Math.max(0, distance) * 0.025);
    if (atten < 0.04) return;
    this.noiseBurst({ duration: 2.6, freq: 380, gain: 0.9 * atten, filterType: "lowpass", q: 0.5 });
    this.tone({ freq: 48, endFreq: 28, duration: 2.4, type: "triangle", gain: 0.6 * atten });
    for (let i = 0; i < 6; i += 1) {
      setTimeout(() => this.noiseBurst({ duration: 0.3, freq: 900, gain: 0.4 * atten, filterType: "bandpass", q: 0.8 }), 200 + i * 320);
    }
  }

  // ---- Z+ rift / dragon ----

  /** Low, throbbing drone while a black hole is open. */
  startRiftHum() {
    if (!this.ready || this.riftHum) return;
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.32, t + 2.5);
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 220;
    const oscs = [38, 38.7, 57].map((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = i === 2 ? "triangle" : "sawtooth";
      o.frequency.value = f;
      o.connect(filter);
      o.start(t);
      return o;
    });
    // Wobble.
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    lfo.frequency.value = 0.35;
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start(t);
    filter.connect(g).connect(this.master);
    this.riftHum = { g, oscs: [...oscs, lfo] };
  }

  stopRiftHum() {
    if (!this.riftHum) return;
    const t = this.ctx.currentTime;
    const { g, oscs } = this.riftHum;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(0.0001, t + 1.5);
    for (const o of oscs) o.stop(t + 1.6);
    this.riftHum = null;
  }

  playRiftBurst() {
    if (!this.ready) return;
    this.tone({ freq: 30, endFreq: 18, duration: 3.2, type: "sine", gain: 0.9, attack: 0.01 });
    this.noiseBurst({ duration: 2.8, freq: 600, gain: 0.85, filterType: "lowpass", q: 0.4 });
    this.tone({ freq: 900, endFreq: 60, duration: 1.4, type: "sawtooth", gain: 0.18 });
  }

  /** Dragon roar: a falling growl with a noisy throat. size scales it. */
  playRoar(distance = 0, size = 1) {
    if (!this.ready) return;
    const atten = 1 / (1 + Math.max(0, distance) * 0.006);
    const g = 0.5 * atten * size;
    this.tone({ freq: 160 * (1.3 - size * 0.25), endFreq: 55, duration: 2.2 * size, type: "sawtooth", gain: g * 0.55, attack: 0.15 });
    this.tone({ freq: 112, endFreq: 40, duration: 2.4 * size, type: "square", gain: g * 0.25, attack: 0.2 });
    this.noiseBurst({ duration: 2 * size, freq: 700, gain: g * 0.8, filterType: "bandpass", q: 0.7, attack: 0.12 });
  }

  playDragonBreath(distance = 0) {
    if (!this.ready) return;
    const atten = 1 / (1 + Math.max(0, distance) * 0.012);
    this.noiseBurst({ duration: 3.2, freq: 1400, gain: 0.6 * atten, filterType: "lowpass", q: 0.5, attack: 0.25 });
    this.noiseBurst({ duration: 3.0, freq: 260, gain: 0.5 * atten, filterType: "lowpass", q: 0.8, attack: 0.3 });
  }

  playWhoosh(distance = 0) {
    if (!this.ready) return;
    const atten = 1 / (1 + Math.max(0, distance) * 0.02);
    this.noiseBurst({ duration: 0.7, freq: 500, gain: 0.5 * atten, filterType: "bandpass", q: 0.6, attack: 0.15, detuneSweep: 900 });
  }

  playThunder(distance = 0) {
    // Close strikes crack, distant ones just rumble.
    const near = Math.max(0, 1 - distance / 600);
    this.noiseBurst({ duration: 0.25, freq: 2400, gain: 0.5 * near * near, filterType: "highpass", q: 0.4 });
    this.noiseBurst({ duration: 3.2 + (1 - near) * 1.5, freq: 160 + near * 220, gain: 0.35 + 0.4 * near, filterType: "lowpass", q: 0.5, attack: 0.08 + (1 - near) * 0.4 });
    this.tone({ freq: 42, endFreq: 26, duration: 2.6, type: "triangle", gain: 0.3 * (0.4 + near) });
  }

  playTreeFall(distance = 0) {
    const atten = 1 / (1 + Math.max(0, distance) * 0.05);
    if (atten < 0.04) return;
    // Creak then whump.
    this.tone({ freq: 180, endFreq: 90, duration: 0.5, type: "sawtooth", gain: 0.14 * atten, attack: 0.1 });
    setTimeout(() => {
      this.noiseBurst({ duration: 0.4, freq: 240, gain: 0.4 * atten, filterType: "lowpass", q: 0.6 });
      this.tone({ freq: 70, endFreq: 35, duration: 0.35, type: "triangle", gain: 0.3 * atten });
    }, 450);
  }

  // ---- Zombie mode sounds ----

  playZombieGroan(distance = 0) {
    const atten = 1 / (1 + Math.max(0, distance) * 0.08);
    if (atten < 0.04) return;
    const base = 70 + Math.random() * 45;
    this.tone({ freq: base, endFreq: base * 0.6, duration: 0.7 + Math.random() * 0.4, type: "sawtooth", gain: 0.16 * atten, attack: 0.12 });
    this.noiseBurst({ duration: 0.5, freq: 260, gain: 0.08 * atten, filterType: "lowpass", q: 0.6, attack: 0.1 });
  }

  playZombieScream(distance = 0) {
    const atten = 1 / (1 + Math.max(0, distance) * 0.04);
    if (atten < 0.04) return;
    this.tone({ freq: 480, endFreq: 1250, duration: 0.5, type: "sawtooth", gain: 0.28 * atten, attack: 0.03 });
    this.tone({ freq: 700, endFreq: 400, duration: 0.7, type: "square", gain: 0.1 * atten, attack: 0.05 });
    this.noiseBurst({ duration: 0.65, freq: 2100, gain: 0.2 * atten, filterType: "bandpass", q: 1.4, detuneSweep: -900 });
  }

  playZombieAttack(distance = 0) {
    const atten = 1 / (1 + Math.max(0, distance) * 0.1);
    if (atten < 0.05) return;
    this.noiseBurst({ duration: 0.16, freq: 420, gain: 0.3 * atten, filterType: "bandpass", q: 0.9, detuneSweep: -260 });
    this.tone({ freq: 130, endFreq: 65, duration: 0.18, type: "sawtooth", gain: 0.18 * atten });
  }

  playZombieDeath(distance = 0) {
    const atten = 1 / (1 + Math.max(0, distance) * 0.09);
    if (atten < 0.05) return;
    this.tone({ freq: 150, endFreq: 42, duration: 0.75, type: "sawtooth", gain: 0.17 * atten, attack: 0.02 });
    this.noiseBurst({ duration: 0.3, freq: 500, gain: 0.1 * atten, filterType: "lowpass", q: 0.7 });
  }

  playEmerge(distance = 0) {
    const atten = 1 / (1 + Math.max(0, distance) * 0.08);
    if (atten < 0.05) return;
    // Earth cracking + a muffled snarl from below.
    this.noiseBurst({ duration: 0.45, freq: 160, gain: 0.34 * atten, filterType: "lowpass", q: 0.5, attack: 0.04 });
    this.tone({ freq: 55, endFreq: 90, duration: 0.4, type: "triangle", gain: 0.2 * atten, attack: 0.06 });
  }

  playSummon(distance = 0) {
    const atten = 1 / (1 + Math.max(0, distance) * 0.04);
    if (atten < 0.05) return;
    // Dissonant two-tone call.
    this.tone({ freq: 220, endFreq: 160, duration: 0.9, type: "sawtooth", gain: 0.16 * atten, attack: 0.08 });
    setTimeout(() => this.tone({ freq: 311, endFreq: 233, duration: 0.8, type: "sawtooth", gain: 0.13 * atten, attack: 0.06 }), 180);
  }

  playBossRoar() {
    this.tone({ freq: 130, endFreq: 45, duration: 1.5, type: "sawtooth", gain: 0.4, attack: 0.05 });
    this.tone({ freq: 90, endFreq: 38, duration: 1.7, type: "square", gain: 0.16, attack: 0.1 });
    this.noiseBurst({ duration: 1.2, freq: 420, gain: 0.28, filterType: "lowpass", q: 0.6, detuneSweep: -260, attack: 0.08 });
  }

  playWaveHorn() {
    this.tone({ freq: 196, endFreq: 174, duration: 1.1, type: "sawtooth", gain: 0.22, attack: 0.08 });
    setTimeout(() => this.tone({ freq: 147, endFreq: 138, duration: 1.4, type: "sawtooth", gain: 0.24, attack: 0.08 }), 350);
  }

  /** Continuous engine loop; call setEngine(speed) every frame, stopEngine() on exit. */
  setEngine(speed) {
    if (!this.ready) return;
    if (!this.engine) {
      const osc = this.ctx.createOscillator();
      osc.type = "sawtooth";
      const sub = this.ctx.createOscillator();
      sub.type = "triangle";
      const filter = this.ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 320;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      osc.connect(filter);
      sub.connect(filter);
      filter.connect(g).connect(this.master);
      osc.start();
      sub.start();
      this.engine = { osc, sub, filter, gain: g };
    }
    const s = Math.abs(speed);
    const t = this.ctx.currentTime;
    const rpm = 42 + s * 4.6;
    this.engine.osc.frequency.setTargetAtTime(rpm, t, 0.08);
    this.engine.sub.frequency.setTargetAtTime(rpm * 0.5, t, 0.08);
    this.engine.filter.frequency.setTargetAtTime(240 + s * 34, t, 0.1);
    this.engine.gain.gain.setTargetAtTime(0.05 + Math.min(0.1, s * 0.004), t, 0.1);
  }

  stopEngine() {
    if (!this.engine || !this.ctx) return;
    const { osc, sub, gain } = this.engine;
    const t = this.ctx.currentTime;
    gain.gain.setTargetAtTime(0, t, 0.12);
    setTimeout(() => {
      try {
        osc.stop();
        sub.stop();
      } catch (_e) { /* already stopped */ }
    }, 600);
    this.engine = null;
  }
}
