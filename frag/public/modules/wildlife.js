/**
 * Ambient wildlife: deer and horses grazing in the server-provided zones
 * (meta.wildlife), and flocks of birds wheeling over the map.
 *
 * Purely cosmetic and client-side (no network cost). Each species is ONE
 * InstancedMesh; legs / heads / wings are animated in the vertex shader from
 * a per-vertex "swing" attribute and a per-instance phase, so a whole herd
 * costs a single draw call. Animals graze, wander, and bolt away from players.
 */

import { WEATHER_UNIFORMS, patchSurface } from "./atmosphere.js";

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Geometry kit: boxes with color + swing attributes, merged.
// swing = (kind, sign, pivotY, pivotZ)
//   kind 1 = leg (rotates about X at the hip), 2 = neck/head (dips to graze),
//   kind 3 = wing (rotates about Z at the body), 0 = rigid.
// ---------------------------------------------------------------------------

function part(list, { size, at, color, swing = [0, 0, 0, 0], rotX = 0 }) {
  const g = new THREE.BoxGeometry(size[0], size[1], size[2]).toNonIndexed();
  if (rotX) g.rotateX(rotX);
  g.translate(at[0], at[1], at[2]);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const sw = new Float32Array(n * 4);
  const c = new THREE.Color(color);
  for (let i = 0; i < n; i += 1) {
    col.set([c.r, c.g, c.b], i * 3);
    sw.set(swing, i * 4);
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("swing", new THREE.BufferAttribute(sw, 4));
  list.push(g);
}

function merge(list) {
  const total = list.reduce((s, g) => s + g.attributes.position.count, 0);
  const out = new THREE.BufferGeometry();
  for (const [name, size] of [["position", 3], ["normal", 3], ["color", 3], ["swing", 4]]) {
    const arr = new Float32Array(total * size);
    let o = 0;
    for (const g of list) {
      arr.set(g.attributes[name].array, o);
      o += g.attributes[name].array.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  out.computeBoundingSphere();
  return out;
}

// Quadruped facing +Z. dims scale the template (deer ~1, horse ~1.4).
function quadruped({ len, bodyH, legH, color, dark, belly, neckColor, antlers = false, mane = null }) {
  const L = [];
  const hip = legH;
  part(L, { size: [len * 0.36, bodyH, len], at: [0, hip + bodyH / 2, 0], color });
  part(L, { size: [len * 0.3, bodyH * 0.3, len * 0.8], at: [0, hip + bodyH * 0.12, 0], color: belly });
  // Legs (front pair and back pair swing in opposition).
  const lx = len * 0.13;
  const lz = len * 0.38;
  for (const [x, z, sgn] of [[-lx, lz, 1], [lx, lz, -1], [-lx, -lz, -1], [lx, -lz, 1]]) {
    part(L, { size: [len * 0.08, legH, len * 0.08], at: [x, legH / 2, z], color: dark, swing: [1, sgn, hip, z] });
  }
  // Neck + head (dip together when grazing). Pivot at the shoulders.
  const sz = len * 0.5;
  const sy = hip + bodyH * 0.8;
  part(L, { size: [len * 0.16, len * 0.5, len * 0.18], at: [0, sy + len * 0.15, sz + len * 0.06], rotX: 0.5, color: neckColor || color, swing: [2, 1, sy, sz] });
  part(L, { size: [len * 0.17, len * 0.17, len * 0.34], at: [0, sy + len * 0.38, sz + len * 0.26], color: neckColor || color, swing: [2, 1, sy, sz] });
  part(L, { size: [len * 0.05, len * 0.12, len * 0.03], at: [-len * 0.07, sy + len * 0.5, sz + len * 0.16], color: dark, swing: [2, 1, sy, sz] });
  part(L, { size: [len * 0.05, len * 0.12, len * 0.03], at: [len * 0.07, sy + len * 0.5, sz + len * 0.16], color: dark, swing: [2, 1, sy, sz] });
  if (antlers) {
    for (const s of [-1, 1]) {
      part(L, { size: [0.04, 0.5, 0.04], at: [s * 0.1, sy + len * 0.62, sz + len * 0.16], color: 0xd8c8a8, swing: [2, 1, sy, sz] });
      part(L, { size: [0.25, 0.04, 0.04], at: [s * 0.2, sy + len * 0.78, sz + len * 0.16], color: 0xd8c8a8, swing: [2, 1, sy, sz] });
    }
  }
  if (mane) part(L, { size: [len * 0.05, len * 0.42, len * 0.14], at: [0, sy + len * 0.22, sz - len * 0.02], rotX: 0.5, color: mane, swing: [2, 1, sy, sz] });
  // Tail.
  part(L, { size: [len * 0.08, mane ? len * 0.4 : len * 0.12, len * 0.08], at: [0, hip + bodyH * (mane ? 0.45 : 0.85), -len * 0.52], color: mane || 0xf2efe8 });
  return merge(L);
}

function birdGeo() {
  const L = [];
  part(L, { size: [0.14, 0.12, 0.5], at: [0, 0, 0], color: 0x2b2d30 });
  part(L, { size: [0.08, 0.08, 0.16], at: [0, 0.03, 0.3], color: 0x2b2d30 });
  part(L, { size: [0.6, 0.02, 0.24], at: [-0.35, 0, 0], color: 0x34373b, swing: [3, 1, 0, 0] });
  part(L, { size: [0.6, 0.02, 0.24], at: [0.35, 0, 0], color: 0x34373b, swing: [3, -1, 0, 0] });
  part(L, { size: [0.18, 0.02, 0.18], at: [0, 0, -0.3], color: 0x2b2d30 });
  return merge(L);
}

// ---------------------------------------------------------------------------
// Material: rotate swing parts in the vertex shader.
// ---------------------------------------------------------------------------

function animatedMaterial() {
  const material = patchSurface(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }), { variation: 0.05, kind: "paint" });
  const base = material.onBeforeCompile;
  material.onBeforeCompile = (shader) => {
    base(shader);
    shader.uniforms.uTime = WEATHER_UNIFORMS.uTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec4 swing;
attribute vec4 anim; // phase, gait (0 idle .. 1 gallop), graze (0..1), flap rate
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
{
  float ph = anim.x;
  if (swing.x == 1.0) {
    float a = sin(ph) * swing.y * mix(0.08, 0.75, anim.y);
    vec3 pv = vec3(0.0, swing.z, swing.w);
    transformed = rotX(a) * (transformed - pv) + pv;
  } else if (swing.x == 2.0) {
    float a = anim.z * 1.15 + sin(ph * 0.5) * 0.06 * (1.0 - anim.z);
    vec3 pv = vec3(0.0, swing.z, swing.w);
    transformed = rotX(a) * (transformed - pv) + pv;
  } else if (swing.x == 3.0) {
    float a = sin(ph) * 0.9 * anim.w + 0.1;
    transformed = rotZ(a * swing.y) * transformed;
  }
}`,
      );
  };
  material.customProgramCacheKey = () => "wildlife";
  return material;
}

// ---------------------------------------------------------------------------

const SPECIES = {
  deer: {
    geo: () => quadruped({ len: 1.5, bodyH: 0.62, legH: 0.85, color: 0x9a6a3e, dark: 0x5a3e26, belly: 0xd9c4a4, antlers: true }),
    walk: 1.4,
    run: 11,
    fear: 22,
    stride: 7,
  },
  horse: {
    geo: () => quadruped({ len: 2.2, bodyH: 0.85, legH: 1.15, color: 0x6b4026, dark: 0x2e1f15, belly: 0x5e3822, mane: 0x1e1612 }),
    walk: 1.3,
    run: 9,
    fear: 12,
    stride: 4.5,
  },
};

class Herd {
  constructor(scene, kind, zones) {
    this.cfg = SPECIES[kind];
    this.animals = [];
    for (const z of zones) {
      for (let i = 0; i < z.count; i += 1) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.sqrt(Math.random()) * z.r;
        this.animals.push({
          zone: z,
          x: z.x + Math.cos(a) * d,
          z: z.z + Math.sin(a) * d,
          yaw: Math.random() * Math.PI * 2,
          speed: 0,
          state: "graze",
          timer: Math.random() * 6,
          phase: Math.random() * 10,
          graze: 1,
          scale: 0.9 + Math.random() * 0.2,
        });
      }
    }
    const n = this.animals.length;
    this.mesh = new THREE.InstancedMesh(this.cfg.geo(), animatedMaterial(), Math.max(1, n));
    this.mesh.count = n;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.userData.dynamic = true;
    this.anim = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 4), 4);
    this.anim.setUsage(THREE.DynamicDrawUsage);
    this.mesh.geometry.setAttribute("anim", this.anim);
    // Coat variation: each animal a little lighter / darker / warmer.
    const c = new THREE.Color();
    for (let i = 0; i < n; i += 1) {
      const l = 0.7 + Math.random() * 0.55;
      c.setRGB(l * (0.95 + Math.random() * 0.1), l, l * (0.9 + Math.random() * 0.1));
      this.mesh.setColorAt(i, c);
    }
    scene.add(this.mesh);
  }

  update(dt, threats, camPos) {
    const cfg = this.cfg;
    for (let i = 0; i < this.animals.length; i += 1) {
      const a = this.animals[i];
      // Animals far from the camera: freeze (keep pose) to save CPU.
      const far = Math.abs(a.x - camPos.x) + Math.abs(a.z - camPos.z) > 420;
      if (!far) {
        let fleeX = 0;
        let fleeZ = 0;
        for (const t of threats) {
          const dx = a.x - t.x;
          const dz = a.z - t.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < cfg.fear * cfg.fear) {
            const d = Math.sqrt(d2) || 1;
            fleeX += dx / d;
            fleeZ += dz / d;
          }
        }
        a.timer -= dt;
        if (fleeX || fleeZ) {
          a.state = "flee";
          a.timer = 2.5 + Math.random() * 2;
          a.targetYaw = Math.atan2(fleeX, fleeZ);
        } else if (a.timer <= 0) {
          if (a.state === "graze" || a.state === "flee") {
            a.state = "walk";
            a.timer = 3 + Math.random() * 6;
            // Wander, drifting back toward the herd's home.
            const hx = a.zone.x - a.x;
            const hz = a.zone.z - a.z;
            const home = Math.hypot(hx, hz) > a.zone.r * 0.8;
            a.targetYaw = home ? Math.atan2(hx, hz) + (Math.random() - 0.5) * 0.6 : Math.random() * Math.PI * 2;
          } else {
            a.state = "graze";
            a.timer = 4 + Math.random() * 9;
          }
        }
        const want = a.state === "flee" ? cfg.run : a.state === "walk" ? cfg.walk : 0;
        a.speed += (want - a.speed) * Math.min(1, dt * (a.state === "flee" ? 4 : 1.5));
        if (a.targetYaw !== undefined) {
          let d = a.targetYaw - a.yaw;
          d = Math.atan2(Math.sin(d), Math.cos(d));
          a.yaw += d * Math.min(1, dt * (a.state === "flee" ? 5 : 1.5));
        }
        a.x += Math.sin(a.yaw) * a.speed * dt;
        a.z += Math.cos(a.yaw) * a.speed * dt;
        // Don't stray too far from the zone even when spooked.
        const hx = a.x - a.zone.x;
        const hz = a.z - a.zone.z;
        const lim = a.zone.r * 1.9;
        const hd = Math.hypot(hx, hz);
        if (hd > lim) {
          a.x = a.zone.x + (hx / hd) * lim;
          a.z = a.zone.z + (hz / hd) * lim;
          a.targetYaw = Math.atan2(-hx, -hz);
        }
        a.graze += ((a.state === "graze" ? 1 : 0) - a.graze) * Math.min(1, dt * 2);
        a.phase += dt * (1.2 + a.speed * cfg.stride * 0.35);
      }
      const gait = Math.min(1, a.speed / cfg.run + (a.speed > 0.2 ? 0.25 : 0));
      // Gallop bounce.
      const bob = Math.abs(Math.sin(a.phase)) * gait * 0.12;
      _q.setFromAxisAngle(_up, a.yaw);
      _s.set(a.scale, a.scale, a.scale);
      _p.set(a.x, bob, a.z);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
      this.anim.setXYZW(i, a.phase, gait, a.graze, 0);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.anim.needsUpdate = true;
  }
}

class Flocks {
  constructor(scene, half) {
    this.birds = [];
    this.flocks = [];
    for (let f = 0; f < 6; f += 1) {
      const flock = {
        x: (Math.random() * 2 - 1) * half * 0.8,
        z: (Math.random() * 2 - 1) * half * 0.8,
        y: 35 + Math.random() * 40,
        r: 30 + Math.random() * 50,
        dir: Math.random() < 0.5 ? 1 : -1,
        vx: (Math.random() - 0.5) * 4,
        vz: (Math.random() - 0.5) * 4,
        half,
      };
      this.flocks.push(flock);
      const n = 7 + Math.floor(Math.random() * 7);
      for (let i = 0; i < n; i += 1) {
        this.birds.push({
          flock,
          a: Math.random() * Math.PI * 2,
          dr: (Math.random() - 0.5) * 14,
          dy: (Math.random() - 0.5) * 8,
          w: 0.35 + Math.random() * 0.2,
          phase: Math.random() * 10,
          glide: 0,
        });
      }
    }
    this.mesh = new THREE.InstancedMesh(birdGeo(), animatedMaterial(), this.birds.length);
    this.mesh.frustumCulled = false;
    this.mesh.userData.dynamic = true;
    this.anim = new THREE.InstancedBufferAttribute(new Float32Array(this.birds.length * 4), 4);
    this.anim.setUsage(THREE.DynamicDrawUsage);
    this.mesh.geometry.setAttribute("anim", this.anim);
    scene.add(this.mesh);
  }

  update(dt, storm) {
    for (const f of this.flocks) {
      f.x += f.vx * dt;
      f.z += f.vz * dt;
      if (Math.abs(f.x) > f.half * 0.9) f.vx = -f.vx;
      if (Math.abs(f.z) > f.half * 0.9) f.vz = -f.vz;
    }
    for (let i = 0; i < this.birds.length; i += 1) {
      const b = this.birds[i];
      const f = b.flock;
      b.a += dt * b.w * f.dir;
      const r = f.r + b.dr;
      const x = f.x + Math.cos(b.a) * r;
      const z = f.z + Math.sin(b.a) * r;
      const y = f.y + b.dy + Math.sin(b.a * 2 + b.phase) * 2 - storm * 15;
      // Flap in bursts, glide in between.
      b.glide = Math.sin(b.a * 3 + b.phase) > 0.2 ? 0.15 : 1;
      b.phase += dt * 11;
      const yaw = Math.atan2(-Math.sin(b.a) * f.dir, Math.cos(b.a) * f.dir) ;
      _q.setFromAxisAngle(_up, yaw);
      _s.set(1.6, 1.6, 1.6);
      _p.set(x, y, z);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
      this.anim.setXYZW(i, b.phase, 0, 0, b.glide);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.anim.needsUpdate = true;
  }
}

export class Wildlife {
  constructor(scene, meta) {
    const zones = meta.wildlife || [];
    this.herds = [];
    for (const kind of Object.keys(SPECIES)) {
      const z = zones.filter((w) => w.kind === kind);
      if (z.length) this.herds.push(new Herd(scene, kind, z));
    }
    this.flocks = new Flocks(scene, meta.worldHalfSize || 320);
    this.threats = [];
  }

  /** players: interpolated player list (positions spook the animals). */
  update(dt, camera, players = [], storm = 0) {
    this.threats.length = 0;
    for (const p of players) if (p.alive !== false) this.threats.push(p);
    for (const h of this.herds) h.update(dt, this.threats, camera.position);
    this.flocks.update(dt, storm);
  }
}
