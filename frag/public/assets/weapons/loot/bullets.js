/**
 * Projectile visuals for the loot weapons. Each returns the moving model plus
 * props for the tracer system (visual speed should match the server's
 * muzzleSpeed so the effect lands when the hit does). Slow "live" projectiles
 * (orbs, rockets) are drawn from the snapshot's bullet list for their whole
 * flight instead of as an end-of-flight tracer.
 */

function basic(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Mesh along +Z (tracers lookAt their target, so +Z is the flight direction). */
function streak(len, radius, color, opacity, z = -len / 2) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 6, 1, true), basic(color, opacity));
  m.rotation.x = Math.PI / 2;
  m.position.z = z;
  return m;
}

function pellet() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 4), basic(0xffe9a0)));
  g.add(streak(0.6, 0.012, 0xffb340, 0.55));
  return g;
}

function slug(color, trail, len = 1.4, r = 0.03) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(r * 2.4, r * 2.4, 0.18), basic(color)));
  g.add(streak(len, r * 0.8, trail, 0.6, -len / 2 - 0.1));
  return g;
}

/** Contra "S" orb: hot core + soft red halo. */
function orb() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), basic(0xfff0d0)));
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), basic(0xff3a1a, 0.55)));
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 8), basic(0xff1a00, 0.18)));
  return g;
}

/** Contra "L" beam: a long cyan bolt with a white core. */
function beam() {
  const g = new THREE.Group();
  g.add(streak(9, 0.025, 0xffffff, 0.95));
  g.add(streak(9, 0.07, 0x3ae8ff, 0.55));
  g.add(streak(9, 0.13, 0x1aa8ff, 0.2));
  return g;
}

function rocket() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 0.5, 10),
    new THREE.MeshStandardMaterial({ color: 0x5a6340, roughness: 0.6, transparent: true }),
  );
  body.rotation.x = Math.PI / 2;
  g.add(body);
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.06, 0.2, 10),
    new THREE.MeshStandardMaterial({ color: 0x3b3f2a, roughness: 0.5, transparent: true }),
  );
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 0.35;
  g.add(nose);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.6, 8, 1, true), basic(0xffa040, 0.9));
  flame.rotation.x = -Math.PI / 2;
  flame.position.z = -0.55;
  g.add(flame);
  g.add(streak(3.5, 0.12, 0x9a9a9a, 0.22, -2.4)); // smoke trail
  return g;
}

export const LOOT_BULLETS = {
  shotgun: { build: pellet, props: { speed: 140, sparkColor: 0xffd27a, sparkCount: 2, smoke: false } },
  burst: { build: () => slug(0xfff2b0, 0xffb84a), props: { speed: 170, sparkColor: 0x88ff88 } },
  revolver: { build: () => slug(0xffe0a0, 0xff8a2a, 1.8, 0.035), props: { speed: 160, sparkColor: 0xffc070 } },
  lmg: { build: () => slug(0xffb0a0, 0xff3a2a, 1.6), props: { speed: 160, sparkColor: 0xff9a7a } },
  spread: { build: orb, props: { speed: 72, sparkColor: 0xff5a2a, sparkCount: 4, smoke: false, live: true } },
  laser: { build: beam, props: { speed: 520, sparkColor: 0x7af4ff, sparkCount: 5, smoke: false } },
  launcher: { build: rocket, props: { speed: 48, sparkColor: 0xffa040, sparkCount: 0, smoke: false, noMark: true, live: true } },
};
