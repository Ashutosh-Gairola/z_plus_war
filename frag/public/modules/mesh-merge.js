/**
 * Collapse static detail meshes into one mesh per (joint, material) so a
 * detailed model costs a few draw calls instead of dozens. Meshes are baked
 * into the space of their nearest joint ancestor (or the root), so animated
 * joints keep working. Mark a mesh or group with userData.noMerge to keep it.
 *
 * Materials carrying userData.mergeInto (a shared vertex-colored material)
 * collapse into that one material, their color baked per vertex — so many
 * flat-colored parts cost a single draw call per joint.
 */

const _inv = new THREE.Matrix4();
const _m = new THREE.Matrix4();

function hasNoMergeAncestor(obj, stop) {
  for (let o = obj; o && o !== stop; o = o.parent) if (o.userData.noMerge) return true;
  return false;
}

export function mergeStaticMeshes(root, { isJoint = () => false, castShadow = true, receiveShadow = false } = {}) {
  root.updateMatrixWorld(true);
  const buckets = new Map(); // joint -> Map(material.uuid -> { material, geos })
  const merged = [];

  root.traverse((obj) => {
    if (!obj.isMesh || hasNoMergeAncestor(obj, root)) return;
    let joint = obj.parent;
    while (joint !== root && !isJoint(joint)) joint = joint.parent;

    _inv.copy(joint.matrixWorld).invert();
    _m.multiplyMatrices(_inv, obj.matrixWorld);
    const src = obj.geometry.index ? obj.geometry.toNonIndexed() : obj.geometry.clone();
    src.applyMatrix4(_m);
    const count = src.attributes.position.count;
    const target = obj.material.userData.mergeInto || obj.material;
    const geo = {
      position: src.attributes.position.array,
      normal: src.attributes.normal ? src.attributes.normal.array : new Float32Array(count * 3),
      uv: src.attributes.uv ? src.attributes.uv.array : new Float32Array(count * 2),
      color: target.vertexColors ? obj.material.color : null,
      colorAttr: target.vertexColors && src.attributes.color ? src.attributes.color.array : null,
    };

    if (!buckets.has(joint)) buckets.set(joint, new Map());
    const byMat = buckets.get(joint);
    if (!byMat.has(target.uuid)) byMat.set(target.uuid, { material: target, geos: [] });
    byMat.get(target.uuid).geos.push(geo);
    merged.push(obj);
  });

  for (const obj of merged) obj.parent.remove(obj);

  for (const [joint, byMat] of buckets) {
    for (const { material, geos } of byMat.values()) {
      const total = geos.reduce((n, g) => n + g.position.length / 3, 0);
      const pos = new Float32Array(total * 3);
      const nor = new Float32Array(total * 3);
      const uv = new Float32Array(total * 2);
      const col = material.vertexColors ? new Float32Array(total * 3) : null;
      let v = 0;
      for (const g of geos) {
        const n = g.position.length / 3;
        pos.set(g.position, v * 3);
        nor.set(g.normal, v * 3);
        uv.set(g.uv, v * 2);
        if (col) {
          const c = g.color || { r: 1, g: 1, b: 1 };
          for (let i = 0; i < n; i += 1) {
            // Already vertex-colored sources keep their colors (tinted by the material color).
            const k = (v + i) * 3;
            const a = g.colorAttr;
            col[k] = c.r * (a ? a[i * 3] : 1);
            col[k + 1] = c.g * (a ? a[i * 3 + 1] : 1);
            col[k + 2] = c.b * (a ? a[i * 3 + 2] : 1);
          }
        }
        v += n;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
      geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      if (col) geometry.setAttribute("color", new THREE.BufferAttribute(col, 3));
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = castShadow && !material.transparent;
      mesh.receiveShadow = receiveShadow;
      joint.add(mesh);
    }
  }

  // Drop groups emptied by the merge (joints and named nodes stay).
  const prune = (node) => {
    for (const child of [...node.children]) {
      prune(child);
      if (!child.isMesh && child.children.length === 0 && !isJoint(child) && !child.name) node.remove(child);
    }
  };
  prune(root);
  return root;
}
