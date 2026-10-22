/**
 * Bolt-action sniper rifle — first-person model + reload choreography.
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

const GRIP_RIGHT = pose(0.015, -0.2, 0.18, -0.35, 0, -0.08);
const GRIP_LEFT = pose(-0.05, -0.13, -0.5, -0.25, 0.15, 1.05);

export function buildSniperGun() {
  const gun = new THREE.Group();
  gun.name = "sniper-fpv";

  const black = makeMat(0x14161a, 0.72, 0.32);
  const dark = makeMat(0x23262e, 0.68, 0.3);
  const wood = makeMat(0x4a3524, 0.82, 0.06);
  const green = makeMat(0x3a4434, 0.8, 0.12);

  // Long receiver + full-length stock body.
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.11, 0.55), black);
  receiver.position.set(0, 0.05, -0.08);
  gun.add(receiver);
  const stockBody = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.13, 0.85), green);
  stockBody.position.set(0, -0.03, 0.1);
  gun.add(stockBody);
  const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.3), green);
  cheek.position.set(0, 0.07, 0.42);
  gun.add(cheek);
  const buttPad = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 0.05), black);
  buttPad.position.set(0, -0.0, 0.6);
  gun.add(buttPad);
  const gripCut = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.09), green);
  gripCut.position.set(0, -0.13, 0.22);
  gripCut.rotation.x = 0.45;
  gun.add(gripCut);

  // Fore-end + barrel + brake.
  const foreEnd = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.1, 0.5), green);
  foreEnd.position.set(0, 0.0, -0.55);
  gun.add(foreEnd);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.85, 12), dark);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.05, -1.15);
  gun.add(barrel);
  const brake = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.14, 10), black);
  brake.rotation.x = Math.PI / 2;
  brake.position.set(0, 0.05, -1.6);
  gun.add(brake);

  // Scope: rail, rings, main tube, objective + ocular bells.
  const rail = buildRail(0.05, 0.3, dark);
  rail.position.set(0, 0.115, -0.1);
  gun.add(rail);
  for (const rz of [-0.16, 0.02]) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 12, 1, true), black);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, 0.185, rz);
    gun.add(ring);
  }
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.4, 14), black);
  tube.rotation.x = Math.PI / 2;
  tube.position.set(0, 0.185, -0.07);
  gun.add(tube);
  const objective = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.045, 0.12, 14), black);
  objective.rotation.x = Math.PI / 2;
  objective.position.set(0, 0.185, -0.32);
  gun.add(objective);
  const objLens = new THREE.Mesh(
    new THREE.CircleGeometry(0.048, 14),
    new THREE.MeshStandardMaterial({ color: 0x35506b, roughness: 0.1, metalness: 0.4, emissive: 0x16283a, emissiveIntensity: 0.6 }),
  );
  objLens.rotation.y = Math.PI;
  objLens.position.set(0, 0.185, -0.381);
  gun.add(objLens);
  const ocular = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.048, 0.1, 14), black);
  ocular.rotation.x = Math.PI / 2;
  ocular.position.set(0, 0.185, 0.16);
  gun.add(ocular);
  const turret = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.035, 10), dark);
  turret.position.set(0, 0.24, -0.07);
  gun.add(turret);

  // Bolt handle: rotates up and slides back during reload/cycling.
  const bolt = new THREE.Group();
  bolt.name = "boltHandle";
  bolt.position.set(0.038, 0.07, 0.08);
  const boltArm = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.085, 8), dark);
  boltArm.rotation.z = Math.PI / 2 - 0.5;
  boltArm.position.set(0.032, -0.015, 0);
  bolt.add(boltArm);
  const boltKnob = new THREE.Mesh(new THREE.SphereGeometry(0.02, 10, 8), black);
  boltKnob.position.set(0.065, -0.032, 0);
  bolt.add(boltKnob);
  gun.add(bolt);

  // Box magazine.
  const magPivot = buildMagazine(0.055, 0.14, 0.12, dark, 0.05);
  magPivot.position.set(0, -0.095, -0.1);
  gun.add(magPivot);

  // Bipod (folded).
  for (const sx of [-0.03, 0.03]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.22, 6), dark);
    leg.rotation.x = 1.25;
    leg.position.set(sx, -0.06, -0.72);
    gun.add(leg);
  }

  const flash = buildMuzzleFlash(1.25);
  flash.position.set(0, 0.05, -1.72);
  gun.add(flash);

  gun.userData.cfg = {
    key: "sniper",
    hip: pose(0.3, -0.35, -0.62, 0.0, 0.03, 0.0),
    ads: pose(0, -0.185, -0.3, 0, 0, 0),
    sprint: pose(0.24, -0.46, -0.5, 0.45, -0.6, 0.24),
    muzzleLocal: { x: 0, y: 0.05, z: -1.78 },
    shellLocal: { x: 0.05, y: 0.08, z: 0.05 },
    grips: { right: GRIP_RIGHT, left: GRIP_LEFT },
    fireKick: { z: 0.16, rx: 0.1 },
    reloadSfx: { out: 0.18, in: 0.48, charge: 0.78 },
    adsZoomFov: 26,
    scopeOverlay: true, // full-screen scope when aiming
  };

  return gun;
}

/** Sniper ADS uses the CSS scope overlay; no world-space reticle needed. */
export function buildSniperScope() {
  const scope = new THREE.Group();
  scope.name = "sniper-scope-reticle";
  scope.visible = false;
  return scope;
}

const LEFT_TRACK = [
  { at: 0.0, pose: GRIP_LEFT },
  { at: 0.1, pose: pose(-0.02, -0.22, -0.12, -0.55, 0, 0.5) },
  { at: 0.18, pose: pose(-0.02, -0.26, -0.1, -0.6, 0, 0.55) },      // grab box mag
  { at: 0.3, pose: pose(-0.04, -0.52, 0.02, -0.95, 0, 0.7) },       // pull out
  { at: 0.4, pose: pose(-0.05, -0.5, 0.04, -0.9, 0, 0.7) },         // swap
  { at: 0.52, pose: pose(-0.02, -0.26, -0.1, -0.6, 0, 0.55) },      // insert new mag
  { at: 0.6, pose: pose(-0.02, -0.2, -0.12, -0.5, 0, 0.5) },        // seated
  { at: 0.7, pose: pose(0.02, 0.03, 0.06, -0.2, 0.25, 0.2) },       // reach bolt
  { at: 0.76, pose: pose(0.03, 0.06, 0.08, -0.1, 0.3, 0.1) },       // grip bolt
  { at: 0.82, pose: pose(0.03, 0.09, 0.2, -0.05, 0.3, 0.1) },       // bolt up + back
  { at: 0.88, pose: pose(0.03, 0.07, 0.09, -0.08, 0.3, 0.1) },      // bolt forward
  { at: 0.93, pose: pose(0.03, 0.05, 0.07, -0.12, 0.28, 0.15) },    // lock down
  { at: 1.0, pose: GRIP_LEFT },
];

const GUN_RELOAD_TRACK = [
  { at: 0.0, pose: pose(0, 0, 0, 0, 0, 0) },
  { at: 0.12, pose: pose(0.02, -0.04, 0.05, 0.18, -0.14, 0.36) },
  { at: 0.58, pose: pose(0.02, -0.04, 0.05, 0.18, -0.14, 0.36) },
  { at: 0.7, pose: pose(0.01, -0.02, 0.03, 0.22, -0.08, 0.18) },   // level out for bolt work
  { at: 0.92, pose: pose(0.01, -0.01, 0.02, 0.18, -0.06, 0.12) },
  { at: 1.0, pose: pose(0, 0, 0, 0, 0, 0) },
];

export function animateSniperReload(gun, arms, progress) {
  const magPivot = gun.getObjectByName("magazinePivot");
  const bolt = gun.getObjectByName("boltHandle");
  const leftArm = arms ? arms.getObjectByName("leftArm") : null;

  if (leftArm) {
    const p = sampleTrack(LEFT_TRACK, progress);
    leftArm.position.set(p.pos.x, p.pos.y, p.pos.z);
    leftArm.rotation.set(p.rot.x, p.rot.y, p.rot.z);
  }

  if (magPivot) {
    const out = phase(progress, 0.18, 0.32);
    const back = 1 - phase(progress, 0.46, 0.58);
    const gone = out * back;
    magPivot.position.set(0, -0.095 - gone * 0.36, -0.1 + gone * 0.06);
    magPivot.rotation.z = gone * 0.22;
    magPivot.visible = !(progress > 0.34 && progress < 0.44);
    magPivot.position.y += pulse(phase(progress, 0.56, 0.64)) * 0.012;
  }

  if (bolt) {
    // Rotate handle up, slide back, slide forward, rotate down.
    const up = phase(progress, 0.72, 0.78) - phase(progress, 0.9, 0.95);
    const back = phase(progress, 0.78, 0.83) - phase(progress, 0.84, 0.89);
    bolt.rotation.z = Math.max(0, up) * 1.1;
    bolt.position.z = 0.08 + Math.max(0, back) * 0.14;
  }

  return sampleTrack(GUN_RELOAD_TRACK, progress);
}

// Legacy shim kept so stale imports don't crash.
export function updateSniperAnimation() {}
