/**
 * Champion boss models (Z+). Detailed procedural figures at height 1 (the
 * caller scales by H), facing -Z. Each is an original design in the spirit
 * of a soulslike archetype:
 *
 *   scarlet  winged golden helm, flowing crimson hair, golden prosthetic arm
 *            and greaves, shredded crimson skirt, long curved katana;
 *            phase 2: a blooming scarlet flower of rot behind her.
 *   titan    colossal armored lord with a lion-faced helm and a huge red
 *            mane, twin curved gravity greatswords, riding a tiny horse.
 *   omen     hunched old omen: long white hair and beard, curling horns,
 *            heavy tattered cloak, gnarled cane, conjured golden weapons.
 *   beast    black wolf-headed beast in shaggy fur and tattered wraps, bone
 *            claws; phase 2: the black blade with burning red runes.
 *   blood    towering blood lord: crown of curved horns, crimson robe with
 *            gold trim, ornate trident; phase 2: great bat-like blood wings.
 *
 * Rig contract (used by animateChampion in boss-fx.js): root, body, hips,
 * torso, neck, head, arms[{sh, el, hand, side}], legs[{hip, knee, foot,
 * side}], cape, props, plus cloth[] for waving fabric.
 */

import { undeadify } from "./boss-undead.js";
export { animateUndead } from "./boss-undead.js";

// ---------------------------------------------------------------------------
// Materials & primitives
// ---------------------------------------------------------------------------

function mat(color, roughness = 0.6, metalness = 0.2, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
}
function metal(color, roughness = 0.32) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.92 });
}
function cloth(color, roughness = 0.95) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, side: THREE.DoubleSide });
}
function glow(color, intensity = 2.4, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.4, ...extra });
}
function M(geo, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Solid of revolution around Y. pts: [[radius, y], ...] bottom to top. */
function lathe(pts, material, segs = 18, sx = 1, sz = 1) {
  const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), segs);
  g.scale(sx, 1, sz);
  g.computeVertexNormals();
  return M(g, material);
}

/** Muscled limb hanging down (-Y) from its joint: bulge near the top. */
function limbMesh(len, r0, r1, material, bulge = 1.15, sx = 1, sz = 1) {
  const pts = [
    [r1 * 0.85, -len],
    [r1, -len * 0.92],
    [(r0 + r1) * 0.5 * bulge, -len * 0.55],
    [r0 * bulge, -len * 0.22],
    [r0, -len * 0.04],
    [r0 * 0.7, 0.01],
  ];
  return lathe(pts, material, 12, sx, sz);
}

/** Tapered curved tube along points (horns, tails, gnarled wood). */
function taperTube(points, r0, r1, material, radial = 8, segs = 24) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  const g = new THREE.TubeGeometry(curve, segs, 1, radial, false);
  const pos = g.attributes.position;
  for (let i = 0; i <= segs; i += 1) {
    const t = i / segs;
    const c = curve.getPointAt(t);
    const r = r0 + (r1 - r0) * t;
    for (let j = 0; j <= radial; j += 1) {
      const k = i * (radial + 1) + j;
      pos.setXYZ(k, c.x + (pos.getX(k) - c.x) * r, c.y + (pos.getY(k) - c.y) * r, c.z + (pos.getZ(k) - c.z) * r);
    }
  }
  g.computeVertexNormals();
  return M(g, material);
}

/** Blade pointing forward (-Z) from the hand, optionally curved upward. */
function bladeMesh(len, width, thick, material, curve = 0, tipTaper = 0.15) {
  const g = new THREE.BoxGeometry(width, thick, len, 2, 1, 16);
  g.translate(0, 0, -len / 2);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const z = pos.getZ(i);
    const t = -z / len; // 0 at hand -> 1 at tip
    // Taper to a point and curve the blade.
    const w = 1 - Math.max(0, t - (1 - tipTaper)) / tipTaper;
    pos.setX(i, pos.getX(i) * Math.max(0.05, w));
    pos.setY(i, pos.getY(i) + curve * t * t * len);
  }
  g.computeVertexNormals();
  return M(g, material);
}

/** Hair / fur strands hanging from a scalp area. */
function strands(group, n, opts) {
  const { center, radius, len, lenVar = 0.3, r = 0.008, color, back = 0.6, spread = 1, mat: material } = opts;
  const m = material || mat(color, 0.85, 0.05);
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2 * spread + (spread < 1 ? Math.PI * (1 - spread) : 0) + (Math.random() - 0.5) * 0.3;
    const ox = Math.sin(a) * radius;
    const oz = Math.cos(a) * radius;
    const L = len * (1 + (Math.random() - 0.5) * lenVar * 2);
    const sway = (Math.random() - 0.5) * 0.04;
    const pts = [
      [center[0] + ox, center[1], center[2] + oz],
      [center[0] + ox * 1.25 + sway, center[1] - L * 0.35, center[2] + oz * 1.2 + back * L * 0.25],
      [center[0] + ox * 1.35 + sway * 2, center[1] - L * 0.7, center[2] + oz * 1.2 + back * L * 0.45],
      [center[0] + ox * 1.4 + sway * 3, center[1] - L, center[2] + oz * 1.25 + back * L * 0.55],
    ];
    group.add(taperTube(pts, r, r * 0.15, m, 5, 8));
  }
}

/** Segmented flowing cloth hanging from a bar (capes, skirts, tabards). */
function clothPanel(width, len, material, cols = 6, rows = 10, jagged = 0) {
  const g = new THREE.PlaneGeometry(width, len, cols, rows);
  g.translate(0, -len / 2, 0);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const y = pos.getY(i);
    if (jagged && y < -len * 0.9) {
      // Tattered hem.
      const x = pos.getX(i);
      pos.setY(i, y + Math.abs(Math.sin(x * 97.1)) * jagged * len);
    }
  }
  g.computeVertexNormals();
  const m = M(g, material);
  m.userData.base = Float32Array.from(pos.array);
  m.userData.len = len;
  return m;
}

/** Feathered / petal wing made of overlapping long planes. */
function featherFan(n, len, width, material, spread = 1.2) {
  const g = new THREE.Group();
  for (let i = 0; i < n; i += 1) {
    const geo = new THREE.PlaneGeometry(width, len, 1, 4);
    geo.translate(0, len / 2, 0);
    const pos = geo.attributes.position;
    for (let k = 0; k < pos.count; k += 1) {
      const t = pos.getY(k) / len;
      pos.setX(k, pos.getX(k) * (1 - t * 0.7)); // feather tip
      pos.setZ(k, t * t * len * 0.25); // curls back
    }
    geo.computeVertexNormals();
    const f = M(geo, material);
    f.material = material.side === THREE.DoubleSide ? material : Object.assign(material.clone(), { side: THREE.DoubleSide });
    f.rotation.z = -spread / 2 + (spread * i) / Math.max(1, n - 1);
    f.scale.setScalar(0.75 + 0.25 * Math.sin((i / Math.max(1, n - 1)) * Math.PI));
    g.add(f);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

/**
 * Shared humanoid skeleton. cfg sets proportions; parts are filled by each
 * champion's builder.
 */
function skeleton(cfg) {
  const {
    shoulderW = 0.17,
    hipW = 0.075,
    thigh = 0.24,
    shin = 0.23,
    upperArm = 0.17,
    foreArm = 0.16,
    torsoH = 0.3,
    neckH = 0.05,
  } = cfg;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const hips = new THREE.Group();
  hips.position.y = 0.5;
  body.add(hips);
  const torso = new THREE.Group();
  torso.position.y = 0.03;
  hips.add(torso);
  const neck = new THREE.Group();
  neck.position.y = torsoH;
  torso.add(neck);
  const head = new THREE.Group();
  head.position.y = neckH;
  neck.add(head);
  const arms = [];
  for (const side of [-1, 1]) {
    const sh = new THREE.Group();
    sh.position.set(side * shoulderW, torsoH - 0.045, 0);
    torso.add(sh);
    const el = new THREE.Group();
    el.position.y = -upperArm;
    sh.add(el);
    const hand = new THREE.Group();
    hand.position.y = -foreArm;
    el.add(hand);
    arms.push({ sh, el, hand, side, upperArm, foreArm });
  }
  const legs = [];
  for (const side of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(side * hipW, -0.02, 0);
    hips.add(hip);
    const knee = new THREE.Group();
    knee.position.y = -thigh;
    hip.add(knee);
    const foot = new THREE.Group();
    foot.position.y = -shin;
    knee.add(foot);
    legs.push({ hip, knee, foot, side, thigh, shin });
  }
  const cape = new THREE.Group(); // filled by builders (may stay empty)
  torso.add(cape);
  return { root, body, hips, torso, neck, head, arms, legs, cape, props: {}, cloth: [], phase: 0, swingT: 99, swingKind: null, extras: {} };
}

/** Standard armored limbs: pauldrons, vambraces, gauntlets, greaves, boots. */
function dressLimbs(R, o) {
  const { armMat, legMat, jointMat, handMat, armR = 0.045, legR = 0.065, pauldron = 0.07, pauldronMat, bootMat } = o;
  for (const A of R.arms) {
    if (pauldron) {
      const pg = new THREE.SphereGeometry(pauldron, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55);
      const p = M(pg, pauldronMat || jointMat, 0, 0.015, 0);
      p.scale.set(1.25, 0.95, 1.15);
      p.rotation.z = -A.side * 0.35;
      A.sh.add(p);
      // A second, lower lame.
      const p2 = M(new THREE.SphereGeometry(pauldron * 0.85, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.45), pauldronMat || jointMat, A.side * 0.012, -0.03, 0);
      p2.scale.set(1.2, 0.8, 1.1);
      p2.rotation.z = -A.side * 0.5;
      A.sh.add(p2);
    }
    A.sh.add(limbMesh(A.upperArm, armR, armR * 0.82, armMat));
    A.el.add(M(new THREE.SphereGeometry(armR * 0.9, 10, 8), jointMat));
    A.el.add(limbMesh(A.foreArm * 0.6, armR * 0.85, armR * 0.75, armMat, 1.1));
    // Gauntlet cuff flaring at the wrist.
    A.el.add(lathe([[armR * 0.72, -A.foreArm], [armR * 1.05, -A.foreArm * 0.8], [armR * 0.95, -A.foreArm * 0.5], [armR * 0.82, -A.foreArm * 0.45]], jointMat, 12));
    const fist = M(new THREE.BoxGeometry(armR * 1.3, armR * 1.5, armR * 1.4), handMat || jointMat, 0, -armR * 0.55, 0);
    A.hand.add(fist);
  }
  for (const L of R.legs) {
    L.hip.add(limbMesh(L.thigh, legR, legR * 0.8, legMat, 1.12));
    L.knee.add(M(new THREE.SphereGeometry(legR * 0.85, 10, 8), jointMat, 0, 0, -0.008));
    const cop = M(new THREE.ConeGeometry(legR * 0.6, legR * 1.1, 6), jointMat, 0, 0.01, -legR * 0.8);
    cop.rotation.x = -Math.PI / 2;
    L.knee.add(cop);
    // Greave flaring toward the ankle.
    L.knee.add(lathe([[legR * 0.75, -L.shin], [legR * 0.85, -L.shin * 0.85], [legR * 0.9, -L.shin * 0.5], [legR * 0.8, -L.shin * 0.1], [legR * 0.6, 0]], legMat, 12));
    const boot = M(new THREE.BoxGeometry(legR * 1.3, legR * 0.7, legR * 2.3), bootMat || jointMat, 0, -legR * 0.25, -legR * 0.45);
    L.foot.add(boot);
    const toe = M(new THREE.ConeGeometry(legR * 0.62, legR * 0.9, 6), bootMat || jointMat, 0, -legR * 0.35, -legR * 1.95);
    toe.rotation.x = -Math.PI / 2;
    L.foot.add(toe);
  }
}

// ---------------------------------------------------------------------------
// Champions
// ---------------------------------------------------------------------------

function buildScarlet() {
  const R = skeleton({ shoulderW: 0.13, hipW: 0.06, torsoH: 0.29, thigh: 0.25, shin: 0.24 });
  const gold = metal(0xd2a03c, 0.28);
  const goldDark = metal(0x8a6420, 0.4);
  const crimson = mat(0x8c1414, 0.55, 0.15);
  const crimsonCloth = cloth(0xa0141a);
  const skin = mat(0xe8d6c4, 0.75, 0);
  const hair = mat(0xb21e14, 0.8, 0.05);

  // Slender armored torso: narrow waist, chest plate, belt.
  R.torso.add(lathe([[0.075, 0], [0.068, 0.06], [0.082, 0.14], [0.105, 0.21], [0.1, 0.26], [0.06, 0.3]], crimson, 20, 1, 0.75));
  R.torso.add(lathe([[0.0, 0.13], [0.09, 0.14], [0.108, 0.2], [0.098, 0.25], [0.05, 0.285]], gold, 20, 1.02, 0.78));
  R.torso.add(lathe([[0.085, 0.0], [0.09, 0.02], [0.085, 0.04]], goldDark, 20, 1, 0.8)); // belt
  R.hips.add(lathe([[0.06, -0.05], [0.085, -0.02], [0.08, 0.04]], crimson, 16, 1, 0.8));

  // Head: pale face, winged golden helm, flowing red hair.
  R.head.add(M(new THREE.SphereGeometry(0.045, 16, 12), skin, 0, 0.0, -0.005));
  const helm = M(new THREE.SphereGeometry(0.052, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.58), gold, 0, 0.004, 0);
  helm.scale.set(1, 1.05, 1.15);
  R.head.add(helm);
  const visor = M(new THREE.BoxGeometry(0.075, 0.018, 0.02), goldDark, 0, 0.002, -0.05);
  R.head.add(visor);
  const crest = taperTube([[0, 0.055, -0.04], [0, 0.07, 0], [0, 0.065, 0.05], [0, 0.04, 0.08]], 0.008, 0.002, gold);
  R.head.add(crest);
  for (const s of [-1, 1]) {
    // Great feathered wings sweeping up and back from the temples.
    const wing = featherFan(8, 0.2, 0.045, gold, 1.0);
    wing.position.set(s * 0.048, 0.03, 0.005);
    wing.rotation.set(0.35, s * 0.25, -s * 0.55);
    R.head.add(wing);
  }
  strands(R.head, 26, { center: [0, 0.03, 0.02], radius: 0.035, len: 0.34, color: 0xb21e14, mat: hair, back: 1.0, spread: 0.55, r: 0.01 });
  // Locks falling forward over both shoulders.
  for (const s of [-1, 1]) {
    for (let i = 0; i < 5; i += 1) {
      const x = s * (0.035 + i * 0.006);
      R.head.add(taperTube([[x, 0.02, -0.005], [x * 1.4, -0.06, -0.03], [x * 1.7, -0.16, -0.04], [x * 1.8, -0.26, -0.03]], 0.011, 0.002, hair, 5, 10));
    }
  }

  dressLimbs(R, { armMat: crimson, legMat: gold, jointMat: goldDark, armR: 0.034, legR: 0.05, pauldron: 0.055, pauldronMat: gold });
  // Left arm is a golden prosthetic: swap its sleeve for segmented gold.
  const left = R.arms[0];
  left.sh.traverse((c) => { if (c.material === crimson) c.material = gold; });
  for (let i = 0; i < 4; i += 1) left.sh.add(M(new THREE.TorusGeometry(0.034, 0.006, 6, 14), goldDark, 0, -0.03 - i * 0.035, 0).rotateX(Math.PI / 2));

  // Shredded crimson skirt panels + long cape.
  for (let i = 0; i < 7; i += 1) {
    const a = -1.3 + (i / 6) * 2.6;
    const panel = clothPanel(0.07, 0.3, crimsonCloth, 2, 8, 0.12);
    panel.position.set(Math.sin(a) * 0.07, 0.0, -Math.cos(a) * 0.055);
    panel.rotation.set(-0.12, a, 0);
    R.hips.add(panel);
    R.cloth.push(panel);
  }
  const cape = clothPanel(0.22, 0.62, crimsonCloth, 6, 12, 0.1);
  cape.position.set(0, 0.26, 0.06);
  R.cape.add(cape);
  R.cloth.push(cape);

  // Katana: long, thin, gently curved; round guard.
  const kat = new THREE.Group();
  kat.add(M(new THREE.CylinderGeometry(0.008, 0.008, 0.07, 6).rotateX(Math.PI / 2), mat(0x2a1a14, 0.8, 0), 0, -0.01, 0.025));
  kat.add(M(new THREE.CylinderGeometry(0.022, 0.022, 0.006, 14).rotateX(Math.PI / 2), gold, 0, -0.01, -0.012));
  const edge = bladeMesh(0.62, 0.016, 0.005, metal(0xe8eaf0, 0.12), 0.09, 0.1);
  edge.position.set(0, -0.01, -0.015);
  kat.add(edge);
  R.arms[1].hand.add(kat);
  R.props.weapon = kat;

  // Phase 2: a scarlet flower of rot blooming behind her back.
  const bloom = new THREE.Group();
  const petal = glow(0xff4a24, 1.3, { side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
  const petalDark = glow(0xb0140c, 1.0, { side: THREE.DoubleSide, transparent: true, opacity: 0.9 });
  for (let ring = 0; ring < 2; ring += 1) {
    const n = ring ? 8 : 6;
    for (let i = 0; i < n; i += 1) {
      const shape = new THREE.Shape();
      const L = ring ? 0.42 : 0.3;
      shape.moveTo(0, 0);
      shape.bezierCurveTo(L * 0.35, L * 0.25, L * 0.3, L * 0.85, 0, L);
      shape.bezierCurveTo(-L * 0.3, L * 0.85, -L * 0.35, L * 0.25, 0, 0);
      const p = M(new THREE.ShapeGeometry(shape, 10), ring ? petal : petalDark);
      p.rotation.z = (i / n) * Math.PI * 2 + ring * 0.3;
      p.rotation.x = -0.35 - ring * 0.2;
      bloom.add(p);
    }
  }
  bloom.add(M(new THREE.SphereGeometry(0.05, 12, 10), glow(0xffb070, 2.5)));
  bloom.position.set(0, 0.2, 0.12);
  bloom.visible = false;
  R.torso.add(bloom);
  R.props.wings = bloom;
  return R;
}

function buildTitan() {
  const R = skeleton({ shoulderW: 0.22, hipW: 0.09, torsoH: 0.3, thigh: 0.22, shin: 0.21, upperArm: 0.18, foreArm: 0.17 });
  const iron = metal(0x4a4038, 0.45);
  const ironDark = metal(0x2c2620, 0.5);
  const bronze = metal(0x8a6a3a, 0.4);
  const mane = mat(0xc8361a, 0.8, 0.02);
  const maneDark = mat(0x8a1e10, 0.85, 0.02);
  const capeMat = cloth(0x6a1c12);

  // Barrel chest and gut, heavy plates.
  R.torso.add(lathe([[0.12, 0], [0.15, 0.06], [0.17, 0.14], [0.19, 0.21], [0.17, 0.27], [0.08, 0.31]], iron, 22, 1, 0.82));
  R.torso.add(lathe([[0.0, 0.13], [0.17, 0.15], [0.195, 0.21], [0.175, 0.26], [0.09, 0.3]], bronze, 22, 1.03, 0.86)); // breastplate
  R.torso.add(lathe([[0.15, 0.0], [0.16, 0.02], [0.155, 0.045]], ironDark, 22, 1.02, 0.86)); // war belt
  R.torso.add(M(new THREE.SphereGeometry(0.035, 12, 10), bronze, 0, 0.2, -0.155)); // chest boss
  R.hips.add(lathe([[0.1, -0.06], [0.13, -0.02], [0.125, 0.04]], ironDark, 18, 1, 0.85));

  // Lion-faced helm.
  const helm = M(new THREE.SphereGeometry(0.075, 16, 12), iron, 0, 0.0, 0);
  helm.scale.set(1, 1.05, 1.1);
  R.head.add(helm);
  const snout = M(new THREE.BoxGeometry(0.075, 0.055, 0.06), ironDark, 0, -0.015, -0.07);
  R.head.add(snout);
  R.head.add(M(new THREE.BoxGeometry(0.09, 0.012, 0.02), glow(0xb07aff, 1.4), 0, 0.012, -0.075)); // eye slit
  for (const s of [-1, 1]) {
    const fang = M(new THREE.ConeGeometry(0.008, 0.03, 5), bronze, s * 0.025, -0.05, -0.09);
    fang.rotation.x = Math.PI;
    R.head.add(fang);
    const ear = M(new THREE.ConeGeometry(0.018, 0.05, 5), iron, s * 0.055, 0.07, -0.01);
    ear.rotation.z = -s * 0.4;
    R.head.add(ear);
  }
  // The great red mane: spikes radiating around the head and over the shoulders.
  for (let i = 0; i < 64; i += 1) {
    const a = (i / 64) * Math.PI * 2;
    const up = Math.sin(a * 3) * 0.03 + (Math.random() - 0.3) * 0.04;
    const len = 0.2 + Math.random() * 0.14;
    const x = Math.sin(a);
    const z = Math.cos(a);
    if (z < -0.6) continue; // keep the face clear
    const pts = [
      [x * 0.06, 0.02 + up, z * 0.06],
      [x * (0.06 + len * 0.5), 0.05 + up - len * 0.15, z * (0.06 + len * 0.45) + 0.02],
      [x * (0.06 + len), -0.02 + up - len * 0.4, z * (0.06 + len * 0.85) + 0.05],
    ];
    R.head.add(taperTube(pts, 0.042, 0.004, i % 3 ? mane : maneDark, 6, 6));
  }
  for (let i = 0; i < 36; i += 1) {
    // The mane spills over the shoulders and down the back.
    const x = (Math.random() - 0.5) * 0.4;
    const z = 0.02 + Math.random() * 0.06;
    R.torso.add(taperTube([[x, 0.31, z], [x * 1.25, 0.24, z + 0.1], [x * 1.4, 0.08, z + 0.15], [x * 1.45, -0.05, z + 0.16]], 0.04, 0.004, i % 2 ? mane : maneDark, 6, 8));
  }

  dressLimbs(R, { armMat: iron, legMat: iron, jointMat: ironDark, armR: 0.058, legR: 0.075, pauldron: 0.1, pauldronMat: bronze });

  const cape = clothPanel(0.36, 0.55, capeMat, 6, 12, 0.08);
  cape.position.set(0, 0.27, 0.12);
  R.cape.add(cape);
  R.cloth.push(cape);
  for (const s of [-1, 1]) {
    const tasset = clothPanel(0.1, 0.16, capeMat, 2, 4, 0.1);
    tasset.position.set(s * 0.08, -0.03, -0.09);
    tasset.rotation.y = s * 0.3;
    R.hips.add(tasset);
    R.cloth.push(tasset);
  }

  // Twin curved gravity greatswords.
  const swordMat = metal(0x7a7266, 0.35);
  const edgeMat = glow(0xb07aff, 1.2);
  for (const [A, key] of [[R.arms[1], "weaponR"], [R.arms[0], "weaponL"]]) {
    const sw = new THREE.Group();
    sw.add(M(new THREE.CylinderGeometry(0.012, 0.012, 0.09, 8).rotateX(Math.PI / 2), mat(0x2a1a10, 0.8, 0), 0, -0.02, 0.03));
    sw.add(M(new THREE.BoxGeometry(0.11, 0.022, 0.02), bronze, 0, -0.02, -0.018));
    const b = bladeMesh(0.5, 0.075, 0.016, swordMat, 0.16, 0.18);
    b.position.set(0, -0.02, -0.025);
    sw.add(b);
    const e = bladeMesh(0.47, 0.018, 0.02, edgeMat, 0.16, 0.2);
    e.position.set(0.035, -0.02, -0.03);
    e.castShadow = false;
    sw.add(e);
    A.hand.add(sw);
    R.props[key] = sw;
  }

  // The (comically) small horse.
  const horse = new THREE.Group();
  const coat = mat(0x5a432c, 0.85, 0.02);
  const hoof = mat(0x1a1410, 0.6, 0.1);
  const barding = metal(0x4a4038, 0.5);
  horse.add(lathe([[0.02, -0.17], [0.07, -0.13], [0.085, 0], [0.075, 0.12], [0.03, 0.17]], coat, 14).rotateX(Math.PI / 2).translateY(0.0));
  horse.children[0].position.y = 0.3;
  const nk = M(new THREE.CylinderGeometry(0.035, 0.05, 0.16, 10), coat, 0, 0.38, -0.17);
  nk.rotation.x = -0.6;
  horse.add(nk);
  const hd = M(new THREE.BoxGeometry(0.045, 0.05, 0.12), coat, 0, 0.44, -0.24);
  hd.rotation.x = 0.35;
  horse.add(hd);
  horse.add(M(new THREE.BoxGeometry(0.17, 0.05, 0.22), barding, 0, 0.33, 0)); // saddle cloth
  for (let i = 0; i < 8; i += 1) horse.add(M(new THREE.ConeGeometry(0.01, 0.06, 4), mane, 0, 0.42 - i * 0.012, -0.12 - i * 0.012).rotateX(0.6));
  const tail = taperTube([[0, 0.32, 0.17], [0, 0.26, 0.22], [0, 0.17, 0.23]], 0.015, 0.004, mane, 5, 6);
  horse.add(tail);
  R.props.horseLegs = [];
  for (const [x, z] of [[-0.05, -0.12], [0.05, -0.12], [-0.05, 0.12], [0.05, 0.12]]) {
    const lg = new THREE.Group();
    lg.position.set(x, 0.26, z);
    lg.add(limbMesh(0.23, 0.02, 0.013, coat, 1.2));
    lg.add(M(new THREE.BoxGeometry(0.025, 0.02, 0.03), hoof, 0, -0.225, 0));
    horse.add(lg);
    R.props.horseLegs.push(lg);
  }
  R.root.add(horse);
  R.props.horse = horse;
  R.mounted = true;
  return R;
}

function buildOmen() {
  const R = skeleton({ shoulderW: 0.16, hipW: 0.07, torsoH: 0.29, neckH: 0.075 });
  R.head.scale.setScalar(1.35); // a big, gaunt old head
  const robe = cloth(0x2e2a24);
  const robeMid = mat(0x3c362c, 0.9, 0.0);
  const leather = mat(0x4a3a2a, 0.8, 0.05);
  const skin = mat(0x9c8c78, 0.8, 0);
  const hair = mat(0xe4e0d6, 0.75, 0.0);
  const horn = mat(0xcfc2a2, 0.55, 0.05);
  const goldGlow = glow(0xffc84a, 2.2, { transparent: true, opacity: 0.92 });

  // Gaunt torso under a heavy layered cloak.
  R.torso.add(lathe([[0.08, 0], [0.085, 0.08], [0.11, 0.18], [0.12, 0.25], [0.07, 0.3]], robeMid, 18, 1, 0.8));
  R.torso.add(lathe([[0.1, 0.12], [0.135, 0.2], [0.14, 0.255], [0.07, 0.285]], leather, 18, 1.05, 0.9)); // mantle
  R.hips.add(lathe([[0.15, -0.38], [0.13, -0.25], [0.1, -0.1], [0.085, 0.04]], robe, 18, 1, 0.85)); // long coat skirt

  // Head: haggard face, long white hair + beard, curling horns.
  const face = M(new THREE.SphereGeometry(0.047, 14, 12), skin, 0, 0, -0.005);
  face.scale.set(0.95, 1.1, 1);
  R.head.add(face);
  R.head.add(M(new THREE.SphereGeometry(0.01, 6, 6), glow(0xffd36a, 2.5), -0.017, 0.008, -0.045));
  R.head.add(M(new THREE.SphereGeometry(0.01, 6, 6), glow(0xffd36a, 2.5), 0.017, 0.008, -0.045));
  const scalp = M(new THREE.SphereGeometry(0.05, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), hair, 0, 0.004, 0.004);
  R.head.add(scalp);
  strands(R.head, 30, { center: [0, 0.035, 0.012], radius: 0.044, len: 0.36, mat: hair, back: 0.8, spread: 0.7, r: 0.01 });
  for (const s of [-1, 1]) {
    for (let i = 0; i < 6; i += 1) {
      const x = s * (0.04 + i * 0.005);
      R.head.add(taperTube([[x, 0.03, -0.01], [x * 1.3, -0.05, -0.035], [x * 1.45, -0.17, -0.05], [x * 1.5, -0.3, -0.04]], 0.01, 0.002, hair, 5, 10));
    }
  }
  for (let i = 0; i < 10; i += 1) {
    const x = (i / 9 - 0.5) * 0.05;
    R.head.add(taperTube([[x, -0.03, -0.04], [x * 1.1, -0.09, -0.06], [x * 0.8, -0.18, -0.065]], 0.008, 0.0015, hair, 5, 8)); // long beard
  }
  for (const s of [-1, 1]) {
    R.head.add(taperTube([[s * 0.03, 0.05, -0.01], [s * 0.075, 0.12, -0.01], [s * 0.07, 0.19, 0.03], [s * 0.04, 0.22, 0.08]], 0.016, 0.002, horn, 7, 16));
    R.head.add(taperTube([[s * 0.04, 0.045, 0.0], [s * 0.1, 0.075, 0.01], [s * 0.13, 0.12, 0.02]], 0.01, 0.0015, horn, 6, 12));
  }

  dressLimbs(R, { armMat: robeMid, legMat: robeMid, jointMat: leather, armR: 0.04, legR: 0.055, pauldron: 0.06, pauldronMat: leather });

  // Tattered cloak and front tails.
  const capeL = clothPanel(0.28, 0.66, robe, 6, 14, 0.18);
  capeL.position.set(0, 0.29, 0.08);
  R.cape.add(capeL);
  R.cloth.push(capeL);
  for (const s of [-1, 1]) {
    const tail = clothPanel(0.08, 0.36, robe, 2, 8, 0.2);
    tail.position.set(s * 0.06, 0.0, -0.075);
    tail.rotation.y = s * 0.15;
    R.hips.add(tail);
    R.cloth.push(tail);
  }

  // Gnarled cane.
  const cane = new THREE.Group();
  const pts = [];
  for (let i = 0; i <= 8; i += 1) pts.push([Math.sin(i * 1.7) * 0.012, Math.cos(i * 2.3) * 0.01, -i * 0.068]);
  cane.add(taperTube(pts, 0.014, 0.009, mat(0x3a2818, 0.85, 0), 6, 30));
  cane.add(M(new THREE.SphereGeometry(0.022, 8, 6), mat(0x3a2818, 0.85, 0), 0, 0, 0.01));
  R.arms[1].hand.add(cane);
  R.props.cane = cane;

  // Conjured golden weapons (shown during those moves).
  const hammer = new THREE.Group();
  hammer.add(M(new THREE.CylinderGeometry(0.012, 0.012, 0.42, 8).rotateX(Math.PI / 2), goldGlow, 0, 0, -0.2));
  const head = M(new THREE.BoxGeometry(0.15, 0.11, 0.11), goldGlow, 0, 0, -0.42);
  hammer.add(head);
  hammer.visible = false;
  R.arms[0].hand.add(hammer);
  R.props.hammer = hammer;
  const gblade = bladeMesh(0.68, 0.06, 0.012, goldGlow, 0.04, 0.2);
  gblade.visible = false;
  R.arms[0].hand.add(gblade);
  R.props.gblade = gblade;
  R.hunch = 0.4;
  return R;
}

function buildBeast() {
  const R = skeleton({ shoulderW: 0.16, hipW: 0.07, torsoH: 0.3, upperArm: 0.19, foreArm: 0.18 });
  const fur = mat(0x1a1a1e, 0.95, 0.0);
  const furGrey = mat(0x2e2e34, 0.95, 0.0);
  const wrap = cloth(0x8a8274);
  const bone = mat(0xd8d0bc, 0.55, 0.05);
  const eye = glow(0xff3020, 3);
  const black = metal(0x0b0b0e, 0.25);
  const rune = glow(0xff3a14, 2.8);

  R.torso.add(lathe([[0.08, 0], [0.09, 0.08], [0.12, 0.18], [0.13, 0.25], [0.07, 0.3]], fur, 18, 1, 0.85));
  R.hips.add(lathe([[0.07, -0.05], [0.09, -0.02], [0.088, 0.04]], fur, 14, 1, 0.85));
  // Shaggy fur mantle down the back and over the shoulders.
  for (let i = 0; i < 40; i += 1) {
    const x = (Math.random() - 0.5) * 0.3;
    const y = 0.22 + Math.random() * 0.1;
    R.torso.add(taperTube([[x, y, 0.05], [x * 1.15, y - 0.08, 0.13], [x * 1.25, y - 0.2, 0.16]], 0.022, 0.003, i % 3 ? fur : furGrey, 5, 5));
  }

  // Wolf head: long snout, pointed ears, glowing eyes, ruff.
  const skull = M(new THREE.SphereGeometry(0.055, 14, 12), fur, 0, 0.01, 0.0);
  skull.scale.set(0.95, 0.95, 1.1);
  R.head.add(skull);
  const snout = lathe([[0.0, 0.0], [0.03, 0.02], [0.034, 0.06], [0.022, 0.1], [0.008, 0.12]], fur, 12, 1, 0.8);
  snout.rotation.x = -Math.PI / 2;
  snout.position.set(0, -0.01, -0.035);
  R.head.add(snout);
  R.head.add(M(new THREE.SphereGeometry(0.01, 6, 6), mat(0x050505, 0.4, 0), 0, -0.004, -0.155)); // nose
  // Bleached skull mask over the brow and muzzle.
  const mask = lathe([[0.0, 0.0], [0.034, 0.02], [0.04, 0.06], [0.03, 0.1], [0.012, 0.125]], bone, 12, 1, 0.55);
  mask.rotation.x = -Math.PI / 2;
  mask.position.set(0, 0.006, -0.03);
  R.head.add(mask);
  const brow = M(new THREE.SphereGeometry(0.05, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.42), bone, 0, 0.018, -0.008);
  brow.scale.set(1, 0.7, 1.15);
  R.head.add(brow);
  for (const s of [-1, 1]) {
    const ear = M(new THREE.ConeGeometry(0.024, 0.1, 5), fur, s * 0.038, 0.08, 0.015);
    ear.rotation.z = -s * 0.25;
    ear.rotation.x = 0.25;
    R.head.add(ear);
    R.head.add(M(new THREE.SphereGeometry(0.011, 6, 6), eye, s * 0.024, 0.022, -0.06));
    for (let t = 0; t < 3; t += 1) {
      const fang = M(new THREE.ConeGeometry(0.004, 0.02, 4), bone, s * (0.016 - t * 0.003), -0.03, -0.075 - t * 0.02);
      fang.rotation.x = Math.PI;
      R.head.add(fang);
    }
  }
  strands(R.head, 22, { center: [0, -0.02, 0.0], radius: 0.05, len: 0.13, mat: furGrey, back: 0.4, spread: 1, r: 0.012 }); // ruff

  dressLimbs(R, { armMat: fur, legMat: fur, jointMat: furGrey, handMat: fur, armR: 0.042, legR: 0.06, pauldron: 0, bootMat: fur });
  // Bandages wound round the forearms and shins.
  const band = mat(0x9c9484, 0.95, 0);
  for (const A of R.arms) for (let i = 0; i < 4; i += 1) A.el.add(M(new THREE.TorusGeometry(0.04, 0.008, 5, 12), band, 0, -0.03 - i * 0.028, 0).rotateX(Math.PI / 2 + (i % 2 ? 0.2 : -0.2)));
  for (const L of R.legs) for (let i = 0; i < 4; i += 1) L.knee.add(M(new THREE.TorusGeometry(0.055, 0.009, 5, 12), band, 0, -0.05 - i * 0.035, 0).rotateX(Math.PI / 2 + (i % 2 ? 0.2 : -0.2)));
  // Bone claws on every hand.
  for (const A of R.arms) {
    for (let c = -1; c <= 1; c += 1) {
      const claw = M(new THREE.ConeGeometry(0.008, 0.07, 4), bone, c * 0.016, -0.08, -0.01);
      claw.rotation.x = Math.PI + 0.3;
      A.hand.add(claw);
    }
  }
  // Tattered wraps.
  const capeM = clothPanel(0.26, 0.5, wrap, 6, 12, 0.25);
  capeM.position.set(0, 0.28, 0.1);
  R.cape.add(capeM);
  R.cloth.push(capeM);
  for (let i = 0; i < 5; i += 1) {
    const a = -1 + (i / 4) * 2;
    const strip = clothPanel(0.045, 0.28, wrap, 1, 6, 0.3);
    strip.position.set(Math.sin(a) * 0.08, -0.02, -Math.cos(a) * 0.06);
    strip.rotation.y = a;
    R.hips.add(strip);
    R.cloth.push(strip);
  }

  // Phase 2: the black blade, red runes burning along it.
  const sword = new THREE.Group();
  sword.add(M(new THREE.CylinderGeometry(0.012, 0.012, 0.1, 8).rotateX(Math.PI / 2), mat(0x1a1010, 0.7, 0.2), 0, -0.02, 0.035));
  sword.add(M(new THREE.BoxGeometry(0.1, 0.02, 0.022), black, 0, -0.02, -0.015));
  const b = bladeMesh(0.74, 0.075, 0.016, black, 0.0, 0.14);
  b.position.set(0, -0.02, -0.025);
  sword.add(b);
  for (let i = 0; i < 9; i += 1) sword.add(M(new THREE.BoxGeometry(0.03, 0.022, 0.025), rune, 0, -0.02, -0.06 - i * 0.07));
  const edgeGlow = bladeMesh(0.72, 0.012, 0.02, rune, 0, 0.16);
  edgeGlow.position.set(0.034, -0.02, -0.03);
  sword.add(edgeGlow);
  sword.visible = false;
  R.arms[1].hand.add(sword);
  R.props.sword = sword;
  R.beast = true;
  return R;
}

function buildBlood() {
  const R = skeleton({ shoulderW: 0.2, hipW: 0.085, torsoH: 0.31, upperArm: 0.18, foreArm: 0.17 });
  const robe = cloth(0x5c0c12);
  const robeDeep = mat(0x3a0a0e, 0.85, 0.05);
  const gold = metal(0xb08a3a, 0.35);
  const skin = mat(0x8a6650, 0.7, 0.0);
  const horn = mat(0x2a1a12, 0.5, 0.1);
  const blood = glow(0xff1a20, 2.4);

  // Broad chest, grand robe flaring to the ground.
  R.torso.add(lathe([[0.11, 0], [0.12, 0.08], [0.16, 0.18], [0.175, 0.26], [0.09, 0.32]], robeDeep, 20, 1, 0.8));
  R.torso.add(lathe([[0.155, 0.2], [0.19, 0.25], [0.18, 0.29], [0.09, 0.32]], gold, 20, 1.05, 0.85)); // gold collar mantle
  const skirt = lathe([[0.27, -0.5], [0.23, -0.35], [0.17, -0.18], [0.12, -0.04], [0.11, 0.04]], robe, 22, 1, 0.9);
  R.hips.add(skirt);
  for (const y of [-0.48, -0.3]) R.hips.add(lathe([[0.27 + (y + 0.48) * -0.25, y], [0.27 + (y + 0.48) * -0.25, y + 0.018]], gold, 22, 1.01, 0.91));
  R.torso.add(M(new THREE.BoxGeometry(0.03, 0.26, 0.02), gold, 0, 0.13, -0.135)); // front trim

  // Bald head, glowing eyes, crown of curved horns.
  const headM = M(new THREE.SphereGeometry(0.058, 16, 12), skin, 0, 0, -0.005);
  headM.scale.set(0.95, 1.1, 1);
  R.head.add(headM);
  R.head.add(M(new THREE.SphereGeometry(0.009, 6, 6), blood, -0.02, 0.01, -0.052));
  R.head.add(M(new THREE.SphereGeometry(0.009, 6, 6), blood, 0.02, 0.01, -0.052));
  for (let i = 0; i < 9; i += 1) {
    const a = -1.4 + (i / 8) * 2.8;
    const x = Math.sin(a) * 0.05;
    const z = -Math.cos(a) * 0.035;
    const big = Math.abs(a) > 0.9 ? 1.6 : 1.1;
    // Each horn sweeps outward, up, then curls back.
    R.head.add(taperTube([[x, 0.035, z], [x * 2.0, 0.085 * big, z * 1.1], [x * 2.9, 0.15 * big, z + 0.03], [x * 2.7, 0.2 * big, z + 0.09], [x * 2.2, 0.21 * big, z + 0.13]], 0.016 * big, 0.002, horn, 7, 16));
  }

  dressLimbs(R, { armMat: robeDeep, legMat: robeDeep, jointMat: gold, handMat: skin, armR: 0.052, legR: 0.07, pauldron: 0.085, pauldronMat: gold });
  // Long hanging sleeves.
  for (const A of R.arms) {
    const sleeve = clothPanel(0.1, 0.3, robe, 2, 6, 0.08);
    sleeve.position.set(0, -0.05, 0.03);
    A.sh.add(sleeve);
    R.cloth.push(sleeve);
  }
  const capeM = clothPanel(0.36, 0.78, robe, 6, 14, 0.06);
  capeM.position.set(0, 0.3, 0.1);
  R.cape.add(capeM);
  R.cloth.push(capeM);

  // Ornate trident.
  const tri = new THREE.Group();
  tri.add(M(new THREE.CylinderGeometry(0.011, 0.011, 0.95, 8).rotateX(Math.PI / 2), mat(0x3a0c0c, 0.5, 0.4), 0, 0, -0.27));
  tri.add(M(new THREE.SphereGeometry(0.026, 10, 8), gold, 0, 0, -0.72));
  tri.add(M(new THREE.BoxGeometry(0.13, 0.02, 0.02), gold, 0, 0, -0.75));
  for (const x of [-0.06, 0, 0.06]) {
    const prong = M(new THREE.ConeGeometry(0.014, x ? 0.13 : 0.17, 6), blood, x, 0, -0.83 - (x ? 0 : 0.02));
    prong.rotation.x = -Math.PI / 2;
    tri.add(prong);
  }
  tri.position.z = 0.2;
  R.arms[1].hand.add(tri);
  R.props.trident = tri;

  // Phase 2: great bat-like blood wings.
  const wings = new THREE.Group();
  const membrane = new THREE.MeshStandardMaterial({ color: 0x4a0a10, emissive: 0x6a0010, emissiveIntensity: 0.5, roughness: 0.8, side: THREE.DoubleSide });
  for (const s of [-1, 1]) {
    const w = new THREE.Group();
    const tips = [[0.55, 0.32], [0.62, 0.05], [0.5, -0.2], [0.3, -0.32]];
    for (const [x, y] of tips) w.add(taperTube([[0, 0, 0], [x * 0.5, y * 0.5 + 0.08, 0.02], [x, y, 0.04]], 0.012, 0.003, horn, 5, 8));
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(0.55, 0.32);
    shape.quadraticCurveTo(0.5, 0.15, 0.62, 0.05);
    shape.quadraticCurveTo(0.48, -0.05, 0.5, -0.2);
    shape.quadraticCurveTo(0.36, -0.2, 0.3, -0.32);
    shape.lineTo(0, -0.05);
    w.add(M(new THREE.ShapeGeometry(shape, 12), membrane, 0, 0, 0.02));
    w.scale.x = s;
    w.position.set(s * 0.06, 0.22, 0.1);
    w.rotation.y = -s * 0.35;
    wings.add(w);
  }
  wings.visible = false;
  R.torso.add(wings);
  R.props.wings = wings;
  return R;
}

const BUILDERS = { scarlet: buildScarlet, titan: buildTitan, omen: buildOmen, beast: buildBeast, blood: buildBlood };

/** Build a champion (height 1, faces -Z). */
export function buildChampion(kind) {
  const R = (BUILDERS[kind] || buildScarlet)();
  undeadify(R, kind); // rot, bones, wounds, glowing veins
  R.kind = kind;
  R.root.userData.rig = R;
  return R.root;
}

/** Wave the fabric (capes, skirts, sleeves). Called every frame. */
export function animateCloth(R, t, stride = 0) {
  for (const m of R.cloth || []) {
    const pos = m.geometry.attributes.position;
    const base = m.userData.base;
    const len = m.userData.len;
    for (let i = 0; i < pos.count; i += 1) {
      const bx = base[i * 3];
      const by = base[i * 3 + 1];
      const k = Math.min(1, -by / len); // 0 at the top, 1 at the hem
      const w = Math.sin(t * 2.2 + bx * 18 + by * 7) * 0.012 + Math.sin(t * 3.7 + bx * 31) * 0.006;
      pos.setZ(i, base[i * 3 + 2] + (w + stride * 0.05) * k * k * 2.2);
    }
    pos.needsUpdate = true;
  }
}
