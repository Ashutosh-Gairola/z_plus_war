/**
 * Assault rifle — first-person model + reload choreography.
 * -Z is forward; origin sits at the receiver above the pistol grip.
 */

import {
  makeMat,
  buildMuzzleFlash,
  buildMagazine,
  buildRail,
  pose,
  sampleTrack,
  phase,
  pulse,
} from "../common.js";

const GRIP_RIGHT = pose(0.015, -0.2, 0.17, -0.35, 0, -0.08);
const GRIP_LEFT = pose(-0.045, -0.115, -0.42, -0.25, 0.15, 1.05);

export function buildRifleGun() {
  const gun = new THREE.Group();
  gun.name = "rifle-fpv";

  const black = makeMat(0x17181c, 0.72, 0.32);
  const dark = makeMat(0x26282f, 0.68, 0.3);
  const accent = makeMat(0x3a3d33, 0.6, 0.35);
  const polymer = makeMat(0x2c2e26, 0.85, 0.08);
  const brass = makeMat(0xa8823f, 0.4, 0.6);

  // Receiver + upper.
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.15, 0.52), black);
  receiver.position.set(0, 0.02, 0);
  gun.add(receiver);
  const upper = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 0.5), dark);
  upper.position.set(0, 0.11, -0.02);
  gun.add(upper);

  // Top rail.
  const rail = buildRail(0.05, 0.58, dark);
  rail.position.set(0, 0.145, -0.08);
  gun.add(rail);

  // Red-dot sight: housing + emissive dot at local y = 0.205.
  const sightBase = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, 0.1), black);
  sightBase.position.set(0, 0.175, 0.02);
  gun.add(sightBase);
  const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.085, 14, 1, true), black);
  housing.rotation.x = Math.PI / 2;
  housing.position.set(0, 0.205, 0.02);
  gun.add(housing);
  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(0.036, 14),
    new THREE.MeshBasicMaterial({ color: 0x0e1c16, transparent: true, opacity: 0.55 }),
  );
  lens.position.set(0, 0.205, 0.062);
  gun.add(lens);
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.0045, 8),
    new THREE.MeshBasicMaterial({ color: 0xff4d3a }),
  );
  dot.position.set(0, 0.205, 0.058);
  dot.name = "sightDot";
  gun.add(dot);

  // Handguard + side detail.
  const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.082, 0.1, 0.44), polymer);
  handguard.position.set(0, 0.03, -0.52);
  gun.add(handguard);
  for (const sx of [-0.047, 0.047]) {
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.05, 0.36), dark);
    vent.position.set(sx, 0.03, -0.52);
    gun.add(vent);
  }
  const frontSight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.07, 0.03), black);
  frontSight.position.set(0, 0.14, -0.68);
  gun.add(frontSight);

  // Barrel + muzzle brake.
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.019, 0.36, 12), dark);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.05, -0.9);
  gun.add(barrel);
  const brake = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.11, 10), black);
  brake.rotation.x = Math.PI / 2;
  brake.position.set(0, 0.05, -1.1);
  gun.add(brake);

  // Stock: buffer tube + shoulder pad.
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.2, 10), dark);
  tube.rotation.x = Math.PI / 2;
  tube.position.set(0, 0.04, 0.36);
  gun.add(tube);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.15, 0.22), polymer);
  stock.position.set(0, 0.0, 0.52);
  gun.add(stock);

  // Grip + trigger guard.
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.17, 0.075), polymer);
  grip.position.set(0, -0.13, 0.17);
  grip.rotation.x = 0.32;
  gun.add(grip);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.016, 0.11), black);
  guard.position.set(0, -0.09, 0.06);
  gun.add(guard);

  // Magazine (animated during reload).
  const magPivot = buildMagazine(0.058, 0.24, 0.11, accent, 0.2);
  magPivot.position.set(0, -0.075, -0.03);
  gun.add(magPivot);

  // Charging handle (pulled during reload).
  const handle = new THREE.Group();
  handle.name = "chargingHandle";
  handle.position.set(0, 0.115, 0.2);
  const hBody = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.024, 0.07), black);
  handle.add(hBody);
  for (const sx of [-0.035, 0.035]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.02, 0.035), dark);
    wing.position.set(sx, 0, 0.015);
    handle.add(wing);
  }
  gun.add(handle);

  // Ejection port + a visible chambered round hint.
  const port = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.045, 0.12), makeMat(0x0c0d10, 0.5, 0.5));
  port.position.set(0.04, 0.05, -0.05);
  gun.add(port);
  const round = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.05, 6), brass);
  round.rotation.x = Math.PI / 2;
  round.position.set(0.03, 0.05, -0.05);
  gun.add(round);

  const flash = buildMuzzleFlash(1.0);
  flash.position.set(0, 0.05, -1.2);
  gun.add(flash);

  gun.userData.cfg = {
    key: "rifle",
    hip: pose(0.3, -0.33, -0.6, 0.0, 0.03, 0.0),
    ads: pose(0, -0.205, -0.46, 0, 0, 0),
    sprint: pose(0.22, -0.42, -0.5, 0.42, -0.55, 0.22),
    muzzleLocal: { x: 0, y: 0.05, z: -1.16 },
    shellLocal: { x: 0.05, y: 0.06, z: -0.05 },
    grips: { right: GRIP_RIGHT, left: GRIP_LEFT },
    fireKick: { z: 0.085, rx: 0.045 },
    reloadSfx: { out: 0.2, in: 0.52, charge: 0.8 },
    adsZoomFov: 58,
  };

  return gun;
}

/** Rifle uses the red dot for ADS; no full-screen reticle overlay. */
export function buildRifleScope() {
  const scope = new THREE.Group();
  scope.name = "rifle-scope-reticle";
  scope.visible = false;
  return scope;
}

// Reload keyframe tracks (progress 0..1 over the server reload window).
const LEFT_TRACK = [
  { at: 0.0, pose: GRIP_LEFT },
  { at: 0.1, pose: pose(-0.02, -0.2, -0.05, -0.5, 0, 0.5) },      // reach mag
  { at: 0.18, pose: pose(-0.02, -0.24, -0.03, -0.55, 0, 0.55) },  // grab
  { at: 0.32, pose: pose(-0.04, -0.52, 0.08, -0.9, 0, 0.7) },     // rip out + down
  { at: 0.42, pose: pose(-0.05, -0.5, 0.1, -0.85, 0, 0.7) },      // swap mags below view
  { at: 0.55, pose: pose(-0.02, -0.25, -0.02, -0.55, 0, 0.55) },  // bring new mag up
  { at: 0.62, pose: pose(-0.02, -0.19, -0.04, -0.45, 0, 0.5) },   // seat it
  { at: 0.72, pose: pose(-0.01, 0.02, 0.14, -0.2, 0.2, 0.3) },    // move to charging handle
  { at: 0.8, pose: pose(-0.005, 0.075, 0.19, -0.1, 0.25, 0.15) }, // grip handle
  { at: 0.86, pose: pose(-0.005, 0.075, 0.33, -0.1, 0.25, 0.15) },// pull back
  { at: 0.9, pose: pose(-0.005, 0.08, 0.2, -0.1, 0.25, 0.15) },   // release
  { at: 1.0, pose: GRIP_LEFT },
];

const GUN_RELOAD_TRACK = [
  { at: 0.0, pose: pose(0, 0, 0, 0, 0, 0) },
  { at: 0.12, pose: pose(0.02, -0.03, 0.04, 0.14, -0.12, 0.34) },
  { at: 0.6, pose: pose(0.02, -0.03, 0.04, 0.14, -0.12, 0.34) },
  { at: 0.66, pose: pose(0.02, -0.02, 0.03, 0.1, -0.1, 0.26) },   // slap settle
  { at: 0.74, pose: pose(0.01, -0.02, 0.03, 0.18, -0.06, 0.12) }, // tilt for charge
  { at: 0.9, pose: pose(0.01, -0.01, 0.02, 0.16, -0.05, 0.1) },
  { at: 1.0, pose: pose(0, 0, 0, 0, 0, 0) },
];

/**
 * Drive the reload animation. progress 0..1.
 * Returns a gun-space offset pose the FPV controller adds on top of its base pose.
 */
export function animateRifleReload(gun, arms, progress) {
  const magPivot = gun.getObjectByName("magazinePivot");
  const handle = gun.getObjectByName("chargingHandle");
  const leftArm = arms ? arms.getObjectByName("leftArm") : null;

  if (leftArm) applyPoseTo(leftArm, sampleTrack(LEFT_TRACK, progress));

  if (magPivot) {
    const out = phase(progress, 0.18, 0.34);
    const back = 1 - phase(progress, 0.5, 0.62);
    const gone = Math.max(out, 0) * back;
    magPivot.position.set(0 + gone * 0.03, -0.075 - gone * 0.42, -0.03 + gone * 0.1);
    magPivot.rotation.z = gone * 0.3;
    magPivot.visible = !(progress > 0.36 && progress < 0.48); // out of view during swap
    const seat = pulse(phase(progress, 0.6, 0.68));
    magPivot.position.y += seat * 0.012;
  }

  if (handle) {
    const pull = phase(progress, 0.8, 0.86) - phase(progress, 0.86, 0.9);
    handle.position.z = 0.2 + Math.max(0, pull) * 0.13;
  }

  return sampleTrack(GUN_RELOAD_TRACK, progress);
}

function applyPoseTo(obj, p) {
  obj.position.set(p.pos.x, p.pos.y, p.pos.z);
  obj.rotation.set(p.rot.x, p.rot.y, p.rot.z);
}

// Legacy shim kept so stale imports don't crash.
export function updateRifleAnimation() {}
