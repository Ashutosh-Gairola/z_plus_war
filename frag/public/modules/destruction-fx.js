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

const DEBRIS_CAP = 520;
const DEBRIS_LIFE = 45; // seconds settled chunks stay before fading
const COLLAPSE_SECONDS = 3.4;
const BOX = new THREE.BoxGeometry(1, 1, 1);
const DUST_GEO = new THREE.SphereGeometry(1, 8, 6);
const CHUNK_GEO = new THREE.IcosahedronGeometry(1, 0);

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
    for (const d of this.debris) this.scene.remove(d.mesh);
    this.debris = [];
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
    for (let i = 0; i < count; i += 1) {
      const size = minSize + Math.random() * (maxSize - minSize);
      const mesh = new THREE.Mesh(
        Math.random() < 0.6 ? BOX : CHUNK_GEO,
        this.mat(shade(def.color || 0x8a8378, 0.7 + Math.random() * 0.35).getHex()),
      );
      mesh.scale.set(size * (0.6 + Math.random()), size * (0.5 + Math.random() * 0.6), size * (0.6 + Math.random()));
      mesh.position.set(
        def.x + (Math.random() - 0.5) * def.sx,
        (def.py || 0) + Math.random() * def.sy,
        def.z + (Math.random() - 0.5) * def.sz,
      );
      mesh.castShadow = true;
      this.scene.add(mesh);
      const speed = 2 + Math.random() * 4;
      this.addDebris(mesh, new THREE.Vector3(
        ox * speed + (Math.random() - 0.5) * 3,
        1 + Math.random() * 3,
        oz * speed + (Math.random() - 0.5) * 3,
      ));
    }
  }

  addDebris(mesh, vel) {
    this.debris.push({
      mesh,
      vel,
      spin: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8),
      settled: false,
      age: 0,
    });
    if (this.debris.length > DEBRIS_CAP) {
      const old = this.debris.shift();
      this.scene.remove(old.mesh);
    }
  }

  dustBurst(x, y, z, spread, count, color = 0xa89f90, size = 1) {
    for (let i = 0; i < count; i += 1) {
      const m = new THREE.Mesh(
        DUST_GEO,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false }),
      );
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * spread;
      m.position.set(x + Math.cos(a) * r, y + Math.random() * 1.2, z + Math.sin(a) * r);
      m.scale.setScalar((0.6 + Math.random() * 0.8) * size);
      this.scene.add(m);
      this.dust.push({
        mesh: m,
        life: 0,
        max: 2.5 + Math.random() * 2,
        vel: new THREE.Vector3(Math.cos(a) * (1 + Math.random() * 2), 0.6 + Math.random() * 1.2, Math.sin(a) * (1 + Math.random() * 2)),
        grow: (1.2 + Math.random()) * size,
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
        d.mesh.position.addScaledVector(d.vel, dt);
        d.mesh.rotation.x += d.spin.x * dt;
        d.mesh.rotation.y += d.spin.y * dt;
        d.mesh.rotation.z += d.spin.z * dt;
        const floor = d.mesh.scale.y * 0.5;
        if (d.mesh.position.y <= floor) {
          d.mesh.position.y = floor;
          if (Math.abs(d.vel.y) < 1.5) {
            d.settled = true; // comes to rest and stays as rubble
          } else {
            d.vel.y *= -0.32;
            d.vel.x *= 0.55;
            d.vel.z *= 0.55;
            d.spin.multiplyScalar(0.5);
          }
        }
      } else if (d.age > DEBRIS_LIFE) {
        const k = 1 - Math.min(1, (d.age - DEBRIS_LIFE) / 2);
        d.mesh.scale.multiplyScalar(k > 0 ? 0.97 : 0);
        if (k <= 0) {
          this.scene.remove(d.mesh);
          this.debris.splice(i, 1);
        }
      }
    }

    for (let i = this.dust.length - 1; i >= 0; i -= 1) {
      const p = this.dust[i];
      p.life += dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(Math.exp(-dt * 1.2));
      p.mesh.scale.addScalar(p.grow * dt);
      p.mesh.material.opacity = 0.5 * (1 - easeOut(Math.min(1, p.life / p.max)));
      if (p.life >= p.max) {
        this.scene.remove(p.mesh);
        p.mesh.material.dispose();
        this.dust.splice(i, 1);
      }
    }
  }
}
