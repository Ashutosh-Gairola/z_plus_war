/**
 * SMG — compact MP5-style first-person model + reload choreography.
 * -Z is forward; origin at the receiver above the pistol grip.
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

const GRIP_RIGHT = pose(0.015, -0.19, 0.14, -0.35, 0, -0.08);
const GRIP_LEFT = pose(-0.04, -0.13, -0.27, -0.3, 0.12, 1.0);

export function buildSMGGun() {
  const gun = new THREE.Group();
  gun.name = "smg-fpv";

  const black = makeMat(0x1b1c22, 0.7, 0.3);
  const dark = makeMat(0x2c2e36, 0.68, 0.28);
  const polymer = makeMat(0x33302c, 0.85, 0.08);
  const accent = makeMat(0x454336, 0.62, 0.32);

  // Receiver.
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.12, 0.42), black);
  receiver.position.set(0, 0.03, -0.02);
  gun.add(receiver);

  // Rounded top tube typical of the MP5 (runs all the way to the suppressor).
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.72, 12), dark);
  tube.rotation.x = Math.PI / 2;
  tube.position.set(0, 0.1, -0.18);
  gun.add(tube);

  const rail = buildRail(0.045, 0.3, dark);
  rail.position.set(0, 0.145, 0.0);
  gun.add(rail);

  // Iron sights: rear drum + front hooded post (front post = ADS reference).
  const rearSight = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.035, 10), black);
  rearSight.position.set(0, 0.175, 0.12);
  gun.add(rearSight);
  const frontHood = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.04, 10, 1, true), black);
  frontHood.position.set(0, 0.175, -0.5);
  gun.add(frontHood);
  const frontPost = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.03, 0.006), makeMat(0xdddddd, 0.4, 0.5));
  frontPost.position.set(0, 0.17, -0.5);
  frontPost.name = "sightDot";
  gun.add(frontPost);

  // Handguard with vertical foregrip.
  const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.095, 0.3), polymer);
  handguard.position.set(0, 0.02, -0.38);
  gun.add(handguard);
  const foregrip = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.032, 0.13, 10), polymer);
  foregrip.position.set(0, -0.09, -0.34);
  gun.add(foregrip);

  // Barrel + suppressor.
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.2, 10), dark);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.1, -0.58);
  gun.add(barrel);
  const can = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.16, 12), black);
  can.rotation.x = Math.PI / 2;
  can.position.set(0, 0.1, -0.74);
  gun.add(can);

  // Collapsed stock hint + grip + trigger guard.
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.16), dark);
  stock.position.set(0, 0.02, 0.3);
  gun.add(stock);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.15, 0.07), polymer);
  grip.position.set(0, -0.12, 0.14);
  grip.rotation.x = 0.3;
  gun.add(grip);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.014, 0.1), black);
  guard.position.set(0, -0.08, 0.03);
  gun.add(guard);

  // Curved magazine ahead of the trigger.
  const magPivot = buildMagazine(0.05, 0.24, 0.09, accent, 0.32);
  magPivot.position.set(0, -0.05, -0.14);
  gun.add(magPivot);

  // Charging handle on the left of the tube (racked + slapped on reload).
  const handle = new THREE.Group();
  handle.name = "chargingHandle";
  handle.position.set(-0.045, 0.1, -0.3);
  const hRod = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.018, 0.018), black);
  handle.add(hRod);
  const hKnob = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.03, 8), dark);
  hKnob.rotation.z = Math.PI / 2;
  hKnob.position.x = -0.032;
  handle.add(hKnob);
  gun.add(handle);

  const flash = buildMuzzleFlash(0.8);
  flash.position.set(0, 0.1, -0.86);
  gun.add(flash);

  gun.userData.cfg = {
    key: "smg",
    hip: pose(0.28, -0.31, -0.52, 0.0, 0.03, 0.0),
    ads: pose(0, -0.172, -0.4, 0, 0, 0),
    sprint: pose(0.2, -0.4, -0.44, 0.4, -0.5, 0.2),
    muzzleLocal: { x: 0, y: 0.1, z: -0.9 },
    shellLocal: { x: 0.04, y: 0.06, z: -0.08 },
    grips: { right: GRIP_RIGHT, left: GRIP_LEFT },
    fireKick: { z: 0.055, rx: 0.028 },
    reloadSfx: { out: 0.22, in: 0.55, charge: 0.84 },
    adsZoomFov: 64,
  };

  return gun;
}

export function buildSMGSight() {
  const sight = new THREE.Group();
  sight.name = "smg-sight-reticle";
  sight.visible = false;
  return sight;
}

const LEFT_TRACK = [
  { at: 0.0, pose: GRIP_LEFT },
  { at: 0.1, pose: pose(-0.02, -0.18, -0.15, -0.55, 0, 0.5) },
  { at: 0.2, pose: pose(-0.02, -0.22, -0.13, -0.6, 0, 0.55) },     // grab mag
  { at: 0.34, pose: pose(-0.04, -0.5, -0.02, -0.95, 0, 0.7) },     // rip down
  { at: 0.46, pose: pose(-0.05, -0.48, 0.0, -0.9, 0, 0.7) },       // swap below view
  { at: 0.58, pose: pose(-0.02, -0.22, -0.13, -0.6, 0, 0.55) },    // insert
  { at: 0.66, pose: pose(-0.02, -0.17, -0.14, -0.5, 0, 0.5) },     // seated
  { at: 0.76, pose: pose(-0.06, 0.04, -0.26, -0.2, 0.3, 0.6) },    // up to charging handle
  { at: 0.82, pose: pose(-0.07, 0.08, -0.3, -0.1, 0.35, 0.65) },   // hand on knob
  { at: 0.87, pose: pose(-0.07, 0.08, -0.18, -0.1, 0.35, 0.65) },  // rack back
  { at: 0.91, pose: pose(-0.07, 0.06, -0.28, -0.15, 0.3, 0.6) },   // slap release
  { at: 1.0, pose: GRIP_LEFT },
];

const GUN_RELOAD_TRACK = [
  { at: 0.0, pose: pose(0, 0, 0, 0, 0, 0) },
  { at: 0.12, pose: pose(0.02, -0.02, 0.03, 0.16, -0.14, 0.3) },
  { at: 0.62, pose: pose(0.02, -0.02, 0.03, 0.16, -0.14, 0.3) },
  { at: 0.74, pose: pose(0.01, -0.01, 0.02, 0.1, -0.2, 0.42) },    // roll right for HK slap
  { at: 0.9, pose: pose(0.01, -0.01, 0.02, 0.08, -0.16, 0.34) },
  { at: 1.0, pose: pose(0, 0, 0, 0, 0, 0) },
];

export function animateSMGReload(gun, arms, progress) {
  const magPivot = gun.getObjectByName("magazinePivot");
  const handle = gun.getObjectByName("chargingHandle");
  const leftArm = arms ? arms.getObjectByName("leftArm") : null;

  if (leftArm) {
    const p = sampleTrack(LEFT_TRACK, progress);
    leftArm.position.set(p.pos.x, p.pos.y, p.pos.z);
    leftArm.rotation.set(p.rot.x, p.rot.y, p.rot.z);
  }

  if (magPivot) {
    const out = phase(progress, 0.2, 0.36);
    const back = 1 - phase(progress, 0.52, 0.64);
    const gone = out * back;
    magPivot.position.set(0, -0.05 - gone * 0.4, -0.14 + gone * 0.08);
    magPivot.rotation.z = gone * 0.28;
    magPivot.visible = !(progress > 0.38 && progress < 0.5);
    magPivot.position.y += pulse(phase(progress, 0.62, 0.7)) * 0.012;
  }

  if (handle) {
    const racked = phase(progress, 0.82, 0.87) - phase(progress, 0.9, 0.93);
    handle.position.z = -0.3 + Math.max(0, racked) * 0.12;
  }

  return sampleTrack(GUN_RELOAD_TRACK, progress);
}

// Legacy shim kept so stale imports don't crash.
export function updateSMGAnimation() {}
