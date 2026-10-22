import { buildRifleBullet, RifleBulletProps } from "../assets/weapons/rifle/bullet.js";
import { buildSMGBullet, SMGBulletProps } from "../assets/weapons/smg/bullet.js";
import { buildSniperBullet, SniperBulletProps } from "../assets/weapons/sniper/bullet.js";
import { LOOT_BULLETS } from "../assets/weapons/loot/bullets.js";
/**
 * Visual effects for bullets and tracers
 * Handles bullet trails and impact effects
 */

import { clamp01 } from "./utils.js";

const MAX_DECAL_AGE = 15000;
const IMPACT_MARK_GEO = new THREE.PlaneGeometry(0.24, 0.24);
const IMPACT_MARK_MAT = new THREE.MeshBasicMaterial({
  color: 0x000000,
  transparent: true,
  opacity: 0.9,
  depthWrite: false, // Prevent flickering
  polygonOffset: true,
  polygonOffsetFactor: -1,
});

/**
 * Spawn a tracer line for a bullet shot
 */
export function spawnTracer(scene, shot) {
  const from = new THREE.Vector3(shot.ox, shot.oy, shot.oz);
  const dir = new THREE.Vector3(shot.dx, shot.dy, shot.dz).normalize();

  const to = new THREE.Vector3(
    shot.ox + shot.dx * shot.distance,
    shot.oy + shot.dy * shot.distance,
    shot.oz + shot.dz * shot.distance
  );

  const group = new THREE.Group();

  // 2. Determine Bullet Type
  let bulletModel = null;
  let props = RifleBulletProps;

  const loot = LOOT_BULLETS[shot.weapon];
  if (loot) {
    props = { sparkCount: 6, smoke: true, ...loot.props };
    // Live projectiles were already drawn in flight; only the impact remains.
    bulletModel = props.live ? new THREE.Group() : loot.build();
  } else if (shot.weapon === "smg") {
    bulletModel = buildSMGBullet();
    props = SMGBulletProps;
  } else if (shot.weapon === "sniper") {
    bulletModel = buildSniperBullet();
    props = SniperBulletProps;
  } else {
    bulletModel = buildRifleBullet();
    props = RifleBulletProps;
  }

  // Orient bullet correctly: +Z is forward
  const lookTarget = to.clone();
  bulletModel.position.copy(from);
  bulletModel.lookAt(lookTarget);

  group.add(bulletModel);

  // 3. Immediate Impact Visual - sparks, smoke, and body-hit feedback.
  const sparks = [];
  if (shot.distance < 1000) {
    const sparkMat = new THREE.MeshBasicMaterial({
      color: shot.hitPlayerId ? (shot.hitPart === "head" ? 0xffd45a : 0x9f1e1e) : props.sparkColor,
      transparent: true,
      opacity: 1.0
    });
    const sparkCount = props.sparkCount ?? 6;
    for (let i = 0; i < sparkCount; i++) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), sparkMat.clone());
      s.position.copy(to);
      s.userData.velocity = new THREE.Vector3(
        (Math.random() - 0.5) * 6,
        (Math.random()) * 6,
        (Math.random() - 0.5) * 6
      );
      group.add(s);
      sparks.push(s);
    }

    const smokeMat = new THREE.MeshBasicMaterial({
      color: 0xb8bec4,
      transparent: true,
      opacity: shot.hitPlayerId ? 0.18 : 0.32,
      depthWrite: false,
    });
    for (let i = 0; i < (props.smoke === false ? 0 : 4); i += 1) {
      const smoke = new THREE.Mesh(new THREE.SphereGeometry(0.08 + Math.random() * 0.05, 8, 6), smokeMat.clone());
      smoke.position.copy(to);
      smoke.userData.velocity = new THREE.Vector3(
        (Math.random() - 0.5) * 1.2,
        0.35 + Math.random() * 0.7,
        (Math.random() - 0.5) * 1.2
      );
      group.add(smoke);
      sparks.push(smoke);
    }
  }

  // 4. Immediate Persistence Mark (Decal)
  let mark = null;
  if (shot.distance < 1000 && !props.noMark) {
    const markMat = IMPACT_MARK_MAT.clone();
    if (shot.hitPlayerId) {
      markMat.color.set(shot.hitPart === "head" || shot.hitPart === "neck" ? 0x7d1212 : 0x4f1515);
      markMat.opacity = 0.72;
    }
    mark = new THREE.Mesh(IMPACT_MARK_GEO, markMat);
    mark.position.copy(to);
    mark.lookAt(from);
    mark.position.addScaledVector(dir, -0.02);
    mark.rotation.z = Math.random() * Math.PI * 2;
    scene.add(mark);
    mark.userData.bornAt = Date.now();
  }

  scene.add(group);

  const travelDuration = props.live ? 20 : (shot.distance / props.speed) * 1000;

  return {
    group,
    bulletModel,
    sparks,
    mark,
    from,
    to,
    travelDuration: Math.max(20, travelDuration),
    bornAt: performance.now()
  };
}

/**
 * Update and remove old tracers
 */
export function updateTracers(scene, tracers) {
  const now = performance.now();
  const time = Date.now();

  for (let i = tracers.length - 1; i >= 0; i -= 1) {
    const t = tracers[i];
    const age = now - t.bornAt;

    // Projectile Movement
    const travelProgress = clamp01(age / t.travelDuration);
    t.bulletModel.position.lerpVectors(t.from, t.to, travelProgress);

    // Fade out (happens after travel finishes)
    const fadeAge = age - t.travelDuration;
    const fade = 1 - clamp01(fadeAge / 150);

    if (age > t.travelDuration) {
      t.bulletModel.traverse(child => {
        if (child.material) child.material.opacity = fade * 0.8;
      });
      t.bulletModel.scale.setScalar(fade);
    }

    // Animate sparks
    t.sparks.forEach(s => {
      s.position.addScaledVector(s.userData.velocity, 0.016);
      s.userData.velocity.y -= 0.2; // gravity
      s.material.opacity = fade;
    });

    // Cleanup when vanished
    if (age >= t.travelDuration + 150) {
      scene.remove(t.group);
      t.bulletModel.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
      tracers.splice(i, 1);
    }
  }

  // Prune old impact marks
  scene.children.forEach(child => {
    if (child.userData && child.userData.bornAt) {
      const age = time - child.userData.bornAt;
      if (age > MAX_DECAL_AGE) {
        scene.remove(child);
        if (child.material) child.material.dispose();
        if (child.geometry) child.geometry.dispose();
      } else if (age > MAX_DECAL_AGE - 2000) {
        child.material.opacity = 0.9 * (1 - (age - (MAX_DECAL_AGE - 2000)) / 2000);
      }
    }
  });
}

/**
 * Draw slow projectiles (Contra orbs, rockets) for their whole flight from the
 * snapshot bullet list. live: Map(id -> mesh), kept by the caller.
 */
export function updateLiveProjectiles(scene, live, bullets, dt) {
  const seen = new Set();
  for (const b of bullets || []) {
    const def = LOOT_BULLETS[b.weapon];
    if (!def || !def.props.live) continue;
    seen.add(b.id);
    let m = live.get(b.id);
    if (!m) {
      m = def.build();
      m.position.set(b.x, b.y, b.z);
      m.userData.sample = new THREE.Vector3(b.x, b.y, b.z);
      m.userData.target = new THREE.Vector3(b.x, b.y, b.z);
      scene.add(m);
      live.set(b.id, m);
    }
    const ud = m.userData;
    const speed = def.props.speed || 60;
    if (ud.sample.x !== b.x || ud.sample.y !== b.y || ud.sample.z !== b.z) {
      // New server sample: re-aim along the travel direction.
      const next = new THREE.Vector3(b.x, b.y, b.z);
      ud.dir = next.clone().sub(ud.sample).normalize();
      ud.sample.copy(next);
      ud.target.copy(next);
    } else if (ud.dir) {
      ud.target.addScaledVector(ud.dir, speed * dt); // extrapolate between snapshots
    }
    m.position.lerp(ud.target, Math.min(1, dt * 14));
    if (ud.dir) m.lookAt(m.position.clone().add(ud.dir));
  }
  for (const [id, m] of live) {
    if (seen.has(id)) continue;
    scene.remove(m);
    m.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    live.delete(id);
  }
}
