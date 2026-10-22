/**
 * First-person arms: full forearm + upper arm + gloved hand with fingers.
 * Each arm's root pivot sits at the WRIST, so placing an arm at a weapon's
 * grip point plants the hand there and the rest of the arm trails naturally
 * back toward the camera. Weapon designs move these roots to choreograph
 * reloads and gestures.
 */

function skinMaterials() {
  return {
    skin: new THREE.MeshStandardMaterial({ color: 0xd7a377, roughness: 0.72 }),
    glove: new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.85 }),
    sleeve: new THREE.MeshStandardMaterial({ color: 0x44503a, roughness: 0.82 }),
    cuff: new THREE.MeshStandardMaterial({ color: 0x2e3630, roughness: 0.85 }),
  };
}

function buildHand(isLeft, mats) {
  const hand = new THREE.Group();
  hand.name = isLeft ? "leftHand" : "rightHand";
  const side = isLeft ? 1 : -1;

  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.045, 0.115), mats.glove);
  palm.position.set(0, -0.01, -0.02);
  hand.add(palm);

  const knuckles = new THREE.Mesh(new THREE.BoxGeometry(0.082, 0.04, 0.035), mats.glove);
  knuckles.position.set(0, -0.02, -0.085);
  hand.add(knuckles);

  // Four fingers curled to wrap a grip.
  for (let i = 0; i < 4; i += 1) {
    const finger = new THREE.Group();
    finger.position.set(-0.03 + i * 0.02, -0.028, -0.095);
    finger.rotation.x = -1.35;
    const seg1 = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.017, 0.048), mats.glove);
    seg1.position.z = -0.022;
    finger.add(seg1);
    const seg2 = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.016, 0.036), mats.skin);
    seg2.position.set(0, -0.014, -0.046);
    seg2.rotation.x = -0.8;
    finger.add(seg2);
    hand.add(finger);
  }

  // Thumb wraps the inner side.
  const thumb = new THREE.Group();
  thumb.position.set(side * 0.045, -0.02, -0.03);
  thumb.rotation.set(-0.7, side * 0.65, 0);
  const tseg = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.02, 0.055), mats.glove);
  tseg.position.z = -0.025;
  thumb.add(tseg);
  hand.add(thumb);

  return hand;
}

function buildArm(isLeft) {
  const mats = skinMaterials();
  const side = isLeft ? -1 : 1;

  const arm = new THREE.Group();
  arm.name = isLeft ? "leftArm" : "rightArm";

  arm.add(buildHand(isLeft, mats));

  // Wrist cuff.
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.07, 10), mats.cuff);
  cuff.rotation.x = Math.PI / 2 - 0.35;
  cuff.position.set(side * 0.005, -0.035, 0.06);
  arm.add(cuff);

  // Forearm slopes down-and-back toward the elbow.
  const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.062, 0.32, 10), mats.sleeve);
  forearm.rotation.x = Math.PI / 2 - 0.42;
  forearm.rotation.z = side * 0.1;
  forearm.position.set(side * 0.025, -0.1, 0.21);
  forearm.name = isLeft ? "leftForearm" : "rightForearm";
  arm.add(forearm);

  // Upper arm continues off toward the shoulder (mostly off-screen).
  const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.34, 10), mats.sleeve);
  upper.rotation.x = Math.PI / 2 - 1.05;
  upper.rotation.z = side * 0.22;
  upper.position.set(side * 0.075, -0.28, 0.38);
  arm.add(upper);

  return arm;
}

/**
 * Build both first-person arms. Roots are at the wrists; the caller positions
 * them at the weapon's grip points.
 * @returns {THREE.Group} group named "fpv-arms" with children rightArm/leftArm
 */
export function buildArms() {
  const arms = new THREE.Group();
  arms.name = "fpv-arms";
  arms.add(buildArm(false));
  arms.add(buildArm(true));
  return arms;
}

/** Exponential damp of an arm root toward a {pos, rot} target. */
export function moveArmToward(arm, target, dt, speed = 14) {
  if (!arm || !target) return;
  const k = Math.min(1, dt * speed);
  arm.position.x += (target.pos.x - arm.position.x) * k;
  arm.position.y += (target.pos.y - arm.position.y) * k;
  arm.position.z += (target.pos.z - arm.position.z) * k;
  arm.rotation.x += (target.rot.x - arm.rotation.x) * k;
  arm.rotation.y += (target.rot.y - arm.rotation.y) * k;
  arm.rotation.z += (target.rot.z - arm.rotation.z) * k;
}

/** Convenience: build a pose target object. */
export function armPose(px, py, pz, rx = 0, ry = 0, rz = 0) {
  return { pos: { x: px, y: py, z: pz }, rot: { x: rx, y: ry, z: rz } };
}

// ---- Backwards-compatible shims (older modules import these) ----

export function buildHands() {
  return buildArms();
}

export function restoreNeutralHands() {}

export function updateHandsAnimation() {}
