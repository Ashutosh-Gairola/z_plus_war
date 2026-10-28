/**
 * Client side of destructible buildings (server: structure-system.js).
 *
 * world-builder puts every building prop in its own holder group inside a
 * per-building group pivoted at the building's base, so this view can:
 *   - hide knocked-out wall panels and burst them into physical debris
 *   - darken cracked panels (damage stages)
 *   - lean an unstable building toward its broken side
 *   - play a collapse (tilt + drop + dust) and leave rubble mounds behind
 * apply() takes the server's structure payload; update() runs every frame.
 */

const DEBRIS_LIFE = 25; // seconds settled chunks stay before fading
const COLLAPSE_SECONDS = 3.4;
const BOX = new THREE.BoxGeometry(1, 1, 1);
const DUST_GEO = new THREE.SphereGeometry(1, 8, 6);
const CHUNK_GEO = new THREE.IcosahedronGeometry(1, 0);

// ---------------------------------------------------------------------------
// Pooled debris + dust. Every chunk used to be its own mesh (and every dust
// puff its own mesh + material): heavy destruction put hundreds of extra
// draw calls (doubled by the shadow pass) on screen and the game crawled.
// Now all debris renders through two InstancedMeshes and all dust through one
// Points cloud — a handful of draw calls no matter how much breaks.
// ---------------------------------------------------------------------------

const DEBRIS_SLOTS = 360; // per shape
const DUST_SLOTS = 700;
const _dm = new THREE.Matrix4();
const _dq = new THREE.Quaternion();
const _de = new THREE.Euler();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

class DebrisPool {
  constructor(scene) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.02, flatShading: true });
    this.meshes = [BOX, CHUNK_GEO].map((geo) => {
      const m = new THREE.InstancedMesh(geo, mat, DEBRIS_SLOTS);
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.userData.dynamic = true;
      for (let i = 0; i < DEBRIS_SLOTS; i += 1) {
        m.setMatrixAt(i, _zero);
        m.setColorAt(i, new THREE.Color(0x888888));
      }
      m.count = DEBRIS_SLOTS;
      scene.add(m);
      return m;
    });
    this.free = [Array.from({ length: DEBRIS_SLOTS }, (_, i) => DEBRIS_SLOTS - 1 - i), Array.from({ length: DEBRIS_SLOTS }, (_, i) => DEBRIS_SLOTS - 1 - i)];
    this.dirty = [false, false];
  }

  /** Take a slot (null when full — the caller recycles the oldest). */
  take(shape, color) {
    const slot = this.free[shape].pop();
    if (slot === undefined) return null;
    this.meshes[shape].setColorAt(slot, color);
    this.meshes[shape].instanceColor.needsUpdate = true;
    return slot;
  }

  release(shape, slot) {
    this.meshes[shape].setMatrixAt(slot, _zero);
    this.free[shape].push(slot);
    this.dirty[shape] = true;
  }

  write(d) {
    _de.set(d.rot.x, d.rot.y, d.rot.z);
    _dq.setFromEuler(_de);
    _dm.compose(d.pos, _dq, d.scale);
    this.meshes[d.shape].setMatrixAt(d.slot, _dm);
    this.dirty[d.shape] = true;
  }

  flush() {
    for (let k = 0; k < 2; k += 1) {
      if (!this.dirty[k]) continue;
      this.meshes[k].instanceMatrix.needsUpdate = true;
      this.dirty[k] = false;
    }
  }
}

class DustCloud {
  constructor(scene) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(DUST_SLOTS * 3);
    this.size = new Float32Array(DUST_SLOTS);
    this.alpha = new Float32Array(DUST_SLOTS);
    this.col = new Float32Array(DUST_SLOTS * 3);
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aColor", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.uniforms = { scale: { value: 500 } };
    this.points = new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        vertexShader: `
          attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
          uniform float scale; varying float vA; varying vec3 vC;
          void main() {
            vA = aAlpha; vC = aColor;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = aSize * scale / max(0.5, -mv.z);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          varying float vA; varying vec3 vC;
          void main() {
            if (vA <= 0.0) discard;
            float d = length(gl_PointCoord - 0.5);
            float a = (1.0 - smoothstep(0.2, 0.5, d)) * vA;
            gl_FragColor = vec4(vC, a);
            #include <encodings_fragment>
          }`,
      }),
    );
    this.points.frustumCulled = false;
    this.points.userData.dynamic = true;
    scene.add(this.points);
    this.cursor = 0;
  }

  /** Reuse the next slot (oldest dust gets overwritten when full). */
  slot() {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % DUST_SLOTS;
    return i;
  }
}

const easeIn = (t) => t * t;
const easeOut = (t) => 1 - (1 - t) * (1 - t);

function shade(hex, f) {
  return new THREE.Color(hex).multiplyScalar(f);
}

export class StructureView {
  constructor(scene, { onSound } = {}) {
    this.scene = scene;
    this.onSound = onSound || (() => {});
    this.version = 0;
    this.knownBroken = new Set();
    this.tinted = new Map(); // prop id -> stage applied
    this.buildings = new Map(); // id -> { state, lean:[x,z], leanNow:[x,z] }
    this.collapsing = []; // { id, t, axis, h }
    this.rubble = new Map(); // rubble id -> mesh group
    this.debris = [];
    this.dust = [];
    this.matCache = new Map();
    this.debrisPool = new DebrisPool(scene);
    this.dustCloud = new DustCloud(scene);
  }

  get props() {
    return this.scene.userData.propMeshes || new Map();
  }

  get propDefs() {
    return this.scene.userData.propDefs || new Map();
  }

  get groups() {
    return this.scene.userData.buildingGroups || new Map();
  }

  mat(color, rough = 0.9) {
    const key = `${color}:${rough}`;
    if (!this.matCache.has(key)) {
      this.matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.02, flatShading: true }));
    }
    return this.matCache.get(key);
  }

  // ---------------------------------------------------------------------------
  // Payload
  // ---------------------------------------------------------------------------

  apply(payload, { snap = false } = {}) {
    if (!payload) return;
    // A lower version or fewer broken pieces means the server reset the city.
    if (payload.v < this.version || (payload.broken || []).length < this.knownBroken.size) this.restoreAll();
    this.version = payload.v;

    for (const [id, state, lx, lz, agoMs] of payload.buildings || []) {
      let b = this.buildings.get(id);
      if (!b) {
        b = { state: "intact", lean: [0, 0], leanNow: [0, 0] };
        this.buildings.set(id, b);
      }
      b.lean = [lx, lz];
      if (state === "collapsed" && b.state !== "collapsed") {
        b.state = "collapsed";
        if (snap || agoMs > (COLLAPSE_SECONDS + 7) * 1000) this.finishCollapse(id);
        else this.startCollapse(id, b);
      } else if (state === "unstable" && b.state === "intact") {
        b.state = "unstable";
        if (!snap) {
          const g = this.groups.get(id);
          if (g) {
            this.onSound("creak", g.position);
            this.dustBurst(g.position.x, 0.5, g.position.z, g.userData.def.w * 0.5, 10, 0x9a9184);
          }
        }
      }
    }

    for (const id of payload.broken || []) {
      if (this.knownBroken.has(id)) continue;
      this.knownBroken.add(id);
      const holder = this.props.get(id);
      const def = this.propDefs.get(id);
      if (!holder) continue;
      const b = def?.buildingId ? this.buildings.get(def.buildingId) : null;
      if (b && b.state === "collapsed") continue; // the collapse handles it
      holder.visible = false;
      if (!snap && def) this.breakPanel(def);
    }

    for (const [id, stage] of payload.stages || []) this.tint(id, stage);

    for (const r of payload.rubble || []) {
      if (this.rubble.has(r.id)) continue;
      const mesh = this.buildRubble(r);
      const collapsing = this.collapsing.find((c) => c.id === r.buildingId);
      mesh.visible = !collapsing;
      if (collapsing) collapsing.rubble.push(mesh);
      this.scene.add(mesh);
      this.rubble.set(r.id, mesh);
    }
  }

  /** Darken a cracked panel (materials are cloned per panel on first hit). */
  tint(id, stage) {
    const holder = this.props.get(id);
    if (!holder || (this.tinted.get(id) || 0) === stage) return;
    this.tinted.set(id, stage);
    const f = stage >= 2 ? 0.55 : stage === 1 ? 0.78 : 1;
    if (holder.setTint) {
      holder.setTint(f); // merged building prop (scene-optimizer PropHandle)
    } else holder.traverse((o) => {
      if (!o.isMesh || !o.material || !o.material.color) return;
      if (!o.userData.baseColor) {
        o.material = o.material.clone();
        o.userData.baseColor = o.material.color.clone();
      }
      o.material.color.copy(o.userData.baseColor).multiplyScalar(f);
    });
    // Chips knocked off as it cracks.
    const def = this.propDefs.get(id);
    if (def && stage > 0) this.spawnChunks(def, 3, 0.12, 0.25);
  }

  restoreAll() {
    for (const id of this.knownBroken) {
      const h = this.props.get(id);
      if (h) h.visible = true;
    }
    for (const [id] of this.tinted) this.tint(id, 0);
    this.tinted.clear();
    for (const [, g] of this.groups) {
      g.visible = true;
      g.rotation.set(0, 0, 0);
      g.position.y = 0;
      for (const h of g.userData.survivors || []) g.add(h);
      g.userData.survivors = [];
    }
    for (const [, m] of this.rubble) this.scene.remove(m);
    this.rubble.clear();
    for (const d of this.debris) this.debrisPool.release(d.shape, d.slot);
    this.debris = [];
    this.debrisPool.flush();
    this.collapsing = [];
    this.knownBroken.clear();
    this.buildings.clear();
  }

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  breakPanel(def) {
    const vol = def.sx * def.sy * def.sz;
    this.spawnChunks(def, Math.min(16, 6 + Math.round(vol * 2)), 0.18, 0.55);
    this.dustBurst(def.x, (def.py || 0) + def.sy * 0.5, def.z, Math.max(def.sx, def.sz) * 0.5, 5, 0xb5aa98);
    this.onSound("break", new THREE.Vector3(def.x, (def.py || 0) + 1, def.z));
  }

  /** Physical chunks thrown from a prop's volume. */
  spawnChunks(def, count, minSize, maxSize) {
    const g = def.buildingId ? this.groups.get(def.buildingId) : null;
    const cx = g ? g.position.x : def.x;
    const cz = g ? g.position.z : def.z;
    // Throw outward, away from the building's middle.
    let ox = def.x - cx;
    let oz = def.z - cz;
    const ol = Math.hypot(ox, oz) || 1;
    ox /= ol;
    oz /= ol;
    const base = new THREE.Color(def.color || 0x8a8378);
    const c = new THREE.Color();
    for (let i = 0; i < count; i += 1) {
      const size = minSize + Math.random() * (maxSize - minSize);
      const shape = Math.random() < 0.6 ? 0 : 1;
      const speed = 2 + Math.random() * 4;
      this.addDebris(
        {
          shape,
          color: c.copy(base).multiplyScalar(0.7 + Math.random() * 0.35),
          pos: new THREE.Vector3(def.x + (Math.random() - 0.5) * def.sx, (def.py || 0) + Math.random() * def.sy, def.z + (Math.random() - 0.5) * def.sz),
          scale: new THREE.Vector3(size * (0.6 + Math.random()), size * (0.5 + Math.random() * 0.6), size * (0.6 + Math.random())),
        },
        new THREE.Vector3(ox * speed + (Math.random() - 0.5) * 3, 1 + Math.random() * 3, oz * speed + (Math.random() - 0.5) * 3),
      );
    }
  }

  addDebris(chunk, vel) {
    let slot = this.debrisPool.take(chunk.shape, chunk.color);
    if (slot === null) {
      // Pool full: recycle the oldest chunk of this shape.
      const k = this.debris.findIndex((d) => d.shape === chunk.shape);
      if (k < 0) return;
      const old = this.debris.splice(k, 1)[0];
      this.debrisPool.release(old.shape, old.slot);
      slot = this.debrisPool.take(chunk.shape, chunk.color);
      if (slot === null) return;
    }
    const d = {
      shape: chunk.shape,
      slot,
      pos: chunk.pos,
      scale: chunk.scale,
      rot: new THREE.Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6),
      vel,
      spin: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8),
      settled: false,
      age: 0,
    };
    this.debris.push(d);
    this.debrisPool.write(d);
  }

  dustBurst(x, y, z, spread, count, color = 0xa89f90, size = 1) {
    const c = new THREE.Color(color);
    const D = this.dustCloud;
    for (let i = 0; i < count; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * spread;
      const slot = D.slot();
      // Drop whatever older puff used this slot.
      const prev = this.dust.findIndex((p) => p.slot === slot);
      if (prev >= 0) this.dust.splice(prev, 1);
      D.col[slot * 3] = c.r;
      D.col[slot * 3 + 1] = c.g;
      D.col[slot * 3 + 2] = c.b;
      this.dust.push({
        slot,
        pos: new THREE.Vector3(x + Math.cos(a) * r, y + Math.random() * 1.2, z + Math.sin(a) * r),
        size: (0.6 + Math.random() * 0.8) * size * 2,
        life: 0,
        max: 2.5 + Math.random() * 2,
        vel: new THREE.Vector3(Math.cos(a) * (1 + Math.random() * 2), 0.6 + Math.random() * 1.2, Math.sin(a) * (1 + Math.random() * 2)),
        grow: (1.2 + Math.random()) * size * 2,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Collapse
  // ---------------------------------------------------------------------------

  /** Pull floor-level pieces (that survive) out so they don't fall with it. */
  detachSurvivors(g) {
    g.userData.survivors = [];
    for (const holder of [...g.children]) {
      const def = this.propDefs.get(holder.userData.propId);
      if (def && (def.type === "floor" || def.type === "rug" || def.type === "door-threshold")) {
        g.remove(holder);
        holder.position.set(0, 0, 0); // its meshes are in world space
        this.scene.add(holder);
        g.userData.survivors.push(holder);
      }
    }
  }

  startCollapse(id, b) {
    const g = this.groups.get(id);
    if (!g) return;
    this.detachSurvivors(g);
    const [lx, lz] = b.lean;
    const len = Math.hypot(lx, lz) || 1;
    // Tip over toward the lean: rotate about the horizontal axis perpendicular to it.
    const axis = new THREE.Vector3(lz / len, 0, -lx / len);
    const def = g.userData.def;
    // Taller buildings take longer to come down (a supertall pancakes for ~9s).
    const duration = COLLAPSE_SECONDS + Math.max(0, def.h - 20) / 28;
    this.collapsing.push({ id, t: 0, duration, axis, h: def.h, def, q0: g.quaternion.clone(), rubble: [], dustTimer: 0 });
    this.onSound("collapse", g.position);
  }

  finishCollapse(id) {
    const g = this.groups.get(id);
    if (!g) return;
    if (!g.userData.survivors) this.detachSurvivors(g);
    g.visible = false;
    g.userData.gone = true; // (distance culling must not bring it back)
  }

  updateCollapses(dt) {
    for (let i = this.collapsing.length - 1; i >= 0; i -= 1) {
      const c = this.collapsing[i];
      const g = this.groups.get(c.id);
      c.t += dt / c.duration;
      const t = Math.min(1, c.t);
      if (g) {
        // Shudder, then tip and drop into the ground with gravity-like ease.
        const shake = t < 0.18 ? Math.sin(t * 120) * 0.012 : 0;
        const tip = easeIn(Math.max(0, (t - 0.08) / 0.92)) * (c.h > 60 ? 0.12 : c.h > 10 ? 0.32 : 0.5);
        g.quaternion.copy(c.q0).multiply(new THREE.Quaternion().setFromAxisAngle(c.axis, tip + shake));
        g.position.y = -easeIn(Math.max(0, (t - 0.12) / 0.88)) * c.h * 1.05;
      }
      // Dust boils out of the base the whole way down.
      c.dustTimer -= dt;
      if (c.dustTimer <= 0 && t < 0.92) {
        c.dustTimer = 0.12;
        const big = c.h > 60 ? 4 : c.h > 10 ? 1.8 : 1.1;
        this.dustBurst(c.def.x, 0.6, c.def.z, Math.max(c.def.w, c.def.d) * 0.55, 6, 0x9d9486, big);
        if (Math.random() < 0.7) {
          this.spawnChunks(
            { x: c.def.x, z: c.def.z, sx: c.def.w, sz: c.def.d, sy: Math.min(8, c.h), py: 0, color: c.def.color, buildingId: c.id },
            5,
            0.3,
            c.h > 10 ? 1.2 : 0.7,
          );
        }
      }
      if (t > 0.55) for (const r of c.rubble) r.visible = true;
      if (t >= 1) {
        if (g) g.visible = false;
        for (const r of c.rubble) r.visible = true;
        this.dustBurst(c.def.x, 1.5, c.def.z, Math.max(c.def.w, c.def.d) * (c.h > 60 ? 1.6 : 0.7), c.h > 60 ? 40 : 18, 0xa39a8a, c.h > 60 ? 5 : c.h > 10 ? 2.4 : 1.4);
        this.collapsing.splice(i, 1);
      }
    }
  }

  /** Rubble mound: a heap of slabs, blocks and rebar inside the given box. */
  buildRubble(r) {
    const g = new THREE.Group();
    g.position.set(r.x, 0, r.z);
    const pieces = Math.min(26, 8 + Math.round(r.sx * r.sz * 0.12));
    for (let i = 0; i < pieces; i += 1) {
      const u = (Math.random() - 0.5) * 2;
      const v = (Math.random() - 0.5) * 2;
      const falloff = 1 - Math.max(Math.abs(u), Math.abs(v)) * 0.65; // higher in the middle
      const slab = Math.random() < 0.35;
      const w = slab ? r.sx * (0.3 + Math.random() * 0.3) : 0.6 + Math.random() * Math.min(2.2, r.sx * 0.3);
      const d = slab ? r.sz * (0.25 + Math.random() * 0.3) : 0.6 + Math.random() * Math.min(2.2, r.sz * 0.3);
      const h = slab ? 0.25 + Math.random() * 0.3 : 0.4 + Math.random() * r.sy * 0.5;
      const mesh = new THREE.Mesh(
        slab || Math.random() < 0.5 ? BOX : CHUNK_GEO,
        this.mat(shade(Math.random() < 0.3 ? 0x8d8a84 : r.color || 0x8a8378, 0.6 + Math.random() * 0.35).getHex()),
      );
      mesh.scale.set(w, h, d);
      mesh.position.set((u * r.sx) / 2, Math.max(h / 2, falloff * r.sy * (0.4 + Math.random() * 0.6) - h / 2), (v * r.sz) / 2);
      mesh.rotation.set((Math.random() - 0.5) * 0.9, Math.random() * Math.PI, (Math.random() - 0.5) * 0.9);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
    }
    // Twisted rebar sticking out.
    const rebar = this.mat(0x3a2e26, 0.6);
    for (let i = 0; i < 5; i += 1) {
      const bar = new THREE.Mesh(BOX, rebar);
      const len = 1 + Math.random() * 2;
      bar.scale.set(0.05, len, 0.05);
      bar.position.set((Math.random() - 0.5) * r.sx * 0.7, r.sy * 0.5 + len * 0.3, (Math.random() - 0.5) * r.sz * 0.7);
      bar.rotation.set((Math.random() - 0.5) * 1.6, 0, (Math.random() - 0.5) * 1.6);
      g.add(bar);
    }
    return g;
  }

  // ---------------------------------------------------------------------------
  // Frame update
  // ---------------------------------------------------------------------------

  update(dt) {
    if (!dt) return;
    // Unstable buildings ease into their lean (and creak back and forth a hair).
    const t = performance.now() * 0.001;
    for (const [id, b] of this.buildings) {
      if (b.state !== "unstable") continue;
      const g = this.groups.get(id);
      if (!g) continue;
      const sway = Math.sin(t * 1.3 + g.position.x) * 0.004;
      b.leanNow[0] += (b.lean[0] - b.leanNow[0]) * Math.min(1, dt * 0.8);
      b.leanNow[1] += (b.lean[1] - b.leanNow[1]) * Math.min(1, dt * 0.8);
      // Lean toward +x tips the top toward +x: rotate -z about Z, +x about X for +z.
      g.rotation.set(b.leanNow[1] + sway, 0, -b.leanNow[0] - sway);
      if (Math.random() < dt * 0.4) {
        // Bits keep falling off a building that's about to go.
        const def = g.userData.def;
        this.spawnChunks({ x: def.x, z: def.z, sx: def.w, sz: def.d, sy: Math.min(def.h, 8), py: 0, color: def.color, buildingId: id }, 2, 0.15, 0.35);
      }
    }

    this.updateCollapses(dt);

    for (let i = this.debris.length - 1; i >= 0; i -= 1) {
      const d = this.debris[i];
      d.age += dt;
      if (!d.settled) {
        d.vel.y -= 18 * dt;
        d.pos.addScaledVector(d.vel, dt);
        d.rot.addScaledVector(d.spin, dt);
        const floor = d.scale.y * 0.5;
        if (d.pos.y <= floor) {
          d.pos.y = floor;
          if (Math.abs(d.vel.y) < 1.5) {
            d.settled = true; // comes to rest and stays as rubble
          } else {
            d.vel.y *= -0.32;
            d.vel.x *= 0.55;
            d.vel.z *= 0.55;
            d.spin.multiplyScalar(0.5);
          }
        }
        this.debrisPool.write(d);
      } else if (d.age > DEBRIS_LIFE) {
        const k = 1 - Math.min(1, (d.age - DEBRIS_LIFE) / 2);
        d.scale.multiplyScalar(k > 0 ? 0.97 : 0);
        if (k <= 0) {
          this.debrisPool.release(d.shape, d.slot);
          this.debris.splice(i, 1);
        } else this.debrisPool.write(d);
      }
    }
    this.debrisPool.flush();

    const D = this.dustCloud;
    for (let i = this.dust.length - 1; i >= 0; i -= 1) {
      const p = this.dust[i];
      p.life += dt;
      p.pos.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(Math.exp(-dt * 1.2));
      p.size += p.grow * dt;
      const k = p.slot;
      D.pos[k * 3] = p.pos.x;
      D.pos[k * 3 + 1] = p.pos.y;
      D.pos[k * 3 + 2] = p.pos.z;
      D.size[k] = p.size;
      D.alpha[k] = 0.5 * (1 - easeOut(Math.min(1, p.life / p.max)));
      if (p.life >= p.max) {
        D.alpha[k] = 0;
        this.dust.splice(i, 1);
      }
    }
    D.uniforms.scale.value = (window.innerHeight || 600) * 0.5;
    for (const key of ["position", "aSize", "aAlpha", "aColor"]) D.geo.attributes[key].needsUpdate = true;
  }
}
