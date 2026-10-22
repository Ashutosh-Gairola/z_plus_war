/**
 * Small procedural geometry kit shared by the character and zombie models.
 */

/** Box with rounded edges/corners (same technique as three's RoundedBoxGeometry). */
export function roundedBox(w, h, d, r, seg = r >= 0.03 ? 2 : 1) {
  r = Math.max(0.0005, Math.min(r, w / 2 - 0.0005, h / 2 - 0.0005, d / 2 - 0.0005));
  const n = seg * 2 + 1;
  const geo = new THREE.BoxGeometry(1, 1, 1, n, n, n);
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const half = 0.5 / n;
  const inner = new THREE.Vector3(w / 2 - r, h / 2 - r, d / 2 - r);
  const v = new THREE.Vector3();
  const nv = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 1) {
    v.fromBufferAttribute(pos, i);
    nv.set(v.x - Math.sign(v.x) * half, v.y - Math.sign(v.y) * half, v.z - Math.sign(v.z) * half).normalize();
    pos.setXYZ(
      i,
      Math.sign(v.x) * inner.x + nv.x * r,
      Math.sign(v.y) * inner.y + nv.y * r,
      Math.sign(v.z) * inner.z + nv.z * r,
    );
    nor.setXYZ(i, nv.x, nv.y, nv.z);
  }
  return geo;
}

/**
 * Organic limb: lathe along -Y from the joint (y=0) to y=-length.
 * profile: [[t, radius], ...] with t in 0..1 from top to bottom.
 */
export function limbGeo(length, profile, segs = 14) {
  const pts = [];
  const last = profile[profile.length - 1];
  const first = profile[0];
  pts.push(new THREE.Vector2(0.0001, -length - last[1] * 0.35));
  pts.push(new THREE.Vector2(last[1] * 0.7, -length - last[1] * 0.25));
  for (let i = profile.length - 1; i >= 0; i -= 1) {
    pts.push(new THREE.Vector2(profile[i][1], -profile[i][0] * length));
  }
  pts.push(new THREE.Vector2(first[1] * 0.7, first[1] * 0.25));
  pts.push(new THREE.Vector2(0.0001, first[1] * 0.35));
  return new THREE.LatheGeometry(pts, segs);
}
