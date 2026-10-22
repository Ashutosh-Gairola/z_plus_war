/**
 * Shared helpers for first-person weapon designs.
 * All guns are modeled with -Z forward (muzzle at negative z), origin at the
 * receiver above the pistol grip.
 */

export function makeMat(color, roughness = 0.72, metalness = 0.28) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

/** Progress within [a, b] clamped to 0..1. */
export function phase(p, a, b) {
  if (b <= a) return p >= b ? 1 : 0;
  return Math.max(0, Math.min(1, (p - a) / (b - a)));
}

export function easeInOut(t) {
  return t * t * (3 - 2 * t);
}

/** Smooth in-and-back pulse over 0..1. */
export function pulse(t) {
  return Math.sin(Math.max(0, Math.min(1, t)) * Math.PI);
}

/**
 * Star-shaped muzzle flash + glow. Hidden by default; the FPV controller
 * toggles visibility and randomizes rotation/scale per shot.
 */
export function buildMuzzleFlash(size = 1) {
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffd56b,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const coreMat = new THREE.MeshBasicMaterial({
    color: 0xfff3c9,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const flash = new THREE.Group();
  flash.name = "muzzleFlash";
  flash.visible = false;

  const core = new THREE.Mesh(new THREE.SphereGeometry(0.055 * size, 8, 6), coreMat);
  flash.add(core);

  const petalGeo = new THREE.ConeGeometry(0.05 * size, 0.3 * size, 5);
  for (let i = 0; i < 5; i += 1) {
    const petal = new THREE.Mesh(petalGeo, flashMat);
    const angle = (Math.PI * 2 * i) / 5;
    petal.position.set(Math.cos(angle) * 0.06 * size, Math.sin(angle) * 0.06 * size, 0);
    petal.rotation.z = angle + Math.PI / 2;
    petal.rotation.x = Math.PI / 2;
    flash.add(petal);
  }
  const spear = new THREE.Mesh(new THREE.ConeGeometry(0.045 * size, 0.42 * size, 6), flashMat);
  spear.rotation.x = -Math.PI / 2;
  spear.position.z = -0.2 * size;
  flash.add(spear);

  return flash;
}

/** Detachable magazine inside a pivot group so reloads can animate it. */
export function buildMagazine(w, h, d, mat, curve = 0.18) {
  const pivot = new THREE.Group();
  pivot.name = "magazinePivot";
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  body.position.y = -h / 2;
  body.rotation.x = curve;
  body.name = "magazine";
  pivot.add(body);
  const base = new THREE.Mesh(new THREE.BoxGeometry(w * 1.15, h * 0.12, d * 1.15), mat);
  base.position.y = -h * 0.98;
  base.rotation.x = curve;
  pivot.add(base);
  return pivot;
}

/** Pose helpers: a pose is {pos:{x,y,z}, rot:{x,y,z}}. */
export function pose(px, py, pz, rx = 0, ry = 0, rz = 0) {
  return { pos: { x: px, y: py, z: pz }, rot: { x: rx, y: ry, z: rz } };
}

export function mixPose(a, b, t) {
  const s = easeInOut(Math.max(0, Math.min(1, t)));
  return {
    pos: {
      x: a.pos.x + (b.pos.x - a.pos.x) * s,
      y: a.pos.y + (b.pos.y - a.pos.y) * s,
      z: a.pos.z + (b.pos.z - a.pos.z) * s,
    },
    rot: {
      x: a.rot.x + (b.rot.x - a.rot.x) * s,
      y: a.rot.y + (b.rot.y - a.rot.y) * s,
      z: a.rot.z + (b.rot.z - a.rot.z) * s,
    },
  };
}

export function applyPose(obj, p) {
  if (!obj || !p) return;
  obj.position.set(p.pos.x, p.pos.y, p.pos.z);
  obj.rotation.set(p.rot.x, p.rot.y, p.rot.z);
}

/** Walk a keyframe track [{at, pose}...] and return the pose at progress p. */
export function sampleTrack(track, p) {
  if (p <= track[0].at) return track[0].pose;
  for (let i = 1; i < track.length; i += 1) {
    if (p <= track[i].at) {
      const t = (p - track[i - 1].at) / (track[i].at - track[i - 1].at);
      return mixPose(track[i - 1].pose, track[i].pose, t);
    }
  }
  return track[track.length - 1].pose;
}

/** Simple picatinny-style rail strip. */
export function buildRail(w, len, mat) {
  const rail = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(w, 0.024, len), mat);
  rail.add(base);
  const notchGeo = new THREE.BoxGeometry(w * 1.06, 0.012, 0.02);
  const count = Math.floor(len / 0.055);
  for (let i = 0; i < count; i += 1) {
    const notch = new THREE.Mesh(notchGeo, mat);
    notch.position.set(0, 0.016, -len / 2 + 0.03 + i * 0.055);
    rail.add(notch);
  }
  return rail;
}
