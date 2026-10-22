/**
 * Z+ mode — co-op zombie survival on the frag map.
 *
 * Route: /frag/z_plus (auto-join with a random survivor name).
 * Same world as frag mode; adds:
 *  - 5 min day / 5 min night cycle (smooth transition factor sent to clients)
 *  - wave spawning (first wave 60s after the first player joins), ambient
 *    trickle spawns between waves — both doubled at night
 *  - six zombie types (walker, runner, tank, screamer, crawler, jumper) plus
 *    a mini-boss tank every 5th wave
 *  - layered zombie AI: FSM (idle/patrol/investigate/chase/attack/search),
 *    vision cone + line-of-sight raycasts, hearing driven by noise events
 *    (gunshots, sprinting, engines), memory of last known player position,
 *    flanking roles, steering with separation + obstacle avoidance + stuck
 *    detours, and a horde manager that LODs AI updates by distance
 *  - dynamic difficulty (spawn rate follows player health/kill rate; campers
 *    get spawns behind them)
 */

const express = require("express");
const path = require("path");
const {
  updateVehicleFleet,
  seatWorld,
  resolveCircleVsVehicles,
  SEATED_EYE,
  createVehicleNet,
  serializeVehicleDelta,
} = require("../vehicle-system");
const { createWeather, updateWeather, serializeWeather, weatherGrip } = require("../weather-system");
const {
  NPC_ROLES,
  RECRUIT_RADIUS,
  buildNpcSpawns,
  createRecruitBeacon,
  assertRecruit,
  cancelRecruit,
  updateRecruitBeacon,
  serializeRecruitBeacon,
  updateNpcFleet,
  damageNpc,
  serializeNpc,
  getActiveShields,
} = require("../npc-system");
const {
  WEAPONS,
  DEFAULT_SLOTS,
  buildWorldLayout,
  clamp,
  randomInRange,
  pointInsideObstacle,
  obstacleBlocksPlayer,
  supportHeightAt,
  propsNear,
  propsAlongSegment,
  resolveObstacleCollision,
  rayAabbDistance,
  PLAYER_CONSTANTS: C,
} = require("../server");
const { createStructureSystem } = require("../structure-system");
const { createDragonEvent } = require("./dragon-system");
const { createBossEvent } = require("./boss-system");

const TICK_RATE = 30;
const BROADCAST_RATE = 15;

const DAY_MS = 5 * 60 * 1000;
const NIGHT_MS = 5 * 60 * 1000;
const CYCLE_MS = DAY_MS + NIGHT_MS;
const DUSK_MS = 25 * 1000; // transition window

const FIRST_WAVE_DELAY_MS = Number(process.env.ZPLUS_FIRST_WAVE_MS) || 60 * 1000;
// Waves are time-based: a new wave spawns on this fixed cadence regardless of
// how many zombies from earlier waves are still alive, so hordes accumulate.
const WAVE_INTERVAL_MS = Number(process.env.ZPLUS_WAVE_INTERVAL_MS) || 45 * 1000;
const MAX_ZOMBIES = 90;
const HORDE_PULSE_MS = 2 * 60 * 1000; // every 2 min the horde senses all players
const DAY_GROWTH = 0.3; // spawn growth per survived day/night cycle
const DAY_GROWTH_CAP = 2.5;
const ZOMBIE_SNAPSHOT_RANGE = 190;
const RESPAWN_MS = 8 * 1000;
const REGEN_DELAY_MS = 6000;
const REGEN_PER_SEC = 7;

const MAX_SHOT_EVENTS = 128;
// Each shot rides ~6 consecutive snapshots (enough to survive a couple of
// dropped volatile packets); it used to be re-sent ~22 times.
const SHOT_EVENT_TTL_MS = 450;
const MAX_ACTIVE_BULLETS = 300;
const BULLET_MAX_LIFETIME_MS = 2600;

const VEHICLE_ENTER_RADIUS = 6.5;
const VEHICLE_EXIT_OFFSET = 4.4;
const VEHICLE_ACCEL = 24;
const VEHICLE_BRAKE = 28;
const VEHICLE_REVERSE_ACCEL = 13;
const VEHICLE_DRAG = 3.1;
const VEHICLE_TURN_RATE = 1.95;
const VEHICLE_MAX_SPEED = 28;

const ZOMBIE_TYPES = {
  walker: {
    key: "walker", hp: 60, speed: 1.5, chaseSpeed: 3.4, damage: 9, attackRange: 1.7,
    attackMs: 1100, vision: 18, hearing: 1.0, scale: 1.0, height: 1.8, radius: 0.45, score: 10,
  },
  runner: {
    key: "runner", hp: 45, speed: 2.4, chaseSpeed: 7.0, damage: 7, attackRange: 1.6,
    attackMs: 800, vision: 24, hearing: 1.2, scale: 0.95, height: 1.72, radius: 0.4, score: 15,
    // Smart runner: jukes sideways when a player draws a bead on it (see the
    // dodge trigger in the shoot handler + the lateral juke in moveZombie).
    dodger: true,
  },
  tank: {
    key: "tank", hp: 420, speed: 1.1, chaseSpeed: 2.7, damage: 26, attackRange: 2.3,
    attackMs: 1600, vision: 16, hearing: 0.8, scale: 1.45, height: 2.35, radius: 0.7, score: 60,
  },
  screamer: {
    key: "screamer", hp: 50, speed: 2.0, chaseSpeed: 4.2, damage: 6, attackRange: 1.6,
    attackMs: 1000, vision: 26, hearing: 1.6, scale: 0.9, height: 1.68, radius: 0.4, score: 25,
  },
  crawler: {
    key: "crawler", hp: 35, speed: 2.0, chaseSpeed: 5.0, damage: 8, attackRange: 1.4,
    attackMs: 900, vision: 14, hearing: 1.1, scale: 0.9, height: 0.8, radius: 0.45, score: 15,
  },
  jumper: {
    key: "jumper", hp: 55, speed: 2.2, chaseSpeed: 5.4, damage: 12, attackRange: 1.7,
    attackMs: 950, vision: 22, hearing: 1.1, scale: 0.95, height: 1.7, radius: 0.42, score: 25,
  },
  // Flyer: 1.5x a walker's health, hovers above the map, dives to attack,
  // and juke-dodges sideways when someone shoots at it.
  flyer: {
    key: "flyer", hp: 90, speed: 3.2, chaseSpeed: 6.8, damage: 10, attackRange: 2.2,
    attackMs: 900, vision: 32, hearing: 1.3, scale: 0.95, height: 1.4, radius: 0.45, score: 35,
    flying: true, hoverHeight: 4.4,
  },
};

const EMERGE_MS = 1700; // zombies claw their way out of the ground

const SURVIVOR_ADJ = ["Rusty", "Silent", "Grim", "Lucky", "Feral", "Ashen", "Broken", "Swift", "Iron", "Pale"];
const SURVIVOR_NOUN = ["Fox", "Wolf", "Crow", "Rat", "Hound", "Viper", "Moth", "Bear", "Hawk", "Ghost"];

function randomSurvivorName() {
  const a = SURVIVOR_ADJ[Math.floor(Math.random() * SURVIVOR_ADJ.length)];
  const n = SURVIVOR_NOUN[Math.floor(Math.random() * SURVIVOR_NOUN.length)];
  return `${a}${n}-${Math.floor(Math.random() * 900 + 100)}`;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function initZPlusMode(app, io, rootDir) {
  const nsp = io.of("/frag-zplus");
  const players = new Map();
  const zombies = new Map();
  const bullets = new Map();
  const { props: worldProps, terrainPatches, vehicles, wildlife, buildings } = buildWorldLayout();
  // Recruitable AI companions (shared system with frag). In co-op, enemies are
  // zombies and every human player is an ally.
  const weather = createWeather(Date.now()); // shared sky: clear / cloudy / rain / storm / fog / snow
  const npcs = buildNpcSpawns({
    worldProps,
    worldHalfSize: C.WORLD_HALF_SIZE,
    clamp,
    pointInsideObstacle,
    obstacleBlocksPlayer,
    supportHeightAt,
    propsNear,
    allowRoles: ["healer", "attacker", "defender", "summoner"], // full co-op roster
  });
  const killFeed = [];
  const shotEvents = [];
  const noiseEvents = [];
  const zombieEvents = [];
  const vehicleEvents = [];
  const destroyedPropIds = [];
  let shotSeq = 0;
  let bulletSeq = 0;
  let zombieSeq = 0;

  const modeStartAt = Date.now();
  let firstJoinAt = null;
  // ZPLUS_START_WAVE lets tests jump straight to boss/flyer waves.
  let waveNumber = Math.max(0, (Number(process.env.ZPLUS_START_WAVE) || 1) - 1);
  let nextWaveAt = null;
  let waveActive = false;
  let nextHordePulseAt = null;

  // Dynamic difficulty state.
  const difficulty = { spawnMult: 1, runnerBias: 0, lastEvalAt: 0, recentKills: [] };

  let lastTickAt = Date.now();
  let lastBroadcastAt = 0;
  let lastAmbientAt = 0;
  let lastNoiseSampleAt = 0;

  // ---------------------------------------------------------------------
  // Day / night
  // ---------------------------------------------------------------------

  function cycleInfo(now) {
    const t = (now - modeStartAt) % CYCLE_MS;
    const isNight = t >= DAY_MS;
    let factor; // 0 = day, 1 = night
    if (!isNight) {
      factor = t > DAY_MS - DUSK_MS ? (t - (DAY_MS - DUSK_MS)) / DUSK_MS : 0;
    } else {
      const nt = t - DAY_MS;
      factor = nt > NIGHT_MS - DUSK_MS ? 1 - (nt - (NIGHT_MS - DUSK_MS)) / DUSK_MS : 1;
    }
    const day = 1 + Math.floor((now - modeStartAt) / CYCLE_MS);
    return { t, isNight, factor, day };
  }

  // Spawns scale up with every day/night cycle survived.
  function dayGrowthMult(now) {
    const { day } = cycleInfo(now);
    return Math.min(DAY_GROWTH_CAP, 1 + DAY_GROWTH * (day - 1));
  }

  // ---------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------

  function addKillFeed(killer, victim, now) {
    killFeed.unshift({ at: now, killer, victim });
    killFeed.splice(8);
  }

  function addNoise(x, z, loud, now) {
    noiseEvents.push({ x, z, loud, at: now });
    if (noiseEvents.length > 64) noiseEvents.splice(0, noiseEvents.length - 64);
  }

  function addVehicleEvent(type, payload) {
    vehicleEvents.push({ type, at: Date.now(), ...payload });
    if (vehicleEvents.length > 32) vehicleEvents.splice(0, vehicleEvents.length - 32);
    if (type === "treefall") destroyedPropIds.push(payload.propId);
    // Crashes are loud — zombies investigate them.
    if (type === "crash" && payload.power > 8) addNoise(payload.x, payload.z, 34, Date.now());
  }

  // ---- Destructible buildings (same system as frag) ----
  // Walls / roof tiles break under fire and car rams; lose enough sides and
  // the building collapses on whoever (or whatever) is inside.
  const WALL_BULLET_SCALE = 0.3; // per-bullet damage x this
  const WALL_RAM_SCALE = 1.3; // 0.5 * mass * v^2 x this
  const structures = createStructureSystem({
    worldProps,
    buildings,
    onCollapse: (b, attacker, now) => {
      const inside = (x, z, pad) => Math.abs(x - b.x) < b.w / 2 + pad && Math.abs(z - b.z) < b.d / 2 + pad;
      const crushPad = b.h > 60 ? 22 : 1.2;
      for (const p of players.values()) {
        if (!p.alive || !inside(p.x, p.z, crushPad)) continue;
        p.health -= 220;
        p.lastDamagedAt = now;
        if (p.health <= 0) killPlayer(p, attacker ? `${attacker.name} (building collapse)` : "Building collapse", now);
      }
      for (const zb of zombies.values()) {
        if (zb.alive && inside(zb.x, zb.z, crushPad)) damageZombie(zb, 9999, attacker ? players.get(attacker.id) : null, "collapse", now);
      }
      for (const v of vehicles) {
        if (!v.destroyed && inside(v.x, v.z, 1)) v.health = Math.max(0, (v.health ?? 100) - 70);
      }
      addVehicleEvent("collapse", { x: b.x, y: 1, z: b.z, power: Math.min(60, 18 + b.h), buildingId: b.id });
    },
  });
  let lastStructureEmitAt = 0;

  // ---- "The Rift" boss event: every 10th wave (see dragon-system.js) ----
  const eventEnv = {
    players,
    zombies,
    worldHalf: C.WORLD_HALF_SIZE,
    waveNumber: () => waveNumber,
    addZombieEvent: (type, x, z, now, extra) => addZombieEvent(type, x, z, now, extra),
    addKillFeed: (a, b, now) => addKillFeed(a, b, now),
    propsNear: (x, z) => propsNear(worldProps, x, z),
    propsAlongSegment: (ax, az, bx, bz) => propsAlongSegment(worldProps, ax, az, bx, bz),
    rayAabbDistance,
    hurtPlayer: (p, dmg, cause, now) => {
      if (!p.alive) return;
      p.health -= dmg;
      p.lastDamagedAt = now;
      if (p.health <= 0) killPlayer(p, cause, now);
    },
    hurtZombie: (zb, dmg, now) => damageZombie(zb, dmg, null, "fire", now),
    hurtZombieBy: (zb, dmg, owner, now) => damageZombie(zb, dmg, owner, "pet", now),
    // Terrain height for the Wyrm's landings (it lands on the ground and
    // crushes buildings; only the mountain rock is solid "ground" up high).
    groundHeight: (x, z) => {
      let h = 0;
      for (const p of propsNear(worldProps, x, z)) {
        if (p.type !== "cliff" && p.type !== "cavewall" && p.type !== "caveroof") continue;
        if (Math.abs(x - p.x) <= p.sx / 2 && Math.abs(z - p.z) <= p.sz / 2) h = Math.max(h, (p.py || 0) + p.sy);
      }
      return h;
    },
    // Slams / tail sweeps / wing gusts throw players around.
    knockback: (p, ix, iy, iz) => {
      p.vx = (p.vx || 0) + ix;
      p.vz = (p.vz || 0) + iz;
      p.vy = Math.max(p.vy || 0, iy);
      p.knockedUntil = Date.now() + 450;
    },
    lineOfSight: (ax, ay, az, bx, by, bz) => hasLineOfSight(ax, ay, az, bx, by, bz),
    // Explosions / breath / ramming: break buildings; optionally hurt
    // vehicles and zombies caught in it.
    blast: (pt, radius, dmg, now, by, hitsEntities = false) => {
      if (radius > 0) structures.applyBlast(pt, radius, dmg, now, by);
      if (!hitsEntities) return;
      for (const v of vehicles) {
        const d = Math.hypot(v.x - pt.x, (v.y || 0) + 1 - pt.y, v.z - pt.z);
        if (!v.destroyed && d < radius + 1.5) v.health = Math.max(0, (v.health ?? 100) - 70 * (1 - d / (radius + 1.5)));
      }
      for (const zb of zombies.values()) {
        if (!zb.alive) continue;
        const d = Math.hypot(zb.x - pt.x, zb.z - pt.z);
        if (d < radius) damageZombie(zb, 120 * (1 - d / radius), null, "explosion", now);
      }
    },
    // The roar: fresh zombies claw up around the players.
    summon: (now) => {
      const alive = Array.from(players.values()).filter((p) => p.alive);
      if (!alive.length) return;
      const anchor = alive[Math.floor(Math.random() * alive.length)];
      const pos = pickSpawnPoint(anchor);
      if (!pos) return;
      const r = Math.random();
      const zb = spawnZombie(r < 0.45 ? "walker" : r < 0.75 ? "runner" : "flyer", pos, now);
      if (zb) {
        zb.lastKnown = { x: anchor.x, z: anchor.z };
        zb.state = "investigate";
      }
    },
    // Dragon down: the regular wave cycle picks up again shortly.
    onEventEnd: (now) => {
      nextWaveAt = now + 20000;
      waveActive = false;
    },
    // Mini-dragon pets also fight champion bosses.
    bossTarget: () => bossEvent.hostile(),
    damageBoss: (amount, owner, now) => bossEvent.damage(amount, owner, "pet", now),
  };
  const dragonEvent = createDragonEvent(eventEnv);
  // ---- Champion bosses: waves 5, 15, 25, ... (see boss-system.js) ----
  const bossEvent = createBossEvent({
    ...eventEnv,
    hurtPetsNear: (x, z, r, dmg, now) => dragonEvent.hurtPetsNear(x, z, r, dmg, now),
  });
  const bossFightActive = () => dragonEvent.active() || bossEvent.active();

  function addZombieEvent(type, x, z, now, extra = {}) {
    zombieEvents.push({ type, x: round2(x), z: round2(z), at: now, ...extra });
    if (zombieEvents.length > 32) zombieEvents.splice(0, zombieEvents.length - 32);
  }

  function addShotEvent(fromId, origin, dir, distance, hit, now, weaponKey) {
    shotSeq += 1;
    shotEvents.push({
      id: shotSeq,
      at: now,
      fromId,
      ox: round2(origin.x),
      oy: round2(origin.y),
      oz: round2(origin.z),
      dx: round2(dir.x),
      dy: round2(dir.y),
      dz: round2(dir.z),
      distance: round2(distance),
      hitPlayerId: hit?.playerId || null,
      hitZombieId: hit?.zombieId || null,
      hitPart: hit?.part || null,
      damage: hit?.damage ? round2(hit.damage) : 0,
      weapon: weaponKey,
    });
    if (shotEvents.length > MAX_SHOT_EVENTS) shotEvents.splice(0, shotEvents.length - MAX_SHOT_EVENTS);
  }

  function addBulletTrail(fromId, weaponKey, now, fromPos, toPos, hit = null) {
    const dx = toPos.x - fromPos.x;
    const dy = toPos.y - fromPos.y;
    const dz = toPos.z - fromPos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist <= 0.001) return;
    addShotEvent(fromId, fromPos, { x: dx / dist, y: dy / dist, z: dz / dist }, dist, hit, now, weaponKey);
  }

  // ---------------------------------------------------------------------
  // Players (movement/vehicles copied from frag mode, minus zone/phases)
  // ---------------------------------------------------------------------

  function defaultWeapon() {
    return WEAPONS.rifle;
  }

  function refillMagazine(player, weapon) {
    player.ammoInMag = weapon.magSize;
    player.magSize = weapon.magSize;
  }

  function safeSpawnPoint() {
    for (let i = 0; i < 60; i += 1) {
      const x = randomInRange(-120, 120);
      const z = randomInRange(-120, 120);
      let blocked = false;
      for (const obstacle of propsNear(worldProps, x, z)) {
        if (!obstacleBlocksPlayer(obstacle, 0)) continue;
        if (pointInsideObstacle(x, z, C.PLAYER_RADIUS, obstacle)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      let nearZombie = false;
      for (const zb of zombies.values()) {
        if (zb.alive && Math.hypot(zb.x - x, zb.z - z) < 28) {
          nearZombie = true;
          break;
        }
      }
      if (!nearZombie) return { x, z };
    }
    return { x: 0, z: 0 };
  }

  function respawnPlayer(player, now) {
    leaveVehicle(player);
    const spawn = safeSpawnPoint();
    player.x = spawn.x;
    player.y = C.PLAYER_EYE_HEIGHT;
    player.z = spawn.z;
    player.vx = 0;
    player.vy = 0;
    player.vz = 0;
    player.health = 100;
    player.alive = true;
    player.respawnAt = 0;
    player.deathAt = 0;
    player.deathTilt = 0;
    player.deathRoll = 0;
    player.reloadingUntil = 0;
    player.crouching = false;
    refillMagazine(player, WEAPONS[player.weapon] || defaultWeapon());
    player.lastDamagedAt = now;
  }

  function makePlayer(id, name, now) {
    const weapon = defaultWeapon();
    const spawn = safeSpawnPoint();
    return {
      id,
      name: String(name || randomSurvivorName()).slice(0, 18),
      x: spawn.x,
      y: C.PLAYER_EYE_HEIGHT,
      z: spawn.z,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      pitch: 0,
      health: 100,
      kills: 0,
      score: 0,
      deaths: 0,
      alive: true,
      respawnAt: 0,
      deathAt: 0,
      deathTilt: 0,
      deathRoll: 0,
      weapon: weapon.key,
      ammoInMag: weapon.magSize,
      magSize: weapon.magSize,
      reloadingUntil: 0,
      lastShotAt: 0,
      lastMeleeAt: 0,
      switchingUntil: 0,
      previousWeapon: weapon.key,
      inVehicle: null,
      vehicleSeat: null,
      crouching: false,
      input: { forward: false, back: false, left: false, right: false, sprint: false, jump: false, crouch: false },
      lastJumpPressed: false,
      lastDamagedAt: now,
      // camping detection
      campRefX: spawn.x,
      campRefZ: spawn.z,
      campCheckAt: now + 20000,
      camping: false,
    };
  }

  function applyMovement(player, dtSec) {
    if (!player.alive || player.inVehicle) return;

    let moveForward = 0;
    let moveSide = 0;
    if (player.input.forward) moveForward += 1;
    if (player.input.back) moveForward -= 1;
    if (player.input.right) moveSide += 1;
    if (player.input.left) moveSide -= 1;

    const mag = Math.hypot(moveForward, moveSide);
    player.crouching = Boolean(player.input.crouch);
    const speed = player.crouching ? 4.1 : player.input.sprint ? 10.6 : 7.5;
    let desiredVx = 0;
    let desiredVz = 0;

    if (mag > 0.001) {
      const normForward = moveForward / mag;
      const normSide = moveSide / mag;
      const sin = Math.sin(player.yaw);
      const cos = Math.cos(player.yaw);
      desiredVx = (-sin * normForward + cos * normSide) * speed;
      desiredVz = (-cos * normForward - sin * normSide) * speed;
    }

    // Just thrown by the dragon (slam / tail / wing gust): the shove carries
    // you for a moment before your own control takes back over.
    const knocked = player.knockedUntil && Date.now() < player.knockedUntil;
    const accelFactor = (1 - Math.exp(-C.PLAYER_ACCEL * dtSec)) * (knocked ? 0.06 : 1);
    player.vx += (desiredVx - player.vx) * accelFactor;
    player.vz += (desiredVz - player.vz) * accelFactor;

    if (mag < 0.001 && !knocked) {
      const drag = Math.exp(-C.PLAYER_GROUND_FRICTION * dtSec);
      player.vx *= drag;
      player.vz *= drag;
      if (Math.abs(player.vx) < 0.01) player.vx = 0;
      if (Math.abs(player.vz) < 0.01) player.vz = 0;
    }

    const eyeHeight = player.crouching ? C.PLAYER_CROUCH_EYE_HEIGHT : C.PLAYER_EYE_HEIGHT;
    const feetY = player.y - eyeHeight;
    const support = supportHeightAt(player.x, player.z, feetY, worldProps);
    const onGround = feetY <= support + 0.03;

    if (player.input.jump && !player.lastJumpPressed && onGround && !player.crouching) {
      player.vy = C.PLAYER_JUMP_VELOCITY;
    }
    player.lastJumpPressed = Boolean(player.input.jump);
    player.vy -= C.PLAYER_GRAVITY * dtSec;
    player.y += player.vy * dtSec;

    let nx = clamp(player.x + player.vx * dtSec, -C.WORLD_HALF_SIZE + C.PLAYER_RADIUS, C.WORLD_HALF_SIZE - C.PLAYER_RADIUS);
    let nz = clamp(player.z + player.vz * dtSec, -C.WORLD_HALF_SIZE + C.PLAYER_RADIUS, C.WORLD_HALF_SIZE - C.PLAYER_RADIUS);

    const curFeet = player.y - eyeHeight;
    for (let i = 0; i < 2; i += 1) {
      for (const obstacle of propsNear(worldProps, nx, nz)) {
        if (!obstacleBlocksPlayer(obstacle, curFeet)) continue;
        if (!pointInsideObstacle(nx, nz, C.PLAYER_RADIUS, obstacle)) continue;
        const resolved = resolveObstacleCollision(nx, nz, C.PLAYER_RADIUS, obstacle);
        nx = resolved.x;
        nz = resolved.z;
      }
    }

    // Vehicles are solid: walk around them, not through.
    ({ x: nx, z: nz } = resolveCircleVsVehicles(nx, nz, C.PLAYER_RADIUS, vehicles, curFeet));
    const newSupport = supportHeightAt(nx, nz, curFeet, worldProps);
    if (player.vy <= 0 && player.y < newSupport + eyeHeight) {
      player.y = newSupport + eyeHeight;
      player.vy = 0;
    }

    player.x = nx;
    player.z = nz;
  }

  function killPlayer(victim, killerName, now) {
    leaveVehicle(victim);
    victim.health = 0;
    victim.alive = false;
    victim.deaths += 1;
    victim.respawnAt = now + RESPAWN_MS;
    victim.deathAt = now;
    victim.deathTilt = randomInRange(-1.2, 1.2);
    victim.deathRoll = randomInRange(-0.6, 0.6);
    victim.reloadingUntil = 0;
    addKillFeed(killerName, victim.name, now);
  }

  // ---- Vehicles ----

  function getVehicleById(id) {
    return vehicles.find((v) => v.id === id) || null;
  }

  function leaveVehicle(player) {
    if (!player?.inVehicle) return;
    const vehicle = getVehicleById(player.inVehicle);
    if (vehicle && (vehicle.driverId === player.id || vehicle.passengerId === player.id)) {
      const isDriver = vehicle.driverId === player.id;
      // Driver bails out the left door, passenger the right.
      const exitYaw = vehicle.yaw + Math.PI * 0.5 * (isDriver ? 1 : -1);
      if (isDriver) {
        vehicle.driverId = null;
        vehicle.engineOn = false;
        vehicle.steer = 0;
      } else {
        vehicle.passengerId = null;
      }
      player.x = clamp(vehicle.x + Math.cos(exitYaw) * VEHICLE_EXIT_OFFSET, -C.WORLD_HALF_SIZE + 1, C.WORLD_HALF_SIZE - 1);
      player.z = clamp(vehicle.z + Math.sin(exitYaw) * VEHICLE_EXIT_OFFSET, -C.WORLD_HALF_SIZE + 1, C.WORLD_HALF_SIZE - 1);
      // Bailing out of a flying vehicle leaves you in the air — gravity does the rest.
      player.y = (vehicle.y || 0) + C.PLAYER_EYE_HEIGHT;
      player.vx = vehicle.vx * 0.15;
      player.vz = vehicle.vz * 0.15;
      player.vy = 0;
    }
    player.inVehicle = null;
    player.vehicleSeat = null;
  }

  function enterNearestVehicle(player, seat = "driver") {
    if (!player.alive) return false;
    if (player.inVehicle) {
      leaveVehicle(player);
      return true;
    }
    let nearest = null;
    let nearestDist = Infinity;
    for (const vehicle of vehicles) {
      if (vehicle.destroyed) continue;
      const dist = Math.hypot(vehicle.x - player.x, vehicle.z - player.z);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = vehicle;
      }
    }
    if (!nearest || nearestDist > VEHICLE_ENTER_RADIUS) return false;
    if (seat === "passenger") {
      if (nearest.passengerId) return false;
      nearest.passengerId = player.id;
    } else {
      if (nearest.driverId) return false;
      nearest.driverId = player.id;
      nearest.engineOn = true;
      player.reloadingUntil = 0;
    }
    player.inVehicle = nearest.id;
    player.vehicleSeat = seat;
    return true;
  }

  /** Riders sit at the vehicle's real seat with a seated hitbox; aim stays free. */
  function syncPlayerToVehicle(player, vehicle, seat = "driver") {
    const hip = seatWorld(vehicle, seat);
    player.x = hip.x;
    player.z = hip.z;
    player.y = hip.y + SEATED_EYE;
    player.vx = vehicle.vx;
    player.vz = vehicle.vz;
    player.vy = vehicle.vy || 0;
    player.crouching = true;
  }

  // Radius + occupant damage when an aircraft goes up. Zombies caught in the
  // blast burn too. Occupants who didn't bail before impact take the worst.
  function onVehicleExplosion(vehicle) {
    const now = Date.now();
    const EXPLOSION_RADIUS = 13;
    structures.applyBlast({ x: vehicle.x, y: (vehicle.y || 0) + 1, z: vehicle.z }, 7, 320, now, null);
    for (const p of players.values()) {
      if (!p.alive) continue;
      let damage = 0;
      if (p.inVehicle === vehicle.id) {
        leaveVehicle(p); // dumped next to the burning wreck
        damage = 95;
      } else {
        const d = Math.hypot(p.x - vehicle.x, p.z - vehicle.z, (p.y - (vehicle.y || 0)) * 0.7);
        if (d < EXPLOSION_RADIUS) damage = 110 * (1 - d / EXPLOSION_RADIUS);
      }
      if (damage > 0) {
        p.health -= damage;
        p.lastDamagedAt = now;
        if (p.health <= 0) killPlayer(p, "Vehicle explosion", now);
      }
    }
    for (const zb of zombies.values()) {
      if (!zb.alive) continue;
      const d = Math.hypot(zb.x - vehicle.x, zb.z - vehicle.z);
      if (d < EXPLOSION_RADIUS) damageZombie(zb, 160 * (1 - d / EXPLOSION_RADIUS), null, "explosion", now);
    }
  }

  function updateVehicles(dtSec, now) {
    updateVehicleFleet(
      {
        vehicles,
        weatherGrip: () => weatherGrip(weather),
        players,
        worldProps,
        clamp,
        pointInsideObstacle,
        resolveObstacleCollision,
        worldHalfSize: C.WORLD_HALF_SIZE,
        propsNear: (x, z) => propsNear(worldProps, x, z),
        active: () => true,
        syncPlayerToVehicle,
        addEvent: addVehicleEvent,
        onVehicleExplosion,
        // Ramming a wall panel hard enough knocks it out (and its neighbours:
        // a vehicle-sized hole) — the car drives on through.
        onVehicleImpact: (obstacle, energy, vehicle, impactNow) => {
          const driver = vehicle.driverId ? players.get(vehicle.driverId) : null;
          const by = driver ? { id: driver.id, name: driver.name } : null;
          const dmg = energy * WALL_RAM_SCALE;
          const broke = structures.damageProp(obstacle, dmg, impactNow, by);
          if (broke) structures.applyBlast({ x: obstacle.x, y: 1, z: obstacle.z }, 3.2, dmg, impactNow, by);
          return broke;
        },
        onRunOverPlayer: (victim, vehicle, driver, speed) => {
          victim.health -= speed * 3.2;
          victim.lastDamagedAt = now;
          if (victim.health <= 0) {
            killPlayer(victim, driver ? `${driver.name} (road kill)` : "Runaway car", now);
          }
        },
        zombies,
        onRunOverZombie: (zb, vehicle, driver, speed) => {
          damageZombie(zb, speed * 4, driver, "roadkill", now);
        },
      },
      dtSec,
      now,
    );
  }

  // --- AI companion (NPC) wiring -------------------------------------------
  // Co-op: every human player is an ally; the zombie horde is the enemy.

  function npcGetPlayerById(id) {
    return players.get(id) || null;
  }

  function npcGetAllies() {
    const out = [];
    for (const p of players.values()) if (p.alive) out.push(p);
    return out;
  }

  function npcGetHostiles() {
    const now = Date.now();
    const out = [];
    for (const zb of zombies.values()) {
      if (zb.alive && now >= (zb.emergingUntil || 0)) out.push(zb);
    }
    const dragon = dragonEvent.hostile();
    if (dragon) out.push(dragon);
    const champ = bossEvent.hostile();
    if (champ) out.push(champ);
    return out;
  }

  function npcHasLineOfSight(ax, ay, az, bx, by, bz) {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz) || 1;
    const dir = { x: dx / len, y: dy / len, z: dz / len };
    for (const ob of propsAlongSegment(worldProps, ax, az, bx, bz)) {
      if (ob.collidable === false) continue;
      const d = rayAabbDistance({ x: ax, y: ay, z: az }, dir, ob);
      if (d != null && d > 0 && d < len - 0.2) return false;
    }
    return true;
  }

  function npcHealPlayer(player, amount) {
    if (!player || !player.alive) return;
    if (player.healBlockedUntil && Date.now() < player.healBlockedUntil) return;
    player.health = Math.min(100, player.health + amount);
  }

  function npcEmitTracer(fromId, origin, dir, distance, hitId, weaponKey) {
    const hit = hitId ? { zombieId: hitId } : null;
    addShotEvent(fromId, origin, dir, distance, hit, Date.now(), weaponKey || "rifle");
  }

  function npcApplyDamage(target, amount, npc) {
    const now = Date.now();
    if (target && target.isDragon) {
      dragonEvent.damage(amount, players.get(npc.ownerId) || null, "body", now);
      return;
    }
    if (target && target.isBoss) {
      bossEvent.damage(amount, players.get(npc.ownerId) || null, "body", now);
      return;
    }
    if (target && target.cfg !== undefined) {
      // Zombie: credit the companion's owner with the kill/score.
      const owner = players.get(npc.ownerId) || null;
      damageZombie(target, amount, owner, "companion", now);
    }
  }

  /** A walkable spot anywhere on the map for the roaming recruit beacon. */
  function randomRecruitSpot() {
    const R = C.WORLD_HALF_SIZE * 0.85;
    for (let i = 0; i < 60; i += 1) {
      const x = (Math.random() * 2 - 1) * R;
      const z = (Math.random() * 2 - 1) * R;
      let blocked = false;
      for (const ob of propsNear(worldProps, x, z)) {
        if (obstacleBlocksPlayer(ob, 0) && pointInsideObstacle(x, z, 1, ob)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) return { x, z };
    }
    return { x: 0, z: 0 };
  }

  const npcEnv = {
    npcs,
    allowRoles: ["healer", "attacker", "defender", "summoner"],
    randomRecruitSpot,
    worldProps,
    worldHalfSize: C.WORLD_HALF_SIZE,
    clamp,
    pointInsideObstacle,
    obstacleBlocksPlayer,
    supportHeightAt,
    propsNear,
    resolveObstacleCollision,
    active: () => true,
    getPlayerById: npcGetPlayerById,
    getAllies: npcGetAllies,
    getHostiles: npcGetHostiles,
    hasLineOfSight: npcHasLineOfSight,
    applyDamage: npcApplyDamage,
    healPlayer: npcHealPlayer,
    emitTracer: npcEmitTracer,
    addEvent: addVehicleEvent,
  };

  // The roaming recruit point (one for everyone; party of up to 4 per player).
  const recruitBeacon = createRecruitBeacon(npcEnv);

  function updateNpcs(dtSec) {
    updateNpcFleet(npcEnv, dtSec, Date.now());
    updateRecruitBeacon(npcEnv, recruitBeacon, dtSec, Date.now());
  }

  // Active defender domes for this tick (refreshed at the top of updateZombies).
  // Hostiles are pushed out of these and cannot damage anyone standing inside.
  let activeShields = [];
  function pointShielded(x, z) {
    for (const s of activeShields) {
      if (Math.hypot(x - s.x, z - s.z) < s.radius) return true;
    }
    return false;
  }

  /** Zombies chew on any active companion they're standing next to. */
  function zombiesDamageNpcs(dtSec, now) {
    for (const npc of npcs) {
      if (npc.state !== "active") continue;
      if (pointShielded(npc.x, npc.z)) continue; // safe inside a defender dome
      for (const zb of zombies.values()) {
        if (!zb.alive || now < (zb.emergingUntil || 0)) continue;
        const reach = (zb.cfg?.attackRange || 1.6) + 0.7;
        if (Math.hypot(zb.x - npc.x, zb.z - npc.z) > reach) continue;
        damageNpc(npcEnv, npc, (zb.cfg?.damage || 8) * 0.9 * dtSec, now);
        if (npc.state !== "active") break;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Zombies
  // ---------------------------------------------------------------------

  function zombieBlocked(obstacle, feetY, cfg) {
    if (obstacle.collidable === false) return false;
    const base = obstacle.py || 0;
    const top = base + obstacle.sy;
    const step = cfg.key === "crawler" ? 0.45 : C.PLAYER_STEP_HEIGHT;
    if (top <= feetY + step) return false;
    if (base >= feetY + cfg.height - 0.1) return false;
    return true;
  }

  function spotBlockedForSpawn(x, z) {
    for (const obstacle of propsNear(worldProps, x, z)) {
      if (!obstacleBlocksPlayer(obstacle, 0)) continue;
      if (pointInsideObstacle(x, z, 0.6, obstacle)) return true;
    }
    return false;
  }

  function pickSpawnPoint(anchor, behind = false) {
    for (let i = 0; i < 24; i += 1) {
      let angle;
      if (behind && anchor.yaw !== undefined) {
        // behind the player's facing direction +/- 45 deg
        angle = anchor.yaw + Math.PI + randomInRange(-0.8, 0.8);
        // convert camera yaw to world angle of forward vector, then invert:
        // forward is (-sin(yaw), -cos(yaw)); behind is (sin(yaw), cos(yaw)).
        angle = Math.atan2(Math.sin(anchor.yaw), Math.cos(anchor.yaw)) + randomInRange(-0.8, 0.8);
      } else {
        angle = Math.random() * Math.PI * 2;
      }
      // Mid-range ring: close enough to reach the player quickly, far enough
      // that they don't materialize in view.
      const dist = randomInRange(30, 55);
      const x = clamp(anchor.x + Math.cos(angle) * dist, -C.WORLD_HALF_SIZE + 4, C.WORLD_HALF_SIZE - 4);
      const z = clamp(anchor.z + Math.sin(angle) * dist, -C.WORLD_HALF_SIZE + 4, C.WORLD_HALF_SIZE - 4);
      if (spotBlockedForSpawn(x, z)) continue;
      let tooClose = false;
      for (const p of players.values()) {
        if (p.alive && Math.hypot(p.x - x, p.z - z) < 24) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) return { x, z };
    }
    return null;
  }

  function assignRole() {
    const r = Math.random();
    if (r < 0.7) return "direct";
    if (r < 0.8) return "flankL";
    if (r < 0.9) return "flankR";
    return "cutoff";
  }

  function spawnZombie(typeKey, pos, now, boss = false) {
    if (zombies.size >= MAX_ZOMBIES) return null;
    const cfg = ZOMBIE_TYPES[typeKey] || ZOMBIE_TYPES.walker;
    zombieSeq += 1;
    const hpMult = boss ? 2.2 : 1;
    const zb = {
      id: `z${zombieSeq}`,
      type: typeKey,
      cfg,
      boss,
      // Every spawn digs itself out of the ground; flyers take off after.
      emergingUntil: now + EMERGE_MS,
      // The boss always summons; ~10% of regular zombies learned the trick.
      canSummon: boss || Math.random() < 0.1,
      summonCooldownUntil: now + 12000,
      dodgeUntil: 0,
      dodgeCooldownUntil: 0,
      dodgeSign: 1,
      x: pos.x,
      z: pos.z,
      y: supportHeightAt(pos.x, pos.z, 0, worldProps),
      vy: 0,
      yaw: Math.random() * Math.PI * 2,
      health: cfg.hp * hpMult,
      maxHealth: cfg.hp * hpMult,
      state: "idle",
      role: assignRole(),
      targetId: null,
      lastKnown: null,
      lostSightAt: 0,
      searchUntil: 0,
      idleUntil: now + randomInRange(500, 3000),
      patrolPoint: null,
      nextThinkAt: now + Math.random() * 400,
      lastAttackAt: 0,
      attackWindupAt: 0,
      screamCooldownUntil: 0,
      screamingUntil: 0,
      leapCooldownUntil: 0,
      leapingUntil: 0,
      stuckCheckAt: now + 1200,
      stuckRefX: pos.x,
      stuckRefZ: pos.z,
      detourUntil: 0,
      detourSign: 1,
      alive: true,
      deathAt: 0,
      spawnedAt: now,
    };
    zombies.set(zb.id, zb);
    addZombieEvent("emerge", zb.x, zb.z, now, { boss });
    return zb;
  }

  function waveComposition(n, isNight) {
    let count = Math.round((8 + n * 4) * (isNight ? 2 : 1) * difficulty.spawnMult * dayGrowthMult(Date.now()));
    count = Math.max(4, Math.min(count, MAX_ZOMBIES - zombies.size));
    const types = [];
    const runnerShare = n >= 2 ? 0.2 + difficulty.runnerBias : 0;
    const crawlerShare = n >= 3 ? 0.12 : 0;
    const screamerShare = n >= 3 ? 0.08 : 0;
    // Bigger airborne threat: flyers arrive a wave earlier and make up a much
    // larger slice of the horde than before (was 0.1 from wave 3).
    const flyerShare = n >= 2 ? 0.22 : 0;
    const jumperShare = n >= 4 ? 0.1 : 0;
    const tankCount = n >= 4 ? 1 + Math.floor(n / 6) : 0;

    for (let i = 0; i < count; i += 1) {
      const r = Math.random();
      let acc = runnerShare;
      if (r < acc) {
        types.push("runner");
        continue;
      }
      if (r < (acc += crawlerShare)) {
        types.push("crawler");
        continue;
      }
      if (r < (acc += screamerShare)) {
        types.push("screamer");
        continue;
      }
      if (r < (acc += flyerShare)) {
        types.push("flyer");
        continue;
      }
      if (r < (acc += jumperShare)) {
        types.push("jumper");
        continue;
      }
      types.push("walker");
    }
    for (let i = 0; i < tankCount; i += 1) types.push("tank");
    return types;
  }

  function spawnWave(now) {
    const alivePlayers = Array.from(players.values()).filter((p) => p.alive);
    if (alivePlayers.length === 0) return;
    waveNumber += 1;
    // Every 10th wave the sky tears open instead (dragon-system.js).
    if (waveNumber % 10 === 0 && dragonEvent.start(now)) {
      waveActive = true;
      addZombieEvent("wave", 0, 0, now, { wave: waveNumber, rift: true });
      return;
    }
    // Waves 5, 15, 25...: a champion steps onto the field (boss-system.js).
    if (waveNumber % 10 === 5 && bossEvent.start(bossEvent.kindForWave(waveNumber), now)) {
      waveActive = true;
      addZombieEvent("wave", 0, 0, now, { wave: waveNumber, champion: true });
      return;
    }
    const { isNight } = cycleInfo(now);
    const types = waveComposition(waveNumber, isNight);
    const isBossWave = waveNumber % 5 === 0;

    for (const typeKey of types) {
      const anchor = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
      const pos = pickSpawnPoint(anchor, anchor.camping);
      if (!pos) continue;
      const zb = spawnZombie(typeKey, pos, now);
      // Wave zombies have caught the scent: converge on the player's rough
      // position (with scatter) until their own senses take over.
      if (zb) {
        zb.lastKnown = { x: anchor.x + randomInRange(-9, 9), z: anchor.z + randomInRange(-9, 9) };
        zb.state = "investigate";
      }
    }
    if (isBossWave) {
      const anchor = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
      const pos = pickSpawnPoint(anchor);
      if (pos) {
        const boss = spawnZombie("tank", pos, now, true);
        if (boss) {
          boss.lastKnown = { x: anchor.x, z: anchor.z };
          boss.state = "investigate";
          // Announce the boss with its exact spawn location.
          addZombieEvent("boss", boss.x, boss.z, now, { wave: waveNumber });
        }
      }
    }
    waveActive = true;
    addZombieEvent("wave", 0, 0, now, { wave: waveNumber });
  }

  function ambientSpawn(now, isNight) {
    const alivePlayers = Array.from(players.values()).filter((p) => p.alive);
    if (alivePlayers.length === 0) return;
    const spawnCount = Math.round((isNight ? 3 : 2) * dayGrowthMult(now));
    for (let i = 0; i < spawnCount; i += 1) {
      if (zombies.size >= MAX_ZOMBIES - 4) return;
      const anchor = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
      const pos = pickSpawnPoint(anchor, anchor.camping);
      if (!pos) continue;
      // Once flyers have entered the rotation, a share of ambient spawns are
      // airborne too, so the sky threat persists between waves.
      const roll = Math.random();
      let typeKey;
      if (waveNumber >= 2 && roll < 0.18) typeKey = "flyer";
      else if (roll < 0.18 + 0.25 + difficulty.runnerBias) typeKey = "runner";
      else typeKey = "walker";
      spawnZombie(typeKey, pos, now);
    }
  }

  // ---- Senses ----

  function hasLineOfSight(fromX, fromY, fromZ, toX, toY, toZ) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const dz = toZ - fromZ;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.001) return true;
    const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
    const origin = { x: fromX, y: fromY, z: fromZ };
    for (const obstacle of propsAlongSegment(worldProps, fromX, fromZ, toX, toZ)) {
      if (obstacle.collidable === false) continue;
      const d = rayAabbDistance(origin, dir, obstacle);
      if (d !== null && d > 0.01 && d < dist - 0.2) return false;
    }
    return true;
  }

  function senseTarget(zb, now, night) {
    const cfg = zb.cfg;
    const visionRange = cfg.vision * (night ? 1.3 : 1);
    let best = null;
    let bestDist = Infinity;
    for (const p of players.values()) {
      if (!p.alive) continue; // players in vehicles are fair game too
      const dist = Math.hypot(p.x - zb.x, p.z - zb.z);
      if (dist > visionRange) continue;
      // Vision cone (~100 deg) unless target is very close.
      if (dist > 4) {
        const fx = -Math.sin(zb.yaw);
        const fz = -Math.cos(zb.yaw);
        const dot = ((p.x - zb.x) / dist) * fx + ((p.z - zb.z) / dist) * fz;
        if (dot < 0.17) continue;
      }
      if (!hasLineOfSight(zb.x, zb.y + cfg.height * 0.85, zb.z, p.x, p.y, p.z)) continue;
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    return best;
  }

  function hearNoise(zb, night) {
    const mult = zb.cfg.hearing * (night ? 1.4 : 1);
    let best = null;
    let bestScore = 0;
    for (const noise of noiseEvents) {
      const dist = Math.hypot(noise.x - zb.x, noise.z - zb.z);
      const reach = noise.loud * mult;
      if (dist > reach) continue;
      const score = reach - dist;
      if (score > bestScore) {
        bestScore = score;
        best = noise;
      }
    }
    return best;
  }

  function scream(zb, target, now) {
    zb.screamingUntil = now + 1000;
    zb.screamCooldownUntil = now + 14000;
    addZombieEvent("scream", zb.x, zb.z, now);
    for (const other of zombies.values()) {
      if (!other.alive || other.id === zb.id) continue;
      if (Math.hypot(other.x - zb.x, other.z - zb.z) > 42) continue;
      other.lastKnown = { x: target.x, z: target.z };
      if (other.state === "idle" || other.state === "patrol" || other.state === "search") {
        other.state = "investigate";
      }
    }
  }

  // ---- Think (state transitions) ----

  function summonReinforcements(zb, target, now) {
    zb.summonCooldownUntil = now + (zb.boss ? 16000 : 32000);
    addZombieEvent("summon", zb.x, zb.z, now, { boss: zb.boss });
    const count = zb.boss ? 4 : 3;
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const dist = randomInRange(4.5, 9.5);
      const sx = clamp(target.x + Math.cos(angle) * dist, -C.WORLD_HALF_SIZE + 4, C.WORLD_HALF_SIZE - 4);
      const sz = clamp(target.z + Math.sin(angle) * dist, -C.WORLD_HALF_SIZE + 4, C.WORLD_HALF_SIZE - 4);
      if (spotBlockedForSpawn(sx, sz)) continue;
      const minion = spawnZombie(Math.random() < 0.3 ? "runner" : "walker", { x: sx, z: sz }, now);
      if (minion) {
        minion.canSummon = false; // no chain summons
        minion.lastKnown = { x: target.x, z: target.z };
        minion.state = "investigate";
      }
    }
  }

  function think(zb, now, night) {
    const cfg = zb.cfg;

    // Summoners call the horde down on their prey.
    if (
      zb.canSummon &&
      (zb.state === "chase" || zb.state === "attack") &&
      now > zb.summonCooldownUntil &&
      zombies.size < MAX_ZOMBIES - 5
    ) {
      const target = zb.targetId ? players.get(zb.targetId) : null;
      if (target && target.alive) summonReinforcements(zb, target, now);
    }

    const seen = senseTarget(zb, now, night);

    if (seen) {
      zb.targetId = seen.id;
      zb.lastKnown = { x: seen.x, z: seen.z };
      zb.lostSightAt = 0;
      if (cfg.key === "screamer" && now > zb.screamCooldownUntil) scream(zb, seen, now);
      const dist = Math.hypot(seen.x - zb.x, seen.z - zb.z);
      zb.state = dist <= cfg.attackRange + 0.15 ? "attack" : "chase";
      return;
    }

    if (zb.state === "chase" || zb.state === "attack") {
      const target = zb.targetId ? players.get(zb.targetId) : null;
      if (target && target.alive) {
        const dist = Math.hypot(target.x - zb.x, target.z - zb.z);
        // Memory: keep chasing the last known position for a while after
        // losing sight, then switch to searching it.
        if (dist < 6) {
          zb.lastKnown = { x: target.x, z: target.z };
          zb.state = dist <= cfg.attackRange + 0.15 ? "attack" : "chase";
          return;
        }
        if (!zb.lostSightAt) zb.lostSightAt = now;
        if (now - zb.lostSightAt < 3500) {
          zb.state = "chase";
          return;
        }
      }
      zb.targetId = null;
      if (zb.lastKnown) {
        zb.state = "investigate";
        return;
      }
      zb.state = "patrol";
      return;
    }

    const noise = hearNoise(zb, night);
    if (noise && (zb.state === "idle" || zb.state === "patrol" || zb.state === "search")) {
      zb.lastKnown = { x: noise.x, z: noise.z };
      zb.state = "investigate";
      return;
    }

    if (zb.state === "investigate" && zb.lastKnown) {
      const dist = Math.hypot(zb.lastKnown.x - zb.x, zb.lastKnown.z - zb.z);
      if (dist < 2.2) {
        zb.state = "search";
        zb.searchUntil = now + 5000;
      }
      return;
    }

    if (zb.state === "search") {
      if (now > zb.searchUntil) {
        zb.state = "patrol";
        zb.lastKnown = null;
        zb.patrolPoint = null;
      }
      return;
    }

    if (zb.state === "idle") {
      if (now > zb.idleUntil) {
        zb.state = "patrol";
        zb.patrolPoint = null;
      }
      return;
    }

    if (zb.state === "patrol" && !zb.patrolPoint) {
      const angle = Math.random() * Math.PI * 2;
      const dist = randomInRange(8, 26);
      zb.patrolPoint = {
        x: clamp(zb.x + Math.cos(angle) * dist, -C.WORLD_HALF_SIZE + 4, C.WORLD_HALF_SIZE - 4),
        z: clamp(zb.z + Math.sin(angle) * dist, -C.WORLD_HALF_SIZE + 4, C.WORLD_HALF_SIZE - 4),
      };
    }
  }

  // ---- Movement (steering + separation + obstacle slide + stuck detour) ----

  const separationGrid = new Map();

  function rebuildSeparationGrid() {
    separationGrid.clear();
    for (const zb of zombies.values()) {
      if (!zb.alive) continue;
      const key = `${Math.floor(zb.x / 4)},${Math.floor(zb.z / 4)}`;
      let cell = separationGrid.get(key);
      if (!cell) {
        cell = [];
        separationGrid.set(key, cell);
      }
      cell.push(zb);
    }
  }

  function separationForce(zb) {
    let fx = 0;
    let fz = 0;
    const cx = Math.floor(zb.x / 4);
    const cz = Math.floor(zb.z / 4);
    for (let gx = cx - 1; gx <= cx + 1; gx += 1) {
      for (let gz = cz - 1; gz <= cz + 1; gz += 1) {
        const cell = separationGrid.get(`${gx},${gz}`);
        if (!cell) continue;
        for (const other of cell) {
          if (other.id === zb.id) continue;
          const dx = zb.x - other.x;
          const dz = zb.z - other.z;
          const dist = Math.hypot(dx, dz);
          const minDist = zb.cfg.radius + other.cfg.radius + 0.25;
          if (dist > minDist || dist < 1e-5) continue;
          const push = (minDist - dist) / minDist;
          fx += (dx / dist) * push;
          fz += (dz / dist) * push;
        }
      }
    }
    return { fx, fz };
  }

  function chaseTargetPoint(zb, target) {
    // Flanking roles offset the pursuit point so hordes surround instead of
    // forming a single-file line.
    const dx = target.x - zb.x;
    const dz = target.z - zb.z;
    const dist = Math.hypot(dx, dz) || 1e-5;
    if (zb.role === "cutoff") {
      return { x: target.x + (target.vx || 0) * 1.6, z: target.z + (target.vz || 0) * 1.6 };
    }
    if ((zb.role === "flankL" || zb.role === "flankR") && dist > 6) {
      const side = zb.role === "flankL" ? 1 : -1;
      const offset = Math.min(12, dist * 0.5);
      // Perpendicular to the direction toward the player.
      const px = (-dz / dist) * offset * side;
      const pz = (dx / dist) * offset * side;
      return { x: target.x + px, z: target.z + pz };
    }
    return { x: target.x, z: target.z };
  }

  function moveZombie(zb, dtSec, now, night) {
    const cfg = zb.cfg;
    let goal = null;
    let speed = 0;

    if (zb.state === "patrol" && zb.patrolPoint) {
      goal = zb.patrolPoint;
      speed = cfg.speed * 0.8;
      if (Math.hypot(goal.x - zb.x, goal.z - zb.z) < 1.6) {
        zb.patrolPoint = null;
        zb.state = "idle";
        zb.idleUntil = now + randomInRange(1500, 5000);
        goal = null;
      }
    } else if (zb.state === "investigate" && zb.lastKnown) {
      goal = zb.lastKnown;
      speed = cfg.speed * 1.15;
    } else if (zb.state === "search") {
      if (!zb.patrolPoint || Math.hypot(zb.patrolPoint.x - zb.x, zb.patrolPoint.z - zb.z) < 1.4) {
        const base = zb.lastKnown || zb;
        zb.patrolPoint = {
          x: clamp(base.x + randomInRange(-7, 7), -C.WORLD_HALF_SIZE + 4, C.WORLD_HALF_SIZE - 4),
          z: clamp(base.z + randomInRange(-7, 7), -C.WORLD_HALF_SIZE + 4, C.WORLD_HALF_SIZE - 4),
        };
      }
      goal = zb.patrolPoint;
      speed = cfg.speed * 0.9;
    } else if (zb.state === "chase") {
      const target = zb.targetId ? players.get(zb.targetId) : null;
      if (target && target.alive) {
        goal = chaseTargetPoint(zb, target);
      } else if (zb.lastKnown) {
        goal = zb.lastKnown;
      }
      speed = cfg.chaseSpeed * (night ? 1.12 : 1);

      // Jumper leap: ballistic lunge that clears window sills and fences.
      if (cfg.key === "jumper" && target && now > zb.leapCooldownUntil && now > zb.leapingUntil) {
        const dist = Math.hypot(target.x - zb.x, target.z - zb.z);
        if (dist > 5 && dist < 11 && hasLineOfSight(zb.x, zb.y + 1.4, zb.z, target.x, target.y, target.z)) {
          zb.leapingUntil = now + 700;
          zb.leapCooldownUntil = now + 4200;
          zb.vy = 6.4;
          addZombieEvent("leap", zb.x, zb.z, now);
        }
      }
    } else if (zb.state === "attack") {
      const target = zb.targetId ? players.get(zb.targetId) : null;
      if (target) {
        zb.yaw = Math.atan2(-(target.x - zb.x), -(target.z - zb.z));
        // Flyers must actually dive down to bite; include height in reach.
        const dist = cfg.flying
          ? Math.hypot(target.x - zb.x, target.z - zb.z, Math.max(0, zb.y - target.y))
          : Math.hypot(target.x - zb.x, target.z - zb.z);
        const inCar = target.inVehicle ? getVehicleById(target.inVehicle) : null;
        const effRange = cfg.attackRange + (inCar ? 1.9 : 0); // car body is wide
        if (dist > effRange + 0.3) zb.state = "chase";
        // A target standing inside a defender dome takes no damage.
        else if (!pointShielded(target.x, target.z) && now - zb.lastAttackAt > cfg.attackMs) {
          zb.lastAttackAt = now;
          const dmg = cfg.damage * (zb.boss ? 1.4 : 1);
          addZombieEvent("attack", zb.x, zb.z, now);
          if (inCar && inCar.health > 0) {
            // Pound on the car: the vehicle soaks the damage.
            inCar.health = Math.max(0, inCar.health - dmg * 0.9);
          } else {
            // On foot — or the wreck no longer protects them.
            target.health -= inCar ? dmg * 0.5 : dmg;
            target.lastDamagedAt = now;
            if (target.health <= 0) {
              killPlayer(target, zb.boss ? "Tank Boss" : `${cfg.key[0].toUpperCase()}${cfg.key.slice(1)} zombie`, now);
            }
          }
        }
      } else {
        zb.state = "patrol";
      }
      goal = null;
      speed = 0;
    }

    const leaping = now < zb.leapingUntil;
    let vx = 0;
    let vz = 0;
    if (goal) {
      let dx = goal.x - zb.x;
      let dz = goal.z - zb.z;
      const dist = Math.hypot(dx, dz) || 1e-5;

      // Stuck detour: veer sideways for a moment when progress stalls.
      if (now < zb.detourUntil) {
        const px = (-dz / dist) * zb.detourSign;
        const pz = (dx / dist) * zb.detourSign;
        dx = dx / dist + px * 1.4;
        dz = dz / dist + pz * 1.4;
      } else {
        dx /= dist;
        dz /= dist;
      }

      const sep = separationForce(zb);
      vx = (dx + sep.fx * 1.5) * speed;
      vz = (dz + sep.fz * 1.5) * speed;
      if (leaping) {
        vx = dx * Math.max(speed, 7.5);
        vz = dz * Math.max(speed, 7.5);
      }
      // Bullet-dodge: hard lateral juke that briefly overrides pursuit. Flyers
      // and smart runners both use this (runners get the sidestep, not the
      // vertical component, which only matters airborne).
      if (now < zb.dodgeUntil) {
        vx += zb.dodgeVx || 0;
        vz += zb.dodgeVz || 0;
      }

      const targetYaw = Math.atan2(-vx, -vz);
      let yawDiff = targetYaw - zb.yaw;
      while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
      while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
      zb.yaw += yawDiff * Math.min(1, dtSec * 7);
    }

    let nx = clamp(zb.x + vx * dtSec, -C.WORLD_HALF_SIZE + 2, C.WORLD_HALF_SIZE - 2);
    let nz = clamp(zb.z + vz * dtSec, -C.WORLD_HALF_SIZE + 2, C.WORLD_HALF_SIZE - 2);

    // Defender dome: shove the zombie back to the boundary if it tried to cross
    // in. Allies are unaffected — only hostiles consult activeShields.
    for (const s of activeShields) {
      const sdx = nx - s.x;
      const sdz = nz - s.z;
      const sd = Math.hypot(sdx, sdz) || 1e-3;
      if (sd < s.radius) {
        nx = s.x + (sdx / sd) * s.radius;
        nz = s.z + (sdz / sd) * s.radius;
      }
    }

    if (cfg.flying) {
      // Airborne: hover above the terrain, swoop down at prey, jink when dodging.
      const ground = supportHeightAt(nx, nz, zb.y, worldProps);
      const target = zb.targetId ? players.get(zb.targetId) : null;
      let targetY = ground + cfg.hoverHeight;
      if (target && (zb.state === "attack" || (zb.state === "chase" && Math.hypot(target.x - zb.x, target.z - zb.z) < 7.5))) {
        targetY = Math.max(ground + 0.6, target.y - 0.1); // dive to head height
      }
      if (now < zb.dodgeUntil) targetY += zb.dodgeDy || 0;
      zb.y += (targetY - zb.y) * Math.min(1, dtSec * 3.4);
      zb.vy = 0;
      zb.x = nx;
      zb.z = nz;
    } else {
      // Vertical: gravity + walkable-support snapping (stairs, terraces).
      zb.vy -= C.PLAYER_GRAVITY * dtSec;
      zb.y += zb.vy * dtSec;

      for (let i = 0; i < 2; i += 1) {
        for (const obstacle of propsNear(worldProps, nx, nz)) {
          if (leaping && (obstacle.py || 0) + obstacle.sy <= zb.y + 0.4) continue;
          if (!zombieBlocked(obstacle, zb.y, cfg)) continue;
          if (!pointInsideObstacle(nx, nz, cfg.radius, obstacle)) continue;
          const resolved = resolveObstacleCollision(nx, nz, cfg.radius, obstacle);
          nx = resolved.x;
          nz = resolved.z;
        }
      }

      const support = supportHeightAt(nx, nz, zb.y, worldProps);
      if (zb.vy <= 0 && zb.y < support) {
        zb.y = support;
        zb.vy = 0;
      }

      zb.x = nx;
      zb.z = nz;
    }

    // Stuck detection while pursuing.
    if (now >= zb.stuckCheckAt) {
      if ((zb.state === "chase" || zb.state === "investigate") &&
          Math.hypot(zb.x - zb.stuckRefX, zb.z - zb.stuckRefZ) < 0.3) {
        zb.detourUntil = now + 850;
        zb.detourSign = Math.random() < 0.5 ? 1 : -1;
      }
      zb.stuckRefX = zb.x;
      zb.stuckRefZ = zb.z;
      zb.stuckCheckAt = now + 1100;
    }
  }

  function damageZombie(zb, amount, attacker, part, now) {
    if (!zb.alive) return;
    zb.health -= amount;
    if (zb.health <= 0) {
      zb.alive = false;
      zb.deathAt = now;
      if (attacker) {
        attacker.kills += 1;
        attacker.score += zb.cfg.score * (zb.boss ? 3 : 1);
        difficulty.recentKills.push(now);
        if (zb.boss) addKillFeed(attacker.name, "TANK BOSS", now);
      }
    } else if (zb.state === "idle" || zb.state === "patrol" || zb.state === "search") {
      // Getting shot reveals the attacker's rough position.
      if (attacker) {
        zb.lastKnown = { x: attacker.x, z: attacker.z };
        zb.state = "investigate";
      }
    }
  }

  // Horde manager: LOD think/move frequency by distance to the nearest player.
  function updateZombies(dtSec, now) {
    const { isNight, factor } = cycleInfo(now);
    const night = factor > 0.5;
    rebuildSeparationGrid();
    activeShields = getActiveShields(npcs, now); // defender domes to keep zombies out of

    const alivePlayers = Array.from(players.values()).filter((p) => p.alive);

    for (const zb of zombies.values()) {
      if (!zb.alive) {
        if (now - zb.deathAt > 2600) zombies.delete(zb.id);
        continue;
      }

      // Caught in a rift / the dragon's maw: dragon-system moves it.
      if (zb.pulled) continue;
      // Still clawing out of the ground: helpless but shootable.
      if (now < zb.emergingUntil) continue;

      let nearest = Infinity;
      for (const p of alivePlayers) {
        const dist = Math.hypot(p.x - zb.x, p.z - zb.z);
        if (dist < nearest) nearest = dist;
      }

      // LOD tiers: near = think every 250ms + move every tick;
      // mid = think 700ms + move every tick; far = think/move ~2s (drift);
      // very far = sleep.
      let thinkInterval;
      let moves = true;
      if (nearest < 70) thinkInterval = 250;
      else if (nearest < 150) thinkInterval = 700;
      else if (nearest < 260) {
        thinkInterval = 2000;
        moves = zb.state !== "idle";
      } else {
        thinkInterval = 4000;
        moves = false;
      }

      if (now >= zb.nextThinkAt) {
        zb.nextThinkAt = now + thinkInterval * (0.85 + Math.random() * 0.3);
        think(zb, now, night);
      }
      if (moves) moveZombie(zb, dtSec, now, night);
    }
  }

  // ---------------------------------------------------------------------
  // Bullets (players shoot zombies and each other's zombies only)
  // ---------------------------------------------------------------------

  function spawnBullet(shooter, weapon, now) {
    const moveSpeed = Math.hypot(shooter.vx || 0, shooter.vz || 0);
    const spread =
      (weapon.baseSpread || 0) +
      moveSpeed * (weapon.moveSpreadPerSpeed || 0) +
      (shooter.input.sprint ? weapon.sprintSpread || 0 : 0);
    const shotYaw = shooter.yaw + (Math.random() * 2 - 1) * spread;
    const shotPitch = clamp(shooter.pitch + (Math.random() * 2 - 1) * spread * 0.9, -1.3, 1.25);

    const cosPitch = Math.cos(shotPitch);
    const dirX = -Math.sin(shotYaw) * cosPitch;
    const dirY = Math.sin(shotPitch);
    const dirZ = -Math.cos(shotYaw) * cosPitch;

    const rightX = Math.cos(shooter.yaw);
    const rightZ = -Math.sin(shooter.yaw);
    const origin = { x: shooter.x + rightX * 0.2, y: shooter.y - 0.14, z: shooter.z + rightZ * 0.2 };

    bulletSeq += 1;
    bullets.set(bulletSeq, {
      id: bulletSeq,
      shooterId: shooter.id,
      weaponKey: weapon.key,
      damage: weapon.damage,
      headMultiplier: weapon.headMultiplier || 2,
      maxRange: weapon.range,
      travel: 0,
      radius: weapon.bulletRadius,
      gravity: weapon.bulletGravity,
      x: origin.x + dirX * 0.8,
      y: origin.y + dirY * 0.8,
      z: origin.z + dirZ * 0.8,
      vx: dirX * weapon.muzzleSpeed,
      vy: dirY * weapon.muzzleSpeed,
      vz: dirZ * weapon.muzzleSpeed,
      spawnedAt: now,
    });
    if (bullets.size > MAX_ACTIVE_BULLETS) {
      bullets.delete(bullets.keys().next().value);
    }
  }

  function segmentZombieHit(from, to, zb, bulletRadius) {
    // Cheap capsule test: closest point on segment (XZ) to the zombie axis,
    // classified by height band.
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const lenSq = dx * dx + dz * dz;
    const t = lenSq > 1e-9 ? clamp(((zb.x - from.x) * dx + (zb.z - from.z) * dz) / lenSq, 0, 1) : 0;
    const cx = from.x + dx * t;
    const cy = from.y + (to.y - from.y) * t;
    const cz = from.z + dz * t;
    const horiz = Math.hypot(cx - zb.x, cz - zb.z);
    const cfg = zb.cfg;
    if (horiz > cfg.radius + bulletRadius + 0.1) return null;
    const rel = cy - zb.y;
    if (rel < -0.1 || rel > cfg.height + 0.15) return null;
    let part = "body";
    let mult = 1;
    if (rel > cfg.height * 0.78) {
      part = "head";
      mult = 2.2;
    } else if (rel < cfg.height * 0.32 && cfg.key !== "crawler") {
      part = "legs";
      mult = 0.7;
    }
    return { t, part, mult };
  }

  function simulateBullets(dtSec, now) {
    for (const bullet of bullets.values()) {
      const from = { x: bullet.x, y: bullet.y, z: bullet.z };
      bullet.vy -= bullet.gravity * dtSec;
      bullet.x += bullet.vx * dtSec;
      bullet.y += bullet.vy * dtSec;
      bullet.z += bullet.vz * dtSec;
      const to = { x: bullet.x, y: bullet.y, z: bullet.z };
      const segmentLen = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
      bullet.travel += segmentLen;

      if (
        bullet.travel >= bullet.maxRange ||
        now - bullet.spawnedAt >= BULLET_MAX_LIFETIME_MS ||
        Math.abs(bullet.x) > C.WORLD_HALF_SIZE + 2 ||
        Math.abs(bullet.z) > C.WORLD_HALF_SIZE + 2 ||
        bullet.y < 0.05
      ) {
        addBulletTrail(bullet.shooterId, bullet.weaponKey, now, from, to, null);
        bullets.delete(bullet.id);
        continue;
      }

      // Obstacles.
      let obstacleT = Infinity;
      let obstacleProp = null;
      const dir = segmentLen > 1e-6
        ? { x: (to.x - from.x) / segmentLen, y: (to.y - from.y) / segmentLen, z: (to.z - from.z) / segmentLen }
        : null;
      if (dir) {
        for (const obstacle of propsAlongSegment(worldProps, from.x, from.z, to.x, to.z)) {
          if (obstacle.collidable === false) continue;
          const d = rayAabbDistance(from, dir, obstacle);
          if (d === null || d < 0 || d > segmentLen) continue;
          if (d < obstacleT) {
            obstacleT = d;
            obstacleProp = obstacle;
          }
        }
      }

      // Zombies.
      let zhit = null;
      for (const zb of zombies.values()) {
        if (!zb.alive) continue;
        const candidate = segmentZombieHit(from, to, zb, bullet.radius);
        if (!candidate) continue;
        const dist = candidate.t * segmentLen;
        if (dist < obstacleT && (!zhit || dist < zhit.dist)) {
          zhit = { zb, dist, part: candidate.part, mult: candidate.mult, t: candidate.t };
        }
      }

      // Champion boss.
      const bhit = dir ? bossEvent.bulletHit(from, to, bullet.radius) : null;
      if (bhit) {
        const bdist = bhit.t * segmentLen;
        if (bdist < obstacleT && (!zhit || bdist < zhit.dist)) {
          const shooter = players.get(bullet.shooterId);
          const damage = bullet.damage * bhit.mult;
          bossEvent.damage(damage, shooter, bhit.part, now);
          const hitPoint = { x: from.x + (to.x - from.x) * bhit.t, y: from.y + (to.y - from.y) * bhit.t, z: from.z + (to.z - from.z) * bhit.t };
          addBulletTrail(bullet.shooterId, bullet.weaponKey, now, from, hitPoint, { zombieId: "boss", part: bhit.part, damage });
          bullets.delete(bullet.id);
          continue;
        }
      }

      // The dragon (big sphere hitboxes; head is the weak spot).
      const dhit = dir ? dragonEvent.bulletHit(from, to, bullet.radius) : null;
      if (dhit) {
        const ddist = dhit.t * segmentLen;
        if (ddist < obstacleT && (!zhit || ddist < zhit.dist)) {
          const shooter = players.get(bullet.shooterId);
          const damage = bullet.damage * dhit.mult;
          dragonEvent.damage(damage, shooter, dhit.part, now);
          const hitPoint = { x: from.x + (to.x - from.x) * dhit.t, y: from.y + (to.y - from.y) * dhit.t, z: from.z + (to.z - from.z) * dhit.t };
          addBulletTrail(bullet.shooterId, bullet.weaponKey, now, from, hitPoint, {
            zombieId: "dragon",
            part: dhit.part === "head" ? "head" : dhit.part,
            damage,
          });
          bullets.delete(bullet.id);
          continue;
        }
      }

      if (zhit) {
        const damage = bullet.damage * zhit.mult;
        const shooter = players.get(bullet.shooterId);
        damageZombie(zhit.zb, damage, shooter, zhit.part, now);
        const hitPoint = {
          x: from.x + (to.x - from.x) * zhit.t,
          y: from.y + (to.y - from.y) * zhit.t,
          z: from.z + (to.z - from.z) * zhit.t,
        };
        addBulletTrail(bullet.shooterId, bullet.weaponKey, now, from, hitPoint, {
          zombieId: zhit.zb.id,
          part: zhit.part,
          damage,
        });
        bullets.delete(bullet.id);
        continue;
      }

      if (obstacleT < Infinity) {
        const hitPoint = {
          x: from.x + dir.x * obstacleT,
          y: from.y + dir.y * obstacleT,
          z: from.z + dir.z * obstacleT,
        };
        addBulletTrail(bullet.shooterId, bullet.weaponKey, now, from, hitPoint, null);
        // Bullets chip away at breakable walls and roof tiles.
        if (obstacleProp && obstacleProp.breakable) {
          const shooter = players.get(bullet.shooterId);
          structures.damageProp(obstacleProp, bullet.damage * WALL_BULLET_SCALE, now, shooter ? { id: shooter.id, name: shooter.name } : null);
        }
        bullets.delete(bullet.id);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Difficulty + housekeeping
  // ---------------------------------------------------------------------

  function evaluateDifficulty(now) {
    difficulty.lastEvalAt = now;
    difficulty.recentKills = difficulty.recentKills.filter((t) => now - t < 60000);
    const alive = Array.from(players.values()).filter((p) => p.alive);
    const avgHealth = alive.length
      ? alive.reduce((sum, p) => sum + p.health, 0) / alive.length
      : 100;

    if (avgHealth < 35) {
      difficulty.spawnMult = 0.7;
      difficulty.runnerBias = 0;
    } else if (difficulty.recentKills.length > 22) {
      difficulty.spawnMult = 1.25;
      difficulty.runnerBias = 0.15;
    } else {
      difficulty.spawnMult = 1;
      difficulty.runnerBias = 0;
    }

    // Camping detection: little movement over 20s.
    for (const p of players.values()) {
      if (now >= p.campCheckAt) {
        p.camping = p.alive && Math.hypot(p.x - p.campRefX, p.z - p.campRefZ) < 6;
        p.campRefX = p.x;
        p.campRefZ = p.z;
        p.campCheckAt = now + 20000;
      }
    }
  }

  function sampleAmbientNoise(now) {
    for (const p of players.values()) {
      if (!p.alive) continue;
      const speed = Math.hypot(p.vx, p.vz);
      if (p.inVehicle) {
        const vehicle = getVehicleById(p.inVehicle);
        if (vehicle && Math.abs(vehicle.speed) > 3) addNoise(p.x, p.z, 30, now);
      } else if (speed > 9) {
        addNoise(p.x, p.z, 9, now);
      } else if (speed > 2 && !p.crouching) {
        addNoise(p.x, p.z, 3.5, now);
      }
    }
  }

  function maybeRegen(player, dtSec, now) {
    if (!player.alive || player.health >= 100) return;
    if (player.healBlockedUntil && now < player.healBlockedUntil) return; // black-blade wound
    if (now - player.lastDamagedAt < REGEN_DELAY_MS) return;
    player.health = Math.min(100, player.health + REGEN_PER_SEC * dtSec);
  }

  function performMelee(attacker, now) {
    if (!attacker.alive || attacker.inVehicle) return false;
    if (now - attacker.lastMeleeAt < 850) return false;
    attacker.lastMeleeAt = now;
    addNoise(attacker.x, attacker.z, 8, now);

    const forwardX = -Math.sin(attacker.yaw);
    const forwardZ = -Math.cos(attacker.yaw);
    let hitSomething = false;
    for (const zb of zombies.values()) {
      if (!zb.alive) continue;
      const dx = zb.x - attacker.x;
      const dz = zb.z - attacker.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 2.45) continue;
      const dot = dist > 1e-6 ? (dx / dist) * forwardX + (dz / dist) * forwardZ : 1;
      if (dot < 0.35) continue;
      damageZombie(zb, 60, attacker, "melee", now);
      hitSomething = true;
    }
    return hitSomething;
  }

  // ---------------------------------------------------------------------
  // Snapshot + tick
  // ---------------------------------------------------------------------

  function zombiesForSnapshot() {
    const list = [];
    const playerList = Array.from(players.values());
    for (const zb of zombies.values()) {
      // Bosses are always broadcast so their exact location stays visible.
      let near = playerList.length === 0 || zb.boss;
      for (const p of playerList) {
        if (near) break;
        if (Math.hypot(p.x - zb.x, p.z - zb.z) < ZOMBIE_SNAPSHOT_RANGE) {
          near = true;
        }
      }
      if (!near) continue;
      const now = Date.now();
      // Compact row (see ZOMBIE_FIELDS in public/modules/game-state.js):
      // keyed objects were ~100 bytes per zombie, a row is ~45.
      const dead = !zb.alive;
      list.push([
        zb.id,
        zb.type,
        round2(zb.x),
        round2(zb.y),
        round2(zb.z),
        round2(((zb.yaw % 6.2832) + 6.2832) % 6.2832),
        Math.round((zb.health / zb.maxHealth) * 100) / 100,
        zb.state,
        dead ? 0 : 1,
        Math.max(0, 450 - (now - zb.lastAttackAt)) || 0,
        Math.max(0, zb.screamingUntil - now) || 0,
        Math.max(0, (zb.emergingUntil || 0) - now) || 0,
        dead ? round2(clamp((now - zb.deathAt) / 900, 0, 1)) : 0,
        zb.boss ? 1 : 0,
      ]);
    }
    return list;
  }

  function zombiesRemaining() {
    let count = 0;
    for (const zb of zombies.values()) if (zb.alive) count += 1;
    return count;
  }

  const vehicleNet = createVehicleNet();
  function getSnapshot(now = Date.now(), includeMeta = false) {
    const vehicleDelta = serializeVehicleDelta(vehicles, vehicleNet, now, includeMeta);
    const liveShots = shotEvents.filter((s) => now - s.at <= SHOT_EVENT_TTL_MS);
    const liveZombieEvents = zombieEvents.filter((e) => now - e.at <= 1600);
    const cycle = cycleInfo(now);
    const snapshot = {
      mode: "zplus",
      wave: {
        n: waveNumber,
        remaining: zombiesRemaining(),
        active: waveActive,
        nextInMs: nextWaveAt ? Math.max(0, nextWaveAt - now) : null,
      },
      night: { f: Math.round(cycle.factor * 1000) / 1000, isNight: cycle.isNight, day: cycle.day },
      killFeed,
      shotEvents: liveShots,
      zombieEvents: liveZombieEvents,
      rift: dragonEvent.serialize(now) || undefined,
      champ: bossEvent.serialize(now) || undefined,
      zc: zombiesForSnapshot(),
      bullets: Array.from(bullets.values()).map((b) => ({
        id: b.id,
        weapon: b.weaponKey,
        x: round2(b.x),
        y: round2(b.y),
        z: round2(b.z),
      })),
      vehicles: vehicleDelta.list,
      vehiclesPartial: vehicleDelta.partial || undefined,
      vehicleEvents: vehicleEvents.filter((e) => now - e.at <= 1600),
      destroyedProps: destroyedPropIds,
      players: Array.from(players.values()).map((p) => {
        const deathProgress = p.alive || !p.deathAt ? 0 : clamp((now - p.deathAt) / 900, 0, 1);
        return {
          id: p.id,
          name: p.name,
          x: round2(p.x),
          y: round2(p.y),
          z: round2(p.z),
          vx: round2(p.vx),
          vy: round2(p.vy),
          vz: round2(p.vz),
          yaw: round2(p.yaw),
          pitch: round2(p.pitch),
          health: round2(p.health),
          kills: p.kills,
          score: p.score,
          deaths: p.deaths,
          alive: p.alive,
          inVehicle: p.inVehicle,
          seat: p.vehicleSeat || null,
          crouching: p.crouching,
          respawnMs: p.alive ? 0 : Math.max(0, p.respawnAt - now),
          weapon: p.weapon,
          previousWeapon: p.previousWeapon,
          lastShotAt: p.lastShotAt,
          ammoInMag: p.ammoInMag,
          magSize: p.magSize,
          reloadingMs: p.reloadingUntil ? Math.max(0, p.reloadingUntil - now) : 0,
          switchingMs: p.switchingUntil ? Math.max(0, p.switchingUntil - now) : 0,
          meleeMs: Math.max(0, 520 - (now - (p.lastMeleeAt || 0))),
          deathTilt: p.deathTilt,
          deathRoll: p.deathRoll,
          deathProgress,
        };
      }),
      recruit: serializeRecruitBeacon(recruitBeacon, now),
      weather: serializeWeather(weather, now),
      npcs: npcs.map((n) => {
        const s = serializeNpc(n, now);
        s.x = round2(s.x);
        s.y = round2(s.y);
        s.z = round2(s.z);
        s.yaw = round2(s.yaw);
        s.homeX = round2(s.homeX);
        s.homeZ = round2(s.homeZ);
        return s;
      }),
      serverTime: now,
    };
    if (includeMeta) {
      snapshot.meta = {
        worldHalfSize: C.WORLD_HALF_SIZE,
        weapons: Object.values(WEAPONS),
        defaultSlots: DEFAULT_SLOTS,
        props: worldProps.filter((p) => p.type !== "rubble"), // rubble rides in `structure`
        buildings: buildings.map((b) => ({ id: b.id, kind: b.kind, x: b.x, z: b.z, w: b.w, d: b.d, h: b.h, color: b.color })),
        structure: structures.payload(now),
        terrainPatches,
        wildlife,
        vehicles,
        zombieTypes: Object.fromEntries(
          Object.entries(ZOMBIE_TYPES).map(([k, v]) => [k, { scale: v.scale, height: v.height, hp: v.hp }]),
        ),
        npcRoles: Object.fromEntries(
          Object.entries(NPC_ROLES).map(([key, cfg]) => [key, { label: cfg.label, color: cfg.color }]),
        ),
      };
    }
    return snapshot;
  }

  function tick() {
    const now = Date.now();
    const dtSec = Math.min(0.06, (now - lastTickAt) / 1000);
    lastTickAt = now;
    const cycle = cycleInfo(now);
    updateWeather(weather, now);
    structures.update(now);
    if (now - lastStructureEmitAt >= 100 && structures.takeDirty()) {
      lastStructureEmitAt = now;
      nsp.emit("structure", structures.payload(now));
    }

    // Waves: purely time-based. Each wave spawns on a fixed cadence and
    // immediately rearms the timer for the next one — survivors from earlier
    // waves stay alive, so the horde grows over time.
    if (bossFightActive()) {
      // The rift / dragon / champion fight holds the wave clock.
      if (nextWaveAt !== null) nextWaveAt = Math.max(nextWaveAt, now + WAVE_INTERVAL_MS);
      lastAmbientAt = now;
      if (nextHordePulseAt !== null) nextHordePulseAt = Math.max(nextHordePulseAt, now + HORDE_PULSE_MS);
    }
    if (firstJoinAt && players.size > 0 && !bossFightActive()) {
      if (nextWaveAt === null) nextWaveAt = firstJoinAt + FIRST_WAVE_DELAY_MS;
      if (now >= nextWaveAt) {
        nextWaveAt = now + WAVE_INTERVAL_MS;
        spawnWave(now);
      }
      // Ambient trickle (doubled at night) once the first wave has begun.
      const ambientInterval = cycle.isNight ? 12000 : 24000;
      if (waveNumber > 0 && now - lastAmbientAt > ambientInterval) {
        lastAmbientAt = now;
        ambientSpawn(now, cycle.isNight);
      }

      // Horde pulse: every 2 minutes the whole horde catches the players'
      // scent and converges on their positions.
      if (nextHordePulseAt === null) nextHordePulseAt = firstJoinAt + HORDE_PULSE_MS;
      if (now >= nextHordePulseAt) {
        nextHordePulseAt = now + HORDE_PULSE_MS;
        const alive = Array.from(players.values()).filter((p) => p.alive);
        if (alive.length) {
          for (const zb of zombies.values()) {
            if (!zb.alive || now < zb.emergingUntil) continue;
            let nearest = null;
            let nearestDist = Infinity;
            for (const p of alive) {
              const d = Math.hypot(p.x - zb.x, p.z - zb.z);
              if (d < nearestDist) {
                nearestDist = d;
                nearest = p;
              }
            }
            zb.lastKnown = { x: nearest.x, z: nearest.z };
            if (zb.state === "idle" || zb.state === "patrol" || zb.state === "search") {
              zb.state = "investigate";
            }
          }
          addZombieEvent("horde", 0, 0, now);
        }
      }
    }

    if (now - difficulty.lastEvalAt > 10000) evaluateDifficulty(now);
    if (now - lastNoiseSampleAt > 400) {
      lastNoiseSampleAt = now;
      sampleAmbientNoise(now);
    }
    // Expire stale noise.
    while (noiseEvents.length && now - noiseEvents[0].at > 1200) noiseEvents.shift();

    for (const player of players.values()) {
      if (player.reloadingUntil && now >= player.reloadingUntil) {
        refillMagazine(player, WEAPONS[player.weapon] || defaultWeapon());
        player.reloadingUntil = 0;
      }
      applyMovement(player, dtSec);
      maybeRegen(player, dtSec, now);
      if (!player.alive && player.respawnAt && now >= player.respawnAt) respawnPlayer(player, now);
    }
    updateVehicles(dtSec, now);
    dragonEvent.update(dtSec, now);
    bossEvent.update(dtSec, now);
    updateZombies(dtSec, now);
    updateNpcs(dtSec);
    zombiesDamageNpcs(dtSec, now);
    simulateBullets(dtSec, now);

    if (now - lastBroadcastAt >= Math.floor(1000 / BROADCAST_RATE)) {
      lastBroadcastAt = now;
      nsp.volatile.emit("state", getSnapshot(now, false));
    }
  }

  setInterval(tick, Math.floor(1000 / TICK_RATE));

  // ---------------------------------------------------------------------
  // Socket events
  // ---------------------------------------------------------------------

  nsp.on("connection", (socket) => {
    // ---- Boss Test panel (open the game with ?bosstest=<token>) ----
    // Summon any boss on demand. Disabled unless the server has
    // ZPLUS_BOSS_TEST_TOKEN set, and the client must send the same token.
    socket.on("dev_boss", (req, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const token = process.env.ZPLUS_BOSS_TEST_TOKEN;
      if (!token) return reply({ ok: false, reason: "Boss test mode is disabled on this server (ZPLUS_BOSS_TEST_TOKEN not set)" });
      if (!req || req.token !== token) return reply({ ok: false, reason: "Wrong boss test token" });
      const p = players.get(socket.id);
      if (!p) return reply({ ok: false, reason: "Join the game first" });
      if (!p.alive) return reply({ ok: false, reason: "Wait until you respawn" });
      const now = Date.now();
      const level = Math.max(1, Math.min(10, Number(req.level) || 1));
      const hpScale = req.lowHp ? 0.1 : 1;
      // Whatever is running ends first.
      if (bossEvent.active()) bossEvent.reset();
      if (dragonEvent.active()) dragonEvent.reset();
      if (req.kind === "end") {
        waveActive = false;
        nextWaveAt = now + 15000;
        return reply({ ok: true, msg: "Boss fight ended — waves resume in 15s" });
      }
      const started = req.kind === "dragon"
        ? dragonEvent.start(now, { level, hpScale })
        : bossEvent.start(req.kind, now, { level, hpScale });
      if (!started) return reply({ ok: false, reason: `Could not start "${req.kind}"` });
      waveActive = true;
      addKillFeed(p.name, `summoned ${req.kind === "dragon" ? "the Undead Wyrm" : req.kind} (test, Lv ${level})`, now);
      return reply({ ok: true, msg: `Summoned ${req.kind} · Lv ${level}${req.lowHp ? " · low HP" : ""}` });
    });

    socket.on("join", (name, ack) => {
      if (players.has(socket.id)) {
        if (typeof ack === "function") ack({ ok: true, id: socket.id });
        return;
      }
      const player = makePlayer(socket.id, name, Date.now());
      players.set(socket.id, player);
      if (!firstJoinAt) firstJoinAt = Date.now();
      socket.emit("joined", getSnapshot(Date.now(), true));
      if (typeof ack === "function") ack({ ok: true, id: socket.id, name: player.name });
      nsp.emit("state", getSnapshot(Date.now(), false));
    });

    socket.on("input", (input) => {
      const p = players.get(socket.id);
      if (!p || !input) return;
      p.input.forward = Boolean(input.forward);
      p.input.back = Boolean(input.back);
      p.input.left = Boolean(input.left);
      p.input.right = Boolean(input.right);
      p.input.sprint = Boolean(input.sprint);
      p.input.jump = Boolean(input.jump);
      p.input.crouch = Boolean(input.crouch);
      // Facing rides along with every input packet (30/s): the separate,
      // droppable "look" stream could leave the server walking you in a
      // stale direction — a big source of rubber-banding on phones.
      if (Number.isFinite(input.yaw)) p.yaw = input.yaw;
      if (Number.isFinite(input.pitch)) p.pitch = clamp(input.pitch, -1.25, 1.1);
    });

    socket.on("look", (look) => {
      const p = players.get(socket.id);
      if (!p || !look) return;
      p.yaw = Number.isFinite(look.yaw) ? look.yaw : p.yaw;
      p.pitch = clamp(Number.isFinite(look.pitch) ? look.pitch : p.pitch, -1.25, 1.1);
    });

    socket.on("switch_weapon", (weaponKeyOrSlot) => {
      const p = players.get(socket.id);
      // Z+ has no loot: only the three default slots are switchable.
      const weaponKey = Number.isInteger(weaponKeyOrSlot) ? DEFAULT_SLOTS[weaponKeyOrSlot] : weaponKeyOrSlot;
      if (!DEFAULT_SLOTS.includes(weaponKey)) return;
      // Drivers have their hands on the wheel; passengers keep their weapon.
      if (!p || !WEAPONS[weaponKey] || p.weapon === weaponKey) return;
      const now = Date.now();
      p.previousWeapon = p.weapon;
      p.weapon = weaponKey;
      p.reloadingUntil = 0;
      p.switchingUntil = now + 700;
      refillMagazine(p, WEAPONS[weaponKey]);
    });

    socket.on("vehicle_toggle", (opts, ack) => {
      // Backward compatible: old clients send just an ack callback; new ones
      // send ({seat: "driver"|"passenger"}, ack) to pick a seat.
      if (typeof opts === "function") {
        ack = opts;
        opts = null;
      }
      const p = players.get(socket.id);
      const seat = opts?.seat === "passenger" ? "passenger" : "driver";
      const ok = p ? enterNearestVehicle(p, seat) : false;
      if (typeof ack === "function") ack({ ok });
    });

    // Hold-to-recruit an AI companion (server times the 10s hold in the fleet
    // update while the player stays alive and in range).
    // Hold-to-recruit at the roaming beacon (server times the 10s hold).
    socket.on("recruit_start", () => {
      const p = players.get(socket.id);
      if (!p || !p.alive) return;
      assertRecruit(recruitBeacon, socket.id, Date.now());
    });

    socket.on("recruit_cancel", () => {
      cancelRecruit(recruitBeacon, socket.id);
    });

    socket.on("melee", (ack) => {
      const p = players.get(socket.id);
      const ok = p ? performMelee(p, Date.now()) : false;
      if (typeof ack === "function") ack({ ok });
    });

    socket.on("reload", (ack) => {
      const now = Date.now();
      const p = players.get(socket.id);
      if (!p || !p.alive) {
        if (typeof ack === "function") ack({ ok: false, reason: "not-active" });
        return;
      }
      const weapon = WEAPONS[p.weapon] || defaultWeapon();
      if (p.reloadingUntil > now || p.ammoInMag >= weapon.magSize) {
        if (typeof ack === "function") ack({ ok: false });
        return;
      }
      p.reloadingUntil = now + weapon.reloadMs;
      if (typeof ack === "function") ack({ ok: true, reloadMs: weapon.reloadMs });
    });

    socket.on("fire", (ack) => {
      const now = Date.now();
      const p = players.get(socket.id);
      // The driver can't shoot — the passenger seat is the gun seat.
      if (!p || !p.alive) {
        if (typeof ack === "function") ack({ ok: false, reason: "not-active" });
        return;
      }
      const weapon = WEAPONS[p.weapon] || defaultWeapon();
      if (p.switchingUntil > now || p.reloadingUntil > now || now - p.lastShotAt < weapon.fireIntervalMs) {
        if (typeof ack === "function") ack({ ok: false, reason: "busy" });
        return;
      }
      if (p.ammoInMag <= 0) {
        p.reloadingUntil = now + weapon.reloadMs;
        if (typeof ack === "function") ack({ ok: false, reason: "empty", reloadMs: weapon.reloadMs });
        return;
      }
      p.lastShotAt = now;
      p.ammoInMag -= 1;
      spawnBullet(p, weapon, now);
      // Gunfire is the loudest zombie magnet.
      const loud = weapon.key === "sniper" ? 62 : weapon.key === "rifle" ? 46 : 38;
      addNoise(p.x, p.z, loud, now);

      // Dodgers (flyers + smart runners) being aimed at juke sideways before
      // the bullet arrives. Runners only react once they've noticed the player
      // (chase/attack/investigate) — an unaware wanderer shouldn't twitch.
      const aimX = -Math.sin(p.yaw);
      const aimZ = -Math.cos(p.yaw);
      for (const zb of zombies.values()) {
        if (!zb.alive) continue;
        const isFlyer = zb.cfg.flying;
        const isRunner = zb.cfg.dodger && !isFlyer;
        if (!isFlyer && !isRunner) continue;
        if (now < zb.dodgeCooldownUntil || now < zb.emergingUntil) continue;
        // A grounded runner only bothers to juke when it's actively engaged.
        if (isRunner && zb.state !== "chase" && zb.state !== "attack" && zb.state !== "investigate") continue;
        const dx = zb.x - p.x;
        const dz = zb.z - p.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 4 || dist > 48) continue;
        const dot = (dx / dist) * aimX + (dz / dist) * aimZ;
        if (dot < 0.9) continue; // not aimed at it
        // Runners recover faster and juke a touch harder so the sidestep reads
        // as a deliberate dodge rather than a stumble.
        zb.dodgeCooldownUntil = now + (isRunner ? 1100 : 1500);
        zb.dodgeUntil = now + (isRunner ? 380 : 480);
        const sign = Math.random() < 0.5 ? 1 : -1;
        const power = isRunner ? 8.5 : 9.5;
        zb.dodgeVx = -aimZ * power * sign;
        zb.dodgeVz = aimX * power * sign;
        if (isFlyer) zb.dodgeDy = Math.random() < 0.5 ? 1.7 : -1.5;
      }
      if (p.ammoInMag <= 0) p.reloadingUntil = now + weapon.reloadMs;
      if (typeof ack === "function") {
        ack({
          ok: true,
          ammoInMag: p.ammoInMag,
          magSize: weapon.magSize,
          recoilPitch: weapon.recoilPitch,
          recoilYaw: weapon.recoilYaw,
        });
      }
    });

    socket.on("ping_check", (ack) => {
      if (typeof ack === "function") ack({ serverTime: Date.now() });
    });

    socket.on("disconnect", () => {
      const p = players.get(socket.id);
      if (p) leaveVehicle(p);
      players.delete(socket.id);
      // Companions leave with their owner.
      cancelRecruit(recruitBeacon, socket.id);
      for (const npc of npcs) {
        if (npc.ownerId === socket.id) {
          npc.state = "dead";
          npc.diedAt = 0;
          npc.ownerId = null;
        }
      }
      // Empty server: rebuild the town for whoever plays next.
      if (players.size === 0) {
        structures.reset();
        nsp.emit("structure", structures.payload(Date.now()));
      }
    });
  });

  // ---------------------------------------------------------------------
  // Routes: /frag/z_plus (+ /demo/frag/z_plus). Registered before the /frag
  // static mount would matter, but express falls through anyway since the
  // frag public dir has no z_plus file.
  // ---------------------------------------------------------------------

  const publicDir = path.join(rootDir, "frag", "z_plus", "public");
  app.use("/frag/z_plus", express.static(publicDir));
  app.use("/demo/frag/z_plus", express.static(publicDir));
  for (const route of ["/frag/z_plus", "/frag/z_plus/", "/demo/frag/z_plus", "/demo/frag/z_plus/"]) {
    app.get(route, (_req, res) => {
      res.sendFile(path.join(publicDir, "index.html"));
    });
  }
}

module.exports = { initZPlusMode };
