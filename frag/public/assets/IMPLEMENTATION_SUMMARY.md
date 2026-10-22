# FPV Weapon & Hand System Implementation

## Overview

Complete modular first-person view (FPV) weapon system with realistic hand models, gun designs, and scope systems for all 3 weapons in Frag Arena.

## What's New

### 1. **Hand Model System** (`/assets/hands/design.js`)
- Realistic hands with arms, forearms, palms, and fingers
- Skin-tone materials with realistic textures
- Sleeves/clothing details
- Breathing animation
- Recoil response feel

### 2. **Rifle Design** (`/assets/weapons/rifle/design.js`)
- Full rifle model with:
  - Long precision barrel with muzzle brake
  - Wooden stock and handguard
  - Metal receiver with detail
  - Magazine with realistic angle
  - Tactical scope with glass lenses
  - Charging handle
  - Trigger guard
- Green crosshair scope reticle with windage marks
- Realistic reload animation (1750ms)
- Moderate recoil kick
- Smooth weapon bobbing

### 3. **SMG Design** (`/assets/weapons/smg/design.js`)
- Compact submachine gun with:
  - Short barrel with compact profile
  - Fast-firing visual style
  - Built-in reflex sight with red dot
  - Magazine with witness holes
  - Burst fire selector
  - Handguard with heat vents
- Red-dot sight reticle
- Fast reload animation (1500ms)
- Strong firing recoil (aggressive feel)
- Fast weapon bobbing (more active)

### 4. **Sniper Rifle Design** (`/assets/weapons/sniper/design.js`)
- Precision sniper rifle with:
  - Long barrel with shroud (precision feel)
  - Heavy reinforced receiver with rail system
  - Wooden furniture (stock and handguard)
  - Tactical scope with large objective/eyepiece
  - Turret adjustments (elevation & windage)
  - Bolt handle
- Green mil-dot tactical scope reticle
- Slow reload animation (2200ms) - bolt-action
- Strongest recoil (high-power rounds)
- Slow, steady weapon bobbing (precision weapon)

## Directory Structure

```
/public/assets/
├── weapons/
│   ├── rifle/
│   │   └── design.js          (Rifle model + scope + animations)
│   ├── smg/
│   │   └── design.js          (SMG model + red-dot + animations)
│   └── sniper/
│       └── design.js          (Sniper model + tactical scope + animations)
├── hands/
│   └── design.js              (Shared hand/arm model)
└── WEAPON_DESIGN_GUIDE.md     (Complete guide for adding new weapons)
```

## Technical Implementation

### Main Orchestrator: `fpv-weapon.js`

```javascript
// Factory function - creates complete FPV scene (hands + weapon + sight)
buildFPVWeapon(weaponKey) → Returns THREE.Group with:
  - Hands model
  - Weapon-specific gun
  - Weapon-specific sight reticle

// Animation updates
updateFPVAnimations(fpvScene, deltaTime, reloadingMs, isFiring, recoilIntensity)
  - Updates hands with recoil
  - Updates gun with firing/reload/bobbing
  - Delegates to weapon-specific animation function

// Weapon switching
switchFPVWeapon(currentScene, newWeapon) → Removes old, builds new
```

### Renderer Integration

- Auto-initializes FPV weapon when first weapon is detected
- Switches weapon when player changes loadout
- Updates animations in render loop
- Renders FPV scene on top of main game world

### Game Loop Integration (`frag.js`)

```javascript
// Track weapon changes
const me = state.players.find(p => p.id === myId);
if (me.weapon !== lastWeapon) {
  renderer.updateFPVWeapon(me.weapon);
  lastWeapon = me.weapon;
}

// Update animations each frame
renderer.updateFPVAnimations(deltaTime, me.reloadingMs, me.firingMs > 0);
```

## Features

✅ **Rifle**
- Scope with green reticle
- Balanced animations
- Medium-speed reload
- Smooth recoil

✅ **SMG** 
- Red-dot sight
- Aggressive animations
- Fast reload
- Strong, punchy recoil

✅ **Sniper**
- Tactical scope with mil-dots
- Precise, steady feel
- Slow bolt-action reload
- Extreme recoil (realistic for high-caliber)

✅ **Hands**
- Breathing animation
- Recoil response
- Realistic grip and finger animation
- Clothing/sleeve details

## Asset Geometry

### Hand Components
- Upper arms (CapsuleGeometry)
- Forearms (CapsuleGeometry)
- Palms (BoxGeometry)
- Fingers (BoxGeometry - simplified)
- Sleeves (CapsuleGeometry with scale)

### Weapon Components
- Barrels (CylinderGeometry)
- Receivers (BoxGeometry)
- Stocks (BoxGeometry)
- Magazines (BoxGeometry with angle)
- Scopes/Sights (CylinderGeometry + SphereGeometry)
- Grips (BoxGeometry with rotation)

## Materials Used

| Type | Color | Roughness | Metalness |
|------|-------|-----------|-----------|
| Steel | 0x2a2a2a | 0.5 | 0.8 |
| Bright Steel | 0x3a3a3a | 0.4 | 0.85 |
| Black Steel | 0x0a0a0a | 0.7 | 0.6 |
| Wood | 0x5c3d2e | 0.65 | 0 |
| Plastic | 0x1a1a1a | 0.7 | 0.1 |
| Skin | 0xd4a574 | 0.7 | 0 |
| Glass | 0x001a40 | 0.05 | 0.3 |

## Animation Details

### Weapon Bobbing
- Frame-locked to movement (deltaTime based)
- Different speeds per weapon (SMG faster, Sniper slower)
- Sine/cosine combination for natural feel

### Reload Animation
- Rifle: 1750ms - Moderate rotation
- SMG: 1500ms - Quick reload
- Sniper: 2200ms - Slow bolt-action

### Firing Recoil
- Rifle: 0.08 upward knockback, 0.12 rotation
- SMG: 0.12 upward knockback, 0.18 rotation (aggressive)
- Sniper: 0.15 upward knockback, 0.22 rotation (strong)

## Performance Stats

- **Weapon Polygons**: ~800-1200 triangles per gun
- **Hand Polygons**: ~400 triangles
- **Scope Reticle**: Procedural lines (minimal geometry)
- **Material Count**: 6-8 per weapon
- **Draw Calls**: 1 FPV render pass on top of main scene

## How to Extend

See `/public/assets/WEAPON_DESIGN_GUIDE.md` for complete instructions on:
1. Creating new weapon designs
2. Material property reference
3. Animation pattern templates
4. Scope reticle examples
5. Best practices and optimization

## Files Modified

1. **fpv-weapon.js** - Completely refactored to use modular weapon designs
2. **renderer.js** - Updated to import and use new fpv-weapon functions
3. **frag.js** - Added FPV weapon updates to render loop
4. **index.html** - (No changes needed - already had correct structure)

## Testing

1. Open http://localhost:3000/frag
2. Join game with a name
3. Weapons: Use `1` (rifle), `2` (smg), `3` (sniper) to switch
4. Look at right side of screen - should see:
   - Hands holding weapon
   - Detailed gun model
   - Weapon name and animations
5. Fire to see recoil animations
6. Reload to see reload animations
7. Move to see weapon bobbing
8. For scoped rifles/sniper - aimDown sight to see reticle

## Future Enhancements

- [ ] Add scope zoom blurring effect
- [ ] Add muzzle flash particle effects
- [ ] Add shell casing ejection
- [ ] Add damage screen overlay
- [ ] Add weapon sway under fire
- [ ] Add aiming stabilization animation
- [ ] Add different hand poses per weapon
- [ ] Add weapon damage indicator color change

