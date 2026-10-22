# Weapon Design System Architecture

## Directory Structure

```
/public
├── assets/
│   ├── weapons/
│   │   ├── rifle/
│   │   │   └── design.js              # Rifle-specific FPV model and animations
│   │   ├── smg/
│   │   │   └── design.js              # SMG-specific FPV model and animations
│   │   └── sniper/
│   │       └── design.js              # Sniper-specific FPV model and animations
│   └── hands/
│       └── design.js                  # Shared hand/arm model for all weapons
└── modules/
    └── fpv-weapon.js                  # Main coordinator importing weapon designs
```

## Module Overview

### `/assets/hands/design.js`
**Purpose**: Shared hand and arm model displayed in first-person view

**Exports**:
- `buildHands()` - Creates the hand model with skin textures, arms, and sleeves
- `updateHandsAnimation(hands, deltaTime, isFiring, recoilIntensity)` - Animates hands with breathing and recoil

**Features**:
- Realistic hand geometry (arms, forearms, palms, fingers)
- Skin-tone materials with realistic roughness
- Sleeve/clothing details
- Breathing animation
- Recoil response animation

---

### `/assets/weapons/rifle/design.js`
**Purpose**: Assault rifle design with scope system

**Exports**:
- `buildRifleGun()` - Detailed rifle model with barrel, receiver, stock, magazine, scope
- `buildRifleScope()` - Scope reticle overlay (green crosshair with windage marks)
- `updateRifleAnimation(rifle, deltaTime, reloadingMs, isFiring)` - Animations

**Features**:
- Barrel with muzzle brake
- Wooden stock and handguard
- Metal receiver with detail
- Magazine with angle
- Tactical scope with glass lenses
- Reload animation (rotating motion)
- Firing recoil (downward kick)
- Weapon bobbing when moving

---

### `/assets/weapons/smg/design.js`
**Purpose**: Submachine gun design with red-dot sight

**Exports**:
- `buildSMGGun()` - Compact SMG model with reflex sight
- `buildSMGSight()` - Red-dot reticle overlay
- `updateSMGAnimation(smg, deltaTime, reloadingMs, isFiring)` - Animations

**Features**:
- Shorter barrel and receiver (compact profile)
- Fast-firing visual style (aggressive angles)
- Built-in reflex sight with red dot
- Magazine witness holes
- Burst fire selector
- More aggressive movement bobbing (faster feel)
- Stronger firing recoil than rifle

---

### `/assets/weapons/sniper/design.js`
**Purpose**: Precision sniper rifle with tactical scope

**Exports**:
- `buildSniperGun()` - Long-barrel sniper rifle with tactical scope
- `buildSniperScope()` - Green mil-dot reticle overlay
- `updateSniperAnimation(sniper, deltaTime, reloadingMs, isFiring)` - Animations

**Features**:
- Long precision barrel with shroud
- Heavy reinforced receiver with rail system
- Wooden furniture (stock and handguard)
- Tactical scope with large objective/eyepiece
- Elevation and windage turrets
- Bolt-action reload animation
- Strongest recoil (high-power rounds)
- Slower, steadier movement bobbing (precision weapon feel)

---

### `/modules/fpv-weapon.js`
**Purpose**: Main orchestrator for FPV weapon system

**Key Functions**:
- `buildFPVWeapon(weaponKey)` - Factory function that creates proper weapon + hands
- `updateFPVAnimations(fpvScene, deltaTime, reloadingMs, isFiring, recoilIntensity)` - Updates all animations
- `switchFPVWeapon(currentScene, newWeapon)` - Weapon switching logic
- `setScope(fpvScene, active)` - Scope activation
- `getCurrentWeapon(fpvScene)` - Query current weapon

---

## How to Add a New Weapon Design

### Step 1: Create Weapon Directory
```bash
mkdir -p /public/assets/weapons/myweapon
touch /public/assets/weapons/myweapon/design.js
```

### Step 2: Create design.js Template
```javascript
/**
 * MyWeapon design - Description
 */

export function buildMyWeaponGun() {
  const gun = new THREE.Group();
  gun.name = "myweapon-fpv";
  gun.position.set(0.4, -0.35, -0.6);

  // Create materials
  const steelMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a2a,
    roughness: 0.5,
    metalness: 0.8,
  });

  // Build gun geometry using THREE.js primitives
  // ... add mesh components ...

  gun.userData.bobbingTime = 0;
  gun.userData.isReloading = false;

  return gun;
}

export function buildMyWeaponSight() {
  const sight = new THREE.Group();
  sight.name = "myweapon-sight-reticle";

  // Create sight reticle geometry
  // ... add sight elements ...

  sight.userData.isActive = false;
  return sight;
}

export function updateMyWeaponAnimation(gun, deltaTime, reloadingMs, isFiring) {
  if (!gun) return;

  gun.userData.bobbingTime += deltaTime;

  // Add weapon-specific animations
  // ... bobbing, reload, recoil logic ...
}
```

### Step 3: Update fpv-weapon.js
Add the weapon switch case in `buildFPVWeapon()`:

```javascript
import { buildMyWeaponGun, buildMyWeaponSight, updateMyWeaponAnimation } from "../assets/weapons/myweapon/design.js";

// In buildFPVWeapon function:
case "myweapon":
  gun = buildMyWeaponGun();
  sight = buildMyWeaponSight();
  fpvScene.userData.updateGunAnimation = updateMyWeaponAnimation;
  break;
```

### Step 4: Register in Server
Update `server.js` WEAPONS config:
```javascript
myweapon: {
  key: "myweapon",
  label: "MyWeapon",
  damage: 40,
  fireIntervalMs: 100,
  // ... other stats ...
}
```

---

## Material Properties Guide

### Steel/Metal
```javascript
const steelMat = new THREE.MeshStandardMaterial({
  color: 0x2a2a2a,      // Dark gray
  roughness: 0.5,       // Polished steel (0-1)
  metalness: 0.8,       // Highly metallic (0-1)
});
```

### Wood
```javascript
const woodMat = new THREE.MeshStandardMaterial({
  color: 0x5c3d2e,      // Wood brown
  roughness: 0.6,       // Wood has texture
  metalness: 0,         // Not metallic
});
```

### Plastic
```javascript
const plastMat = new THREE.MeshStandardMaterial({
  color: 0x1a1a1a,      // Black
  roughness: 0.7,       // Textured plastic
  metalness: 0.1,       // Slight sheen
});
```

### Glass (Scope Lenses)
```javascript
const glassMat = new THREE.MeshStandardMaterial({
  color: 0x001a40,      // Dark blue
  roughness: 0.05,      // Very smooth
  metalness: 0.3,       // Some reflection
});
```

---

## Animation Patterns

### Weapon Bobbing
```javascript
const bob = Math.sin(deltaTime * 2) * 0.02;  // Vertical bob
const sway = Math.cos(deltaTime * 1.2) * 0.015; // Horizontal sway
gun.position.y = baseY + bob;
gun.position.x = baseX + sway;
```

### Reload Animation
```javascript
if (reloadingMs > 0) {
  const progress = elapsed / reloadDuration; // 0 to 1
  const rotation = progress * Math.PI / 2.5;
  gun.rotation.x = Math.sin(rotation) * 0.35;
}
```

### Firing Recoil
```javascript
if (isFiring) {
  gun.position.y -= recoilIntensity * 0.1;
  gun.rotation.x -= recoilIntensity * 0.15;
}
```

---

## Scope Reticle Patterns

### Simple Crosshair
```javascript
const crossGeo = new THREE.BufferGeometry();
crossGeo.setAttribute('position', new THREE.BufferAttribute(
  new Float32Array([
    -0.05, 0, 0,  0.05, 0, 0,
    0, -0.05, 0,  0, 0.05, 0,
  ]), 3
));
const lineMat = new THREE.LineBasicMaterial({ color: 0x00ff00 });
const cross = new THREE.Line(crossGeo, lineMat);
scope.add(cross);
```

### Circle Reticle
```javascript
const circleGeo = new THREE.BufferGeometry();
const circlePoints = [];
for (let i = 0; i <= 32; i++) {
  const angle = (i / 32) * Math.PI * 2;
  circlePoints.push(
    Math.cos(angle) * 0.15,
    Math.sin(angle) * 0.15,
    0
  );
}
circleGeo.setAttribute('position', new THREE.BufferAttribute(
  new Float32Array(circlePoints), 3
));
const circle = new THREE.Line(circleGeo, lineMat);
scope.add(circle);
```

---

## Best Practices

1. **Position**: Keep weapon at `(0.4, -0.35, -0.6)` for consistent FPV feel
2. **Scale**: Use CapsuleGeometry for arms/cylinders for barrels
3. **Materials**: Use `MeshStandardMaterial` for realistic PBR rendering
4. **Animations**: Use deltaTime for smooth frame-rate independent motion
5. **Recoil**: Apply recoil to both position and rotation for visual punch
6. **Sight**: Always create a sight reticle even if it's not used
7. **Naming**: Use consistent naming pattern `{weapon}-fpv` for gun groups

---

## Testing Your New Weapon

1. Add weapon to server WEAPONS config
2. Create design.js template
3. Update fpv-weapon.js with weapon case
4. Join game and switch to weapon with `1/2/3` keys
5. Listen for any console errors
6. Test animations: movement, reload, firing

---

## Performance Optimization

- Reuse geometries: `new THREE.BoxGeometry(...)` creates geometry, reuse with multiple meshes
- Limit poly count: Keep weapon under 5000 triangles
- Material efficiency: Reuse materials across weapon parts
- Animation updates: Only animated changed properties
- Scope rendering: Use 2D canvas overlay instead of 3D geometry if possible

