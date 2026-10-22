/**
 * Third-person weapon models. Reuses the detailed first-person gun designs,
 * scaled to real-world size and merged per material so each gun is only a
 * handful of draw calls. The gun mounts on the character's "weaponSocket"
 * (a torso-space mount; +Z forward) and exposes grip / support-hand points in
 * socket space so the arm IK can put both hands on it.
 */

import { buildRifleGun } from "../assets/weapons/rifle/design.js";
import { buildSMGGun } from "../assets/weapons/smg/design.js";
import { buildSniperGun } from "../assets/weapons/sniper/design.js";
import { LOOT_TP_PRESETS } from "../assets/weapons/loot/designs.js";
import { mergeStaticMeshes } from "./mesh-merge.js";

// FPV-space anchor points (gun -Z forward, origin above the pistol grip).
const PRESETS = {
  rifle: { build: buildRifleGun, scale: 0.62, grip: [0, -0.13, 0.17], support: [0, -0.04, -0.46], butt: 0.62 },
  smg: { build: buildSMGGun, scale: 0.56, grip: [0, -0.12, 0.14], support: [0, -0.13, -0.34], butt: 0.38 },
  sniper: { build: buildSniperGun, scale: 0.52, grip: [0, -0.13, 0.22], support: [0, -0.06, -0.5], butt: 0.52 },
  ...LOOT_TP_PRESETS,
};

const templates = new Map();
let sharedGunMaterial = null;

function gunMaterial() {
  if (!sharedGunMaterial) {
    sharedGunMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.35 });
  }
  return sharedGunMaterial;
}

function buildTemplate(weaponKey) {
  const preset = PRESETS[weaponKey] || PRESETS.rifle;
  const fpv = preset.build();
  fpv.scale.setScalar(preset.scale);
  // FPV models face -Z; characters face +Z.
  fpv.rotation.y = Math.PI;

  // Muzzle flash keeps its own group so it can toggle; everything else merges.
  const fpvFlash = fpv.getObjectByName("muzzleFlash");
  if (fpvFlash) fpvFlash.parent.remove(fpvFlash);

  const s = preset.scale;
  // FPV point -> socket space (grip at origin, +Z forward).
  const toSocket = (p) =>
    new THREE.Vector3(-(p[0] - preset.grip[0]) * s, (p[1] - preset.grip[1]) * s, -(p[2] - preset.grip[2]) * s);

  const gun = new THREE.Group();
  gun.name = `weapon-${weaponKey}`;
  const holder = new THREE.Group();
  holder.add(fpv);
  gun.add(holder);
  // Offset so the pistol grip sits at the socket origin.
  holder.position.set(preset.grip[0] * s, -preset.grip[1] * s, preset.grip[2] * s);
  // Opaque metal/polymer parts collapse into one vertex-colored material.
  fpv.traverse((o) => {
    if (o.isMesh && o.material.isMeshStandardMaterial && !o.material.transparent) {
      o.material.userData.mergeInto = gunMaterial();
    }
  });
  mergeStaticMeshes(holder, { castShadow: true });

  if (fpvFlash) {
    fpvFlash.name = "tpMuzzleFlash";
    fpvFlash.visible = false;
    const p = fpvFlash.position;
    fpvFlash.position.copy(toSocket([p.x, p.y, p.z]));
    fpvFlash.scale.setScalar(s * 0.9);
    fpvFlash.rotation.set(0, Math.PI, 0);
    gun.add(fpvFlash);
  }

  gun.userData.anchors = {
    grip: new THREE.Vector3(0, 0, 0),
    support: toSocket(preset.support),
    buttZ: -(preset.butt - preset.grip[2]) * s,
  };
  return gun;
}

export function buildWeapon(weaponKey) {
  const key = PRESETS[weaponKey] ? weaponKey : "rifle";
  if (!templates.has(key)) templates.set(key, buildTemplate(key));
  const template = templates.get(key);
  const gun = template.clone();
  gun.userData.anchors = template.userData.anchors;
  // Flash material is shared with the template; it only toggles visibility.
  return gun;
}

export function updatePlayerWeapon(playerGroup, weaponKey, weaponData) {
  const socket =
    playerGroup.getObjectByName("weaponSocket") || playerGroup.getObjectByName("rightHand");
  if (!socket) return;

  const oldWeapon = socket.children.find((c) => c.name && c.name.startsWith("weapon-"));
  if (oldWeapon) socket.remove(oldWeapon);

  const gun = buildWeapon(weaponKey, weaponData);
  socket.add(gun);
  playerGroup.userData.currentWeapon = weaponKey;
  playerGroup.userData.weaponAnchors = gun.userData.anchors;
}
