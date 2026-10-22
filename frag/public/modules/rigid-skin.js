/**
 * Rigid skinning: turn a "jointed" model (a hierarchy of named joint groups
 * holding plain meshes) into ONE SkinnedMesh per material, with a Bone per
 * joint. Every vertex is weighted 100% to the joint it hung from, so the body
 * deforms exactly like the old group-per-limb rig — but costs a couple of
 * draw calls instead of one per limb per material.
 *
 *   const rig = buildRigidSkin(root, (o) => JOINTS.has(o.name));   // once per look
 *   const inst = instantiateRigidSkin(rig);                         // per character
 *   inst.bones.leftArm.rotation.x = -1.2;                           // animate as before
 *
 * three r128: skinned meshes need material.skinning = true, so materials are
 * cloned into skinning variants (cached).
 */

const skinningMats = new Map();
function skinningVariant(mat) {
  if (!skinningMats.has(mat.uuid)) {
    const m = mat.clone();
    m.skinning = true;
    skinningMats.set(mat.uuid, m);
  }
  return skinningMats.get(mat.uuid);
}

const _inv = new THREE.Matrix4();
const _m = new THREE.Matrix4();

export function buildRigidSkin(root, isJoint, { castShadow = true } = {}) {
  root.updateMatrixWorld(true);
  _inv.copy(root.matrixWorld).invert();

  // Bones mirror the joint hierarchy; bone 0 is the model root.
  const jointList = [root];
  root.traverse((o) => {
    if (o !== root && isJoint(o)) jointList.push(o);
  });
  const indexOf = new Map(jointList.map((j, i) => [j, i]));
  const bones = jointList.map((j, i) => {
    const b = new THREE.Bone();
    b.name = i === 0 ? "__root" : j.name;
    if (i > 0) {
      b.position.copy(j.position);
      b.quaternion.copy(j.quaternion);
      b.scale.copy(j.scale);
    }
    return b;
  });
  const parentJoint = (o) => {
    let p = o.parent;
    while (p && p !== root && !isJoint(p)) p = p.parent;
    return p || root;
  };
  for (let i = 1; i < jointList.length; i += 1) {
    const j = jointList[i];
    bones[indexOf.get(parentJoint(j))].add(bones[i]);
    // A joint nested under plain groups: fold their transform into the bone.
    let extra = j.parent;
    while (extra && extra !== root && !isJoint(extra)) {
      bones[i].applyMatrix4(new THREE.Matrix4().compose(extra.position, extra.quaternion, extra.scale));
      extra = extra.parent;
    }
  }
  bones[0].updateMatrixWorld(true);
  const boneInverses = bones.map((b) => new THREE.Matrix4().copy(b.matrixWorld).invert());

  // Bake every mesh into root space, tagged with its joint's bone index.
  const buckets = new Map();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const target = o.material.userData.mergeInto || o.material;
    const bone = indexOf.get(parentJoint(o));
    _m.multiplyMatrices(_inv, o.matrixWorld);
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    g.applyMatrix4(_m);
    if (!buckets.has(target.uuid)) buckets.set(target.uuid, { material: target, parts: [] });
    buckets.get(target.uuid).parts.push({ g, bone: bone ?? 0, color: o.material.color, cast: o.castShadow });
  });

  const meshes = [];
  for (const { material, parts } of buckets.values()) {
    const total = parts.reduce((n, p) => n + p.g.attributes.position.count, 0);
    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    const col = material.vertexColors ? new Float32Array(total * 3) : null;
    const si = new Uint16Array(total * 4);
    const sw = new Float32Array(total * 4);
    let v = 0;
    for (const p of parts) {
      const n = p.g.attributes.position.count;
      pos.set(p.g.attributes.position.array, v * 3);
      if (p.g.attributes.normal) nor.set(p.g.attributes.normal.array, v * 3);
      if (p.g.attributes.uv) uv.set(p.g.attributes.uv.array, v * 2);
      for (let i = 0; i < n; i += 1) {
        si[(v + i) * 4] = p.bone;
        sw[(v + i) * 4] = 1;
        if (col) {
          col[(v + i) * 3] = p.color ? p.color.r : 1;
          col[(v + i) * 3 + 1] = p.color ? p.color.g : 1;
          col[(v + i) * 3 + 2] = p.color ? p.color.b : 1;
        }
      }
      v += n;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    if (col) geometry.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geometry.setAttribute("skinIndex", new THREE.BufferAttribute(si, 4));
    geometry.setAttribute("skinWeight", new THREE.BufferAttribute(sw, 4));
    geometry.computeBoundingSphere();
    // Limbs swing past the bind pose; pad the cull sphere a little.
    geometry.boundingSphere.radius *= 1.25;
    meshes.push({
      geometry,
      material: skinningVariant(material),
      castShadow: castShadow && !material.transparent && parts.some((p) => p.cast !== false),
    });
  }
  return { bones, boneInverses, meshes };
}

/** A fresh, independently animated copy (shares geometry + materials). */
export function instantiateRigidSkin(rig) {
  const group = new THREE.Group();
  const rootBone = rig.bones[0].clone(true);
  group.add(rootBone);
  const byName = {};
  const list = [];
  rootBone.traverse((b) => {
    if (b.isBone) byName[b.name] = b;
  });
  for (const b of rig.bones) list.push(byName[b.name]);
  const skeleton = new THREE.Skeleton(list, rig.boneInverses);
  const meshes = [];
  for (const m of rig.meshes) {
    const mesh = new THREE.SkinnedMesh(m.geometry, m.material);
    mesh.castShadow = m.castShadow;
    mesh.receiveShadow = false;
    mesh.bind(skeleton, new THREE.Matrix4());
    group.add(mesh);
    meshes.push(mesh);
  }
  delete byName.__root;
  return { group, bones: byName, meshes };
}
