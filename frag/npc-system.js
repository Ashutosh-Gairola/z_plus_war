/**
 * AI Companion (recruitable NPC) system — shared by frag (PvP) and z_plus (co-op).
 *
 * This module is a pure, mode-agnostic subsystem in the same style as
 * `vehicle-system.js`: the host (frag/server.js or z_plus/server.js) OWNS the
 * `npcs` array and injects an `env` bundle of world helpers + mode-specific
 * hooks. The module never requires the server directly, so the exact same NPC
 * behavior runs in both game modes — only what counts as an "ally" vs an
 * "enemy" differs, and the host decides that through `env.getAllies` /
 * `env.getHostiles`.
 *
 * Recruiting: ONE recruit beacon sits at a random spot on the map. A player
 * holds Recruit for 10s inside it and gets one random companion from the roles
 * they don't have yet (each role at most once per party). The beacon then
 * vanishes and reappears somewhere else 3 minutes later. A player with the
 * full party no longer sees / can use it. A companion that dies leaves the
 * party, so that role can be recruited again.
 *
 * Lifecycle of one companion (state machine, driven by updateNpcFleet):
 *
 *   (recruited) ─▶ arriving ──(drop pod lands)──▶ active ──(0 HP)──▶ dead ─▶ removed
 *
 * While `active` an NPC follows its owner in formation, auto-engages the
 * nearest hostile, and uses its role ability. Recruitment progress is driven by
 * the host setting `npc.recruiterId` (from a `recruit_start` socket event) and
 * clearing it (`recruit_cancel` / leaving range); this module accumulates the
 * hold timer and performs the actual recruitment.
 *
 * Phase A implements the Healer and Attacker roles. Defender and Alchemist
 * (with minions) are added in Phase B by extending NPC_ROLES + the role
 * dispatch in updateActiveNpc; the framework (recruit/follow/respawn/render) is
 * already role-agnostic.
 */

// --- Tunable constants ------------------------------------------------------

/** How close a player must be to an NPC's home to recruit it. */
const RECRUIT_RADIUS = 6.5;
/** Hold duration to complete a recruitment. */
const RECRUIT_HOLD_MS = 10000;
/** Drop-pod arrival animation length (NPC is invulnerable and idle during it). */
const ARRIVE_MS = 2200;
/** After someone recruits, the beacon reappears elsewhere after this long. */
const BEACON_RELOCATE_MS = 3 * 60 * 1000;
/** A hold must be re-asserted at least this often (client pings every 500ms). */
const RECRUIT_ASSERT_MS = 900;
/** Dead companions linger this long (death pose) before leaving the party. */
const CORPSE_MS = 4000;
let companionSeq = 0;

const NPC_EYE_HEIGHT = 1.7; // NPCs use the same eye height as players
const NPC_RADIUS = 0.6;

// Defender ability — a protective dome enemies cannot enter or shoot into.
const SHIELD_DURATION_MS = 20000; // 20s of safety
const SHIELD_COOLDOWN_MS = 3 * 60 * 1000; // 3-min regen
// Summoner ability — a pack of minions; a fresh pack only after the last dies.
const MINION_COUNT = 3;
const RESUMMON_DELAY_MS = 4000; // brief "cast" before (re)summoning
let minionSeq = 0; // unique-id counter for dynamically summoned minions

/** Formation follow tuning. */
const FOLLOW_STOP_DIST = 0.7; // close enough — stop and hold
const FOLLOW_CATCHUP_DIST = 11; // beyond this, sprint to catch up
const SEPARATION_RADIUS = 2.4; // keep companions from stacking

// --- Role definitions -------------------------------------------------------
// color is the body tint used client-side. Combat numbers are balanced around
// player health of 100 and the 30 Hz server tick.

const NPC_ROLES = {
  healer: {
    label: "Healer",
    color: 0x37d98a, // green
    maxHealth: 130,
    moveSpeed: 6.2, // average
    detectRadius: 24,
    attackRange: 20,
    damage: 6, // low damage attack
    fireIntervalMs: 650,
    weaponKey: "rifle",
    // Ability: aura heal of allied players.
    healRadius: 9,
    healAmount: 42,
    healCooldownPerPlayerMs: 60000,
  },
  attacker: {
    label: "Attacker",
    color: 0xe8563a, // red
    maxHealth: 170,
    moveSpeed: 3.6, // deliberately the slowest companion (heavy weapon)
    detectRadius: 36,
    attackRange: 30,
    damage: 14, // high per-shot damage
    fireIntervalMs: 110,
    weaponKey: "smg",
    // Ability: machine gun overheats after sustained fire, then long cooldown.
    overheatAfterMs: 4000,
    overheatMs: 60000,
    // Accuracy decreases while continuously firing (hit chance falls off).
    minHitChance: 0.45,
  },
  defender: {
    label: "Defender",
    color: 0x4aa0ff, // blue
    maxHealth: 320, // tanky — high defence
    moveSpeed: 4.4,
    detectRadius: 24,
    attackRange: 18,
    damage: 3, // deliberately weak offence
    fireIntervalMs: 700,
    weaponKey: "rifle",
    // Ability: deploy a 20s dome (radius 8) no hostile can enter or shoot into.
    shieldRadius: 8,
    shieldDurationMs: SHIELD_DURATION_MS,
    shieldCooldownMs: SHIELD_COOLDOWN_MS,
  },
  summoner: {
    label: "Summoner",
    color: 0xb066ff, // purple
    maxHealth: 150,
    moveSpeed: 5.4,
    detectRadius: 26,
    attackRange: 22,
    damage: 3, // weak on its own; the minions do the work
    fireIntervalMs: 800,
    weaponKey: "rifle",
    // Ability: keeps a pack of MINION_COUNT minions alive; a fresh pack only
    // spawns once every current minion is dead.
    minionCount: MINION_COUNT,
    resummonDelayMs: RESUMMON_DELAY_MS,
  },
  minion: {
    label: "Minion",
    color: 0xff8a3c, // orange
    maxHealth: 45, // fragile
    moveSpeed: 7.4, // fast
    detectRadius: 34,
    attackRange: 15,
    damage: 24, // huge damage
    fireIntervalMs: 280,
    weaponKey: "smg",
    // Not recruitable and has no home — only ever created by a Summoner.
    recruitable: false,
  },
};


// --- Small helpers ----------------------------------------------------------

function dist2d(ax, az, bx, bz) {
  return Math.hypot(ax - bx, az - bz);
}

/** Yaw such that the Three.js -Z forward vector points along (dx, dz). */
function yawFromDir(dx, dz) {
  return Math.atan2(-dx, -dz);
}

/** Ground eye-height Y at (x, z) — NPCs stand on the highest low surface. */
function groundEye(env, x, z) {
  return env.supportHeightAt(x, z, 0.6, env.worldProps) + NPC_EYE_HEIGHT;
}

/** Nudge a home point off any blocking prop with a short outward spiral. */
function clearHome(env, x, z) {
  const blocked = (px, pz) => {
    for (const ob of env.propsNear(env.worldProps, px, pz)) {
      if (!env.obstacleBlocksPlayer(ob, 0)) continue;
      if (env.pointInsideObstacle(px, pz, NPC_RADIUS + 0.5, ob)) return true;
    }
    return false;
  };
  if (!blocked(x, z)) return { x, z };
  for (let r = 3; r <= 30; r += 3) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
      const nx = env.clamp(x + Math.cos(a) * r, -env.worldHalfSize + 4, env.worldHalfSize - 4);
      const nz = env.clamp(z + Math.sin(a) * r, -env.worldHalfSize + 4, env.worldHalfSize - 4);
      if (!blocked(nx, nz)) return { x: nx, z: nz };
    }
  }
  return { x, z };
}

// --- Construction -----------------------------------------------------------

/**
 * Build the recruitable NPC roster. Returns an array of NPC objects (the host
 * owns and mutates it). One NPC per role defined in NPC_ROLES, each parked at
 * its fixed home in the `available` state.
 */
function buildNpcSpawns() {
  // Companions are no longer parked at fixed homes — they come from the
  // roaming recruit beacon (createRecruitBeacon). Kept for API compatibility.
  return [];
}

/**
 * Build a fresh minion NPC around its summoner. Minions are dynamic: pushed
 * into env.npcs by the fleet update and reaped when they die (they are never
 * parked or recruited).
 */
function makeMinion(env, summoner, index, now) {
  const cfg = NPC_ROLES.minion;
  const ang = (index / MINION_COUNT) * Math.PI * 2;
  const mx = env.clamp(summoner.x + Math.cos(ang) * 2.4, -env.worldHalfSize + 4, env.worldHalfSize - 4);
  const mz = env.clamp(summoner.z + Math.sin(ang) * 2.4, -env.worldHalfSize + 4, env.worldHalfSize - 4);
  minionSeq += 1;
  return {
    id: `${summoner.id}-m${minionSeq}`,
    role: "minion",
    homeX: mx,
    homeZ: mz,
    x: mx,
    y: groundEye(env, mx, mz),
    z: mz,
    vx: 0,
    vz: 0,
    yaw: summoner.yaw,
    state: "active",
    ownerId: summoner.ownerId,
    health: cfg.maxHealth,
    maxHealth: cfg.maxHealth,
    recruiterId: null,
    recruitProgressMs: 0,
    arriveUntil: 0,
    respawnAt: 0,
    targetId: null,
    lastShotAt: 0,
    lastAttackAt: 0,
    burstMs: 0,
    overheatUntil: 0,
    healCooldowns: {},
    shieldUntil: 0,
    shieldCooldownUntil: 0,
    shieldX: 0,
    shieldZ: 0,
    minionIds: [],
    nextSummonAt: 0,
    summonerId: summoner.id,
  };
}

// --- Movement ---------------------------------------------------------------

/**
 * Steer the NPC toward (tx, tz) at `speed`, applying separation from other
 * companions, obstacle avoidance, world clamping, and ground snapping. Returns
 * the remaining distance to the goal (pre-move).
 */
function stepTowards(env, npc, tx, tz, speed, dtSec) {
  const dx = tx - npc.x;
  const dz = tz - npc.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-3) {
    npc.vx = 0;
    npc.vz = 0;
    return dist;
  }
  let mvx = dx / dist;
  let mvz = dz / dist;

  // Separation: push away from nearby active companions so they don't stack.
  for (const other of env.npcs) {
    if (other === npc || other.state !== "active") continue;
    const ox = npc.x - other.x;
    const oz = npc.z - other.z;
    const od = Math.hypot(ox, oz);
    if (od > 1e-3 && od < SEPARATION_RADIUS) {
      const w = (SEPARATION_RADIUS - od) / SEPARATION_RADIUS;
      mvx += (ox / od) * w * 0.9;
      mvz += (oz / od) * w * 0.9;
    }
  }
  const ml = Math.hypot(mvx, mvz) || 1;
  mvx /= ml;
  mvz /= ml;

  const half = env.worldHalfSize - NPC_RADIUS;
  let nx = env.clamp(npc.x + mvx * speed * dtSec, -half, half);
  let nz = env.clamp(npc.z + mvz * speed * dtSec, -half, half);

  const feetY = npc.y - NPC_EYE_HEIGHT;
  for (let i = 0; i < 2; i += 1) {
    for (const ob of env.propsNear(env.worldProps, nx, nz)) {
      if (!env.obstacleBlocksPlayer(ob, feetY)) continue;
      if (!env.pointInsideObstacle(nx, nz, NPC_RADIUS, ob)) continue;
      const r = env.resolveObstacleCollision(nx, nz, NPC_RADIUS, ob);
      nx = r.x;
      nz = r.z;
    }
  }

  npc.vx = (nx - npc.x) / Math.max(dtSec, 1e-3);
  npc.vz = (nz - npc.z) / Math.max(dtSec, 1e-3);
  npc.x = nx;
  npc.z = nz;
  npc.y = env.supportHeightAt(npc.x, npc.z, npc.y - NPC_EYE_HEIGHT, env.worldProps) + NPC_EYE_HEIGHT;
  npc.yaw = yawFromDir(mvx, mvz);
  return dist;
}

/** Settle an NPC in place (no movement): stop velocity, snap to ground. */
function holdStill(env, npc) {
  npc.vx = 0;
  npc.vz = 0;
  npc.y = env.supportHeightAt(npc.x, npc.z, npc.y - NPC_EYE_HEIGHT, env.worldProps) + NPC_EYE_HEIGHT;
}

/** Turn to face a world point without moving. */
function facePoint(npc, tx, tz) {
  const dx = tx - npc.x;
  const dz = tz - npc.z;
  if (Math.hypot(dx, dz) > 1e-3) npc.yaw = yawFromDir(dx, dz);
}

// --- Combat -----------------------------------------------------------------

/** Nearest hostile within detectRadius (ignores LOS so NPCs give chase). */
function acquireTarget(env, npc, cfg) {
  let best = null;
  let bestD = Infinity;
  for (const e of env.getHostiles(npc)) {
    if (!e || e.alive === false) continue;
    const d = dist2d(npc.x, npc.z, e.x, e.z);
    if (d <= cfg.detectRadius && d < bestD) {
      best = e;
      bestD = d;
    }
  }
  return best;
}

/**
 * Fire one hitscan shot at `target`. `hitChance` models accuracy: on a hit we
 * apply damage and draw the tracer to the target; on a miss we draw a tracer
 * that flies wide (no damage). Always emits a tracer so the client shows
 * muzzle flash + gunfire.
 */
function fireHitscan(env, npc, target, damage, now, opts = {}) {
  const weaponKey = opts.weaponKey || "rifle";
  const hitChance = opts.hitChance == null ? 1 : opts.hitChance;
  const eyeY = npc.y - 0.15;
  const origin = { x: npc.x, y: eyeY, z: npc.z };
  const aimY = (target.y != null ? target.y : NPC_EYE_HEIGHT) - 0.55;

  let dx = target.x - npc.x;
  let dy = aimY - eyeY;
  let dz = target.z - npc.z;
  const straight = Math.hypot(dx, dy, dz) || 1;

  let endX;
  let endY;
  let endZ;
  let hitId = null;
  if (Math.random() < hitChance) {
    env.applyDamage(target, damage, npc);
    endX = target.x;
    endY = aimY;
    endZ = target.z;
    hitId = target.id;
  } else {
    // Wide miss — jitter the direction so the tracer visibly flies past.
    const j = 0.07;
    dx = dx / straight + (Math.random() * 2 - 1) * j;
    dy = dy / straight + (Math.random() * 2 - 1) * j;
    dz = dz / straight + (Math.random() * 2 - 1) * j;
    const jl = Math.hypot(dx, dy, dz) || 1;
    endX = npc.x + (dx / jl) * straight;
    endY = eyeY + (dy / jl) * straight;
    endZ = npc.z + (dz / jl) * straight;
  }

  const edx = endX - origin.x;
  const edy = endY - origin.y;
  const edz = endZ - origin.z;
  const edist = Math.hypot(edx, edy, edz) || 1;
  env.emitTracer(npc.id, origin, { x: edx / edist, y: edy / edist, z: edz / edist }, edist, hitId, weaponKey);
  npc.lastShotAt = now;
}

/** Attacker: chase into range, then machine-gun with overheat + accuracy falloff. */
function updateAttacker(env, npc, cfg, target, now, dtSec) {
  const d = dist2d(npc.x, npc.z, target.x, target.z);
  const desired = cfg.attackRange * 0.78;
  if (d > desired) {
    stepTowards(env, npc, target.x, target.z, cfg.moveSpeed, dtSec);
  } else {
    holdStill(env, npc);
    facePoint(npc, target.x, target.z);
  }

  if (npc.overheatUntil > now) {
    npc.burstMs = 0;
    return;
  }

  const eyeY = npc.y - 0.15;
  const losY = target.y != null ? target.y : NPC_EYE_HEIGHT;
  const inRange = d <= cfg.attackRange;
  const los = env.hasLineOfSight(npc.x, eyeY, npc.z, target.x, losY - 0.4, target.z);
  // burstMs tracks continuous trigger-hold time (every tick a target is engaged),
  // not per-shot, so overheat fires after ~overheatAfterMs of sustained fire
  // regardless of the shot cadence.
  const engaging = inRange && los;
  if (engaging) {
    npc.burstMs += dtSec * 1000;
    if (now - npc.lastAttackAt >= cfg.fireIntervalMs) {
      npc.lastAttackAt = now;
      // Hit chance falls from 1.0 to minHitChance as the burst approaches overheat.
      const t = Math.min(1, npc.burstMs / cfg.overheatAfterMs);
      const hitChance = 1 - (1 - cfg.minHitChance) * t;
      fireHitscan(env, npc, target, cfg.damage, now, { hitChance, weaponKey: cfg.weaponKey });
    }
    if (npc.burstMs >= cfg.overheatAfterMs) {
      npc.overheatUntil = now + cfg.overheatMs;
      npc.burstMs = 0;
      env.addEvent("npc_overheat", { id: npc.id, x: npc.x, z: npc.z });
    }
  } else {
    // Bleed the heat gauge back down while no target is engaged.
    npc.burstMs = Math.max(0, npc.burstMs - dtSec * 1000 * 1.5);
  }
}

/** Healer: heal nearby allies on a per-player cooldown, plus a weak attack. */
function updateHealer(env, npc, cfg, target, now, dtSec) {
  // Ability: heal each allied player in radius, once per healCooldownPerPlayerMs.
  for (const ally of env.getAllies(npc)) {
    if (!ally || ally.alive === false) continue;
    if (dist2d(npc.x, npc.z, ally.x, ally.z) > cfg.healRadius) continue;
    if ((ally.health || 0) >= 100) continue;
    const nextAt = npc.healCooldowns[ally.id] || 0;
    if (now < nextAt) continue;
    env.healPlayer(ally, cfg.healAmount);
    npc.healCooldowns[ally.id] = now + cfg.healCooldownPerPlayerMs;
    env.addEvent("npc_heal", { id: npc.id, x: npc.x, z: npc.z, targetId: ally.id });
  }

  // Weak self-defense attack when an enemy is in range with a clear shot.
  if (target) {
    const d = dist2d(npc.x, npc.z, target.x, target.z);
    const desired = cfg.attackRange * 0.85;
    if (d > desired) {
      stepTowards(env, npc, target.x, target.z, cfg.moveSpeed, dtSec);
    } else {
      holdStill(env, npc);
      facePoint(npc, target.x, target.z);
    }
    const eyeY = npc.y - 0.15;
    const losY = target.y != null ? target.y : NPC_EYE_HEIGHT;
    if (
      d <= cfg.attackRange &&
      env.hasLineOfSight(npc.x, eyeY, npc.z, target.x, losY - 0.4, target.z) &&
      now - npc.lastAttackAt >= cfg.fireIntervalMs
    ) {
      npc.lastAttackAt = now;
      fireHitscan(env, npc, target, cfg.damage, now, { hitChance: 0.85, weaponKey: cfg.weaponKey });
    }
  }
}

/** Weak self-defence fire shared by the low-damage roles (defender/summoner). */
function weakAttack(env, npc, cfg, target, now, hitChance) {
  if (!target) return;
  const d = dist2d(npc.x, npc.z, target.x, target.z);
  const eyeY = npc.y - 0.15;
  const losY = target.y != null ? target.y : NPC_EYE_HEIGHT;
  if (
    d <= cfg.attackRange &&
    env.hasLineOfSight(npc.x, eyeY, npc.z, target.x, losY - 0.4, target.z) &&
    now - npc.lastAttackAt >= cfg.fireIntervalMs
  ) {
    npc.lastAttackAt = now;
    fireHitscan(env, npc, target, cfg.damage, now, { hitChance, weaponKey: cfg.weaponKey });
  }
}

/**
 * Defender: high HP, weak gun. Drops a protective dome when the owner is
 * threatened and the ability is off cooldown, then parks inside it to hold the
 * line. Enemies are kept out / damage-negated by the HOST (see z_plus server),
 * which reads the active shield via getActiveShields(); this module only owns
 * the ability's timing and the defender's positioning.
 */
function updateDefender(env, npc, cfg, target, now, dtSec) {
  const owner = env.getPlayerById(npc.ownerId);
  const shieldActive = now < npc.shieldUntil;

  if (!shieldActive && now >= npc.shieldCooldownUntil) {
    // Deploy when a hostile is closing on the owner (or the defender itself).
    let threatened = false;
    const trigger = cfg.shieldRadius + 7;
    for (const e of env.getHostiles(npc)) {
      if (!e || e.alive === false) continue;
      // Independent checks (not Math.min) so one bad/NaN distance can't mask the other.
      const nearOwner = owner ? dist2d(owner.x, owner.z, e.x, e.z) : Infinity;
      if (nearOwner <= trigger || dist2d(npc.x, npc.z, e.x, e.z) <= trigger) {
        threatened = true;
        break;
      }
    }
    if (threatened) {
      npc.shieldX = owner ? owner.x : npc.x;
      npc.shieldZ = owner ? owner.z : npc.z;
      npc.shieldUntil = now + cfg.shieldDurationMs;
      npc.shieldCooldownUntil = now + cfg.shieldCooldownMs;
      env.addEvent("npc_shield", { id: npc.id, x: npc.shieldX, z: npc.shieldZ, radius: cfg.shieldRadius });
    }
  }

  if (now < npc.shieldUntil) {
    // Anchor near the dome centre so the safe bubble stays put.
    const dc = dist2d(npc.x, npc.z, npc.shieldX, npc.shieldZ);
    if (dc > cfg.shieldRadius * 0.45) {
      stepTowards(env, npc, npc.shieldX, npc.shieldZ, cfg.moveSpeed, dtSec);
    } else {
      holdStill(env, npc);
      if (target) facePoint(npc, target.x, target.z);
    }
  } else if (target) {
    const d = dist2d(npc.x, npc.z, target.x, target.z);
    if (d > cfg.attackRange * 0.85) stepTowards(env, npc, target.x, target.z, cfg.moveSpeed, dtSec);
    else {
      holdStill(env, npc);
      facePoint(npc, target.x, target.z);
    }
  } else if (owner) {
    followOwner(env, npc, cfg, owner, dtSec);
  } else {
    holdStill(env, npc);
  }

  weakAttack(env, npc, cfg, target, now, 0.8);
}

/**
 * Summoner: weak on its own, but keeps a pack of MINION_COUNT minions. A new
 * pack is (re)summoned only once every minion is dead. Minions are appended to
 * env.npcs via env._spawnMinion (applied by the fleet update after iteration).
 */
function updateSummoner(env, npc, cfg, target, now, dtSec) {
  const owner = env.getPlayerById(npc.ownerId);

  const living = env.npcs.filter(
    (n) => n.role === "minion" && n.summonerId === npc.id && n.state === "active",
  );
  npc.minionIds = living.map((n) => n.id);

  if (living.length === 0) {
    // Schedule a pack the moment the previous one is wiped (and on first spawn).
    if (npc.nextSummonAt === 0) npc.nextSummonAt = now + cfg.resummonDelayMs;
    if (now >= npc.nextSummonAt && env._spawnMinion) {
      for (let i = 0; i < cfg.minionCount; i += 1) env._spawnMinion(makeMinion(env, npc, i, now));
      npc.nextSummonAt = 0;
      env.addEvent("npc_summon", { id: npc.id, x: npc.x, z: npc.z, count: cfg.minionCount });
    }
  } else {
    npc.nextSummonAt = 0;
  }

  if (target) {
    const d = dist2d(npc.x, npc.z, target.x, target.z);
    // The summoner keeps its distance and lets the pack do the fighting.
    if (d < cfg.attackRange * 0.6 && owner) {
      followOwner(env, npc, cfg, owner, dtSec);
    } else {
      holdStill(env, npc);
      facePoint(npc, target.x, target.z);
    }
  } else if (owner) {
    followOwner(env, npc, cfg, owner, dtSec);
  } else {
    holdStill(env, npc);
  }

  weakAttack(env, npc, cfg, target, now, 0.75);
}

/** Minion: fast, fragile, hits hard. Aggressively chases and guns down hostiles. */
function updateMinion(env, npc, cfg, target, now, dtSec) {
  const owner = env.getPlayerById(npc.ownerId);
  if (!target) {
    if (owner) followOwner(env, npc, cfg, owner, dtSec);
    else holdStill(env, npc);
    return;
  }
  const d = dist2d(npc.x, npc.z, target.x, target.z);
  if (d > cfg.attackRange * 0.7) stepTowards(env, npc, target.x, target.z, cfg.moveSpeed, dtSec);
  else {
    holdStill(env, npc);
    facePoint(npc, target.x, target.z);
  }
  weakAttack(env, npc, cfg, target, now, 0.85);
}

// --- Follow -----------------------------------------------------------------

/** Stable slot index of this NPC among its owner's active companions. */
function ownerSlotIndex(env, npc) {
  let slot = 0;
  for (const other of env.npcs) {
    if (other === npc) break;
    if (other.ownerId === npc.ownerId && (other.state === "active" || other.state === "arriving")) {
      slot += 1;
    }
  }
  return slot;
}

/** Follow the owner in a loose V formation, keeping a reasonable distance. */
function followOwner(env, npc, cfg, owner, dtSec) {
  const slot = ownerSlotIndex(env, npc);
  const back = 4.5;
  const side = 2.3 * (slot % 2 === 0 ? 1 : -1) * (1 + Math.floor(slot / 2) * 0.7);
  const fwdX = -Math.sin(owner.yaw);
  const fwdZ = -Math.cos(owner.yaw);
  const rightX = Math.cos(owner.yaw);
  const rightZ = -Math.sin(owner.yaw);
  const tx = owner.x - fwdX * back + rightX * side;
  const tz = owner.z - fwdZ * back + rightZ * side;

  const d = dist2d(npc.x, npc.z, tx, tz);
  if (d <= FOLLOW_STOP_DIST) {
    holdStill(env, npc);
    npc.yaw = owner.yaw;
    return;
  }
  const speed = d > FOLLOW_CATCHUP_DIST ? cfg.moveSpeed * 1.6 : cfg.moveSpeed;
  stepTowards(env, npc, tx, tz, speed, dtSec);
}

// --- Per-NPC update by state ------------------------------------------------


function updateArriving(env, npc, now) {
  holdStill(env, npc);
  // Owner bailed before arrival — return the pod to the pool.
  if (!npc.ownerId || !env.getPlayerById(npc.ownerId)) {
    resetToAvailable(env, npc);
    return;
  }
  if (now >= npc.arriveUntil) npc.state = "active";
}

function updateActiveNpc(env, npc, cfg, now, dtSec) {
  const owner = env.getPlayerById(npc.ownerId);
  if (!owner) {
    // Owner disconnected. Minions die with their master's absence; recruited
    // companions return to the recruitable pool.
    if (npc.role === "minion") {
      npc.state = "dead";
      return;
    }
    resetToAvailable(env, npc);
    return;
  }

  const target = acquireTarget(env, npc, cfg);
  npc.targetId = target ? target.id : null;

  if (npc.role === "healer") {
    // Healer always services its aura; it only chases/attacks if a target exists.
    updateHealer(env, npc, cfg, target, now, dtSec);
    if (!target) followOwner(env, npc, cfg, owner, dtSec);
  } else if (npc.role === "attacker") {
    if (target) updateAttacker(env, npc, cfg, target, now, dtSec);
    else followOwner(env, npc, cfg, owner, dtSec);
  } else if (npc.role === "defender") {
    updateDefender(env, npc, cfg, target, now, dtSec);
  } else if (npc.role === "summoner") {
    updateSummoner(env, npc, cfg, target, now, dtSec);
  } else if (npc.role === "minion") {
    updateMinion(env, npc, cfg, target, now, dtSec);
  } else {
    followOwner(env, npc, cfg, owner, dtSec);
  }
}


/** Owner gone: the companion leaves (removed by the fleet update). */
function resetToAvailable(env, npc) {
  npc.state = "dead";
  npc.diedAt = 0;
  npc.ownerId = null;
}


// --- Public per-tick entry point --------------------------------------------

/**
 * Advance every NPC one tick. `env` must provide:
 *   npcs, worldProps, worldHalfSize,
 *   clamp, pointInsideObstacle, obstacleBlocksPlayer, supportHeightAt,
 *   propsNear, resolveObstacleCollision,
 *   active() -> bool,
 *   getPlayerById(id) -> player|null,
 *   getAllies(npc) -> [players], getHostiles(npc) -> [entities],
 *   hasLineOfSight(ax,ay,az,bx,by,bz) -> bool,
 *   applyDamage(target, amount, npc), healPlayer(player, amount),
 *   emitTracer(fromId, origin, dir, distance, hitId, weaponKey),
 *   addEvent(type, payload)
 */
function updateNpcFleet(env, dtSec, now) {
  const playing = env.active ? env.active() : true;

  // Reap dead minions (re-summoned, never respawned) and fallen companions
  // (they leave the party, freeing the role) so their meshes go too.
  for (let i = env.npcs.length - 1; i >= 0; i -= 1) {
    const n = env.npcs[i];
    if (n.state !== "dead") continue;
    if (n.role === "minion" || now - (n.diedAt || 0) > CORPSE_MS) env.npcs.splice(i, 1);
  }

  // Summoners append new minions through this sink; applied after the loop so
  // we never mutate env.npcs mid-iteration.
  const pendingMinions = [];
  env._spawnMinion = (m) => pendingMinions.push(m);

  for (const npc of env.npcs) {
    const cfg = NPC_ROLES[npc.role];
    if (!cfg) continue;

    if (npc.state === "dead") continue;
    if (npc.state === "arriving") {
      updateArriving(env, npc, now);
      continue;
    }
    if (npc.state === "active") {
      if (playing) updateActiveNpc(env, npc, cfg, now, dtSec);
      else holdStill(env, npc);
    }
  }

  if (pendingMinions.length) env.npcs.push(...pendingMinions);
  env._spawnMinion = null;
}

/**
 * Apply damage to an NPC (called by the host from its bullet / melee / zombie
 * damage paths). Only `active` NPCs are damageable. Returns true if this hit
 * killed the NPC (host may award a kill to the attacker).
 */
function damageNpc(env, npc, amount, now) {
  if (npc.state !== "active") return false;
  npc.health -= amount;
  if (npc.health <= 0) {
    npc.health = 0;
    npc.state = "dead";
    npc.targetId = null;
    npc.vx = 0;
    npc.vz = 0;
    if (npc.role === "minion") {
      // Minions are reaped (not respawned) by the fleet update.
      npc.ownerId = null;
      if (env.addEvent) env.addEvent("npc_down", { id: npc.id, role: npc.role, x: npc.x, z: npc.z });
      return true;
    }
    npc.diedAt = now; // removed from the party after a short death pose
    npc.ownerId = null;
    if (npc.role === "summoner") {
      // The pack falls with its master — kill every linked minion at once.
      for (const n of env.npcs) {
        if (n.role === "minion" && n.summonerId === npc.id && n.state === "active") {
          n.state = "dead";
          n.health = 0;
          if (env.addEvent) env.addEvent("npc_down", { id: n.id, role: "minion", x: n.x, z: n.z });
        }
      }
      npc.minionIds = [];
    }
    if (env.addEvent) env.addEvent("npc_down", { id: npc.id, role: npc.role, x: npc.x, z: npc.z });
    return true;
  }
  return false;
}

/**
 * Active defender shields, for the host to enforce (keep hostiles out + negate
 * their damage to anyone inside). Returns [{ x, z, radius, until }].
 */
function getActiveShields(npcs, now) {
  const out = [];
  for (const npc of npcs) {
    if (npc.role === "defender" && npc.state === "active" && now < npc.shieldUntil) {
      out.push({
        x: npc.shieldX,
        z: npc.shieldZ,
        radius: NPC_ROLES.defender.shieldRadius,
        until: npc.shieldUntil,
      });
    }
  }
  return out;
}

/** Compact per-client serialization (positions rounded by the host if desired). */
function serializeNpc(npc, now) {
  return {
    id: npc.id,
    role: npc.role,
    x: npc.x,
    y: npc.y,
    z: npc.z,
    yaw: npc.yaw,
    vx: npc.vx || 0,
    vz: npc.vz || 0,
    state: npc.state,
    ownerId: npc.ownerId,
    health: Math.max(0, Math.round(npc.health)),
    maxHealth: npc.maxHealth,
    homeX: npc.homeX,
    homeZ: npc.homeZ,
    available: npc.state === "available",
    lastShotAt: npc.lastShotAt,
    respawnMs: npc.state === "dead" ? Math.max(0, npc.respawnAt - now) : 0,
    arriveMs: npc.state === "arriving" ? Math.max(0, npc.arriveUntil - now) : 0,
    recruitProgressMs: npc.state === "available" ? Math.round(npc.recruitProgressMs) : 0,
    overheatMs: npc.overheatUntil > now ? npc.overheatUntil - now : 0,
    // Defender dome (for client rendering + the roster panel).
    shield:
      npc.role === "defender"
        ? {
            active: now < npc.shieldUntil,
            x: npc.shieldX,
            z: npc.shieldZ,
            radius: NPC_ROLES.defender.shieldRadius,
            ms: Math.max(0, npc.shieldUntil - now),
            cooldownMs: Math.max(0, npc.shieldCooldownUntil - now),
          }
        : undefined,
    // Summoner pack size (for the roster panel).
    minionCount: npc.role === "summoner" ? (npc.minionIds ? npc.minionIds.length : 0) : undefined,
    minionMax: npc.role === "summoner" ? NPC_ROLES.summoner.minionCount : undefined,
    summonerId: npc.summonerId || null,
  };
}

// --- Recruit beacon -----------------------------------------------------------

/** Roles a player can still recruit (each role once per party). */
function missingRoles(env, playerId) {
  const allow = Array.isArray(env.allowRoles) ? env.allowRoles : Object.keys(NPC_ROLES).filter((r) => NPC_ROLES[r].recruitable !== false);
  const owned = new Set(
    env.npcs.filter((n) => n.ownerId === playerId && n.role !== "minion" && n.state !== "dead").map((n) => n.role),
  );
  return allow.filter((r) => !owned.has(r));
}

/** A fresh companion for `owner`, dropping in beside them. */
function makeCompanion(env, role, owner, now) {
  const cfg = NPC_ROLES[role];
  companionSeq += 1;
  const a = Math.random() * Math.PI * 2;
  const spot = clearHome(env, owner.x + Math.cos(a) * 2.5, owner.z + Math.sin(a) * 2.5);
  return {
    id: `npc-${role}-${companionSeq}`,
    role,
    homeX: spot.x,
    homeZ: spot.z,
    x: spot.x,
    y: groundEye(env, spot.x, spot.z),
    z: spot.z,
    vx: 0,
    vz: 0,
    yaw: owner.yaw || 0,
    state: "arriving",
    ownerId: owner.id,
    health: cfg.maxHealth,
    maxHealth: cfg.maxHealth,
    recruiterId: null,
    recruitProgressMs: 0,
    arriveUntil: now + ARRIVE_MS,
    respawnAt: 0,
    targetId: null,
    lastShotAt: 0,
    lastAttackAt: 0,
    burstMs: 0,
    overheatUntil: 0,
    healCooldowns: {},
    shieldUntil: 0,
    shieldCooldownUntil: 0,
    shieldX: 0,
    shieldZ: 0,
    minionIds: [],
    nextSummonAt: 0,
    summonerId: null,
  };
}

/** The roaming recruit point. env.randomRecruitSpot() picks a walkable spot. */
function createRecruitBeacon(env) {
  const spot = env.randomRecruitSpot();
  return { x: spot.x, z: spot.z, active: true, nextAt: 0, sessions: new Map() };
}

/** Player is holding Recruit (re-sent every ~500ms while held). */
function assertRecruit(beacon, playerId, now) {
  if (!beacon.active) return;
  const s = beacon.sessions.get(playerId) || { progressMs: 0, lastAssertAt: now };
  s.lastAssertAt = now;
  beacon.sessions.set(playerId, s);
}

function cancelRecruit(beacon, playerId) {
  beacon.sessions.delete(playerId);
}

function updateRecruitBeacon(env, beacon, dtSec, now) {
  if (!beacon.active) {
    if (now >= beacon.nextAt) {
      const spot = env.randomRecruitSpot();
      beacon.x = spot.x;
      beacon.z = spot.z;
      beacon.active = true;
      env.addEvent("recruit_beacon", { x: spot.x, z: spot.z });
    }
    return;
  }
  for (const [pid, s] of beacon.sessions) {
    const p = env.getPlayerById(pid);
    const inRange = p && p.alive && dist2d(p.x, p.z, beacon.x, beacon.z) <= RECRUIT_RADIUS;
    const free = p ? missingRoles(env, pid) : [];
    if (!inRange || now - s.lastAssertAt > RECRUIT_ASSERT_MS || free.length === 0) {
      beacon.sessions.delete(pid);
      continue;
    }
    s.progressMs += dtSec * 1000;
    if (s.progressMs < RECRUIT_HOLD_MS) continue;
    // Recruited: a random role this player doesn't have yet drops in.
    const role = free[Math.floor(Math.random() * free.length)];
    const npc = makeCompanion(env, role, p, now);
    env.npcs.push(npc);
    env.addEvent("npc_arrive", { id: npc.id, role, x: npc.x, z: npc.z, ownerId: pid });
    // The beacon moves on: gone for 3 minutes, then somewhere new.
    beacon.active = false;
    beacon.nextAt = now + BEACON_RELOCATE_MS;
    beacon.sessions.clear();
    break;
  }
}

function serializeRecruitBeacon(beacon, now) {
  const progress = {};
  for (const [pid, s] of beacon.sessions) progress[pid] = Math.round(s.progressMs);
  return {
    x: Math.round(beacon.x * 100) / 100,
    z: Math.round(beacon.z * 100) / 100,
    active: beacon.active,
    returnsInMs: beacon.active ? 0 : Math.max(0, beacon.nextAt - now),
    holdMs: RECRUIT_HOLD_MS,
    progress,
  };
}

module.exports = {
  createRecruitBeacon,
  assertRecruit,
  cancelRecruit,
  updateRecruitBeacon,
  serializeRecruitBeacon,
  missingRoles,
  NPC_ROLES,
  RECRUIT_RADIUS,
  RECRUIT_HOLD_MS,
  buildNpcSpawns,
  updateNpcFleet,
  damageNpc,
  serializeNpc,
  getActiveShields,
};
