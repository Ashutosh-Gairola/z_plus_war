/**
 * Countryside look (see frag/world-regions.js for the layout): tree species,
 * Japanese village architecture (sweeping hip roofs, pagoda, torii, stone
 * lanterns), cliffs / cave rock, the waterfall, crystals, farm props, and the
 * instanced field crops (golden pampas, rice shoots).
 *
 * Everything static uses plain-colored MeshStandardMaterials so the scene
 * optimizer can fold it into the merged per-area chunks; only the waterfall
 * (animated shader) and the instanced fields stay as their own draw calls.
 */

import { patchSurface } from "./atmosphere.js";

const _c = new THREE.Color();
const matCache = new Map();
function mat(color, roughness = 0.9, extra = {}) {
  const key = `${color}:${roughness}:${JSON.stringify(extra)}`;
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, ...extra }));
  return matCache.get(key);
}
function surf(material, kind) {
  material.userData.surface = { kind };
  return material;
}
function shade(hex, l = 0, s = 0) {
  return _c.setHex(hex).offsetHSL(0, s, l).getHex();
}
// Deterministic per-prop randomness (every client builds the same world).
function rng(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i += 1) h = Math.imul(h ^ seedStr.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}
function mesh(geo, material, shadow = true) {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

/** Fills `group` (positioned at the tree's base) with the species' shape. */
export function buildTreeVariant(group, prop) {
  const r = rng(prop.id);
  const H = prop.sy;
  const base = prop.color;
  switch (prop.variant) {
    case "pine": {
      const trunk = mesh(new THREE.CylinderGeometry(prop.sx * 0.22, prop.sx * 0.42, H * 0.92, 6), surf(mat(0x5a3b26, 0.95), "bark"));
      trunk.position.y = H * 0.46;
      group.add(trunk);
      const tiers = 5;
      for (let i = 0; i < tiers; i += 1) {
        const t = i / (tiers - 1);
        const rad = H * (0.26 - t * 0.17) * (0.9 + r() * 0.2);
        // Open-ended: no flat black disc under each tier.
        const cone = mesh(new THREE.ConeGeometry(rad, H * 0.3, 7, 1, true), mat(shade(base, (r() - 0.5) * 0.05), 0.95, { flatShading: true }));
        cone.position.y = H * (0.3 + t * 0.58);
        cone.rotation.y = r() * Math.PI;
        group.add(cone);
      }
      return;
    }
    case "maple":
    case "cherry": {
      const pink = prop.variant === "cherry";
      const trunkH = H * 0.42;
      const trunk = mesh(new THREE.CylinderGeometry(prop.sx * 0.3, prop.sx * 0.55, trunkH, 6), surf(mat(pink ? 0x4a3328 : 0x4b3426, 0.95), "bark"));
      trunk.position.y = trunkH / 2;
      trunk.rotation.z = (r() - 0.5) * 0.15;
      group.add(trunk);
      for (let i = 0; i < 2; i += 1) {
        const br = mesh(new THREE.CylinderGeometry(prop.sx * 0.12, prop.sx * 0.2, H * 0.3, 5), surf(mat(0x4b3426, 0.95), "bark"), false);
        const a = r() * Math.PI * 2;
        br.position.set(Math.cos(a) * H * 0.06, trunkH + H * 0.08, Math.sin(a) * H * 0.06);
        br.rotation.set(Math.sin(a) * 0.7, 0, -Math.cos(a) * 0.7);
        group.add(br);
      }
      // Wide umbrella canopy of leaf clumps.
      const clumps = 6;
      for (let i = 0; i < clumps; i += 1) {
        const a = (i / clumps) * Math.PI * 2 + r() * 0.6;
        const d = i === 0 ? 0 : H * (0.16 + r() * 0.12);
        const rad = H * (0.17 + r() * 0.07);
        const blob = mesh(new THREE.IcosahedronGeometry(rad, 0), mat(shade(base, (r() - 0.5) * 0.1, (r() - 0.5) * 0.1), 0.9, { flatShading: true }));
        blob.position.set(Math.cos(a) * d, trunkH + H * (0.22 + r() * 0.18) + (i === 0 ? H * 0.12 : 0), Math.sin(a) * d);
        blob.scale.y = 0.7;
        group.add(blob);
      }
      // Fallen leaves carpet.
      const carpet = mesh(new THREE.CircleGeometry(H * 0.42, 9), mat(shade(base, -0.06), 1, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), false);
      carpet.rotation.x = -Math.PI / 2;
      carpet.position.y = 0.03;
      group.add(carpet);
      return;
    }
    case "birch": {
      const trunk = mesh(new THREE.CylinderGeometry(prop.sx * 0.3, prop.sx * 0.45, H * 0.85, 6), surf(mat(0xd9d4c8, 0.8), "bark"));
      trunk.position.y = H * 0.42;
      group.add(trunk);
      for (let i = 0; i < 3; i += 1) {
        const blob = mesh(new THREE.IcosahedronGeometry(H * (0.13 - i * 0.02), 0), mat(shade(base, (r() - 0.5) * 0.08), 0.9, { flatShading: true }));
        blob.position.set((r() - 0.5) * 1.2, H * (0.55 + i * 0.15), (r() - 0.5) * 1.2);
        blob.scale.y = 1.5;
        group.add(blob);
      }
      return;
    }
    case "bamboo": {
      const stalks = 5 + Math.floor(r() * 4);
      const leafMat = mat(shade(base, 0.04), 0.85, { flatShading: true, side: THREE.DoubleSide });
      for (let i = 0; i < stalks; i += 1) {
        const h = H * (0.65 + r() * 0.35);
        const ox = (r() - 0.5) * prop.sx;
        const oz = (r() - 0.5) * prop.sz;
        const lean = (r() - 0.5) * 0.12;
        const stalk = mesh(new THREE.CylinderGeometry(0.06, 0.08, h, 5), mat(shade(base, (r() - 0.5) * 0.08), 0.6));
        stalk.position.set(ox + Math.sin(lean) * h * 0.5, h / 2, oz);
        stalk.rotation.z = -lean;
        group.add(stalk);
        // Leaf sprays near the top.
        for (let k = 0; k < 3; k += 1) {
          const leaf = mesh(new THREE.ConeGeometry(0.55, 1.6, 4, 1, true), leafMat, false);
          leaf.position.set(ox + Math.sin(lean) * h * (0.75 + k * 0.1), h * (0.72 + k * 0.1), oz);
          leaf.rotation.set(Math.PI / 2 + (r() - 0.5), r() * Math.PI * 2, (r() - 0.5));
          leaf.scale.set(1, 1, 0.25);
          group.add(leaf);
        }
      }
      return;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Japanese roofs
// ---------------------------------------------------------------------------

/**
 * Hip roof over a W x D footprint, height H: a ridge along the long axis, a
 * concave sweep down to the eaves and the corners curling up (irimoya style).
 */
export function hipRoofGeometry(W, D, H, upturn = 0.6, power = 1.5) {
  const along = W >= D;
  const a = (along ? W : D) / 2;
  const b = (along ? D : W) / 2;
  const ridge = Math.max(0, a - b * 0.8);
  const geo = new THREE.PlaneGeometry(W, D, 22, 16);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const u = along ? Math.abs(x) : Math.abs(z);
    const v = along ? Math.abs(z) : Math.abs(x);
    const du = Math.max(0, u - ridge) / (a - ridge || 1);
    const dv = v / b;
    const t = Math.min(1, Math.max(du, dv));
    let y = H * Math.pow(1 - t, power);
    y += upturn * Math.pow(Math.min(1, du), 3) * Math.pow(Math.min(1, dv), 3) * 1.6;
    y += upturn * 0.25 * Math.pow(t, 6);
    pos.setY(i, y);
  }
  geo.computeVertexNormals();
  return geo;
}

export function addHipRoof(scene, prop) {
  const g = new THREE.Group();
  const thatch = prop.style === "thatch";
  const western = prop.style === "western";
  const W = prop.sx;
  const D = prop.sz;
  const H = prop.sy;
  const roof = mesh(
    hipRoofGeometry(W, D, H, thatch ? 0.05 : western ? 0 : 0.75, thatch ? 1.15 : western ? 1 : 1.6),
    mat(prop.color, thatch ? 1 : 0.7, { side: THREE.DoubleSide, flatShading: thatch }),
  );
  g.add(roof);
  // Eave fascia: thin dark band just under the roof edge.
  const fascia = mesh(new THREE.BoxGeometry(W - 1.2, 0.35, D - 1.2), mat(0x3a2a1e, 0.9), false);
  fascia.position.y = -0.1;
  g.add(fascia);
  // Ridge cap + end tiles.
  const along = W >= D;
  const ridgeLen = Math.max(0.8, (along ? W - D * 0.8 : D - W * 0.8));
  const capMat = mat(thatch ? shade(prop.color, -0.12) : 0x2b2f35, 0.7);
  const cap = mesh(new THREE.BoxGeometry(along ? ridgeLen : 0.5, thatch ? 0.6 : 0.35, along ? 0.5 : ridgeLen), capMat);
  cap.position.y = H + 0.1;
  g.add(cap);
  if (!thatch && !western) {
    for (const s of [-1, 1]) {
      const oni = mesh(new THREE.BoxGeometry(0.5, 0.9, 0.5), capMat, false);
      oni.position.set(along ? (s * ridgeLen) / 2 : 0, H + 0.4, along ? 0 : (s * ridgeLen) / 2);
      g.add(oni);
    }
  }
  g.position.set(prop.x, prop.py || 0, prop.z);
  scene.add(g);
}

export function addPagoda(scene, prop) {
  const g = new THREE.Group();
  const tiers = prop.tiers || 5;
  const H = prop.sy;
  const tierH = (H - 6) / tiers;
  const wallMat = mat(0xe4dccb, 0.85);
  const woodMat = mat(prop.color || 0x8a3a26, 0.8);
  const roofMat = mat(0x2f343b, 0.65, { side: THREE.DoubleSide });
  let y = 0;
  for (let i = 0; i < tiers; i += 1) {
    const s = prop.sx * (1 - i * 0.11);
    const body = mesh(new THREE.BoxGeometry(s, tierH * 0.62, s), i === 0 ? wallMat : woodMat);
    body.position.y = y + tierH * 0.31;
    g.add(body);
    // Railing balcony on upper tiers.
    if (i > 0) {
      const bal = mesh(new THREE.BoxGeometry(s + 1.2, 0.25, s + 1.2), woodMat, false);
      bal.position.y = y + 0.1;
      g.add(bal);
    }
    const roofW = s + 5.5 - i * 0.3;
    const roof = mesh(hipRoofGeometry(roofW, roofW, tierH * 0.42, 0.8, 1.7), roofMat);
    roof.position.y = y + tierH * 0.6;
    g.add(roof);
    y += tierH;
  }
  // Sōrin spire with rings.
  const spire = mesh(new THREE.CylinderGeometry(0.12, 0.22, 6, 6), mat(0x7a6a3a, 0.4, { metalness: 0.6 }));
  spire.position.y = y + 3;
  g.add(spire);
  for (let k = 0; k < 7; k += 1) {
    const ring = mesh(new THREE.TorusGeometry(0.55 - k * 0.04, 0.08, 4, 10), mat(0x7a6a3a, 0.4, { metalness: 0.6 }), false);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = y + 0.8 + k * 0.6;
    g.add(ring);
  }
  g.position.set(prop.x, prop.py || 0, prop.z);
  scene.add(g);
}

export function addTorii(scene, prop) {
  const g = new THREE.Group();
  const scale = prop.sy / 5.2;
  const red = mat(prop.color || 0xc4402a, 0.6);
  const black = mat(0x1e1d1c, 0.7);
  const span = 4.4 * scale;
  for (const s of [-1, 1]) {
    const post = mesh(new THREE.CylinderGeometry(0.26 * scale, 0.32 * scale, 4.7 * scale, 10), red);
    post.position.set(s * span / 2, 2.35 * scale, 0);
    g.add(post);
    const foot = mesh(new THREE.CylinderGeometry(0.36 * scale, 0.36 * scale, 0.5 * scale, 10), black);
    foot.position.set(s * span / 2, 0.25 * scale, 0);
    g.add(foot);
  }
  const nuki = mesh(new THREE.BoxGeometry(span + 0.9 * scale, 0.32 * scale, 0.3 * scale), red);
  nuki.position.y = 3.75 * scale;
  g.add(nuki);
  // Kasagi: the top lintel curving up at both ends.
  const kasagi = new THREE.BoxGeometry(span + 2.6 * scale, 0.42 * scale, 0.6 * scale, 12, 1, 1);
  const pos = kasagi.attributes.position;
  const half = (span + 2.6 * scale) / 2;
  for (let i = 0; i < pos.count; i += 1) {
    const t = Math.abs(pos.getX(i)) / half;
    pos.setY(i, pos.getY(i) + Math.pow(t, 3) * 0.55 * scale);
  }
  kasagi.computeVertexNormals();
  const top = mesh(kasagi, black);
  top.position.y = 4.95 * scale;
  g.add(top);
  const under = mesh(new THREE.BoxGeometry(span + 1.8 * scale, 0.3 * scale, 0.5 * scale), red);
  under.position.y = 4.62 * scale;
  g.add(under);
  g.position.set(prop.x, 0, prop.z);
  g.rotation.y = prop.alongX ? Math.PI / 2 : 0;
  scene.add(g);
}

export function addStoneLantern(scene, prop) {
  const g = new THREE.Group();
  const stone = mat(prop.color || 0x8d8a82, 0.95, { flatShading: true });
  const parts = [
    [new THREE.CylinderGeometry(0.42, 0.5, 0.3, 6), 0.15],
    [new THREE.CylinderGeometry(0.16, 0.2, 0.8, 6), 0.7],
    [new THREE.CylinderGeometry(0.42, 0.3, 0.2, 6), 1.2],
    [new THREE.BoxGeometry(0.5, 0.42, 0.5), 1.51],
    [new THREE.ConeGeometry(0.62, 0.38, 6), 1.92],
    [new THREE.SphereGeometry(0.1, 6, 4), 2.15],
  ];
  for (const [geo, y] of parts) {
    const m = mesh(geo, stone);
    m.position.y = y;
    g.add(m);
  }
  const light = mesh(new THREE.BoxGeometry(0.3, 0.26, 0.52), mat(0xffc970, 1, { emissive: 0xffa640, emissiveIntensity: 0.9 }), false);
  light.position.y = 1.5;
  g.add(light);
  g.position.set(prop.x, 0, prop.z);
  scene.add(g);
}

// ---------------------------------------------------------------------------
// Rock: cliffs, cave walls/ceilings
// ---------------------------------------------------------------------------

function hash3(x, y, z) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/** Box with every surface vertex jittered: reads as fractured rock. */
function rockBox(w, h, d, jitter, seed) {
  const seg = (n) => Math.max(1, Math.min(14, Math.round(n / 6)));
  const geo = new THREE.BoxGeometry(w, h, d, seg(w), seg(h), seg(d));
  const pos = geo.attributes.position;
  // Shared positions must move together: key by rounded position.
  const moved = new Map();
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}`;
    let off = moved.get(key);
    if (!off) {
      const bottom = y < -h / 2 + 0.01;
      const k = bottom ? 0 : jitter;
      off = [
        (hash3(x + seed, y, z) - 0.5) * 2 * k,
        bottom ? 0 : (hash3(x, y + seed, z) - 0.5) * k * 1.4,
        (hash3(x, y, z + seed) - 0.5) * 2 * k,
      ];
      moved.set(key, off);
    }
    pos.setXYZ(i, x + off[0], y + off[1], z + off[2]);
  }
  return geo.toNonIndexed();
}

export function addRockMass(scene, prop) {
  const seed = (prop.x * 0.37 + prop.z * 0.11) % 97;
  const cave = prop.type !== "cliff";
  const jitter = cave ? 0.6 : Math.min(2.4, Math.min(prop.sx, prop.sz) * 0.08);
  const rock = mesh(rockBox(prop.sx, prop.sy, prop.sz, jitter, seed), surf(mat(prop.color, 0.95, { flatShading: true }), "rock"));
  rock.position.set(prop.x, (prop.py || 0) + prop.sy / 2, prop.z);
  scene.add(rock);
  if (prop.type === "cliff") {
    // Strata bands + mossy / grassy cap.
    const strata = mesh(rockBox(prop.sx + 0.6, prop.sy * 0.12, prop.sz + 0.6, 0.8, seed + 3), surf(mat(shade(prop.color, -0.06), 0.95, { flatShading: true }), "rock"), false);
    strata.position.set(prop.x, (prop.py || 0) + prop.sy * 0.38, prop.z);
    scene.add(strata);
    const cap = mesh(rockBox(prop.sx + 0.4, 1.2, prop.sz + 0.4, 0.7, seed + 7), surf(mat(0x4f6a36, 1, { flatShading: true }), "grass"), false);
    cap.position.set(prop.x, (prop.py || 0) + prop.sy - 0.2, prop.z);
    scene.add(cap);
  }
}

export function addCrystal(scene, prop) {
  const g = new THREE.Group();
  const r = rng(prop.id);
  const m = mat(prop.color, 0.2, { emissive: prop.color, emissiveIntensity: 1.6, transparent: true, opacity: 0.85 });
  for (let i = 0; i < 5; i += 1) {
    const h = prop.sy * (0.45 + r() * 0.55);
    const c = mesh(new THREE.OctahedronGeometry(0.3, 0), m, false);
    c.scale.set(prop.sx * 0.5, h, prop.sx * 0.5);
    c.position.set((r() - 0.5) * prop.sx, h * 0.45, (r() - 0.5) * prop.sz);
    c.rotation.set((r() - 0.5) * 0.6, r() * 3, (r() - 0.5) * 0.6);
    g.add(c);
  }
  g.position.set(prop.x, 0, prop.z);
  scene.add(g);
}

// ---------------------------------------------------------------------------
// Waterfall (animated shader — stays its own draw call)
// ---------------------------------------------------------------------------

export function addWaterfall(scene, prop) {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { time: { value: 0 } }]),
    vertexShader: `
      #include <fog_pars_vertex>
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec3 p = position;
        // Bulge out from the cliff as the water falls.
        p.z += pow(1.0 - uv.y, 1.6) * 3.0;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: `
      #include <common>
      #include <fog_pars_fragment>
      uniform float time;
      varying vec2 vUv;
      float h(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5453); }
      float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      void main() {
        vec2 uv = vec2(vUv.x * 7.0, vUv.y * 3.0 + time * 1.6);
        float streak = n(vec2(uv.x * 3.0, uv.y)) * 0.6 + n(vec2(uv.x * 9.0, uv.y * 2.3 + time)) * 0.4;
        vec3 deep = vec3(0.32, 0.5, 0.58);
        vec3 foam = vec3(0.93, 0.97, 1.0);
        vec3 col = mix(deep, foam, smoothstep(0.35, 0.8, streak));
        col = mix(col, foam, smoothstep(0.25, 0.0, vUv.y)); // white water at the bottom
        float edge = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x);
        gl_FragColor = vec4(col, (0.62 + 0.35 * streak) * edge);
        #include <tonemapping_fragment>
        #include <encodings_fragment>
        #include <fog_fragment>
      }
    `,
  });
  const geo = new THREE.PlaneGeometry(prop.sx, prop.sy, 6, 16);
  const fall = new THREE.Mesh(geo, material);
  fall.position.set(prop.x, prop.sy / 2, prop.z);
  fall.userData.dynamic = true;
  scene.add(fall);
  scene.userData.waterMaterials = scene.userData.waterMaterials || [];
  scene.userData.waterMaterials.push(material);

  // Mist at the plunge pool.
  const count = 160;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    pos[i * 3] = (Math.random() - 0.5) * prop.sx * 1.4;
    pos[i * 3 + 1] = Math.random() * 6;
    pos[i * 3 + 2] = 2 + Math.random() * 8;
  }
  const mg = new THREE.BufferGeometry();
  mg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mist = new THREE.Points(mg, new THREE.PointsMaterial({ color: 0xffffff, size: 2.6, transparent: true, opacity: 0.22, depthWrite: false }));
  mist.position.set(prop.x, 0, prop.z);
  mist.userData.dynamic = true;
  scene.add(mist);
}

// ---------------------------------------------------------------------------
// Farm / village props
// ---------------------------------------------------------------------------

export function addFarmProp(scene, prop) {
  const g = new THREE.Group();
  const wood = mat(0x6a4a2c, 0.9);
  switch (prop.type) {
    case "haystack": {
      const body = mesh(new THREE.CylinderGeometry(prop.sx * 0.42, prop.sx * 0.5, prop.sy * 0.6, 9), mat(prop.color, 1, { flatShading: true }));
      body.position.y = prop.sy * 0.3;
      const top = mesh(new THREE.ConeGeometry(prop.sx * 0.48, prop.sy * 0.55, 9), mat(shade(prop.color, -0.05), 1, { flatShading: true }));
      top.position.y = prop.sy * 0.85;
      g.add(body, top);
      break;
    }
    case "well": {
      const ring = mesh(new THREE.CylinderGeometry(prop.sx / 2, prop.sx / 2, prop.sy, 10, 1, true), mat(prop.color, 0.95, { side: THREE.DoubleSide }));
      ring.position.y = prop.sy / 2;
      const water = mesh(new THREE.CircleGeometry(prop.sx / 2 - 0.1, 10), mat(0x1f3d4a, 0.2), false);
      water.rotation.x = -Math.PI / 2;
      water.position.y = prop.sy * 0.5;
      g.add(ring, water);
      for (const s of [-1, 1]) {
        const post = mesh(new THREE.BoxGeometry(0.18, 2.4, 0.18), wood);
        post.position.set(s * prop.sx * 0.45, 1.2, 0);
        g.add(post);
      }
      const roof = mesh(hipRoofGeometry(prop.sx + 1, prop.sx * 0.9, 0.7, 0.2), mat(0x3b4048, 0.7, { side: THREE.DoubleSide }));
      roof.position.y = 2.4;
      g.add(roof);
      break;
    }
    case "cart": {
      const bed = mesh(new THREE.BoxGeometry(prop.sx, 0.5, prop.sz), wood);
      bed.position.y = 0.9;
      g.add(bed);
      for (const s of [-1, 1]) {
        const wheel = mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.12, 12), mat(0x4a3424, 0.9));
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(0, 0.6, s * (prop.sz / 2 + 0.08));
        g.add(wheel);
      }
      const shaft = mesh(new THREE.BoxGeometry(2.2, 0.1, 0.1), wood, false);
      shaft.position.set(prop.sx / 2 + 1, 0.8, 0);
      g.add(shaft);
      break;
    }
    case "woodpile": {
      const log = mat(0x7a5634, 0.95);
      for (let row = 0; row < 3; row += 1) {
        for (let i = 0; i < 4 - row; i += 1) {
          const l = mesh(new THREE.CylinderGeometry(0.16, 0.16, prop.sx, 6), log);
          l.rotation.z = Math.PI / 2;
          l.position.set(0, 0.16 + row * 0.28, (i - (3 - row) / 2) * 0.32);
          g.add(l);
        }
      }
      break;
    }
    case "scarecrow": {
      const post = mesh(new THREE.BoxGeometry(0.12, prop.sy, 0.12), wood);
      post.position.y = prop.sy / 2;
      const arms = mesh(new THREE.BoxGeometry(1.6, 0.1, 0.1), wood);
      arms.position.y = prop.sy * 0.7;
      const coat = mesh(new THREE.BoxGeometry(0.6, 0.8, 0.3), mat(0x5a6e8a, 1));
      coat.position.y = prop.sy * 0.62;
      const hat = mesh(new THREE.ConeGeometry(0.5, 0.3, 10), mat(0xc2a25a, 1));
      hat.position.y = prop.sy + 0.1;
      g.add(post, arms, coat, hat);
      break;
    }
    case "campfire": {
      const logs = mat(0x4a3020, 0.95);
      for (let i = 0; i < 4; i += 1) {
        const l = mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.2, 5), logs, false);
        l.rotation.set(Math.PI / 2 - 0.4, (i / 4) * Math.PI * 2, 0);
        l.position.y = 0.25;
        g.add(l);
      }
      const fire = mesh(new THREE.ConeGeometry(0.4, 0.9, 6), mat(0xffa040, 1, { emissive: 0xff7a1a, emissiveIntensity: 2 }), false);
      fire.position.y = 0.5;
      g.add(fire);
      break;
    }
    default:
      return false;
  }
  g.position.set(prop.x, prop.py || 0, prop.z);
  scene.add(g);
  return true;
}

// ---------------------------------------------------------------------------
// Terrain patches + instanced fields
// ---------------------------------------------------------------------------

export const COUNTRY_PATCH_LOOK = {
  dirtroad: { roughness: 1 },
  paddy: { roughness: 0.18, metalness: 0.1 }, // flooded: reflective
  pampas: { roughness: 1 },
  meadow: { roughness: 1 },
  cave: { roughness: 1 },
};

// Phones get sparser fields (the instanced grass is per-vertex sway work).
const LOW_END = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

function instancedField(scene, patches, { count, geo, color, sway, scaleMin, scaleMax, density }) {
  if (!patches.length) return;
  if (LOW_END) {
    count = Math.round(count * 0.4);
    density *= 0.4;
  }
  const area = patches.reduce((s, p) => s + p.sx * p.sz, 0);
  const n = Math.min(count, Math.floor(area * density));
  const material = patchSurface(new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true }), { sway, variation: 0.4 });
  const im = new THREE.InstancedMesh(geo, material, n);
  im.receiveShadow = true;
  const dummy = new THREE.Object3D();
  let placed = 0;
  for (const p of patches) {
    const share = Math.round((n * (p.sx * p.sz)) / area);
    for (let i = 0; i < share && placed < n; i += 1) {
      dummy.position.set(p.x + (Math.random() - 0.5) * p.sx, 0, p.z + (Math.random() - 0.5) * p.sz);
      dummy.rotation.set((Math.random() - 0.5) * 0.25, Math.random() * Math.PI, (Math.random() - 0.5) * 0.25);
      const s = scaleMin + Math.random() * (scaleMax - scaleMin);
      dummy.scale.set(s, s * (0.8 + Math.random() * 0.4), s);
      dummy.updateMatrix();
      im.setMatrixAt(placed, dummy.matrix);
      placed += 1;
    }
  }
  im.count = placed;
  im.instanceMatrix.needsUpdate = true;
  scene.add(im);
}

/** Golden pampas plumes and rice shoots in the paddies. */
export function addFields(scene, meta) {
  const patches = meta.terrainPatches || [];
  // Pampas: a fan of thin blades with soft feathery plumes leaning off them.
  const parts = [];
  for (let k = 0; k < 3; k += 1) {
    const a = (k / 3) * Math.PI * 2;
    const blade = new THREE.ConeGeometry(0.05, 1.4, 3);
    blade.translate(0, 0.7, 0);
    blade.rotateZ(Math.cos(a) * 0.22);
    blade.rotateX(Math.sin(a) * 0.22);
    parts.push(blade);
    const plume = new THREE.IcosahedronGeometry(0.16, 0);
    plume.scale(0.8, 3.0, 0.8);
    plume.rotateZ(Math.cos(a) * 0.35);
    plume.rotateX(Math.sin(a) * 0.35);
    plume.translate(Math.sin(-Math.cos(a) * 0.3) * 1.5, 1.75, Math.sin(Math.sin(a) * 0.3) * 1.5);
    parts.push(plume);
  }
  const pampasGeo = mergeGeos(parts);
  instancedField(scene, patches.filter((p) => p.type === "pampas"), {
    count: 14000, geo: pampasGeo, color: 0xe2cf9c, sway: 1.4, scaleMin: 0.8, scaleMax: 1.4, density: 0.1,
  });
  const rice = new THREE.ConeGeometry(0.14, 0.7, 4);
  rice.translate(0, 0.35, 0);
  instancedField(scene, patches.filter((p) => p.type === "paddy"), {
    count: 5000, geo: rice, color: 0x7fa64a, sway: 0.6, scaleMin: 0.8, scaleMax: 1.2, density: 0.28,
  });
}

function mergeGeos(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const total = parts.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  return out;
}
