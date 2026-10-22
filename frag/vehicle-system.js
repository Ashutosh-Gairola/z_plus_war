/**
 * Shared vehicle simulation used by both frag deathmatch and Z+ zombie mode.
 *
 * Vehicle types (vehicle.type):
 *  - "car"   (default): tuned arcade driving — stronger accel, speed-sensitive
 *    steering, gentler collision response so walls don't feel like trampolines.
 *  - "heli":  vertical lift (jump/crouch = up/down), hovers, tilts into travel.
 *  - "plane": needs ground-roll airspeed to take off, stalls below STALL_SPEED,
 *    climbs/dives with jump/crouch while airborne.
 *
 * Shared features:
 *  - fuel: drains with engine load, slowly siphons back while parked on the
 *    ground. Aircraft that run dry LOSE LIFT and fall; a hard ground impact
 *    triggers an explosion that the host server turns into radius damage
 *    (env.onVehicleExplosion) — occupants who don't bail in time go with it.
 *  - health: crashes damage the vehicle; a dead car won't drive, a dead
 *    aircraft falls out of the sky.
 *  - seats: driverId + passengerId. The driver steers and cannot shoot; the
 *    passenger rides along and keeps their weapon usable (enforced host-side).
 *  - destroyed vehicles respawn at their original spawn point after a delay.
 *  - world interaction: crashing emits events (client shows dust/sparks and
 *    plays audio), trees get knocked down at speed, players/zombies get
 *    run over with speed-based damage.
 */

const TUNING = {
  ACCEL: 30,
  BRAKE: 44,
  REVERSE_ACCEL: 16,
  MAX_SPEED: 32,
  MAX_REVERSE: 11,
  DRAG: 1.15, // rolling drag while driving
  PARK_DRAG: 3.4, // no driver / no throttle
  TURN_RATE: 2.25,
  STEER_RESPONSE: 9,
  BODY_RADIUS: 2.2,
  FUEL_IDLE_DRAIN: 0.14, // per second while engine on
  FUEL_SPEED_DRAIN: 0.03, // per m/s per second
  FUEL_PARK_REFILL: 1.4, // scavenged back while parked
  CRASH_MIN_SPEED: 7, // below this a wall hit is just a scrape
  TREE_FELL_SPEED: 9,
  RUNOVER_MIN_SPEED: 7,

  VEHICLE_RESPAWN_MS: 45000, // destroyed wreck -> fresh vehicle at spawn point

  HELI: {
    ACCEL: 15,
    MAX_SPEED: 30,
    MAX_REVERSE: 10,
    TURN_RATE: 1.7,
    MAX_ASCEND: 9,
    MAX_DESCEND: 8,
    MAX_ALT: 70,
    BODY_RADIUS: 2.6,
    FUEL_IDLE_DRAIN: 0.55, // thirstier than a car — flight time ~90s at speed
    FUEL_SPEED_DRAIN: 0.018,
    FALL_GRAVITY: 26, // unpowered descent accel
    MAX_FALL: 38,
    CRASH_IMPACT: 9, // vertical+forward impact beyond this hurts / explodes
  },

  PLANE: {
    ACCEL: 19,
    MAX_SPEED: 46,
    TURN_RATE_AIR: 1.15,
    TURN_RATE_GROUND: 1.5,
    TAKEOFF_SPEED: 22,
    STALL_SPEED: 15,
    CLIMB: 8,
    DIVE: 11,
    MAX_ALT: 90,
    BODY_RADIUS: 3.0,
    FUEL_IDLE_DRAIN: 0.45,
    FUEL_SPEED_DRAIN: 0.012,
    GLIDE_DRAG: 0.28, // engine-out drag — planes glide, they don't stop midair
    CRASH_IMPACT: 8,
  },
};

const EXPLOSION_POWER = 26;

/**
 * Ground vehicle classes. Multipliers on the base car TUNING, plus:
 *   radius  collision circle (m)
 *   mass    ram power vs walls/props and how much a crash slows you
 *   armor   incoming crash/run-over damage multiplier (lower = tougher)
 */
const GROUND_TYPES = {
  car: { accel: 1, maxSpeed: 1, turn: 1, radius: 2.2, mass: 1, armor: 1 }, // sedan
  sports: { accel: 1.35, maxSpeed: 1.38, turn: 1.12, radius: 2.15, mass: 0.85, armor: 1.25 },
  suv: { accel: 0.92, maxSpeed: 0.94, turn: 0.92, radius: 2.4, mass: 1.5, armor: 0.75 },
  pickup: { accel: 0.95, maxSpeed: 0.97, turn: 0.9, radius: 2.5, mass: 1.6, armor: 0.75 },
  truck: { accel: 0.55, maxSpeed: 0.75, turn: 0.6, radius: 3.3, mass: 3.2, armor: 0.45 },
  bike: { accel: 1.3, maxSpeed: 1.25, turn: 1.45, radius: 1.1, mass: 0.45, armor: 1.6 },
  apc: { accel: 0.5, maxSpeed: 0.68, turn: 0.62, radius: 3.0, mass: 4, armor: 0.25 },
};

/**
 * Body box + seats per vehicle type (vehicle-local: +x right, -z forward,
 * y up from the vehicle's ground point). hx/hz = half width/length, h = height.
 * Seats are hip positions; the seated eye sits ~0.78m above. Keep in sync with
 * public/modules/vehicle-shapes.js (the browser copy).
 */
const VEHICLE_SHAPES = {
  car: { hx: 1.15, hz: 2.35, h: 1.8, seats: { driver: [-0.47, 0.8, 0.35], passenger: [0.47, 0.8, 0.35] } },
  sports: { hx: 1.1, hz: 2.3, h: 1.35, seats: { driver: [-0.42, 0.52, 0.3], passenger: [0.42, 0.52, 0.3] } },
  suv: { hx: 1.22, hz: 2.35, h: 2.4, seats: { driver: [-0.5, 1.2, 0.2], passenger: [0.5, 1.2, 0.2] } },
  pickup: { hx: 1.22, hz: 2.85, h: 2.2, seats: { driver: [-0.5, 1.1, -0.35], passenger: [0.5, 1.1, -0.35] } },
  truck: { hx: 1.35, hz: 4.0, h: 3.8, seats: { driver: [-0.6, 1.85, -2.35], passenger: [0.6, 1.85, -2.35] } },
  bike: { hx: 0.38, hz: 1.3, h: 1.35, seats: { driver: [0, 1.0, 0.3], passenger: [0, 1.12, 0.85] } },
  apc: { hx: 1.45, hz: 3.3, h: 3.0, seats: { driver: [-0.6, 1.9, -2.0], passenger: [0, 2.85, 0.4] } },
  heli: { hx: 1.3, hz: 3.2, h: 2.8, seats: { driver: [-0.42, 1.2, -0.35], passenger: [0.42, 1.2, -0.35] } },
  plane: { hx: 1.0, hz: 4.2, h: 2.6, seats: { driver: [0, 1.5, -0.2], passenger: [0, 1.5, 0.6] } },
};
const SEATED_EYE = 0.78;

function vehicleShape(vehicle) {
  return VEHICLE_SHAPES[vehicle?.type] || VEHICLE_SHAPES.car;
}

/** World position of a seat (hip) — local offset rotated by the vehicle yaw. */
function seatWorld(vehicle, seat) {
  const [lx, ly, lz] = vehicleShape(vehicle).seats[seat] || vehicleShape(vehicle).seats.driver;
  const c = Math.cos(vehicle.yaw);
  const s = Math.sin(vehicle.yaw);
  return { x: vehicle.x + lx * c + lz * s, y: (vehicle.y || 0) + ly, z: vehicle.z - lx * s + lz * c };
}

/** Vehicle-local coordinates of a world point. */
function toVehicleLocal(vehicle, x, z) {
  const dx = x - vehicle.x;
  const dz = z - vehicle.z;
  const c = Math.cos(vehicle.yaw);
  const s = Math.sin(vehicle.yaw);
  return { lx: dx * c - dz * s, lz: dx * s + dz * c };
}

/**
 * Push a walking body (circle radius r, feet at feetY) out of every solid
 * vehicle. Returns the corrected { x, z }.
 */
function resolveCircleVsVehicles(x, z, r, vehicles, feetY = 0) {
  for (const v of vehicles) {
    if (v.destroyed) continue;
    const shape = vehicleShape(v);
    const vy = v.y || 0;
    if (feetY > vy + shape.h - 0.3 || feetY + 1.8 < vy) continue; // flying overhead / under a heli
    const { lx, lz } = toVehicleLocal(v, x, z);
    const ex = shape.hx + r - Math.abs(lx);
    const ez = shape.hz + r - Math.abs(lz);
    if (ex <= 0 || ez <= 0) continue;
    // Out along the shallow axis, in local space, then back to world.
    let nlx = lx;
    let nlz = lz;
    if (ex < ez) nlx += lx >= 0 ? ex : -ex;
    else nlz += lz >= 0 ? ez : -ez;
    const c = Math.cos(v.yaw);
    const s = Math.sin(v.yaw);
    x = v.x + nlx * c + nlz * s;
    z = v.z - nlx * s + nlz * c;
  }
  return { x, z };
}

/**
 * Distance along a segment to a vehicle's body box (null if missed), for
 * bullets. Done in the vehicle's local frame as a ray-vs-box test.
 */
function segmentHitsVehicle(from, to, v) {
  const shape = vehicleShape(v);
  const a = toVehicleLocal(v, from.x, from.z);
  const b = toVehicleLocal(v, to.x, to.z);
  const vy = v.y || 0;
  const o = [a.lx, from.y - vy, a.lz];
  const d = [b.lx - a.lx, to.y - from.y, b.lz - a.lz];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len < 1e-6) return null;
  const min = [-shape.hx, 0.25, -shape.hz];
  const max = [shape.hx, shape.h, shape.hz];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < min[i] || o[i] > max[i]) return null;
      continue;
    }
    let ta = (min[i] - o[i]) / d[i];
    let tb = (max[i] - o[i]) / d[i];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return { t: t0, distance: t0 * len };
}

/** Bullet / blast damage to a vehicle; wrecks it (and explodes) at 0 HP. */
function damageVehicle(env, vehicle, amount, now) {
  if (!vehicle || vehicle.destroyed) return;
  vehicle.health = Math.max(0, (vehicle.health ?? 100) - amount * vehicleArmor(vehicle));
  if (vehicle.health <= 0) explodeVehicle(env, vehicle, now);
}

/** Separate two ground vehicles that overlap (2D oriented-box SAT). */
function resolveVehiclePair(env, a, b, now) {
  const sa = vehicleShape(a);
  const sb = vehicleShape(b);
  const axes = [];
  for (const v of [a, b]) {
    axes.push([Math.cos(v.yaw), -Math.sin(v.yaw)], [Math.sin(v.yaw), Math.cos(v.yaw)]);
  }
  const corners = (v, sh) => {
    const c = Math.cos(v.yaw);
    const s = Math.sin(v.yaw);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([ix, iz]) => {
      const lx = ix * sh.hx;
      const lz = iz * sh.hz;
      return [v.x + lx * c + lz * s, v.z - lx * s + lz * c];
    });
  };
  const ca = corners(a, sa);
  const cb = corners(b, sb);
  let best = Infinity;
  let bestAxis = null;
  for (const [ax, az] of axes) {
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, z] of ca) { const p = x * ax + z * az; a0 = Math.min(a0, p); a1 = Math.max(a1, p); }
    for (const [x, z] of cb) { const p = x * ax + z * az; b0 = Math.min(b0, p); b1 = Math.max(b1, p); }
    const overlap = Math.min(a1, b1) - Math.max(a0, b0);
    if (overlap <= 0) return false; // separating axis: no contact
    if (overlap < best) {
      best = overlap;
      bestAxis = [ax, az];
    }
  }
  // Push apart along the minimum axis, heavier vehicle moves less.
  let [nx, nz] = bestAxis;
  if ((b.x - a.x) * nx + (b.z - a.z) * nz < 0) {
    nx = -nx;
    nz = -nz;
  }
  const ma = vehicleMass(a);
  const mb = vehicleMass(b);
  const fa = mb / (ma + mb);
  const fb = ma / (ma + mb);
  a.x -= nx * best * fa;
  a.z -= nz * best * fa;
  b.x += nx * best * fb;
  b.z += nz * best * fb;
  // Crash: closing speed along the contact normal.
  const closing = (a.vx || 0) * nx + (a.vz || 0) * nz - ((b.vx || 0) * nx + (b.vz || 0) * nz);
  if (closing > TUNING.CRASH_MIN_SPEED && now >= (a.pairCrashUntil || 0)) {
    a.pairCrashUntil = now + 700;
    b.pairCrashUntil = now + 700;
    a.health = Math.max(0, a.health - Math.min(25, closing * 0.6 * mb / (ma + mb) * 2) * vehicleArmor(a));
    b.health = Math.max(0, b.health - Math.min(25, closing * 0.6 * ma / (ma + mb) * 2) * vehicleArmor(b));
    env.addEvent("crash", { x: (a.x + b.x) / 2, y: 1, z: (a.z + b.z) / 2, power: closing });
  }
  // Momentum: the struck vehicle gets shoved, the striker slows.
  const push = Math.max(0, closing) * fa;
  a.speed *= 1 - Math.min(0.8, 0.5 * fa + 0.1);
  if (b.type !== "heli" && b.type !== "plane") {
    const along = -Math.sin(b.yaw) * nx - Math.cos(b.yaw) * nz;
    b.speed += along * push * 0.6;
  }
  return true;
}

function groundSpec(vehicle) {
  return GROUND_TYPES[vehicle.type] || GROUND_TYPES.car;
}

function vehicleBodyRadius(vehicle) {
  if (vehicle.type === "heli") return TUNING.HELI.BODY_RADIUS;
  if (vehicle.type === "plane") return TUNING.PLANE.BODY_RADIUS;
  return groundSpec(vehicle).radius;
}

function vehicleMass(vehicle) {
  if (vehicle.type === "heli") return 1.6;
  if (vehicle.type === "plane") return 2;
  return groundSpec(vehicle).mass;
}

function vehicleArmor(vehicle) {
  if (vehicle.type === "heli" || vehicle.type === "plane") return 1;
  return groundSpec(vehicle).armor;
}

/** Vertical span the aircraft body occupies, for 3D-ish obstacle checks. */
function verticalOverlap(vehicle, obstacle) {
  const bottom = vehicle.y || 0;
  const top = bottom + 3.0;
  const obBottom = obstacle.py || 0;
  const obTop = obBottom + obstacle.sy;
  return bottom < obTop && top > obBottom;
}

/**
 * Blow up a vehicle: mark it destroyed, queue a respawn, notify clients and
 * let the host server apply radius/occupant damage via env.onVehicleExplosion.
 */
function explodeVehicle(env, vehicle, now) {
  if (vehicle.destroyed) return;
  vehicle.destroyed = true;
  vehicle.health = 0;
  vehicle.engineOn = false;
  vehicle.speed = 0;
  vehicle.vx = 0;
  vehicle.vz = 0;
  vehicle.vy = 0;
  vehicle.respawnAt = now + TUNING.VEHICLE_RESPAWN_MS;
  env.addEvent("explosion", {
    x: vehicle.x,
    y: (vehicle.y || 0) + 1.2,
    z: vehicle.z,
    power: EXPLOSION_POWER,
  });
  if (env.onVehicleExplosion) env.onVehicleExplosion(vehicle);
  // Explosion callback ejects/damages occupants; make double sure the seats clear.
  vehicle.driverId = null;
  vehicle.passengerId = null;
}

/** Clear a seat whose occupant is gone/dead/moved to another vehicle. */
function validateSeat(vehicle, seatKey, players) {
  const occupantId = vehicle[seatKey];
  if (!occupantId) return null;
  const occupant = players.get(occupantId);
  if (!occupant || !occupant.alive || occupant.inVehicle !== vehicle.id) {
    if (occupant && occupant.inVehicle === vehicle.id) occupant.inVehicle = null;
    vehicle[seatKey] = null;
    return null;
  }
  return occupant;
}

/** Shared collision + crash handling for the horizontal plane. */
function resolveVehicleObstacles(env, vehicle, nextX, nextZ, dtSec, now, opts) {
  const { worldProps, pointInsideObstacle, resolveObstacleCollision } = env;
  const radius = vehicleBodyRadius(vehicle);
  const airborne = (vehicle.y || 0) > 0.2;

  // Broad-phase: only props in the grid cells around the vehicle (the hosts
  // pass propsNear); falls back to everything.
  const candidates = env.propsNear ? env.propsNear(nextX, nextZ) : worldProps;
  for (const obstacle of candidates) {
    if (obstacle.collidable === false) continue;
    if (airborne) {
      // In the air only solid geometry at our altitude matters.
      if (!verticalOverlap(vehicle, obstacle)) continue;
    } else {
      if ((obstacle.py || 0) > 1.4 || obstacle.sy <= 0.45) continue;
    }
    if (!pointInsideObstacle(nextX, nextZ, radius, obstacle)) continue;

    const impact = Math.abs(vehicle.speed);

    if (
      !airborne &&
      opts.fellTrees &&
      obstacle.type === "tree" &&
      impact >= TUNING.TREE_FELL_SPEED &&
      !obstacle.destroyed
    ) {
      obstacle.destroyed = true;
      obstacle.collidable = false;
      vehicle.health = Math.max(0, vehicle.health - impact * 0.3);
      vehicle.speed *= 0.6;
      const len = Math.hypot(vehicle.vx, vehicle.vz) || 1;
      env.addEvent("treefall", {
        propId: obstacle.id,
        x: obstacle.x,
        z: obstacle.z,
        dx: vehicle.vx / len,
        dz: vehicle.vz / len,
      });
      env.addEvent("crash", { x: nextX, y: 1, z: nextZ, power: impact * 0.6 });
      continue; // drive through the falling tree
    }

    // Breakable structure (wall panel etc.): the host decides if the hit
    // smashes through. Heavier/faster vehicles hit harder.
    if (
      env.onVehicleImpact &&
      obstacle.breakable &&
      impact >= TUNING.CRASH_MIN_SPEED &&
      now >= (vehicle.crashCooldownUntil || 0)
    ) {
      const mass = vehicleMass(vehicle);
      const energy = 0.5 * mass * impact * impact;
      if (env.onVehicleImpact(obstacle, energy, vehicle, now)) {
        vehicle.crashCooldownUntil = now + 250;
        vehicle.health = Math.max(0, vehicle.health - Math.min(22, impact * 0.45) * vehicleArmor(vehicle));
        vehicle.speed *= Math.min(0.85, 0.45 + mass * 0.08); // heavy rigs keep momentum
        env.addEvent("crash", { x: nextX, y: (vehicle.y || 0) + 1, z: nextZ, power: impact });
        if (airborne && vehicle.health <= 0) explodeVehicle(env, vehicle, now);
        continue; // drove through the wall
      }
    }

    const resolved = resolveObstacleCollision(nextX, nextZ, radius, obstacle);
    nextX = resolved.x;
    nextZ = resolved.z;
    // A cooldown keeps grinding against a wall from re-registering the same
    // crash every tick and shredding the vehicle.
    if (impact >= TUNING.CRASH_MIN_SPEED && now >= (vehicle.crashCooldownUntil || 0)) {
      vehicle.crashCooldownUntil = now + 900;
      const damage = (airborne ? Math.min(34, impact * 0.9) : Math.min(18, impact * 0.5)) * vehicleArmor(vehicle);
      vehicle.health = Math.max(0, vehicle.health - damage);
      vehicle.speed *= -0.24;
      env.addEvent("crash", {
        x: nextX + (vehicle.vx / (Math.abs(vehicle.speed) + 1)) * 1.2,
        y: (vehicle.y || 0) + 1,
        z: nextZ + (vehicle.vz / (Math.abs(vehicle.speed) + 1)) * 1.2,
        power: impact,
      });
      // Flying into a building at speed is usually terminal.
      if (airborne && vehicle.health <= 0) explodeVehicle(env, vehicle, now);
    } else {
      vehicle.speed *= 0.9; // scrape
    }
    break;
  }

  return { x: nextX, z: nextZ };
}

/** Run over players/zombies — only meaningful at ground level. */
function applyRunOver(env, vehicle, driver, players) {
  if ((vehicle.y || 0) > 1.2) return;

  if (env.onRunOverPlayer && Math.abs(vehicle.speed) > TUNING.RUNOVER_MIN_SPEED) {
    for (const p of players.values()) {
      if (!p.alive || p.inVehicle || p.id === vehicle.driverId || p.id === vehicle.passengerId) continue;
      if (Math.hypot(p.x - vehicle.x, p.z - vehicle.z) < vehicleBodyRadius(vehicle) * 0.9) {
        env.onRunOverPlayer(p, vehicle, driver, Math.abs(vehicle.speed) * Math.min(1.6, 0.75 + vehicleMass(vehicle) * 0.25));
        vehicle.speed *= 0.88;
        vehicle.health = Math.max(0, vehicle.health - 2 * vehicleArmor(vehicle));
      }
    }
  }

  if (env.zombies && env.onRunOverZombie && Math.abs(vehicle.speed) > TUNING.RUNOVER_MIN_SPEED - 1) {
    for (const zb of env.zombies.values()) {
      if (!zb.alive) continue;
      if (Math.hypot(zb.x - vehicle.x, zb.z - vehicle.z) < vehicleBodyRadius(vehicle) * 0.95) {
        env.onRunOverZombie(zb, vehicle, driver, Math.abs(vehicle.speed));
        vehicle.speed *= vehicleMass(vehicle) >= 3 ? 0.97 : 0.9; // trucks plough through hordes
        vehicle.health = Math.max(0, vehicle.health - 1.5 * vehicleArmor(vehicle));
      }
    }
  }
}

// ── Per-type physics ────────────────────────────────────────────────────────────

function updateCar(env, vehicle, driver, dtSec, now) {
  const { clamp, worldHalfSize } = env;
  const spec = groundSpec(vehicle);
  const disabled = vehicle.health <= 0;
  const outOfFuel = vehicle.fuel <= 0;
  const input = driver?.input;
  let throttle = 0;
  if (input?.forward) throttle += 1;
  if (input?.back) throttle -= 1;
  if (disabled || outOfFuel) throttle = 0;

  // Throttle / brake. Holding S while rolling forward brakes hard first.
  if (input?.back && vehicle.speed > 1) {
    vehicle.speed = Math.max(0, vehicle.speed - TUNING.BRAKE * dtSec);
  } else if (throttle !== 0) {
    const accel = (throttle > 0 ? TUNING.ACCEL : TUNING.REVERSE_ACCEL) * spec.accel * (env.weatherGrip ? 0.4 + 0.6 * env.weatherGrip() : 1);
    vehicle.speed += throttle * accel * dtSec;
  }

  // Fuel economy.
  if (vehicle.engineOn && !disabled && vehicle.fuel > 0) {
    vehicle.fuel = Math.max(
      0,
      vehicle.fuel - (TUNING.FUEL_IDLE_DRAIN + Math.abs(vehicle.speed) * TUNING.FUEL_SPEED_DRAIN) * dtSec,
    );
  } else if (!vehicle.driverId && vehicle.fuel < 100) {
    vehicle.fuel = Math.min(100, vehicle.fuel + TUNING.FUEL_PARK_REFILL * dtSec);
  }

  const drag = throttle !== 0 ? TUNING.DRAG : TUNING.PARK_DRAG;
  vehicle.speed *= Math.exp(-drag * dtSec);
  vehicle.speed = clamp(vehicle.speed, -TUNING.MAX_REVERSE, TUNING.MAX_SPEED * spec.maxSpeed);
  if (Math.abs(vehicle.speed) < 0.05) vehicle.speed = 0;

  // Steering: responsive at low speed, stable at high speed.
  let steerInput = 0;
  if (input?.left) steerInput += 1;
  if (input?.right) steerInput -= 1;
  vehicle.steer += (steerInput - vehicle.steer) * Math.min(1, dtSec * TUNING.STEER_RESPONSE);
  const speedAbs = Math.abs(vehicle.speed);
  // Wet roads / snow (env.weatherGrip) cost steering grip; snow also traction.
  const traction = env.weatherGrip ? env.weatherGrip() : 1;
  const grip = clamp(speedAbs / 6, 0, 1) * (1 - clamp((speedAbs - 18) / 40, 0, 0.4)) * (0.35 + 0.65 * traction);
  vehicle.yaw += vehicle.steer * TUNING.TURN_RATE * spec.turn * grip * dtSec * Math.sign(vehicle.speed || 1);

  vehicle.vx = -Math.sin(vehicle.yaw) * vehicle.speed;
  vehicle.vz = -Math.cos(vehicle.yaw) * vehicle.speed;
  vehicle.y = 0;
  vehicle.tilt = 0;

  let nextX = clamp(vehicle.x + vehicle.vx * dtSec, -worldHalfSize + 3, worldHalfSize - 3);
  let nextZ = clamp(vehicle.z + vehicle.vz * dtSec, -worldHalfSize + 3, worldHalfSize - 3);
  const resolved = resolveVehicleObstacles(env, vehicle, nextX, nextZ, dtSec, now, { fellTrees: true });
  vehicle.x = resolved.x;
  vehicle.z = resolved.z;
}

function updateHeli(env, vehicle, driver, dtSec, now) {
  const { clamp, worldHalfSize } = env;
  const H = TUNING.HELI;
  const input = driver?.input;
  const powered = vehicle.engineOn && vehicle.health > 0 && vehicle.fuel > 0;

  // Vertical: collective toward a target climb rate; unpowered = gravity.
  if (powered) {
    let targetVy = 0;
    if (input?.jump) targetVy = H.MAX_ASCEND;
    else if (input?.crouch) targetVy = -H.MAX_DESCEND;
    vehicle.vy = (vehicle.vy || 0) + (targetVy - (vehicle.vy || 0)) * Math.min(1, dtSec * 3.2);
  } else {
    vehicle.vy = Math.max(-(H.MAX_FALL), (vehicle.vy || 0) - H.FALL_GRAVITY * dtSec);
  }
  vehicle.y = Math.min(H.MAX_ALT, (vehicle.y || 0) + vehicle.vy * dtSec);

  // Horizontal cyclic.
  let throttle = 0;
  if (powered && input?.forward) throttle = 1;
  else if (powered && input?.back) throttle = -0.6;
  vehicle.speed += throttle * H.ACCEL * dtSec;
  vehicle.speed *= Math.exp(-(powered ? 0.9 : 0.35) * dtSec);
  vehicle.speed = clamp(vehicle.speed, -H.MAX_REVERSE, H.MAX_SPEED);

  let steerInput = 0;
  if (input?.left) steerInput += 1;
  if (input?.right) steerInput -= 1;
  if (powered || vehicle.y > 0.5) vehicle.yaw += steerInput * H.TURN_RATE * dtSec;

  vehicle.vx = -Math.sin(vehicle.yaw) * vehicle.speed;
  vehicle.vz = -Math.cos(vehicle.yaw) * vehicle.speed;
  // Nose dips into forward flight — purely visual, clients lerp this.
  vehicle.tilt = clamp(vehicle.speed / H.MAX_SPEED, -1, 1) * 0.22;

  // Fuel: drains in flight, trickles back only when parked empty on the ground.
  if (powered) {
    vehicle.fuel = Math.max(
      0,
      vehicle.fuel - (H.FUEL_IDLE_DRAIN + Math.abs(vehicle.speed) * H.FUEL_SPEED_DRAIN) * dtSec,
    );
  } else if (!vehicle.driverId && vehicle.y <= 0.1 && vehicle.fuel < 100) {
    vehicle.fuel = Math.min(100, vehicle.fuel + TUNING.FUEL_PARK_REFILL * dtSec);
  }

  let nextX = clamp(vehicle.x + vehicle.vx * dtSec, -worldHalfSize + 3, worldHalfSize - 3);
  let nextZ = clamp(vehicle.z + vehicle.vz * dtSec, -worldHalfSize + 3, worldHalfSize - 3);
  const resolved = resolveVehicleObstacles(env, vehicle, nextX, nextZ, dtSec, now, { fellTrees: false });
  vehicle.x = resolved.x;
  vehicle.z = resolved.z;
  if (vehicle.destroyed) return;

  // Ground contact.
  if (vehicle.y <= 0) {
    const impact = Math.abs(Math.min(0, vehicle.vy)) + Math.abs(vehicle.speed) * 0.35;
    vehicle.y = 0;
    if (vehicle.vy < 0) vehicle.vy = 0;
    if (impact >= H.CRASH_IMPACT) {
      // A dead or dry bird coming down hard is a fireball; a rough but powered
      // landing just batters the airframe.
      if (!powered || impact >= H.CRASH_IMPACT * 1.6) {
        explodeVehicle(env, vehicle, now);
        return;
      }
      vehicle.health = Math.max(0, vehicle.health - impact * 4);
      env.addEvent("crash", { x: vehicle.x, y: 1, z: vehicle.z, power: impact });
      if (vehicle.health <= 0) {
        explodeVehicle(env, vehicle, now);
        return;
      }
    }
  }
}

function updatePlane(env, vehicle, driver, dtSec, now) {
  const { clamp, worldHalfSize } = env;
  const P = TUNING.PLANE;
  const input = driver?.input;
  const powered = vehicle.engineOn && vehicle.health > 0 && vehicle.fuel > 0;
  const airborne = (vehicle.y || 0) > 0.05;

  // Thrust.
  let throttle = 0;
  if (powered && input?.forward) throttle = 1;
  if (!airborne && input?.back && vehicle.speed > 0.5) {
    vehicle.speed = Math.max(0, vehicle.speed - TUNING.BRAKE * 0.7 * dtSec);
  } else if (throttle !== 0) {
    vehicle.speed += throttle * P.ACCEL * dtSec;
  }
  const drag = powered ? (throttle !== 0 ? 0.32 : 0.6) : P.GLIDE_DRAG + (airborne ? 0 : 1.6);
  vehicle.speed *= Math.exp(-drag * dtSec);
  vehicle.speed = clamp(vehicle.speed, 0, P.MAX_SPEED);

  // Steering (banked in the air, nosewheel on the ground).
  let steerInput = 0;
  if (input?.left) steerInput += 1;
  if (input?.right) steerInput -= 1;
  const turnRate = airborne
    ? P.TURN_RATE_AIR * clamp(vehicle.speed / P.TAKEOFF_SPEED, 0.3, 1)
    : P.TURN_RATE_GROUND * clamp(vehicle.speed / 8, 0, 1);
  vehicle.yaw += steerInput * turnRate * dtSec;

  // Vertical: lift needs airspeed. Below stall the nose drops no matter what.
  if (airborne) {
    let targetVy = 0;
    if (vehicle.speed >= P.STALL_SPEED) {
      if (input?.jump) targetVy = P.CLIMB * clamp((vehicle.speed - P.STALL_SPEED) / 10, 0.3, 1);
      else if (input?.crouch) targetVy = -P.DIVE;
      else targetVy = powered ? 0 : -2.5; // engine-out glide sinks gently
    } else {
      targetVy = -(P.STALL_SPEED - vehicle.speed) * 1.4; // stall — falling
    }
    vehicle.vy = (vehicle.vy || 0) + (targetVy - (vehicle.vy || 0)) * Math.min(1, dtSec * 2.6);
    // Diving trades altitude for airspeed.
    if (vehicle.vy < -4) vehicle.speed = clamp(vehicle.speed - vehicle.vy * 0.12 * dtSec * 10, 0, P.MAX_SPEED);
  } else {
    vehicle.vy = 0;
    if (powered && input?.jump && vehicle.speed >= P.TAKEOFF_SPEED) {
      vehicle.vy = 5.5; // rotate!
    }
  }
  vehicle.y = Math.min(P.MAX_ALT, Math.max(0, (vehicle.y || 0) + (vehicle.vy || 0) * dtSec));
  vehicle.tilt = clamp((vehicle.vy || 0) / 10, -1, 1) * -0.3;

  vehicle.vx = -Math.sin(vehicle.yaw) * vehicle.speed;
  vehicle.vz = -Math.cos(vehicle.yaw) * vehicle.speed;

  // Fuel.
  if (powered && (throttle !== 0 || airborne)) {
    vehicle.fuel = Math.max(
      0,
      vehicle.fuel - (P.FUEL_IDLE_DRAIN + Math.abs(vehicle.speed) * P.FUEL_SPEED_DRAIN) * dtSec,
    );
  } else if (!vehicle.driverId && !airborne && vehicle.fuel < 100) {
    vehicle.fuel = Math.min(100, vehicle.fuel + TUNING.FUEL_PARK_REFILL * dtSec);
  }

  let nextX = clamp(vehicle.x + vehicle.vx * dtSec, -worldHalfSize + 3, worldHalfSize - 3);
  let nextZ = clamp(vehicle.z + vehicle.vz * dtSec, -worldHalfSize + 3, worldHalfSize - 3);
  const resolved = resolveVehicleObstacles(env, vehicle, nextX, nextZ, dtSec, now, { fellTrees: false });
  vehicle.x = resolved.x;
  vehicle.z = resolved.z;
  if (vehicle.destroyed) return;

  // Touchdown / crash. Landing gently (shallow sink, sane speed) is fine;
  // slamming in — or coming down with no fuel/health — is not.
  if (vehicle.y <= 0 && airborne) {
    const sink = Math.abs(Math.min(0, vehicle.vy || 0));
    const impact = sink + Math.max(0, vehicle.speed - 30) * 0.5;
    vehicle.y = 0;
    vehicle.vy = 0;
    if (impact >= P.CRASH_IMPACT || (!powered && sink > 4)) {
      explodeVehicle(env, vehicle, now);
      return;
    }
    if (sink > 3.5) {
      vehicle.health = Math.max(0, vehicle.health - sink * 5);
      env.addEvent("crash", { x: vehicle.x, y: 1, z: vehicle.z, power: sink * 2 });
      if (vehicle.health <= 0) {
        explodeVehicle(env, vehicle, now);
        return;
      }
    }
  }
}

/**
 * Advance every vehicle by one tick.
 *
 * env = {
 *   vehicles, players, worldProps,
 *   clamp, pointInsideObstacle, resolveObstacleCollision,
 *   worldHalfSize,
 *   active(): boolean                    -- mode allows driving right now
 *   syncPlayerToVehicle(player, vehicle, seat)   -- seat: "driver"|"passenger"
 *   addEvent(type, payload)              -- crash / treefall / explosion events
 *   onVehicleExplosion(vehicle) | null   -- host applies radius + occupant damage
 *   onRunOverPlayer(victim, vehicle, driver, speed) | null
 *   zombies: Map | null
 *   onRunOverZombie(zombie, vehicle, driver, speed) | null
 * }
 */
function updateVehicleFleet(env, dtSec, now) {
  const { vehicles, players } = env;

  for (const vehicle of vehicles) {
    if (vehicle.fuel === undefined) vehicle.fuel = 100;
    if (vehicle.health === undefined) vehicle.health = 100;
    if (vehicle.y === undefined) vehicle.y = 0;
    if (vehicle.vy === undefined) vehicle.vy = 0;
    if (vehicle.spawnX === undefined) {
      // First tick: remember the placement so wrecks can respawn fresh.
      vehicle.spawnX = vehicle.x;
      vehicle.spawnZ = vehicle.z;
      vehicle.spawnYaw = vehicle.yaw;
    }

    // Wrecks sit out until their respawn timer brings back a fresh vehicle.
    if (vehicle.destroyed) {
      validateSeat(vehicle, "driverId", players);
      validateSeat(vehicle, "passengerId", players);
      if (vehicle.respawnAt && now >= vehicle.respawnAt) {
        vehicle.destroyed = false;
        vehicle.respawnAt = null;
        vehicle.x = vehicle.spawnX;
        vehicle.z = vehicle.spawnZ;
        vehicle.yaw = vehicle.spawnYaw;
        vehicle.y = 0;
        vehicle.vy = 0;
        vehicle.speed = 0;
        vehicle.steer = 0;
        vehicle.vx = 0;
        vehicle.vz = 0;
        vehicle.fuel = 100;
        vehicle.health = 100;
        vehicle.tilt = 0;
      }
      continue;
    }

    let driver = validateSeat(vehicle, "driverId", players);
    const passenger = validateSeat(vehicle, "passengerId", players);
    if (driver && !env.active()) {
      driver.inVehicle = null;
      vehicle.driverId = null;
      driver = null;
    }
    if (!driver) vehicle.engineOn = false;

    if (vehicle.type === "heli") {
      updateHeli(env, vehicle, driver, dtSec, now);
    } else if (vehicle.type === "plane") {
      updatePlane(env, vehicle, driver, dtSec, now);
    } else {
      updateCar(env, vehicle, driver, dtSec, now);
    }

    if (vehicle.destroyed) continue; // blew up during this tick

    applyRunOver(env, vehicle, driver, players);
  }

  // Vehicles are solid to each other (ground level only).
  const solid = vehicles.filter((v) => !v.destroyed && (v.y || 0) < 1.5);
  for (let i = 0; i < solid.length; i += 1) {
    for (let j = i + 1; j < solid.length; j += 1) {
      const a = solid[i];
      const b = solid[j];
      if (Math.abs(a.x - b.x) > 9 || Math.abs(a.z - b.z) > 9) continue;
      // The faster one is the "striker".
      if (Math.abs(a.speed || 0) >= Math.abs(b.speed || 0)) resolveVehiclePair(env, a, b, now);
      else resolveVehiclePair(env, b, a, now);
    }
  }

  // Seat sync last, so riders sit where the vehicle finally ended up.
  for (const vehicle of vehicles) {
    if (vehicle.destroyed) continue;
    const driver = vehicle.driverId ? players.get(vehicle.driverId) : null;
    const passenger = vehicle.passengerId ? players.get(vehicle.passengerId) : null;
    if (driver && driver.inVehicle === vehicle.id) env.syncPlayerToVehicle(driver, vehicle, "driver");
    if (passenger && passenger.inVehicle === vehicle.id) env.syncPlayerToVehicle(passenger, vehicle, "passenger");
  }
}

// ---------------------------------------------------------------------------
// Network: vehicle delta snapshots
// ---------------------------------------------------------------------------
// ~30 vehicles mostly sit parked, yet were re-sent in full 15-20 times a
// second (~80% of every snapshot). Now each snapshot carries only vehicles
// whose networked state changed since the last broadcast, plus a full
// keyframe every second (volatile snapshots can be dropped; the keyframe
// repairs any client that missed a change). Clients merge by id.

const VEHICLE_KEYFRAME_MS = 1000;
const r2 = (v) => Math.round(v * 100) / 100;

function serializeVehicle(v) {
  return {
    id: v.id,
    x: r2(v.x),
    y: r2(v.y || 0),
    z: r2(v.z),
    yaw: r2(v.yaw),
    speed: r2(v.speed),
    steer: r2(v.steer),
    tilt: r2(v.tilt || 0),
    type: v.type || "car",
    color: v.color,
    driverId: v.driverId,
    passengerId: v.passengerId || null,
    engineOn: v.engineOn,
    destroyed: !!v.destroyed,
    fuel: Math.round(v.fuel ?? 100),
    health: Math.round(v.health ?? 100),
  };
}

function createVehicleNet() {
  return { lastKeyAt: 0, sigs: new Map() };
}

/**
 * full=true (join / meta snapshots): everything, cache untouched.
 * Otherwise: { list, partial } for a broadcast.
 */
function serializeVehicleDelta(vehicles, net, now, full = false) {
  const all = vehicles.map(serializeVehicle);
  if (full) return { list: all, partial: false };
  const keyframe = now - net.lastKeyAt >= VEHICLE_KEYFRAME_MS;
  if (keyframe) net.lastKeyAt = now;
  const list = [];
  for (const s of all) {
    const sig = `${s.x}|${s.y}|${s.z}|${s.yaw}|${s.speed}|${s.steer}|${s.tilt}|${s.driverId}|${s.passengerId}|${s.engineOn}|${s.destroyed}|${s.fuel}|${s.health}|${s.color}`;
    if (keyframe || net.sigs.get(s.id) !== sig) list.push(s);
    net.sigs.set(s.id, sig);
  }
  return { list, partial: !keyframe };
}

module.exports = {
  createVehicleNet,
  serializeVehicleDelta,
  updateVehicleFleet,
  vehicleBodyRadius,
  vehicleShape,
  seatWorld,
  resolveCircleVsVehicles,
  segmentHitsVehicle,
  damageVehicle,
  VEHICLE_SHAPES,
  SEATED_EYE,
  VEHICLE_TUNING: TUNING,
  GROUND_VEHICLE_TYPES: GROUND_TYPES,
  EXPLOSION_POWER,
};
