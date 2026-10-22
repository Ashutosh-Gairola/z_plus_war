/**
 * Z+ — Champion bosses (waves 5, 15, 25, ...; the dragon owns 10, 20, 30).
 *
 * Five original giant duelists, each built around a classic soulslike
 * archetype. They fight on foot (well — one rides), telegraph their big
 * moves with ground markers, have a phase-2 transformation at low HP, and
 * come back stronger every time the rotation repeats.
 *
 *   scarlet  Seraphine, Blade of the Scarlet Bloom — fast blade combos, heals
 *            from every hit she lands, aerial flurry dance; phase 2: rot bloom.
 *   titan    Varkhan, the Fallen Starlord — giant on a tiny horse: twin
 *            greatswords, gravity pull, homing gravity arrows, cavalry charge;
 *            phase 2: meteor crash + falling stars.
 *   omen     Morcant, the Hooded Omen — cane combos with delayed timings,
 *            thrown golden daggers, golden hammer, leap slam; phase 2: blade.
 *   beast    Kael'dris, the Black Blade — phase 1 beast: pounces, claws, holy
 *            stones; phase 2 black sword: wounds block all healing, blade
 *            waves, death ring.
 *   blood    Sanguis, Lord of the Blood Rite — trident combos, blood-flame
 *            fields, blood nova; phase 2: wings + the Blood Rite curse that
 *            drains everyone to heal him.
 *
 * Pure server logic; the host passes the same kind of env as the dragon.
 */

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const r2 = (v) => Math.round(v * 100) / 100;

const ROTATION = ["scarlet", "titan", "omen", "beast", "blood"];

const BOSSES = {
  scarlet: {
    name: "Seraphine",
    title: "Blade of the Scarlet Bloom",
    H: 9,
    hp: 5200,
    walk: 5,
    run: 15,
    lifesteal: 3.5, // HP regained per point of damage she deals
    p2: 0.5,
    agile: true,
    moves: [
      { key: "slash3", ph: [1, 2], range: [0, 13], cd: 1800, w: 3, dur: 1900 },
      { key: "thrust", ph: [1, 2], range: [8, 32], cd: 4500, w: 2, dur: 1300 },
      { key: "flurry", ph: [1, 2], range: [0, 26], cd: 20000, w: 5, dur: 3900 },
    ],
  },
  titan: {
    name: "Varkhan",
    title: "the Fallen Starlord",
    H: 15,
    hp: 8200,
    walk: 7,
    run: 20,
    p2: 0.55,
    moves: [
      { key: "twin_sweep", ph: [1, 2], range: [0, 19], cd: 2400, w: 3, dur: 2300 },
      { key: "gravity", ph: [1, 2], range: [8, 60], cd: 9000, w: 2, dur: 2700 },
      { key: "arrows", ph: [1, 2], range: [24, 150], cd: 6500, w: 3, dur: 2400 },
      { key: "charge", ph: [1, 2], range: [24, 110], cd: 8000, w: 2, dur: 2300 },
      { key: "meteor", ph: [2], range: [0, 220], cd: 24000, w: 6, dur: 5300 },
    ],
  },
  omen: {
    name: "Morcant",
    title: "the Hooded Omen",
    H: 8,
    hp: 4600,
    walk: 4,
    run: 13,
    p2: 0.6,
    agile: true,
    moves: [
      { key: "cane", ph: [1, 2], range: [0, 10], cd: 1500, w: 3, dur: 2600 },
      { key: "daggers", ph: [1, 2], range: [10, 60], cd: 5500, w: 3, dur: 2200 },
      { key: "hammer", ph: [1, 2], range: [0, 14], cd: 6500, w: 2, dur: 2300 },
      { key: "leap", ph: [1, 2], range: [12, 36], cd: 6000, w: 2, dur: 1800 },
      { key: "gblade", ph: [2], range: [0, 19], cd: 4500, w: 3, dur: 1700 },
    ],
  },
  beast: {
    name: "Kael'dris",
    title: "the Black Blade",
    H: 8.5,
    hp: 6200,
    walk: 6,
    run: 21,
    p2: 0.6,
    agile: true,
    moves: [
      { key: "pounce", ph: [1, 2], range: [10, 42], cd: 3200, w: 3, dur: 1500 },
      { key: "claws", ph: [1], range: [0, 9], cd: 1400, w: 3, dur: 1800 },
      { key: "stones", ph: [1], range: [15, 70], cd: 7500, w: 2, dur: 2100 },
      { key: "death_slash", ph: [2], range: [0, 18], cd: 2000, w: 3, dur: 1800 },
      { key: "blade_wave", ph: [2], range: [12, 90], cd: 5000, w: 3, dur: 1900 },
      { key: "death_ring", ph: [2], range: [0, 32], cd: 18000, w: 5, dur: 3000 },
    ],
  },
  blood: {
    name: "Sanguis",
    title: "Lord of the Blood Rite",
    H: 10,
    hp: 7200,
    walk: 5,
    run: 12,
    lifesteal: 1,
    p2: 0.5,
    moves: [
      { key: "trident", ph: [1, 2], range: [0, 13], cd: 1900, w: 3, dur: 2100 },
      { key: "blood_wave", ph: [1, 2], range: [10, 45], cd: 6500, w: 3, dur: 2200 },
      { key: "nova", ph: [1, 2], range: [0, 24], cd: 13000, w: 2, dur: 2400 },
      { key: "rite", ph: [2], range: [0, 250], cd: 38000, w: 6, dur: 4500 },
    ],
  },
};

const PHASE2_MS = { scarlet: 3200, titan: 2600, omen: 1800, beast: 3200, blood: 3000 };
const INTRO_MS = 4200;
const DEATHMARK_MS = 18000; // black-blade wounds: no healing at all
const RITE_MS = 9000;

function createBossEvent(env) {
  const E = {
    boss: null,
    phase: "none", // none | intro | fight | slain
    phaseAt: 0,
    encounters: { scarlet: 0, titan: 0, omen: 0, beast: 0, blood: 0 },
    projectiles: [],
    zones: [],
    rings: [], // expanding death rings
    marks: [], // telegraph circles { x, z, r, until, kind }
    rites: new Map(), // playerId -> until (Blood Rite curse)
    seq: 0,
  };

  const alivePlayers = () => Array.from(env.players.values()).filter((p) => p.alive);

  function power(enc) {
    const k = Math.max(0, enc - 1);
    return { hp: 1 + 0.5 * k, dmg: 1 + 0.2 * k, speed: 1 + 0.06 * Math.min(k, 6), cadence: Math.max(0.6, 1 - 0.1 * k) };
  }

  function active() {
    return E.phase !== "none";
  }

  /** Which champion owns this wave (5 -> scarlet, 15 -> titan, ...). */
  function kindForWave(wave) {
    return ROTATION[Math.floor((wave - 5) / 10) % ROTATION.length];
  }

  // ---------------------------------------------------------------------------
  // Start / end
  // ---------------------------------------------------------------------------

  function start(kind, now, opts = {}) {
    const ps = alivePlayers();
    if (!ps.length || active() || !BOSSES[kind]) return false;
    const cfg = BOSSES[kind];
    // Boss Test panel: summon at a chosen level.
    if (opts.level) E.encounters[kind] = Math.max(0, opts.level - 1);
    E.encounters[kind] += 1;
    const enc = E.encounters[kind];
    const pw = power(enc);
    let cx = 0;
    let cz = 0;
    for (const p of ps) {
      cx += p.x;
      cz += p.z;
    }
    cx /= ps.length;
    cz /= ps.length;
    // Arrive somewhere the players can actually SEE: open ground (not inside
    // or hugging a building), with a clear line of sight to them.
    const lim = env.worldHalf - 30;
    const clearSpot = (px, pz, pad) => {
      for (const p of env.propsNear(px, pz)) {
        if (p.collidable === false || p.sy < 1.5) continue;
        if (Math.abs(px - p.x) < p.sx / 2 + pad && Math.abs(pz - p.z) < p.sz / 2 + pad) return false;
      }
      return true;
    };
    let best = null;
    const a0 = Math.random() * Math.PI * 2;
    for (let i = 0; i < 36 && !(best && best.los); i += 1) {
      const ang = a0 + i * 2.39996; // golden-angle spiral of candidates
      const dist = 34 + (i % 4) * 7;
      const px = clamp(cx + Math.cos(ang) * dist, -lim, lim);
      const pz = clamp(cz + Math.sin(ang) * dist, -lim, lim);
      if (!clearSpot(px, pz, cfg.H * 0.35)) continue;
      const los = env.lineOfSight ? env.lineOfSight(cx, 2, cz, px, cfg.H * 0.5, pz) : true;
      if (!best || (los && !best.los)) best = { x: px, z: pz, los };
    }
    if (!best) {
      const ang = Math.random() * Math.PI * 2;
      best = { x: cx + Math.cos(ang) * 45, z: cz + Math.sin(ang) * 45 };
    }
    const x = best.x;
    const z = best.z;
    const testScale = (Number(process.env.ZPLUS_BOSS_HP_SCALE) || 1) * (opts.hpScale || 1);
    const maxHp = Math.round(cfg.hp * (1 + 0.45 * (env.players.size - 1)) * pw.hp * testScale);
    E.boss = {
      kind,
      cfg,
      level: enc,
      pw,
      x,
      z,
      y: env.groundHeight(x, z),
      yaw: Math.atan2(-(cx - x), -(cz - z)),
      hp: maxHp,
      maxHp,
      ph: 1,
      act: null, // current move
      cds: {},
      recoverUntil: now + INTRO_MS + 600,
      speed: 0,
      air: 0, // height above ground (leaps)
      contributors: new Map(),
      recentDamage: [],
      lastDodgeAt: 0,
      targetId: null,
      lastMeteorShowerAt: now,
      smashAt: 0,
    };
    E.phase = "intro";
    E.phaseAt = now;
    env.addZombieEvent("boss_intro", x, z, now, { kind, name: cfg.name, title: cfg.title, lvl: enc });
    env.addKillFeed(cfg.name.toUpperCase(), cfg.title, now);
    return true;
  }

  function reset() {
    for (const p of env.players.values()) p.healBlockedUntil = 0;
    E.boss = null;
    E.phase = "none";
    E.projectiles.length = 0;
    E.zones.length = 0;
    E.rings.length = 0;
    E.marks.length = 0;
    E.rites.clear();
  }

  // ---------------------------------------------------------------------------
  // Combat primitives
  // ---------------------------------------------------------------------------

  const fwd = (b) => ({ x: -Math.sin(b.yaw), z: -Math.cos(b.yaw) });

  function hurt(b, p, dmg, cause, now, knock = null, onHit = null) {
    if (!p.alive) return;
    const dealt = dmg * b.pw.dmg;
    env.hurtPlayer(p, dealt, `${b.cfg.name} (${cause})`, now);
    if (b.cfg.lifesteal && E.phase === "fight") b.hp = Math.min(b.maxHp, b.hp + dealt * b.cfg.lifesteal);
    if (knock && !p.inVehicle) env.knockback(p, knock.x, knock.y, knock.z);
    if (onHit) onHit(p);
  }

  /** Frontal arc in front of the boss. */
  function arc(b, reach, half, dmg, cause, now, knockF = 10, onHit = null) {
    const f = fwd(b);
    for (const p of alivePlayers()) {
      const dx = p.x - b.x;
      const dz = p.z - b.z;
      const d = Math.hypot(dx, dz);
      if (d > reach + 0.8 || p.y > b.y + b.air + b.cfg.H + 2) continue;
      if (d > 1.5 && (dx * f.x + dz * f.z) / d < Math.cos(half)) continue;
      hurt(b, p, dmg, cause, now, { x: (dx / (d || 1)) * knockF, y: knockF * 0.4, z: (dz / (d || 1)) * knockF }, onHit);
    }
    hitPets(b.x, b.z, reach, dmg * 0.3, now);
    // The swing tears through any wall it passes (3 points along the arc).
    const wallDmg = 260 + reach * 18;
    for (const off of [-half * 0.6, 0, half * 0.6]) {
      const ang = b.yaw + off;
      const r = reach * 0.7;
      env.blast({ x: b.x - Math.sin(ang) * r, y: b.y + Math.min(3, b.cfg.H * 0.3), z: b.z - Math.cos(ang) * r }, Math.max(2.5, reach * 0.28), wallDmg, now, null);
    }
    env.addZombieEvent("boss_arc", b.x, b.z, now, { yaw: r2(b.yaw), reach, half: r2(half), kind: b.kind });
  }

  function circle(b, cx, cz, r, dmg, cause, now, knockF = 12, onHit = null) {
    const gy = env.groundHeight(cx, cz);
    for (const p of alivePlayers()) {
      const dx = p.x - cx;
      const dz = p.z - cz;
      const d = Math.hypot(dx, dz);
      if (d > r || p.y > gy + 14) continue;
      hurt(b, p, dmg * (1 - (d / r) * 0.4), cause, now, { x: (dx / (d || 1)) * knockF, y: knockF * 0.5, z: (dz / (d || 1)) * knockF }, onHit);
    }
    hitPets(cx, cz, r, dmg * 0.3, now);
    for (const zb of env.zombies.values()) {
      if (zb.alive && Math.hypot(zb.x - cx, zb.z - cz) < r) env.hurtZombie(zb, dmg * 2, now);
    }
    // Ground slams / novas / landings smash nearby walls.
    if (r >= 4) env.blast({ x: cx, y: gy + 2, z: cz }, r * 0.65, 450 + r * 30, now, null);
    env.addZombieEvent("boss_circle", cx, cz, now, { r, kind: b.kind });
  }

  function hitPets(x, z, r, dmg, now) {
    if (env.hurtPetsNear) env.hurtPetsNear(x, z, r, dmg, now);
  }

  function mark(x, z, r, ms, now, kind = "danger") {
    E.marks.push({ x, z, r, until: now + ms, kind });
  }

  function proj(b, kind, x, y, z, vx, vy, vz, opts = {}) {
    E.seq += 1;
    E.projectiles.push({
      id: E.seq,
      kind,
      x,
      y,
      z,
      vx,
      vy,
      vz,
      gravity: opts.gravity || 0,
      homing: opts.homing || 0,
      targetId: opts.targetId || null,
      hitR: opts.hitR || 1.5,
      explodeR: opts.explodeR || 0,
      dmg: opts.dmg || 20,
      life: opts.life || 5000,
      bornAt: Date.now(),
      ground: Boolean(opts.ground),
      deathmark: Boolean(opts.deathmark),
      hitIds: new Set(),
      boss: b,
    });
  }

  /** Aim from (x,y,z) at a player's predicted position with `speed`. */
  function aimAt(p, from, speed, lead = 1) {
    const d = Math.hypot(p.x - from.x, (p.y - 1) - from.y, p.z - from.z);
    const t = (d / speed) * lead;
    const tx = p.x + (p.vx || 0) * t;
    const tz = p.z + (p.vz || 0) * t;
    const ty = p.y - 1;
    const dx = tx - from.x;
    const dy = ty - from.y;
    const dz = tz - from.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    return { x: (dx / l) * speed, y: (dy / l) * speed, z: (dz / l) * speed };
  }

  function zone(kind, x, z, r, ms, dps, now) {
    for (const zn of E.zones) {
      if (zn.kind === kind && Math.hypot(zn.x - x, zn.z - z) < r * 0.6) {
        zn.until = Math.max(zn.until, now + ms);
        return;
      }
    }
    E.zones.push({ kind, x, z, r, until: now + ms, dps, nextAt: now });
    if (E.zones.length > 50) E.zones.shift();
  }

  function deathmark(p, now) {
    p.healBlockedUntil = now + DEATHMARK_MS;
  }

  function moveForward(b, speed, dtSec) {
    const f = fwd(b);
    b.x += f.x * speed * dtSec;
    b.z += f.z * speed * dtSec;
  }

  function faceTo(b, p, dtSec, rate = 4) {
    const yaw = Math.atan2(-(p.x - b.x), -(p.z - b.z));
    b.yaw += clamp(wrap(yaw - b.yaw), -rate * dtSec, rate * dtSec);
  }

  /** Parabolic leap from b.leapFrom to b.leapTo between t0..t1 (ms). */
  function leap(b, t, t0, t1, peak) {
    if (t < t0 || t > t1) return;
    const k = (t - t0) / (t1 - t0);
    b.x = b.leapFrom.x + (b.leapTo.x - b.leapFrom.x) * k;
    b.z = b.leapFrom.z + (b.leapTo.z - b.leapFrom.z) * k;
    b.air = Math.sin(k * Math.PI) * peak;
  }

  function once(b, key, cond, fn) {
    if (cond && !b.act.done[key]) {
      b.act.done[key] = true;
      fn();
    }
  }

  // ---------------------------------------------------------------------------
  // Moves
  // ---------------------------------------------------------------------------

  function runMove(b, a, t, target, dtSec, now) {
    const cad = b.pw.cadence;
    switch (a.key) {
      // ---------------- Seraphine ----------------
      case "slash3": {
        if (t > 250 && t < 1650) moveForward(b, 6 * b.pw.speed, dtSec);
        if (t < 300) faceTo(b, target, dtSec, 6);
        for (const [i, at] of [450, 950, 1500].entries()) {
          once(b, `s${i}`, t >= at, () => {
            faceTo(b, target, 0.25, 6);
            arc(b, 11, 1.1, 18, "blade", now, 8);
          });
        }
        break;
      }
      case "thrust": {
        if (t < 550) faceTo(b, target, dtSec, 5);
        if (t >= 550 && t < 950) {
          moveForward(b, 52 * b.pw.speed, dtSec);
          const f = fwd(b);
          const fx = b.x + f.x * 3;
          const fz = b.z + f.z * 3;
          for (const p of alivePlayers()) {
            if (a.hitIds.has(p.id) || Math.hypot(p.x - fx, p.z - fz) > 3.8) continue;
            a.hitIds.add(p.id);
            hurt(b, p, 30, "thrust", now, { x: f.x * 14, y: 4, z: f.z * 14 });
          }
          smash(b, now);
        }
        break;
      }
      case "flurry": {
        // Rise... then three whirling dives onto the players.
        if (t < 900) {
          b.air = (t / 900) * 14;
          once(b, "mark", true, () => mark(b.x, b.z, 14, 900, now));
        } else if (t < 3300) {
          const n = Math.min(2, Math.floor((t - 900) / 800));
          once(b, `dive${n}`, true, () => {
            const ps = alivePlayers().filter((p) => Math.hypot(p.x - b.x, p.z - b.z) < 40);
            const p = ps.length ? ps[Math.floor(Math.random() * ps.length)] : target;
            b.x = p.x + rand(-3, 3);
            b.z = p.z + rand(-3, 3);
            mark(b.x, b.z, 12, 500, now);
          });
          const local = (t - 900) % 800;
          b.air = 4 + Math.abs(Math.sin(local / 800 * Math.PI)) * 3;
          once(b, `h${n}a`, local > 250, () => circle(b, b.x, b.z, 12, 15, "flurry", now, 6));
          once(b, `h${n}b`, local > 500, () => circle(b, b.x, b.z, 12, 15, "flurry", now, 6));
          b.yaw += dtSec * 14;
        } else {
          b.air = Math.max(0, b.air - dtSec * 30);
        }
        break;
      }
      case "p2_scarlet": {
        // The scarlet bloom: rises inside a giant flower and bursts.
        if (t < 1800) b.air = (t / 1800) * 9;
        once(b, "mark", true, () => mark(b.x, b.z, 28, 2200, now));
        once(b, "boom", t >= 2200, () => {
          circle(b, b.x, b.z, 28, 28, "scarlet bloom", now, 18);
          for (let i = 0; i < 5; i += 1) {
            const ang = (i / 5) * Math.PI * 2 + rand(-0.3, 0.3);
            zone("rot", b.x + Math.cos(ang) * rand(8, 18), b.z + Math.sin(ang) * rand(8, 18), 7, 30000, 6, now);
          }
          env.addZombieEvent("boss_bloom", b.x, b.z, now, {});
        });
        if (t > 2400) b.air = Math.max(0, b.air - dtSec * 12);
        break;
      }

      // ---------------- Varkhan ----------------
      case "twin_sweep": {
        if (t < 600) faceTo(b, target, dtSec, 3);
        if (t > 700 && t < 1700) moveForward(b, 5, dtSec);
        once(b, "a", t >= 800, () => arc(b, 17, 1.4, 34, "greatsword", now, 16));
        once(b, "b", t >= 1600, () => arc(b, 17, 1.4, 34, "greatsword", now, 16));
        break;
      }
      case "gravity": {
        once(b, "mark", true, () => mark(b.x, b.z, 15, 1900, now, "gravity"));
        if (t < 1600) {
          // Gravity well: everyone nearby is dragged toward him.
          if (now >= (a.nextPull || 0)) {
            a.nextPull = now + 200;
            for (const p of alivePlayers()) {
              const dx = b.x - p.x;
              const dz = b.z - p.z;
              const d = Math.hypot(dx, dz);
              if (d > 60 || d < 3 || p.inVehicle) continue;
              env.knockback(p, (dx / d) * 9, 1.5, (dz / d) * 9);
            }
          }
        }
        once(b, "slam", t >= 1900, () => circle(b, b.x, b.z, 15, 40, "gravity slam", now, 20));
        break;
      }
      case "arrows": {
        if (t < 700) faceTo(b, target, dtSec, 4);
        for (let i = 0; i < 5; i += 1) {
          once(b, `ar${i}`, t >= 700 + i * 300, () => {
            const ps = alivePlayers();
            const p = ps[Math.floor(Math.random() * ps.length)] || target;
            const from = { x: b.x, y: b.y + b.cfg.H * 0.8, z: b.z };
            const v = aimAt(p, from, 55);
            proj(b, "gravarrow", from.x, from.y, from.z, v.x, v.y + 6, v.z, { gravity: 9, homing: 1.1, targetId: p.id, explodeR: 5.5, dmg: 26 });
          });
        }
        break;
      }
      case "charge": {
        if (t < 500) faceTo(b, target, dtSec, 5);
        if (t >= 500 && t < 1800) {
          moveForward(b, 32 * b.pw.speed, dtSec);
          const f = fwd(b);
          for (const p of alivePlayers()) {
            if (a.hitIds.has(p.id) || Math.hypot(p.x - b.x, p.z - b.z) > 5.5) continue;
            a.hitIds.add(p.id);
            hurt(b, p, 30, "trampled", now, { x: f.x * 16 + rand(-6, 6), y: 8, z: f.z * 16 + rand(-6, 6) });
          }
          smash(b, now);
        }
        break;
      }
      case "meteor": {
        // Leaps out of sight and comes back down as a falling star.
        if (t < 700) break;
        if (t < 2600) {
          b.air = ((t - 700) / 1900) * 120;
          b.hidden = b.air > 60;
        } else if (t < 3400) {
          const pr = { x: target.x + (target.vx || 0) * 0.9, z: target.z + (target.vz || 0) * 0.9 };
          b.x = pr.x;
          b.z = pr.z;
          a.landX = pr.x;
          a.landZ = pr.z;
          once(b, "mark", true, () => mark(pr.x, pr.z, 24, 1500, now));
          if (E.marks.length) {
            E.marks[E.marks.length - 1].x = pr.x;
            E.marks[E.marks.length - 1].z = pr.z;
          }
        } else if (t < 4100) {
          b.hidden = false;
          b.air = Math.max(0, 120 * (1 - (t - 3400) / 700));
        } else {
          b.air = 0;
          once(b, "impact", true, () => {
            circle(b, b.x, b.z, 26, 60, "falling star", now, 26);
            env.blast({ x: b.x, y: 2, z: b.z }, 20, 1500, now, null, true);
            env.addZombieEvent("boss_meteor", b.x, b.z, now, {});
            for (let i = 0; i < 4; i += 1) {
              const ang = (i / 4) * Math.PI * 2;
              proj(b, "gravorb", b.x + Math.cos(ang) * 4, b.y + 3, b.z + Math.sin(ang) * 4, Math.cos(ang) * 14, 6, Math.sin(ang) * 14, {
                homing: 1.6,
                targetId: alivePlayers()[i % Math.max(1, alivePlayers().length)]?.id,
                explodeR: 5,
                dmg: 22,
                life: 6000,
              });
            }
          });
        }
        break;
      }
      case "p2_titan": {
        once(b, "roar", true, () => env.addZombieEvent("boss_roar", b.x, b.z, now, { kind: b.kind }));
        once(b, "pull", t >= 1200, () => circle(b, b.x, b.z, 20, 20, "starfall", now, 22));
        b.cds.meteor = 0; // the falling star comes right away
        break;
      }

      // ---------------- Morcant ----------------
      case "cane": {
        // Two or three swings with unpredictable (delayed) windups.
        if (!a.plan) {
          const n = Math.random() < 0.5 ? 2 : 3;
          let at = 0;
          a.plan = [];
          for (let i = 0; i < n; i += 1) {
            at += rand(420, 1050);
            a.plan.push(at);
          }
          a.dur = at + 500;
        }
        if (t < a.plan[0] - 200) faceTo(b, target, dtSec, 5);
        a.plan.forEach((at, i) => once(b, `c${i}`, t >= at, () => {
          faceTo(b, target, 0.2, 5);
          arc(b, 9, 1.2, 20, "cane", now, 9);
        }));
        break;
      }
      case "daggers": {
        if (t < 900) faceTo(b, target, dtSec, 5);
        for (let i = 0; i < 3; i += 1) {
          once(b, `d${i}`, t >= 900 + i * 350, () => {
            const from = { x: b.x + Math.cos(b.yaw) * (i - 1) * 2, y: b.y + b.cfg.H * 0.85, z: b.z - Math.sin(b.yaw) * (i - 1) * 2 };
            const v = aimAt(target, from, 75, 1);
            proj(b, "dagger", from.x, from.y, from.z, v.x, v.y, v.z, { hitR: 1.6, dmg: 16, life: 2500 });
          });
        }
        break;
      }
      case "hammer": {
        if (t < 900) faceTo(b, target, dtSec, 3);
        const f = fwd(b);
        once(b, "mark", t > 300, () => mark(b.x + f.x * 7, b.z + f.z * 7, 8, 800, now));
        once(b, "h1", t >= 1100, () => circle(b, b.x + f.x * 7, b.z + f.z * 7, 8, 40, "golden hammer", now, 18));
        if (b.ph === 2) once(b, "h2", t >= 1800, () => circle(b, b.x + f.x * 8, b.z + f.z * 8, 9, 34, "golden hammer", now, 18));
        break;
      }
      case "leap": {
        once(b, "aim", true, () => {
          b.leapFrom = { x: b.x, z: b.z };
          b.leapTo = { x: target.x + (target.vx || 0) * 0.6, z: target.z + (target.vz || 0) * 0.6 };
          faceTo(b, target, 1, 99);
          mark(b.leapTo.x, b.leapTo.z, 9, 1200, now);
        });
        leap(b, t, 250, 1200, 12);
        once(b, "land", t >= 1200, () => {
          b.air = 0;
          circle(b, b.x, b.z, 9, 34, "leap slam", now, 16);
        });
        break;
      }
      case "gblade": {
        if (t < 700) faceTo(b, target, dtSec, 4);
        once(b, "s", t >= 900, () => arc(b, 16, 1.6, 30, "golden blade", now, 14));
        break;
      }
      case "p2_omen": {
        once(b, "roar", true, () => env.addZombieEvent("boss_roar", b.x, b.z, now, { kind: b.kind }));
        break;
      }

      // ---------------- Kael'dris ----------------
      case "pounce": {
        once(b, "aim", true, () => {
          b.leapFrom = { x: b.x, z: b.z };
          b.leapTo = { x: target.x + (target.vx || 0) * 0.5, z: target.z + (target.vz || 0) * 0.5 };
          faceTo(b, target, 1, 99);
        });
        leap(b, t, 200, 900, 9);
        once(b, "land", t >= 900, () => {
          b.air = 0;
          circle(b, b.x, b.z, 7, 30, "pounce", now, 14);
        });
        break;
      }
      case "claws": {
        faceTo(b, target, dtSec, 6);
        if (t < 1500) moveForward(b, 5, dtSec);
        for (const [i, at] of [300, 650, 1000, 1350].entries()) once(b, `c${i}`, t >= at, () => arc(b, 8, 1.3, 12, "claws", now, 6));
        break;
      }
      case "stones": {
        if (t < 1000) faceTo(b, target, dtSec, 4);
        for (let i = 0; i < 5; i += 1) {
          once(b, `s${i}`, t >= 1000 + i * 140, () => {
            const ang = b.yaw + (i - 2) * 0.35;
            const from = { x: b.x - Math.sin(ang) * 3, y: b.y + b.cfg.H * 0.9, z: b.z - Math.cos(ang) * 3 };
            const v = aimAt(target, from, 45);
            proj(b, "stone", from.x, from.y, from.z, v.x, v.y, v.z, { homing: 0.8, targetId: target.id, explodeR: 3.5, dmg: 18 });
          });
        }
        break;
      }
      case "death_slash": {
        if (t < 600) faceTo(b, target, dtSec, 4);
        if (t > 600 && t < 1400) moveForward(b, 7, dtSec);
        const wound = (p) => deathmark(p, now);
        once(b, "a", t >= 800, () => arc(b, 17, 1.5, 30, "black blade", now, 12, wound));
        once(b, "b", t >= 1350, () => {
          faceTo(b, target, 0.3, 5);
          arc(b, 17, 1.5, 26, "black blade", now, 12, wound);
        });
        break;
      }
      case "blade_wave": {
        if (t < 700) faceTo(b, target, dtSec, 4);
        for (const [i, off] of [-0.22, 0, 0.22].entries()) {
          once(b, `w${i}`, t >= 800 + i * 300, () => {
            const ang = b.yaw + off;
            proj(b, "blackwave", b.x - Math.sin(ang) * 4, b.y + 1.2, b.z - Math.cos(ang) * 4, -Math.sin(ang) * 38, 0, -Math.cos(ang) * 38, {
              hitR: 4.2,
              dmg: 26,
              life: 2600,
              ground: true,
              deathmark: true,
            });
          });
        }
        break;
      }
      case "death_ring": {
        if (t < 1100) {
          b.air = (t / 1100) * 18;
          once(b, "mark", true, () => mark(b.x, b.z, 32, 2700, now));
        } else if (t < 1500) {
          b.air = Math.max(0, 18 * (1 - (t - 1100) / 400));
        } else {
          b.air = 0;
          once(b, "ring", true, () => {
            E.rings.push({ x: b.x, z: b.z, at: now, dur: 1200, r0: 2, r1: 32, band: 2.6, dmg: 40, hit: new Set(), boss: b });
            env.addZombieEvent("boss_ring", b.x, b.z, now, { r: 32 });
          });
        }
        break;
      }
      case "p2_beast": {
        once(b, "roar", true, () => env.addZombieEvent("boss_roar", b.x, b.z, now, { kind: b.kind }));
        once(b, "blast", t >= 2400, () => circle(b, b.x, b.z, 14, 20, "black flame", now, 16));
        break;
      }

      // ---------------- Sanguis ----------------
      case "trident": {
        if (t < 500) faceTo(b, target, dtSec, 4);
        const f = fwd(b);
        const thrust = (key, at) => once(b, key, t >= at, () => {
          const fx = b.x + f.x * 9;
          const fz = b.z + f.z * 9;
          for (const p of alivePlayers()) {
            if (Math.hypot(p.x - fx, p.z - fz) < 4 || Math.hypot(p.x - (b.x + f.x * 4), p.z - (b.z + f.z * 4)) < 3) {
              hurt(b, p, 24, "trident", now, { x: f.x * 12, y: 3, z: f.z * 12 });
            }
          }
          env.addZombieEvent("boss_thrust", fx, fz, now, { kind: b.kind });
        });
        thrust("t1", 650);
        thrust("t2", 1200);
        once(b, "sweep", t >= 1700, () => {
          arc(b, 13, 1.4, 22, "trident sweep", now, 12);
          for (let i = 1; i <= 3; i += 1) zone("blood", b.x + f.x * i * 4, b.z + f.z * i * 4, 3.2, 6000, 8, now);
        });
        break;
      }
      case "blood_wave": {
        if (t < 900) faceTo(b, target, dtSec, 4);
        once(b, "wave", t >= 1000, () => {
          arc(b, 40, 0.55, 18, "bloodflame", now, 8);
          for (let r = 8; r <= 40; r += 8) {
            for (const off of [-0.35, 0, 0.35]) {
              const ang = b.yaw + off;
              zone("blood", b.x - Math.sin(ang) * r, b.z - Math.cos(ang) * r, 4, 8000, 10, now);
            }
          }
          env.addZombieEvent("boss_bloodwave", b.x, b.z, now, { yaw: r2(b.yaw) });
        });
        break;
      }
      case "nova": {
        once(b, "mark", true, () => mark(b.x, b.z, 22, 1600, now));
        once(b, "boom", t >= 1600, () => {
          circle(b, b.x, b.z, 22, 32, "blood nova", now, 15);
          zone("blood", b.x, b.z, 9, 9000, 10, now);
        });
        break;
      }
      case "rite": {
        // Wings spread, the Blood Rite: everyone is cursed; every drop of
        // blood it drains heals him. When the curse ends, the cursed burst.
        if (t < 1500) b.air = (t / 1500) * 8;
        once(b, "curse", t >= 1500, () => {
          for (const p of alivePlayers()) E.rites.set(p.id, now + RITE_MS);
          env.addZombieEvent("boss_rite", b.x, b.z, now, {});
        });
        if (t > 3500) b.air = Math.max(0, b.air - dtSec * 10);
        break;
      }
      case "p2_blood": {
        once(b, "roar", true, () => env.addZombieEvent("boss_roar", b.x, b.z, now, { kind: b.kind }));
        if (t < 2000) b.air = (t / 2000) * 4;
        else b.air = Math.max(0, b.air - dtSec * 6);
        b.cds.rite = 0;
        break;
      }
      case "dodge": {
        if (t < 380) {
          b.x += a.dvx * dtSec;
          b.z += a.dvz * dtSec;
          b.air = Math.sin((t / 380) * Math.PI) * 2;
        } else b.air = 0;
        break;
      }
      default:
    }
    void cad;
  }

  /** Walk / run / ride through anything breakable. */
  function smash(b, now) {
    if (now < b.smashAt) return;
    for (const p of env.propsNear(b.x, b.z)) {
      if (p.collidable === false || !p.breakable) continue;
      if (Math.abs(b.x - p.x) > p.sx / 2 + 2.5 || Math.abs(b.z - p.z) > p.sz / 2 + 2.5) continue;
      if ((p.py || 0) > b.y + b.cfg.H) continue;
      b.smashAt = now + 300;
      env.blast({ x: b.x, y: 2, z: b.z }, 4.5, 800, now, null);
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------

  function pickTarget(b) {
    const ps = alivePlayers();
    if (!ps.length) return null;
    let cur = ps.find((p) => p.id === b.targetId);
    if (!cur || Math.random() < 0.01) {
      cur = ps.reduce((a, c) => (Math.hypot(a.x - b.x, a.z - b.z) < Math.hypot(c.x - b.x, c.z - b.z) ? a : c));
      b.targetId = cur.id;
    }
    return cur;
  }

  function chooseMove(b, target, now) {
    const d = Math.hypot(target.x - b.x, target.z - b.z);
    const options = b.cfg.moves.filter((m) => m.ph.includes(b.ph) && d >= m.range[0] && d <= m.range[1] && now >= (b.cds[m.key] || 0));
    if (!options.length) return null;
    let total = options.reduce((s, m) => s + m.w, 0);
    let r = Math.random() * total;
    for (const m of options) {
      r -= m.w;
      if (r <= 0) return m;
    }
    return options[options.length - 1];
  }

  function startAct(b, key, dur, now, cd = 0) {
    b.act = { key, at: now, dur, done: {}, hitIds: new Set() };
    if (cd) b.cds[key] = now + cd * b.pw.cadence;
    env.addZombieEvent("boss_act", b.x, b.z, now, { act: key, kind: b.kind });
  }

  function updateProjectiles(dtSec, now) {
    for (let i = E.projectiles.length - 1; i >= 0; i -= 1) {
      const pr = E.projectiles[i];
      if (pr.homing && pr.targetId) {
        const tp = env.players.get(pr.targetId);
        if (tp && tp.alive) {
          const sp = Math.hypot(pr.vx, pr.vy, pr.vz) || 1;
          const want = { x: tp.x - pr.x, y: tp.y - 1 - pr.y, z: tp.z - pr.z };
          const wl = Math.hypot(want.x, want.y, want.z) || 1;
          const k = Math.min(1, pr.homing * dtSec);
          pr.vx += ((want.x / wl) * sp - pr.vx) * k;
          pr.vy += ((want.y / wl) * sp - pr.vy) * k;
          pr.vz += ((want.z / wl) * sp - pr.vz) * k;
        }
      }
      pr.vy -= pr.gravity * dtSec;
      pr.x += pr.vx * dtSec;
      pr.y += pr.vy * dtSec;
      pr.z += pr.vz * dtSec;
      if (pr.ground) pr.y = env.groundHeight(pr.x, pr.z) + 1.2;
      const b = pr.boss;
      let explode = now - pr.bornAt > pr.life || (!pr.ground && pr.y <= env.groundHeight(pr.x, pr.z) + 0.2);
      // Flying projectiles stop at (and break) the walls they hit.
      let hitWall = false;
      if (!explode && !pr.ground) {
        for (const p of env.propsNear(pr.x, pr.z)) {
          if (p.collidable === false || p.sy < 1) continue;
          if (Math.abs(pr.x - p.x) > p.sx / 2 + 0.4 || Math.abs(pr.z - p.z) > p.sz / 2 + 0.4) continue;
          if (pr.y < (p.py || 0) - 0.3 || pr.y > (p.py || 0) + p.sy + 0.3) continue;
          explode = true;
          hitWall = true;
          break;
        }
      }
      for (const p of alivePlayers()) {
        if (pr.hitIds.has(p.id)) continue;
        if (Math.hypot(p.x - pr.x, p.y - 0.9 - pr.y, p.z - pr.z) > pr.hitR + 0.5) continue;
        if (pr.explodeR) {
          explode = true;
          break;
        }
        pr.hitIds.add(p.id);
        hurt(b, p, pr.dmg, pr.kind, now, { x: pr.vx * 0.2, y: 3, z: pr.vz * 0.2 }, pr.deathmark ? (q) => deathmark(q, now) : null);
        if (!pr.ground) explode = true;
      }
      if (!explode && pr.ground) {
        // Blade waves cut through walls as they go.
        for (const p of env.propsNear(pr.x, pr.z)) {
          if (p.breakable && p.collidable !== false && Math.abs(pr.x - p.x) < p.sx / 2 + 2 && Math.abs(pr.z - p.z) < p.sz / 2 + 2) {
            env.blast({ x: pr.x, y: 2, z: pr.z }, 3, 600, now, null);
            break;
          }
        }
      }
      if (!explode) continue;
      E.projectiles.splice(i, 1);
      if (hitWall || pr.explodeR) env.blast({ x: pr.x, y: pr.y, z: pr.z }, Math.max(2.5, (pr.explodeR || 2) * 0.8), pr.explodeR ? 700 : 380, now, null);
      if (pr.explodeR) {
        circle(b, pr.x, pr.z, pr.explodeR, pr.dmg, pr.kind, now, 10);
        if (pr.kind === "smallmeteor") env.blast({ x: pr.x, y: 1, z: pr.z }, 5, 700, now, null);
      }
      env.addZombieEvent("boss_proj_hit", pr.x, pr.z, now, { y: r2(pr.y), pk: pr.kind });
    }
  }

  function updateZones(now) {
    for (let i = E.zones.length - 1; i >= 0; i -= 1) {
      const zn = E.zones[i];
      if (now > zn.until) {
        E.zones.splice(i, 1);
        continue;
      }
      if (now < zn.nextAt) continue;
      zn.nextAt = now + 500;
      for (const p of alivePlayers()) {
        if (p.y < env.groundHeight(p.x, p.z) + 3.5 && Math.hypot(p.x - zn.x, p.z - zn.z) < zn.r) {
          env.hurtPlayer(p, zn.dps * 0.5 * (E.boss?.pw.dmg || 1), zn.kind === "rot" ? "Scarlet rot" : "Bloodflame", now);
        }
      }
    }
    for (let i = E.rings.length - 1; i >= 0; i -= 1) {
      const rg = E.rings[i];
      const k = (now - rg.at) / rg.dur;
      if (k >= 1) {
        E.rings.splice(i, 1);
        continue;
      }
      const R = rg.r0 + (rg.r1 - rg.r0) * k;
      for (const p of alivePlayers()) {
        if (rg.hit.has(p.id)) continue;
        const d = Math.hypot(p.x - rg.x, p.z - rg.z);
        if (Math.abs(d - R) < rg.band && p.y < env.groundHeight(p.x, p.z) + 4) {
          rg.hit.add(p.id);
          hurt(rg.boss, p, rg.dmg, "death ring", now, { x: ((p.x - rg.x) / (d || 1)) * 14, y: 6, z: ((p.z - rg.z) / (d || 1)) * 14 }, (q) => deathmark(q, now));
        }
      }
    }
    for (let i = E.marks.length - 1; i >= 0; i -= 1) if (now > E.marks[i].until) E.marks.splice(i, 1);
    // Blood Rite: drain + heal, then burst.
    for (const [pid, until] of E.rites) {
      const p = env.players.get(pid);
      if (!p || !p.alive) {
        E.rites.delete(pid);
        continue;
      }
      if (now >= until) {
        E.rites.delete(pid);
        if (E.boss) circle(E.boss, p.x, p.z, 6, 26, "blood rite", now, 10);
        zone("blood", p.x, p.z, 5, 6000, 10, now);
        continue;
      }
      if (now >= (p.riteTickAt || 0)) {
        p.riteTickAt = now + 500;
        const dmg = 2 * (E.boss?.pw.dmg || 1);
        env.hurtPlayer(p, dmg, "Blood Rite", now);
        if (E.boss) E.boss.hp = Math.min(E.boss.maxHp, E.boss.hp + dmg * 6);
      }
    }
  }

  function update(dtSec, now) {
    if (E.phase === "none") return;
    // Everyone disconnected: pause the fight (a refresh or a phone dropping
    // its connection must not delete the boss); give up after 30s.
    if (env.players.size === 0) {
      if (!E.emptySince) E.emptySince = now;
      if (now - E.emptySince > 30000) reset();
      return;
    }
    E.emptySince = 0;
    const b = E.boss;
    updateProjectiles(dtSec, now);
    updateZones(now);
    if (E.phase === "slain") {
      b.air = Math.max(0, b.air - dtSec * 10);
      if (now - E.phaseAt > 5000) {
        reset();
        env.onEventEnd(now);
      }
      return;
    }
    const target = pickTarget(b);
    if (E.phase === "intro") {
      if (target) faceTo(b, target, dtSec, 2);
      if (now - E.phaseAt > INTRO_MS) {
        E.phase = "fight";
        E.phaseAt = now;
      }
      b.y = env.groundHeight(b.x, b.z);
      return;
    }
    if (!target) return;

    // Phase 2 at low HP: a transformation move (briefly untouchable).
    if (b.ph === 1 && b.hp < b.maxHp * b.cfg.p2 && !b.act) {
      b.ph = 2;
      startAct(b, `p2_${b.kind}`, PHASE2_MS[b.kind], now);
      env.addZombieEvent("boss_phase2", b.x, b.z, now, { kind: b.kind });
    }

    // Titan phase 2: stars keep falling on the players.
    if (b.kind === "titan" && b.ph === 2 && now - b.lastMeteorShowerAt > 7000 * b.pw.cadence) {
      b.lastMeteorShowerAt = now;
      for (const p of alivePlayers().slice(0, 4)) {
        const x = p.x + rand(-6, 6);
        const z = p.z + rand(-6, 6);
        mark(x, z, 6, 1700, now);
        proj(b, "smallmeteor", x + rand(-20, 20), 110, z + rand(-20, 20), 0, 0, 0, { explodeR: 6, dmg: 24, life: 4000 });
        const pr = E.projectiles[E.projectiles.length - 1];
        pr.vx = (x - pr.x) / 1.6;
        pr.vz = (z - pr.z) / 1.6;
        pr.vy = -(110 - 1) / 1.6;
      }
    }

    if (b.act) {
      const t = now - b.act.at;
      runMove(b, b.act, t, target, dtSec, now);
      if (t >= b.act.dur) {
        b.act = null;
        b.air = 0;
        b.hidden = false;
        b.recoverUntil = now + rand(250, 650) * b.pw.cadence;
      }
    } else if (now >= b.recoverUntil) {
      const m = chooseMove(b, target, now);
      if (m) {
        faceTo(b, target, 0.25, 99);
        startAct(b, m.key, m.dur, now, m.cd);
      } else {
        // Close the distance (run when far, stalk when close).
        const d = Math.hypot(target.x - b.x, target.z - b.z);
        faceTo(b, target, dtSec, 3);
        const sp = (d > 30 ? b.cfg.run : b.cfg.walk) * b.pw.speed * (b.kind === "scarlet" && b.ph === 2 ? 1.25 : 1);
        if (d > 6) moveForward(b, sp, dtSec);
        b.speed = d > 6 ? sp : 0;
        smash(b, now);
      }
    } else {
      faceTo(b, target, dtSec, 2.5);
      b.speed = 0;
    }
    if (b.act) b.speed = 0;
    const lim = env.worldHalf - 10;
    b.x = clamp(b.x, -lim, lim);
    b.z = clamp(b.z, -lim, lim);
    b.y = env.groundHeight(b.x, b.z);
  }

  // ---------------------------------------------------------------------------
  // Being hit
  // ---------------------------------------------------------------------------

  function hitSpheres(b) {
    const H = b.cfg.H;
    const y = b.y + b.air;
    const out = [
      { x: b.x, y: y + H * 0.9, z: b.z, r: H * 0.1, part: "head", mult: 2 },
      { x: b.x, y: y + H * 0.66, z: b.z, r: H * 0.17, part: "body", mult: 1 },
      { x: b.x, y: y + H * 0.42, z: b.z, r: H * 0.15, part: "body", mult: 1 },
      { x: b.x, y: y + H * 0.18, z: b.z, r: H * 0.13, part: "legs", mult: 0.8 },
    ];
    if (b.kind === "titan") {
      // Rides a (tiny) horse: the mount soaks hits too.
      const f = fwd(b);
      out.push({ x: b.x + f.x * 2, y: y + H * 0.2, z: b.z + f.z * 2, r: H * 0.16, part: "mount", mult: 0.6 });
    }
    return out;
  }

  function bulletHit(from, to, radius = 0.1) {
    const b = E.boss;
    if (!b || E.phase !== "fight" || b.hidden) return null;
    const sx = to.x - from.x;
    const sy = to.y - from.y;
    const sz = to.z - from.z;
    const len2 = sx * sx + sy * sy + sz * sz || 1e-9;
    const mx = (from.x + to.x) / 2 - b.x;
    const mz = (from.z + to.z) / 2 - b.z;
    if (mx * mx + mz * mz > (Math.sqrt(len2) / 2 + b.cfg.H) ** 2) return null;
    let best = null;
    for (const s of hitSpheres(b)) {
      let t = ((s.x - from.x) * sx + (s.y - from.y) * sy + (s.z - from.z) * sz) / len2;
      t = clamp(t, 0, 1);
      const px = from.x + sx * t - s.x;
      const py = from.y + sy * t - s.y;
      const pz = from.z + sz * t - s.z;
      if (px * px + py * py + pz * pz <= (s.r + radius) ** 2 && (!best || t < best.t)) best = { t, part: s.part, mult: s.mult };
    }
    return best;
  }

  function damage(amount, attacker, part, now) {
    const b = E.boss;
    if (!b || E.phase !== "fight") return 0;
    if (b.act && b.act.key.startsWith("p2_")) amount *= 0.2; // transforming: barely scratched
    b.hp -= amount;
    if (attacker) {
      const c = b.contributors.get(attacker.id) || { dmg: 0, name: attacker.name };
      c.dmg += amount;
      b.contributors.set(attacker.id, c);
    }
    // Agile champions sidestep a burst of damage.
    b.recentDamage.push([now, amount]);
    while (b.recentDamage.length && now - b.recentDamage[0][0] > 1200) b.recentDamage.shift();
    const burst = b.recentDamage.reduce((s, x) => s + x[1], 0);
    if (b.cfg.agile && !b.act && b.hp > 0 && burst > b.maxHp * 0.03 && now - b.lastDodgeAt > 5000 * b.pw.cadence && attacker) {
      b.lastDodgeAt = now;
      const dx = b.x - attacker.x;
      const dz = b.z - attacker.z;
      const d = Math.hypot(dx, dz) || 1;
      const side = Math.random() < 0.5 ? 1 : -1;
      startAct(b, "dodge", 500, now);
      b.act.dvx = ((dx / d) * 0.6 + (-dz / d) * side * 0.8) * 34;
      b.act.dvz = ((dz / d) * 0.6 + (dx / d) * side * 0.8) * 34;
    }
    if (b.hp <= 0) {
      b.hp = 0;
      E.phase = "slain";
      E.phaseAt = now;
      E.rites.clear();
      for (const p of env.players.values()) {
        p.healBlockedUntil = 0;
        if (p.alive) p.health = 100; // victory: everyone patched up
      }
      const total = [...b.contributors.values()].reduce((s, c) => s + c.dmg, 0) || 1;
      for (const [id, c] of b.contributors) {
        const p = env.players.get(id);
        if (p) {
          p.score += Math.round(300 + 2000 * (c.dmg / total));
          p.kills += 1;
        }
      }
      const top = [...b.contributors.values()].sort((a, c) => c.dmg - a.dmg)[0];
      env.addKillFeed(top ? top.name : "The survivors", `${b.cfg.name.toUpperCase()}, ${b.cfg.title}`, now);
      env.addZombieEvent("boss_slain", b.x, b.z, now, { kind: b.kind, name: b.cfg.name });
    }
    return amount;
  }

  function hostile() {
    const b = E.boss;
    if (!b || E.phase !== "fight" || b.hidden) return null;
    return { id: "boss", isBoss: true, x: b.x, y: b.y + b.air + b.cfg.H * 0.6, z: b.z, alive: true };
  }

  function serialize(now) {
    if (E.phase === "none") return null;
    const b = E.boss;
    const out = {
      ph: E.phase,
      t: now - E.phaseAt,
      k: b.kind,
      name: b.cfg.name,
      title: b.cfg.title,
      lvl: b.level,
      x: r2(b.x),
      y: r2(b.y + b.air),
      z: r2(b.z),
      yaw: r2(b.yaw),
      hp: Math.round(b.hp),
      max: b.maxHp,
      p2: b.ph === 2 ? 1 : undefined,
      act: b.act ? b.act.key : undefined,
      at: b.act ? now - b.act.at : undefined,
      dur: b.act ? b.act.dur : undefined,
      sp: r2(b.speed || 0),
      air: b.air > 0.05 ? r2(b.air) : undefined,
      hid: b.hidden ? 1 : undefined,
      H: b.cfg.H,
    };
    if (E.projectiles.length) out.pr = E.projectiles.map((p) => [p.id, p.kind, r2(p.x), r2(p.y), r2(p.z), r2(Math.atan2(-p.vx, -p.vz))]);
    if (E.zones.length) out.zn = E.zones.map((z) => [z.kind, r2(z.x), r2(z.z), z.r, Math.max(0, z.until - now)]);
    if (E.marks.length) out.mk = E.marks.map((m) => [r2(m.x), r2(m.z), m.r, Math.max(0, m.until - now), m.kind]);
    if (E.rings.length) out.rg = E.rings.map((r) => [r2(r.x), r2(r.z), r2(r.r0 + (r.r1 - r.r0) * Math.min(1, (now - r.at) / r.dur))]);
    const st = [];
    for (const p of env.players.values()) {
      if (p.healBlockedUntil && p.healBlockedUntil > now) st.push([p.id, "death", p.healBlockedUntil - now]);
    }
    for (const [pid, until] of E.rites) st.push([pid, "rite", until - now]);
    if (st.length) out.st = st;
    return out;
  }

  return { start, update, active, reset, bulletHit, damage, hostile, serialize, kindForWave };
}

module.exports = { createBossEvent, BOSSES, ROTATION };
