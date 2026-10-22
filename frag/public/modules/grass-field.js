/**
 * Dense grass blades around the camera.
 *
 * A fixed grid of blade clumps (one instanced draw call) covers a disc around
 * the camera. Each clump snaps to the world grid cell nearest the camera, so
 * blades stay planted in the world as you move instead of swimming with you.
 * A top-down mask texture (painted from terrain patches and building
 * footprints) keeps grass off roads, water, floors and fields. Blades sway in
 * the wind, darken toward the root, get wet / snowed on like everything else.
 */

import { patchSurface, LOW_END } from "./atmosphere.js";

const NO_GRASS_PATCHES = new Set([
  "road", "sidewalk", "river", "lake", "sand", "dirt", "lot", "scorch", "dirtroad", "paddy", "pampas", "cave",
]);
const NO_GRASS_PROPS = new Set([
  "roof", "floor", "tower", "shop", "container", "bus", "truck", "gravelpile", "plane-fuselage", "plane-wing",
  "plane-tail", "scaffold", "cranemast", "cliff", "cavewall", "caveroof", "terrace", "stairs", "supertall", "wall",
  "pagoda", "well", "haystack", "rug",
]);

function paintMask(meta, half, size) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, size, size);
  const k = size / (half * 2);
  const rect = (x, z, sx, sz, pad = 0) => {
    g.fillRect((x - sx / 2 - pad + half) * k, (z - sz / 2 - pad + half) * k, (sx + pad * 2) * k, (sz + pad * 2) * k);
  };
  g.fillStyle = "#000";
  for (const p of meta.terrainPatches || []) if (NO_GRASS_PATCHES.has(p.type)) rect(p.x, p.z, p.sx, p.sz, 0.3);
  for (const p of meta.props || []) if (NO_GRASS_PROPS.has(p.type) && !(p.py > 1)) rect(p.x, p.z, p.sx, p.sz, 0.2);
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.LinearEncoding;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = false; // canvas row 0 = world z -half = v 0
  return tex;
}

function bladeClump(blades) {
  const pos = [];
  const col = [];
  const nor = [];
  const idx = [];
  const root = new THREE.Color(0x1a2c12);
  const tip = new THREE.Color(0x4e6a2a);
  let v = 0;
  for (let b = 0; b < blades; b += 1) {
    const a = Math.random() * Math.PI;
    const ox = (Math.random() - 0.5) * 0.45;
    const oz = (Math.random() - 0.5) * 0.45;
    const h = 0.2 + Math.random() * 0.22;
    const w = 0.035 + Math.random() * 0.02;
    const bend = (Math.random() - 0.5) * 0.25;
    const cs = Math.cos(a);
    const sn = Math.sin(a);
    // 5 verts: two rows + tip, bending forward with height.
    const rows = [
      [0, w],
      [0.55, w * 0.7],
      [1, 0],
    ];
    for (const [t, hw] of rows) {
      const y = t * h;
      const fwd = bend * t * t;
      const pts = hw > 0 ? [-hw, hw] : [0];
      for (const sx of pts) {
        pos.push(ox + cs * sx - sn * fwd, y, oz + sn * sx + cs * fwd);
        const c = root.clone().lerp(tip, t);
        col.push(c.r, c.g, c.b);
        nor.push(-sn * 0.3, 1, cs * 0.3);
      }
    }
    idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2, v + 2, v + 3, v + 4);
    v += 5;
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setIndex(idx);
  return geo;
}

export function createGrassField(scene, meta, renderer) {
  const gl = renderer.getContext();
  if (gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) < 1) return null; // no vertex textures
  const half = meta.worldHalfSize || 320;
  const R = LOW_END ? 22 : 40;
  const spacing = LOW_END ? 0.8 : 0.55;
  const n = Math.floor((R * 2) / spacing);
  const geo = bladeClump(LOW_END ? 4 : 5);
  const offs = new Float32Array(n * n * 2);
  let i = 0;
  for (let gx = 0; gx < n; gx += 1) {
    for (let gz = 0; gz < n; gz += 1) {
      offs[i++] = -R + gx * spacing;
      offs[i++] = -R + gz * spacing;
    }
  }
  geo.setAttribute("aCell", new THREE.InstancedBufferAttribute(offs, 2));
  geo.instanceCount = n * n;

  const uniforms = {
    uGrassCam: { value: new THREE.Vector3() },
    uMask: { value: paintMask(meta, half, 1024) },
    uHalf: { value: half },
    uRange: { value: R },
  };
  const material = patchSurface(
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }),
    { sway: 0.5, variation: 0.25, kind: "paint" },
  );
  const base = material.onBeforeCompile;
  material.onBeforeCompile = (shader) => {
    base(shader);
    Object.assign(shader.uniforms, uniforms);
    // Blades are lit as if facing up from both sides (no black backsides).
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <normal_fragment_begin>",
      `vec3 normal = normalize(vNormal);
vec3 geometryNormal = normal;`,
    );
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec2 aCell;
uniform vec3 uGrassCam;
uniform sampler2D uMask;
uniform float uHalf;
uniform float uRange;`,
      )
      .replace(
        "#include <color_vertex>",
        `#include <color_vertex>
// World cell for this clump: the copy of the grid point nearest the camera.
vec2 gSpan = vec2(uRange * 2.0);
vec2 gW = aCell + gSpan * floor((uGrassCam.xz - aCell) / gSpan + 0.5);
float gH1 = fract(sin(dot(gW, vec2(12.9898, 78.233))) * 43758.5453);
float gH2 = fract(sin(dot(gW, vec2(39.3468, 11.135))) * 24634.6345);
gW += (vec2(gH1, gH2) - 0.5) * 0.5;
float gMask = texture2D(uMask, (gW + uHalf) / (uHalf * 2.0)).r;
float gD = length(gW - uGrassCam.xz);
float gScale = gMask * (1.0 - smoothstep(uRange * 0.6, uRange * 0.98, gD)) * (0.6 + 0.55 * gH2);
gScale *= step(0.18, gH1 + (1.0 - smoothstep(0.0, uRange * 0.5, gD))); // thin out with distance
float gRot = gH1 * 6.2831;
#ifdef USE_COLOR
vColor *= 0.7 + 0.5 * gH2;
vColor = mix(vColor, vColor * vec3(1.25, 1.1, 0.6), smoothstep(0.55, 0.9, fract(gH1 * 7.31)) * 0.6);
#endif`,
      )
      .replace(
        "#include <begin_vertex>",
        `vec3 transformed = vec3(
  cos(gRot) * position.x - sin(gRot) * position.z,
  position.y,
  sin(gRot) * position.x + cos(gRot) * position.z) * gScale;
transformed.xz += gW;`,
      );
  };
  const prevKey = material.customProgramCacheKey;
  material.customProgramCacheKey = () => `grassfield|${prevKey()}`;

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.receiveShadow = !LOW_END;
  mesh.userData.dynamic = true;
  scene.add(mesh);
  return {
    mesh,
    off: false,
    update(camera) {
      uniforms.uGrassCam.value.copy(camera.position);
      // Nothing to draw from the sky (heli / plane) or deep in a vehicle cam.
      mesh.visible = !this.off && camera.position.y < 60;
    },
  };
}
