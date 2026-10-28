const express = require("express");
const path = require("path");
const {
  updateVehicleFleet,
  vehicleBodyRadius,
  seatWorld,
  resolveCircleVsVehicles,
  segmentHitsVehicle,
  damageVehicle,
  SEATED_EYE,
  createVehicleNet,
  serializeVehicleDelta,
} = require("./vehicle-system");
const { createStructureSystem } = require("./structure-system");
const { createWeather, updateWeather, serializeWeather, weatherGrip } = require("./weather-system");
const { buildRegions } = require("./world-regions");
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
} = require("./npc-system");

const WORLD_HALF_SIZE = 640; // city in the middle, countryside around (world-regions.js)
const ZONE_START_RADIUS = 560;
const PLAYER_RADIUS = 0.55;
const PLAYER_STEP_HEIGHT = 0.62;
const PLAYER_HEIGHT = 1.8;
const PLAYER_COLLISION_RADIUS = 1.1;
const PLAYER_ACCEL = 66;
const PLAYER_GROUND_FRICTION = 10;
const PLAYER_GRAVITY = 34;
const PLAYER_JUMP_VELOCITY = 9.4;
const FALL_DAMAGE_SPEED = 12; // landing faster than this (m/s) costs health
const PLAYER_EYE_HEIGHT = 1.7;
const PLAYER_CROUCH_EYE_HEIGHT = 1.18;
const TICK_RATE = 30;
const BROADCAST_RATE = 20;

const PLAY_TIME_MS = 10 * 60 * 1000;
const COOLDOWN_TIME_MS = 3 * 60 * 1000;
const BASE_RESPAWN_MS = 10 * 1000;

const OUTSIDE_ZONE_DAMAGE_PER_SEC = 12;
const MIN_ZONE_RADIUS = 46;
const ZONE_SHIFT_INTERVAL_MS = 60 * 1000;
const ZONE_SHIFT_DURATION_MS = 45 * 1000;

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

const WEAPONS = {
  rifle: {
    key: "rifle",
    label: "Rifle",
    fireMode: "auto",
    rarity: "default",
    damage: 41,
    bodyMultiplier: 1.0,
    headMultiplier: 2.3,
    neckMultiplier: 1.65,
    chestMultiplier: 1.0,
    armMultiplier: 0.72,
    legMultiplier: 0.62,
    baseSpread: 0.0025,
    moveSpreadPerSpeed: 0.0009,
    sprintSpread: 0.014,
    fireIntervalMs: 120,
    range: 130,
    hitRadius: 1.2,
    magSize: 30,
    reloadMs: 1750,
    recoilPitch: 0.034,
    recoilYaw: 0.014,
    adsFov: 58,
    muzzleSpeed: 165,
    bulletGravity: 22,
    bulletRadius: 0.16,
    // Visual properties
    scale: { x: 0.8, y: 0.3, z: 2.0 },
    offset: { x: 0.35, y: 0.15, z: -0.3 },
    color: 0x4a5c5a,
  },
  smg: {
    key: "smg",
    label: "SMG",
    fireMode: "auto",
    rarity: "default",
    damage: 31,
    bodyMultiplier: 1.0,
    headMultiplier: 2.2,
    neckMultiplier: 1.55,
    chestMultiplier: 1.0,
    armMultiplier: 0.68,
    legMultiplier: 0.58,
    baseSpread: 0.004,
    moveSpreadPerSpeed: 0.00075,
    sprintSpread: 0.011,
    fireIntervalMs: 80,
    range: 92,
    hitRadius: 1.45,
    magSize: 40,
    reloadMs: 1500,
    recoilPitch: 0.021,
    recoilYaw: 0.018,
    adsFov: 64,
    muzzleSpeed: 150,
    bulletGravity: 18,
    bulletRadius: 0.18,
    // Visual properties
    scale: { x: 0.6, y: 0.25, z: 1.4 },
    offset: { x: 0.3, y: 0.12, z: -0.25 },
    color: 0x5a4a5a,
  },
  sniper: {
    key: "sniper",
    label: "Sniper",
    fireMode: "semi",
    scopeOverlay: true,
    rarity: "default",
    damage: 75,
    bodyMultiplier: 1.0,
    headMultiplier: 2.5,
    neckMultiplier: 1.8,
    chestMultiplier: 1.0,
    armMultiplier: 0.78,
    legMultiplier: 0.7,
    baseSpread: 0.0012,
    moveSpreadPerSpeed: 0.0018,
    sprintSpread: 0.02,
    fireIntervalMs: 980,
    range: 240,
    hitRadius: 0.72,
    magSize: 5,
    reloadMs: 2200,
    recoilPitch: 0.065,
    recoilYaw: 0.009,
    adsFov: 26,
    muzzleSpeed: 260,
    bulletGravity: 13,
    bulletRadius: 0.12,
    // Visual properties
    scale: { x: 0.5, y: 0.25, z: 3.2 },
    offset: { x: 0.25, y: 0.2, z: -0.4 },
    color: 0x3a4a5a,
  },

  // ---- Loot weapons: found on the map / dropped by fallen players ----
  // Each has its own mechanic (fields read by the fire pipeline):
  //   pellets/pelletSpread  — shotgun cone            (PUBG S686)
  //   burstCount/burstGapMs — 3-round burst per pull  (Valorant Bulldog)
  //   spinUpStartMs/Shots   — fire rate ramps up      (Valorant Odin)
  //   fan/fanAngle          — fixed 5-way fan          (Contra "S")
  //   pierce                — beam passes through N    (Contra "L")
  //   explosive             — splash damage on impact  (rocket launcher)
  shotgun: {
    key: "shotgun", label: "Pump Shotgun", fireMode: "semi", rarity: "rare", lootWeight: 3,
    pellets: 9, pelletSpread: 0.068,
    damage: 14, headMultiplier: 1.6, neckMultiplier: 1.3, armMultiplier: 0.8, legMultiplier: 0.7,
    baseSpread: 0, moveSpreadPerSpeed: 0.0006, sprintSpread: 0.012,
    fireIntervalMs: 850, range: 44, magSize: 6, reloadMs: 2600,
    recoilPitch: 0.075, recoilYaw: 0.022, adsFov: 64,
    muzzleSpeed: 140, bulletGravity: 14, bulletRadius: 0.14,
  },
  burst: {
    key: "burst", label: "Burst Rifle", fireMode: "burst", rarity: "rare", lootWeight: 3,
    burstCount: 3, burstGapMs: 70,
    damage: 35, headMultiplier: 2.3, neckMultiplier: 1.6, armMultiplier: 0.72, legMultiplier: 0.62,
    baseSpread: 0.0018, moveSpreadPerSpeed: 0.0008, sprintSpread: 0.013,
    fireIntervalMs: 320, range: 125, magSize: 24, reloadMs: 1900,
    recoilPitch: 0.024, recoilYaw: 0.01, adsFov: 54,
    muzzleSpeed: 170, bulletGravity: 20, bulletRadius: 0.15,
  },
  revolver: {
    key: "revolver", label: "Revolver", fireMode: "semi", rarity: "rare", lootWeight: 3,
    damage: 56, headMultiplier: 2.9, neckMultiplier: 1.8, armMultiplier: 0.75, legMultiplier: 0.65,
    baseSpread: 0.0012, moveSpreadPerSpeed: 0.0012, sprintSpread: 0.018,
    fireIntervalMs: 420, range: 95, magSize: 6, reloadMs: 2100,
    recoilPitch: 0.06, recoilYaw: 0.02, adsFov: 60,
    muzzleSpeed: 160, bulletGravity: 18, bulletRadius: 0.13,
  },
  lmg: {
    key: "lmg", label: "LMG", fireMode: "auto", rarity: "epic", lootWeight: 2,
    spinUpStartMs: 165, spinUpShots: 12,
    damage: 29, headMultiplier: 2.0, neckMultiplier: 1.5, armMultiplier: 0.7, legMultiplier: 0.6,
    baseSpread: 0.005, moveSpreadPerSpeed: 0.0014, sprintSpread: 0.022,
    fireIntervalMs: 72, range: 120, magSize: 100, reloadMs: 3600,
    recoilPitch: 0.017, recoilYaw: 0.02, adsFov: 60,
    muzzleSpeed: 160, bulletGravity: 20, bulletRadius: 0.17,
  },
  spread: {
    key: "spread", label: "Spread Gun", fireMode: "auto", rarity: "epic", lootWeight: 2,
    fan: 5, fanAngle: 0.1,
    damage: 17, headMultiplier: 1.5, neckMultiplier: 1.3, armMultiplier: 0.9, legMultiplier: 0.8,
    baseSpread: 0.002, moveSpreadPerSpeed: 0.0004, sprintSpread: 0.006,
    fireIntervalMs: 300, range: 75, magSize: 25, reloadMs: 1800,
    recoilPitch: 0.02, recoilYaw: 0.008, adsFov: 64,
    muzzleSpeed: 72, bulletGravity: 0, bulletRadius: 0.24,
  },
  laser: {
    key: "laser", label: "Laser Gun", fireMode: "auto", rarity: "legendary", lootWeight: 1.4,
    pierce: 3,
    damage: 44, headMultiplier: 1.8, neckMultiplier: 1.4, armMultiplier: 0.85, legMultiplier: 0.75,
    baseSpread: 0.001, moveSpreadPerSpeed: 0.0005, sprintSpread: 0.01,
    fireIntervalMs: 340, range: 210, magSize: 12, reloadMs: 2000,
    recoilPitch: 0.012, recoilYaw: 0.004, adsFov: 52,
    muzzleSpeed: 520, bulletGravity: 0, bulletRadius: 0.14,
  },
  launcher: {
    key: "launcher", label: "Rocket Launcher", fireMode: "semi", rarity: "legendary", lootWeight: 1,
    explosive: { radius: 6.5, damage: 115, selfScale: 0.5 },
    damage: 25, headMultiplier: 1, neckMultiplier: 1, armMultiplier: 1, legMultiplier: 1,
    baseSpread: 0.001, moveSpreadPerSpeed: 0.0008, sprintSpread: 0.02,
    fireIntervalMs: 900, range: 170, magSize: 2, reloadMs: 3000,
    recoilPitch: 0.09, recoilYaw: 0.02, adsFov: 58,
    muzzleSpeed: 48, bulletGravity: 3.5, bulletRadius: 0.25,
  },
};

// Every player spawns with these three slots; loot weapons swap into them.
const DEFAULT_SLOTS = ["rifle", "smg", "sniper"];
const LOOT_COUNT = 28; // weapons lying around the map at once
const LOOT_RESPAWN_MS = 45000; // a picked map spawn refills elsewhere after this
const DROPPED_WEAPON_TTL_MS = 120000;
const PICKUP_RADIUS = 2.6;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function randomInRange(min, max) {
  return min + Math.random() * (max - min);
}

function buildWorldLayout() {
  const props = [];
  const terrainPatches = [];
  const vehicles = [];
  let propId = 0;
  let vehicleId = 0;

  // py = base elevation of the prop. Props with a high base don't block ground
  // movement; props whose top is within step height act as walkable floors.
  // Buildings: every prop added between beginBuilding/endBuilding belongs to
  // that structure (destruction + collapse are tracked per building).
  const buildings = [];
  let currentBuilding = null;
  const beginBuilding = (kind, cx, cz, w, d, h, color, panelHp) => {
    currentBuilding = { id: `bld-${buildings.length}`, kind, x: cx, z: cz, w, d, h, color, panelHp, propIds: [] };
    buildings.push(currentBuilding);
  };
  // Roof slab cut into ~3m breakable tiles: shoot (or blast) a hole from above
  // or below and whoever stood on that tile drops into the room.
  const ROOF_TILE = 3.2;
  const addRoofTiles = (cx, cz, sx, sz, sy, color, py, hp) => {
    const nx = Math.max(1, Math.round(sx / ROOF_TILE));
    const nz = Math.max(1, Math.round(sz / ROOF_TILE));
    const tx = sx / nx;
    const tz = sz / nz;
    for (let i = 0; i < nx; i += 1) {
      for (let j = 0; j < nz; j += 1) {
        const tile = addProp(cx - sx / 2 + tx * (i + 0.5), cz - sz / 2 + tz * (j + 0.5), tx, sy, tz, "roof", color, true, py);
        tile.roofTile = true;
        tile.breakable = true;
        tile.side = null;
        tile.maxHp = hp;
      }
    }
  };

  // Furniture/fittings inside a building smash easily; lobby pillars are tough.
  const FURNITURE_HP = { table: 60, sofa: 60, bed: 60, cabinet: 70, crate: 50, lamp: 20, pillar: 700 };
  const endBuilding = () => {
    for (const p of props) {
      if (p.buildingId !== currentBuilding.id || !FURNITURE_HP[p.type]) continue;
      p.breakable = true;
      p.side = null;
      p.maxHp = FURNITURE_HP[p.type];
    }
    currentBuilding = null;
  };

  // Centimetre precision: keeps the join-time world meta compact (thousands
  // of props) and server/client collision use the very same numbers.
  const cm = (v) => Math.round(v * 100) / 100;
  const addProp = (x, z, sx, sy, sz, type = "crate", color = 0x7a7268, collidable = true, py = 0) => {
    x = cm(x);
    z = cm(z);
    sx = cm(sx);
    sy = cm(sy);
    sz = cm(sz);
    py = cm(py);
    const prop = { id: `prop-${propId++}`, x, y: py + sy / 2, z, sx, sy, sz, py, type, color, collidable };
    if (currentBuilding) {
      prop.buildingId = currentBuilding.id;
      currentBuilding.propIds.push(prop.id);
    }
    props.push(prop);
    return prop;
  };

  const addVehicle = (x, z, yaw = 0, color = 0x2f6f9f, type = "car") => {
    vehicles.push({
      id: `${type}-${vehicleId++}`,
      type,
      x,
      y: 0,
      z,
      yaw,
      vx: 0,
      vy: 0,
      vz: 0,
      speed: 0,
      steer: 0,
      tilt: 0,
      color,
      driverId: null,
      passengerId: null,
      engineOn: false,
      fuel: 100,
      health: 100,
      destroyed: false,
    });
  };

  const WALL_H = 3.4;
  const WALL_T = 0.42;
  const buildingRects = [];

  // Darken a hex color (for roof slabs / trim relative to a wall color).
  const darkenHex = (hex, f = 0.72) => {
    const r = Math.round(((hex >> 16) & 0xff) * f);
    const g = Math.round(((hex >> 8) & 0xff) * f);
    const b = Math.round((hex & 0xff) * f);
    return (r << 16) | (g << 8) | b;
  };

  // A run of wall along X (horiz) or Z, optionally punctured by door/window
  // openings. Openings are given as center offsets (from the run center).
  // side: which outer face of the current building this run is ("+z", "-z",
  // "+x", "-x"), or null for interior partitions. Solid spans are cut into
  // ~3m breakable panels so a car or rocket knocks out a section, not a wall.
  const PANEL_LEN = 3.0;
  const breakableWall = (prop, side) => {
    if (!currentBuilding) return prop;
    prop.breakable = true;
    prop.side = side;
    prop.maxHp = currentBuilding.panelHp * (prop.sy / WALL_H > 1.4 ? 1.6 : 1);
    return prop;
  };
  const wallRun = (cx, cz, len, horiz, openings, color, wallHeight = WALL_H, side = null) => {
    const spans = [];
    const sorted = [...openings].sort((a, b) => a.at - b.at);
    let cursor = -len / 2;
    for (const open of sorted) {
      const start = open.at - open.w / 2;
      if (start - cursor > 0.15) spans.push([cursor, start, null]);
      spans.push([start, open.at + open.w / 2, open]);
      cursor = open.at + open.w / 2;
    }
    if (len / 2 - cursor > 0.15) spans.push([cursor, len / 2, null]);

    for (const [s0, s1, open] of spans) {
      const segLen = s1 - s0;
      const mx = horiz ? cx + (s0 + s1) / 2 : cx;
      const mz = horiz ? cz : cz + (s0 + s1) / 2;
      const sx = horiz ? segLen : WALL_T;
      const sz = horiz ? WALL_T : segLen;
      if (!open) {
        const pieces = Math.max(1, Math.round(segLen / PANEL_LEN));
        const pLen = segLen / pieces;
        for (let i = 0; i < pieces; i += 1) {
          const off = s0 + pLen * (i + 0.5);
          const px = horiz ? cx + off : cx;
          const pz = horiz ? cz : cz + off;
          breakableWall(addProp(px, pz, horiz ? pLen : WALL_T, wallHeight, horiz ? WALL_T : pLen, "wall", color, true, 0), side);
        }
      } else if (open.type === "window") {
        // Sill blocks walking, gap above lets bullets through, lintel closes the top.
        breakableWall(addProp(mx, mz, sx, 1.05, sz, "wall", color, true, 0), side);
        addProp(mx, mz, horiz ? segLen : WALL_T * 0.4, 1.15, horiz ? WALL_T * 0.4 : segLen, "glass", 0xbfe3ff, false, 1.05);
        breakableWall(addProp(mx, mz, sx, wallHeight - 2.2, sz, "wall", color, true, 2.2), side);
      } else {
        // Door: open gap with a lintel above head height.
        breakableWall(addProp(mx, mz, sx, wallHeight - 2.35, sz, "wall", color, true, 2.35), side);
        addProp(mx, mz, horiz ? segLen + 0.3 : WALL_T + 0.25, 0.08, horiz ? WALL_T + 0.25 : segLen + 0.3, "door-threshold", 0x4e4b45, false, 0);
      }
    }
  };

  const addBuilding = (cx, cz, w, d, opts = {}) => {
    const {
      wallColor = 0x9a917f,
      roofColor = 0x66584a,
      floorColor = 0x8a6f4d,
      roofAccess = false,
      rooms = 2,
    } = opts;
    buildingRects.push({ x: cx, z: cz, hw: w / 2 + 4, hd: d / 2 + 4 });
    beginBuilding("house", cx, cz, w, d, WALL_H + 0.3, wallColor, 240);
    const doorW = 2.0;
    const winW = 2.6;

    // Front (south, +z): door slightly left, window right.
    wallRun(cx, cz + d / 2, w, true, [
      { at: -w * 0.18, w: doorW, type: "door" },
      { at: w * 0.26, w: winW, type: "window" },
    ], wallColor, WALL_H, "+z");
    // Back (north): two windows.
    wallRun(cx, cz - d / 2, w, true, [
      { at: -w * 0.25, w: winW, type: "window" },
      { at: w * 0.25, w: winW, type: "window" },
    ], wallColor, WALL_H, "-z");
    // Sides: one window each, west side gets a back door for flanking.
    wallRun(cx - w / 2, cz, d, false, [
      { at: -d * 0.2, w: winW, type: "window" },
      { at: d * 0.24, w: doorW, type: "door" },
    ], wallColor, WALL_H, "-x");
    wallRun(cx + w / 2, cz, d, false, [
      { at: d * 0.1, w: winW, type: "window" },
    ], wallColor, WALL_H, "+x");

    // Interior floor + partition wall(s) creating rooms with door gaps.
    addProp(cx, cz, w - WALL_T, 0.07, d - WALL_T, "floor", floorColor, false, 0.015);
    wallRun(cx, cz - d * 0.08, w - WALL_T * 2, true, [
      { at: w * 0.2, w: 1.8, type: "door" },
    ], 0x8b8171);
    if (rooms >= 3) {
      const backD = d * 0.42 - WALL_T;
      wallRun(cx - w * 0.12, cz - d * 0.08 - backD / 2 - 0.2, backD - 1, false, [
        { at: -backD * 0.16, w: 1.7, type: "door" },
      ], 0x8b8171);
    }

    // Roof slab + interior ceiling lamp.
    addRoofTiles(cx, cz, w + 0.6, d + 0.6, 0.3, roofColor, WALL_H, 150);
    if (!roofAccess) {
      const pitched = addProp(cx, cz, w + 1.8, Math.min(w, d) * 0.36, d + 1.8, "hiproof", roofColor, false, WALL_H + 0.3);
      pitched.style = "western";
    }
    addProp(cx + w * 0.15, cz + d * 0.2, 1.3, 0.09, 1.3, "ceilinglamp", 0xfff2c4, false, WALL_H - 0.16);
    addProp(cx - w * 0.2, cz - d * 0.25, 1.3, 0.09, 1.3, "ceilinglamp", 0xfff2c4, false, WALL_H - 0.16);

    if (roofAccess) {
      // Exterior staircase on the east side up to the roof; parapet with a gap there.
      const stepCount = 8;
      const stepRise = (WALL_H + 0.3) / stepCount;
      const stepDepth = 0.9;
      const sxOff = cx + w / 2 + 1.15;
      for (let i = 0; i < stepCount; i += 1) {
        addProp(sxOff, cz + d / 2 - 0.7 - i * stepDepth, 1.9, stepRise * (i + 1), stepDepth, "stairs", 0x7d7365, true, 0);
      }
      // Parapets (blocking rails) around three roof edges.
      addProp(cx, cz - d / 2 - 0.15, w + 0.6, 0.95, 0.3, "wall", roofColor, true, WALL_H + 0.3);
      addProp(cx, cz + d / 2 + 0.15, w + 0.6, 0.95, 0.3, "wall", roofColor, true, WALL_H + 0.3);
      addProp(cx - w / 2 - 0.15, cz, 0.3, 0.95, d + 0.6, "wall", roofColor, true, WALL_H + 0.3);
      addProp(cx + w / 2 + 0.15, cz - d * 0.25, 0.3, 0.95, d * 0.5, "wall", roofColor, true, WALL_H + 0.3);
      // Cover crate on the roof.
      addProp(cx - w * 0.2, cz + d * 0.15, 1.6, 1.1, 1.6, "crate", 0x8a6d43, true, WALL_H + 0.3);
    }

    // Furniture: blocking cover + decorative pieces.
    addProp(cx - w * 0.28, cz + d * 0.22, 2.0, 0.85, 1.0, "table", 0x6e4f35, true);
    addProp(cx - w * 0.34, cz - d * 0.32, 1.5, 1.9, 0.6, "cabinet", 0x5b4634, true);
    addProp(cx + w * 0.3, cz + d * 0.32, 2.2, 0.75, 0.95, "sofa", 0x35546a, true);
    addProp(cx + w * 0.32, cz - d * 0.3, 2.1, 0.6, 1.5, "bed", 0x7c5a4a, true);
    addProp(cx + w * 0.1, cz - d * 0.35, 0.5, 1.6, 0.5, "lamp", 0xf3c77a, false);
    addProp(cx - w * 0.1, cz + d * 0.35, 1.1, 1.0, 1.1, "crate", 0x8a6d43, true);
    addProp(cx, cz + d * 0.2, 2.6, 0.02, 1.8, "rug", 0x7a3b33, false, 0.06);
    endBuilding();
  };

  // ===========================================================================
  // CITY LAYOUT — a dense urban grid: roads + sidewalks, downtown office towers,
  // apartment blocks, enterable houses, a shopping strip, a park w/ playground,
  // a parking lot, a construction site, a crashed airliner, and street props.
  // Solid towers use ONE collidable footprint box (cheap) with a rich client
  // facade; enterable houses keep their detailed interiors.
  // ===========================================================================

  // ---- City structure helpers ----

  // Apartment/office block — ENTERABLE. A glass ground-floor lobby you can walk
  // into (doors on two sides, windows, interior cover) with the tower mass
  // rising above it; the client draws the window-band facade on the upper mass.
  const LOBBY_H = 6.6;
  const addTower = (cx, cz, w, d, h, opts = {}) => {
    const { color = 0x8b93a1, kind = "office", face = 0, style = kind === "office" ? "bands" : "grid", roof = "plant", annex = null } = opts;
    buildingRects.push({ x: cx, z: cz, hw: w / 2 + 2, hd: d / 2 + 2 });
    beginBuilding(kind, cx, cz, w, d, h, color, 330);

    // Lobby perimeter: entrance door on front (+z) and west (-x), windows all round.
    wallRun(cx, cz + d / 2, w, true, [
      { at: 0, w: 3.4, type: "door" },
      { at: -w * 0.32, w: 3.2, type: "window" },
      { at: w * 0.32, w: 3.2, type: "window" },
    ], color, LOBBY_H, "+z");
    wallRun(cx, cz - d / 2, w, true, [
      { at: -w * 0.28, w: 3.2, type: "window" },
      { at: w * 0.28, w: 3.2, type: "window" },
    ], color, LOBBY_H, "-z");
    wallRun(cx - w / 2, cz, d, false, [
      { at: 0, w: 3.0, type: "door" },
      { at: d * 0.32, w: 3.0, type: "window" },
    ], color, LOBBY_H, "-x");
    wallRun(cx + w / 2, cz, d, false, [
      { at: -d * 0.3, w: 3.0, type: "window" },
      { at: d * 0.3, w: 3.0, type: "window" },
    ], color, LOBBY_H, "+x");

    // Lobby floor + ceiling (ceiling doubles as the base slab for the mass above).
    addProp(cx, cz, w - WALL_T, 0.08, d - WALL_T, "floor", 0x6b6f74, false, 0.02);
    addProp(cx, cz, w, 0.45, d, "roof", darkenHex(color), true, LOBBY_H);
    addProp(cx + w * 0.16, cz + d * 0.18, 1.2, 0.09, 1.2, "ceilinglamp", 0xfff2c4, false, LOBBY_H - 0.2);
    addProp(cx - w * 0.2, cz - d * 0.2, 1.2, 0.09, 1.2, "ceilinglamp", 0xfff2c4, false, LOBBY_H - 0.2);

    // Lobby interior: reception desk + two structural pillars (cover).
    addProp(cx, cz - d * 0.22, Math.min(w * 0.5, 6), 1.1, 1.2, "table", 0x4a3f33, true);
    for (const px of [-w * 0.26, w * 0.26]) {
      addProp(cx + px, cz + d * 0.05, 0.9, LOBBY_H, 0.9, "pillar", 0x7c7466, true);
    }

    // Tower mass above the lobby — solid, with the window-band facade.
    const upperH = Math.max(2.5, h - LOBBY_H - 0.45);
    const t = addProp(cx, cz, w, upperH, d, "tower", color, true, LOBBY_H + 0.45);
    t.kind = kind;
    t.face = face;
    t.style = style; // facade: bands | curtain | grid | setback | deco
    t.roofKit = roof; // rooftop: plant | helipad | watertower | garden | antenna
    // Optional lower wing (L / T-shaped massing): a solid mass beside the lobby.
    if (annex) {
      buildingRects.push({ x: cx + annex.dx, z: cz + annex.dz, hw: annex.w / 2 + 2, hd: annex.d / 2 + 2 });
      const a = addProp(cx + annex.dx, cz + annex.dz, annex.w, annex.h, annex.d, "tower", annex.color || color, true, 0);
      a.kind = kind;
      a.face = face;
      a.style = annex.style || (kind === "office" ? "curtain" : "grid");
      a.roofKit = annex.roof || "garden";
    }
    endBuilding();
    return t;
  };

  // Supertall landmark (Burj Khalifa style). A walk-in glass podium lobby
  // whose walls can be broken like any tower (just much tougher), and above it
  // a stack of setback tiers ending in a spire — ~200m, five times the next
  // tallest tower. Tier boxes are the collision volume (aircraft hit them);
  // the client draws the Y-shaped three-wing massing inside each box.
  const addSupertall = (cx, cz) => {
    const W = 36;
    const PODIUM_H = 8.5;
    const TIERS = 9;
    const TIER_H = 19;
    const height = PODIUM_H + 0.5 + TIERS * TIER_H;
    const color = 0xb7c3cf;
    buildingRects.push({ x: cx, z: cz, hw: W / 2 + 6, hd: W / 2 + 6 });
    beginBuilding("supertall", cx, cz, W, W, height, color, 700);
    wallRun(cx, cz + W / 2, W, true, [
      { at: 0, w: 4.4, type: "door" },
      { at: -W * 0.3, w: 4.0, type: "window" },
      { at: W * 0.3, w: 4.0, type: "window" },
    ], color, PODIUM_H, "+z");
    wallRun(cx, cz - W / 2, W, true, [
      { at: 0, w: 4.4, type: "door" },
      { at: -W * 0.3, w: 4.0, type: "window" },
      { at: W * 0.3, w: 4.0, type: "window" },
    ], color, PODIUM_H, "-z");
    wallRun(cx - W / 2, cz, W, false, [{ at: -W * 0.25, w: 4.0, type: "window" }, { at: W * 0.25, w: 4.0, type: "window" }], color, PODIUM_H, "-x");
    wallRun(cx + W / 2, cz, W, false, [{ at: -W * 0.25, w: 4.0, type: "window" }, { at: W * 0.25, w: 4.0, type: "window" }], color, PODIUM_H, "+x");
    addProp(cx, cz, W - WALL_T, 0.08, W - WALL_T, "floor", 0x5f6368, false, 0.02);
    addProp(cx, cz, W + 1, 0.5, W + 1, "roof", 0x8d96a0, true, PODIUM_H);
    // Lobby: core columns + reception (cover).
    for (const [px, pz] of [[-7, -7], [7, -7], [-7, 7], [7, 7]]) addProp(cx + px, cz + pz, 1.4, PODIUM_H, 1.4, "pillar", 0x9aa3ad, true);
    addProp(cx, cz - 4, 8, 1.1, 1.4, "table", 0x3d4248, true);
    addProp(cx + 6, cz + 9, 1.2, 0.09, 1.2, "ceilinglamp", 0xfff2c4, false, PODIUM_H - 0.2);
    addProp(cx - 6, cz - 9, 1.2, 0.09, 1.2, "ceilinglamp", 0xfff2c4, false, PODIUM_H - 0.2);
    // Setback tiers: each a little smaller, the short wing spiralling round.
    for (let i = 0; i < TIERS; i += 1) {
      const reach = 17 * (1 - (i / TIERS) * 0.78);
      const tier = addProp(cx, cz, reach * 2, TIER_H, reach * 2, "supertall", color, true, PODIUM_H + 0.5 + i * TIER_H);
      tier.tier = i;
      tier.tiers = TIERS;
      tier.reach = reach;
    }
    const spire = addProp(cx, cz, 1.6, 34, 1.6, "spire", 0xd5dbe0, true, height);
    spire.tiers = TIERS;
    endBuilding();
  };

  // Storefront — ENTERABLE single-storey unit. Glass front with a wide doorway,
  // a back door for flanking, interior counter + shelving, flat roof + sign.
  const SHOP_H = 4.2;
  const addShop = (cx, cz, w, d, opts = {}) => {
    const { color = 0xb8a98c, sign = 0xcf5b48, face = 0 } = opts;
    buildingRects.push({ x: cx, z: cz, hw: w / 2 + 1.5, hd: d / 2 + 1.5 });
    beginBuilding("shop", cx, cz, w, d, SHOP_H + 0.4, color, 220);
    // Front storefront (+z): big entrance flanked by display windows.
    wallRun(cx, cz + d / 2, w, true, [
      { at: 0, w: 3.6, type: "door" },
      { at: -w * 0.34, w: 3.0, type: "window" },
      { at: w * 0.34, w: 3.0, type: "window" },
    ], color, SHOP_H, "+z");
    wallRun(cx, cz - d / 2, w, true, [{ at: w * 0.3, w: 2.0, type: "door" }], color, SHOP_H, "-z"); // back door
    wallRun(cx - w / 2, cz, d, false, [{ at: 0, w: 2.6, type: "window" }], color, SHOP_H, "-x");
    wallRun(cx + w / 2, cz, d, false, [{ at: 0, w: 2.6, type: "window" }], color, SHOP_H, "+x");
    addProp(cx, cz, w - WALL_T, 0.08, d - WALL_T, "floor", 0x7a6a52, false, 0.02);
    addRoofTiles(cx, cz, w + 0.4, d + 0.4, 0.4, darkenHex(color), SHOP_H, 170);
    // Awning + illuminated sign band across the storefront.
    const awn = addProp(cx, cz + d / 2 + 0.55, w * 0.9, 0.16, 1.5, "awning", sign, false, SHOP_H - 1.3);
    awn.face = face;
    const s = addProp(cx, cz + d / 2 + 0.06, w * 0.82, 0.75, 0.15, "shopsign", sign, false, SHOP_H - 0.55);
    s.face = face;
    // Interior fittings (cover).
    addProp(cx, cz - d * 0.26, w * 0.66, 1.0, 0.8, "table", 0x6e4f35, true); // counter
    addProp(cx - w * 0.32, cz + d * 0.06, 0.8, 2.3, d * 0.5, "cabinet", 0x5b4634, true); // shelves
    addProp(cx + w * 0.32, cz + d * 0.06, 0.8, 2.3, d * 0.5, "cabinet", 0x5b4634, true);
    endBuilding();
    return s;
  };

  // Static street vehicles (props, not drivable). alongZ orients the long axis.
  const addStreetVehicle = (type, cx, cz, alongZ, color, len, wide, tall) => {
    const sx = alongZ ? wide : len;
    const sz = alongZ ? len : wide;
    const v = addProp(cx, cz, sx, tall, sz, type, color, true, 0);
    v.alongZ = alongZ;
    return v;
  };
  const addBus = (cx, cz, alongZ, color = 0x2f6f9f) => addStreetVehicle("bus", cx, cz, alongZ, color, 12, 3.0, 3.2);
  const addTruck = (cx, cz, alongZ, color = 0x8a4a3a) => addStreetVehicle("truck", cx, cz, alongZ, color, 9.5, 3.0, 3.4);
  const addParkedCar = (cx, cz, alongZ, color = 0x555a63) => addStreetVehicle("parkedcar", cx, cz, alongZ, color, 4.6, 2.2, 1.55);

  const addTrafficLight = (cx, cz, face = 0) => {
    const t = addProp(cx, cz, 0.4, 5.4, 0.4, "trafficlight", 0x24272b, true, 0);
    t.face = face;
  };
  const addSign = (cx, cz, kind = "warn", face = 0) => {
    const s = addProp(cx, cz, 0.28, 3.0, 0.28, "roadsign", 0x9aa0a6, true, 0);
    s.kind = kind;
    s.face = face;
  };
  const addBillboard = (cx, cz, alongZ = false, color = 0x2b2e31) => {
    const spread = 3.4;
    if (alongZ) {
      addProp(cx, cz - spread, 0.4, 6.5, 0.4, "post", 0x3a3d42, true, 0);
      addProp(cx, cz + spread, 0.4, 6.5, 0.4, "post", 0x3a3d42, true, 0);
      const b = addProp(cx, cz, 0.5, 3.4, spread * 2 + 1.6, "billboard", color, false, 6.3);
      b.alongZ = true;
    } else {
      addProp(cx - spread, cz, 0.4, 6.5, 0.4, "post", 0x3a3d42, true, 0);
      addProp(cx + spread, cz, 0.4, 6.5, 0.4, "post", 0x3a3d42, true, 0);
      const b = addProp(cx, cz, spread * 2 + 1.6, 3.4, 0.5, "billboard", color, false, 6.3);
      b.alongZ = false;
    }
  };
  const addBusStop = (cx, cz, face = 0) => {
    const s = addProp(cx, cz, 4.4, 0.4, 0.35, "busstop", 0x35507a, true, 0);
    s.face = face;
  };
  const addBin = (cx, cz) => addProp(cx, cz, 0.8, 1.1, 0.8, "trashbin", 0x2f6f4f, true);
  const addHydrant = (cx, cz) => addProp(cx, cz, 0.5, 0.9, 0.5, "hydrant", 0xd23b2f, true);
  const addCone = (cx, cz) => addProp(cx, cz, 0.5, 0.7, 0.5, "cone", 0xe8721c, false);
  const addPlanter = (cx, cz) => addProp(cx, cz, 1.4, 0.9, 1.4, "planter", 0x6b5a44, true);

  // ---- Road grid + sidewalks (flat terrain patches, no collision) ----
  const ROADS = [-220, -110, 0, 110, 220];
  const CITY = 660;
  terrainPatches.push(
    { x: 0, z: 0, sx: 3400, sz: 3400, color: 0x3d5530 },                 // countryside base
    { x: 0, z: 0, sx: CITY, sz: CITY, color: 0x45592f },                 // city ground
    { x: -250, z: 0, sx: 42, sz: 1280, color: 0x2e6b8f, type: "river" }, // river (N-S)
    { x: 250, z: -250, sx: 150, sz: 120, color: 0x2d6484, type: "lake" },
    { x: 250, z: -250, sx: 172, sz: 142, color: 0xc9b98a, type: "sand" },
  );
  for (const c of ROADS) {
    const w = c === 0 ? 16 : 11;
    const roadColor = c === 0 ? 0x4e5157 : 0x54585e;
    terrainPatches.push({ x: c, z: 0, sx: w + 8, sz: CITY, color: 0x8b9094, type: "sidewalk" });
    terrainPatches.push({ x: c, z: 0, sx: w, sz: CITY, color: roadColor, type: "road" });
    terrainPatches.push({ x: 0, z: c, sx: CITY, sz: w + 8, color: 0x8b9094, type: "sidewalk" });
    terrainPatches.push({ x: 0, z: c, sx: CITY, sz: w, color: roadColor, type: "road" });
  }

  // Bridges: guard rails where the river crosses E-W roads.
  for (const bz of ROADS) {
    addProp(-250, bz - 9, 46, 1.0, 0.4, "fence", 0x6b6a66, true);
    addProp(-250, bz + 9, 46, 1.0, 0.4, "fence", 0x6b6a66, true);
  }

  // ---- Downtown: four office towers around the central intersection ----
  // Each one different: glass curtain wall, art-deco setbacks, ribbon bands...
  addTower(-55, -55, 30, 26, 44, { color: 0x3e5470, kind: "office", face: Math.PI * 0.5, style: "curtain", roof: "helipad",
    annex: { dx: -6, dz: 21, w: 18, d: 12, h: 12, style: "curtain", color: 0x55687e } });
  addTower(55, -55, 30, 28, 52, { color: 0xb9ad94, kind: "office", face: -Math.PI * 0.5, style: "deco", roof: "antenna" });
  addTower(-55, 55, 26, 30, 27, { color: 0x7f8894, kind: "office", face: Math.PI, style: "bands", roof: "garden",
    annex: { dx: 20, dz: 4, w: 12, d: 22, h: 16, style: "bands" } });
  addTower(55, 55, 32, 30, 38, { color: 0x6d7f8c, kind: "office", face: 0, style: "setback", roof: "watertower" });
  addBillboard(55, 39, false, 0x203a5c); // rooftop-ish billboard by downtown

  // ---- Landmark supertall on the east edge (visible from everywhere) ----
  addSupertall(275, -55);

  // ---- Apartment blocks (mid-rise) on the mid ring ----
  addTower(165, -55, 26, 40, 20, { color: 0xa0623e, kind: "apartment", face: -Math.PI * 0.5, style: "grid", roof: "watertower" }); // brick
  addTower(-165, -55, 24, 40, 18, { color: 0xc9c0ad, kind: "apartment", face: Math.PI * 0.5, style: "bands", roof: "garden" });
  addTower(165, 55, 26, 38, 26, { color: 0x8a9a8c, kind: "apartment", face: -Math.PI * 0.5, style: "setback", roof: "plant" });
  addTower(-165, 55, 24, 36, 15, { color: 0xb07a52, kind: "apartment", face: Math.PI * 0.5, style: "grid", roof: "plant",
    annex: { dx: 0, dz: -24, w: 24, d: 8, h: 9, style: "grid" } });

  // ---- Outer-ring blocks: more skyline variety ----
  addTower(-55, 275, 28, 24, 30, { color: 0x4a6a78, kind: "office", face: Math.PI, style: "curtain", roof: "antenna" });
  addTower(55, 275, 24, 24, 24, { color: 0xd0c4a8, kind: "office", face: Math.PI, style: "deco", roof: "plant" });
  addTower(-165, 275, 30, 22, 16, { color: 0x9a5a3c, kind: "apartment", face: Math.PI, style: "grid", roof: "watertower" });
  addTower(275, 55, 24, 30, 34, { color: 0x5f6f7f, kind: "office", face: -Math.PI * 0.5, style: "setback", roof: "helipad" });
  addTower(275, 165, 22, 26, 20, { color: 0xbfb6a2, kind: "apartment", face: -Math.PI * 0.5, style: "bands", roof: "garden" });

  // ---- Residential houses (enterable) along the north row (z = 165) ----
  addBuilding(-165, 165, 18, 14, { rooms: 3, roofAccess: true, wallColor: 0xb0a48e });
  addBuilding(-55, 165, 16, 12, { rooms: 2, wallColor: 0x9a917f });
  addBuilding(55, 165, 17, 13, { rooms: 3, wallColor: 0x8f8b80 });
  addBuilding(165, 165, 16, 12, { roofAccess: true, wallColor: 0xa39781, roofColor: 0x705c48 });
  addBuilding(55, -165, 15, 12, { rooms: 2, roofAccess: true, wallColor: 0xa8988a });

  // ---- Shopping strip: storefronts facing the z=110 road (front = +z) ----
  for (let i = 0; i < 6; i += 1) {
    const sx = -90 + i * 36;
    if (Math.abs(sx) < 12) continue; // clear the N-S main road
    addShop(sx, 98, 16, 10, {
      color: [0xbf9f6f, 0xa8b0b6, 0xc48f7a, 0x8fa07a, 0xb0a0c0, 0xc0b070][i],
      sign: [0xcf5b48, 0x2f8f9f, 0xe0a020, 0x9f3c72, 0x3f8f4f, 0xd2681c][i],
      face: 0,
    });
    addBin(sx + 8, 92);
  }
  addBillboard(-90, 108, false, 0x7a2f2f);

  // ---- Park + playground (block at -55, -165) ----
  const park = { x: -55, z: -165 };
  terrainPatches.push({ x: park.x, z: park.z, sx: 82, sz: 82, color: 0x4f7a3d, type: "meadow" });
  terrainPatches.push({ x: park.x + 22, z: park.z - 20, sx: 26, sz: 22, color: 0x2d6484, type: "lake" }); // pond
  terrainPatches.push({ x: park.x - 18, z: park.z + 14, sx: 14, sz: 14, color: 0xd8c48a, type: "sand" }); // sandbox
  // Playground equipment.
  addProp(park.x - 18, park.z + 14, 2.2, 2.6, 4.6, "slide", 0xd94f4f, true, 0);
  addProp(park.x - 26, park.z + 8, 0.2, 2.8, 0.2, "post", 0x6a4a2a, true, 0);
  addProp(park.x - 21, park.z + 8, 0.2, 2.8, 0.2, "post", 0x6a4a2a, true, 0);
  const swingBar = addProp(park.x - 23.5, park.z + 8, 5.0, 0.2, 0.2, "swingbar", 0x7a5a2a, false, 2.7);
  swingBar.alongZ = false;
  addProp(park.x - 10, park.z + 20, 3.0, 1.2, 3.0, "roundabout", 0x3f7f9f, true, 0);
  // Fountain in the park center.
  addProp(park.x + 2, park.z + 2, 4.5, 0.8, 4.5, "fountain", 0x8f96a0, true, 0);
  for (const [bx, bz] of [[park.x - 30, park.z - 10], [park.x + 12, park.z + 24], [park.x + 28, park.z + 6]]) {
    addProp(bx, bz, 1.9, 0.55, 0.6, "bench", 0x6e5433, true);
  }
  for (const [tx, tz] of [[park.x - 32, park.z + 30], [park.x + 30, park.z - 30], [park.x + 34, park.z + 28], [park.x - 5, park.z - 30]]) {
    addProp(tx, tz, 1.4, randomInRange(8, 11), 1.4, "tree", 0x2f5e23, true);
  }

  // ---- Parking lot (block at -165, -165) with static vehicles ----
  const lot = { x: -165, z: -165 };
  terrainPatches.push({ x: lot.x, z: lot.z, sx: 82, sz: 82, color: 0x4c4f54, type: "lot" });
  for (let r = 0; r < 2; r += 1) {
    for (let cIdx = 0; cIdx < 5; cIdx += 1) {
      const px = lot.x - 32 + cIdx * 16;
      const pz = lot.z - 16 + r * 32;
      if (Math.random() < 0.35) continue; // some empty stalls
      const palette = [0x9f3c32, 0x2f6f9f, 0xc2b03a, 0x3f8f5f, 0x7a4a9f, 0xb0b0b8];
      addParkedCar(px, pz, false, palette[Math.floor(Math.random() * palette.length)]);
    }
  }
  addTruck(lot.x + 26, lot.z + 26, true, 0x556a8a);
  addTruck(lot.x - 28, lot.z + 24, true, 0x8a6a3a);

  // ---- Construction site (block at 165, -165) ----
  const cons = { x: 165, z: -165 };
  terrainPatches.push({ x: cons.x, z: cons.z, sx: 80, sz: 80, color: 0x7a6f57, type: "dirt" });
  // Scaffold tower (4 posts + platform bands).
  for (const [ox, oz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
    addProp(cons.x + ox, cons.z + oz, 0.3, 14, 0.3, "scaffold", 0x8a7a3a, true, 0);
  }
  for (let lvl = 1; lvl <= 3; lvl += 1) {
    addProp(cons.x, cons.z, 7, 0.3, 7, "scaffoldplank", 0x9a8a4a, false, lvl * 4);
  }
  // Tower crane.
  addProp(cons.x - 24, cons.z + 20, 1.8, 30, 1.8, "cranemast", 0xf0c020, true, 0);
  const jib = addProp(cons.x - 24, cons.z + 8, 2.2, 1.0, 26, "cranejib", 0xf0c020, false, 29);
  jib.alongZ = true;
  // Materials + barriers + porta-cabins + containers.
  addProp(cons.x + 20, cons.z - 18, 7, 2.4, 7, "gravelpile", 0x9a8f7a, true, 0);
  addProp(cons.x + 8, cons.z - 22, 6, 2.0, 6, "gravelpile", 0x8a7f6a, true, 0);
  for (let i = 0; i < 4; i += 1) addProp(cons.x - 30 + i * 4, cons.z - 30, 3.6, 1.1, 0.6, "barrier", 0xd2a02f, true);
  addProp(cons.x + 24, cons.z + 20, 1.5, 2.5, 1.5, "porta", 0x2f8f6f, true);
  addProp(cons.x + 27, cons.z + 20, 1.5, 2.5, 1.5, "porta", 0x2f6f8f, true);
  const consContainers = [[cons.x - 8, cons.z + 26, 0x8a4a3a], [cons.x + 4, cons.z + 28, 0x3f6f8a], [cons.x - 8, cons.z + 22, 0x6f8a3f]];
  for (const [ccx, ccz, col] of consContainers) addProp(ccx, ccz, 8.2, 2.9, 3.2, "container", col, true);

  // ---- Crashed airliner in the open field (SE) ----
  const plane = { x: 232, z: 232 };
  terrainPatches.push({ x: plane.x, z: plane.z, sx: 90, sz: 60, color: 0x2f2a26, type: "scorch" });
  // Fuselage broken into two sections (long axis = x).
  const fuse1 = addProp(plane.x - 8, plane.z, 24, 5.4, 5.4, "plane-fuselage", 0xdfe3e8, true, 0.3);
  fuse1.alongZ = false;
  fuse1.section = "front";
  const fuse2 = addProp(plane.x + 18, plane.z + 4, 13, 4.8, 5.0, "plane-fuselage", 0xdfe3e8, true, 0.3);
  fuse2.alongZ = false;
  fuse2.section = "rear";
  // Wings (span along z), one still attached, one sheared off.
  addProp(plane.x - 4, plane.z - 14, 9, 1.1, 22, "plane-wing", 0xc8ced4, true, 1.4);
  addProp(plane.x - 1, plane.z + 15, 8, 0.9, 17, "plane-wing", 0xc8ced4, true, 0.5);
  // Tail fin + engines + debris.
  addProp(plane.x - 21, plane.z, 3.5, 8, 5, "plane-tail", 0xc45a44, true, 0);
  addProp(plane.x - 2, plane.z - 24, 2.8, 2.4, 3.4, "plane-engine", 0x3a3d42, true, 0);
  addProp(plane.x + 30, plane.z - 6, 2.4, 2.0, 3.0, "plane-engine", 0x3a3d42, true, 0);
  for (const [dx, dz] of [[plane.x + 12, plane.z - 12], [plane.x - 16, plane.z + 16], [plane.x + 28, plane.z + 10]]) {
    addProp(dx, dz, randomInRange(1.4, 2.2), randomInRange(0.8, 1.4), randomInRange(1.4, 2.2), "debris", 0x8a8f94, true);
  }

  // ---- Street furniture along the sidewalks ----
  // Streetlights lining every road.
  for (const along of ROADS) {
    for (let s = -240; s <= 240; s += 60) {
      if (Math.abs(s) < 14) continue;
      // lights beside N-S road at x=along
      addProp(along + (along <= 0 ? -8.5 : 8.5), s, 0.35, 4.8, 0.35, "streetlight", 0x2b2e31, true);
      // lights beside E-W road at z=along
      addProp(s, along + (along <= 0 ? -8.5 : 8.5), 0.35, 4.8, 0.35, "streetlight", 0x2b2e31, true);
    }
  }
  // Traffic lights + signs at major intersections.
  for (const ix of [-110, 0, 110]) {
    for (const iz of [-110, 0, 110]) {
      addTrafficLight(ix + 9, iz + 9, Math.atan2(-ix - 9, -iz - 9));
      if ((ix + iz) % 220 === 0) addSign(ix - 9, iz - 9, "warn", 0);
    }
  }
  // Bus stops + buses on the main roads.
  addBusStop(-9, -70, 0);
  addBusStop(9, 130, Math.PI);
  addBusStop(-70, 9, Math.PI * 0.5);
  addBus(-19, -70, true, 0x2f6f9f);
  addBus(20, 130, true, 0xc23b2f);
  addBus(-70, 20, false, 0x3f8f5f);
  // Trucks + a couple street cars parked roadside.
  addTruck(120, -8, false, 0x6a6f8a);
  addTruck(-8, 205, true, 0x8a5a3a);
  addParkedCar(9, -40, true, 0x9f3c32);
  addParkedCar(-9, 44, true, 0x2f6f9f);
  // Hydrants, bins, planters, cones dotted along sidewalks.
  for (let i = 0; i < 14; i += 1) {
    const along = ROADS[Math.floor(Math.random() * ROADS.length)];
    const s = randomInRange(-240, 240);
    if (Math.abs(s) < 16) continue;
    const side = Math.random() < 0.5;
    addHydrant(side ? along + 8 : s, side ? s : along + 8);
  }
  for (const [bx, bz] of [[15, -95], [-15, 95], [95, 15], [-95, -15], [125, 125], [-125, -125], [15, 205], [205, 15]]) {
    addBin(bx, bz);
  }
  for (const [px, pz] of [[24, 24], [-24, 24], [24, -24], [-24, -24]]) addPlanter(px, pz);
  for (let i = 0; i < 10; i += 1) addCone(randomInRange(-40, 40), randomInRange(-40, 40));

  // ---- A few remaining crates/barriers for cover, off roads & buildings ----
  const onRoad = (x, z, pad = 0) => ROADS.some((c) => Math.abs(x - c) < 10 + pad || Math.abs(z - c) < 10 + pad);
  const nearBuilding = (x, z, pad = 0) => buildingRects.some((b) => Math.abs(x - b.x) < b.hw + pad && Math.abs(z - b.z) < b.hd + pad);
  for (let i = 0; i < 26; i += 1) {
    const rx = randomInRange(-230, 230);
    const rz = randomInRange(-230, 230);
    if (onRoad(rx, rz, 2) || nearBuilding(rx, rz, 2)) continue;
    addProp(rx, rz, randomInRange(1.0, 1.6), randomInRange(0.9, 1.4), randomInRange(1.0, 1.6), "crate", 0x8a6d43, true);
  }

  // ---- Street trees + outskirt greenery (kept off roads / water / buildings) ----
  const blockedSpot = (x, z, pad = 0) => {
    if (onRoad(x, z, pad)) return true;
    if (x > -278 && x < -222) return true;                          // river
    if (x > 160 && x < 340 && z > -320 && z < -180) return true;    // lake
    if (Math.abs(x - 232) < 50 && Math.abs(z - 232) < 40) return true; // plane field
    return nearBuilding(x, z, pad);
  };
  // Street trees along sidewalks (in the grass verge just off the road).
  for (const c of ROADS) {
    for (let s = -230; s <= 230; s += 46) {
      if (Math.abs(s) < 20) continue;
      for (const off of [-13, 13]) {
        if (!blockedSpot(c + off, s, 1)) addProp(c + off, s, 1.3, randomInRange(6, 9), 1.3, "tree", 0x357028, true);
      }
    }
  }
  // Outfield trees, bushes, rocks.
  for (let i = 0; i < 45; i += 1) {
    const rx = randomInRange(-320, 320);
    const rz = randomInRange(-320, 320);
    if (blockedSpot(rx, rz, 3)) continue;
    const trunkR = randomInRange(0.5, 0.85);
    addProp(rx, rz, trunkR * 2, randomInRange(7, 12), trunkR * 2, "tree", 0x2f5e23, true);
  }
  for (let i = 0; i < 55; i += 1) {
    const rx = randomInRange(-300, 300);
    const rz = randomInRange(-300, 300);
    if (blockedSpot(rx, rz, 1)) continue;
    addProp(rx, rz, randomInRange(1.2, 2.2), randomInRange(0.7, 1.2), randomInRange(1.2, 2.2), "bush", 0x3c6b2e, false);
  }
  for (let i = 0; i < 18; i += 1) {
    const rx = randomInRange(-300, 300);
    const rz = randomInRange(-300, 300);
    if (blockedSpot(rx, rz, 1)) continue;
    addProp(rx, rz, randomInRange(1.1, 2.4), randomInRange(0.6, 1.4), randomInRange(1.1, 2.2), "rock", 0x77797b, true);
  }

  // ---- Background ranges (outside playable bounds) ----
  // A ring of peaks 900-1400m out; the north side (behind the cliffs) is
  // tallest so the mountain wall reads as one range.
  for (let i = 0; i < 26; i += 1) {
    const ang = (i / 26) * Math.PI * 2 + randomInRange(-0.08, 0.08);
    const north = Math.sin(ang) < -0.4;
    const dist = randomInRange(north ? 880 : 1000, north ? 1050 : 1350);
    addProp(
      Math.cos(ang) * dist,
      Math.sin(ang) * dist,
      randomInRange(260, 420),
      north ? randomInRange(220, 330) : randomInRange(110, 230),
      randomInRange(240, 400),
      "mountain",
      north ? 0x5a5c62 : 0x56604e,
      false,
    );
  }

  // ---- Drivable cars parked along the roads / in the lot ----
  // Ground fleet: sedans, sports cars, SUVs, pickups, heavy trucks, bikes and
  // APCs (handling per type lives in vehicle-system GROUND_TYPES).
  addVehicle(-30, -8, Math.PI * 0.5, 0xd02a2a, "sports");
  addVehicle(42, 8, -Math.PI * 0.5, 0x9f3c32);
  addVehicle(-8, -118, 0, 0x3d5fa8, "suv");
  addVehicle(8, 96, Math.PI, 0xf2c21a, "sports");
  addVehicle(-118, 8, Math.PI * 0.5, 0xa87f32);
  addVehicle(118, -8, -Math.PI * 0.5, 0x2f3a46, "suv");
  addVehicle(-8, 208, 0, 0xc2b03a, "pickup");
  addVehicle(-150, -150, Math.PI * 0.5, 0x2f8f6f, "pickup");
  addVehicle(112, 60, 0, 0x2f5f9f, "truck");
  addVehicle(-112, -60, Math.PI, 0x9f5f2f, "truck");
  addVehicle(4, 40, 0, 0x1a1a1a, "bike");
  addVehicle(-4, -160, Math.PI, 0xe0572a, "bike");
  addVehicle(222, 30, 0, 0x2a7fd0, "bike");
  addVehicle(-222, -30, 0, 0x4b5a35, "apc");
  addVehicle(30, -222, Math.PI * 0.5, 0x5a5f48, "apc");
  addVehicle(60, 112, -Math.PI * 0.5, 0xeeeeee);

  // ---- Aircraft ----
  // Helicopters on open pads (park + parking lot), planes lined up on the
  // long straight road that doubles as a runway.
  addVehicle(150, 150, Math.PI * 0.25, 0x2c3e50, "heli");
  addVehicle(-210, 60, Math.PI * 0.5, 0x7f8c8d, "heli");
  addVehicle(-60, 220, Math.PI * 0.5, 0xc0392b, "plane");
  addVehicle(210, -210, 0, 0xf1c40f, "plane");

  // ---- Countryside: village, mountains, waterfall, cave, forests, fields ----
  const { wildlife } = buildRegions({
    addProp,
    addVehicle,
    terrainPatches,
    beginBuilding,
    endBuilding,
    wallRun,
    addRoofTiles,
    buildingRects,
    WALL_H,
    WALL_T,
    rand: randomInRange,
    worldHalf: WORLD_HALF_SIZE,
  });

  return { props, terrainPatches, vehicles, buildings, wildlife };
}

function createZone(now) {
  return {
    x: 0,
    z: 0,
    radius: ZONE_START_RADIUS,
    startX: 0,
    startZ: 0,
    startRadius: ZONE_START_RADIUS,
    targetX: 0,
    targetZ: 0,
    targetRadius: ZONE_START_RADIUS,
    transitionStartAt: now,
    transitionDurationMs: ZONE_SHIFT_DURATION_MS,
    nextShiftAt: now + ZONE_SHIFT_INTERVAL_MS,
  };
}

function pointInsideObstacle(x, z, radius, obstacle) {
  if (obstacle.collidable === false) return false;
  const hx = obstacle.sx / 2 + radius;
  const hz = obstacle.sz / 2 + radius;
  return Math.abs(x - obstacle.x) < hx && Math.abs(z - obstacle.z) < hz;
}

// A prop blocks horizontal movement only if its top is above step height and
// its base is below head height relative to the player's feet.
function obstacleBlocksPlayer(obstacle, feetY) {
  if (obstacle.collidable === false) return false;
  const base = obstacle.py || 0;
  const top = base + obstacle.sy;
  if (top <= feetY + PLAYER_STEP_HEIGHT) return false;
  if (base >= feetY + PLAYER_HEIGHT - 0.1) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Broad-phase spatial grid. Movement/support queries only touch props in the
// local cells instead of scanning the whole (now city-sized) prop list, so the
// world can be dense without the per-tick physics cost growing with map size.
// The grid is memoized on the prop array (non-enumerable so snapshots ignore
// it) and holds only props that are collidable at build time; runtime collide
// flips (e.g. a tree felled by a car) are still honored by the per-prop checks
// at each call site.
// ---------------------------------------------------------------------------
const PROP_GRID_CELL = 16;

function ensurePropGrid(worldProps) {
  if (worldProps.__grid) return worldProps.__grid;
  const grid = new Map();
  for (const p of worldProps) {
    if (p.collidable === false) continue;
    const minX = Math.floor((p.x - p.sx / 2) / PROP_GRID_CELL);
    const maxX = Math.floor((p.x + p.sx / 2) / PROP_GRID_CELL);
    const minZ = Math.floor((p.z - p.sz / 2) / PROP_GRID_CELL);
    const maxZ = Math.floor((p.z + p.sz / 2) / PROP_GRID_CELL);
    for (let gx = minX; gx <= maxX; gx += 1) {
      for (let gz = minZ; gz <= maxZ; gz += 1) {
        const key = `${gx}:${gz}`;
        let cell = grid.get(key);
        if (!cell) {
          cell = [];
          grid.set(key, cell);
        }
        cell.push(p);
      }
    }
  }
  Object.defineProperty(worldProps, "__grid", { value: grid, configurable: true });
  return grid;
}

// Collidable props near (x, z), for point/radius collision queries. Returns a
// fresh array (a prop spanning multiple queried cells may appear more than
// once, which is harmless for idempotent resolve/support checks).
function propsNear(worldProps, x, z) {
  const grid = ensurePropGrid(worldProps);
  const gx = Math.floor(x / PROP_GRID_CELL);
  const gz = Math.floor(z / PROP_GRID_CELL);
  const out = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      const cell = grid.get(`${gx + dx}:${gz + dz}`);
      if (cell) for (let i = 0; i < cell.length; i += 1) out.push(cell[i]);
    }
  }
  return out;
}

// Collidable props whose grid cells a segment (a bullet step, a line-of-sight
// ray) passes through — instead of testing all ~4,000 world props. Large props
// are registered in every cell they cover, so any prop the segment can hit is
// in a cell along its 2D path. Each prop is returned once.
let segmentStamp = 0;
function propsAlongSegment(worldProps, ax, az, bx, bz) {
  const grid = ensurePropGrid(worldProps);
  segmentStamp += 1;
  const out = [];
  const len = Math.hypot(bx - ax, bz - az);
  const steps = Math.max(1, Math.ceil(len / (PROP_GRID_CELL * 0.125)));
  let lastKey = "";
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const gx = Math.floor((ax + (bx - ax) * t) / PROP_GRID_CELL);
    const gz = Math.floor((az + (bz - az) * t) / PROP_GRID_CELL);
    const key = `${gx}:${gz}`;
    if (key === lastKey) continue;
    lastKey = key;
    const cell = grid.get(key);
    if (!cell) continue;
    for (let k = 0; k < cell.length; k += 1) {
      const p = cell[k];
      if (p.__segStamp === segmentStamp) continue;
      p.__segStamp = segmentStamp;
      out.push(p);
    }
  }
  return out;
}

// Highest walkable surface under (x, z) reachable from feetY within step height.
function supportHeightAt(x, z, feetY, worldProps) {
  const grid = ensurePropGrid(worldProps);
  const gx = Math.floor(x / PROP_GRID_CELL);
  const gz = Math.floor(z / PROP_GRID_CELL);
  let support = 0;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      const cell = grid.get(`${gx + dx}:${gz + dz}`);
      if (!cell) continue;
      for (let i = 0; i < cell.length; i += 1) {
        const p = cell[i];
        if (p.collidable === false) continue;
        if (Math.abs(x - p.x) > p.sx / 2 + 0.12 || Math.abs(z - p.z) > p.sz / 2 + 0.12) continue;
        const top = (p.py || 0) + p.sy;
        if (top <= feetY + PLAYER_STEP_HEIGHT && top > support) support = top;
      }
    }
  }
  return support;
}

function resolveObstacleCollision(x, z, radius, obstacle) {
  if (obstacle.collidable === false) return { x, z };
  const hx = obstacle.sx / 2 + radius;
  const hz = obstacle.sz / 2 + radius;
  const dx = x - obstacle.x;
  const dz = z - obstacle.z;
  const overlapX = hx - Math.abs(dx);
  const overlapZ = hz - Math.abs(dz);
  if (overlapX <= 0 || overlapZ <= 0) {
    return { x, z };
  }
  if (overlapX < overlapZ) {
    x += dx >= 0 ? overlapX : -overlapX;
  } else {
    z += dz >= 0 ? overlapZ : -overlapZ;
  }
  return { x, z };
}

function rayAabbDistance(origin, dir, box) {
  let tmin = -Infinity;
  let tmax = Infinity;
  const baseY = box.py || 0;
  const min = { x: box.x - box.sx / 2, y: baseY, z: box.z - box.sz / 2 };
  const max = { x: box.x + box.sx / 2, y: baseY + box.sy, z: box.z + box.sz / 2 };
  const axes = ["x", "y", "z"];

  for (const axis of axes) {
    const o = origin[axis];
    const d = dir[axis];
    if (Math.abs(d) < 1e-8) {
      if (o < min[axis] || o > max[axis]) return null;
      continue;
    }
    const invD = 1 / d;
    let t1 = (min[axis] - o) * invD;
    let t2 = (max[axis] - o) * invD;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }

  if (tmax < 0) return null;
  // If tmin is negative, it means the origin is inside the box. 
  // We return 0 to indicate a hit at the start of the ray.
  if (tmin < 0) return 0;
  return tmin;
}

function initFragMode(app, io, rootDir) {
  const nsp = io.of("/frag");
  const players = new Map();
  const bullets = new Map();
  const votes = new Set();
  const { props: worldProps, terrainPatches, vehicles, buildings, wildlife } = buildWorldLayout();
  // Recruitable AI companions, parked at their fixed homes until recruited.
  const npcs = buildNpcSpawns({
    worldProps,
    worldHalfSize: WORLD_HALF_SIZE,
    clamp,
    pointInsideObstacle,
    obstacleBlocksPlayer,
    supportHeightAt,
    propsNear,
  });
  const zone = createZone(Date.now());
  const weather = createWeather(Date.now()); // shared sky: clear / cloudy / rain / storm / fog / snow
  const killFeed = [];
  const shotEvents = [];
  const vehicleEvents = [];
  const destroyedPropIds = [];
  let shotSeq = 0;
  let bulletSeq = 0;

  function addVehicleEvent(type, payload) {
    vehicleEvents.push({ type, at: Date.now(), ...payload });
    if (vehicleEvents.length > 32) vehicleEvents.splice(0, vehicleEvents.length - 32);
    if (type === "treefall") destroyedPropIds.push(payload.propId);
  }

  // ---- Ground weapons (map loot + drops) ----
  const groundWeapons = new Map();
  const lootRespawnQueue = [];
  let lootSeq = 0;

  function rollLootKey() {
    const pool = Object.values(WEAPONS).filter((w) => w.lootWeight > 0);
    let r = Math.random() * pool.reduce((sum, w) => sum + w.lootWeight, 0);
    for (const w of pool) {
      r -= w.lootWeight;
      if (r <= 0) return w.key;
    }
    return pool[0].key;
  }

  function randomLootSpot() {
    for (let i = 0; i < 60; i += 1) {
      const x = randomInRange(-WORLD_HALF_SIZE * 0.88, WORLD_HALF_SIZE * 0.88);
      const z = randomInRange(-WORLD_HALF_SIZE * 0.88, WORLD_HALF_SIZE * 0.88);
      let blocked = false;
      for (const obstacle of propsNear(worldProps, x, z)) {
        if (!obstacleBlocksPlayer(obstacle, 0)) continue;
        if (pointInsideObstacle(x, z, 0.8, obstacle)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) return { x, z };
    }
    return { x: 0, z: 0 };
  }

  function spawnGroundWeapon(key, x, z, source, now) {
    lootSeq += 1;
    const item = {
      id: lootSeq,
      key,
      x,
      y: 0,
      z,
      source, // "spawn" (map loot) | "drop" (from a player)
      at: now,
      expiresAt: source === "drop" ? now + DROPPED_WEAPON_TTL_MS : 0,
    };
    groundWeapons.set(item.id, item);
    return item;
  }

  function seedLoot(now) {
    groundWeapons.clear();
    lootRespawnQueue.length = 0;
    for (let i = 0; i < LOOT_COUNT; i += 1) {
      const spot = randomLootSpot();
      spawnGroundWeapon(rollLootKey(), spot.x, spot.z, "spawn", now);
    }
  }

  function updateLoot(now) {
    for (const item of groundWeapons.values()) {
      if (item.expiresAt && now >= item.expiresAt) groundWeapons.delete(item.id);
    }
    while (lootRespawnQueue.length && lootRespawnQueue[0] <= now) {
      lootRespawnQueue.shift();
      const spot = randomLootSpot();
      spawnGroundWeapon(rollLootKey(), spot.x, spot.z, "spawn", now);
    }
  }

  /** Drop a player's loot weapons (not the defaults) in a ring at their feet. */
  function dropLootWeapons(player, now) {
    const loot = (player.slots || []).filter((key) => !DEFAULT_SLOTS.includes(key));
    loot.forEach((key, i) => {
      const a = (i / Math.max(1, loot.length)) * Math.PI * 2 + Math.random();
      spawnGroundWeapon(key, player.x + Math.cos(a) * 0.9, player.z + Math.sin(a) * 0.9, "drop", now);
    });
    player.slots = [...DEFAULT_SLOTS];
  }

  /** Put a weapon in the player's hands (holster/draw window + fresh mag). */
  function equipWeapon(player, weaponKey, now) {
    player.previousWeapon = player.weapon;
    player.weapon = weaponKey;
    player.reloadingUntil = 0;
    player.burstLeft = 0;
    player.spinShots = 0;
    player.switchStartedAt = now;
    // Two-phase holster/draw animation window (client shows lower then raise).
    player.switchingUntil = now + 700;
    refillMagazine(player, WEAPONS[weaponKey]);
  }

  let phase = "playing";
  let phaseStartedAt = Date.now();
  let phaseDurationMs = PLAY_TIME_MS;
  let lastTickAt = Date.now();
  let lastBroadcastAt = 0;

  function addKillFeed(killer, victim, now) {
    killFeed.unshift({ at: now, killer, victim });
    killFeed.splice(8);
  }

  function addShotEvent(fromId, origin, dir, distance, hitPlayerId, now, weaponKey, hitInfo = null) {
    shotSeq += 1;
    shotEvents.push({
      id: shotSeq,
      at: now,
      fromId,
      ox: origin.x,
      oy: origin.y,
      oz: origin.z,
      dx: dir.x,
      dy: dir.y,
      dz: dir.z,
      distance,
      hitPlayerId: hitPlayerId || null,
      hitPart: hitInfo?.part || null,
      damage: hitInfo?.damage ? round2(hitInfo.damage) : 0,
      weapon: weaponKey,
    });
    if (shotEvents.length > MAX_SHOT_EVENTS) {
      shotEvents.splice(0, shotEvents.length - MAX_SHOT_EVENTS);
    }
  }

  function addBulletSnapshotTrail(fromId, weaponKey, now, fromPos, toPos, hitPlayerId = null, hitInfo = null) {
    const dx = toPos.x - fromPos.x;
    const dy = toPos.y - fromPos.y;
    const dz = toPos.z - fromPos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist <= 0.001) return;
    addShotEvent(
      fromId,
      fromPos,
      { x: dx / dist, y: dy / dist, z: dz / dist },
      dist,
      hitPlayerId,
      now,
      weaponKey,
      hitInfo,
    );
  }

  function phaseRemainingMs(now) {
    return Math.max(0, phaseStartedAt + phaseDurationMs - now);
  }

  function randomSpawnInCircle() {
    for (let i = 0; i < 80; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random()) * Math.max(12, zone.radius * 0.76);
      const x = clamp(zone.x + Math.cos(angle) * radius, -WORLD_HALF_SIZE + 2, WORLD_HALF_SIZE - 2);
      const z = clamp(zone.z + Math.sin(angle) * radius, -WORLD_HALF_SIZE + 2, WORLD_HALF_SIZE - 2);
      let blocked = false;
      for (const obstacle of propsNear(worldProps, x, z)) {
        if (!obstacleBlocksPlayer(obstacle, 0)) continue;
        if (pointInsideObstacle(x, z, PLAYER_RADIUS, obstacle)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) return { x, z };
    }
    return { x: 0, z: 0 };
  }

  function getVehicleById(vehicleId) {
    return vehicles.find((vehicle) => vehicle.id === vehicleId) || null;
  }

  function findNearestVehicle(player) {
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
    return nearest && nearestDist <= VEHICLE_ENTER_RADIUS ? nearest : null;
  }

  /**
   * Riders sit at their vehicle's real seat (driver / passenger, per type) with
   * a seated hitbox. Facing is left alone: everyone in a vehicle aims where
   * they look, so drivers can shoot too (drive-by) and passengers keep a free aim.
   */
  function syncPlayerToVehicle(player, vehicle, seat = "driver") {
    const hip = seatWorld(vehicle, seat);
    player.x = hip.x;
    player.z = hip.z;
    player.y = hip.y + SEATED_EYE;
    player.vx = vehicle.vx;
    player.vz = vehicle.vz;
    player.vy = vehicle.vy || 0;
    player.crouching = true; // seated: the compact (crouch) hitbox fits a seated body
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
      player.x = clamp(
        vehicle.x + Math.cos(exitYaw) * VEHICLE_EXIT_OFFSET,
        -WORLD_HALF_SIZE + PLAYER_RADIUS,
        WORLD_HALF_SIZE - PLAYER_RADIUS,
      );
      player.z = clamp(
        vehicle.z + Math.sin(exitYaw) * VEHICLE_EXIT_OFFSET,
        -WORLD_HALF_SIZE + PLAYER_RADIUS,
        WORLD_HALF_SIZE - PLAYER_RADIUS,
      );
      // Bailing out of a flying vehicle leaves you in the air — gravity does the rest.
      player.y = (vehicle.y || 0) + PLAYER_EYE_HEIGHT;
      player.vx = vehicle.vx * 0.15;
      player.vz = vehicle.vz * 0.15;
      player.vy = 0;
    }
    player.inVehicle = null;
    player.vehicleSeat = null;
  }

  function enterNearestVehicle(player, seat = "driver") {
    if (!player.alive || phase !== "playing") return false;
    if (player.inVehicle) {
      leaveVehicle(player);
      return true;
    }

    const vehicle = findNearestVehicle(player);
    if (!vehicle) return false;
    if (seat === "passenger") {
      if (vehicle.passengerId) return false;
      vehicle.passengerId = player.id;
    } else {
      if (vehicle.driverId) return false;
      vehicle.driverId = player.id;
      vehicle.engineOn = true;
      player.reloadingUntil = 0;
    }
    player.inVehicle = vehicle.id;
    player.vehicleSeat = seat;
    syncPlayerToVehicle(player, vehicle, seat);
    return true;
  }

  // Radius + occupant damage when an aircraft (or future exploding vehicle)
  // goes up. Occupants who didn't bail before impact take the worst of it.
  // ---- Trees: shoot (or blast) them down; they fall away from the hit ----
  const TREE_HP = 160;
  const TREE_CRUSH_DAMAGE = 45;
  function damageTree(tree, amount, dirX, dirZ, now, attacker = null) {
    if (!tree || tree.type !== "tree" || tree.destroyed) return false;
    tree.hp = (tree.hp ?? TREE_HP) - amount;
    if (tree.hp > 0) {
      damagedTrees.set(tree.id, Math.round((tree.hp / TREE_HP) * 100) / 100);
      return false;
    }
    damagedTrees.delete(tree.id);
    const len = Math.hypot(dirX, dirZ) || 1;
    const dx = dirX / len;
    const dz = dirZ / len;
    tree.destroyed = true;
    tree.collidable = false;
    addVehicleEvent("treefall", { propId: tree.id, x: tree.x, z: tree.z, dx, dz });
    // Anyone standing where the trunk lands gets flattened.
    const reach = tree.sy * 0.9;
    for (const p of players.values()) {
      if (!p.alive || p.inVehicle) continue;
      const rx = p.x - tree.x;
      const rz = p.z - tree.z;
      const along = rx * dx + rz * dz;
      const across = Math.abs(rx * dz - rz * dx);
      if (along < 0.5 || along > reach || across > 1.3) continue;
      p.health -= TREE_CRUSH_DAMAGE;
      p.lastDamagedAt = now;
      if (p.health <= 0) {
        killPlayer(p, attacker ? `${attacker.name} (falling tree)` : "Falling tree", now);
        const killer = attacker ? players.get(attacker.id) : null;
        if (killer && killer.id !== p.id) killer.kills += 1;
      }
    }
    return true;
  }

  function blastTrees(point, radius, damage, now, attacker = null) {
    for (const tree of propsNear(worldProps, point.x, point.z)) {
      if (tree.type !== "tree" || tree.destroyed) continue;
      const d = Math.hypot(tree.x - point.x, tree.z - point.z);
      if (d > radius) continue;
      damageTree(tree, damage * (1 - d / radius), tree.x - point.x, tree.z - point.z, now, attacker);
    }
  }

  // id -> remaining health 0..1 for trees that have been shot (HUD bar).
  const damagedTrees = new Map();

  function resetTrees() {
    damagedTrees.clear();
    for (const p of worldProps) {
      if (p.type !== "tree" || !p.destroyed) continue;
      p.destroyed = false;
      p.collidable = true;
      p.hp = TREE_HP;
    }
    destroyedPropIds.length = 0;
  }

  // ---- Destructible buildings ----
  // How hard each damage source hits a wall panel (panel HP: house 240,
  // shop 220, tower lobby ~530).
  const WALL_BULLET_SCALE = 0.3; // per-bullet damage x this
  const WALL_RAM_SCALE = 1.3; // 0.5 * mass * v^2 x this
  const structures = createStructureSystem({
    worldProps,
    buildings,
    onCollapse: (b, attacker, now) => {
      // Everyone inside (or on the roof) is crushed; vehicles get smashed.
      const inside = (x, z, pad) => Math.abs(x - b.x) < b.w / 2 + pad && Math.abs(z - b.z) < b.d / 2 + pad;
      const killer = attacker ? players.get(attacker.id) : null;
      // A supertall throws debris far beyond its footprint.
      const crushPad = b.h > 60 ? 22 : 1.2;
      for (const p of players.values()) {
        if (!p.alive || !inside(p.x, p.z, crushPad)) continue;
        p.health -= 220;
        p.lastDamagedAt = now;
        if (p.health <= 0) {
          killPlayer(p, attacker ? `${attacker.name} (building collapse)` : "Building collapse", now);
          if (killer && killer.id !== p.id) killer.kills += 1;
        }
      }
      for (const v of vehicles) {
        if (!v.destroyed && inside(v.x, v.z, 1)) v.health = Math.max(0, (v.health ?? 100) - 70);
      }
      for (const npc of npcs) {
        if (npc.state === "active" && inside(npc.x, npc.z, 1)) damageNpc(npcEnv, npc, 400, now);
      }
      addVehicleEvent("collapse", { x: b.x, y: 1, z: b.z, power: Math.min(60, 18 + b.h), buildingId: b.id });
    },
  });
  let lastStructureEmitAt = 0;

  function onVehicleExplosion(vehicle) {
    const now = Date.now();
    const EXPLOSION_RADIUS = 13;
    structures.applyBlast({ x: vehicle.x, y: (vehicle.y || 0) + 1, z: vehicle.z }, 7, 320, now, null);
    blastTrees({ x: vehicle.x, z: vehicle.z }, 6, 400, now, null);
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
  }

  const vehicleEnv = {
        vehicles,
        players,
        worldProps,
        clamp,
        pointInsideObstacle,
        resolveObstacleCollision,
        worldHalfSize: WORLD_HALF_SIZE,
        propsNear: (x, z) => propsNear(worldProps, x, z),
        active: () => phase === "playing",
        syncPlayerToVehicle,
        addEvent: addVehicleEvent,
        onVehicleExplosion,
        // A ram that knocks the panel out lets the vehicle drive through.
        onVehicleImpact: (obstacle, energy, vehicle, now) => {
          const driver = vehicle.driverId ? players.get(vehicle.driverId) : null;
          const by = driver ? { id: driver.id, name: driver.name } : null;
          const dmg = energy * WALL_RAM_SCALE;
          const broke = structures.damageProp(obstacle, dmg, now, by);
          // Tear a vehicle-sized hole: the panels beside the impact take the hit too.
          if (broke) structures.applyBlast({ x: obstacle.x, y: 1, z: obstacle.z }, vehicleBodyRadius(vehicle) + 1.6, dmg, now, by);
          return broke;
        },
        onRunOverPlayer: (victim, vehicle, driver, speed) => {
          victim.health -= speed * 3.2;
          victim.lastDamagedAt = Date.now();
          if (victim.health <= 0) {
            killPlayer(victim, driver ? `${driver.name} (road kill)` : "Runaway car", Date.now());
            if (driver) driver.kills += 1;
          }
        },
        zombies: null,
        onRunOverZombie: null,
        weatherGrip: () => weatherGrip(weather),
  };

  function updateVehicles(dtSec) {
    updateVehicleFleet(vehicleEnv, dtSec, Date.now());
  }

  // --- AI companion (NPC) wiring -------------------------------------------
  // Frag is free-for-all: an NPC's owner is its only ally, and every other
  // player (plus their companions) is a hostile. Friendly fire is prevented by
  // comparing ownership, mirroring the "not me" rule used everywhere else.

  function npcGetPlayerById(id) {
    return players.get(id) || null;
  }

  function npcGetAllies(npc) {
    const owner = players.get(npc.ownerId);
    return owner && owner.alive ? [owner] : [];
  }

  function npcGetHostiles(npc) {
    const out = [];
    for (const p of players.values()) {
      if (p.alive && p.id !== npc.ownerId && !p.inVehicle) out.push(p);
    }
    for (const other of npcs) {
      if (other !== npc && other.state === "active" && other.ownerId && other.ownerId !== npc.ownerId) {
        out.push(other);
      }
    }
    return out;
  }

  function npcHasLineOfSight(ax, ay, az, bx, by, bz) {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz) || 1;
    const blocked = shotBlockedByObstacle(
      { x: ax, y: ay, z: az },
      { x: dx / len, y: dy / len, z: dz / len },
      len,
    );
    return blocked === null || blocked >= len - 0.2;
  }

  function npcHealPlayer(player, amount) {
    if (!player || !player.alive) return;
    player.health = Math.min(100, player.health + amount);
  }

  function npcEmitTracer(fromId, origin, dir, distance, hitId, weaponKey) {
    addShotEvent(fromId, origin, dir, distance, hitId, Date.now(), weaponKey || "rifle", null);
  }

  function npcApplyDamage(target, amount, npc) {
    const now = Date.now();
    if (target && target.role !== undefined && target.homeX !== undefined) {
      // Target is another player's companion.
      const killed = damageNpc(npcEnv, target, amount, now);
      if (killed) {
        const owner = players.get(npc.ownerId);
        if (owner) owner.kills += 1;
      }
      return;
    }
    // Target is a player.
    if (!target.alive) return;
    target.health -= amount;
    target.lastDamagedAt = now;
    if (target.health <= 0) {
      const owner = players.get(npc.ownerId);
      const label = NPC_ROLES[npc.role]?.label || "Companion";
      killPlayer(target, owner ? `${owner.name}'s ${label}` : label, now);
      if (owner) owner.kills += 1;
    }
  }

  const npcEnv = {
    npcs,
    allowRoles: ["healer", "attacker", "defender", "summoner"],
    // Beacon spots: anywhere walkable on the map (not inside a building).
    randomRecruitSpot: () => randomLootSpot(),
    worldProps,
    worldHalfSize: WORLD_HALF_SIZE,
    clamp,
    pointInsideObstacle,
    obstacleBlocksPlayer,
    supportHeightAt,
    propsNear,
    resolveObstacleCollision,
    active: () => phase === "playing",
    getPlayerById: npcGetPlayerById,
    getAllies: npcGetAllies,
    getHostiles: npcGetHostiles,
    hasLineOfSight: npcHasLineOfSight,
    applyDamage: npcApplyDamage,
    healPlayer: npcHealPlayer,
    emitTracer: npcEmitTracer,
    addEvent: addVehicleEvent, // discrete NPC FX ride the same event channel
  };

  // The roaming recruit point (one for everyone; party of up to 4 per player).
  const recruitBeacon = createRecruitBeacon(npcEnv);

  function updateNpcs(dtSec) {
    updateNpcFleet(npcEnv, dtSec, Date.now());
    updateRecruitBeacon(npcEnv, recruitBeacon, dtSec, Date.now());
  }

  /** A player's bullet may strike an enemy companion (not their own). */
  function npcBulletHit(bullet, from, to) {
    let hit = null;
    const bodyRadius = (bullet.radius || 0.12) + 0.62;
    for (const npc of npcs) {
      if (npc.state !== "active") continue;
      if (npc.ownerId === bullet.shooterId) continue; // never your own companion
      const center = { x: npc.x, y: npc.y - 0.6, z: npc.z };
      const check = segmentPointDistanceSq(from, to, center);
      if (check.distSq > bodyRadius * bodyRadius) continue;
      const distance =
        Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) * check.t;
      if (!hit || distance < hit.distance) hit = { npc, distance, t: check.t };
    }
    return hit;
  }

  function resetZone(now) {
    zone.x = 0;
    zone.z = 0;
    zone.radius = ZONE_START_RADIUS;
    zone.startX = 0;
    zone.startZ = 0;
    zone.startRadius = ZONE_START_RADIUS;
    zone.targetX = 0;
    zone.targetZ = 0;
    zone.targetRadius = ZONE_START_RADIUS;
    zone.transitionStartAt = now;
    zone.nextShiftAt = now + ZONE_SHIFT_INTERVAL_MS;
  }

  function defaultWeapon() {
    return WEAPONS.rifle;
  }

  function refillMagazine(player, weapon) {
    player.ammoInMag = weapon.magSize;
    player.magSize = weapon.magSize;
  }

  function respawnPlayer(player, now) {
    leaveVehicle(player);
    const spawn = randomSpawnInCircle();
    player.x = spawn.x;
    player.y = PLAYER_EYE_HEIGHT;
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
    player.movementPenaltyUntil = 0;
    if (!Array.isArray(player.slots)) player.slots = [...DEFAULT_SLOTS];
    if (!player.slots.includes(player.weapon)) player.weapon = player.slots[0];
    player.burstLeft = 0;
    player.spinShots = 0;
    refillMagazine(player, WEAPONS[player.weapon] || defaultWeapon());
    player.lastDamagedAt = now;
  }

  function rotatePhase(now) {
    phase = phase === "playing" ? "cooldown" : "playing";
    phaseStartedAt = now;
    phaseDurationMs = phase === "playing" ? PLAY_TIME_MS : COOLDOWN_TIME_MS;
    killFeed.splice(0);
    shotEvents.splice(0);
    bullets.clear();
    votes.clear();
    resetZone(now);
    seedLoot(now);
    structures.reset();
    resetTrees();

    for (const player of players.values()) {
      if (phase === "playing") {
        player.kills = 0;
        player.deaths = 0;
      }
      player.slots = [...DEFAULT_SLOTS];
      respawnPlayer(player, now);
    }
  }

  function maybeAdvancePhase(now) {
    while (phaseRemainingMs(now) <= 0) {
      rotatePhase(now);
    }
  }

  function scheduleZoneShift(now) {
    // PUBG-style: new circle must be entirely contained within old circle
    // newRadius is 60-80% of current
    const newRadius = Math.max(MIN_ZONE_RADIUS, zone.radius * randomInRange(0.6, 0.75));
    
    // The maximum distance the center can move and still keep the new circle inside the old one
    const maxShift = zone.radius - newRadius;
    
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.sqrt(Math.random()) * maxShift; // sqrt for uniform distribution in circle
    
    const targetX = clamp(zone.x + Math.cos(angle) * dist, -WORLD_HALF_SIZE + newRadius, WORLD_HALF_SIZE - newRadius);
    const targetZ = clamp(zone.z + Math.sin(angle) * dist, -WORLD_HALF_SIZE + newRadius, WORLD_HALF_SIZE - newRadius);

    zone.startX = zone.x;
    zone.startZ = zone.z;
    zone.startRadius = zone.radius;
    zone.targetX = targetX;
    zone.targetZ = targetZ;
    zone.targetRadius = newRadius;
    zone.transitionStartAt = now;
    zone.transitionDurationMs = ZONE_SHIFT_DURATION_MS;
    zone.nextShiftAt = now + ZONE_SHIFT_INTERVAL_MS;
  }

  function updateZone(now) {
    if (phase !== "playing") return;
    if (now >= zone.nextShiftAt && zone.radius > MIN_ZONE_RADIUS + 1) {
      scheduleZoneShift(now);
    }
    const t = clamp((now - zone.transitionStartAt) / Math.max(1, zone.transitionDurationMs), 0, 1);
    zone.x = zone.startX + (zone.targetX - zone.startX) * t;
    zone.z = zone.startZ + (zone.targetZ - zone.startZ) * t;
    zone.radius = zone.startRadius + (zone.targetRadius - zone.startRadius) * t;
  }

  function makePlayer(id, name, now) {
    const spawn = randomSpawnInCircle();
    const weapon = defaultWeapon();
    return {
      id,
      name: String(name || "Player").slice(0, 18),
      x: spawn.x,
      y: PLAYER_EYE_HEIGHT,
      z: spawn.z,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      pitch: 0,
      health: 100,
      kills: 0,
      deaths: 0,
      alive: true,
      respawnAt: 0,
      deathAt: 0,
      deathTilt: 0,
      deathRoll: 0,
      weapon: weapon.key,
      slots: [...DEFAULT_SLOTS],
      burstLeft: 0,
      burstNextAt: 0,
      spinShots: 0,
      ammoInMag: weapon.magSize,
      magSize: weapon.magSize,
      reloadingUntil: 0,
      lastShotAt: 0,
      lastMeleeAt: 0,
      switchingUntil: 0,
      switchStartedAt: 0,
      previousWeapon: weapon.key,
      inVehicle: null,
      vehicleSeat: null,
      crouching: false,
      movementPenaltyUntil: 0,
      input: {
        forward: false,
        back: false,
        left: false,
        right: false,
        sprint: false,
        jump: false,
        crouch: false,
      },
      lastJumpPressed: false,
      lastDamagedAt: now,
    };
  }

  function applyMovement(player, dtSec) {
    if (!player.alive || phase !== "playing") return;
    if (player.inVehicle) return;

    let moveForward = 0;
    let moveSide = 0;
    // Forward in Three.js is -Z. With normForward = 1, dz = -cos(0) * 1 = -1.
    if (player.input.forward) moveForward += 1;
    if (player.input.back) moveForward -= 1;
    if (player.input.right) moveSide += 1;
    if (player.input.left) moveSide -= 1;

    const mag = Math.hypot(moveForward, moveSide);
    player.crouching = Boolean(player.input.crouch);
    const legPenalty = player.movementPenaltyUntil > Date.now() ? 0.78 : 1;
    const speed = (player.crouching ? 4.1 : player.input.sprint ? 10.6 : 7.5) * legPenalty;
    let desiredVx = 0;
    let desiredVz = 0;

    if (mag > 0.001) {
      const normForward = moveForward / mag;
      const normSide = moveSide / mag;
      const sin = Math.sin(player.yaw);
      const cos = Math.cos(player.yaw);
      // Three.js forward is -Z at yaw 0
      const dx = -sin * normForward + cos * normSide;
      const dz = -cos * normForward - sin * normSide;
      desiredVx = dx * speed;
      desiredVz = dz * speed;
    }

    const accelFactor = 1 - Math.exp(-PLAYER_ACCEL * dtSec);
    player.vx += (desiredVx - player.vx) * accelFactor;
    player.vz += (desiredVz - player.vz) * accelFactor;

    if (mag < 0.001) {
      const drag = Math.exp(-PLAYER_GROUND_FRICTION * dtSec);
      player.vx *= drag;
      player.vz *= drag;
      if (Math.abs(player.vx) < 0.01) player.vx = 0;
      if (Math.abs(player.vz) < 0.01) player.vz = 0;
    }

    const eyeHeight = player.crouching ? PLAYER_CROUCH_EYE_HEIGHT : PLAYER_EYE_HEIGHT;
    const feetY = player.y - eyeHeight;
    const support = supportHeightAt(player.x, player.z, feetY, worldProps);
    const onGround = feetY <= support + 0.03;

    if (player.input.jump && !player.lastJumpPressed && onGround && !player.crouching) {
      player.vy = PLAYER_JUMP_VELOCITY;
    }
    player.lastJumpPressed = Boolean(player.input.jump);
    player.vy -= PLAYER_GRAVITY * dtSec;
    player.y += player.vy * dtSec;

    let nx = clamp(player.x + player.vx * dtSec, -WORLD_HALF_SIZE + PLAYER_RADIUS, WORLD_HALF_SIZE - PLAYER_RADIUS);
    let nz = clamp(player.z + player.vz * dtSec, -WORLD_HALF_SIZE + PLAYER_RADIUS, WORLD_HALF_SIZE - PLAYER_RADIUS);

    const curFeet = player.y - eyeHeight;
    for (let i = 0; i < 2; i += 1) {
      for (const obstacle of propsNear(worldProps, nx, nz)) {
        if (!obstacleBlocksPlayer(obstacle, curFeet)) continue;
        if (!pointInsideObstacle(nx, nz, PLAYER_RADIUS, obstacle)) continue;
        const resolved = resolveObstacleCollision(nx, nz, PLAYER_RADIUS, obstacle);
        nx = resolved.x;
        nz = resolved.z;
      }
    }

    // Vehicles are solid: walk around them, not through.
    ({ x: nx, z: nz } = resolveCircleVsVehicles(nx, nz, PLAYER_RADIUS, vehicles, curFeet));

    // Land on / step up onto the highest reachable surface. Only snap while
    // not moving upward so jumps aren't cut short.
    const newSupport = supportHeightAt(nx, nz, curFeet, worldProps);
    if (player.vy <= 0 && player.y < newSupport + eyeHeight) {
      // Hard landings hurt: a jump lands at ~9 m/s, dropping through a
      // shot-out roof (~3.7m) at ~16 m/s (about 20 damage).
      const impact = -player.vy;
      if (impact > FALL_DAMAGE_SPEED) {
        player.health -= (impact - FALL_DAMAGE_SPEED) * 5;
        player.lastDamagedAt = Date.now();
        if (player.health <= 0) killPlayer(player, "Fall damage", Date.now());
      }
      player.y = newSupport + eyeHeight;
      player.vy = 0;
    }

    player.x = nx;
    player.z = nz;
  }

  function resolvePlayerCollisions() {
    const activePlayers = Array.from(players.values()).filter((p) => p.alive && !p.inVehicle);
    for (let i = 0; i < activePlayers.length; i += 1) {
      const a = activePlayers[i];
      for (let j = i + 1; j < activePlayers.length; j += 1) {
        const b = activePlayers[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const dist = Math.hypot(dx, dz);
        const minDist = PLAYER_COLLISION_RADIUS;
        if (dist >= minDist) continue;

        const nx = dist > 1e-6 ? dx / dist : 1;
        const nz = dist > 1e-6 ? dz / dist : 0;
        const push = (minDist - dist) * 0.5;

        a.x = clamp(a.x - nx * push, -WORLD_HALF_SIZE + PLAYER_RADIUS, WORLD_HALF_SIZE - PLAYER_RADIUS);
        a.z = clamp(a.z - nz * push, -WORLD_HALF_SIZE + PLAYER_RADIUS, WORLD_HALF_SIZE - PLAYER_RADIUS);
        b.x = clamp(b.x + nx * push, -WORLD_HALF_SIZE + PLAYER_RADIUS, WORLD_HALF_SIZE - PLAYER_RADIUS);
        b.z = clamp(b.z + nz * push, -WORLD_HALF_SIZE + PLAYER_RADIUS, WORLD_HALF_SIZE - PLAYER_RADIUS);

      }
    }
  }

  function killPlayer(victim, killerName, now) {
    leaveVehicle(victim);
    victim.health = 0;
    victim.alive = false;
    victim.deaths += 1;
    victim.respawnAt = now + BASE_RESPAWN_MS;
    victim.deathAt = now;
    victim.deathTilt = randomInRange(-1.57, 1.57);
    victim.deathRoll = randomInRange(-0.78, 0.78);
    victim.reloadingUntil = 0;
    victim.burstLeft = 0;
    dropLootWeapons(victim, now);
    addKillFeed(killerName, victim.name, now);
  }

  function applyZoneDamage(player, dtSec, now) {
    if (!player.alive || phase !== "playing") return;
    const dist = Math.hypot(player.x - zone.x, player.z - zone.z);
    if (dist <= zone.radius) return;

    const overshoot = dist - zone.radius;
    const multiplier = 1 + clamp(overshoot / 90, 0, 1.2);
    player.health -= OUTSIDE_ZONE_DAMAGE_PER_SEC * multiplier * dtSec;
    if (player.health <= 0) {
      killPlayer(player, "Blue Zone", now);
    }
  }

  function performMelee(attacker, now) {
    if (!attacker.alive || attacker.inVehicle || phase !== "playing") return false;
    if (now - attacker.lastMeleeAt < 850) return false;
    attacker.lastMeleeAt = now;

    const forwardX = -Math.sin(attacker.yaw);
    const forwardZ = -Math.cos(attacker.yaw);
    let best = null;

    for (const target of players.values()) {
      if (!target.alive || target.id === attacker.id || target.inVehicle) continue;
      const dx = target.x - attacker.x;
      const dz = target.z - attacker.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 2.45) continue;
      const dot = dist > 1e-6 ? (dx / dist) * forwardX + (dz / dist) * forwardZ : 1;
      if (dot < 0.38) continue;
      if (!best || dist < best.dist) best = { target, dist };
    }

    if (!best) return false;
    best.target.health -= 38;
    best.target.lastDamagedAt = now;
    if (best.target.health <= 0) {
      killPlayer(best.target, attacker.name, now);
      attacker.kills += 1;
    }
    return true;
  }

  function maybeRespawn(player, now) {
    if (!player.alive && player.respawnAt && now >= player.respawnAt) {
      respawnPlayer(player, now);
    }
  }

  function maybeFinishReload(player, now) {
    if (player.reloadingUntil && now >= player.reloadingUntil) {
      const weapon = WEAPONS[player.weapon] || defaultWeapon();
      refillMagazine(player, weapon);
      player.reloadingUntil = 0;
    }
  }

  function shotBlockedByObstacle(origin, dir, maxDistance) {
    let blockedAt = null;
    const reach = Math.min(maxDistance, 2000);
    for (const obstacle of propsAlongSegment(worldProps, origin.x, origin.z, origin.x + dir.x * reach, origin.z + dir.z * reach)) {
      if (obstacle.collidable === false) continue;
      const d = rayAabbDistance(origin, dir, obstacle);
      if (d == null || d <= 0 || d > maxDistance) continue;
      if (blockedAt == null || d < blockedAt) blockedAt = d;
    }
    return blockedAt;
  }

  function segmentAabbDistance(fromPos, toPos, obstacle) {
    if (obstacle.collidable === false) return null;
    const dx = toPos.x - fromPos.x;
    const dy = toPos.y - fromPos.y;
    const dz = toPos.z - fromPos.z;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-6) return null;
    const dir = { x: dx / length, y: dy / length, z: dz / length };
    const dist = rayAabbDistance(fromPos, dir, obstacle);
    if (dist == null || dist < 0 || dist > length) return null;
    return dist;
  }

  function segmentPointDistanceSq(fromPos, toPos, point) {
    const ax = fromPos.x;
    const ay = fromPos.y;
    const az = fromPos.z;
    const bx = toPos.x;
    const by = toPos.y;
    const bz = toPos.z;
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const apx = point.x - ax;
    const apy = point.y - ay;
    const apz = point.z - az;
    const abLenSq = abx * abx + aby * aby + abz * abz;
    const t = abLenSq > 1e-9 ? clamp((apx * abx + apy * aby + apz * abz) / abLenSq, 0, 1) : 0;
    const cx = ax + abx * t;
    const cy = ay + aby * t;
    const cz = az + abz * t;
    const dx = point.x - cx;
    const dy = point.y - cy;
    const dz = point.z - cz;
    return { distSq: dx * dx + dy * dy + dz * dz, t };
  }

  function segmentClosestPoint(fromPos, toPos, point) {
    const ax = fromPos.x;
    const ay = fromPos.y;
    const az = fromPos.z;
    const bx = toPos.x;
    const by = toPos.y;
    const bz = toPos.z;
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const apx = point.x - ax;
    const apy = point.y - ay;
    const apz = point.z - az;
    const abLenSq = abx * abx + aby * aby + abz * abz;
    const t = abLenSq > 1e-9 ? clamp((apx * abx + apy * aby + apz * abz) / abLenSq, 0, 1) : 0;
    return {
      t,
      x: ax + abx * t,
      y: ay + aby * t,
      z: az + abz * t,
    };
  }

  function segmentClosestPointOnXZ(fromPos, toPos, x, z) {
    const dx = toPos.x - fromPos.x;
    const dz = toPos.z - fromPos.z;
    const lenSq = dx * dx + dz * dz;
    const t = lenSq > 1e-9 ? clamp(((x - fromPos.x) * dx + (z - fromPos.z) * dz) / lenSq, 0, 1) : 0;
    return {
      t,
      x: fromPos.x + dx * t,
      y: fromPos.y + (toPos.y - fromPos.y) * t,
      z: fromPos.z + dz * t,
    };
  }

  function makeHitCandidate(part, target, fromPos, toPos, rootY, centerY, radius, minY, maxY, multiplier) {
    const closest = segmentClosestPointOnXZ(fromPos, toPos, target.x, target.z);
    if (closest.y < minY || closest.y > maxY) return null;

    const dx = closest.x - target.x;
    const dz = closest.z - target.z;
    const horizDistSq = dx * dx + dz * dz;
    const allowedRadius = radius;
    if (horizDistSq > allowedRadius * allowedRadius) return null;

    const segmentLen = Math.hypot(toPos.x - fromPos.x, toPos.y - fromPos.y, toPos.z - fromPos.z);
    return {
      target,
      part,
      distance: segmentLen * closest.t,
      t: closest.t,
      multiplier,
      point: closest,
      rootY,
      centerY,
    };
  }

  function resolveBodyPartHit(fromPos, toPos, target, bullet) {
    const py = Number.isFinite(target.y) ? target.y : PLAYER_EYE_HEIGHT;
    const rootY = py - (target.crouching ? PLAYER_CROUCH_EYE_HEIGHT : PLAYER_EYE_HEIGHT);
    const crouchScale = target.crouching ? 0.74 : 1;
    const hitRadius = bullet.radius || 0.12;
    const candidates = [];

    const headCenterY = rootY + 1.66 * crouchScale;
    const headRadius = 0.24 + hitRadius;
    const headCheck = segmentPointDistanceSq(fromPos, toPos, { x: target.x, y: headCenterY, z: target.z });
    if (headCheck.distSq <= headRadius * headRadius) {
      candidates.push({
        target,
        part: "head",
        distance: Math.hypot(toPos.x - fromPos.x, toPos.y - fromPos.y, toPos.z - fromPos.z) * headCheck.t,
        t: headCheck.t,
        multiplier: bullet.headMultiplier,
      });
    }

    const zones = [
      ["neck", 1.38, 0.34, 1.27, 1.52, bullet.neckMultiplier],
      ["chest", 0.98, 0.64, 0.72, 1.34, bullet.chestMultiplier],
      ["arms", 0.94, 0.86, 0.52, 1.34, bullet.armMultiplier],
      ["legs", 0.36, 0.52, 0.02, 0.76, bullet.legMultiplier],
    ];

    for (const [part, centerY, radius, minY, maxY, multiplier] of zones) {
      const candidate = makeHitCandidate(
        part,
        target,
        fromPos,
        toPos,
        rootY,
        rootY + centerY * crouchScale,
        radius + hitRadius,
        rootY + minY * crouchScale,
        rootY + maxY * crouchScale,
        multiplier,
      );
      if (candidate) candidates.push(candidate);
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.distance - b.distance || b.multiplier - a.multiplier);
    return candidates[0];
  }

  function removeBullet(bulletId) {
    bullets.delete(bulletId);
  }

  /** One trigger pull: pellets / fan / single round depending on the weapon. */
  function fireVolley(shooter, weapon, now) {
    if (weapon.fan) {
      for (let i = 0; i < weapon.fan; i += 1) {
        spawnBullet(shooter, weapon, now, { yawOffset: (i - (weapon.fan - 1) / 2) * weapon.fanAngle });
      }
    } else if (weapon.pellets) {
      for (let i = 0; i < weapon.pellets; i += 1) spawnBullet(shooter, weapon, now, { cone: weapon.pelletSpread });
    } else {
      spawnBullet(shooter, weapon, now);
    }
  }

  /** LMG-style spin-up: the gap between shots shrinks while the trigger is held. */
  function fireIntervalFor(player, weapon, now) {
    if (!weapon.spinUpStartMs) return weapon.fireIntervalMs;
    if (now - player.lastShotAt > 280) player.spinShots = 0;
    const t = Math.min(1, (player.spinShots || 0) / weapon.spinUpShots);
    return weapon.spinUpStartMs + (weapon.fireIntervalMs - weapon.spinUpStartMs) * t;
  }

  /** Follow-up rounds of a burst, fired from the tick loop. */
  function updateBurst(player, now) {
    if (!player.burstLeft || now < player.burstNextAt) return;
    const weapon = WEAPONS[player.weapon];
    if (!weapon || !weapon.burstCount || !player.alive || player.ammoInMag <= 0 || player.reloadingUntil > now) {
      player.burstLeft = 0;
      return;
    }
    player.burstLeft -= 1;
    player.burstNextAt = now + weapon.burstGapMs;
    player.lastShotAt = now;
    player.ammoInMag -= 1;
    fireVolley(player, weapon, now);
    if (player.ammoInMag <= 0) {
      player.burstLeft = 0;
      player.reloadingUntil = now + weapon.reloadMs;
    }
  }

  /** Rocket splash: falloff damage to players + enemy companions in radius. */
  function explode(bullet, point, now) {
    const ex = bullet.explosive;
    const shooter = players.get(bullet.shooterId);
    for (const target of players.values()) {
      if (!target.alive) continue;
      const d = Math.hypot(target.x - point.x, target.y - 0.8 - point.y, target.z - point.z);
      if (d > ex.radius) continue;
      const self = target.id === bullet.shooterId;
      const dmg = ex.damage * (1 - d / ex.radius) * (self ? ex.selfScale : 1);
      if (dmg <= 0.5) continue;
      target.health -= dmg;
      target.lastDamagedAt = now;
      if (target.health <= 0) {
        killPlayer(target, bullet.shooterName, now);
        if (shooter && !self) shooter.kills += 1;
      } else if (!self) {
        addBulletSnapshotTrail(bullet.shooterId, bullet.weaponKey, now, point, { x: target.x, y: target.y - 0.8, z: target.z }, target.id, { part: "chest", damage: dmg });
      }
    }
    for (const npc of npcs) {
      if (npc.state !== "active" || npc.ownerId === bullet.shooterId) continue;
      const d = Math.hypot(npc.x - point.x, npc.y - 0.6 - point.y, npc.z - point.z);
      if (d > ex.radius) continue;
      if (damageNpc(npcEnv, npc, ex.damage * (1 - d / ex.radius), now) && shooter) shooter.kills += 1;
    }
    structures.applyBlast(point, ex.radius * 0.8, 420, now, { id: bullet.shooterId, name: bullet.shooterName });
    for (const v of vehicles) {
      const d = Math.hypot(v.x - point.x, (v.y || 0) + 1 - point.y, v.z - point.z);
      if (d < ex.radius + 1.5) damageVehicle(vehicleEnv, v, 95 * (1 - d / (ex.radius + 1.5)), now);
    }
    blastTrees(point, ex.radius * 0.7, 400, now, { id: bullet.shooterId, name: bullet.shooterName });
    addVehicleEvent("explosion", { x: round2(point.x), y: round2(Math.max(0.3, point.y)), z: round2(point.z), power: 9 });
  }

  /** End a bullet's flight (rockets detonate wherever they stop). */
  function finishBullet(bullet, point, now) {
    if (bullet.explosive) explode(bullet, point, now);
    removeBullet(bullet.id);
  }

  function spawnBullet(shooter, weapon, now, opts = {}) {
    const moveSpeed = Math.hypot(shooter.vx || 0, shooter.vz || 0);
    const driving = shooter.inVehicle && shooter.vehicleSeat === "driver";
    const spread =
      (weapon.baseSpread || 0) +
      (shooter.inVehicle ? 0 : moveSpeed * (weapon.moveSpreadPerSpeed || 0)) +
      (shooter.input.sprint && !shooter.inVehicle ? weapon.sprintSpread || 0 : 0) +
      (driving ? 0.012 : shooter.inVehicle ? 0.004 : 0); // drive-by is one-handed
    let spreadYaw = (Math.random() * 2 - 1) * spread + (opts.yawOffset || 0);
    let spreadPitch = (Math.random() * 2 - 1) * spread * 0.9;
    if (opts.cone) {
      // Uniform pellet cone.
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * opts.cone;
      spreadYaw += Math.cos(a) * r;
      spreadPitch += Math.sin(a) * r * 0.8;
    }
    const shotYaw = shooter.yaw + spreadYaw;
    const shotPitch = clamp(shooter.pitch + spreadPitch, -1.3, 1.25);

    const cosPitch = Math.cos(shotPitch);
    // Correct -Z forward for Three.js
    const dirX = -Math.sin(shotYaw) * cosPitch;
    const dirY = Math.sin(shotPitch);
    const dirZ = -Math.cos(shotYaw) * cosPitch;

    // Spawn from the weapon muzzle: slightly right of and below the eye,
    // pushed forward along the aim direction.
    const rightX = Math.cos(shooter.yaw);
    const rightZ = -Math.sin(shooter.yaw);
    const origin = {
      x: shooter.x + rightX * 0.2,
      y: shooter.y - 0.14,
      z: shooter.z + rightZ * 0.2,
    };
    const dir = { x: dirX, y: dirY, z: dirZ };
    const muzzleBlockedDist = shotBlockedByObstacle(origin, dir, 0.8);
    const spawnDist = muzzleBlockedDist !== null ? muzzleBlockedDist - 0.05 : 0.8;

    bulletSeq += 1;
    bullets.set(bulletSeq, {
      id: bulletSeq,
      shooterId: shooter.id,
      shooterName: shooter.name,
      weaponKey: weapon.key,
      damage: weapon.damage,
      bodyMultiplier: weapon.bodyMultiplier || 1,
      headMultiplier: weapon.headMultiplier || 2,
      neckMultiplier: weapon.neckMultiplier || 1.55,
      chestMultiplier: weapon.chestMultiplier || weapon.bodyMultiplier || 1,
      armMultiplier: weapon.armMultiplier || 0.7,
      legMultiplier: weapon.legMultiplier || 0.6,
      maxRange: weapon.range,
      travel: 0,
      radius: weapon.bulletRadius,
      gravity: weapon.bulletGravity,
      x: origin.x + dirX * spawnDist,
      y: origin.y + dirY * spawnDist,
      z: origin.z + dirZ * spawnDist,
      vx: dirX * weapon.muzzleSpeed,
      vy: dirY * weapon.muzzleSpeed,
      vz: dirZ * weapon.muzzleSpeed,
      spawnedAt: now,
      lastX: origin.x,
      lastY: origin.y,
      lastZ: origin.z,
      ownVehicle: shooter.inVehicle || null, // never hits the vehicle it's fired from
      pierce: weapon.pierce || 0,
      hitIds: weapon.pierce ? new Set() : null,
      explosive: weapon.explosive || null,
    });

    if (bullets.size > MAX_ACTIVE_BULLETS) {
      const oldestId = bullets.keys().next().value;
      bullets.delete(oldestId);
    }
  }

  function simulateBullets(dtSec, now) {
    for (const bullet of bullets.values()) {
      const from = { x: bullet.x, y: bullet.y, z: bullet.z };
      bullet.lastX = from.x;
      bullet.lastY = from.y;
      bullet.lastZ = from.z;

      bullet.vy -= bullet.gravity * dtSec;
      bullet.x += bullet.vx * dtSec;
      bullet.y += bullet.vy * dtSec;
      bullet.z += bullet.vz * dtSec;

      const to = { x: bullet.x, y: bullet.y, z: bullet.z };
      const segmentLen = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
      bullet.travel += segmentLen;

      // Out of range / time / world / into the ground. Decided now but applied
      // only after the hit tests: a steep downward shot crosses ground level
      // within one tick, and must still hit the roof or prop it passes first.
      const expired =
        bullet.travel >= bullet.maxRange ||
        now - bullet.spawnedAt >= BULLET_MAX_LIFETIME_MS ||
        Math.abs(bullet.x) > WORLD_HALF_SIZE + 2 ||
        Math.abs(bullet.z) > WORLD_HALF_SIZE + 2 ||
        bullet.y < 0.15;

      let obstacleHit = null;
      for (const obstacle of propsAlongSegment(worldProps, from.x, from.z, to.x, to.z)) {
        const d = segmentAabbDistance(from, to, obstacle);
        if (d == null) continue;
        if (obstacleHit == null || d < obstacleHit.distance) {
          obstacleHit = { distance: d, obstacle };
        }
      }

      let targetHit = null;
      for (const target of players.values()) {
        if (!target.alive || target.id === bullet.shooterId) continue;
        if (bullet.hitIds && bullet.hitIds.has(target.id)) continue; // laser already passed through
        const bestForTarget = resolveBodyPartHit(from, to, target, bullet);
        if (!bestForTarget) continue;

        if (!targetHit || bestForTarget.distance < targetHit.distance) {
          targetHit = bestForTarget;
        }
      }

      // Enemy AI companions are shootable too (never your own — see npcBulletHit).
      let npcHit = npcBulletHit(bullet, from, to);
      if (npcHit && bullet.hitIds && bullet.hitIds.has(npcHit.npc.id)) npcHit = null;

      // Vehicles stop bullets (and take damage) — never the one it was fired from.
      let vehicleHit = null;
      for (const v of vehicles) {
        if (v.destroyed || v.id === bullet.ownVehicle) continue;
        if (Math.abs(v.x - from.x) > segmentLen + 8 || Math.abs(v.z - from.z) > segmentLen + 8) continue;
        const h = segmentHitsVehicle(from, to, v);
        if (h && (!vehicleHit || h.distance < vehicleHit.distance)) vehicleHit = { vehicle: v, ...h };
      }

      if (
        targetHit &&
        (!obstacleHit || targetHit.distance <= obstacleHit.distance) &&
        (!npcHit || targetHit.distance <= npcHit.distance) &&
        // Riders can be shot through the windows of the vehicle they sit in.
        (!vehicleHit || targetHit.distance <= vehicleHit.distance || targetHit.target.inVehicle === vehicleHit.vehicle.id)
      ) {
        const hitPoint = {
          x: from.x + (to.x - from.x) * targetHit.t,
          y: from.y + (to.y - from.y) * targetHit.t,
          z: from.z + (to.z - from.z) * targetHit.t,
        };
        const damageMultiplier = targetHit.multiplier || bullet.bodyMultiplier;
        const finalDamage = bullet.damage * damageMultiplier;
        targetHit.target.health -= finalDamage;
        targetHit.target.lastDamagedAt = now;
        if (targetHit.part === "legs") {
          targetHit.target.movementPenaltyUntil = Math.max(
            targetHit.target.movementPenaltyUntil || 0,
            now + 2200,
          );
        }
        if (targetHit.target.health <= 0) {
          killPlayer(targetHit.target, bullet.shooterName, now);
          const shooter = players.get(bullet.shooterId);
          if (shooter) shooter.kills += 1;
        }
        addBulletSnapshotTrail(
          bullet.shooterId,
          bullet.weaponKey,
          now,
          from,
          hitPoint,
          targetHit.target.id,
          { part: targetHit.part, damage: finalDamage }
        );
        if (bullet.hitIds && bullet.hitIds.size < bullet.pierce) {
          bullet.hitIds.add(targetHit.target.id); // piercing beam keeps going
          continue;
        }
        finishBullet(bullet, hitPoint, now);
        continue;
      }

      if (
        vehicleHit &&
        (!obstacleHit || vehicleHit.distance <= obstacleHit.distance) &&
        (!npcHit || vehicleHit.distance <= npcHit.distance)
      ) {
        const hitPoint = {
          x: from.x + (to.x - from.x) * vehicleHit.t,
          y: from.y + (to.y - from.y) * vehicleHit.t,
          z: from.z + (to.z - from.z) * vehicleHit.t,
        };
        if (!bullet.explosive) damageVehicle(vehicleEnv, vehicleHit.vehicle, bullet.damage * 0.2, now);
        addBulletSnapshotTrail(bullet.shooterId, bullet.weaponKey, now, from, hitPoint, null);
        finishBullet(bullet, hitPoint, now);
        continue;
      }

      if (npcHit && (!obstacleHit || npcHit.distance <= obstacleHit.distance)) {
        const hitPoint = {
          x: from.x + (to.x - from.x) * npcHit.t,
          y: from.y + (to.y - from.y) * npcHit.t,
          z: from.z + (to.z - from.z) * npcHit.t,
        };
        const killed = damageNpc(npcEnv, npcHit.npc, bullet.damage, now);
        if (killed) {
          const shooter = players.get(bullet.shooterId);
          if (shooter) shooter.kills += 1;
        }
        addBulletSnapshotTrail(bullet.shooterId, bullet.weaponKey, now, from, hitPoint, null);
        if (bullet.hitIds && bullet.hitIds.size < bullet.pierce) {
          bullet.hitIds.add(npcHit.npc.id);
          continue;
        }
        finishBullet(bullet, hitPoint, now);
        continue;
      }

      if (obstacleHit) {
        const hitPoint = {
          x: from.x + ((to.x - from.x) * obstacleHit.distance) / Math.max(segmentLen, 1e-6),
          y: from.y + ((to.y - from.y) * obstacleHit.distance) / Math.max(segmentLen, 1e-6),
          z: from.z + ((to.z - from.z) * obstacleHit.distance) / Math.max(segmentLen, 1e-6),
        };
        addBulletSnapshotTrail(bullet.shooterId, bullet.weaponKey, now, from, hitPoint, null);
        // Bullets chip at trees, breakable walls and roof tiles (rockets: see explode()).
        if (!bullet.explosive && obstacleHit.obstacle.type === "tree") {
          damageTree(obstacleHit.obstacle, bullet.damage, to.x - from.x, to.z - from.z, now, {
            id: bullet.shooterId,
            name: bullet.shooterName,
          });
        } else if (!bullet.explosive && obstacleHit.obstacle.breakable) {
          structures.damageProp(
            obstacleHit.obstacle,
            bullet.damage * WALL_BULLET_SCALE,
            now,
            { id: bullet.shooterId, name: bullet.shooterName },
          );
        }
        finishBullet(bullet, hitPoint, now);
      } else if (expired) {
        // Clip a ground strike to where the path actually meets the ground.
        let end = to;
        if (to.y < 0.15 && from.y > 0.15) {
          const t = (from.y - 0.15) / (from.y - to.y);
          end = { x: from.x + (to.x - from.x) * t, y: 0.15, z: from.z + (to.z - from.z) * t };
        }
        addBulletSnapshotTrail(bullet.shooterId, bullet.weaponKey, now, from, end, null);
        finishBullet(bullet, end, now);
      }
    }
  }

  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  const vehicleNet = createVehicleNet();
  function getSnapshot(now = Date.now(), includeMeta = false) {
    const vehicleDelta = serializeVehicleDelta(vehicles, vehicleNet, now, includeMeta);
    const liveShots = shotEvents.filter((s) => now - s.at <= SHOT_EVENT_TTL_MS);
    const snapshot = {
      phase,
      timerMs: phaseRemainingMs(now),
      voteStatus: {
        count: votes.size,
        total: players.size,
      },
      zone: {
        x: round2(zone.x),
        z: round2(zone.z),
        radius: round2(zone.radius),
        nextShiftAt: zone.nextShiftAt,
      },
      killFeed,
      shotEvents: liveShots,
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
      groundWeapons: Array.from(groundWeapons.values(), (g) => ({
        id: g.id,
        key: g.key,
        x: round2(g.x),
        y: g.y,
        z: round2(g.z),
        drop: g.source === "drop",
      })),
      destroyedProps: destroyedPropIds,
      treeHp: damagedTrees.size ? Array.from(damagedTrees.entries()) : undefined,
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
          deaths: p.deaths,
          alive: p.alive,
          inVehicle: p.inVehicle,
          seat: p.vehicleSeat || null,
          crouching: p.crouching,
          movementPenaltyMs: Math.max(0, (p.movementPenaltyUntil || 0) - now),
          respawnMs: p.alive ? 0 : Math.max(0, p.respawnAt - now),
          weapon: p.weapon,
          slots: p.slots,
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
        worldHalfSize: WORLD_HALF_SIZE,
        weapons: Object.values(WEAPONS),
        props: worldProps.filter((p) => p.type !== "rubble"), // rubble rides in `structure`
        buildings: buildings.map((b) => ({ id: b.id, kind: b.kind, x: b.x, z: b.z, w: b.w, d: b.d, h: b.h, color: b.color })),
        structure: structures.payload(now),
        terrainPatches,
        wildlife,
        vehicles,
        npcRoles: Object.fromEntries(
          Object.entries(NPC_ROLES).map(([key, cfg]) => [key, { label: cfg.label, color: cfg.color }]),
        ),
      };
    }
    return snapshot;
  }

  function emitSnapshot(now = Date.now(), reliable = false, includeMeta = false) {
    const payload = getSnapshot(now, includeMeta);
    if (reliable) {
      nsp.emit("state", payload);
      return;
    }
    nsp.volatile.emit("state", payload);
  }

  function tick() {
    const now = Date.now();
    const dtSec = Math.min(0.06, (now - lastTickAt) / 1000);
    lastTickAt = now;

    maybeAdvancePhase(now);
    updateZone(now);

    updateLoot(now);
    updateWeather(weather, now);
    structures.update(now);
    if (now - lastStructureEmitAt >= 100 && structures.takeDirty()) {
      lastStructureEmitAt = now;
      nsp.emit("structure", structures.payload(now));
    }
    for (const player of players.values()) {
      maybeFinishReload(player, now);
      updateBurst(player, now);
      applyMovement(player, dtSec);
      applyZoneDamage(player, dtSec, now);
      maybeRespawn(player, now);
    }
    updateVehicles(dtSec);
    updateNpcs(dtSec);
    resolvePlayerCollisions();
    if (phase === "playing") simulateBullets(dtSec, now);

    if (now - lastBroadcastAt >= Math.floor(1000 / BROADCAST_RATE)) {
      lastBroadcastAt = now;
      emitSnapshot(now, false);
    }
  }

  seedLoot(Date.now());
  setInterval(tick, Math.floor(1000 / TICK_RATE));

  nsp.on("connection", (socket) => {
    socket.on("join", (name, ack) => {
      if (players.has(socket.id)) {
        if (typeof ack === "function") ack({ ok: true, id: socket.id });
        return;
      }

      const player = makePlayer(socket.id, name || `Player-${socket.id.slice(0, 4)}`, Date.now());
      players.set(socket.id, player);
      socket.emit("joined", getSnapshot(Date.now(), true));
      if (typeof ack === "function") ack({ ok: true, id: socket.id });
      emitSnapshot(Date.now(), true);
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

    // Accepts a weapon key or a slot index (0-2); only carried weapons switch.
    socket.on("switch_weapon", (weaponKeyOrSlot) => {
      const p = players.get(socket.id);
      if (!p) return;
      const weaponKey = Number.isInteger(weaponKeyOrSlot) ? p.slots[weaponKeyOrSlot] : weaponKeyOrSlot;
      if (!WEAPONS[weaponKey] || !p.slots.includes(weaponKey) || p.weapon === weaponKey) return;
      equipWeapon(p, weaponKey, Date.now());
    });

    // Pick up a ground weapon: it replaces the held slot, the old gun drops.
    socket.on("pickup_weapon", (opts, ack) => {
      if (typeof opts === "function") {
        ack = opts;
        opts = null;
      }
      const reply = (res) => typeof ack === "function" && ack(res);
      const p = players.get(socket.id);
      if (!p || !p.alive || p.inVehicle || phase !== "playing") return reply({ ok: false, reason: "not-active" });
      let item = opts && groundWeapons.get(opts.id);
      if (!item) {
        let best = Infinity;
        for (const g of groundWeapons.values()) {
          const d = Math.hypot(g.x - p.x, g.z - p.z);
          if (d < best) {
            best = d;
            item = g;
          }
        }
      }
      if (!item || Math.hypot(item.x - p.x, item.z - p.z) > PICKUP_RADIUS) return reply({ ok: false, reason: "too-far" });
      if (p.slots.includes(item.key)) return reply({ ok: false, reason: "owned" });

      const now = Date.now();
      let slot = p.slots.indexOf(p.weapon);
      if (slot < 0) slot = 0;
      const old = p.slots[slot];
      p.slots[slot] = item.key;
      groundWeapons.delete(item.id);
      if (item.source === "spawn") lootRespawnQueue.push(now + LOOT_RESPAWN_MS);
      const fx = -Math.sin(p.yaw);
      const fz = -Math.cos(p.yaw);
      spawnGroundWeapon(old, p.x + fx * 0.8, p.z + fz * 0.8, "drop", now);
      equipWeapon(p, item.key, now);
      reply({ ok: true, key: item.key, slot });
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

    // Begin (or keep alive) a hold-to-recruit on the NPC at the player's feet.
    // The server times the 10-second hold in updateNpcFleet while the player
    // stays alive and in range; the client just re-asserts intent.
    // Hold-to-recruit at the roaming beacon: the client re-asserts every
    // ~500ms while F / the button is held; the server times the 10s hold.
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
      if (!p || !p.alive || phase !== "playing") {
        if (typeof ack === "function") ack({ ok: false, reason: "not-active" });
        return;
      }
      const weapon = WEAPONS[p.weapon] || defaultWeapon();
      if (p.reloadingUntil > now) {
        if (typeof ack === "function") ack({ ok: false, reason: "already-reloading" });
        return;
      }
      if (p.ammoInMag >= weapon.magSize) {
        if (typeof ack === "function") ack({ ok: false, reason: "full-mag" });
        return;
      }
      p.reloadingUntil = now + weapon.reloadMs;
      if (typeof ack === "function") ack({ ok: true, reloadMs: weapon.reloadMs });
    });

    socket.on("fire", (ack) => {
      const now = Date.now();
      const p = players.get(socket.id);
      // Everyone can shoot from a vehicle (drivers one-handed: extra spread).
      if (!p || !p.alive || phase !== "playing") {
        if (typeof ack === "function") ack({ ok: false, reason: "not-active" });
        return;
      }

      const weapon = WEAPONS[p.weapon] || defaultWeapon();
      if (p.switchingUntil > now) {
        if (typeof ack === "function") ack({ ok: false, reason: "switching" });
        return;
      }
      if (p.burstLeft > 0) {
        if (typeof ack === "function") ack({ ok: false, reason: "bursting" });
        return;
      }
      if (p.reloadingUntil > now) {
        if (typeof ack === "function") ack({ ok: false, reason: "reloading" });
        return;
      }
      if (now - p.lastShotAt < fireIntervalFor(p, weapon, now)) {
        if (typeof ack === "function") ack({ ok: false, reason: "cooldown" });
        return;
      }
      if (p.ammoInMag <= 0) {
        p.reloadingUntil = now + weapon.reloadMs;
        if (typeof ack === "function") ack({ ok: false, reason: "empty", reloadMs: weapon.reloadMs });
        return;
      }

      p.lastShotAt = now;
      p.ammoInMag -= 1;
      p.spinShots = (p.spinShots || 0) + 1;
      fireVolley(p, weapon, now);
      if (weapon.burstCount && p.ammoInMag > 0) {
        p.burstLeft = weapon.burstCount - 1;
        p.burstNextAt = now + weapon.burstGapMs;
      }
      if (p.ammoInMag <= 0) {
        p.reloadingUntil = now + weapon.reloadMs;
      }

      if (typeof ack === "function") {
        ack({
          ok: true,
          hit: false,
          hitInfo: null,
          ammoInMag: p.ammoInMag,
          magSize: weapon.magSize,
          recoilPitch: weapon.recoilPitch,
          recoilYaw: weapon.recoilYaw,
        });
      }
    });

    socket.on("vote_skip", () => {
      if (phase !== "cooldown" || !players.has(socket.id)) return;
      votes.add(socket.id);
      const now = Date.now();
      const remaining = phaseRemainingMs(now);
      if (votes.size >= players.size && players.size > 0 && remaining > 30000) {
        phaseDurationMs = (now - phaseStartedAt) + 4000;
      }
      emitSnapshot(now, true);
    });

    socket.on("ping_check", (ack) => {
      if (typeof ack === "function") ack({ serverTime: Date.now() });
    });

    socket.on("disconnect", () => {
      const leaving = players.get(socket.id);
      if (leaving && leaving.alive) dropLootWeapons(leaving, Date.now());
      players.delete(socket.id);
      votes.delete(socket.id);
      // Companions leave with their owner.
      cancelRecruit(recruitBeacon, socket.id);
      for (const npc of npcs) {
        if (npc.ownerId === socket.id) {
          npc.state = "dead";
          npc.diedAt = 0;
          npc.ownerId = null;
        }
      }
      emitSnapshot(Date.now(), true);
    });
  });

  // Frag routes: local (/frag) + prod-prefixed (/demo/frag)
  // redirect:false — express.static's own "/frag" -> "/frag/" redirect is
  // absolute and lands outside the public /demo prefix (Caddy strips it).
  app.use("/frag", express.static(path.join(rootDir, "frag", "public"), { redirect: false }));
  app.use("/demo/frag", express.static(path.join(rootDir, "frag", "public"), { redirect: false }));

  // Local route (relative redirect works behind the /demo prefix too)
  app.get("/frag", (req, res, next) => {
    if (req.path.endsWith("/")) return next();
    res.redirect("frag/");
  });
  app.get("/frag/", (_req, res) => {
    res.sendFile(path.join(rootDir, "frag", "public", "index.html"));
  });

  // Prod-prefixed route
  app.get("/demo/frag", (req, res, next) => {
    if (req.path.endsWith("/")) return next();
    res.redirect("frag/");
  });

  app.get("/demo/frag/", (_req, res) => {
    res.sendFile(path.join(rootDir, "frag", "public", "index.html"));
  });
}

module.exports = {
  initFragMode,
  // Shared world/physics helpers reused by other modes (z_plus zombie mode).
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
  PLAYER_CONSTANTS: {
    WORLD_HALF_SIZE,
    PLAYER_RADIUS,
    PLAYER_STEP_HEIGHT,
    PLAYER_HEIGHT,
    PLAYER_COLLISION_RADIUS,
    PLAYER_ACCEL,
    PLAYER_GROUND_FRICTION,
    PLAYER_GRAVITY,
    PLAYER_JUMP_VELOCITY,
    PLAYER_EYE_HEIGHT,
    PLAYER_CROUCH_EYE_HEIGHT,
  },
};
