/**
 * Loot weapons — first-person models + reload / action choreography.
 *
 * Seven guns that are found on the map or dropped by fallen players, each
 * with its own silhouette and mechanic:
 *   shotgun  — pump-action, pellet cone, pump racks after every shot (PUBG S686)
 *   burst    — bullpup 3-round burst rifle with carry-handle sight (Valorant Bulldog)
 *   revolver — heavy six-shooter, swing-out cylinder reload (Valorant Sheriff)
 *   lmg      — belt-fed machine gun, box mag + feed cover reload (Valorant Odin)
 *   spread   — Contra "S": five fanned barrels firing glowing orbs
 *   laser    — Contra "L": coil-wrapped beam rifle that pierces targets
 *   launcher — shoulder-fired rocket tube with splash damage
 *
 * Conventions match the default guns: -Z forward, origin at the receiver
 * above the pistol grip. cfg.cycleMs + cycle() let a design animate an
 * action (pump, hammer, rocket reload) after each shot.
 */

import { makeMat, buildMuzzleFlash, buildMagazine, buildRail, pose, sampleTrack, phase, pulse } from "../common.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const RIGHT_GRIP = pose(0.015, -0.2, 0.17, -0.35, 0, -0.08);

/** Left hand under a handguard whose underside sits at z. */
function handguardGrip(z, y = -0.115) {
  return pose(-0.045, y, z + 0.1, -0.25, 0.15, 1.05);
}

function glow(color, intensity = 1.6) {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.35 });
}

function cyl(parent, rTop, rBot, len, mat, x, y, z, axis = "z", segs = 12) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, len, segs), mat);
  if (axis === "z") m.rotation.x = Math.PI / 2;
  if (axis === "x") m.rotation.z = Math.PI / 2;
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function box(parent, w, h, d, mat, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  parent.add(m);
  return m;
}

function pistolGrip(gun, mat, guardMat) {
  box(gun, 0.055, 0.17, 0.075, mat, 0, -0.13, 0.17, 0.32);
  box(gun, 0.05, 0.016, 0.11, guardMat, 0, -0.09, 0.06);
}

function applyPoseTo(obj, p) {
  obj.position.set(p.pos.x, p.pos.y, p.pos.z);
  obj.rotation.set(p.rot.x, p.rot.y, p.rot.z);
}

/**
 * Generic detachable-mag reload: the left hand drops the mag, swaps it below
 * view, seats a new one, then (optionally) works a charging handle.
 * mag: rest position of the "magazinePivot"; handle: { name, axis, travel, at }.
 */
function makeMagReload({ grip, mag, drop = 0.42, tilt = { x: 0.16, y: -0.14, z: 0.32 }, handle = null, handlePose = null }) {
  const mx = mag.x;
  const my = mag.y;
  const mz = mag.z;
  const left = [
    { at: 0.0, pose: grip },
    { at: 0.1, pose: pose(mx - 0.02, my - 0.125, mz - 0.02, -0.55, 0, 0.5) },
    { at: 0.18, pose: pose(mx - 0.02, my - 0.165, mz, -0.55, 0, 0.55) },
    { at: 0.32, pose: pose(mx - 0.04, my - 0.445, mz + 0.11, -0.9, 0, 0.7) },
    { at: 0.42, pose: pose(mx - 0.05, my - 0.425, mz + 0.13, -0.85, 0, 0.7) },
    { at: 0.55, pose: pose(mx - 0.02, my - 0.175, mz + 0.01, -0.55, 0, 0.55) },
    { at: 0.62, pose: pose(mx - 0.02, my - 0.115, mz - 0.01, -0.45, 0, 0.5) },
  ];
  if (handlePose) {
    left.push({ at: 0.72, pose: handlePose.reach });
    left.push({ at: 0.8, pose: handlePose.grab });
    left.push({ at: 0.86, pose: handlePose.pull });
    left.push({ at: 0.9, pose: handlePose.grab });
  }
  left.push({ at: 1.0, pose: grip });
  const gunTrack = [
    { at: 0.0, pose: pose(0, 0, 0, 0, 0, 0) },
    { at: 0.12, pose: pose(0.02, -0.03, 0.04, tilt.x, tilt.y, tilt.z) },
    { at: 0.62, pose: pose(0.02, -0.03, 0.04, tilt.x, tilt.y, tilt.z) },
    { at: 0.74, pose: pose(0.01, -0.02, 0.03, tilt.x * 0.9, tilt.y * 0.6, tilt.z * 0.5) },
    { at: 1.0, pose: pose(0, 0, 0, 0, 0, 0) },
  ];
  return (gun, arms, progress) => {
    const leftArm = arms ? arms.getObjectByName("leftArm") : null;
    if (leftArm) applyPoseTo(leftArm, sampleTrack(left, progress));
    const magPivot = gun.getObjectByName("magazinePivot");
    if (magPivot) {
      const gone = phase(progress, 0.18, 0.34) * (1 - phase(progress, 0.5, 0.62));
      magPivot.position.set(mx + gone * 0.03, my - gone * drop, mz + gone * 0.1);
      magPivot.rotation.z = gone * 0.3;
      magPivot.visible = !(progress > 0.36 && progress < 0.48);
      magPivot.position.y += pulse(phase(progress, 0.6, 0.68)) * 0.012;
    }
    if (handle) {
      const h = gun.getObjectByName(handle.name);
      if (h) {
        const pull = phase(progress, 0.8, 0.86) - phase(progress, 0.86, 0.9);
        h.position[handle.axis] = handle.rest + Math.max(0, pull) * handle.travel;
      }
    }
    return sampleTrack(gunTrack, progress);
  };
}

function hiddenSight(name) {
  const g = new THREE.Group();
  g.name = name;
  g.visible = false;
  return g;
}

// ---------------------------------------------------------------------------
// Pump shotgun
// ---------------------------------------------------------------------------

const SHOTGUN_LEFT = handguardGrip(-0.44, -0.105);

export function buildShotgunGun() {
  const gun = new THREE.Group();
  gun.name = "shotgun-fpv";
  const steel = makeMat(0x1f2124, 0.5, 0.6);
  const dark = makeMat(0x2a2c30, 0.6, 0.4);
  const wood = makeMat(0x6b4423, 0.7, 0.05);
  const woodDark = makeMat(0x4f3119, 0.75, 0.05);
  const red = makeMat(0xa8261d, 0.55, 0.1);
  const brass = makeMat(0xb08a3e, 0.35, 0.75);

  box(gun, 0.075, 0.12, 0.38, steel, 0, 0.02, 0.0);
  box(gun, 0.073, 0.03, 0.34, dark, 0, 0.09, -0.01); // top rib
  cyl(gun, 0.022, 0.022, 0.78, steel, 0, 0.06, -0.58);
  cyl(gun, 0.02, 0.02, 0.56, dark, 0, 0.005, -0.47); // mag tube
  cyl(gun, 0.026, 0.026, 0.03, steel, 0, 0.06, -0.96); // muzzle band
  const bead = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), makeMat(0xf2e6b0, 0.3, 0.6));
  bead.position.set(0, 0.088, -0.95);
  bead.name = "sightDot";
  gun.add(bead);
  // Ghost-ring rear sight.
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.016, 0.004, 6, 14), steel);
  ring.position.set(0, 0.105, 0.1);
  gun.add(ring);
  box(gun, 0.012, 0.025, 0.012, steel, 0, 0.09, 0.1);

  // Pump forend (racked after each shot).
  const pump = new THREE.Group();
  pump.name = "pump";
  pump.position.set(0, -0.005, -0.44);
  box(pump, 0.082, 0.07, 0.22, woodDark, 0, 0, 0);
  for (let i = 0; i < 6; i += 1) box(pump, 0.084, 0.006, 0.012, wood, 0, -0.036, -0.09 + i * 0.036);
  gun.add(pump);

  // Side saddle with spare shells.
  for (let i = 0; i < 4; i += 1) {
    cyl(gun, 0.011, 0.011, 0.06, red, -0.046, 0.03, -0.1 + i * 0.026, "y", 8);
    cyl(gun, 0.0115, 0.0115, 0.012, brass, -0.046, -0.005, -0.1 + i * 0.026, "y", 8);
  }

  // Wood stock + recoil pad.
  box(gun, 0.06, 0.1, 0.18, wood, 0, -0.01, 0.27, -0.12);
  box(gun, 0.062, 0.14, 0.2, wood, 0, -0.05, 0.44, -0.12);
  box(gun, 0.064, 0.15, 0.025, makeMat(0x111111, 0.95, 0), 0, -0.07, 0.55, -0.12);
  pistolGrip(gun, wood, steel);
  // Loading port.
  box(gun, 0.05, 0.006, 0.12, makeMat(0x0b0b0c, 0.6, 0.2), 0, -0.04, -0.02);

  const flash = buildMuzzleFlash(1.5);
  flash.position.set(0, 0.06, -1.0);
  gun.add(flash);

  gun.userData.cfg = {
    key: "shotgun",
    hip: pose(0.3, -0.31, -0.58, 0.0, 0.03, 0.0),
    ads: pose(0, -0.105, -0.42, 0, 0, 0),
    sprint: pose(0.22, -0.42, -0.5, 0.42, -0.55, 0.22),
    muzzleLocal: { x: 0, y: 0.06, z: -0.98 },
    shellLocal: { x: 0.05, y: 0.04, z: -0.02 },
    grips: { right: RIGHT_GRIP, left: SHOTGUN_LEFT },
    fireKick: { z: 0.17, rx: 0.12 },
    reloadSfx: { out: 0.15, in: 0.45, charge: 0.88 },
    adsZoomFov: 64,
    shellScale: 1.8,
    cycleMs: 620,
    cycle: shotgunCycle,
  };
  return gun;
}

/** Pump back-and-forward after a shot (left hand rides the forend). */
function shotgunCycle(gun, arms, t) {
  const back = phase(t, 0.25, 0.5) - phase(t, 0.55, 0.8);
  const pump = gun.getObjectByName("pump");
  if (pump) pump.position.z = -0.44 + Math.max(0, back) * 0.14;
  const leftArm = arms ? arms.getObjectByName("leftArm") : null;
  if (leftArm) {
    applyPoseTo(leftArm, SHOTGUN_LEFT);
    leftArm.position.z += Math.max(0, back) * 0.14;
  }
  return Math.max(0, back) > 0.01;
}

const SHOTGUN_LEFT_TRACK = (() => {
  const t = [{ at: 0, pose: SHOTGUN_LEFT }];
  // Four shells pushed into the loading port, then rack the pump.
  for (let i = 0; i < 4; i += 1) {
    const base = 0.08 + i * 0.17;
    t.push({ at: base, pose: pose(-0.03, -0.26, 0.06, -0.6, 0.1, 0.6) }); // shell from belt
    t.push({ at: base + 0.08, pose: pose(-0.01, -0.12, -0.03, -0.45, 0.05, 0.5) }); // push in
  }
  t.push({ at: 0.8, pose: SHOTGUN_LEFT });
  t.push({ at: 0.88, pose: pose(-0.045, -0.105, -0.2, -0.25, 0.15, 1.05) });
  t.push({ at: 0.95, pose: SHOTGUN_LEFT });
  t.push({ at: 1, pose: SHOTGUN_LEFT });
  return t;
})();
const SHOTGUN_GUN_TRACK = [
  { at: 0, pose: pose(0, 0, 0, 0, 0, 0) },
  { at: 0.06, pose: pose(-0.02, -0.02, 0.03, 0.12, 0.2, -0.45) }, // roll to show the port
  { at: 0.76, pose: pose(-0.02, -0.02, 0.03, 0.12, 0.2, -0.45) },
  { at: 0.84, pose: pose(0, 0, 0, 0, 0, 0) },
  { at: 1, pose: pose(0, 0, 0, 0, 0, 0) },
];

export function animateShotgunReload(gun, arms, progress) {
  const leftArm = arms ? arms.getObjectByName("leftArm") : null;
  if (leftArm) applyPoseTo(leftArm, sampleTrack(SHOTGUN_LEFT_TRACK, progress));
  const pump = gun.getObjectByName("pump");
  if (pump) pump.position.z = -0.44 + Math.max(0, phase(progress, 0.82, 0.88) - phase(progress, 0.9, 0.95)) * 0.14;
  return sampleTrack(SHOTGUN_GUN_TRACK, progress);
}

// ---------------------------------------------------------------------------
// Burst rifle (bullpup with carry handle)
// ---------------------------------------------------------------------------

const BURST_LEFT = handguardGrip(-0.4, -0.11);

export function buildBurstGun() {
  const gun = new THREE.Group();
  gun.name = "burst-fpv";
  const shell = makeMat(0x7d7258, 0.75, 0.1); // tan polymer
  const black = makeMat(0x18191c, 0.65, 0.35);
  const dark = makeMat(0x2b2d31, 0.6, 0.35);
  const accent = makeMat(0x3c3f45, 0.55, 0.4);

  // Long bullpup body: action sits behind the grip.
  box(gun, 0.08, 0.15, 0.78, shell, 0, 0.02, 0.05);
  box(gun, 0.082, 0.05, 0.6, black, 0, -0.035, 0.08); // lower
  box(gun, 0.084, 0.09, 0.32, shell, 0, 0.0, -0.46); // handguard
  for (let i = 0; i < 5; i += 1) box(gun, 0.086, 0.012, 0.03, dark, 0, 0.03, -0.58 + i * 0.06);
  cyl(gun, 0.018, 0.018, 0.22, black, 0, 0.035, -0.72);
  cyl(gun, 0.026, 0.026, 0.07, dark, 0, 0.035, -0.85); // flash hider

  // Carry handle with integrated sight (ADS line).
  box(gun, 0.03, 0.04, 0.5, shell, 0, 0.165, -0.08);
  box(gun, 0.02, 0.06, 0.03, shell, 0, 0.12, 0.15);
  box(gun, 0.02, 0.06, 0.03, shell, 0, 0.12, -0.31);
  const rear = new THREE.Mesh(new THREE.TorusGeometry(0.012, 0.004, 6, 12), black);
  rear.position.set(0, 0.2, 0.12);
  gun.add(rear);
  const post = box(gun, 0.006, 0.026, 0.006, makeMat(0xe0e0e0, 0.3, 0.4), 0, 0.197, -0.3);
  post.name = "sightDot";

  // Pistol grip ahead of the magazine, mag behind it.
  pistolGrip(gun, black, black);
  const magPivot = buildMagazine(0.055, 0.2, 0.1, accent, 0.12);
  magPivot.position.set(0, -0.06, 0.32);
  gun.add(magPivot);
  box(gun, 0.07, 0.12, 0.04, black, 0, -0.01, 0.48); // butt pad

  const handle = new THREE.Group();
  handle.name = "chargingHandle";
  handle.position.set(0, 0.155, -0.02);
  box(handle, 0.03, 0.025, 0.05, black, 0, 0, 0);
  gun.add(handle);

  const flash = buildMuzzleFlash(1.0);
  flash.position.set(0, 0.035, -0.92);
  gun.add(flash);

  gun.userData.cfg = {
    key: "burst",
    hip: pose(0.29, -0.33, -0.6, 0.0, 0.03, 0.0),
    ads: pose(0, -0.198, -0.4, 0, 0, 0),
    sprint: pose(0.22, -0.42, -0.5, 0.42, -0.55, 0.22),
    muzzleLocal: { x: 0, y: 0.035, z: -0.9 },
    shellLocal: { x: 0.05, y: 0.05, z: 0.18 },
    grips: { right: RIGHT_GRIP, left: BURST_LEFT },
    fireKick: { z: 0.07, rx: 0.035 },
    reloadSfx: { out: 0.22, in: 0.58, charge: 0.84 },
    adsZoomFov: 54,
  };
  return gun;
}

export const animateBurstReload = makeMagReload({
  grip: BURST_LEFT,
  mag: { x: 0, y: -0.06, z: 0.32 },
  drop: 0.38,
  tilt: { x: 0.2, y: -0.25, z: 0.35 },
  handle: { name: "chargingHandle", axis: "z", rest: -0.02, travel: 0.1 },
  handlePose: {
    reach: pose(-0.03, 0.07, 0.02, -0.15, 0.3, 0.5),
    grab: pose(-0.03, 0.1, 0.0, -0.1, 0.3, 0.5),
    pull: pose(-0.03, 0.1, 0.1, -0.1, 0.3, 0.5),
  },
});

// ---------------------------------------------------------------------------
// Revolver
// ---------------------------------------------------------------------------

const REV_RIGHT = pose(0.012, -0.17, 0.12, -0.3, 0, -0.06);
const REV_LEFT = pose(-0.055, -0.2, 0.13, -0.45, 0.55, 0.85); // cupping the grip

export function buildRevolverGun() {
  const gun = new THREE.Group();
  gun.name = "revolver-fpv";
  const steel = makeMat(0x9aa1a8, 0.25, 0.9);
  const darkSteel = makeMat(0x3b3f45, 0.35, 0.8);
  const wood = makeMat(0x5a3a22, 0.6, 0.05);
  const gold = makeMat(0xc9a14a, 0.3, 0.85);

  box(gun, 0.05, 0.1, 0.17, steel, 0, 0.0, 0.02); // frame
  box(gun, 0.052, 0.03, 0.1, darkSteel, 0, 0.065, 0.02); // top strap
  // Barrel with a ventilated top rib + ejector shroud.
  cyl(gun, 0.019, 0.019, 0.3, steel, 0, 0.035, -0.21);
  box(gun, 0.03, 0.03, 0.3, steel, 0, 0.0, -0.21);
  box(gun, 0.016, 0.018, 0.3, darkSteel, 0, 0.06, -0.21);
  const blade = box(gun, 0.006, 0.026, 0.02, gold, 0, 0.077, -0.35);
  blade.name = "sightDot";
  box(gun, 0.03, 0.012, 0.012, darkSteel, 0, 0.085, 0.09); // rear notch

  // Cylinder (rotates per shot, swings out on reload).
  const crane = new THREE.Group();
  crane.name = "crane";
  crane.position.set(-0.01, -0.02, -0.02);
  gun.add(crane);
  const cylinder = new THREE.Group();
  cylinder.name = "cylinder";
  cylinder.position.set(0.01, 0.04, 0.0);
  crane.add(cylinder);
  cyl(cylinder, 0.048, 0.048, 0.1, darkSteel, 0, 0, 0, "z", 18);
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2;
    cyl(cylinder, 0.011, 0.011, 0.102, makeMat(0x0d0d0e, 0.6, 0.3), Math.cos(a) * 0.028, Math.sin(a) * 0.028, 0, "z", 8);
    cyl(cylinder, 0.009, 0.009, 0.01, gold, Math.cos(a) * 0.028, Math.sin(a) * 0.028, 0.05, "z", 8); // case heads
  }

  const hammer = new THREE.Group();
  hammer.name = "hammer";
  hammer.position.set(0, 0.05, 0.1);
  box(hammer, 0.012, 0.045, 0.02, darkSteel, 0, 0.015, 0.01, -0.4);
  gun.add(hammer);

  // Wood grip + trigger guard.
  box(gun, 0.048, 0.15, 0.06, wood, 0, -0.1, 0.11, 0.38);
  box(gun, 0.05, 0.03, 0.065, steel, 0, -0.03, 0.09, 0.38);
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.005, 6, 12, Math.PI), steel);
  guard.rotation.set(0, Math.PI / 2, Math.PI);
  guard.position.set(0, -0.05, 0.03);
  gun.add(guard);

  const flash = buildMuzzleFlash(1.15);
  flash.position.set(0, 0.035, -0.4);
  gun.add(flash);

  gun.userData.cfg = {
    key: "revolver",
    hip: pose(0.2, -0.24, -0.46, 0.0, 0.02, 0.0),
    ads: pose(0, -0.086, -0.38, 0, 0, 0),
    sprint: pose(0.16, -0.36, -0.4, 0.55, -0.35, 0.15),
    muzzleLocal: { x: 0, y: 0.035, z: -0.38 },
    shellLocal: { x: 0, y: 0.04, z: 0 },
    noShells: true, // revolvers keep their brass
    grips: { right: REV_RIGHT, left: REV_LEFT },
    fireKick: { z: 0.1, rx: 0.2 },
    reloadSfx: { out: 0.18, in: 0.55, charge: 0.86 },
    adsZoomFov: 60,
    cycleMs: 300,
    cycle: revolverCycle,
  };
  return gun;
}

/** Hammer falls then re-cocks; cylinder indexes one chamber. */
function revolverCycle(gun, arms, t) {
  const hammer = gun.getObjectByName("hammer");
  if (hammer) hammer.rotation.x = 0.45 * (phase(t, 0, 0.08) - phase(t, 0.3, 0.9)); // fall, then re-cock
  const cylinder = gun.getObjectByName("cylinder");
  if (cylinder) cylinder.rotation.z = (cylinder.userData.index || 0) * (Math.PI / 3) + phase(t, 0.2, 0.7) * (Math.PI / 3);
  if (t >= 1 && cylinder) cylinder.userData.index = ((cylinder.userData.index || 0) + 1) % 6;
  return false;
}

const REV_LEFT_TRACK = [
  { at: 0.0, pose: REV_LEFT },
  { at: 0.1, pose: pose(-0.06, -0.07, -0.02, -0.3, 0.6, 0.9) }, // thumb the cylinder out
  { at: 0.3, pose: pose(-0.08, -0.12, 0.0, -0.4, 0.6, 0.9) },
  { at: 0.42, pose: pose(-0.1, -0.42, 0.12, -0.8, 0.3, 0.7) }, // grab speedloader
  { at: 0.58, pose: pose(-0.09, -0.06, 0.02, -0.35, 0.55, 0.9) }, // load it
  { at: 0.72, pose: pose(-0.06, -0.06, 0.0, -0.3, 0.6, 0.9) },
  { at: 0.84, pose: REV_LEFT },
  { at: 1.0, pose: REV_LEFT },
];
const REV_GUN_TRACK = [
  { at: 0, pose: pose(0, 0, 0, 0, 0, 0) },
  { at: 0.12, pose: pose(-0.04, 0.02, 0.05, -0.4, 0.3, -0.5) }, // muzzle up, tilt left
  { at: 0.3, pose: pose(-0.04, 0.03, 0.05, -0.75, 0.2, -0.3) }, // eject: muzzle to the sky
  { at: 0.4, pose: pose(-0.04, 0.0, 0.05, 0.25, 0.25, -0.5) }, // muzzle down to load
  { at: 0.72, pose: pose(-0.04, 0.0, 0.05, 0.25, 0.25, -0.5) },
  { at: 0.82, pose: pose(0, 0, 0, 0.05, 0.05, 0.1) }, // flick closed
  { at: 1, pose: pose(0, 0, 0, 0, 0, 0) },
];

export function animateRevolverReload(gun, arms, progress) {
  const leftArm = arms ? arms.getObjectByName("leftArm") : null;
  if (leftArm) applyPoseTo(leftArm, sampleTrack(REV_LEFT_TRACK, progress));
  const crane = gun.getObjectByName("crane");
  if (crane) {
    const open = phase(progress, 0.08, 0.16) * (1 - phase(progress, 0.74, 0.8));
    crane.rotation.z = open * 1.2;
    crane.position.x = -0.01 - open * 0.045;
  }
  return sampleTrack(REV_GUN_TRACK, progress);
}

// ---------------------------------------------------------------------------
// LMG
// ---------------------------------------------------------------------------

const LMG_LEFT = handguardGrip(-0.5, -0.12);

export function buildLMGGun() {
  const gun = new THREE.Group();
  gun.name = "lmg-fpv";
  const black = makeMat(0x1a1b1e, 0.62, 0.4);
  const dark = makeMat(0x2d2f33, 0.6, 0.4);
  const olive = makeMat(0x4a4e38, 0.8, 0.12);
  const brass = makeMat(0xb08a3e, 0.35, 0.75);

  box(gun, 0.1, 0.16, 0.52, black, 0, 0.03, -0.02); // receiver
  // Feed cover (opens on reload) with rail + optic.
  const cover = new THREE.Group();
  cover.name = "feedCover";
  cover.position.set(0, 0.11, 0.2);
  box(cover, 0.1, 0.035, 0.36, dark, 0, 0.0, -0.18);
  const rail = buildRail(0.05, 0.3, dark);
  rail.position.set(0, 0.03, -0.18);
  cover.add(rail);
  box(cover, 0.05, 0.05, 0.1, black, 0, 0.07, -0.16); // optic body
  const lens = cyl(cover, 0.026, 0.026, 0.1, black, 0, 0.1, -0.16);
  lens.scale.set(1, 1, 1);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.004, 8), new THREE.MeshBasicMaterial({ color: 0xff4d3a }));
  dot.position.set(0, 0.1, -0.215);
  dot.rotation.y = Math.PI;
  dot.name = "sightDot";
  cover.add(dot);
  gun.add(cover);

  // Perforated heat shroud + heavy barrel + bipod.
  cyl(gun, 0.042, 0.042, 0.42, dark, 0, 0.04, -0.5, "z", 14);
  for (let i = 0; i < 6; i += 1) {
    for (const s of [-1, 1]) cyl(gun, 0.011, 0.011, 0.01, black, s * 0.04, 0.04, -0.35 - i * 0.055, "x", 8);
  }
  cyl(gun, 0.024, 0.024, 0.34, black, 0, 0.04, -0.86);
  cyl(gun, 0.034, 0.034, 0.08, dark, 0, 0.04, -1.04);
  for (const s of [-1, 1]) cyl(gun, 0.008, 0.008, 0.32, black, s * 0.02, -0.0, -0.8, "z", 6); // folded bipod
  box(gun, 0.03, 0.06, 0.24, black, 0, 0.17, -0.02); // carry handle

  // Box magazine on the left + belt into the feed tray.
  const magPivot = new THREE.Group();
  magPivot.name = "magazinePivot";
  magPivot.position.set(-0.02, -0.07, -0.08);
  box(magPivot, 0.12, 0.15, 0.15, olive, -0.03, -0.07, 0);
  box(magPivot, 0.125, 0.02, 0.155, dark, -0.03, 0.0, 0);
  for (let i = 0; i < 5; i += 1) cyl(magPivot, 0.007, 0.007, 0.05, brass, 0.03 + i * 0.0, 0.03 + i * 0.012, 0.0, "x", 6);
  gun.add(magPivot);

  // Skeleton stock + grip.
  box(gun, 0.05, 0.03, 0.3, black, 0, 0.07, 0.36);
  box(gun, 0.05, 0.03, 0.3, black, 0, -0.06, 0.36);
  box(gun, 0.065, 0.16, 0.04, dark, 0, 0.0, 0.52);
  pistolGrip(gun, black, black);

  const flash = buildMuzzleFlash(1.3);
  flash.position.set(0, 0.04, -1.12);
  gun.add(flash);

  gun.userData.cfg = {
    key: "lmg",
    hip: pose(0.31, -0.36, -0.64, 0.0, 0.03, 0.0),
    ads: pose(0, -0.23, -0.42, 0, 0, 0),
    sprint: pose(0.25, -0.46, -0.52, 0.42, -0.6, 0.24),
    muzzleLocal: { x: 0, y: 0.04, z: -1.1 },
    shellLocal: { x: 0.06, y: 0.0, z: 0.0 },
    grips: { right: RIGHT_GRIP, left: LMG_LEFT },
    fireKick: { z: 0.05, rx: 0.025 },
    reloadSfx: { out: 0.22, in: 0.55, charge: 0.8 },
    adsZoomFov: 60,
  };
  return gun;
}

const lmgMagReload = makeMagReload({
  grip: LMG_LEFT,
  mag: { x: -0.02, y: -0.07, z: -0.08 },
  drop: 0.45,
  tilt: { x: 0.2, y: -0.2, z: 0.3 },
});

export function animateLMGReload(gun, arms, progress) {
  const cover = gun.getObjectByName("feedCover");
  if (cover) cover.rotation.x = -(phase(progress, 0.05, 0.15) * (1 - phase(progress, 0.7, 0.8))) * 1.0;
  return lmgMagReload(gun, arms, progress);
}

// ---------------------------------------------------------------------------
// Contra spread gun
// ---------------------------------------------------------------------------

const SPREAD_LEFT = handguardGrip(-0.36, -0.12);

export function buildSpreadGun() {
  const gun = new THREE.Group();
  gun.name = "spread-fpv";
  const metal = makeMat(0x3a3f47, 0.45, 0.65);
  const dark = makeMat(0x1c1e22, 0.55, 0.5);
  const red = makeMat(0xb3261e, 0.45, 0.35);
  const hot = glow(0xff5a2a, 1.8);

  box(gun, 0.1, 0.15, 0.5, metal, 0, 0.03, -0.05);
  box(gun, 0.104, 0.04, 0.46, red, 0, 0.1, -0.05); // red top plate
  box(gun, 0.106, 0.012, 0.3, hot, 0, 0.03, -0.1); // glowing side seam
  // Big "S" badge.
  const badge = box(gun, 0.006, 0.06, 0.06, hot, 0.054, 0.04, -0.12);
  badge.rotation.z = 0;

  // Fan block with five barrels angled outward.
  box(gun, 0.2, 0.08, 0.12, dark, 0, 0.04, -0.36);
  for (let i = 0; i < 5; i += 1) {
    // Outer barrels splay outward, like the fan of shots they throw.
    const a = (i - 2) * 0.12;
    const dir = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
    const base = new THREE.Vector3((i - 2) * 0.03, 0.04, -0.42);
    const barrel = cyl(gun, 0.015, 0.018, 0.26, metal, 0, 0, 0, "z", 10);
    barrel.rotation.set(Math.PI / 2, 0, 0);
    barrel.rotation.order = "YXZ";
    barrel.rotation.y = -a;
    barrel.position.copy(base).addScaledVector(dir, 0.13);
    const tip = cyl(gun, 0.019, 0.019, 0.02, hot, 0, 0, 0, "z", 10);
    tip.rotation.order = "YXZ";
    tip.rotation.y = -a;
    tip.position.copy(base).addScaledVector(dir, 0.26);
  }

  // Energy cell (the "magazine").
  const magPivot = new THREE.Group();
  magPivot.name = "magazinePivot";
  magPivot.position.set(0, -0.06, -0.08);
  box(magPivot, 0.06, 0.13, 0.08, dark, 0, -0.06, 0);
  box(magPivot, 0.045, 0.1, 0.085, hot, 0, -0.06, 0);
  gun.add(magPivot);

  // Sight: open ring over the fan block.
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.004, 6, 18), dark);
  ring.position.set(0, 0.155, -0.25);
  gun.add(ring);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.004, 8), new THREE.MeshBasicMaterial({ color: 0xff3a2a }));
  dot.position.set(0, 0.155, -0.252);
  dot.rotation.y = Math.PI;
  dot.name = "sightDot";
  gun.add(dot);
  box(gun, 0.01, 0.04, 0.01, dark, 0, 0.13, -0.25);

  box(gun, 0.07, 0.11, 0.22, metal, 0, 0.0, 0.32); // stock
  box(gun, 0.072, 0.13, 0.03, red, 0, -0.01, 0.44);
  pistolGrip(gun, dark, dark);

  const flash = buildMuzzleFlash(1.2);
  flash.position.set(0, 0.04, -0.68);
  flash.traverse((o) => o.material && o.material.color && o.material.color.setHex(0xff6a3a));
  gun.add(flash);

  gun.userData.cfg = {
    key: "spread",
    hip: pose(0.3, -0.32, -0.58, 0.0, 0.03, 0.0),
    ads: pose(0, -0.155, -0.4, 0, 0, 0),
    sprint: pose(0.22, -0.42, -0.5, 0.42, -0.55, 0.22),
    muzzleLocal: { x: 0, y: 0.04, z: -0.66 },
    shellLocal: { x: 0.05, y: 0.04, z: -0.05 },
    noShells: true,
    grips: { right: RIGHT_GRIP, left: SPREAD_LEFT },
    fireKick: { z: 0.07, rx: 0.04 },
    reloadSfx: { out: 0.22, in: 0.56, charge: 0.86 },
    adsZoomFov: 64,
  };
  return gun;
}

export const animateSpreadReload = makeMagReload({
  grip: SPREAD_LEFT,
  mag: { x: 0, y: -0.06, z: -0.08 },
  drop: 0.4,
});

// ---------------------------------------------------------------------------
// Contra laser gun
// ---------------------------------------------------------------------------

const LASER_LEFT = handguardGrip(-0.46, -0.11);

export function buildLaserGun() {
  const gun = new THREE.Group();
  gun.name = "laser-fpv";
  const white = makeMat(0xd9dde2, 0.35, 0.3);
  const dark = makeMat(0x22262c, 0.5, 0.5);
  const cyan = glow(0x3ae8ff, 1.8);

  box(gun, 0.085, 0.14, 0.56, white, 0, 0.03, -0.02);
  box(gun, 0.088, 0.04, 0.5, dark, 0, -0.03, -0.02);
  box(gun, 0.09, 0.01, 0.4, cyan, 0, 0.06, -0.05); // glow stripe
  // Coil-wrapped emitter barrel.
  cyl(gun, 0.03, 0.03, 0.55, dark, 0, 0.04, -0.55, "z", 14);
  for (let i = 0; i < 7; i += 1) {
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.036, 0.008, 6, 16), i % 2 ? white : cyan);
    coil.position.set(0, 0.04, -0.36 - i * 0.065);
    gun.add(coil);
  }
  cyl(gun, 0.04, 0.03, 0.06, white, 0, 0.04, -0.85, "z", 14);
  const lensFront = new THREE.Mesh(new THREE.CircleGeometry(0.026, 16), cyan);
  lensFront.position.set(0, 0.04, -0.881);
  lensFront.rotation.y = Math.PI;
  gun.add(lensFront);

  // Holo sight.
  box(gun, 0.05, 0.02, 0.1, dark, 0, 0.11, -0.05);
  const holo = new THREE.Mesh(new THREE.TorusGeometry(0.024, 0.0035, 6, 20), cyan);
  holo.position.set(0, 0.155, -0.08);
  gun.add(holo);
  box(gun, 0.006, 0.05, 0.01, dark, -0.026, 0.14, -0.08);
  box(gun, 0.006, 0.05, 0.01, dark, 0.026, 0.14, -0.08);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.004, 8), new THREE.MeshBasicMaterial({ color: 0x3ae8ff }));
  dot.position.set(0, 0.155, -0.082);
  dot.rotation.y = Math.PI;
  dot.name = "sightDot";
  gun.add(dot);

  const magPivot = new THREE.Group();
  magPivot.name = "magazinePivot";
  magPivot.position.set(0, -0.06, -0.12);
  box(magPivot, 0.06, 0.12, 0.09, white, 0, -0.05, 0);
  box(magPivot, 0.062, 0.03, 0.092, cyan, 0, -0.07, 0);
  gun.add(magPivot);

  box(gun, 0.065, 0.12, 0.26, white, 0, 0.0, 0.36);
  box(gun, 0.068, 0.14, 0.03, dark, 0, -0.01, 0.5);
  pistolGrip(gun, dark, dark);

  const flash = buildMuzzleFlash(0.9);
  flash.position.set(0, 0.04, -0.92);
  flash.traverse((o) => o.material && o.material.color && o.material.color.setHex(0x7af4ff));
  gun.add(flash);

  gun.userData.cfg = {
    key: "laser",
    hip: pose(0.29, -0.33, -0.6, 0.0, 0.03, 0.0),
    ads: pose(0, -0.155, -0.36, 0, 0, 0),
    sprint: pose(0.22, -0.42, -0.5, 0.42, -0.55, 0.22),
    muzzleLocal: { x: 0, y: 0.04, z: -0.9 },
    shellLocal: { x: 0.05, y: 0.04, z: -0.05 },
    noShells: true,
    grips: { right: RIGHT_GRIP, left: LASER_LEFT },
    fireKick: { z: 0.05, rx: 0.02 },
    reloadSfx: { out: 0.22, in: 0.56, charge: 0.86 },
    adsZoomFov: 52,
  };
  return gun;
}

export const animateLaserReload = makeMagReload({
  grip: LASER_LEFT,
  mag: { x: 0, y: -0.06, z: -0.12 },
  drop: 0.4,
});

// ---------------------------------------------------------------------------
// Rocket launcher
// ---------------------------------------------------------------------------

const LAUNCHER_LEFT = pose(-0.04, -0.16, -0.22, -0.3, 0.12, 1.0);

export function buildLauncherGun() {
  const gun = new THREE.Group();
  gun.name = "launcher-fpv";
  const olive = makeMat(0x4b5233, 0.8, 0.12);
  const dark = makeMat(0x1d1f1c, 0.6, 0.4);
  const metal = makeMat(0x55595e, 0.4, 0.7);
  const warheadMat = makeMat(0x5a6340, 0.6, 0.25);

  // Launch tube sits above the grips.
  cyl(gun, 0.058, 0.058, 1.0, olive, 0, 0.06, -0.05, "z", 18);
  cyl(gun, 0.064, 0.064, 0.06, dark, 0, 0.06, -0.52, "z", 18);
  cyl(gun, 0.064, 0.064, 0.05, dark, 0, 0.06, 0.2, "z", 18);
  cyl(gun, 0.06, 0.1, 0.14, dark, 0, 0.06, 0.5, "z", 18); // rear venturi
  // Heat shield pads.
  box(gun, 0.13, 0.04, 0.24, makeMat(0x6b5a3a, 0.9, 0.0), 0, 0.12, 0.0);

  // Warhead loaded in the muzzle.
  const rocket = new THREE.Group();
  rocket.name = "rocket";
  rocket.position.set(0, 0.06, -0.56);
  cyl(rocket, 0.065, 0.055, 0.16, warheadMat, 0, 0, -0.08, "z", 16);
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.065, 0.2, 16), warheadMat);
  cone.rotation.x = -Math.PI / 2;
  cone.position.z = -0.26;
  rocket.add(cone);
  cyl(rocket, 0.012, 0.012, 0.05, metal, 0, 0, -0.38, "z", 8);
  gun.add(rocket);

  // Raised reflex optic on top of the tube.
  box(gun, 0.03, 0.07, 0.03, dark, 0, 0.135, 0.02);
  box(gun, 0.06, 0.012, 0.06, dark, 0, 0.17, 0.02);
  const frame = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.005, 6, 18), dark);
  frame.position.set(0, 0.205, 0.02);
  gun.add(frame);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.005, 8), new THREE.MeshBasicMaterial({ color: 0xff6a2a }));
  dot.position.set(0, 0.205, 0.018);
  dot.rotation.y = Math.PI;
  dot.name = "sightDot";
  gun.add(dot);

  // Two pistol grips under the tube.
  pistolGrip(gun, dark, metal);
  box(gun, 0.05, 0.15, 0.06, dark, 0, -0.08, -0.3, 0.15);

  const flash = buildMuzzleFlash(1.6);
  flash.position.set(0, 0.06, -0.62);
  gun.add(flash);

  gun.userData.cfg = {
    key: "launcher",
    hip: pose(0.28, -0.3, -0.56, 0.0, 0.03, 0.0),
    ads: pose(0, -0.205, -0.5, 0, 0, 0),
    sprint: pose(0.24, -0.42, -0.48, 0.42, -0.55, 0.22),
    muzzleLocal: { x: 0, y: 0.06, z: -0.62 },
    shellLocal: { x: 0, y: 0.06, z: 0.55 },
    noShells: true,
    grips: { right: RIGHT_GRIP, left: LAUNCHER_LEFT },
    fireKick: { z: 0.2, rx: 0.12 },
    reloadSfx: { out: 0.25, in: 0.6, charge: 0.85 },
    adsZoomFov: 58,
    cycleMs: 700,
    cycle: launcherCycle,
  };
  return gun;
}

/** The warhead leaves the tube; the next one slides in if any remain. */
function launcherCycle(gun, arms, t) {
  const rocket = gun.getObjectByName("rocket");
  if (rocket) {
    rocket.visible = t > 0.75;
    rocket.position.z = -0.56 - (1 - phase(t, 0.75, 1)) * 0.3;
  }
  return false;
}

const LAUNCHER_LEFT_TRACK = [
  { at: 0, pose: LAUNCHER_LEFT },
  { at: 0.12, pose: pose(-0.05, -0.4, -0.1, -0.8, 0.2, 0.8) }, // reach back pack
  { at: 0.3, pose: pose(-0.08, -0.5, 0.05, -0.9, 0.2, 0.7) },
  { at: 0.48, pose: pose(-0.02, 0.0, -0.95, -0.1, 0.1, 0.6) }, // rocket at the muzzle
  { at: 0.64, pose: pose(-0.02, 0.0, -0.72, -0.1, 0.1, 0.6) }, // push in
  { at: 0.8, pose: LAUNCHER_LEFT },
  { at: 1, pose: LAUNCHER_LEFT },
];
const LAUNCHER_GUN_TRACK = [
  { at: 0, pose: pose(0, 0, 0, 0, 0, 0) },
  { at: 0.15, pose: pose(-0.06, -0.05, 0.12, 0.25, 0.35, 0.2) }, // muzzle swung in to load
  { at: 0.7, pose: pose(-0.06, -0.05, 0.12, 0.25, 0.35, 0.2) },
  { at: 0.85, pose: pose(0, 0, 0, 0, 0, 0) },
  { at: 1, pose: pose(0, 0, 0, 0, 0, 0) },
];

export function animateLauncherReload(gun, arms, progress) {
  const leftArm = arms ? arms.getObjectByName("leftArm") : null;
  if (leftArm) applyPoseTo(leftArm, sampleTrack(LAUNCHER_LEFT_TRACK, progress));
  const rocket = gun.getObjectByName("rocket");
  if (rocket) {
    // New warhead rides in the left hand, then seats in the tube.
    rocket.visible = progress > 0.4 || progress >= 1;
    const seat = phase(progress, 0.48, 0.64);
    rocket.position.z = -0.56 - (1 - seat) * 0.3;
  }
  return sampleTrack(LAUNCHER_GUN_TRACK, progress);
}

export const LOOT_DESIGNS = {
  shotgun: { build: buildShotgunGun, scope: () => hiddenSight("shotgun-sight"), reload: animateShotgunReload },
  burst: { build: buildBurstGun, scope: () => hiddenSight("burst-sight"), reload: animateBurstReload },
  revolver: { build: buildRevolverGun, scope: () => hiddenSight("revolver-sight"), reload: animateRevolverReload },
  lmg: { build: buildLMGGun, scope: () => hiddenSight("lmg-sight"), reload: animateLMGReload },
  spread: { build: buildSpreadGun, scope: () => hiddenSight("spread-sight"), reload: animateSpreadReload },
  laser: { build: buildLaserGun, scope: () => hiddenSight("laser-sight"), reload: animateLaserReload },
  launcher: { build: buildLauncherGun, scope: () => hiddenSight("launcher-sight"), reload: animateLauncherReload },
};

/** Third-person anchor points (FPV gun space) for weapon-model.js. */
export const LOOT_TP_PRESETS = {
  shotgun: { build: buildShotgunGun, scale: 0.6, grip: [0, -0.13, 0.17], support: [0, -0.04, -0.44], butt: 0.56 },
  burst: { build: buildBurstGun, scale: 0.6, grip: [0, -0.13, 0.17], support: [0, -0.04, -0.42], butt: 0.5 },
  // Pistol: a virtual "butt" far behind the grip pushes it out to arm's length.
  revolver: { build: buildRevolverGun, scale: 0.75, grip: [0, -0.1, 0.11], support: [0, -0.12, 0.08], butt: 0.6 },
  lmg: { build: buildLMGGun, scale: 0.6, grip: [0, -0.13, 0.17], support: [0, -0.04, -0.5], butt: 0.54 },
  spread: { build: buildSpreadGun, scale: 0.62, grip: [0, -0.13, 0.17], support: [0, -0.06, -0.36], butt: 0.45 },
  laser: { build: buildLaserGun, scale: 0.62, grip: [0, -0.13, 0.17], support: [0, -0.04, -0.46], butt: 0.51 },
  launcher: { build: buildLauncherGun, scale: 0.68, grip: [0, -0.13, 0.17], support: [0, -0.14, -0.3], butt: 0.3 },
};
