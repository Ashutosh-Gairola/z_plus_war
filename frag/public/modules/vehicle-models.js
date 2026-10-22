/**
 * Drivable ground-vehicle models: sedan (the classic "car"), sports car, SUV,
 * pickup, heavy truck, motorbike and armored APC.
 *
 * Contract with Renderer.updateVehicles (shared with heli/plane):
 *   userData.type     vehicle type key
 *   userData.wheels   wheel groups (spin on X; z < 0 ones steer)
 *   userData.wheelR   wheel radius (for spin rate)
 *   userData.beamZ/Y  where the headlight spot sits (front of the body)
 *   userData.lean     body-roll factor into turns (bikes lean hard)
 *   "steeringWheel"   optional named object, rotated with steering
 *   "smokeAnchor"     where damage smoke comes out
 * Models face -Z (forward), ground at y = 0. Flat parts are merged per joint
 * into a few shared materials so a vehicle costs ~15 draw calls.
 */

import { mergeStaticMeshes } from "./mesh-merge.js";
import { roundedBox } from "./geo-kit.js";
import { patchSurface } from "./atmosphere.js";

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

const matCache = new Map();
function cached(key, make) {
  if (!matCache.has(key)) matCache.set(key, make());
  return matCache.get(key);
}

const GROUPS = {
  paint: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.55 }),
  matte: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.08 }),
  chrome: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.16, metalness: 0.9 }),
  rubber: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0 }),
  // Lamps are unlit and always bright: one material for head/tail/indicators.
  light: () => new THREE.MeshBasicMaterial({ vertexColors: true }),
};

function flat(group, color) {
  return cached(`${group}:${color}`, () => {
    const m = new THREE.MeshStandardMaterial({ color });
    // Body panels get rain-wet shine and settled snow like the world does.
    m.userData.mergeInto = cached(`group:${group}`, () => patchSurface(GROUPS[group](), { variation: 0.04, kind: group === "rubber" ? "wall" : "paint" }));
    return m;
  });
}

const GLASS = () =>
  cached("glass", () =>
    new THREE.MeshStandardMaterial({ color: 0x5f87a8, roughness: 0.05, metalness: 0.4, transparent: true, opacity: 0.55 }),
  );

function palette(color) {
  const c = new THREE.Color(color);
  return {
    paint: flat("paint", c.getHex()),
    paintDark: flat("paint", c.clone().offsetHSL(0, 0, -0.12).getHex()),
    trim: flat("matte", 0x17191c),
    plastic: flat("matte", 0x2a2d31),
    interior: flat("matte", 0x24272c),
    chrome: flat("chrome", 0xc4ccd4),
    rubber: flat("rubber", 0x151515),
    // Whole wheel (tire, rim, spokes, hub) shares one material: 1 draw call per wheel.
    rim: flat("rubber", 0x8f979f),
    plate: flat("matte", 0xe8e4d5),
    glass: GLASS(),
    head: flat("light", 0xfff4cf),
    tail: flat("light", 0xe23c3c),
    amber: flat("light", 0xffa020),
  };
}

// ---------------------------------------------------------------------------
// Part helpers
// ---------------------------------------------------------------------------

function rbox(parent, w, h, d, r, mat, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(roundedBox(w, h, d, r), mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  parent.add(m);
  return m;
}

function bx(parent, w, h, d, mat, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  parent.add(m);
  return m;
}

function cyl(parent, r1, r2, len, mat, x, y, z, axis = "x", segs = 14) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, segs), mat);
  if (axis === "x") m.rotation.z = Math.PI / 2;
  if (axis === "z") m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/** Wheel: tire with sidewall bulge + multi-spoke rim + hub. */
function wheel(group, p, x, y, z, r, width, { spokes = 5, offroad = false } = {}) {
  const w = new THREE.Group();
  w.position.set(x, y, z);
  w.userData.joint = true;
  const tire = new THREE.CylinderGeometry(r, r, width, 14);
  tire.rotateZ(Math.PI / 2);
  w.add(new THREE.Mesh(tire, p.rubber));
  const wall = new THREE.TorusGeometry(r * 0.86, width * 0.32, 5, 14);
  wall.rotateY(Math.PI / 2);
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(wall, p.rubber);
    m.position.x = (s * width) / 2.6;
    w.add(m);
  }
  if (offroad) {
    // Chunky tread blocks.
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      const lug = bx(w, width * 1.02, r * 0.16, r * 0.22, p.rubber, 0, Math.cos(a) * r, Math.sin(a) * r);
      lug.rotation.x = -a;
    }
  }
  const side = Math.sign(x) || 1;
  const rimR = r * 0.6;
  cyl(w, rimR, rimR, width * 1.02, p.rim, 0, 0, 0, "x", 10);
  for (let i = 0; i < spokes; i += 1) {
    const a = (i / spokes) * Math.PI * 2;
    const spoke = bx(w, 0.03, rimR * 0.95, rimR * 0.2, p.rim, side * width * 0.52, Math.cos(a) * rimR * 0.45, Math.sin(a) * rimR * 0.45);
    spoke.rotation.x = -a;
  }
  cyl(w, rimR * 0.3, rimR * 0.3, width * 1.12, p.rubber, 0, 0, 0, "x", 10);
  group.add(w);
  group.userData.wheels.push(w);
  return w;
}

function lights(group, p, { w, y, front, rear, headW = 0.42, headH = 0.14, tailW = 0.5 }) {
  for (const s of [-1, 1]) {
    rbox(group, headW, headH, 0.08, 0.03, p.head, s * (w / 2 - headW / 2 - 0.12), y, front);
    rbox(group, tailW, 0.13, 0.06, 0.02, p.tail, s * (w / 2 - tailW / 2 - 0.1), y + 0.04, rear);
    rbox(group, 0.14, 0.07, 0.06, 0.02, p.amber, s * (w / 2 - 0.12), y - 0.14, front + 0.02);
  }
}

function mirrors(group, p, w, y, z) {
  for (const s of [-1, 1]) {
    bx(group, 0.18, 0.03, 0.05, p.paintDark, s * (w / 2 + 0.05), y, z);
    rbox(group, 0.07, 0.14, 0.22, 0.03, p.paintDark, s * (w / 2 + 0.14), y, z);
  }
}

function seats(group, p, xs, y, z) {
  for (const x of xs) {
    rbox(group, 0.56, 0.14, 0.55, 0.05, p.interior, x, y, z);
    rbox(group, 0.56, 0.6, 0.13, 0.05, p.interior, x, y + 0.34, z + 0.3, -0.12);
  }
}

function steering(group, p, x, y, z, tilt = 1.0, r = 0.18) {
  const s = new THREE.Mesh(new THREE.TorusGeometry(r, 0.03, 8, 18), p.trim);
  s.position.set(x, y, z);
  s.rotation.x = tilt;
  s.name = "steeringWheel";
  s.userData.joint = true;
  group.add(s);
}

/** Glass cabin: windshield + rear glass + side windows + pillars + roof. */
function greenhouse(group, p, { w, y0, h, zFront, zRear, rake = 0.45, rearRake = 0.4, roofMat = p.paint }) {
  const len = zRear - zFront;
  const roofZ0 = zFront + Math.tan(rake) * h;
  const roofZ1 = zRear - Math.tan(rearRake) * h;
  rbox(group, w - 0.08, 0.1, roofZ1 - roofZ0 + 0.12, 0.04, roofMat, 0, y0 + h, (roofZ0 + roofZ1) / 2);
  const ws = bx(group, w - 0.16, h / Math.cos(rake), 0.05, p.glass, 0, y0 + h / 2, (zFront + roofZ0) / 2);
  ws.rotation.x = rake;
  const rg = bx(group, w - 0.18, h / Math.cos(rearRake), 0.05, p.glass, 0, y0 + h / 2, (zRear + roofZ1) / 2);
  rg.rotation.x = -rearRake;
  for (const s of [-1, 1]) {
    bx(group, 0.04, h * 0.78, len * 0.62, p.glass, s * (w / 2 - 0.04), y0 + h * 0.48, (zFront + zRear) / 2);
    const a = bx(group, 0.08, h / Math.cos(rake), 0.09, p.paintDark, s * (w / 2 - 0.05), y0 + h / 2, (zFront + roofZ0) / 2);
    a.rotation.x = rake;
    const c = bx(group, 0.09, h / Math.cos(rearRake), 0.14, p.paintDark, s * (w / 2 - 0.05), y0 + h / 2, (zRear + roofZ1) / 2);
    c.rotation.x = -rearRake;
    bx(group, 0.07, h * 0.9, 0.08, p.trim, s * (w / 2 - 0.05), y0 + h * 0.45, (zFront + zRear) / 2);
  }
}

function anchor(group, name, x, y, z) {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  group.add(o);
}

function finish(group, type, opts) {
  group.userData.type = type;
  group.userData.wheelR = opts.wheelR;
  group.userData.beamZ = opts.beamZ;
  group.userData.beamY = opts.beamY ?? 1.0;
  group.userData.lean = opts.lean ?? 0.05;
  const wheels = group.userData.wheels;
  mergeStaticMeshes(group, { isJoint: (o) => Boolean(o.userData.joint), castShadow: true });
  group.userData.wheels = wheels;
  return group;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function buildSedan(color) {
  const g = new THREE.Group();
  g.userData.wheels = [];
  const p = palette(color);
  const W = 2.2;
  rbox(g, W - 0.15, 0.3, 4.3, 0.1, p.trim, 0, 0.42, 0); // underbody
  rbox(g, W, 0.58, 4.6, 0.2, p.paint, 0, 0.8, 0); // body
  rbox(g, W - 0.12, 0.16, 1.5, 0.07, p.paint, 0, 1.08, -1.5, 0.06); // hood
  rbox(g, W - 0.12, 0.15, 1.0, 0.06, p.paint, 0, 1.1, 1.76, -0.05); // trunk
  bx(g, W - 0.3, 0.05, 0.25, p.paintDark, 0, 1.2, 2.2); // lip spoiler
  for (const [fx, fz] of [[-1, -1.45], [1, -1.45], [-1, 1.42], [1, 1.42]]) rbox(g, 0.16, 0.32, 1.16, 0.06, p.paintDark, fx * (W / 2 + 0.01), 0.8, fz);
  greenhouse(g, p, { w: W - 0.42, y0: 1.12, h: 0.62, zFront: -0.92, zRear: 1.28 });
  for (const s of [-1, 1]) {
    bx(g, 0.015, 0.42, 0.02, p.trim, s * (W / 2 + 0.005), 0.82, 0.15); // door seam
    rbox(g, 0.03, 0.05, 0.24, 0.015, p.chrome, s * (W / 2 + 0.02), 0.97, -0.15); // handle
  }
  mirrors(g, p, W - 0.2, 1.24, -0.62);
  seats(g, p, [-0.47, 0.47], 1.12, 0.35);
  rbox(g, W - 0.5, 0.2, 0.38, 0.06, p.interior, 0, 1.25, -0.6); // dash
  steering(g, p, -0.47, 1.33, -0.4);
  rbox(g, 1.15, 0.26, 0.08, 0.03, p.trim, 0, 0.75, -2.31); // grille
  bx(g, 1.2, 0.04, 0.1, p.chrome, 0, 0.76, -2.33);
  rbox(g, W + 0.06, 0.28, 0.32, 0.1, p.paintDark, 0, 0.47, -2.3); // bumpers
  rbox(g, W + 0.06, 0.28, 0.28, 0.1, p.paintDark, 0, 0.47, 2.28);
  bx(g, 0.5, 0.14, 0.03, p.plate, 0, 0.58, -2.47);
  bx(g, 0.5, 0.14, 0.03, p.plate, 0, 0.66, 2.44);
  lights(g, p, { w: W, y: 0.88, front: -2.3, rear: 2.3 });
  cyl(g, 0.05, 0.055, 0.22, p.chrome, -0.7, 0.34, 2.42, "z", 10);
  for (const [x, z] of [[-1.1, -1.45], [1.1, -1.45], [-1.1, 1.42], [1.1, 1.42]]) wheel(g, p, x, 0.42, z, 0.42, 0.3);
  anchor(g, "smokeAnchor", 0, 1.2, -1.6);
  return finish(g, "car", { wheelR: 0.42, beamZ: -2.3 });
}

function buildSports(color) {
  const g = new THREE.Group();
  g.userData.wheels = [];
  const p = palette(color);
  const W = 2.15;
  rbox(g, W - 0.1, 0.22, 4.4, 0.08, p.trim, 0, 0.32, 0);
  rbox(g, W, 0.46, 4.5, 0.22, p.paint, 0, 0.62, 0); // low wedge body
  rbox(g, W - 0.16, 0.12, 1.7, 0.06, p.paint, 0, 0.84, -1.35, 0.1); // sloped hood
  rbox(g, W - 0.12, 0.2, 1.2, 0.08, p.paint, 0, 0.88, 1.55, -0.05); // engine deck
  for (const s of [-1, 1]) {
    rbox(g, 0.25, 0.36, 1.3, 0.12, p.paint, s * (W / 2 - 0.02), 0.74, 1.35); // rear haunches
    rbox(g, 0.06, 0.18, 0.8, 0.04, p.trim, s * (W / 2 + 0.02), 0.62, 0.4); // side intake
    bx(g, 0.05, 0.3, 0.05, p.trim, s * 0.62, 1.2, 2.05); // wing stands
  }
  greenhouse(g, p, { w: W - 0.5, y0: 0.9, h: 0.46, zFront: -0.55, zRear: 1.05, rake: 0.75, rearRake: 0.75 });
  bx(g, W - 0.2, 0.05, 0.38, p.trim, 0, 1.36, 2.1); // rear wing
  mirrors(g, p, W - 0.3, 1.0, -0.4);
  seats(g, p, [-0.42, 0.42], 0.82, 0.3);
  steering(g, p, -0.42, 1.05, -0.2, 1.2, 0.16);
  rbox(g, W + 0.02, 0.2, 0.3, 0.09, p.paintDark, 0, 0.36, -2.25); // splitter
  bx(g, 1.4, 0.12, 0.06, p.trim, 0, 0.48, -2.38); // intake
  rbox(g, W, 0.24, 0.24, 0.09, p.paintDark, 0, 0.42, 2.25);
  bx(g, 1.2, 0.14, 0.05, p.trim, 0, 0.36, 2.37); // diffuser
  for (const s of [-1, 1]) cyl(g, 0.06, 0.06, 0.18, p.chrome, s * 0.25, 0.34, 2.4, "z", 10);
  lights(g, p, { w: W, y: 0.72, front: -2.24, rear: 2.28, headW: 0.48, headH: 0.08, tailW: 0.62 });
  for (const [x, z] of [[-1.05, -1.4], [1.05, -1.4], [-1.08, 1.4], [1.08, 1.4]]) wheel(g, p, x, 0.38, z, 0.38, z > 0 ? 0.36 : 0.3, { spokes: 10 });
  anchor(g, "smokeAnchor", 0, 1.0, 1.5);
  return finish(g, "sports", { wheelR: 0.38, beamZ: -2.25, beamY: 0.75 });
}

function buildSUV(color) {
  const g = new THREE.Group();
  g.userData.wheels = [];
  const p = palette(color);
  const W = 2.3;
  rbox(g, W - 0.2, 0.36, 4.3, 0.1, p.trim, 0, 0.62, 0);
  rbox(g, W, 0.8, 4.5, 0.18, p.paint, 0, 1.12, 0); // tall body
  rbox(g, W - 0.12, 0.14, 1.25, 0.06, p.paint, 0, 1.56, -1.55, 0.04);
  greenhouse(g, p, { w: W - 0.18, y0: 1.55, h: 0.78, zFront: -0.95, zRear: 2.1, rake: 0.38, rearRake: 0.05 });
  for (const s of [-1, 1]) {
    bx(g, 0.06, 0.06, 2.6, p.chrome, s * 0.82, 2.42, 0.6); // roof rails
    rbox(g, 0.2, 0.42, 1.25, 0.08, p.trim, s * (W / 2 + 0.03), 1.0, -1.45); // flares
    rbox(g, 0.2, 0.42, 1.25, 0.08, p.trim, s * (W / 2 + 0.03), 1.0, 1.45);
    rbox(g, 0.18, 0.08, 2.0, 0.03, p.chrome, s * (W / 2 + 0.06), 0.55, 0); // side step
    rbox(g, 0.03, 0.05, 0.24, 0.015, p.chrome, s * (W / 2 + 0.02), 1.32, -0.25);
  }
  mirrors(g, p, W - 0.1, 1.72, -0.85);
  seats(g, p, [-0.5, 0.5], 1.5, 0.2);
  rbox(g, W - 0.4, 0.22, 0.4, 0.06, p.interior, 0, 1.68, -0.75);
  steering(g, p, -0.5, 1.78, -0.55);
  rbox(g, 1.6, 0.42, 0.1, 0.04, p.trim, 0, 1.12, -2.27); // big grille
  for (let i = 0; i < 4; i += 1) bx(g, 1.5, 0.03, 0.04, p.chrome, 0, 0.98 + i * 0.1, -2.33);
  rbox(g, W + 0.1, 0.34, 0.36, 0.1, p.trim, 0, 0.66, -2.3); // bash bar bumper
  bx(g, 1.4, 0.06, 0.1, p.chrome, 0, 0.56, -2.48);
  rbox(g, W + 0.06, 0.32, 0.3, 0.1, p.trim, 0, 0.66, 2.28);
  cyl(g, 0.42, 0.42, 0.26, p.rubber, 0, 1.3, 2.38, "z", 18); // spare wheel
  cyl(g, 0.22, 0.22, 0.28, p.rim, 0, 1.3, 2.38, "z", 12);
  lights(g, p, { w: W, y: 1.28, front: -2.27, rear: 2.27 });
  for (const [x, z] of [[-1.12, -1.45], [1.12, -1.45], [-1.12, 1.45], [1.12, 1.45]]) wheel(g, p, x, 0.5, z, 0.5, 0.36, { spokes: 6, offroad: true });
  anchor(g, "smokeAnchor", 0, 1.7, -1.6);
  return finish(g, "suv", { wheelR: 0.5, beamZ: -2.3, beamY: 1.3 });
}

function buildPickup(color) {
  const g = new THREE.Group();
  g.userData.wheels = [];
  const p = palette(color);
  const W = 2.3;
  rbox(g, W - 0.2, 0.34, 5.3, 0.1, p.trim, 0, 0.6, 0.1); // frame
  rbox(g, W, 0.72, 2.6, 0.16, p.paint, 0, 1.08, -1.2); // cab + nose body
  rbox(g, W - 0.1, 0.16, 1.4, 0.06, p.paint, 0, 1.48, -1.75, 0.04);
  greenhouse(g, p, { w: W - 0.2, y0: 1.44, h: 0.72, zFront: -1.0, zRear: 0.15, rake: 0.42, rearRake: 0.02 });
  // Open bed with walls + tailgate + cargo.
  bx(g, W, 0.12, 2.5, p.trim, 0, 0.82, 1.5);
  for (const s of [-1, 1]) rbox(g, 0.12, 0.62, 2.5, 0.04, p.paint, s * (W / 2 - 0.06), 1.12, 1.5);
  rbox(g, W, 0.62, 0.12, 0.04, p.paint, 0, 1.12, 2.72);
  rbox(g, W, 0.62, 0.12, 0.04, p.paint, 0, 1.12, 0.28);
  bx(g, 1.0, 0.5, 0.7, flat("matte", 0x6b5a3a), -0.3, 1.13, 1.4); // crate
  cyl(g, 0.3, 0.3, 0.9, flat("matte", 0x3f5a3a), 0.5, 1.2, 2.0, "y", 12); // drum
  bx(g, W - 0.1, 0.08, 0.08, p.chrome, 0, 2.2, 0.35); // roll bar
  for (const s of [-1, 1]) {
    bx(g, 0.08, 0.92, 0.08, p.chrome, s * (W / 2 - 0.1), 1.74, 0.35);
    rbox(g, 0.18, 0.4, 1.25, 0.08, p.paintDark, s * (W / 2 + 0.02), 0.98, -1.75);
    rbox(g, 0.18, 0.4, 1.25, 0.08, p.paintDark, s * (W / 2 + 0.02), 0.98, 1.8);
  }
  mirrors(g, p, W, 1.65, -0.9);
  seats(g, p, [-0.5, 0.5], 1.4, -0.35);
  steering(g, p, -0.5, 1.68, -0.85);
  rbox(g, 1.7, 0.45, 0.1, 0.04, p.chrome, 0, 1.08, -2.47);
  for (let i = 0; i < 3; i += 1) bx(g, 1.6, 0.06, 0.06, p.trim, 0, 0.94 + i * 0.13, -2.52);
  rbox(g, W + 0.1, 0.3, 0.32, 0.1, p.chrome, 0, 0.62, -2.5);
  rbox(g, W + 0.06, 0.28, 0.24, 0.1, p.chrome, 0, 0.62, 2.82);
  lights(g, p, { w: W, y: 1.22, front: -2.48, rear: 2.79 });
  for (const [x, z] of [[-1.12, -1.75], [1.12, -1.75], [-1.12, 1.8], [1.12, 1.8]]) wheel(g, p, x, 0.48, z, 0.48, 0.36, { spokes: 6, offroad: true });
  anchor(g, "smokeAnchor", 0, 1.6, -1.8);
  return finish(g, "pickup", { wheelR: 0.48, beamZ: -2.5, beamY: 1.2 });
}

function buildTruck(color) {
  const g = new THREE.Group();
  g.userData.wheels = [];
  const p = palette(color);
  const W = 2.6;
  rbox(g, W - 0.5, 0.4, 7.6, 0.08, p.trim, 0, 0.85, 0.4); // ladder frame
  // Cab-over cab.
  rbox(g, W, 1.9, 2.0, 0.18, p.paint, 0, 1.95, -2.55);
  bx(g, W - 0.2, 0.9, 0.06, p.glass, 0, 2.45, -3.56, 0.08);
  for (const s of [-1, 1]) {
    bx(g, 0.05, 0.7, 1.1, p.glass, s * (W / 2 + 0.005), 2.45, -2.6);
    bx(g, 0.3, 0.06, 0.06, p.trim, s * (W / 2 + 0.15), 2.5, -3.4);
    rbox(g, 0.1, 0.45, 0.3, 0.03, p.trim, s * (W / 2 + 0.3), 2.5, -3.4); // big mirrors
    bx(g, 0.5, 0.08, 0.35, p.chrome, s * (W / 2 - 0.05), 0.9, -2.3); // steps
    cyl(g, 0.11, 0.11, 1.9, p.chrome, s * (W / 2 - 0.15), 2.95, -1.5, "y", 10); // exhaust stacks
    cyl(g, 0.38, 0.38, 1.3, p.chrome, s * (W / 2 - 0.3), 1.05, -0.4, "z", 16); // fuel tanks
  }
  rbox(g, 2.0, 0.7, 0.1, 0.05, p.chrome, 0, 1.4, -3.58); // grille
  for (let i = 0; i < 5; i += 1) bx(g, 1.9, 0.04, 0.06, p.trim, 0, 1.15 + i * 0.12, -3.62);
  rbox(g, W + 0.1, 0.4, 0.4, 0.1, p.trim, 0, 0.8, -3.55);
  bx(g, W - 0.4, 0.18, 0.22, p.amber, 0, 3.0, -3.0); // roof marker bar
  seats(g, p, [-0.6, 0.6], 2.1, -2.3);
  steering(g, p, -0.6, 2.35, -3.0, 0.6, 0.24);
  // Cargo box.
  rbox(g, W + 0.05, 2.7, 5.4, 0.08, flat("paint", 0xd8d8d8), 0, 2.45, 1.25);
  for (let i = 0; i < 8; i += 1) bx(g, W + 0.08, 2.6, 0.06, flat("matte", 0xb0b0b0), 0, 2.45, -1.3 + i * 0.73);
  rbox(g, W * 0.94, 0.5, 0.06, 0.03, p.paint, 0, 3.4, -1.47); // painted header
  for (const s of [-1, 1]) bx(g, 0.04, 2.4, 0.06, p.chrome, s * 0.4, 2.4, 3.98); // rear door hinges
  bx(g, W, 0.3, 0.3, p.trim, 0, 0.75, 4.0);
  lights(g, p, { w: W, y: 1.25, front: -3.6, rear: 4.0, headW: 0.38 });
  for (const [x, z] of [[-1.15, -2.55], [1.15, -2.55]]) wheel(g, p, x, 0.58, z, 0.58, 0.42, { spokes: 8 });
  for (const z of [2.2, 3.35]) for (const x of [-1.1, 1.1]) wheel(g, p, x, 0.58, z, 0.58, 0.62, { spokes: 8 });
  anchor(g, "smokeAnchor", 0, 3.0, -2.6);
  return finish(g, "truck", { wheelR: 0.58, beamZ: -3.6, beamY: 1.3, lean: 0.03 });
}

function buildBike(color) {
  const g = new THREE.Group();
  g.userData.wheels = [];
  const p = palette(color);
  // Sport bike: fairing, tank, seat, swingarm, forks.
  rbox(g, 0.42, 0.42, 0.9, 0.16, p.paint, 0, 0.98, -0.25); // tank
  rbox(g, 0.5, 0.55, 0.85, 0.18, p.paint, 0, 0.9, -0.85, -0.25); // front fairing
  bx(g, 0.36, 0.3, 0.05, p.glass, 0, 1.3, -1.12, -0.55); // windscreen
  rbox(g, 0.32, 0.12, 0.75, 0.05, p.interior, 0, 1.12, 0.45, 0.08); // seat
  rbox(g, 0.3, 0.3, 0.6, 0.1, p.paint, 0, 1.06, 0.95, 0.15); // tail
  rbox(g, 0.36, 0.42, 0.62, 0.1, p.plastic, 0, 0.62, -0.05); // engine
  for (let i = 0; i < 4; i += 1) bx(g, 0.38, 0.03, 0.5, p.chrome, 0, 0.5 + i * 0.08, -0.05);
  cyl(g, 0.07, 0.09, 0.8, p.chrome, 0.2, 0.55, 0.7, "z", 10); // exhaust
  for (const s of [-1, 1]) {
    bx(g, 0.05, 0.05, 0.9, p.chrome, s * 0.12, 0.5, 0.75, 0.15); // swingarm
    const fork = cyl(g, 0.035, 0.035, 0.9, p.chrome, s * 0.13, 0.82, -1.05, "y", 8);
    fork.rotation.x = -0.4;
    bx(g, 0.34, 0.04, 0.04, p.trim, s * 0.28, 1.2, -0.72); // clip-on bars
  }
  rbox(g, 0.22, 0.14, 0.08, 0.04, p.head, 0, 1.0, -1.28);
  rbox(g, 0.18, 0.08, 0.05, 0.03, p.tail, 0, 1.1, 1.26);
  bx(g, 0.2, 0.12, 0.02, p.plate, 0, 0.9, 1.3);
  wheel(g, p, 0, 0.36, -1.22, 0.36, 0.14, { spokes: 3 });
  wheel(g, p, 0, 0.36, 1.08, 0.37, 0.2, { spokes: 3 });
  anchor(g, "smokeAnchor", 0, 0.8, 0);
  return finish(g, "bike", { wheelR: 0.36, beamZ: -1.3, beamY: 1.0, lean: 0.38 });
}

function buildAPC(color) {
  const g = new THREE.Group();
  g.userData.wheels = [];
  const p = palette(color);
  const W = 2.8;
  // Angled armored hull.
  rbox(g, W, 1.2, 6.4, 0.12, p.paint, 0, 1.45, 0);
  const glacis = rbox(g, W, 0.12, 1.6, 0.04, p.paint, 0, 1.75, -3.25, 0.55);
  glacis.scale.set(1, 1, 1);
  rbox(g, W - 0.5, 0.5, 4.6, 0.1, p.paintDark, 0, 2.3, 0.6); // upper hull
  for (const s of [-1, 1]) {
    rbox(g, 0.12, 0.6, 6.0, 0.04, p.paintDark, s * (W / 2 + 0.04), 1.3, 0); // side skirts
    for (let i = 0; i < 6; i += 1) bx(g, 0.05, 0.08, 0.08, p.trim, s * (W / 2 + 0.11), 1.55, -2.5 + i, 0); // bolts
    bx(g, 0.1, 0.3, 0.3, p.trim, s * (W / 2 - 0.1), 2.6, -1.6); // smoke dischargers
    bx(g, 0.04, 0.2, 0.4, p.glass, s * 0.5, 2.35, -1.5, 0, 0, 0); // vision blocks
  }
  bx(g, 1.4, 0.18, 0.06, p.glass, 0, 2.3, -1.72, 0.4); // driver periscope
  // Turret + autocannon.
  const turret = new THREE.Group();
  turret.position.set(0, 2.55, 0.4);
  rbox(turret, 1.7, 0.6, 1.9, 0.2, p.paint, 0, 0.3, 0);
  cyl(turret, 0.08, 0.1, 2.2, p.trim, 0.2, 0.32, -1.9, "z", 10);
  cyl(turret, 0.13, 0.13, 0.35, p.trim, 0.2, 0.32, -3.0, "z", 10);
  bx(turret, 0.35, 0.3, 0.45, p.trim, -0.55, 0.75, 0.2); // commander optic
  cyl(turret, 0.02, 0.02, 1.4, p.trim, -0.6, 1.4, 0.6, "y", 6); // antenna
  g.add(turret);
  rbox(g, W - 0.2, 0.25, 0.2, 0.05, p.trim, 0, 0.9, -3.3); // tow bar
  lights(g, p, { w: W, y: 1.6, front: -3.22, rear: 3.22, headW: 0.26 });
  for (const z of [-2.3, -0.8, 0.8, 2.3]) for (const x of [-1.3, 1.3]) wheel(g, p, x, 0.6, z, 0.6, 0.45, { spokes: 6, offroad: true });
  anchor(g, "smokeAnchor", 0, 2.4, 2.4);
  return finish(g, "apc", { wheelR: 0.6, beamZ: -3.25, beamY: 1.6, lean: 0.02 });
}

const BUILDERS = {
  car: buildSedan,
  sedan: buildSedan,
  sports: buildSports,
  suv: buildSUV,
  pickup: buildPickup,
  truck: buildTruck,
  bike: buildBike,
  apc: buildAPC,
};

export function isGroundVehicleType(type) {
  return Boolean(BUILDERS[type || "car"]);
}

export function buildGroundVehicle(type, color) {
  const build = BUILDERS[type || "car"] || buildSedan;
  const group = build(typeof color === "number" ? color : 0x2f6f9f);
  return group;
}
