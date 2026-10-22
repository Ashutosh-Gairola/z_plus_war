/**
 * Z+ — "The Rift" boss event (every 10th wave: 10, 20, 30, ...).
 *
 *   1. VORTEX  — a black hole tears open in the sky above the players. Every
 *                zombie on the map is ripped off the ground, spirals up and
 *                is swallowed. Regular waves pause.
 *   2. BURST   — once the horde is consumed the rift implodes, and from it
 *                hatches the Undead Wyrm. The more it swallowed, the more HP.
 *   3. DRAGON  — a flying boss that never lands:
 *                - circles and strafes, barrel-rolls to dodge burst damage
 *                - FIRE BREATH dives: a burning cone that sets the ground on
 *                  fire and chews through buildings
 *                - FIREBALL volleys: explosive shots that blow walls apart
 *                - ROAR: summons zombies around the players
 *                - DEVOUR: opens its own black hole and swallows nearby
 *                  zombies to regenerate (shoot them first to deny it)
 *                - smashes through anything it flies into
 *   4. Slain   — it falls out of the sky; the normal wave cycle resumes.
 *
 * Pure server logic; the host (z_plus/server.js) passes an env of helpers.
 */

// The Wyrm is BIG (Elden Ring scale): ~55m nose to tail, ~75m wingspan.
// Every body-relative distance (head, hitboxes, mouth) is in model units x S.
const S = 2.4;
const GROUND_H = 4.9 * S; // body-center height when standing (matches the model's planted legs)

const VORTEX_ALT = 46;
const VORTEX_MIN_MS = 7000; // drama: at least this long even with few zombies
const VORTEX_MAX_MS = 22000; // stragglers get swallowed at the end regardless
const BURST_MS = 2600;
const DRAGON_SPEED = 34;
const DRAGON_ACCEL = 18;
const MIN_ALT = 22;
const MAX_ALT = 95;
const BREATH_RANGE = 48;
const BREATH_HALF_ANGLE = 0.42; // rad
const FIREBALL_SPEED = 36;
const FIREBALL_GRAVITY = 7;
const FIREBALL_RADIUS = 9;
const DEVOUR_RADIUS = 160;
const DEVOUR_HEAL = 0.035; // of max HP per zombie swallowed
const FIRE_ZONE_MS = 6000;
const FIRE_ZONE_DPS = 7;
// Ground phase (sudden landing -> ground attacks -> takeoff).
const SLAM_RADIUS = 22;
const SLAM_DAMAGE = 55;
const GROUND_MS = 7500;
const SLAM_COOLDOWN_MS = 16000;

// Mini-dragon companion (reward for every player present when a Wyrm dies).
const PET = {
  HP: 50, // half a player
  BREATH_MS: 5000, // breathes fire for 5s...
  COOLDOWN_MS: 5000, // ...then needs 5s to rekindle
  RANGE: 15,
  HALF_ANGLE: 0.5,
  TICK_DMG: 10, // per 250ms tick = 40 dps to everything in the cone
  RESPAWN_MS: 45000,
  HP_UP: 1.1, // each further Wyrm kill: +10% HP
  ATK_UP: 1.2, // ...and +20% attack
};

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const r2 = (v) => Math.round(v * 100) / 100;

function createDragonEvent(env) {
  const E = {
    phase: "none", // none | vortex | burst | dragon | slain
    phaseAt: 0,
    encounters: 0,
    vortex: null, // { x, y, z, r, consumed, kind: "rift" | "devour" }
    dragon: null,
    fireballs: [],
    fireZones: [],
    fireSeq: 0,
    pets: new Map(), // ownerId -> mini dragon companion (reward for slaying the Wyrm)
    tracks: new Map(), // playerId -> recent positions, for the Wyrm's predictions
  };

  // Per-encounter power curve: every Wyrm is tougher, hits harder, flies
  // faster, attacks more often and knows more tricks than the last.
  function power(enc) {
    const k = Math.max(0, enc - 1);
    return {
      hp: 1 + 0.5 * k,
      dmg: 1 + 0.2 * k,
      speed: 1 + 0.07 * Math.min(k, 6),
      volleyExtra: Math.min(4, k),
      cadence: Math.max(0.55, 1 - 0.12 * k), // shorter pauses between attacks
      dodgeCd: Math.max(2200, 4500 - 700 * k),
      tactics: Math.min(4, enc), // 1: lead + break cover, 2: +flank / flush campers / see through strafing, 3: +feints & dives, 4: all, faster
    };
  }

  const alivePlayers = () => Array.from(env.players.values()).filter((p) => p.alive);

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  function active() {
    return E.phase !== "none";
  }

  function start(now, opts = {}) {
    const ps = alivePlayers();
    if (!ps.length || active()) return false;
    // Boss Test panel: summon at a chosen level / reduced HP.
    if (opts.level) E.encounters = Math.max(0, opts.level - 1);
    E.testHpScale = opts.hpScale || 1;
    let cx = 0;
    let cz = 0;
    for (const p of ps) {
      cx += p.x;
      cz += p.z;
    }
    cx /= ps.length;
    cz /= ps.length;
    E.encounters += 1;
    E.phase = "vortex";
    E.phaseAt = now;
    E.vortex = { x: cx, y: VORTEX_ALT, z: cz, r: 3, consumed: 0, kind: "rift" };
    for (const zb of env.zombies.values()) if (zb.alive) grab(zb, now);
    env.addZombieEvent("rift_open", cx, cz, now, { wave: env.waveNumber() });
    env.addKillFeed("THE RIFT", "opens over the city", now);
    return true;
  }

  function reset() {
    for (const zb of env.zombies.values()) zb.pulled = false;
    E.phase = "none";
    E.vortex = null;
    E.dragon = null;
    E.fireballs.length = 0;
    E.fireZones.length = 0;
  }

  /** Mark a zombie as caught in a vortex (its own AI stops; we move it). */
  function grab(zb, now) {
    if (zb.pulled) return;
    zb.pulled = true;
    zb.state = "pulled";
    zb.pullStart = now;
    zb.pullSpin = rand(-1, 1) > 0 ? 1 : -1;
    zb.emergingUntil = 0;
  }

  /** Drag every pulled zombie toward the vortex; swallow those that arrive. */
  function pullZombies(dtSec, now, target, radius, onConsume) {
    for (const zb of env.zombies.values()) {
      if (!zb.alive) continue;
      if (!zb.pulled) {
        if (radius && Math.hypot(zb.x - target.x, zb.z - target.z) <= radius) grab(zb, now);
        else if (!radius) grab(zb, now);
        if (!zb.pulled) continue;
      }
      const dx = target.x - zb.x;
      const dy = target.y - zb.y;
      const dz = target.z - zb.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      if (d < 3.2) {
        zb.alive = false;
        zb.pulled = false;
        zb.deathAt = now - 2500; // removed next zombie update, no corpse
        zb.consumed = true;
        onConsume(zb);
        continue;
      }
      const t = (now - zb.pullStart) / 1000;
      const speed = Math.min(70, 6 + t * 7 + d * 0.22);
      // Spiral in: mostly toward the center, plus a swirl around it.
      const hx = dx / d;
      const hz = dz / d;
      const swirl = 0.55 * zb.pullSpin;
      zb.x += (hx - hz * swirl) * speed * dtSec;
      zb.z += (hz + hx * swirl) * speed * dtSec;
      // Rise: lift off first, then home in on the center height.
      const lift = Math.min(1, t * 0.9);
      zb.y += (dy / d) * speed * dtSec * lift + (t < 1.2 ? 5 * dtSec : 0);
      zb.y = Math.max(0, zb.y);
      zb.yaw += zb.pullSpin * dtSec * (2 + t * 2);
    }
  }

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------

  /** Remember where everyone has been (the Wyrm reads movement patterns). */
  function trackPlayers(now) {
    for (const p of env.players.values()) {
      let t = E.tracks.get(p.id);
      if (!t) E.tracks.set(p.id, (t = { pts: [], still: now, sx: p.x, sz: p.z }));
      if (!t.pts.length || now - t.pts[t.pts.length - 1].t >= 150) {
        t.pts.push({ t: now, x: p.x, z: p.z });
        if (t.pts.length > 40) t.pts.shift(); // ~6s
      }
      if (Math.hypot(p.x - t.sx, p.z - t.sz) > 7) {
        t.still = now;
        t.sx = p.x;
        t.sz = p.z;
      }
    }
    for (const id of E.tracks.keys()) if (!env.players.has(id)) E.tracks.delete(id);
  }

  /**
   * Where will this player be in `lead` seconds? Smarter Wyrms read patterns:
   * side-to-side strafing (velocity keeps flipping) is aimed at its center
   * instead of wherever the player happens to be heading this instant.
   */
  function predictPos(p, lead, tactics) {
    const t = E.tracks.get(p.id);
    if (!t || t.pts.length < 4) return { x: p.x + (p.vx || 0) * lead, z: p.z + (p.vz || 0) * lead };
    const pts = t.pts;
    const a = pts[Math.max(0, pts.length - 5)];
    const b = pts[pts.length - 1];
    const dt = Math.max(0.15, (b.t - a.t) / 1000);
    const vx = (b.x - a.x) / dt;
    const vz = (b.z - a.z) / dt;
    if (tactics >= 2 && pts.length >= 12) {
      // Count direction reversals over the last ~2s.
      let flips = 0;
      let prev = null;
      let cx = 0;
      let cz = 0;
      const recent = pts.slice(-14);
      for (let i = 1; i < recent.length; i += 1) {
        const dx = recent[i].x - recent[i - 1].x;
        const dz = recent[i].z - recent[i - 1].z;
        const dir = Math.abs(dx) > Math.abs(dz) ? Math.sign(dx) : Math.sign(dz) * 2;
        if (prev !== null && dir !== 0 && dir === -prev) flips += 1;
        if (dir !== 0) prev = dir;
        cx += recent[i].x;
        cz += recent[i].z;
      }
      if (flips >= 3) return { x: cx / (recent.length - 1), z: cz / (recent.length - 1), strafer: true };
    }
    return { x: p.x + vx * lead, z: p.z + vz * lead };
  }

  // ---------------------------------------------------------------------------
  // Mini-dragon companions
  // ---------------------------------------------------------------------------

  function grantPets(now) {
    for (const p of env.players.values()) {
      let pet = E.pets.get(p.id);
      if (pet) {
        // Another Wyrm down: the little one grows.
        pet.level += 1;
        pet.hpMult *= PET.HP_UP;
        pet.atkMult *= PET.ATK_UP;
        pet.maxHp = Math.round(PET.HP * pet.hpMult);
        pet.hp = pet.maxHp;
        pet.deadUntil = 0;
      } else {
        pet = {
          ownerId: p.id,
          x: p.x,
          y: p.y + 8,
          z: p.z,
          yaw: 0,
          level: 1,
          hpMult: 1,
          atkMult: 1,
          maxHp: PET.HP,
          hp: PET.HP,
          phase: "ready", // ready | breath | cool
          phaseUntil: 0,
          nextTickAt: 0,
          deadUntil: 0,
          orbit: Math.random() * Math.PI * 2,
        };
        E.pets.set(p.id, pet);
      }
      env.addZombieEvent("pet_bond", p.x, p.z, now, { owner: p.id, level: pet.level });
    }
  }

  function petTarget(pet, owner, now) {
    const d = E.dragon;
    if (d && E.phase === "dragon" && Math.hypot(d.x - owner.x, d.z - owner.z) < 80) {
      return { x: d.x, y: d.y, z: d.z, dragon: true };
    }
    // A champion boss (boss-system.js) is fair game too.
    const boss = env.bossTarget ? env.bossTarget() : null;
    if (boss && Math.hypot(boss.x - owner.x, boss.z - owner.z) < 80) {
      return { x: boss.x, y: boss.y, z: boss.z, dragon: true, boss: true };
    }
    let best = null;
    let bestD = 38;
    for (const zb of env.zombies.values()) {
      if (!zb.alive || zb.pulled) continue;
      const dd = Math.hypot(zb.x - owner.x, zb.z - owner.z);
      if (dd < bestD) {
        bestD = dd;
        best = zb;
      }
    }
    return best ? { x: best.x, y: best.y + 1, z: best.z, zb: best } : null;
  }

  function hurtPet(pet, dmg, now) {
    if (pet.deadUntil) return;
    pet.hp -= dmg;
    if (pet.hp <= 0) {
      pet.hp = 0;
      pet.deadUntil = now + PET.RESPAWN_MS;
      env.addZombieEvent("pet_down", pet.x, pet.z, now, { owner: pet.ownerId, y: pet.y });
    }
  }

  function updatePets(dtSec, now) {
    for (const [ownerId, pet] of E.pets) {
      const owner = env.players.get(ownerId);
      if (!owner) {
        E.pets.delete(ownerId);
        continue;
      }
      if (pet.deadUntil) {
        if (now < pet.deadUntil) continue;
        pet.deadUntil = 0;
        pet.hp = pet.maxHp;
        pet.x = owner.x;
        pet.y = owner.y + 8;
        pet.z = owner.z;
        env.addZombieEvent("pet_revive", pet.x, pet.z, now, { owner: ownerId });
      }
      const tgt = owner.alive ? petTarget(pet, owner, now) : null;
      // Breath cycle: 5s of fire, 5s to rekindle.
      if (pet.phase === "breath" && now >= pet.phaseUntil) {
        pet.phase = "cool";
        pet.phaseUntil = now + PET.COOLDOWN_MS;
      } else if (pet.phase === "cool" && now >= pet.phaseUntil) {
        pet.phase = "ready";
      }
      const tdist = tgt ? Math.hypot(tgt.x - pet.x, tgt.y - pet.y, tgt.z - pet.z) : Infinity;
      if (pet.phase === "ready" && tgt && tdist < PET.RANGE + 6) {
        pet.phase = "breath";
        pet.phaseUntil = now + PET.BREATH_MS;
      }

      // Movement: escort the owner; close in on whatever it's burning.
      let goal;
      if (tgt && pet.phase !== "cool") {
        const hd = Math.hypot(pet.x - tgt.x, pet.z - tgt.z) || 1;
        const standoff = tgt.dragon ? 14 : 8;
        goal = {
          x: tgt.x + ((pet.x - tgt.x) / hd) * standoff,
          y: tgt.dragon ? tgt.y - 2 : tgt.y + 5,
          z: tgt.z + ((pet.z - tgt.z) / hd) * standoff,
        };
      } else {
        pet.orbit += dtSec * 0.9;
        goal = { x: owner.x + Math.cos(pet.orbit) * 4.5, y: (owner.y || 1.7) + 5.5, z: owner.z + Math.sin(pet.orbit) * 4.5 };
      }
      const dx = goal.x - pet.x;
      const dy = goal.y - pet.y;
      const dz = goal.z - pet.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 120) {
        // Left far behind (owner drove / respawned): catch up instantly.
        pet.x = goal.x;
        pet.y = goal.y;
        pet.z = goal.z;
      } else {
        const sp = Math.min(dist * 2.4, 26);
        pet.x += (dx / (dist || 1)) * sp * dtSec;
        pet.y += (dy / (dist || 1)) * sp * dtSec;
        pet.z += (dz / (dist || 1)) * sp * dtSec;
      }
      pet.y = clamp(pet.y, 2.5, 70);
      const face = tgt && pet.phase === "breath" ? tgt : goal;
      const yaw = Math.atan2(-(face.x - pet.x), -(face.z - pet.z));
      if (Math.hypot(face.x - pet.x, face.z - pet.z) > 0.5) pet.yaw += wrap(yaw - pet.yaw) * Math.min(1, dtSec * 6);

      // Fire!
      if (pet.phase === "breath" && tgt && now >= pet.nextTickAt) {
        pet.nextTickAt = now + 250;
        const dmg = PET.TICK_DMG * pet.atkMult;
        const fx = -Math.sin(pet.yaw);
        const fz = -Math.cos(pet.yaw);
        if (tgt.boss) {
          if (tdist < PET.RANGE + 10 && env.damageBoss) env.damageBoss(dmg, owner, now);
        } else if (tgt.dragon) {
          if (tdist < PET.RANGE + 10) damage(dmg, owner, "body", now);
        } else {
          for (const zb of env.zombies.values()) {
            if (!zb.alive || zb.pulled) continue;
            const vx = zb.x - pet.x;
            const vz = zb.z - pet.z;
            const vy = zb.y + 1 - pet.y;
            const dd = Math.hypot(vx, vy, vz);
            if (dd > PET.RANGE) continue;
            const hcos = (vx * fx + vz * fz) / (Math.hypot(vx, vz) || 1);
            if (hcos < Math.cos(PET.HALF_ANGLE)) continue;
            env.hurtZombieBy(zb, dmg, owner, now);
          }
        }
      }
    }
  }

  /** Seconds this player has stayed within a few meters (camping). */
  function stillFor(p, now) {
    const t = E.tracks.get(p.id);
    return t ? (now - t.still) / 1000 : 0;
  }

  function update(dtSec, now) {
    trackPlayers(now);
    updatePets(dtSec, now);
    if (E.phase === "none") return;
    // Everyone disconnected: pause (a refresh / dropped connection must not
    // delete the event); give up after 30s.
    if (env.players.size === 0) {
      if (!E.emptySince) E.emptySince = now;
      if (now - E.emptySince > 30000) reset();
      return;
    }
    E.emptySince = 0;
    const elapsed = now - E.phaseAt;

    if (E.phase === "vortex") {
      const v = E.vortex;
      v.r = Math.min(9, 3 + elapsed / 900);
      pullZombies(dtSec, now, v, 0, () => {
        v.consumed += 1;
        v.r = Math.min(12, v.r + 0.08);
      });
      let left = 0;
      for (const zb of env.zombies.values()) if (zb.alive) left += 1;
      if (elapsed > VORTEX_MAX_MS) {
        for (const zb of env.zombies.values()) {
          if (!zb.alive) continue;
          zb.alive = false;
          zb.deathAt = now - 2500;
          zb.consumed = true;
          v.consumed += 1;
        }
        left = 0;
      }
      if (elapsed > VORTEX_MIN_MS && left === 0) {
        E.phase = "burst";
        E.phaseAt = now;
        env.addZombieEvent("rift_burst", v.x, v.z, now, { y: v.y, consumed: v.consumed });
      }
      return;
    }

    if (E.phase === "burst") {
      if (elapsed > BURST_MS) spawnDragon(now);
      return;
    }

    if (E.phase === "dragon" || E.phase === "slain") {
      updateDragon(dtSec, now);
      updateFireballs(dtSec, now);
      updateFireZones(dtSec, now);
      if (E.phase === "slain" && now - E.phaseAt > 6000 && !E.fireballs.length) {
        reset();
        env.onEventEnd(now);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // The dragon
  // ---------------------------------------------------------------------------

  function spawnDragon(now) {
    const v = E.vortex;
    const ps = Math.max(1, env.players.size);
    const pw = power(E.encounters);
    // ZPLUS_DRAGON_HP_SCALE: tests / events can make it quicker to kill.
    const testScale = (Number(process.env.ZPLUS_DRAGON_HP_SCALE) || 1) * (E.testHpScale || 1);
    const maxHp = Math.round((7500 * (1 + 0.45 * (ps - 1)) + v.consumed * 60) * pw.hp * testScale);
    E.dragon = {
      level: E.encounters,
      pw,
      tactic: null,
      x: v.x,
      y: v.y,
      z: v.z,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: Math.random() * Math.PI * 2,
      pitch: 0,
      roll: 0,
      hp: maxHp,
      maxHp,
      mode: "emerge",
      modeAt: now,
      modeUntil: now + 2600,
      orbitAngle: Math.random() * Math.PI * 2,
      orbitDir: Math.random() < 0.5 ? 1 : -1,
      targetId: null,
      nextBreathTickAt: 0,
      nextBlastAt: 0,
      volleyLeft: 0,
      nextVolleyAt: 0,
      lastSummonAt: now,
      lastDevourAt: now,
      lastDodgeAt: 0,
      dodgeDir: 1,
      recentDamage: [],
      contributors: new Map(),
      smashAt: 0,
      grounded: false,
      lastSlamAt: now,
      land: null,
      gAct: null,
      nextGActAt: 0,
    };
    E.phase = "dragon";
    E.phaseAt = now;
    E.vortex = null;
    env.addZombieEvent("dragon_spawn", v.x, v.z, now, { y: v.y, hp: maxHp });
    env.addKillFeed("UNDEAD WYRM", "has hatched from the rift", now);
  }

  function pickTarget(d) {
    const ps = alivePlayers();
    if (!ps.length) return null;
    let cur = ps.find((p) => p.id === d.targetId);
    if (!cur || Math.random() < 0.25) {
      // Prefer whoever hurt it most recently, else the nearest.
      cur = ps.reduce((a, b) => (Math.hypot(a.x - d.x, a.z - d.z) < Math.hypot(b.x - d.x, b.z - d.z) ? a : b));
      const top = [...d.contributors.entries()].sort((a, b) => b[1].recent - a[1].recent)[0];
      const angry = top && ps.find((p) => p.id === top[0]);
      if (angry && Math.random() < 0.6) cur = angry;
      d.targetId = cur.id;
    }
    return cur;
  }

  function forward(d) {
    const cp = Math.cos(d.pitch);
    return { x: -Math.sin(d.yaw) * cp, y: Math.sin(d.pitch), z: -Math.cos(d.yaw) * cp };
  }

  /** Mouth position (head is ~10m ahead of the body center). */
  function mouth(d) {
    const f = forward(d);
    const k = 12.2 * S;
    return { x: d.x + f.x * k + (d.headX || 0), y: d.y + f.y * k + 0.6 * S + (d.headY || 0), z: d.z + f.z * k + (d.headZ || 0) };
  }

  function setMode(d, mode, now, ms) {
    d.mode = mode;
    d.modeAt = now;
    d.modeUntil = now + ms;
  }

  function chooseNextMode(d, now, target, player) {
    const hpFrac = d.hp / d.maxHp;
    const T = d.pw.tactics;
    d.tactic = null;
    let nearbyZombies = 0;
    for (const zb of env.zombies.values()) {
      if (zb.alive && !zb.pulled && Math.hypot(zb.x - d.x, zb.z - d.z) < DEVOUR_RADIUS) nearbyZombies += 1;
    }
    if (hpFrac < 0.6 && nearbyZombies >= 3 && now - d.lastDevourAt > 22000 * d.pw.cadence) {
      d.lastDevourAt = now;
      setMode(d, "devour", now, 6500);
      env.addZombieEvent("dragon_devour", d.x, d.z, now, { y: d.y });
      return;
    }
    if (hpFrac < 0.85 && now - d.lastSummonAt > 30000 * d.pw.cadence && Math.random() < 0.5) {
      d.lastSummonAt = now;
      setMode(d, "roar", now, 2200);
      env.addZombieEvent("dragon_roar", d.x, d.z, now, { y: d.y });
      return;
    }

    // ---- Sudden landing: crash down onto the players and fight on foot ----
    if (player && now - d.lastSlamAt > SLAM_COOLDOWN_MS * d.pw.cadence) {
      const ps = alivePlayers();
      // A tight group of players is an irresistible target.
      let cluster = null;
      for (const a of ps) {
        const near = ps.filter((b) => Math.hypot(a.x - b.x, a.z - b.z) < 18);
        if (near.length >= 2 && (!cluster || near.length > cluster.length)) cluster = near;
      }
      const chance = 0.32 + (hpFrac < 0.5 ? 0.15 : 0) + (cluster ? 0.35 : 0);
      if (Math.random() < chance) {
        let lx = player.x;
        let lz = player.z;
        if (cluster) {
          lx = cluster.reduce((s2, q) => s2 + q.x, 0) / cluster.length;
          lz = cluster.reduce((s2, q) => s2 + q.z, 0) / cluster.length;
        } else if (T >= 2) {
          const pr = predictPos(player, 2.5, T);
          lx = pr.x;
          lz = pr.z;
        }
        d.lastSlamAt = now;
        d.land = { x: lx, z: lz };
        d.tactic = cluster ? "slam_group" : "slam";
        setMode(d, "slam_rise", now, 5000);
        env.addZombieEvent("dragon_slam_mark", lx, lz, now, { tactic: d.tactic });
        return;
      }
    }

    // ---- Tactics: read the players before attacking ----
    if (player) {
      // Hiding indoors / behind cover: smash the cover first.
      const exposed = env.lineOfSight(d.x, d.y, d.z, player.x, player.y, player.z);
      // Camping in one spot for a while: carpet-bomb it.
      const camper = T >= 2 ? Array.from(env.players.values()).find((p) => p.alive && stillFor(p, now) > 14) : null;
      if (camper || (!exposed && Math.random() < 0.7)) {
        const who = camper || player;
        d.tactic = camper ? "flush" : "cover";
        d.volleyTarget = who;
        d.volleyLeft = 4 + d.pw.volleyExtra + (camper ? 2 : 0);
        d.nextVolleyAt = now + 700;
        setMode(d, "volley", now, 700 + d.volleyLeft * 420 * d.pw.cadence + 500);
        env.addZombieEvent("dragon_tactic", who.x, who.z, now, { tactic: d.tactic, target: who.id });
        return;
      }
      // Ambush dive from above.
      if (T >= 3 && Math.random() < 0.3) {
        const a = Math.random() * Math.PI * 2;
        d.runDir = { x: Math.cos(a), z: Math.sin(a) };
        d.tactic = "dive";
        setMode(d, "dive", now, 7000);
        env.addZombieEvent("dragon_tactic", d.x, d.z, now, { tactic: "dive" });
        return;
      }
    }

    const r = Math.random();
    if (r < 0.48) {
      // Strafing run. Smart Wyrms come in from the target's blind side
      // (behind where they're looking) and aim where they'll be, not are.
      const pred = player ? predictPos(player, 2.5, T) : target;
      let a = Math.random() * Math.PI * 2;
      if (player && T >= 2) {
        const behind = Math.atan2(Math.cos(player.yaw), Math.sin(player.yaw)); // opposite their view
        a = behind + rand(-0.5, 0.5);
        d.tactic = "flank";
        env.addZombieEvent("dragon_tactic", player.x, player.z, now, { tactic: "flank", target: player.id });
      }
      d.runFrom = { x: pred.x + Math.cos(a) * 95, z: pred.z + Math.sin(a) * 95 };
      d.runDir = { x: -Math.cos(a), z: -Math.sin(a) };
      d.feint = T >= 3 && Math.random() < 0.3;
      setMode(d, "approach", now, 4500);
    } else {
      d.volleyLeft = 3 + Math.floor(Math.random() * 3) + d.pw.volleyExtra + (hpFrac < 0.5 ? 2 : 0);
      d.nextVolleyAt = now + 900 * d.pw.cadence;
      setMode(d, "volley", now, 900 * d.pw.cadence + d.volleyLeft * 420 * d.pw.cadence + 500);
    }
  }

  function steer(d, goal, speed, dtSec, faceGoal = true) {
    const dx = goal.x - d.x;
    const dy = goal.y - d.y;
    const dz = goal.z - d.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    const want = Math.min(speed, dist * 1.2);
    const tvx = (dx / dist) * want;
    const tvy = (dy / dist) * want;
    const tvz = (dz / dist) * want;
    const k = Math.min(1, DRAGON_ACCEL * dtSec / Math.max(1, speed) * 2.2);
    d.vx += (tvx - d.vx) * k;
    d.vy += (tvy - d.vy) * k;
    d.vz += (tvz - d.vz) * k;
    if (faceGoal) {
      const hs = Math.hypot(d.vx, d.vz);
      if (hs > 2) {
        const yaw = Math.atan2(-d.vx, -d.vz);
        const diff = wrap(yaw - d.yaw);
        d.yaw += diff * Math.min(1, dtSec * 2.6);
        d.roll += (clamp(-diff * 1.4, -0.9, 0.9) - d.roll) * Math.min(1, dtSec * 3);
      }
      d.pitch += (clamp(Math.atan2(d.vy, Math.max(1, hs)), -0.6, 0.5) - d.pitch) * Math.min(1, dtSec * 2.5);
    }
  }

  function faceTowards(d, p, dtSec) {
    const yaw = Math.atan2(-(p.x - d.x), -(p.z - d.z));
    d.yaw += wrap(yaw - d.yaw) * Math.min(1, dtSec * 3.5);
    const hd = Math.hypot(p.x - d.x, p.z - d.z) || 1;
    d.pitch += (clamp(Math.atan2(p.y - d.y, hd), -0.7, 0.3) - d.pitch) * Math.min(1, dtSec * 3);
    d.roll *= Math.exp(-dtSec * 3);
  }

  function updateDragon(dtSec, now) {
    const d = E.dragon;
    if (!d) return;

    if (E.phase === "slain") {
      // Falling out of the sky, spinning, then a crater.
      if (!d.crashed) {
        d.vy -= 18 * dtSec;
        d.x += d.vx * dtSec;
        d.y += d.vy * dtSec;
        d.z += d.vz * dtSec;
        d.roll += dtSec * 2.4;
        d.pitch = Math.max(-1.1, d.pitch - dtSec * 0.6);
        const floor = env.groundHeight(d.x, d.z) + GROUND_H * 0.7;
        if (d.y <= floor) {
          d.y = floor;
          d.crashed = true;
          d.vx = d.vy = d.vz = 0;
          env.blast({ x: d.x, y: 1, z: d.z }, 26, 1400, now, null, true);
          env.addZombieEvent("dragon_crash", d.x, d.z, now, {});
        }
      }
      return;
    }

    const target = pickTarget(d);
    if (!target && d.grounded) {
      d.grounded = false;
      d.gAct = null;
      setMode(d, "takeoff", now, 1700);
    }
    if (!target) {
      // Nobody alive: circle the rift's old position.
      steer(d, { x: d.x + Math.cos(now * 0.0004) * 60, y: 50, z: d.z + Math.sin(now * 0.0004) * 60 }, 14, dtSec);
    } else {
      const tp = { x: target.x, y: target.y, z: target.z };
      switch (d.mode) {
        case "emerge": {
          // Unfurling above the burst point, then climb away.
          d.vy = 3;
          d.vx *= 0.9;
          d.vz *= 0.9;
          faceTowards(d, tp, dtSec);
          if (now >= d.modeUntil) setMode(d, "circle", now, rand(2500, 4500));
          break;
        }
        case "circle": {
          const R = 75;
          const sp = DRAGON_SPEED * d.pw.speed;
          d.orbitAngle += d.orbitDir * dtSec * (sp / R) * 0.8;
          const alt = 48 + Math.sin(now * 0.0011) * 8;
          steer(d, { x: tp.x + Math.cos(d.orbitAngle) * R, y: alt, z: tp.z + Math.sin(d.orbitAngle) * R }, sp, dtSec);
          if (now >= d.modeUntil) chooseNextMode(d, now, tp, target);
          break;
        }
        case "dive": {
          // Ambush: climb out of sight, then drop onto the target's predicted
          // position and roll straight into a breath run.
          const pred = predictPos(target, 2.2, d.pw.tactics);
          const climbing = now - d.modeAt < 2600;
          const goal = climbing ? { x: pred.x - d.runDir.x * 110, y: MAX_ALT - 4, z: pred.z - d.runDir.z * 110 } : { x: pred.x, y: 28, z: pred.z };
          steer(d, goal, DRAGON_SPEED * d.pw.speed * (climbing ? 1 : 1.6), dtSec);
          if (!climbing && (Math.hypot(pred.x - d.x, pred.z - d.z) < 55 || now >= d.modeUntil)) {
            setMode(d, "breath", now, 3000);
            d.nextBreathTickAt = now;
            env.addZombieEvent("dragon_breath", d.x, d.z, now, { y: d.y });
          }
          break;
        }
        case "approach": {
          steer(d, { x: d.runFrom.x, y: 32, z: d.runFrom.z }, DRAGON_SPEED * 1.2 * d.pw.speed, dtSec);
          // Feint: halfway in, a clever Wyrm pulls up and lobs fireballs instead.
          if (d.feint && now - d.modeAt > 1600) {
            d.feint = false;
            d.tactic = "feint";
            d.volleyLeft = 3 + d.pw.volleyExtra;
            d.nextVolleyAt = now + 300;
            setMode(d, "volley", now, 300 + d.volleyLeft * 380 + 500);
            env.addZombieEvent("dragon_tactic", d.x, d.z, now, { tactic: "feint" });
            break;
          }
          if (Math.hypot(d.runFrom.x - d.x, d.runFrom.z - d.z) < 14 || now >= d.modeUntil) {
            setMode(d, "breath", now, 3400);
            d.nextBreathTickAt = now;
            env.addZombieEvent("dragon_breath", d.x, d.z, now, { y: d.y });
          }
          break;
        }
        case "breath": {
          // Low, straight strafing run over the target, fire pouring down.
          const ahead = { x: d.x + d.runDir.x * 60, y: 26, z: d.z + d.runDir.z * 60 };
          steer(d, ahead, DRAGON_SPEED * 0.85 * d.pw.speed, dtSec);
          d.pitch = Math.min(d.pitch, -0.12);
          if (now >= d.nextBreathTickAt) {
            d.nextBreathTickAt = now + 200;
            breathTick(d, now);
          }
          if (now >= d.modeUntil) setMode(d, "circle", now, rand(2500, 4000));
          break;
        }
        case "volley": {
          // Hang back and lob fireballs.
          const away = Math.hypot(d.x - tp.x, d.z - tp.z) || 1;
          const hold = {
            x: tp.x + ((d.x - tp.x) / away) * 80,
            y: 52,
            z: tp.z + ((d.z - tp.z) / away) * 80,
          };
          steer(d, hold, 10, dtSec, false);
          faceTowards(d, tp, dtSec);
          if (d.volleyLeft > 0 && now >= d.nextVolleyAt) {
            d.volleyLeft -= 1;
            d.nextVolleyAt = now + 420 * d.pw.cadence;
            launchFireball(d, d.volleyTarget || target, now);
          }
          if (now >= d.modeUntil) {
            d.volleyTarget = null;
            setMode(d, "circle", now, rand(2000, 3500) * d.pw.cadence);
          }
          break;
        }
        case "roar": {
          steer(d, { x: d.x, y: Math.max(42, d.y), z: d.z }, 4, dtSec, false);
          faceTowards(d, tp, dtSec);
          if (!d.summoned && now - d.modeAt > 900) {
            d.summoned = true;
            const n = 5 + Math.min(8, env.players.size * 2);
            for (let i = 0; i < n; i += 1) env.summon(now);
          }
          if (now >= d.modeUntil) {
            d.summoned = false;
            setMode(d, "circle", now, rand(2500, 4000));
          }
          break;
        }
        case "devour": {
          // Hovers and opens a rift in its jaws: nearby zombies are dragged in
          // and every one swallowed heals it. Kill them first to deny it.
          steer(d, { x: d.x, y: Math.max(45, d.y), z: d.z }, 3, dtSec, false);
          const m = mouth(d);
          E.vortex = { x: m.x, y: m.y, z: m.z, r: 6, consumed: E.vortex?.consumed || 0, kind: "devour" };
          pullZombies(dtSec, now, m, DEVOUR_RADIUS, () => {
            E.vortex.consumed += 1;
            d.hp = Math.min(d.maxHp, d.hp + d.maxHp * DEVOUR_HEAL);
            env.addZombieEvent("dragon_heal", m.x, m.z, now, { y: m.y });
          });
          if (now >= d.modeUntil) {
            E.vortex = null;
            for (const zb of env.zombies.values()) if (zb.pulled) zb.pulled = false;
            setMode(d, "circle", now, rand(2500, 4000));
          }
          break;
        }
        case "dodge": {
          // Barrel roll sideways out of the line of fire.
          d.roll += d.dodgeDir * dtSec * 9;
          d.x += d.dodgeVX * dtSec;
          d.z += d.dodgeVZ * dtSec;
          d.y += Math.sin((now - d.modeAt) / 700 * Math.PI) * dtSec * 16;
          if (now >= d.modeUntil) {
            d.roll = wrap(d.roll);
            setMode(d, d.resumeMode || "circle", now, rand(1500, 3000));
          }
          break;
        }
        case "slam_rise": {
          // Climb high over the landing spot (marked on the ground for players).
          const L = d.land;
          if (d.pw.tactics >= 2) {
            // Clever Wyrms keep re-aiming at where the target is heading.
            const pr = predictPos(target, 1.5, d.pw.tactics);
            L.x += (pr.x - L.x) * Math.min(1, dtSec * 0.8);
            L.z += (pr.z - L.z) * Math.min(1, dtSec * 0.8);
          }
          steer(d, { x: L.x, y: 82, z: L.z }, DRAGON_SPEED * 1.35 * d.pw.speed, dtSec);
          if ((Math.hypot(L.x - d.x, L.z - d.z) < 14 && d.y > 64) || now >= d.modeUntil) {
            setMode(d, "slam_fall", now, 5000);
            d.vx *= 0.25;
            d.vz *= 0.25;
            d.vy = -12;
            env.addZombieEvent("dragon_slam_fall", L.x, L.z, now, {});
          }
          break;
        }
        case "slam_fall": {
          // Plummet: wings tucked, accelerating straight down onto the mark.
          const L = d.land;
          d.vy = Math.max(-110, d.vy - 150 * dtSec);
          d.vx += ((L.x - d.x) * 2.5 - d.vx) * Math.min(1, dtSec * 4);
          d.vz += ((L.z - d.z) * 2.5 - d.vz) * Math.min(1, dtSec * 4);
          faceTowards(d, tp, dtSec);
          d.pitch = -0.45;
          break;
        }
        case "grounded": {
          groundedTick(d, target, now, dtSec);
          break;
        }
        case "takeoff": {
          // Huge wing beats hurl dust and players away, then it climbs.
          d.vy = Math.min(26, d.vy + 40 * dtSec);
          d.vx *= 0.95;
          d.vz *= 0.95;
          d.pitch += (0.35 - d.pitch) * Math.min(1, dtSec * 3);
          if (now >= d.modeUntil) {
            d.grounded = false;
            setMode(d, "circle", now, rand(2500, 4000));
          }
          break;
        }
        default:
          setMode(d, "circle", now, 3000);
      }
    }

    if (d.mode !== "dodge") {
      d.x += d.vx * dtSec;
      d.y += d.vy * dtSec;
      d.z += d.vz * dtSec;
    }
    const lim = env.worldHalf - 20;
    d.x = clamp(d.x, -lim, lim);
    d.z = clamp(d.z, -lim, lim);
    const groundY = env.groundHeight(d.x, d.z) + GROUND_H;
    if (d.mode === "slam_fall" && d.y <= groundY) {
      d.y = groundY;
      slamImpact(d, now);
    } else if (d.grounded) {
      d.y = Math.max(groundY, Math.min(d.y, MAX_ALT));
    } else {
      // Normal flight keeps a safe altitude; plunging / taking off may go lower.
      const floor = d.mode === "slam_fall" || d.mode === "takeoff" ? groundY : Math.max(MIN_ALT, groundY);
      d.y = clamp(d.y, floor, MAX_ALT);
    }

    smashThroughBuildings(d, now);
  }

  // ---------------------------------------------------------------------------
  // Ground phase
  // ---------------------------------------------------------------------------

  /** Damage + shove everyone in a radius (optionally only a frontal arc). */
  function areaHit(center, radius, dmg, knock, now, cause, arc = null) {
    for (const p of env.players.values()) {
      if (!p.alive) continue;
      const dx = p.x - center.x;
      const dz = p.z - center.z;
      const dist = Math.hypot(dx, dz);
      if (dist > radius || p.y > center.y + 14) continue;
      if (arc) {
        const dot = (dx * arc.x + dz * arc.z) / (dist || 1);
        if (dot < arc.cos) continue;
      }
      const fall = 1 - (dist / radius) * 0.5;
      env.hurtPlayer(p, dmg * fall, cause, now);
      if (knock && !p.inVehicle) env.knockback(p, (dx / (dist || 1)) * knock, knock * 0.45, (dz / (dist || 1)) * knock);
    }
    for (const zb of env.zombies.values()) {
      if (zb.alive && !zb.pulled && Math.hypot(zb.x - center.x, zb.z - center.z) < radius) env.hurtZombie(zb, dmg * 2, now);
    }
    for (const pet of E.pets.values()) {
      if (Math.hypot(pet.x - center.x, pet.z - center.z) < radius && pet.y < center.y + 10) hurtPet(pet, dmg * 0.4, now);
    }
  }

  function slamImpact(d, now) {
    d.grounded = true;
    d.vx = d.vy = d.vz = 0;
    d.pitch = 0;
    d.roll = 0;
    d.gAct = null;
    d.nextGActAt = now + 1100;
    // Longer stays on the ground for tougher Wyrms (they're confident).
    setMode(d, "grounded", now, GROUND_MS + (d.level - 1) * 900);
    const c = { x: d.x, y: d.y - GROUND_H, z: d.z };
    areaHit(c, SLAM_RADIUS, SLAM_DAMAGE * d.pw.dmg, 22, now, "Undead Wyrm (crushed)");
    env.blast({ x: d.x, y: 2, z: d.z }, 7 * S, 1600, now, null, true); // whatever it landed on is gone
    env.addZombieEvent("dragon_slam", d.x, d.z, now, { y: c.y });
  }

  function startGroundAct(d, kind, now, dur) {
    d.gAct = { kind, at: now, until: now + dur, hit: false, nextTick: now };
    env.addZombieEvent("dragon_gact", d.x, d.z, now, { act: kind });
  }

  function groundedTick(d, target, now, dtSec) {
    d.vx = d.vy = d.vz = 0;
    d.pitch *= Math.exp(-dtSec * 4);
    d.roll *= Math.exp(-dtSec * 4);
    const f = forward(d);
    const a = d.gAct;
    if (!a) {
      // Turn to track the target between moves (slowly — get behind it!).
      const yaw = Math.atan2(-(target.x - d.x), -(target.z - d.z));
      d.yaw += clamp(wrap(yaw - d.yaw), -1.6 * dtSec, 1.6 * dtSec);
      if (now >= d.modeUntil) {
        setMode(d, "takeoff", now, 1700);
        d.vy = 6;
        const c = { x: d.x, y: d.y - GROUND_H, z: d.z };
        areaHit(c, 30, 8 * d.pw.dmg, 18, now, "Undead Wyrm (wing gust)");
        env.addZombieEvent("dragon_takeoff", d.x, d.z, now, {});
        return;
      }
      if (now < d.nextGActAt) return;
      // Choose a move from where the players are relative to its body.
      const dx = target.x - d.x;
      const dz = target.z - d.z;
      const dist = Math.hypot(dx, dz);
      const facing = (dx * f.x + dz * f.z) / (dist || 1);
      const flanked = alivePlayers().some((p) => {
        const px = p.x - d.x;
        const pz = p.z - d.z;
        const pd = Math.hypot(px, pz);
        return pd < 30 && (px * f.x + pz * f.z) / (pd || 1) < -0.2;
      });
      if (flanked && Math.random() < 0.75) startGroundAct(d, "tail", now, 1500);
      else if (dist < 26 && facing > 0.5) startGroundAct(d, Math.random() < 0.55 ? "bite" : "stomp", now, 1250);
      else if (dist < 80) startGroundAct(d, "gbreath", now, 2800);
      else {
        // Everyone ran: take off and hunt them from the air.
        d.modeUntil = now;
      }
      return;
    }
    const t = now - a.at;
    const front = { x: d.x + f.x * 9 * S, y: d.y - GROUND_H, z: d.z + f.z * 9 * S };
    switch (a.kind) {
      case "tail": {
        // Wind up, then a full spin: the tail clears everything around it.
        if (t > 550 && t < 1150) d.yaw += dtSec * 10.5;
        if (!a.hit && t > 700) {
          a.hit = true;
          areaHit({ x: d.x, y: d.y - GROUND_H, z: d.z }, 13 * S, 38 * d.pw.dmg, 20, now, "Undead Wyrm (tail sweep)");
          env.blast({ x: d.x, y: 2, z: d.z }, 9 * S, 500, now, null);
        }
        break;
      }
      case "bite": {
        // Rear back, then lunge forward with the jaws.
        if (t > 450 && t < 750) {
          d.x += f.x * 48 * dtSec;
          d.z += f.z * 48 * dtSec;
        }
        if (!a.hit && t > 650) {
          a.hit = true;
          areaHit(front, 7 * S, 52 * d.pw.dmg, 16, now, "Undead Wyrm (bite)", { x: f.x, z: f.z, cos: 0.25 });
        }
        break;
      }
      case "stomp": {
        // Rear up on the hind legs, then slam the front down.
        d.pitch = t < 600 ? Math.min(0.55, t / 600 * 0.55) : Math.max(0, 0.55 - (t - 600) / 120 * 0.55);
        if (!a.hit && t > 720) {
          a.hit = true;
          areaHit(front, 6 * S, 44 * d.pw.dmg, 14, now, "Undead Wyrm (stomp)");
          env.blast({ x: front.x, y: 2, z: front.z }, 4 * S, 900, now, null);
          env.addZombieEvent("dragon_stomp", front.x, front.z, now, {});
        }
        break;
      }
      case "gbreath": {
        // Head low, a sweeping river of fire across the ground.
        if (t > 500 && now >= a.nextTick) {
          a.nextTick = now + 180;
          const sweep = -0.85 + 1.7 * clamp((t - 500) / 2100, 0, 1);
          d.breathYaw = sweep;
          breathTick(d, now, sweep, 0.22);
        }
        break;
      }
      default:
    }
    if (now >= a.until) {
      d.gAct = null;
      d.breathYaw = 0;
      d.nextGActAt = now + 450 * d.pw.cadence;
    }
    smashThroughBuildings(d, now);
  }

  /** Anything big in the dragon's path gets blown apart. */
  function smashThroughBuildings(d, now) {
    if (now < d.smashAt) return;
    for (const p of env.propsNear(d.x, d.z)) {
      if (p.collidable === false || !p.breakable) continue;
      const top = (p.py || 0) + p.sy;
      if (d.y - 3 * S > top || d.y + 3 * S < (p.py || 0)) continue;
      if (Math.abs(d.x - p.x) > p.sx / 2 + 4 * S || Math.abs(d.z - p.z) > p.sz / 2 + 4 * S) continue;
      d.smashAt = now + 350;
      env.blast({ x: d.x, y: d.y, z: d.z }, 5 * S, 900, now, null);
      return;
    }
  }

  function breathTick(d, now, yawOffset = 0, down = 0.55) {
    const m = mouth(d);
    const f = forward(d);
    if (yawOffset) {
      const c = Math.cos(yawOffset);
      const sn = Math.sin(yawOffset);
      const fx = f.x * c + f.z * sn;
      const fz = -f.x * sn + f.z * c;
      f.x = fx;
      f.z = fz;
    }
    // Breath aims forward and down.
    const dir = { x: f.x, y: Math.min(f.y, 0) - down, z: f.z };
    const len = Math.hypot(dir.x, dir.y, dir.z);
    dir.x /= len;
    dir.y /= len;
    dir.z /= len;
    for (const p of env.players.values()) {
      if (!p.alive) continue;
      const vx = p.x - m.x;
      const vy = p.y - 0.8 - m.y;
      const vz = p.z - m.z;
      const dist = Math.hypot(vx, vy, vz);
      if (dist > BREATH_RANGE) continue;
      const cos = (vx * dir.x + vy * dir.y + vz * dir.z) / (dist || 1);
      if (cos < Math.cos(BREATH_HALF_ANGLE)) continue;
      env.hurtPlayer(p, 11 * d.pw.dmg, "Undead Wyrm (fire breath)", now);
    }
    for (const zb of env.zombies.values()) {
      if (!zb.alive || zb.pulled) continue;
      const dist = Math.hypot(zb.x - m.x, zb.y - m.y, zb.z - m.z);
      if (dist < BREATH_RANGE * 0.8) env.hurtZombie(zb, 18, now); // it doesn't care who burns
    }
    for (const pet of E.pets.values()) {
      if (Math.hypot(pet.x - m.x, pet.y - m.y, pet.z - m.z) < BREATH_RANGE * 0.7) hurtPet(pet, 4 * d.pw.dmg, now);
    }
    // Where the cone meets the ground: scorch it and burn what's standing there.
    if (dir.y < -0.05) {
      const t = Math.min(BREATH_RANGE, (m.y - 0.2) / -dir.y);
      const gx = m.x + dir.x * t;
      const gz = m.z + dir.z * t;
      if (now >= d.nextBlastAt) {
        d.nextBlastAt = now + 400;
        env.blast({ x: gx, y: 1.5, z: gz }, 3.5, 140, now, null);
      }
      addFireZone(gx, gz, 4.2, now);
    }
  }

  function launchFireball(d, target, now) {
    const m = mouth(d);
    // Aim where the target WILL be when the fireball lands (flight time from
    // distance), read from their recent movement. Level 1 leads simply.
    const flight = Math.hypot(target.x - m.x, target.y - m.y, target.z - m.z) / FIREBALL_SPEED;
    const pred = predictPos(target, flight * (d.pw.tactics >= 2 ? 1 : 0.6), d.pw.tactics);
    const scatter = d.tactic === "flush" ? 6 : Math.max(1.2, 3 - d.level * 0.4);
    const tx = pred.x + rand(-scatter, scatter);
    const tz = pred.z + rand(-scatter, scatter);
    const ty = (target.y || 1.7) - 1.2;
    const dx = tx - m.x;
    const dz = tz - m.z;
    const dy = ty - m.y;
    const hd = Math.hypot(dx, dz) || 1;
    const time = Math.hypot(hd, dy) / FIREBALL_SPEED;
    E.fireSeq += 1;
    E.fireballs.push({
      id: E.fireSeq,
      x: m.x,
      y: m.y,
      z: m.z,
      vx: dx / time,
      vy: dy / time + 0.5 * FIREBALL_GRAVITY * time,
      vz: dz / time,
      bornAt: now,
      dmg: d.pw.dmg,
    });
  }

  function updateFireballs(dtSec, now) {
    for (let i = E.fireballs.length - 1; i >= 0; i -= 1) {
      const f = E.fireballs[i];
      const from = { x: f.x, y: f.y, z: f.z };
      f.vy -= FIREBALL_GRAVITY * dtSec;
      f.x += f.vx * dtSec;
      f.y += f.vy * dtSec;
      f.z += f.vz * dtSec;
      let hit = f.y <= 0.3 || now - f.bornAt > 6000;
      if (!hit) {
        for (const p of env.players.values()) {
          if (p.alive && Math.hypot(p.x - f.x, p.y - 0.9 - f.y, p.z - f.z) < 2.2) {
            hit = true;
            break;
          }
        }
      }
      if (!hit) {
        const seg = Math.hypot(f.x - from.x, f.y - from.y, f.z - from.z) || 1e-6;
        const dir = { x: (f.x - from.x) / seg, y: (f.y - from.y) / seg, z: (f.z - from.z) / seg };
        for (const p of env.propsAlongSegment(from.x, from.z, f.x, f.z)) {
          if (p.collidable === false) continue;
          const dd = env.rayAabbDistance(from, dir, p);
          if (dd != null && dd >= 0 && dd <= seg) {
            f.x = from.x + dir.x * dd;
            f.y = from.y + dir.y * dd;
            f.z = from.z + dir.z * dd;
            hit = true;
            break;
          }
        }
      }
      if (!hit) continue;
      E.fireballs.splice(i, 1);
      const pt = { x: f.x, y: Math.max(0.5, f.y), z: f.z };
      for (const p of env.players.values()) {
        if (!p.alive) continue;
        const dd = Math.hypot(p.x - pt.x, p.y - 0.9 - pt.y, p.z - pt.z);
        if (dd < FIREBALL_RADIUS) env.hurtPlayer(p, 48 * (f.dmg || 1) * (1 - dd / FIREBALL_RADIUS), "Undead Wyrm (fireball)", now);
      }
      for (const pet of E.pets.values()) {
        const dd = Math.hypot(pet.x - pt.x, pet.y - pt.y, pet.z - pt.z);
        if (dd < FIREBALL_RADIUS) hurtPet(pet, 30 * (f.dmg || 1) * (1 - dd / FIREBALL_RADIUS), now);
      }
      env.blast(pt, FIREBALL_RADIUS * 0.85, 950, now, null, true);
      addFireZone(pt.x, pt.z, 5, now);
      env.addZombieEvent("dragon_fireball_hit", pt.x, pt.z, now, { y: pt.y });
    }
  }

  function addFireZone(x, z, r, now) {
    // Merge with a nearby zone instead of stacking hundreds.
    for (const fz of E.fireZones) {
      if (Math.hypot(fz.x - x, fz.z - z) < r * 0.8) {
        fz.until = now + FIRE_ZONE_MS;
        return;
      }
    }
    E.fireZones.push({ x, z, r, until: now + FIRE_ZONE_MS, nextTickAt: now, dmg: E.dragon?.pw.dmg || 1 });
    if (E.fireZones.length > 40) E.fireZones.shift();
  }

  function updateFireZones(dtSec, now) {
    for (let i = E.fireZones.length - 1; i >= 0; i -= 1) {
      const fz = E.fireZones[i];
      if (now > fz.until) {
        E.fireZones.splice(i, 1);
        continue;
      }
      if (now < fz.nextTickAt) continue;
      fz.nextTickAt = now + 500;
      for (const p of env.players.values()) {
        if (p.alive && p.y < 3.5 && Math.hypot(p.x - fz.x, p.z - fz.z) < fz.r) {
          env.hurtPlayer(p, FIRE_ZONE_DPS * 0.5 * fz.dmg, "Dragonfire", now);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Being shot
  // ---------------------------------------------------------------------------

  /** Hit spheres in world space: head (weak spot), neck, body, tail, wings. */
  function hitSpheres(d) {
    const f = forward(d);
    const side = { x: Math.cos(d.yaw), z: -Math.sin(d.yaw) };
    const at = (k, up = 0) => ({ x: d.x + f.x * k * S, y: d.y + (f.y * k + up) * S, z: d.z + f.z * k * S });
    // On the ground the wings are folded against the body.
    const wingOut = d.grounded ? 3.5 : 8;
    const head = at(11.2, 1.3);
    head.x += d.headX || 0;
    head.y += d.headY || 0;
    head.z += d.headZ || 0;
    return [
      { ...head, r: 1.9 * S, part: "head", mult: 2 },
      { ...at(7.4, 1.1), r: 1.6 * S, part: "neck", mult: 1.2 },
      { ...at(0), r: 3.6 * S, part: "body", mult: 1 },
      { ...at(-3.8), r: 2.8 * S, part: "body", mult: 1 },
      { ...at(-9.5, 0.2), r: 1.9 * S, part: "tail", mult: 0.8 },
      { x: d.x + side.x * wingOut * S, y: d.y + 0.8 * S, z: d.z + side.z * wingOut * S, r: 3.4 * S, part: "wing", mult: 0.5 },
      { x: d.x - side.x * wingOut * S, y: d.y + 0.8 * S, z: d.z - side.z * wingOut * S, r: 3.4 * S, part: "wing", mult: 0.5 },
    ];
  }

  /** Segment test for bullets. Returns { t (0..1), part, mult } or null. */
  function bulletHit(from, to, radius = 0.1) {
    const d = E.dragon;
    if (!d || E.phase !== "dragon") return null;
    const sx = to.x - from.x;
    const sy = to.y - from.y;
    const sz = to.z - from.z;
    const len2 = sx * sx + sy * sy + sz * sz || 1e-9;
    // Cheap reject: segment far from the dragon.
    const mx = (from.x + to.x) / 2 - d.x;
    const mz = (from.z + to.z) / 2 - d.z;
    if (mx * mx + mz * mz > (Math.sqrt(len2) / 2 + 22 * S) ** 2) return null;
    let best = null;
    for (const s of hitSpheres(d)) {
      let t = ((s.x - from.x) * sx + (s.y - from.y) * sy + (s.z - from.z) * sz) / len2;
      t = clamp(t, 0, 1);
      const px = from.x + sx * t - s.x;
      const py = from.y + sy * t - s.y;
      const pz = from.z + sz * t - s.z;
      if (px * px + py * py + pz * pz <= (s.r + radius) ** 2 && (!best || t < best.t)) {
        best = { t, part: s.part, mult: s.mult };
      }
    }
    return best;
  }

  function damage(amount, attacker, part, now) {
    const d = E.dragon;
    if (!d || E.phase !== "dragon" || d.mode === "emerge") return 0;
    // Mid-roll it's hard to land solid hits; on the ground it's exposed.
    if (d.mode === "dodge") amount *= 0.5;
    if (d.grounded && d.mode !== "takeoff") amount *= 1.3;
    d.hp -= amount;
    if (attacker) {
      const c = d.contributors.get(attacker.id) || { dmg: 0, recent: 0, name: attacker.name };
      c.dmg += amount;
      c.recent = now;
      d.contributors.set(attacker.id, c);
    }
    d.recentDamage.push([now, amount]);
    while (d.recentDamage.length && now - d.recentDamage[0][0] > 1200) d.recentDamage.shift();
    const burst = d.recentDamage.reduce((s, x) => s + x[1], 0);
    if (
      d.hp > 0 &&
      d.mode !== "dodge" &&
      d.mode !== "devour" &&
      !d.grounded &&
      d.mode !== "slam_rise" &&
      d.mode !== "slam_fall" &&
      burst > d.maxHp * 0.028 &&
      now - d.lastDodgeAt > d.pw.dodgeCd
    ) {
      // Barrel roll out of the line of fire.
      d.lastDodgeAt = now;
      d.resumeMode = d.mode === "breath" || d.mode === "volley" ? "circle" : d.mode;
      d.dodgeDir = Math.random() < 0.5 ? 1 : -1;
      const side = { x: Math.cos(d.yaw) * d.dodgeDir, z: -Math.sin(d.yaw) * d.dodgeDir };
      d.dodgeVX = side.x * 42 + d.vx * 0.5;
      d.dodgeVZ = side.z * 42 + d.vz * 0.5;
      setMode(d, "dodge", now, 750);
    }
    if (d.hp <= 0) {
      d.hp = 0;
      E.phase = "slain";
      E.phaseAt = now;
      E.vortex = null;
      for (const zb of env.zombies.values()) zb.pulled = false;
      d.vx *= 0.4;
      d.vz *= 0.4;
      d.vy = 2;
      const total = [...d.contributors.values()].reduce((s, c) => s + c.dmg, 0) || 1;
      for (const [id, c] of d.contributors) {
        const p = env.players.get(id);
        if (p) {
          p.score += Math.round(400 + 2600 * (c.dmg / total));
          p.kills += 1;
        }
      }
      const top = [...d.contributors.values()].sort((a, b) => b.dmg - a.dmg)[0];
      env.addKillFeed(top ? top.name : "The survivors", "UNDEAD WYRM", now);
      env.addZombieEvent("dragon_slain", d.x, d.z, now, { y: d.y });
      grantPets(now); // a mini-dragon hatchling for everyone (or a level-up)
    }
    return amount;
  }

  /** Pseudo-enemy so AI companions engage the dragon too. */
  function hostile() {
    const d = E.dragon;
    if (!d || E.phase !== "dragon") return null;
    return { id: "dragon", isDragon: true, x: d.x, y: d.y + 0.5, z: d.z, alive: true };
  }

  // ---------------------------------------------------------------------------
  // Snapshot
  // ---------------------------------------------------------------------------

  function serialize(now) {
    const pets = E.pets.size
      ? Array.from(E.pets.values(), (p) => [
          p.ownerId,
          r2(p.x),
          r2(p.y),
          r2(p.z),
          r2(p.yaw),
          Math.round(p.hp),
          p.maxHp,
          p.deadUntil ? 3 : p.phase === "breath" ? 1 : p.phase === "cool" ? 2 : 0,
          p.level,
        ])
      : undefined;
    if (E.phase === "none") return pets ? { ph: "none", pets } : null;
    const out = { ph: E.phase, t: now - E.phaseAt, enc: E.encounters, pets };
    if (E.vortex) {
      const v = E.vortex;
      out.vortex = { x: r2(v.x), y: r2(v.y), z: r2(v.z), r: r2(v.r), n: v.consumed, kind: v.kind };
    }
    const d = E.dragon;
    if (d) {
      out.dragon = {
        x: r2(d.x),
        y: r2(d.y),
        z: r2(d.z),
        yaw: r2(d.yaw),
        pitch: r2(d.pitch),
        roll: r2(d.roll),
        hp: Math.round(d.hp),
        max: d.maxHp,
        mode: d.mode,
        mt: now - d.modeAt,
        vy: r2(d.vy),
        lvl: d.level,
        tac: d.tactic || undefined,
        sc: S,
        gr: d.grounded ? 1 : undefined,
        ga: d.gAct ? d.gAct.kind : undefined,
        gt: d.gAct ? now - d.gAct.at : undefined,
        by: d.breathYaw ? r2(d.breathYaw) : undefined,
        land: d.mode === "slam_rise" || d.mode === "slam_fall" ? [r2(d.land.x), r2(d.land.z)] : undefined,
      };
    }
    if (E.fireballs.length) out.fb = E.fireballs.map((f) => [f.id, r2(f.x), r2(f.y), r2(f.z)]);
    if (E.fireZones.length) out.fz = E.fireZones.map((f) => [r2(f.x), r2(f.z), f.r, Math.max(0, f.until - now)]);
    return out;
  }

  return {
    start,
    update,
    active,
    reset,
    bulletHit,
    damage,
    hostile,
    serialize,
    isPulled: (zb) => !!zb.pulled,
    removePet: (ownerId) => E.pets.delete(ownerId),
    hurtPetsNear: (x, z, r, dmg, now) => {
      for (const pet of E.pets.values()) if (Math.hypot(pet.x - x, pet.z - z) < r) hurtPet(pet, dmg, now);
    },
  };
}

module.exports = { createDragonEvent };
