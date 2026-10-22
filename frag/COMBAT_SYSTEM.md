# Frag Arena - Complete Combat System Documentation

## Overview
The Frag Arena now features a comprehensive combat system with detailed player models, weapons, animations, and advanced hit detection including headshots.

---

## 1. Player Body Model

### Structure
Each player is rendered with a detailed Minecraft/Roblox/PUBG-style body composed of:

- **Head**: Sphere geometry (radius 0.35) at position y=1.55
  - Skin color: #d9a85f (tan/peach)
  - Used for headshot detection
  
- **Torso**: Box geometry (0.4 x 0.7 x 0.3) at position y=0.9
  - Cloth color: #3a5a7a (blue)
  - Main body component
  
- **Arms**: Capsule geometry (radius 0.12, length 0.5)
  - Left arm: positioned at (-0.25, 1.2, 0), rotated 0.3 rad
  - Right arm: positioned at (0.25, 1.2, 0), rotated -0.3 rad
  - Skin color: #d9a85f
  - Animate during reload and idle
  
- **Hands**: Sphere groups for weapon attachment
  - Right hand: (-0.25, 0.7, -0.2) - holds the weapon
  - Left hand: (-0.25, 0.75, -0.15)
  - Skin color: #d9a85f
  
- **Legs**: Capsule geometry (radius 0.15, length 0.45)
  - Left leg: positioned at (-0.15, 0.25, 0)
  - Right leg: positioned at (0.15, 0.25, 0)
  - Cloth color: #2a3a4a (dark blue)

### Rendering Quality
- Antialias enabled
- Better depth sorting with `renderer.sortObjects = true`
- Metalness reduced to 0.0-0.05 to minimize flickering
- Hemispherical lighting for natural appearance

---

## 2. Weapons System

### Weapon Properties
Each weapon now includes detailed visual parameters:

#### Rifle
- **Damage**: 26
- **Fire Rate**: 120ms interval
- **Magazine Size**: 30
- **Reload Time**: 1750ms
- **Visual Scale**: 0.8 x 0.3 x 2.0
- **Offset**: (0.35, 0.15, -0.3)
- **Color**: #4a5c5a (dark metallic)

#### SMG
- **Damage**: 15
- **Fire Rate**: 80ms interval (fastest)
- **Magazine Size**: 40 (largest)
- **Reload Time**: 1500ms
- **Visual Scale**: 0.6 x 0.25 x 1.4
- **Offset**: (0.3, 0.12, -0.25)
- **Color**: #5a4a5a (purple-gray)

#### Sniper
- **Damage**: 88 (highest)
- **Fire Rate**: 980ms interval (slowest)
- **Magazine Size**: 5 (smallest)
- **Reload Time**: 2200ms
- **Visual Scale**: 0.5 x 0.25 x 3.2 (longest)
- **Offset**: (0.25, 0.2, -0.4)
- **Color**: #3a4a5a (dark blue)

### Weapon Attachment
- Weapons are attached to the right hand of each player
- Different sizes create visual distinction between gun types
- Weapon models include a stock and magazine
- Automatic weapon switching with smooth attachment/detachment

---

## 3. Hit Detection & Headshots

### Server-Side Detection
The bullet system performs sophisticated hit detection:

```
Head Point: (player.x, player.y + 0.35, player.z)
Body Point: (player.x, player.y - 0.25, player.z)
```

### Headshot Multiplier
- **Headshot**: 2x damage multiplier
- **Body Shot**: 1x normal damage
- Detection is automatic based on which point is closer to the bullet path

### Example Damage Values
| Weapon | Bodyshot | Headshot |
|--------|----------|----------|
| Rifle  | 26       | 52       |
| SMG    | 15       | 30       |
| Sniper | 88       | 176      |

---

## 4. Animations

### Idle Animation
- **Breathing**: Torso gently moves up/down (±0.02 units)
- Cycle: 800ms
- Creates natural living appearance

### Reload Animation
- **Duration**: Matches weapon reload time (1500-2200ms)
- **Arm Movement**: Right arm rotates up (pitch 1.5 rad, roll 0.5 rad)
- **Progression**: Linear interpolation from 0 to 1
- **Return**: Arms smoothly return to neutral position

### Aiming Animation
- Head rotates based on pitch angle
- Subtle 30% of pitch applied to head rotation
- Creates looking-down-sights appearance

### Death Animation
- **Falling**: Body tilts and rolls
- **Duration**: 900ms (deathProgress 0→1)
- **Tilt**: Random between -1.08 and 1.08 radians
- **Roll**: Random between -0.55 and 0.55 radians
- Player remains in fallen position until respawn

---

## 5. Blue Zone Damage

### Mechanics
- Players outside the safe zone take continuous damage
- Damage starts at **12 HP/sec** and increases with distance

### Damage Calculation
```javascript
const overshoot = distance - zoneRadius;
const multiplier = 1 + clamp(overshoot / 90, 0, 1.2);
damage = 12 * multiplier * deltaTime;
```

### Progression
- At zone edge: 12 HP/sec
- 90 units beyond edge: 24 HP/sec (max 2x multiplier)
- Creates increasing pressure as zone shrinks

### Death by Zone
- Players who die to the blue zone show "Blue Zone" as killer
- Does not award the kill to any player

---

## 6. Visual Improvements

### Rendering Fixes
- **Depth Testing**: Enabled with proper write flags
- **Sorting**: Objects sorted before rendering (prevents z-fighting)
- **Metalness**: Reduced from 0.07-0.22 to 0.0-0.05 (removes flicker)
- **Material Consistency**: All terrain and props use MeshStandardMaterial
- **Transparency**: Proper depth testing for zone mesh and inner circle

### Fog
- Type: Exponential fog
- Density: 0.0016
- Color: #6f8da8 (neutral blue-gray)
- Creates atmospheric depth cues

---

## 7. Player State Tracking

### Per-Player Animation State
```javascript
{
  reloadProgress: 0-1,    // Reload animation progress
  shootTime: timestamp,   // Last shot time
  weaponSwitch: timestamp, // Last weapon switch time
  isReloading: boolean,   // Current reload status
  lastWeapon: string,     // Previous weapon
}
```

### Animation Updates Per Frame
- Reload state progresses based on server data
- Arm positions updated in real-time
- Death animations apply regardless of network state
- Idle breathing always active

---

## 8. Network Synchronization

### Server Broadcasts
Each player state includes:
- Position (x, y, z)
- Velocity (vx, vz)
- Orientation (yaw, pitch)
- Health
- Current weapon
- Ammo in magazine
- Reload time remaining
- Deaths and kills
- Alive status and respawn time
- Death animation parameters

### Client-Side Interpolation
- Weapon changes synchronized with server weapon data
- Reload timing driven by server reloadingMs value
- Position and rotation smoothly interpolated between updates

---

## 9. Kill Statistics

### Tracking
- **Kills**: Incremented when a player shoots another to death
- **Deaths**: Incremented when a player dies (any cause)
- **K/D Ratio**: Displayed in HUD

### Kill Feed
- Shows up to 8 most recent kills
- Format: `[Killer] › [Victim]`
- Includes zone kills: `Blue Zone › [Victim]`

---

## 10. Implementation Details

### Renderer Changes
- `buildPlayerBody()`: Creates detailed character model
- `buildWeapon()`: Creates weapon model with specified scaling
- `updatePlayerAnimations()`: Applies frame-by-frame animation updates
- `updatePlayerWeapon()`: Swaps weapons on player models
- `updateRemotePlayers()`: Main update loop for all visible players

### Server Changes
- Headshot detection in bullet simulation
- Damage multiplier applied based on hit location
- Weapon visual properties included in WEAPONS config
- Blue zone damage calculation with multiplier

### Client Changes
- Passes worldMeta to updateRemotePlayers for weapon data
- Player state animation tracked per remote player

---

## 11. Performance Considerations

- Capsule geometry: 4-6 segments (balanced quality/performance)
- Sphere geometry: 16 segments (smooth heads and hands)
- Box geometry: Single mesh (efficient torso)
- Animation updates: Per-frame interpolation (smooth motion)
- Headshot detection: Segment-to-point distance (fast raycasting alternative)

---

## 12. Combat Balance

### Range Effectiveness
| Weapon | Effective Range | Effective Damage |
|--------|-----------------|------------------|
| Rifle  | 130 units       | 26 (normal), 52 (head) |
| SMG    | 92 units        | 15 (normal), 30 (head) |
| Sniper | 240 units       | 88 (normal), 176 (head) |

### Engagement Scenarios
- **Close Combat**: SMG excels (fast fire rate, larger hit radius)
- **Medium Range**: Rifle balanced (good damage, decent rate)
- **Long Range**: Sniper dominates (huge damage, tight hit radius)

---

## 13. Future Enhancements

Possible additions:
- Impact effects (blood splats on headshots)
- Weapon reload sound effects
- Weapon-specific bullet tracers (different colors)
- Body part damage variations (arm/leg vs torso)
- Cosmetic skins and camos
- First-person weapon view with arm animation
- Weapon drop and pickup system
- Throwables (grenades, flashbangs)

---

## 14. Screenshots & Testing

### Test Scenarios
1. **Player Visibility**: Spawn 2+ players and verify detailed body rendering
2. **Headshots**: Stand still and have another player aim for the head
3. **Weapon Switching**: Press 1/2/3 to change weapons and verify visual changes
4. **Reloading**: Empty magazine and watch arm animation
5. **Blue Zone**: Let zone shrink and verify damage taken outside
6. **Falling**: Get killed by another player and verify death animation
7. **Performance**: Check FPS with 4+ visible players in scene

---

**Last Updated**: 2026-02-27
**Version**: 1.0
