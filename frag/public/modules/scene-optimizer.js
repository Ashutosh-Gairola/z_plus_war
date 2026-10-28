/**
 * One-time draw-call reduction for the built world (frag + Z+).
 *
 * The city is ~1,450 props built as ~6,000 individual meshes, which made the
 * GPU spend each frame on draw calls (and again for the shadow pass). After
 * buildWorld this:
 *   - merges every static, non-building prop into spatial chunks (~80m cells,
 *     so frustum culling still drops off-screen areas), one mesh per
 *     material "look" per chunk, colors baked per vertex
 *   - merges each tree into ~2 meshes (trees still fall as a unit)
 *   - merges each building into a few meshes while remembering every prop's
 *     vertex range, so destruction can still hide / tint one wall panel or
 *     roof tile (see PropHandle) and lean / topple the building group.
 */

import { mergeStaticMeshes } from "./mesh-merge.js";
import { patchSurface } from "./atmosphere.js";

const CELL = 320;
// Floor-level pieces stay separate: they survive a collapse (destruction-fx).
const SURVIVOR_TYPES = new Set(["floor", "rug", "door-threshold"]);

// ---------------------------------------------------------------------------
// Material "looks": meshes that differ only by color share one vertex-colored
// material (per cast/receive-shadow combination).
// ---------------------------------------------------------------------------

const looks = new Map();
function lookFor(mat, cast, receive, tag = "") {
  if (!mat || Array.isArray(mat) || mat.map || mat.isShaderMaterial || mat.vertexColors) return null;
  let key;
  let make;
  const r1 = (v) => Math.round((v ?? 0) * 10) / 10;
  const q4 = (v) => Math.round((v ?? 0) * 4) / 4; // roughness/metalness buckets
  const glow = mat.emissive && mat.emissive.getHex() && (mat.emissiveIntensity ?? 1) > 0.05;
  if (mat.isMeshStandardMaterial) {
    // Surface kind (grass / road / rock / foliage / bark / wall...) travels on
    // the source material; trees default to foliage, everything else to wall.
    const surf = mat.userData.surface || {};
    const kind = surf.kind || (tag === "tree" ? "foliage" : mat.polygonOffset ? "grass" : "wall");
    key = [
      "std", q4(mat.roughness), q4(mat.metalness), mat.transparent, r1(mat.opacity), glow ? mat.emissive.getHex() : 0,
      glow ? r1(mat.emissiveIntensity) : 0, mat.side, mat.flatShading, mat.depthWrite, mat.polygonOffset,
      mat.polygonOffsetFactor, mat.polygonOffsetUnits, cast, receive, tag, kind,
    ].join(":");
    make = () =>
      // World surfaces: natural variation, wet shine, snow; foliage sways.
      patchSurface(new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: q4(mat.roughness),
        metalness: q4(mat.metalness),
        transparent: mat.transparent,
        opacity: mat.opacity,
        emissive: glow ? mat.emissive.clone() : new THREE.Color(0),
        emissiveIntensity: glow ? mat.emissiveIntensity : 1,
        side: mat.side,
        flatShading: mat.flatShading,
        depthWrite: mat.depthWrite,
        polygonOffset: mat.polygonOffset,
        polygonOffsetFactor: mat.polygonOffsetFactor,
        polygonOffsetUnits: mat.polygonOffsetUnits,
      }), tag === "tree"
        ? { sway: 9, variation: 0.3, kind }
        : { ground: surf.ground ?? mat.polygonOffset, variation: surf.variation ?? 0.22, kind });
  } else if (mat.isMeshBasicMaterial) {
    key = [
      "basic", mat.transparent, r1(mat.opacity), mat.blending, mat.side, mat.depthWrite, mat.polygonOffset,
      mat.polygonOffsetFactor, mat.polygonOffsetUnits, cast, receive,
    ].join(":");
    make = () =>
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: mat.transparent,
        opacity: mat.opacity,
        blending: mat.blending,
        side: mat.side,
        depthWrite: mat.depthWrite,
        polygonOffset: mat.polygonOffset,
        polygonOffsetFactor: mat.polygonOffsetFactor,
        polygonOffsetUnits: mat.polygonOffsetUnits,
      });
  } else {
    return null;
  }
  if (!looks.has(key)) {
    const m = make();
    m.userData.castShadow = cast;
    m.userData.receiveShadow = receive;
    looks.set(key, m);
  }
  return looks.get(key);
}

function mergeable(o) {
  return o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh && o.geometry?.attributes?.position && !Array.isArray(o.material);
}

/**
 * Point every mergeable mesh under root at its shared look (via
 * userData.mergeInto) and merge. Meshes whose material can't be shared merge
 * only with the same material.
 */
function mergeTree(root) {
  root.traverse((o) => {
    if (!mergeable(o)) return;
    const look = lookFor(o.material, o.castShadow, o.receiveShadow);
    // Per-mesh proxy carrying the color, merged into the shared look.
    if (look) {
      const proxy = new THREE.MeshBasicMaterial({ color: o.material.color.clone() });
      proxy.userData.mergeInto = look;
      o.material = proxy;
    } else {
      o.material.userData.castShadow = o.castShadow;
      o.material.userData.receiveShadow = o.receiveShadow;
    }
  });
  mergeStaticMeshes(root, { castShadow: true, receiveShadow: true });
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = o.material.userData.castShadow ?? o.castShadow;
    o.receiveShadow = o.material.userData.receiveShadow ?? o.receiveShadow;
  });
}

// ---------------------------------------------------------------------------
// Buildings: merged, with per-prop vertex ranges kept for destruction.
// ---------------------------------------------------------------------------

/**
 * Stand-in for a merged building prop. destruction-fx treats it like the old
 * holder group: `visible` hides/shows the prop's triangles, setTint() darkens
 * them.
 */
/**
 * Mark only [start, start+count) vertices of an attribute for GPU upload.
 * Uploading the whole merged building buffer for every broken panel was a
 * big hitch during destruction; ranges touched in the same frame merge into
 * one span (three uploads a single updateRange per attribute).
 */
function markRange(attr, start, count) {
  const off = start * attr.itemSize;
  const len = count * attr.itemSize;
  const r = attr.updateRange;
  // The renderer resets count to -1 after each upload: start a new span.
  if (r.count === -1) {
    r.offset = off;
    r.count = len;
  } else {
    const end = Math.max(r.offset + r.count, off + len);
    r.offset = Math.min(r.offset, off);
    r.count = end - r.offset;
  }
  attr.needsUpdate = true;
}

class PropHandle {
  constructor(parts) {
    this.parts = parts; // [{ mesh, start, count }]
    this._visible = true;
    this.userData = {};
  }

  get visible() {
    return this._visible;
  }

  set visible(v) {
    if (v === this._visible) return;
    this._visible = v;
    for (const { mesh, start, count } of this.parts) {
      const pos = mesh.geometry.attributes.position;
      const src = mesh.userData.basePositions;
      // Hidden = collapsed to a degenerate point (no triangles drawn).
      for (let i = start * 3; i < (start + count) * 3; i += 1) pos.array[i] = v ? src[i] : src[(start * 3) + (i % 3)];
      markRange(pos, start, count);
    }
  }

  setTint(f) {
    for (const { mesh, start, count } of this.parts) {
      const col = mesh.geometry.attributes.color;
      if (!col) continue;
      const src = mesh.userData.baseColors;
      for (let i = start * 3; i < (start + count) * 3; i += 1) col.array[i] = src[i] * f;
      markRange(col, start, count);
    }
  }

  traverse() {}
}

const _inv = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _c = new THREE.Color();

/**
 * Merge the meshes of several "items" into `container`, remembering each
 * item's vertex ranges so it can later be hidden / tinted on its own.
 * items: [{ id, root }]. Returns Map(id -> [{ mesh, start, count }]).
 */
function mergeRanged(container, items, tag = "") {
  container.updateMatrixWorld(true);
  _inv.copy(container.matrixWorld).invert();
  const buckets = new Map();
  const ranges = new Map();
  const merged = [];
  for (const { id, root } of items) {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!mergeable(o)) return;
      const look = lookFor(o.material, o.castShadow, o.receiveShadow, tag);
      if (!look) return; // textured / special: keep as-is
      _m.multiplyMatrices(_inv, o.matrixWorld);
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      g.applyMatrix4(_m);
      let b = buckets.get(look.uuid);
      if (!b) {
        b = { look, chunks: [], verts: 0 };
        buckets.set(look.uuid, b);
      }
      const count = g.attributes.position.count;
      b.chunks.push({ g, count, color: o.material.color });
      if (!ranges.has(id)) ranges.set(id, []);
      ranges.get(id).push({ bucket: b, start: b.verts, count });
      b.verts += count;
      merged.push(o);
    });
  }
  for (const o of merged) o.parent.remove(o);

  for (const b of buckets.values()) {
    const pos = new Float32Array(b.verts * 3);
    const nor = new Float32Array(b.verts * 3);
    const col = new Float32Array(b.verts * 3);
    let v = 0;
    for (const { g, count, color } of b.chunks) {
      pos.set(g.attributes.position.array, v * 3);
      if (g.attributes.normal) nor.set(g.attributes.normal.array, v * 3);
      _c.copy(color);
      for (let i = 0; i < count; i += 1) {
        col[(v + i) * 3] = _c.r;
        col[(v + i) * 3 + 1] = _c.g;
        col[(v + i) * 3 + 2] = _c.b;
      }
      v += count;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, b.look);
    mesh.castShadow = b.look.userData.castShadow;
    mesh.receiveShadow = b.look.userData.receiveShadow;
    mesh.userData.basePositions = pos.slice();
    mesh.userData.baseColors = col.slice();
    b.mesh = mesh;
    container.add(mesh);
  }
  const out = new Map();
  for (const [id, list] of ranges) out.set(id, list.map((r) => ({ mesh: r.bucket.mesh, start: r.start, count: r.count })));
  return out;
}

function mergeBuilding(bg, propMeshes) {
  const items = [];
  for (const holder of bg.children) {
    const propId = holder.userData.propId;
    if (!propId) continue;
    const def = holder.userData.def;
    if (def && SURVIVOR_TYPES.has(def.type)) continue;
    items.push({ id: propId, root: holder });
  }
  const propRanges = mergeRanged(bg, items);
  // Replace each merged prop's holder with a handle over its vertex ranges.
  for (const [propId, parts] of propRanges) {
    const holder = propMeshes.get(propId);
    const handle = new PropHandle(parts);
    handle.userData.propId = propId;
    // Anything that wasn't mergeable (textured bits) stays in the old holder.
    if (holder && holder.children.length) {
      handle.extra = holder;
    } else if (holder) {
      bg.remove(holder);
    }
    propMeshes.set(propId, handle);
  }
}

/**
 * Trees merge into their area's chunk. A detached clone stands by: when a tree
 * is felled the renderer calls userData.detach() — its triangles vanish from
 * the chunk and the clone takes its place to topple over.
 */
function mergeTrees(scene, propMeshes) {
  const cells = new Map();
  for (const [id, tree] of propMeshes) {
    if (tree instanceof PropHandle || !tree.isObject3D || tree.parent !== scene) continue;
    const key = `${Math.floor(tree.position.x / CELL)}:${Math.floor(tree.position.z / CELL)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push({ id, root: tree });
  }
  for (const [key, items] of cells) {
    const proxies = new Map(items.map(({ id, root }) => [id, root.clone()]));
    const cell = new THREE.Group();
    cell.name = `tree-cell-${key}`;
    scene.add(cell);
    const ranges = mergeRanged(cell, items, "tree");
    for (const { id, root } of items) {
      scene.remove(root);
      const proxy = proxies.get(id);
      const handle = new PropHandle(ranges.get(id) || []);
      proxy.userData.detach = () => {
        if (proxy.parent) return;
        handle.visible = false;
        scene.add(proxy);
      };
      proxy.userData.attach = () => {
        if (!proxy.parent) return;
        scene.remove(proxy);
        handle.visible = true;
      };
      propMeshes.set(id, proxy);
    }
  }
}

// Extra (unmerged) holder pieces follow the handle's visibility.
const baseVisible = Object.getOwnPropertyDescriptor(PropHandle.prototype, "visible");
Object.defineProperty(PropHandle.prototype, "visible", {
  get: baseVisible.get,
  set(v) {
    baseVisible.set.call(this, v);
    if (this.extra) this.extra.visible = v;
  },
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function optimizeStaticWorld(scene, skip = new Set()) {
  const ud = scene.userData;
  const propMeshes = ud.propMeshes || new Map();
  const buildingGroups = ud.buildingGroups || new Map();
  const propDefs = ud.propDefs || new Map();

  // Tag building holders with their prop def (survivor check needs the type).
  for (const bg of buildingGroups.values()) {
    for (const h of bg.children) if (h.userData.propId) h.userData.def = propDefs.get(h.userData.propId);
    mergeBuilding(bg, propMeshes);
  }

  // Trees: merged per area, with a stand-by clone for when one is felled.
  mergeTrees(scene, propMeshes);
  const keepWhole = new Set(buildingGroups.values());
  for (const c of scene.children) if (c.name?.startsWith("tree-cell-")) keepWhole.add(c);

  // Everything else that's static goes into spatial chunks.
  const cells = new Map();
  for (const child of [...scene.children]) {
    if (skip.has(child) || keepWhole.has(child) || child.isLight || child.name === "skyDome" || child.userData.dynamic) continue;
    if (child.isInstancedMesh || child.isPoints || child.isSprite) continue;
    let special = false;
    child.traverse((o) => {
      if (o.isLight || (o.material && o.material.isShaderMaterial) || o.isInstancedMesh) special = true;
    });
    if (special) continue;
    let hasMesh = false;
    child.traverse((o) => {
      if (o.isMesh) hasMesh = true;
    });
    if (!hasMesh) continue;
    const p = new THREE.Vector3();
    child.updateMatrixWorld(true);
    new THREE.Box3().setFromObject(child).getCenter(p);
    const key = `${Math.floor(p.x / CELL)}:${Math.floor(p.z / CELL)}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = new THREE.Group();
      cell.name = `static-cell-${key}`;
      cells.set(key, cell);
    }
    cell.attach(child); // keeps the world transform
  }
  for (const cell of cells.values()) {
    scene.add(cell);
    mergeTree(cell);
  }
}

export { PropHandle };
