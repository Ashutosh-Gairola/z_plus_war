/**
 * First-person weapon controller.
 * Owns the FPV rig: gun model + attached arms, and drives every viewmodel
 * animation — idle sway, movement bob, look sway, ADS, sprint pose, fire
 * recoil, muzzle flash, shell ejection, smoke, staged reloads (delegated to
 * the weapon design), holster/draw switching, and melee.
 */

import { buildArms } from "../assets/hands/design.js";
import { buildRifleGun, buildRifleScope, animateRifleReload } from "../assets/weapons/rifle/design.js";
import { buildSMGGun, buildSMGSight, animateSMGReload } from "../assets/weapons/smg/design.js";
import { buildSniperGun, buildSniperScope, animateSniperReload } from "../assets/weapons/sniper/design.js";
import { LOOT_DESIGNS } from "../assets/weapons/loot/designs.js";

const DESIGNS = {
  rifle: { build: buildRifleGun, scope: buildRifleScope, reload: animateRifleReload },
  smg: { build: buildSMGGun, scope: buildSMGSight, reload: animateSMGReload },
  sniper: { build: buildSniperGun, scope: buildSniperScope, reload: animateSniperReload },
  ...LOOT_DESIGNS,
};

const SHELL_GEO = new THREE.CylinderGeometry(0.007, 0.007, 0.034, 8);
const SHELL_MAT = new THREE.MeshStandardMaterial({ color: 0xc79945, roughness: 0.35, metalness: 0.7 });
const SMOKE_GEO = new THREE.SphereGeometry(0.03, 8, 6);

function applyPose(obj, p) {
  obj.position.set(p.pos.x, p.pos.y, p.pos.z);
  obj.rotation.set(p.rot.x, p.rot.y, p.rot.z);
}

function mixPoseInto(out, a, b, t) {
  out.pos.x = a.pos.x + (b.pos.x - a.pos.x) * t;
  out.pos.y = a.pos.y + (b.pos.y - a.pos.y) * t;
  out.pos.z = a.pos.z + (b.pos.z - a.pos.z) * t;
  out.rot.x = a.rot.x + (b.rot.x - a.rot.x) * t;
  out.rot.y = a.rot.y + (b.rot.y - a.rot.y) * t;
  out.rot.z = a.rot.z + (b.rot.z - a.rot.z) * t;
}

/**
 * Build the FPV rig for a weapon.
 * @returns {THREE.Group} rig with userData { gun, arms, cfg, currentWeapon }
 */
export function buildFPVWeapon(weaponKey) {
  const design = DESIGNS[weaponKey] || DESIGNS.rifle;
  const rig = new THREE.Group();
  rig.name = "fpv-rig";

  const gun = design.build();
  const cfg = gun.userData.cfg;
  const VIEW_SCALE = 0.78; // keep the viewmodel from dominating the screen
  gun.scale.setScalar(VIEW_SCALE);
  // The sight sits at a scaled local height, so the ADS pose (which centers
  // the sight on the camera axis) must scale with the model.
  cfg.ads.pos.x *= VIEW_SCALE;
  cfg.ads.pos.y *= VIEW_SCALE;
  applyPose(gun, cfg.hip);
  rig.add(gun);

  const arms = buildArms();
  gun.add(arms); // arms live in gun space so they track every gun motion
  applyPose(arms.getObjectByName("rightArm"), cfg.grips.right);
  applyPose(arms.getObjectByName("leftArm"), cfg.grips.left);

  const sight = design.scope();
  rig.add(sight);

  rig.userData = {
    currentWeapon: weaponKey,
    gun,
    arms,
    sight,
    cfg,
    reloadFn: design.reload,
    bobTime: 0,
    adsBlend: 0,
    sprintBlend: 0,
    swayYaw: 0,
    swayPitch: 0,
    recoilZ: 0,
    recoilRX: 0,
    flashUntil: 0,
    cycleStart: -1,
    shells: [],
    smoke: [],
    wasReloading: false,
    scratch: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0 } },
  };

  return rig;
}

export function switchFPVWeapon(currentRig, newWeapon) {
  if (currentRig && currentRig.parent) currentRig.parent.remove(currentRig);
  return buildFPVWeapon(newWeapon);
}

export function setScope(rig, active) {
  if (!rig) return;
  const { cfg, gun, arms } = rig.userData;
  // Sniper full-scope: hide the viewmodel entirely while the CSS overlay shows.
  const hide = active && cfg.scopeOverlay && rig.userData.adsBlend > 0.75;
  gun.visible = !hide;
  if (arms) arms.visible = !hide;
}

export function getCurrentWeapon(rig) {
  return rig?.userData?.currentWeapon || "rifle";
}

function spawnShell(rig) {
  const { gun, cfg } = rig.userData;
  const shell = new THREE.Mesh(SHELL_GEO, SHELL_MAT.clone());
  shell.material.transparent = true;
  const p = new THREE.Vector3(cfg.shellLocal.x, cfg.shellLocal.y, cfg.shellLocal.z);
  gun.localToWorld(p);
  rig.worldToLocal(p);
  shell.position.copy(p);
  if (cfg.shellScale) shell.scale.set(cfg.shellScale, cfg.shellScale * 1.4, cfg.shellScale);
  shell.rotation.set(Math.random(), Math.random(), Math.PI / 2);
  shell.userData.vel = new THREE.Vector3(0.7 + Math.random() * 0.4, 0.45 + Math.random() * 0.25, -0.15 - Math.random() * 0.1);
  shell.userData.spin = new THREE.Vector3(Math.random() * 14, Math.random() * 14, Math.random() * 14);
  shell.userData.life = 0;
  rig.add(shell);
  rig.userData.shells.push(shell);
}

function spawnSmoke(rig) {
  const { gun, cfg } = rig.userData;
  const puff = new THREE.Mesh(
    SMOKE_GEO,
    new THREE.MeshBasicMaterial({ color: 0xcdd3d8, transparent: true, opacity: 0.34, depthWrite: false }),
  );
  const p = new THREE.Vector3(cfg.muzzleLocal.x, cfg.muzzleLocal.y, cfg.muzzleLocal.z);
  gun.localToWorld(p);
  rig.worldToLocal(p);
  puff.position.copy(p);
  puff.userData.vel = new THREE.Vector3((Math.random() - 0.5) * 0.15, 0.3 + Math.random() * 0.2, -0.5 - Math.random() * 0.4);
  puff.userData.life = 0;
  rig.add(puff);
  rig.userData.smoke.push(puff);
}

function updateParticles(rig, dt) {
  const { shells, smoke } = rig.userData;
  for (let i = shells.length - 1; i >= 0; i -= 1) {
    const s = shells[i];
    s.userData.life += dt;
    s.userData.vel.y -= 3.2 * dt;
    s.position.addScaledVector(s.userData.vel, dt);
    s.rotation.x += s.userData.spin.x * dt;
    s.rotation.y += s.userData.spin.y * dt;
    s.material.opacity = Math.max(0, 1 - s.userData.life * 1.8);
    if (s.userData.life > 0.6) {
      rig.remove(s);
      s.material.dispose();
      shells.splice(i, 1);
    }
  }
  for (let i = smoke.length - 1; i >= 0; i -= 1) {
    const s = smoke[i];
    s.userData.life += dt;
    s.position.addScaledVector(s.userData.vel, dt);
    s.scale.setScalar(1 + s.userData.life * 5);
    s.material.opacity = Math.max(0, 0.34 - s.userData.life * 0.5);
    if (s.userData.life > 0.7) {
      rig.remove(s);
      s.material.dispose();
      smoke.splice(i, 1);
    }
  }
}

/**
 * Per-frame FPV update.
 * ctx: {
 *   reloadingMs, reloadTotalMs, switchingMs, switchTotalMs, meleeMs,
 *   justFired, isScoped, isSprinting, isInVehicle,
 *   moveSpeed, grounded, lookDeltaYaw, lookDeltaPitch
 * }
 */
export function updateFPVAnimations(rig, dt, ctx) {
  if (!rig) return;
  const ud = rig.userData;
  const { gun, arms, cfg } = ud;

  rig.visible = !ctx.isInVehicle;
  if (ctx.isInVehicle) return;

  // ---- Blends ----
  const reloading = ctx.reloadingMs > 0;
  const adsTarget = ctx.isScoped && !reloading && !ctx.isSprinting ? 1 : 0;
  ud.adsBlend += (adsTarget - ud.adsBlend) * Math.min(1, dt * 11);
  const sprintTarget = ctx.isSprinting && !reloading ? 1 : 0;
  ud.sprintBlend += (sprintTarget - ud.sprintBlend) * Math.min(1, dt * 9);

  // ---- Gun base pose: hip -> sprint -> ads ----
  const scratch = ud.scratch;
  mixPoseInto(scratch, cfg.hip, cfg.sprint, ud.sprintBlend);
  mixPoseInto(scratch, scratch, cfg.ads, ud.adsBlend);

  // ---- Reload choreography (weapon design owns the keyframes) ----
  let reloadOffset = null;
  if (reloading && ctx.reloadTotalMs > 0) {
    const progress = Math.min(1, Math.max(0, 1 - ctx.reloadingMs / ctx.reloadTotalMs));
    reloadOffset = ud.reloadFn(gun, arms, progress);
    ud.wasReloading = true;
  } else if (ud.wasReloading) {
    // Snap internals back to rest once the reload window closes.
    ud.reloadFn(gun, arms, 1);
    applyPose(arms.getObjectByName("leftArm"), cfg.grips.left);
    ud.wasReloading = false;
  }

  // ---- Fire recoil ----
  if (ctx.justFired) {
    ud.recoilZ = Math.min(0.22, ud.recoilZ + cfg.fireKick.z);
    ud.recoilRX = Math.min(0.14, ud.recoilRX + cfg.fireKick.rx);
    ud.flashUntil = performance.now() + 45;
    const flash = gun.getObjectByName("muzzleFlash");
    if (flash) {
      flash.visible = true;
      flash.rotation.z = Math.random() * Math.PI * 2;
      flash.scale.setScalar(0.8 + Math.random() * 0.5);
    }
    // Pump / revolver / launcher eject on their action cycle, not per shot.
    if (!cfg.noShells && !cfg.cycle) spawnShell(rig);
    spawnSmoke(rig);
    if (cfg.cycle) {
      ud.cycleStart = performance.now();
      ud.cycleShellDone = false;
    }
  }
  // ---- Action cycle after a shot (pump rack, hammer re-cock, rocket reload) ----
  if (cfg.cycle && ud.cycleStart >= 0 && !reloading) {
    const t = Math.min(1, (performance.now() - ud.cycleStart) / cfg.cycleMs);
    const ejecting = cfg.cycle(gun, arms, t);
    if (ejecting && !ud.cycleShellDone && !cfg.noShells) {
      spawnShell(rig);
      ud.cycleShellDone = true;
    }
    if (t >= 1) ud.cycleStart = -1;
  }
  if (performance.now() > ud.flashUntil) {
    const flash = gun.getObjectByName("muzzleFlash");
    if (flash) flash.visible = false;
  }
  ud.recoilZ *= Math.exp(-dt * 11);
  ud.recoilRX *= Math.exp(-dt * 13);

  // ---- Compose gun transform ----
  gun.position.set(scratch.pos.x, scratch.pos.y, scratch.pos.z + ud.recoilZ);
  gun.rotation.set(scratch.rot.x - ud.recoilRX, scratch.rot.y, scratch.rot.z);
  if (reloadOffset) {
    gun.position.x += reloadOffset.pos.x;
    gun.position.y += reloadOffset.pos.y;
    gun.position.z += reloadOffset.pos.z;
    gun.rotation.x += reloadOffset.rot.x;
    gun.rotation.y += reloadOffset.rot.y;
    gun.rotation.z += reloadOffset.rot.z;
  }

  // ---- Movement bob (rig level, damped by ADS) ----
  const speedNorm = Math.min(1, ctx.moveSpeed / 10.5);
  const bobRate = 5.4 + speedNorm * 7.5;
  if (ctx.moveSpeed > 0.4 && ctx.grounded) ud.bobTime += dt * bobRate;
  const bobAmp = (0.006 + speedNorm * 0.02) * (1 - ud.adsBlend * 0.82);
  const bobY = Math.abs(Math.sin(ud.bobTime)) * bobAmp * -1;
  const bobX = Math.cos(ud.bobTime * 0.5) * bobAmp * 0.9;
  const breatheY = Math.sin(performance.now() * 0.0014) * 0.0035 * (1 - ud.adsBlend * 0.6);

  // ---- Look sway (rig lags behind camera turns) ----
  const swayResp = Math.min(1, dt * 9);
  ud.swayYaw += ((ctx.lookDeltaYaw || 0) * 5.2 - ud.swayYaw) * swayResp;
  ud.swayPitch += ((ctx.lookDeltaPitch || 0) * 5.2 - ud.swayPitch) * swayResp;
  const swayScale = 1 - ud.adsBlend * 0.75;

  // ---- Weapon switching: lower then raise ----
  let lower = 0;
  if (ctx.switchingMs > 0 && ctx.switchTotalMs > 0) {
    const t = 1 - ctx.switchingMs / ctx.switchTotalMs; // 0 -> 1
    lower = t < 0.5 ? t * 2 : (1 - t) * 2;
    lower = lower * lower * (3 - 2 * lower);
  }

  // ---- Melee shove ----
  const meleePulse = ctx.meleeMs > 0 ? Math.sin(Math.min(1, 1 - ctx.meleeMs / 520) * Math.PI) : 0;

  rig.position.set(
    bobX + ud.swayYaw * 0.02 * swayScale,
    bobY + breatheY - lower * 0.55 + ud.swayPitch * 0.018 * swayScale,
    -meleePulse * 0.22,
  );
  rig.rotation.set(
    ud.swayPitch * 0.06 * swayScale + lower * 0.75 - meleePulse * 0.3,
    ud.swayYaw * 0.05 * swayScale,
    Math.sin(ud.bobTime * 0.5) * 0.008 * (1 - ud.adsBlend) + lower * 0.18 + meleePulse * 0.25,
  );

  updateParticles(rig, dt);
}
