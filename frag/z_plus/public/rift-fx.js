/**
 * Z+ "The Rift" visuals (server logic: z_plus/dragon-system.js).
 *
 *   - the black hole: pitch-black core, lensing rim, a swirling accretion disk,
 *     a photon ring that always faces you, particles spiralling in and a
 *     column of dust being sucked up from the ground
 *   - zombies tumbling up into it, then the implosion shockwave
 *   - the Undead Wyrm: procedural rotting dragon (exposed ribs, glowing eyes
 *     and veins, torn bat wings) with wing-beat / neck / tail / jaw animation
 *   - fire breath, fireballs with trails, burning ground
 *   - mini-dragon companions
 *   - boss HP bar + event banners
 *
 * No new lights (the renderer's light budget is fixed: adding lights
 * recompiles every shader) — fire glow borrows a pooled light; the rest is
 * emissive + bloom.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

function std(color, roughness = 0.85, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.05, flatShading: true, ...extra });
}

function palette(kind) {
  if (kind === "pet") {
    return {
      skin: std(0x6a2a1e, 0.7),
      belly: std(0xc0703a, 0.8),
      bone: std(0xe8d8b8, 0.6),
      membrane: std(0x8a3a24, 0.8, { side: THREE.DoubleSide }),
      glow: new THREE.MeshStandardMaterial({ color: 0xffb04a, emissive: 0xff8a1a, emissiveIntensity: 2.4 }),
      dark: std(0x2a1410, 0.9),
    };
  }
  return {
    skin: std(0x2b322a, 0.88),
    belly: std(0x4d4a3c, 0.9),
    bone: std(0xd6ccb0, 0.7),
    membrane: std(0x352a33, 0.85, { side: THREE.DoubleSide }),
    glow: new THREE.MeshStandardMaterial({ color: 0x9dff7a, emissive: 0x6dff4a, emissiveIntensity: 2.6 }),
    dark: std(0x141714, 0.95),
  };
}

function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

// ---------------------------------------------------------------------------
// Dragon model (faces -Z, like world "forward")
// ---------------------------------------------------------------------------

function wingMembrane(points, mat) {
  // Fan-triangulate a polygon (first point = fan origin).
  const pos = [];
  for (let i = 1; i < points.length - 1; i += 1) {
    pos.push(...points[0], ...points[i], ...points[i + 1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  return m;
}

function bone(len, r0, r1, mat) {
  // Cylinder along +X from the origin.
  const g = new THREE.CylinderGeometry(r1, r0, len, 6);
  g.rotateZ(-Math.PI / 2);
  g.translate(len / 2, 0, 0);
  return mesh(g, mat);
}

function buildWing(side, P, detail) {
  const s = side; // +1 right, -1 left
  const root = new THREE.Group();
  // Inner arm: shoulder -> elbow along +X (mirrored with scale.x).
  const arm = new THREE.Group();
  root.add(arm);
  arm.add(bone(5.5, 0.55, 0.4, P.bone));
  const wrist = new THREE.Group();
  wrist.position.set(5.5, 0, 0);
  arm.add(wrist);
  wrist.add(bone(5, 0.4, 0.25, P.bone));
  // Fingers fan back from the wrist (toward the tail = +Z).
  const tips = [];
  const fingers = [
    [8.5, 0.05],
    [9, 0.45],
    [7.8, 0.85],
    [6, 1.25],
  ];
  for (const [len, ang] of fingers) {
    const f = bone(len, 0.2, 0.06, P.bone);
    f.position.set(5, 0, 0);
    f.rotation.y = -ang;
    wrist.add(f);
    tips.push([5 + Math.cos(ang) * len, 0, Math.sin(ang) * len]);
    if (detail) {
      // Glowing veins along each finger.
      const vein = bone(len * 0.8, 0.05, 0.03, P.glow);
      vein.position.set(5, -0.05, 0);
      vein.rotation.y = -ang - 0.08;
      vein.castShadow = false;
      wrist.add(vein);
    }
  }
  // Outer membrane (scalloped trailing edge), attached to the wrist so it
  // folds with the hand.
  const outer = [[5, 0, 0]];
  for (let i = 0; i < tips.length; i += 1) {
    outer.push(tips[i]);
    if (i < tips.length - 1) {
      const a = tips[i];
      const b = tips[i + 1];
      outer.push([(a[0] + b[0]) / 2 * 0.86 + 5 * 0.14, 0, (a[2] + b[2]) / 2 * 0.86]);
    }
  }
  outer.push([0.4, 0, 4.6]);
  outer.push([0, 0, 0]);
  wrist.add(wingMembrane(outer, P.membrane));
  // Inner membrane: arm to the flank.
  arm.add(wingMembrane([[0, 0, 0], [5.5, 0, 0], [5.9, 0, 4.6], [2.5, -0.2, 5.8], [-0.5, -0.3, 6]], P.membrane));
  root.scale.x = s;
  return { root, arm, wrist };
}

/**
 * Build a dragon. opts.scale: 1 = the 24m Wyrm; ~0.2 = a hatchling.
 * opts.detail: ribs, teeth, spikes, veins (the boss only).
 */
export function buildDragon(opts = {}) {
  const P = palette(opts.kind || "wyrm");
  const detail = opts.detail !== false;
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);
  body.scale.setScalar(opts.scale || 1);

  // Torso.
  const torso = mesh(new THREE.SphereGeometry(1, 14, 10), P.skin);
  torso.scale.set(2.6, 2.2, 5.4);
  body.add(torso);
  const belly = mesh(new THREE.SphereGeometry(1, 12, 8), P.belly, 0, -0.9, -0.3);
  belly.scale.set(2, 1.4, 4.4);
  body.add(belly);
  if (detail) {
    // Rotted-through flank: exposed ribs with a sickly glow inside.
    const ribGlow = mesh(new THREE.SphereGeometry(1, 10, 8), P.glow, -1.3, 0.1, -0.2);
    ribGlow.scale.set(1.2, 1.4, 2.6);
    ribGlow.castShadow = false;
    body.add(ribGlow);
    for (let i = 0; i < 6; i += 1) {
      const rib = mesh(new THREE.TorusGeometry(2.25, 0.13, 5, 12, Math.PI * 0.9), P.bone, -0.15, 0.1, -2.4 + i * 0.95);
      rib.rotation.set(0, Math.PI / 2, Math.PI * 0.55);
      body.add(rib);
    }
    // Spine spikes.
    for (let i = 0; i < 9; i += 1) {
      const h = 1.3 - Math.abs(i - 3) * 0.12;
      const sp = mesh(new THREE.ConeGeometry(0.28, h, 5), P.bone, 0, 2.1 - Math.abs(i - 3) * 0.08, -4 + i * 1.1);
      sp.rotation.x = 0.35;
      body.add(sp);
    }
  }

  // Hind legs: hip -> knee -> foot, tucked back in flight, planted on the
  // ground when it lands (see animateDragon "grounded").
  const legs = [];
  for (const s of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(s * 1.7, -1.0, 2.0);
    body.add(hip);
    const thigh = mesh(new THREE.CylinderGeometry(0.75, 0.5, 2.0, 7), P.skin, 0, -1.0, 0);
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.set(0, -2.0, 0);
    hip.add(knee);
    const shin = mesh(new THREE.CylinderGeometry(0.45, 0.32, 1.9, 6), P.skin, 0, -0.95, 0);
    knee.add(shin);
    const foot = new THREE.Group();
    foot.position.set(0, -1.9, 0);
    knee.add(foot);
    foot.add(mesh(new THREE.BoxGeometry(0.9, 0.3, 1.2), P.dark, 0, -0.15, -0.3));
    for (const c of [-0.32, 0, 0.32]) {
      const claw = mesh(new THREE.ConeGeometry(0.12, 0.7, 4), P.bone, c, -0.2, -1.05);
      claw.rotation.x = -Math.PI / 2;
      foot.add(claw);
    }
    legs.push({ hip, knee, foot });
  }

  // Neck: a chain of segments so it can curve.
  const neck = [];
  let parent = new THREE.Group();
  parent.position.set(0, 0.9, -4.6);
  body.add(parent);
  const neckSegs = detail ? 6 : 4;
  for (let i = 0; i < neckSegs; i += 1) {
    const r = 1.15 - i * (0.5 / neckSegs);
    const seg = new THREE.Group();
    seg.position.set(0, 0, i === 0 ? 0 : -0.95 * (6 / neckSegs));
    seg.rotation.x = 0.07;
    const m = mesh(new THREE.SphereGeometry(1, 9, 7), P.skin);
    m.scale.set(r, r * 0.95, 0.85 * (6 / neckSegs));
    seg.add(m);
    if (detail && i % 2 === 0) seg.add(mesh(new THREE.ConeGeometry(0.18, 0.7, 4), P.bone, 0, r * 0.95, 0));
    parent.add(seg);
    neck.push(seg);
    parent = seg;
  }

  // Head.
  const head = new THREE.Group();
  head.position.set(0, 0.1, -1.0 * (6 / neckSegs));
  head.rotation.x = -0.3;
  parent.add(head);
  const skullGeo = new THREE.BoxGeometry(1.7, 1.15, 2.8, 2, 2, 3);
  {
    const pos = skullGeo.attributes.position;
    for (let i = 0; i < pos.count; i += 1) {
      const z = pos.getZ(i);
      const k = z < 0 ? 1 + z * 0.22 : 1; // taper toward the snout
      pos.setX(i, pos.getX(i) * k);
      pos.setY(i, pos.getY(i) * (z < 0 ? 1 + z * 0.12 : 1));
    }
    skullGeo.computeVertexNormals();
  }
  head.add(mesh(skullGeo, P.skin, 0, 0.15, -1.1));
  // Lower jaw on a hinge at the back of the head.
  const jaw = new THREE.Group();
  jaw.position.set(0, -0.35, 0.1);
  head.add(jaw);
  jaw.add(mesh(new THREE.BoxGeometry(1.3, 0.35, 2.5), P.skin, 0, -0.1, -1.3));
  // Mouth glow (fire in the throat).
  const throat = mesh(new THREE.BoxGeometry(1.0, 0.25, 2.0), P.glow, 0, -0.12, -1.0);
  throat.castShadow = false;
  head.add(throat);
  // Eyes.
  for (const s of [-1, 1]) {
    const eye = mesh(new THREE.SphereGeometry(0.17, 8, 6), P.glow, s * 0.62, 0.45, -1.4);
    eye.castShadow = false;
    head.add(eye);
    // Horns sweeping back.
    const horn = mesh(new THREE.ConeGeometry(0.22, 2.2, 5), P.bone, s * 0.55, 0.85, 0.2);
    horn.rotation.set(-2.2, 0, s * 0.35);
    head.add(horn);
    if (detail) {
      const horn2 = mesh(new THREE.ConeGeometry(0.14, 1.2, 5), P.bone, s * 0.75, 0.4, 0.4);
      horn2.rotation.set(-2.0, 0, s * 0.8);
      head.add(horn2);
    }
  }
  if (detail) {
    for (let i = 0; i < 7; i += 1) {
      for (const s of [-1, 1]) {
        const tooth = mesh(new THREE.ConeGeometry(0.07, 0.32, 4), P.bone, s * (0.55 - i * 0.05), -0.22, -0.4 - i * 0.32);
        tooth.rotation.x = Math.PI;
        tooth.castShadow = false;
        head.add(tooth);
      }
    }
  }

  // Tail.
  const tail = [];
  parent = new THREE.Group();
  parent.position.set(0, 0.2, 4.8);
  body.add(parent);
  const tailSegs = detail ? 9 : 5;
  for (let i = 0; i < tailSegs; i += 1) {
    const r = 1.4 * (1 - i / tailSegs) + 0.18;
    const seg = new THREE.Group();
    seg.position.set(0, 0, i === 0 ? 0 : 1.35 * (9 / tailSegs));
    const m = mesh(new THREE.SphereGeometry(1, 8, 6), P.skin);
    m.scale.set(r, r * 0.85, 0.95 * (9 / tailSegs));
    seg.add(m);
    if (detail && i % 2 === 1) seg.add(mesh(new THREE.ConeGeometry(0.15, 0.6, 4), P.bone, 0, r * 0.85, 0));
    parent.add(seg);
    tail.push(seg);
    parent = seg;
  }
  // Bone spade at the tip.
  const spade = mesh(new THREE.ConeGeometry(0.7, 1.8, 4), P.bone, 0, 0, 1.3);
  spade.rotation.x = Math.PI / 2;
  spade.scale.z = 0.25;
  parent.add(spade);

  // Wings.
  const wings = [];
  for (const s of [-1, 1]) {
    const w = buildWing(s, P, detail);
    w.root.position.set(s * 2.0, 1.4, -1.6);
    body.add(w.root);
    wings.push({ ...w, side: s });
  }

  g.userData.rig = { body, neck, head, jaw, throat, tail, wings, legs, phase: Math.random() * 10, mouth: head, gF: 0 };
  return g;
}

/**
 * Animate a dragon rig. mode: flight style; jawOpen 0..1; flap rate.
 */
export function animateDragon(
  g,
  dt,
  { flap = 1.6, amp = 1, glide = 0, jawOpen = 0, hover = 0, limp = 0, throatGlow = 0, grounded = 0, tailSpin = 0, lunge = 0, headYaw = 0, tuck = 0 },
) {
  const R = g.userData.rig;
  // Blend smoothly between the flight and standing poses.
  R.gF += (grounded - R.gF) * Math.min(1, dt * 5);
  const gF = R.gF;
  const fly = 1 - gF;
  R.phase += dt * (flap * fly + 0.35 * gF) * Math.PI * 2;
  const ph = R.phase;
  for (const w of R.wings) {
    const beat = Math.sin(ph) * 0.95 * amp * (1 - glide * 0.85) * (1 - tuck);
    const flyZ = (0.15 + beat) * (1 - limp) - limp * 0.9 - tuck * 0.2;
    const flyY = -(0.2 + glide * 0.5 + hover * 0.15 + tuck * 0.9);
    // Standing: wings fold and plant like front legs (wyvern stance).
    // Folded: arm angled down to the ground like a foreleg, swept back.
    w.arm.rotation.z = flyZ * fly + -0.8 * gF;
    w.arm.rotation.y = flyY * fly + -1.05 * gF;
    const wFlyZ = Math.sin(ph - 0.7) * 0.55 * amp * (1 - glide * 0.8) * (1 - limp) * (1 - tuck) - limp * 0.6 + tuck * 1.6;
    // ...with the hand folded back along the flank (membrane draped, not a sail).
    w.wrist.rotation.z = wFlyZ * fly + 0.55 * gF;
    w.wrist.rotation.y = (-0.15 - glide * 0.4) * fly + -1.9 * gF;
  }
  // Legs: trailing behind in flight, planted (thigh forward, shin back) on the ground.
  for (const L of R.legs || []) {
    L.hip.rotation.x = -1.15 * fly + 0.35 * gF;
    L.knee.rotation.x = -0.5 * fly + -0.7 * gF;
    L.foot.rotation.x = 0.9 * fly + 0.35 * gF;
  }
  // Body rides the wing beats (or breathes, standing).
  R.body.position.y = (Math.sin(ph + 0.4) * 0.35 * amp * (1 - glide)) * fly + Math.sin(ph) * 0.08 * gF;
  const n = R.neck.length;
  for (let i = 0; i < n; i += 1) {
    // headYaw: ground fire sweep; lunge: neck stretches forward and down.
    R.neck[i].rotation.y = Math.sin(ph * 0.25 + i * 0.5) * 0.05 + (headYaw / n);
    // Standing it holds its head high, then strikes down when lunging.
    R.neck[i].rotation.x = 0.07 + Math.sin(ph * 0.5 + i * 0.6) * 0.03 - jawOpen * 0.03 + gF * (i < 3 ? 0.09 : -0.05) - lunge * 0.13;
  }
  for (let i = 0; i < R.tail.length; i += 1) {
    // tailSpin: the whole tail whips out to one side for the sweep.
    R.tail[i].rotation.y = Math.sin(ph * 0.5 - i * 0.55) * 0.09 * (1 + limp) * (1 - tailSpin) + tailSpin * 0.17;
    R.tail[i].rotation.x = Math.sin(ph * 0.5 - i * 0.4) * 0.04 - 0.02 + gF * 0.03;
  }
  R.jaw.rotation.x = jawOpen * 0.75;
  R.throat.material.emissiveIntensity = 2.4 + throatGlow * 6;
}

// ---------------------------------------------------------------------------
// Black hole
// ---------------------------------------------------------------------------

const DISK_VERT = `
varying vec2 vUv; varying vec3 vPos;
void main() { vUv = uv; vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const DISK_FRAG = `
uniform float time; uniform float inner; uniform float outer; uniform float strength;
varying vec3 vPos;
float h(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5453); }
float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
void main() {
  float r = length(vPos.xy);
  float k = clamp((r - inner) / (outer - inner), 0.0, 1.0);
  float a = atan(vPos.y, vPos.x);
  float swirl = n(vec2(a * 4.0 - time * 2.6 + k * 9.0, k * 6.0)) * 0.6 + n(vec2(a * 11.0 - time * 4.0, k * 14.0)) * 0.4;
  float glow = pow(1.0 - k, 2.2) * (0.35 + swirl);
  vec3 hot = vec3(4.0, 2.2, 0.9);
  vec3 cool = vec3(1.3, 0.25, 2.4);
  vec3 col = mix(hot, cool, smoothstep(0.0, 0.7, k));
  float edge = smoothstep(0.0, 0.05, k) * smoothstep(1.0, 0.7, k);
  gl_FragColor = vec4(col * glow * strength, glow * edge * strength);
}
`;
const RIM_FRAG = `
uniform float strength; varying vec3 vN; varying vec3 vV;
void main() {
  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.5);
  gl_FragColor = vec4(vec3(1.8, 0.6, 2.6) * f * strength, f * strength);
}
`;
const RIM_VERT = `
varying vec3 vN; varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalMatrix * normal; vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;
const SPIRAL_VERT = `
uniform float time; uniform float radius; uniform float scale;
attribute float seed;
varying float vA;
void main() {
  float t = fract(time * (0.18 + fract(seed * 7.13) * 0.2) + seed);
  float r = radius * (1.0 - t) + 0.6;
  float ang = seed * 6.2831 + time * (1.2 + 5.0 / (r * 0.25 + 0.6));
  vec3 p = vec3(cos(ang) * r, (fract(seed * 3.7) - 0.5) * r * 0.25, sin(ang) * r);
  vA = smoothstep(0.0, 0.15, t) * (1.0 - smoothstep(0.85, 1.0, t));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = (0.35 + 0.9 * fract(seed * 13.1)) * scale / -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;
const SPIRAL_FRAG = `
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = 1.0 - smoothstep(0.2, 0.5, length(c));
  gl_FragColor = vec4(mix(vec3(1.6, 0.7, 0.3), vec3(0.9, 0.35, 1.6), fract(gl_PointCoord.x * 7.0 + vA)) * d * vA, d * vA);
}
`;
const COLUMN_FRAG = `
uniform float time; uniform float strength; varying vec2 vUv;
float h(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5453); }
float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
void main() {
  float s = n(vec2(vUv.x * 18.0, vUv.y * 6.0 - time * 2.5)) * n(vec2(vUv.x * 7.0 + 3.0, vUv.y * 3.0 - time * 1.6));
  float fade = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.75, vUv.y);
  gl_FragColor = vec4(vec3(0.5, 0.25, 0.8) * s * 1.6, s * fade * 0.55 * strength);
}
`;

function additive(vert, frag, uniforms, extra = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    ...extra,
  });
}

class BlackHole {
  constructor(scene, withColumn) {
    this.time = { value: 0 };
    this.strength = { value: 0 };
    this.g = new THREE.Group();
    this.g.visible = false;
    this.g.userData.dynamic = true;
    this.g.frustumCulled = false;
    scene.add(this.g);
    // Core: pure black (occludes what's behind it).
    this.core = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.MeshBasicMaterial({ color: 0x000000, fog: false }));
    this.g.add(this.core);
    this.rim = new THREE.Mesh(new THREE.SphereGeometry(1.25, 32, 16), additive(RIM_VERT, RIM_FRAG, { strength: this.strength }));
    this.g.add(this.rim);
    const diskUniforms = { time: this.time, inner: { value: 1.3 }, outer: { value: 4.6 }, strength: this.strength };
    this.disk = new THREE.Mesh(new THREE.RingGeometry(1.3, 4.6, 128, 6), additive(DISK_VERT, DISK_FRAG, diskUniforms));
    this.disk.rotation.x = -Math.PI / 2 + 0.38;
    this.g.add(this.disk);
    // Photon ring: a thinner disk that always faces the camera.
    this.halo = new THREE.Mesh(
      new THREE.RingGeometry(1.15, 2.1, 96, 2),
      additive(DISK_VERT, DISK_FRAG, { time: this.time, inner: { value: 1.15 }, outer: { value: 2.1 }, strength: this.strength }),
    );
    this.g.add(this.halo);
    // Particles spiralling in.
    const n = 700;
    const seeds = new Float32Array(n);
    for (let i = 0; i < n; i += 1) seeds[i] = Math.random();
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    pg.setAttribute("seed", new THREE.BufferAttribute(seeds, 1));
    this.spiralUniforms = { time: this.time, radius: { value: 5.2 }, scale: { value: 600 } };
    this.spiral = new THREE.Points(pg, additive(SPIRAL_VERT, SPIRAL_FRAG, this.spiralUniforms));
    this.spiral.frustumCulled = false;
    this.spiral.rotation.x = 0.38;
    this.g.add(this.spiral);
    // Dust column being sucked up from the ground.
    if (withColumn) {
      const cg = new THREE.CylinderGeometry(1, 3.2, 1, 32, 1, true);
      cg.translate(0, -0.5, 0);
      this.column = new THREE.Mesh(
        cg,
        new THREE.ShaderMaterial({
          vertexShader: DISK_VERT.replace("varying vec3 vPos;", "varying vec3 vPos;"),
          fragmentShader: COLUMN_FRAG,
          uniforms: { time: this.time, strength: this.strength },
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          fog: false,
        }),
      );
      scene.add(this.column);
      this.column.visible = false;
      this.column.userData.dynamic = true;
    }
  }

  update(v, dt, camera, pixelScale) {
    if (!v) {
      this.strength.value = Math.max(0, this.strength.value - dt * 1.5);
      if (this.strength.value <= 0) {
        this.g.visible = false;
        if (this.column) this.column.visible = false;
      }
      return;
    }
    this.g.visible = true;
    this.strength.value = Math.min(1, this.strength.value + dt * 0.8);
    this.time.value += dt;
    this.g.position.set(v.x, v.y, v.z);
    this.g.scale.setScalar(v.r);
    this.spiralUniforms.scale.value = pixelScale;
    this.spiralUniforms.radius.value = 5.2; // local units (the group is scaled by r)
    this.halo.quaternion.copy(camera.quaternion);
    this.core.scale.setScalar(1 + Math.sin(this.time.value * 3) * 0.03);
    if (this.column) {
      this.column.visible = true;
      this.column.position.set(v.x, v.y, v.z);
      this.column.scale.set(v.r * 1.2, v.y, v.r * 1.2);
    }
  }
}

// ---------------------------------------------------------------------------
// Fire particles (breath, fireball trails, burning ground) — one system
// ---------------------------------------------------------------------------

const FIRE_VERT = `
attribute float aSize; attribute float aLife; attribute float aHeat;
uniform float scale;
varying float vLife; varying float vHeat;
void main() {
  vLife = aLife; vHeat = aHeat;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * scale / max(0.5, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;
const FIRE_FRAG = `
uniform vec3 cDeep; uniform vec3 cMid; uniform vec3 cCore; uniform vec3 cSmoke;
varying float vLife; varying float vHeat;
void main() {
  if (vLife <= 0.0) discard;
  vec2 c = gl_PointCoord - 0.5;
  float d = 1.0 - smoothstep(0.15, 0.5, length(c));
  // White-yellow core -> orange -> deep red -> smoke as it ages.
  // Mostly orange flame; only the youngest particles burn yellow-white.
  vec3 hot = mix(cDeep, cMid, vHeat);
  hot = mix(hot, cCore, smoothstep(0.8, 1.0, vLife) * vHeat);
  vec3 col = mix(cSmoke, hot * 1.6, smoothstep(0.05, 0.5, vLife));
  float a = d * smoothstep(0.0, 0.3, vLife) * 0.7;
  gl_FragColor = vec4(col * a, a);
}
`;

// Particle palettes: [deep, mid, core, smoke] (linear RGB).
export const PARTICLE_PALETTES = {
  fire: [[0.9, 0.16, 0.02], [1.0, 0.55, 0.12], [1.0, 0.85, 0.5], [0.05, 0.035, 0.03]],
  blood: [[0.55, 0.0, 0.02], [0.95, 0.06, 0.05], [1.0, 0.45, 0.35], [0.06, 0.0, 0.01]],
  rot: [[0.8, 0.12, 0.05], [1.0, 0.35, 0.12], [1.0, 0.75, 0.45], [0.12, 0.03, 0.02]],
  gold: [[0.85, 0.5, 0.05], [1.0, 0.8, 0.25], [1.0, 1.0, 0.75], [0.15, 0.1, 0.02]],
  gravity: [[0.25, 0.05, 0.6], [0.6, 0.25, 1.0], [0.9, 0.8, 1.0], [0.03, 0.0, 0.06]],
  shadow: [[0.25, 0.0, 0.02], [0.5, 0.05, 0.05], [0.9, 0.2, 0.15], [0.0, 0.0, 0.0]],
};

export class FireParticles {
  constructor(scene, max = 2600, palette = PARTICLE_PALETTES.fire) {
    this.max = max;
    this.n = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.heat = new Float32Array(max);
    this.grow = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aLife", new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aHeat", new THREE.BufferAttribute(this.heat, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    const v3 = (c) => ({ value: new THREE.Vector3(c[0], c[1], c[2]) });
    this.uniforms = { scale: { value: 600 }, cDeep: v3(palette[0]), cMid: v3(palette[1]), cCore: v3(palette[2]), cSmoke: v3(palette[3]) };
    this.points = new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        vertexShader: FIRE_VERT,
        fragmentShader: FIRE_FRAG,
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    );
    this.points.frustumCulled = false;
    this.points.userData.dynamic = true;
    scene.add(this.points);
    this.cursor = 0;
  }

  emit(x, y, z, vx, vy, vz, size, life, heat = 1, grow = 2.5) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.size[i] = size;
    this.life[i] = 1;
    this.maxLife[i] = life;
    this.heat[i] = heat;
    this.grow[i] = grow;
  }

  update(dt, pixelScale) {
    this.uniforms.scale.value = pixelScale;
    for (let i = 0; i < this.max; i += 1) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt / this.maxLife[i];
      if (this.life[i] <= 0) {
        this.life[i] = 0;
        continue;
      }
      this.vel[i * 3 + 1] += dt * 2.5; // hot air rises
      this.vel[i * 3] *= 1 - dt * 1.2;
      this.vel[i * 3 + 2] *= 1 - dt * 1.2;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] = Math.max(0.1, this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt);
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] += this.grow[i] * dt;
    }
    for (const k of ["position", "aSize", "aLife", "aHeat"]) this.geo.attributes[k].needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// One-shot effects: implosion shockwave
// ---------------------------------------------------------------------------

export class Shockwaves {
  constructor(scene) {
    this.scene = scene;
    this.list = [];
  }
  spawn(x, y, z, size = 1, colors = {}) {
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 16),
      new THREE.MeshBasicMaterial({ color: colors.shell ?? 0xd9a6ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    );
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1, 96),
      new THREE.MeshBasicMaterial({ color: colors.ring ?? 0xffe2b0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    );
    shell.visible = colors.noShell !== true;
    ring.rotation.x = -Math.PI / 2;
    shell.position.set(x, y, z);
    ring.position.set(x, y, z);
    this.scene.add(shell, ring);
    this.list.push({ shell, ring, t: 0, size });
  }
  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i -= 1) {
      const s = this.list[i];
      s.t += dt;
      const k = s.t / 1.6;
      s.shell.scale.setScalar((2 + k * 38) * s.size);
      s.shell.material.opacity = Math.max(0, 0.85 * (1 - k * 1.4));
      s.ring.scale.setScalar((3 + k * 120) * s.size);
      s.ring.material.opacity = Math.max(0, 0.9 * (1 - k));
      if (k >= 1) {
        this.scene.remove(s.shell, s.ring);
        s.shell.geometry.dispose();
        s.shell.material.dispose();
        s.ring.geometry.dispose();
        s.ring.material.dispose();
        this.list.splice(i, 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

const TACTIC_TEXT = {
  flank: "The Wyrm is swinging around behind you!",
  flush: "It has marked your hiding spot — MOVE!",
  cover: "It's burning down your cover!",
  feint: "A feint — fireballs incoming!",
  dive: "LOOK UP — it's diving from above!",
};

class RiftHud {
  constructor(root) {
    this.el = document.createElement("div");
    this.el.className = "rift-hud hidden";
    this.el.innerHTML =
      '<div class="rift-name"></div><div class="rift-bar"><div class="rift-fill"></div><div class="rift-ghost"></div></div><div class="rift-msg"></div>';
    root.appendChild(this.el);
    this.nameEl = this.el.querySelector(".rift-name");
    this.fill = this.el.querySelector(".rift-fill");
    this.ghost = this.el.querySelector(".rift-ghost");
    this.msgEl = this.el.querySelector(".rift-msg");
    this.pet = document.createElement("div");
    this.pet.className = "pet-hud hidden";
    root.appendChild(this.pet);
    this.banner = document.createElement("div");
    this.banner.className = "rift-banner hidden";
    root.appendChild(this.banner);
    this.bannerUntil = 0;
    this.ghostFrac = 1;
    this.key = "";
  }

  flash(text, ms = 3200) {
    this.banner.textContent = text;
    this.banner.classList.remove("hidden");
    this.banner.classList.remove("pulse");
    void this.banner.offsetWidth;
    this.banner.classList.add("pulse");
    this.bannerUntil = performance.now() + ms;
  }

  update(rift, myPet, dt) {
    const now = performance.now();
    if (now > this.bannerUntil) this.banner.classList.add("hidden");
    // Boss bar / rift status.
    if (!rift || rift.ph === "none") {
      this.el.classList.add("hidden");
    } else {
      this.el.classList.remove("hidden");
      let name;
      let frac = 1;
      let msg = "";
      if (rift.ph === "vortex") {
        name = "THE RIFT";
        msg = `The horde is being devoured — ${rift.vortex?.n || 0} consumed`;
        frac = 1;
      } else if (rift.ph === "burst") {
        name = "THE RIFT COLLAPSES";
        msg = "Something is hatching…";
      } else {
        const d = rift.dragon;
        name = `UNDEAD WYRM  ·  LV ${d?.lvl || 1}`;
        frac = d ? d.hp / d.max : 0;
        msg = rift.ph === "slain" ? "SLAIN" : d?.mode === "devour" ? "It's devouring the horde to heal — kill them first!" : d ? `${d.hp.toLocaleString()} / ${d.max.toLocaleString()}` : "";
      }
      const key = `${name}|${msg}`;
      if (key !== this.key) {
        this.key = key;
        this.nameEl.textContent = name;
        this.msgEl.textContent = msg;
      }
      this.fill.style.width = `${(frac * 100).toFixed(1)}%`;
      this.ghostFrac = frac > this.ghostFrac ? frac : this.ghostFrac + (frac - this.ghostFrac) * Math.min(1, dt * 1.5);
      this.ghost.style.width = `${(this.ghostFrac * 100).toFixed(1)}%`;
      this.el.classList.toggle("vortex", rift.ph === "vortex" || rift.ph === "burst");
    }
    // My hatchling.
    if (myPet) {
      const [, , , , , hp, max, st, lvl] = myPet;
      const state = st === 3 ? "DOWN — reviving" : st === 1 ? "BREATHING FIRE" : st === 2 ? "rekindling…" : "ready";
      this.pet.textContent = `🐉 Hatchling Lv${lvl}  ·  ${hp}/${max} HP  ·  ${state}`;
      this.pet.classList.remove("hidden");
      this.pet.classList.toggle("down", st === 3);
    } else {
      this.pet.classList.add("hidden");
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class RiftFx {
  constructor({ renderer, audio, root }) {
    this.R = renderer;
    this.scene = renderer.scene;
    this.audio = audio;
    this.rift = new BlackHole(this.scene, true);
    this.maw = new BlackHole(this.scene, false); // the dragon's devour vortex
    this.fire = new FireParticles(this.scene);
    this.shock = new Shockwaves(this.scene);
    this.hud = new RiftHud(root);
    this.dragon = null;
    this.pets = new Map();
    this.fireballs = new Map();
    this.seenEvents = new Set();
    this.breathLight = null;
    this.humOn = false;
    this.lastMode = null;
    // Red danger circle where the Wyrm is about to land.
    this.mark = new THREE.Group();
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xff2a10, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const fillMat = new THREE.MeshBasicMaterial({ color: 0xff3a10, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.markRing = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 96), ringMat);
    this.markFill = new THREE.Mesh(new THREE.CircleGeometry(1, 64), fillMat);
    this.markInner = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64), ringMat.clone());
    for (const m of [this.markRing, this.markFill, this.markInner]) {
      m.rotation.x = -Math.PI / 2;
      this.mark.add(m);
    }
    this.mark.visible = false;
    this.mark.userData.dynamic = true;
    this.scene.add(this.mark);
  }

  /** Dust thrown out in a ring (landings, takeoff, stomps). */
  dustRing(x, z, radius, count = 22) {
    for (let i = 0; i < count; i += 1) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.3;
      const r = radius * (0.4 + Math.random() * 0.6);
      _v.set(x + Math.cos(a) * r, 0.6 + Math.random() * 1.5, z + Math.sin(a) * r);
      this.R.spawnSmokePuff?.(_v, Math.random() < 0.5 ? 0x8a7d68 : 0x6e6252);
    }
    this.R.spawnDirtBurst?.(x, z, true);
  }

  /** Dragon + hatchling models for shader precompilation. */
  prewarmModels() {
    return [buildDragon({ kind: "wyrm", detail: true }), buildDragon({ kind: "pet", scale: 0.17, detail: false })].map((m) => {
      m.position.set(0, -500, 0);
      return m;
    });
  }

  pixelScale() {
    const r = this.R.renderer;
    return (r.domElement.height || window.innerHeight) * 0.5;
  }

  /** state: interpolated Z+ state. me: my player. */
  update(state, me, myId, dt) {
    const rift = state.rift;
    const ps = this.pixelScale();
    const cam = this.R.camera;

    this.handleEvents(state, me);

    // Black holes.
    const v = rift?.vortex;
    this.rift.update(v && v.kind === "rift" ? v : null, dt, cam, ps);
    this.maw.update(v && v.kind === "devour" ? v : null, dt, cam, ps);
    const humming = Boolean(v);
    if (humming !== this.humOn) {
      this.humOn = humming;
      if (humming) this.audio.startRiftHum?.();
      else this.audio.stopRiftHum?.();
    }

    this.updateDragon(rift, me, dt);
    this.updatePets(rift, myId, dt);
    this.updateFireballs(rift, dt);
    this.updateFireZones(rift, dt);
    this.fire.update(dt, ps);
    this.shock.update(dt);

    const myPet = rift?.pets?.find((p) => p[0] === myId) || null;
    this.hud.update(rift, myPet, dt);
  }

  handleEvents(state, me) {
    for (const ev of state.zombieEvents || []) {
      const key = `${ev.type}:${ev.at}:${ev.x}`;
      if (this.seenEvents.has(key)) continue;
      this.seenEvents.add(key);
      if (this.seenEvents.size > 400) this.seenEvents = new Set([...this.seenEvents].slice(-200));
      const dist = me ? Math.hypot(ev.x - me.x, ev.z - me.z) : 50;
      switch (ev.type) {
        case "rift_open":
          this.hud.flash("THE SKY IS TEARING OPEN", 4000);
          this.R.shakeIntensity = Math.min(0.9, (this.R.shakeIntensity || 0) + 0.4);
          break;
        case "rift_burst":
          this.shock.spawn(ev.x, ev.y || 46, ev.z, 1.2);
          this.audio.playRiftBurst?.();
          this.R.shakeIntensity = 1.2;
          this.hud.flash("THE RIFT COLLAPSES", 2500);
          break;
        case "dragon_spawn":
          this.audio.playRoar?.(dist, 1.4);
          this.hud.flash("THE UNDEAD WYRM HAS HATCHED", 3500);
          break;
        case "dragon_roar":
          this.audio.playRoar?.(dist, 1);
          this.R.shakeIntensity = Math.min(1, (this.R.shakeIntensity || 0) + 0.5);
          this.hud.flash("Its roar wakes the dead…", 2500);
          break;
        case "dragon_devour":
          this.hud.flash("It's devouring the horde to heal — kill them first!", 3500);
          break;
        case "dragon_tactic":
          if (TACTIC_TEXT[ev.tactic] && (!ev.target || ev.target === me?.id || ev.tactic !== "flush")) {
            this.hud.flash(TACTIC_TEXT[ev.tactic], 2600);
          }
          break;
        case "dragon_breath":
          this.audio.playDragonBreath?.(dist);
          break;
        case "dragon_fireball_hit":
          this.R.spawnExplosionEffect(ev.x, ev.y || 1, ev.z, 26);
          this.audio.playCrash?.(40, dist);
          for (let i = 0; i < 40; i += 1) {
            const a = Math.random() * Math.PI * 2;
            const sp = 4 + Math.random() * 10;
            this.fire.emit(ev.x, (ev.y || 1) + 0.5, ev.z, Math.cos(a) * sp, 3 + Math.random() * 6, Math.sin(a) * sp, 2.2, 0.9 + Math.random() * 0.6, Math.random());
          }
          break;
        case "dragon_slain":
          this.audio.playRoar?.(dist, 0.7);
          this.hud.flash("THE UNDEAD WYRM IS FALLING!", 3000);
          break;
        case "dragon_crash":
          this.R.spawnExplosionEffect(ev.x, 2, ev.z, 60);
          this.shock.spawn(ev.x, 1, ev.z, 0.4);
          this.R.shakeIntensity = 1.4;
          this.audio.playCollapse?.(dist);
          break;
        case "dragon_slam_mark":
          this.hud.flash(ev.tactic === "slam_group" ? "IT'S DIVING INTO YOUR GROUP — SCATTER!" : "IT'S COMING DOWN — GET CLEAR OF THE RED CIRCLE!", 2800);
          this.audio.playRoar?.(dist, 0.9);
          break;
        case "dragon_slam_fall":
          this.audio.playWhoosh?.(dist * 0.5);
          break;
        case "dragon_slam":
          this.shock.spawn(ev.x, (ev.y || 0) + 0.5, ev.z, 0.45);
          this.dustRing(ev.x, ev.z, 26, 34);
          this.R.spawnExplosionEffect(ev.x, 1, ev.z, 30);
          this.R.shakeIntensity = Math.min(1.6, (this.R.shakeIntensity || 0) + 1.6 * Math.max(0.15, 1 - dist / 140));
          this.audio.playCollapse?.(dist);
          this.audio.playRoar?.(dist, 1.3);
          this.hud.flash("IT LANDED — strike the head while it's grounded!", 3000);
          break;
        case "dragon_gact":
          if (ev.act === "tail") this.audio.playWhoosh?.(dist);
          else if (ev.act === "bite") this.audio.playRoar?.(dist, 0.6);
          else if (ev.act === "gbreath") this.audio.playDragonBreath?.(dist);
          break;
        case "dragon_stomp":
          this.shock.spawn(ev.x, 0.5, ev.z, 0.18);
          this.dustRing(ev.x, ev.z, 12, 14);
          this.R.shakeIntensity = Math.min(1.2, (this.R.shakeIntensity || 0) + 0.9 * Math.max(0.1, 1 - dist / 90));
          this.audio.playCrash?.(50, dist);
          break;
        case "dragon_takeoff":
          this.dustRing(ev.x, ev.z, 30, 30);
          this.R.shakeIntensity = Math.min(1, (this.R.shakeIntensity || 0) + 0.6 * Math.max(0.1, 1 - dist / 100));
          this.audio.playWhoosh?.(dist);
          break;
        case "pet_bond":
          if (ev.owner === me?.id) {
            this.hud.flash(ev.level > 1 ? `Your hatchling grew stronger! (Lv ${ev.level})` : "A hatchling has bonded with you!", 4000);
          }
          break;
        case "pet_down":
          if (ev.owner === me?.id) this.hud.flash("Your hatchling is down — it will return", 2500);
          break;
        default:
      }
    }
  }

  updateDragon(rift, me, dt) {
    const d = rift?.dragon;
    if (!d) {
      if (this.dragon) {
        this.scene.remove(this.dragon);
        this.dragon = null;
      }
      this.releaseBreathLight();
      return;
    }
    if (!this.dragon) {
      this.dragon = buildDragon({ kind: "wyrm", detail: true });
      this.dragon.userData.dynamic = true;
      this.scene.add(this.dragon);
      this.hatch = 0;
    }
    const g = this.dragon;
    // Hatch: grow out of the burst.
    this.hatch = Math.min(1, this.hatch + dt / 2.2);
    const grow = (d.mode === "emerge" ? 0.2 + 0.8 * easeOut(this.hatch) : 1) * (d.sc || 1);
    g.scale.setScalar(grow);
    g.position.set(d.x, d.y, d.z);
    _e.set(d.pitch, d.yaw, -d.roll, "YXZ");
    g.quaternion.setFromEuler(_e);

    const groundBreath = d.ga === "gbreath" && (d.gt || 0) > 500;
    const breathing = (d.mode === "breath" || groundBreath) && rift.ph === "dragon";
    const devouring = d.mode === "devour";
    const slain = rift.ph === "slain";
    const grounded = d.gr || d.mode === "grounded" ? 1 : 0;
    const gt = d.gt || 0;
    // Ground-move timing (mirrors the server's windups).
    const tailSpin = d.ga === "tail" ? (gt < 550 ? -gt / 550 : gt < 1150 ? 1 : Math.max(0, 1 - (gt - 1150) / 350)) : 0;
    const lunge = d.ga === "bite" ? (gt < 450 ? -gt / 450 * 0.6 : gt < 800 ? 1 : Math.max(0, 1 - (gt - 800) / 400)) : 0;
    animateDragon(g, dt, {
      flap: slain ? 0.4 : d.mode === "takeoff" ? 2.6 : d.mode === "volley" || d.mode === "roar" || devouring ? 1.4 : d.mode === "dodge" ? 3 : breathing ? 1.1 : 1.6,
      amp: d.mode === "dodge" || d.mode === "takeoff" ? 1.35 : 1,
      glide: (d.mode === "dive" && d.vy < -4) || d.mode === "slam_fall" ? 1 : breathing ? 0.4 : 0,
      tuck: d.mode === "slam_fall" ? 1 : 0,
      hover: d.mode === "volley" || d.mode === "roar" || devouring || d.mode === "slam_rise" ? 1 : 0,
      jawOpen: breathing || devouring || d.mode === "roar" || lunge > 0.5 ? 1 : d.mode === "volley" ? 0.5 : grounded ? 0.25 : 0.08,
      limp: slain ? 1 : 0,
      throatGlow: breathing ? 1 : d.mode === "volley" ? 0.6 : 0,
      grounded,
      tailSpin: Math.abs(tailSpin),
      lunge: Math.max(0, lunge),
      headYaw: groundBreath ? -(d.by || 0) : 0,
    });

    // Landing telegraph: a red circle that tightens as it plummets.
    if (d.land && (d.mode === "slam_rise" || d.mode === "slam_fall")) {
      const t = performance.now() * 0.001;
      this.mark.visible = true;
      this.mark.position.set(d.land[0], 0.15, d.land[1]);
      this.mark.scale.setScalar(22);
      const fall = d.mode === "slam_fall";
      const pulse = 0.5 + 0.5 * Math.sin(t * (fall ? 22 : 9));
      this.markRing.material.opacity = 0.55 + 0.4 * pulse;
      this.markFill.material.opacity = (fall ? 0.3 : 0.14) + 0.12 * pulse;
      const inner = fall ? Math.max(0.05, 1 - (d.mt || 0) / 1400) : 0.35 + 0.1 * Math.sin(t * 3);
      this.markInner.scale.setScalar(inner);
    } else {
      this.mark.visible = false;
    }

    // Fire breath pouring from the jaws.
    if (breathing) {
      const head = g.userData.rig.head;
      head.getWorldPosition(_v);
      head.getWorldQuaternion(_q);
      _v2.set(0, groundBreath ? -0.15 : -0.55, -1).normalize().applyQuaternion(_q); // out of the mouth
      _v.addScaledVector(_v2, 2.8 * grow);
      const big = d.sc || 1;
      for (let i = 0; i < 30; i += 1) {
        const sp = (26 + Math.random() * 12) * (0.6 + big * 0.4);
        const spread = 0.24;
        this.fire.emit(
          _v.x, _v.y, _v.z,
          (_v2.x + (Math.random() - 0.5) * spread) * sp,
          (_v2.y + (Math.random() - 0.5) * spread) * sp,
          (_v2.z + (Math.random() - 0.5) * spread) * sp,
          (1.4 + Math.random() * 1.2) * (0.5 + big * 0.5),
          0.6 + Math.random() * 0.4,
          Math.random(),
          9 * big,
        );
      }
      // The flames light up the ground beneath (pooled light).
      if (!this.breathLight) this.breathLight = this.R.borrowPointLight?.(0xff7a2a, 4, 45, 1.6) || null;
      if (this.breathLight && this.breathLight.owned()) {
        this.breathLight.light.position.set(_v.x + _v2.x * 14, Math.max(2, _v.y + _v2.y * 14), _v.z + _v2.z * 14);
        this.breathLight.light.intensity = 3.5 + Math.random() * 1.5;
      }
    } else {
      this.releaseBreathLight();
    }
    // Rotting embers drift off it.
    const sc = d.sc || 1;
    if (Math.random() < dt * 35) {
      this.fire.emit(d.x + (Math.random() - 0.5) * 6 * sc, d.y + (Math.random() - 0.5) * 3 * sc, d.z + (Math.random() - 0.5) * 8 * sc, 0, -1, 0, 0.6 * sc, 1.5, 0.2, 0.5);
    }
    // Dust kicked up while it walks / lunges / spins on the ground.
    if (grounded && (tailSpin > 0.5 || lunge > 0.5) && Math.random() < dt * 20) {
      _v.set(d.x + (Math.random() - 0.5) * 20, 0.8, d.z + (Math.random() - 0.5) * 20);
      this.R.spawnSmokePuff?.(_v, 0x7d7060);
    }
    // Wing-beat whoosh near players.
    if (me && d.mode !== this.lastMode) {
      this.lastMode = d.mode;
      if (d.mode === "dodge") this.audio.playWhoosh?.(Math.hypot(d.x - me.x, d.z - me.z));
    }
  }

  releaseBreathLight() {
    if (this.breathLight) {
      this.breathLight.release();
      this.breathLight = null;
    }
  }

  updatePets(rift, myId, dt) {
    const keep = new Set();
    for (const p of rift?.pets || []) {
      const [owner, x, y, z, yaw, , , st, lvl] = p;
      keep.add(owner);
      let g = this.pets.get(owner);
      if (!g) {
        g = buildDragon({ kind: "pet", scale: 0.17, detail: false });
        g.userData.dynamic = true;
        this.scene.add(g);
        this.pets.set(owner, g);
      }
      g.visible = st !== 3;
      if (!g.visible) continue;
      g.position.set(x, y, z);
      g.rotation.set(0, yaw, 0, "YXZ");
      g.scale.setScalar(1 + (lvl - 1) * 0.12); // grows a little each level
      const breathing = st === 1;
      animateDragon(g, dt, { flap: 3.2, amp: 1, jawOpen: breathing ? 1 : 0.1, throatGlow: breathing ? 1 : 0 });
      if (breathing) {
        const head = g.userData.rig.head;
        head.getWorldPosition(_v);
        head.getWorldQuaternion(_q);
        _v2.set(0, -0.35, -1).normalize().applyQuaternion(_q);
        for (let i = 0; i < 5; i += 1) {
          const sp = 13 + Math.random() * 5;
          this.fire.emit(
            _v.x, _v.y, _v.z,
            (_v2.x + (Math.random() - 0.5) * 0.3) * sp,
            (_v2.y + (Math.random() - 0.5) * 0.3) * sp,
            (_v2.z + (Math.random() - 0.5) * 0.3) * sp,
            0.45 + Math.random() * 0.4,
            0.45 + Math.random() * 0.25,
            Math.random(),
            3,
          );
        }
      }
    }
    for (const [owner, g] of this.pets) {
      if (keep.has(owner)) continue;
      this.scene.remove(g);
      this.pets.delete(owner);
    }
  }

  updateFireballs(rift, dt) {
    const keep = new Set();
    for (const [id, x, y, z] of rift?.fb || []) {
      keep.add(id);
      let f = this.fireballs.get(id);
      if (!f) {
        f = new THREE.Mesh(
          new THREE.SphereGeometry(0.9, 12, 8),
          new THREE.MeshBasicMaterial({ color: 0xffc070, fog: false }),
        );
        f.material.color.setRGB(4, 2, 0.6); // HDR: blooms
        f.userData.dynamic = true;
        this.scene.add(f);
        this.fireballs.set(id, f);
      }
      f.position.set(x, y, z);
      f.scale.setScalar(1 + Math.sin(performance.now() * 0.03 + id) * 0.15);
      for (let i = 0; i < 4; i += 1) {
        this.fire.emit(x + (Math.random() - 0.5), y + (Math.random() - 0.5), z + (Math.random() - 0.5), (Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2, 1.6, 0.5 + Math.random() * 0.3, Math.random(), 3);
      }
    }
    for (const [id, f] of this.fireballs) {
      if (keep.has(id)) continue;
      this.scene.remove(f);
      f.geometry.dispose();
      f.material.dispose();
      this.fireballs.delete(id);
    }
  }

  updateFireZones(rift, dt) {
    for (const [x, z, r, left] of rift?.fz || []) {
      const rate = Math.min(1, left / 1500) * r * r * 1.4;
      let n = rate * dt * 6;
      while (n > 0) {
        if (n < 1 && Math.random() > n) break;
        n -= 1;
        const a = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(Math.random()) * r;
        this.fire.emit(x + Math.cos(a) * rr, 0.2, z + Math.sin(a) * rr, 0, 2 + Math.random() * 2.5, 0, 0.9 + Math.random() * 0.8, 0.7 + Math.random() * 0.5, Math.random(), 1.2);
      }
    }
  }
}

function easeOut(t) {
  return 1 - (1 - t) * (1 - t);
}
