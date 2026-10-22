# Modular Architecture - Frag Game Client

## Overview

The game client has been refactored into focused, reusable modules to improve maintainability, testability, and code organization. The `renderer.js` acts as the main orchestrator that coordinates all rendering concerns.

## Module Structure

### Core Modules

#### 1. **renderer.js** (Main Orchestrator)
- **Role**: Coordinates all rendering systems and manages the Three.js scene
- **Responsibilities**:
  - Initialize WebGL renderer, camera, scenes
  - Setup lighting and world environment
  - Delegate specialized tasks to focused modules
  - Manage player meshes and animations
  - Handle camera updates and viewport
  - Render final scenes

**Key Methods**:
```javascript
buildWorld(meta)              // Initialize game world
getOrCreateRemoteMesh(id)     // Create or retrieve player mesh
updateRemotePlayers(...)      // Update all remote players
updateFPVWeapon(...)          // Update first-person weapon display
render()                      // Final frame rendering
```

#### 2. **player-model.js** (Player Body Management)
- **Role**: Handles all player body creation and animation
- **Responsibilities**:
  - Build detailed player bodies with body parts (head, torso, arms, legs, hands)
  - Create animation state objects
  - Apply animations (idle breathing, reloading, aiming, death)
  - Manage limb rotations and movements

**Exported Functions**:
```javascript
buildPlayerBody()                           // Creates a full player body
createPlayerAnimationState()                // Initializes animation tracker
updatePlayerAnimations(mesh, data, state)  // Updates animations each frame
```

**Player Body Structure**:
- Head (sphere): Weapon attachment point
- Torso (box): Main body, breathing animation
- Arms (capsules): Reload and idle animations
- Hands (spheres): Weapon attachment points (right hand for weapon)
- Legs (capsules): Position foundation

#### 3. **weapon-model.js** (Weapon Creation)
- **Role**: Manages weapon models for third-person view
- **Responsibilities**:
  - Build weapon models with correct scaling per weapon type
  - Position weapons in player hands
  - Handle weapon attachment/detachment
  - Apply per-weapon visual properties (color, size, materials)

**Exported Functions**:
```javascript
buildWeapon(weaponKey, weaponData)           // Create a 3PV weapon model
updatePlayerWeapon(player, key, data)        // Attach weapon to player hand
```

**Weapon Properties Per Type**:
- Rifle: 0.8x0.3x2.0 scale, gray color
- SMG: 0.6x0.25x1.4 scale, purple-gray color
- Sniper: 0.5x0.25x3.2 scale, dark blue color

#### 4. **fpv-weapon.js** (First-Person Weapon)
- **Role**: Renders weapons in first-person view
- **Responsibilities**:
  - Build larger FPV weapon models (120% scaling)
  - Apply weapon bobbing animation
  - Handle reload animations
  - Add muzzle flash indicators
  - Manage FPV weapon state

**Exported Functions**:
```javascript
buildFPVWeapon(weaponKey, weaponData)        // Create FPV weapon
updateFPVAnimations(weapon, deltaTime, ms)   // Update bobbing & reload
```

**FPV Features**:
- Weapon positioned at screen-right (-0.6Z, -0.35Y, 0.4X)
- Continuous bobbing animation (sine/cosine waves)
- Reload rotate animation (weapon tilts upward)
- Muzzle orange glow (0xff6600 with emissive)

#### 5. **world-builder.js** (Environment & Terrain)
- **Role**: Manages world geometry and layout
- **Responsibilities**:
  - Build terrain patches (ground planes)
  - Place props (buildings, crates, containers)
  - Create zone meshes (safe zone indicators)
  - Update zone position and scale
  - Manage world materials and lighting setup

**Exported Functions**:
```javascript
buildWorld(scene, meta)           // Create entire world
addTerrainPatch(scene, patch)     // Add ground plane
addProp(scene, prop)              // Add building/crate
createZoneMeshes(scene)           // Create blue zone visuals
updateZone(zoneMesh, inner, data) // Update zone position
```

**Zone Visuals**:
- Outer ring (blue torus): 0x4ca8ff with 0.7 opacity
- Inner fill (circle): 0x2d72b5 with 0.08 opacity
- Scales dynamically based on zone radius

#### 6. **tracer-effects.js** (Bullet Visuals)
- **Role**: Manages bullet trail visual effects
- **Responsibilities**:
  - Spawn tracer lines from gunfire events
  - Fade tracers over time (180ms lifetime)
  - Clean up old tracer geometry
  - Manage tracer memory and garbage collection

**Exported Functions**:
```javascript
spawnTracer(scene, shot)   // Create bullet trail
updateTracers(scene, list) // Update and remove old tracers
```

**Tracer Properties**:
- Yellow line (0xfff189) with 0.95 opacity
- 180ms fade duration
- Auto-removed after fade complete

---

## Data Flow

```
Renderer (Main)
├─ buildWorld()
│  └─ world-builder.js
│     ├─ addTerrainPatch()
│     ├─ addProp()
│     └─ createZoneMeshes()
│
├─ updateRemotePlayers()
│  ├─ player-model.js
│  │  ├─ buildPlayerBody()
│  │  └─ updatePlayerAnimations()
│  ├─ weapon-model.js
│  │  └─ updatePlayerWeapon()
│  └─ tracer-effects.js
│     └─ spawnTracer()
│
├─ updateFPVWeapon()
│  └─ fpv-weapon.js
│     ├─ buildFPVWeapon()
│     └─ updateFPVAnimations()
│
└─ render()
   └─ Three.js render()
```

---

## Files Location

```
public/modules/
├── renderer.js           (Main orchestrator)
├── player-model.js       (Player bodies & animations)
├── weapon-model.js       (Third-person weapons)
├── fpv-weapon.js         (First-person view weapon)
├── world-builder.js      (World & terrain)
├── tracer-effects.js     (Bullet trails)
├── utils.js              (Shared utilities)
├── game-state.js         (Game state management)
├── socket-manager.js     (Network communication)
├── input-handler.js      (Input controls)
├── ui-manager.js         (HUD & UI)
└── interpolation.js      (State smoothing)
```

---

## Animation System

### Player Animations
- **Breathing**: Torso bobs up/down continuously (idle state)
- **Reload**: Right arm rotates, magazine animates (reload state)
- **Aiming**: Head tilts based on pitch angle (any state)
- **Death**: Body tilts & rolls progressively (0-1 progress)

### Weapon Animations
- **Bobbing**: FPV weapon sways with sine/cosine curves
- **Reload**: Weapon rotates during magazine replacement
- **Switch**: Smooth weapon attachment to hand (via updatePlayerWeapon)

---

## Performance Considerations

1. **Mesh Pooling**: Remote player meshes are reused when players join/leave
2. **Tracer Cleanup**: Old tracers are removed after 180ms to prevent memory buildup
3. **LOD**: No extra geometry added to invisible body parts
4. **Delegated Tasks**: Each module handles only its concern, reducing coupling

---

## Extending the System

### Add a New Animation
1. Edit `player-model.js` in `updatePlayerAnimations()`
2. Access body parts via `playerBody.getObjectByName("partName")`
3. Modify rotation, position, or scale properties

### Add a New Weapon
1. Add weapon config to server `WEAPONS` object with `scale`, `offset`, `color`
2. New weapon automatically rendered in both 3PV (weapon-model.js) and FPV (fpv-weapon.js)
3. Player attaches weapon via `updatePlayerWeapon()` when switching

### Custom World Geometry
1. Extend `world-builder.js` with new build functions
2. Pass props/patches from server metadata
3. Call from `renderer.buildWorld()`

---

## Testing the Modules

```javascript
// Test player body creation
import { buildPlayerBody } from './modules/player-model.js';
const body = buildPlayerBody();
console.log(body); // Verify structure

// Test weapon building
import { buildWeapon } from './modules/weapon-model.js';
const weapon = buildWeapon('rifle', weaponData);
console.log(weapon.children.length); // 2 children (stock + magazine)

// Test FPV weapon
import { buildFPVWeapon } from './modules/fpv-weapon.js';
const fpvWeapon = buildFPVWeapon('rifle', weaponData);
console.log(fpvWeapon.position); // Should be {x:0.4, y:-0.35, z:-0.6}
```

---

**Last Updated**: February 27, 2026  
**Status**: Modular refactor complete with focused responsibility separation
