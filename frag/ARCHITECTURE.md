# Frag Arena - Modular Architecture Guide

## Overview
The Frag Arena game has been refactored from a monolithic structure into well-organized, maintainable modules. Each module has a single responsibility and can be tested/updated independently.

## Project Structure

```
frag/public/
├── frag.js                 # Main entry point (coordinator)
├── index.html             # Game UI template
├── frag.css              # Styling
├── modules/
│   ├── utils.js          # Utility functions
│   ├── game-state.js     # Game state management
│   ├── socket-manager.js # Network communication
│   ├── input-handler.js  # Keyboard & mouse input
│   ├── ui-manager.js     # HUD & UI updates
│   ├── renderer.js       # Three.js rendering
│   └── interpolation.js  # State interpolation
└── vendor/               # Third-party libs
    └── three.js          # Three.js library
```

## Module Documentation

### 1. **utils.js**
Core utility functions used across the game.

**Exports:**
- `clamp(v, min, max)` - Clamps a value between min and max
- `clamp01(v)` - Clamps a value between 0 and 1
- `normalizeAngle(rad)` - Normalizes angle to [-π, π]
- `lerp(a, b, t)` - Linear interpolation
- `lerpAngle(a, b, t)` - Angle interpolation
- `fmtTime(ms)` - Formats milliseconds to "MM:SS"
- `isMobileClient()` - Detects mobile clients

**Usage:**
```javascript
import { clamp, lerp, fmtTime } from './modules/utils.js';
```

---

### 2. **game-state.js**
Centralized game state management using a class pattern.

**Class: GameState**

**Properties:**
- Game metadata: `myId`, `joined`, `worldMeta`, `latestState`
- Rendering: `camera.yaw`, `camera.pitch`, `recoilPitchKick`, `recoilYawKick`
- Networking: `stateBuffer`, `serverOffset`, `offsetSamples`
- Combat: `seenShotIds`, `tracers`
- Input: `input` object with movement flags

**Key Methods:**
- `setPlayerId(id)` - Set player ID
- `setJoined(joined)` - Update joined state
- `pushState(state)` - Buffer game state from server
- `recordOffset(serverTime)` - Calculate server time offset
- `addShotId(id)` / `hasShotId(id)` - Track seen shots
- `addTracer(tracer)` / `removeTracer(index)` - Manage bullet tracers
- `reset()` - Clear all state (on disconnect)

**Usage:**
```javascript
import { GameState } from './modules/game-state.js';

const gameState = new GameState();
gameState.setPlayerId("player123");
gameState.pushState(serverState);
```

---

### 3. **socket-manager.js**
Encapsulates Socket.IO communication.

**Class: SocketManager**

**Methods:**
- `on(event, callback)` - Listen to socket events
- `emit(event, ...args)` - Send socket events
- `isConnected()` - Check connection status
- `disconnect()` - Close connection
- `registerHandler(event, handler)` - Register event handler
- `callHandler(event, data)` - Call registered handler

**Events Handled:**
- `"join"` - Join game with username
- `"input"` - Send player input (position, movement)
- `"look"` - Send camera angles
- `"fire"` - Send fire command
- `"switch_weapon"` - Change weapon
- `"reload"` - Reload current weapon
- `"ping_check"` - Measure ping time

**Usage:**
```javascript
import { SocketManager } from './modules/socket-manager.js';

const socket = new SocketManager();
socket.emit("join", playerName, (response) => {
  console.log(response);
});
socket.on("state", (gameState) => {
  // Handle state update
});
```

---

### 4. **input-handler.js**
Manages keyboard and mouse input.

**Class: InputHandler**

**Constructor:**
```javascript
new InputHandler(gameState, socketManager, canvas)
```

**Key Features:**
- Keyboard input (WASD, shift, 1/2/3, R)
- Mouse movement for camera control
- Mouse buttons for fire and scope
- Automatic pointer lock management
- Input rate limiting (30 Hz updates, 24 Hz look)

**Methods:**
- `sendInput()` - Send movement input to server
- `sendLook()` - Send camera angles to server

**Usage:**
```javascript
const inputHandler = new InputHandler(gameState, socketManager, canvas);
// Input events are automatically hooked up
```

---

### 5. **ui-manager.js**
Manages all UI elements and HUD updates.

**Class: UIManager**

**Managed Elements:**
- Entry screen (name input form)
- Game screen (HUD, kill feed, cooldown panel)
- Respawn notice
- Scope overlay

**Key Methods:**
- `startGameUI()` - Show game screen, hide entry
- `syncHUD(state, myId)` - Update all HUD elements
- `updatePingUI(pingMs)` - Display ping
- `renderKillFeed(feed)` - Show kill feed
- `renderCooldown(players)` - Display leaderboard
- `getPlayerName()` - Get name from input
- `setFormSubmitHandler(callback)` - Hook up join form
- `onPointerLockChange()` - Handle pointer lock changes

**Usage:**
```javascript
import { UIManager } from './modules/ui-manager.js';

const ui = new UIManager();
ui.syncHUD(gameState, playerId);
ui.updatePingUI(42);
```

---

### 6. **renderer.js**
Three.js rendering engine encapsulation.

**Class: Renderer**

**Constructor:**
```javascript
new Renderer(canvas)
```

**Key Methods:**
- `buildWorld(meta)` - Load terrain, props, zone
- `getOrCreateRemoteMesh(id)` - Get/create player model
- `spawnTracer(shot)` - Create bullet tracer line
- `updateCamera(state, myId, gameState, deltaTime)` - Update camera position/rotation
- `updateRemotePlayers(players, myId, deltaTime)` - Update remote player positions
- `updateZone(zone)` - Update zone circle mesh
- `updateTracers(tracers, deltaTime)` - Fade and remove old tracers
- `render()` - Render the scene
- `isInitialized()` - Check if renderer is ready

**Features:**
- Automatic window resize handling
- Smooth camera interpolation
- Player capsule models
- Bullet tracers with fade effect
- Zone visualization with inner circle
- Recoil animation support

**Usage:**
```javascript
const renderer = new Renderer(canvas);
renderer.buildWorld(serverMeta);
renderer.updateCamera(gameState, myId, gameState, deltaTime);
renderer.render();
```

---

### 7. **interpolation.js**
State interpolation for smooth client-side movement.

**Function: interpState()**
```javascript
interpState(stateBuffer, now, serverOffset, INTERP_DELAY_MS)
```

**Purpose:**
- Interpolates between server states for smooth movement
- Reduces jank from discrete server updates
- Uses configurable delay (95ms default) for buffer

**Returns:**
Interpolated game state with smoothed positions/rotations

**Usage:**
```javascript
import { interpState } from './modules/interpolation.js';

const smoothState = interpState(
  gameState.getStateBuffer(),
  Date.now(),
  gameState.serverOffset,
  gameState.INTERP_DELAY_MS
);
```

---

### 8. **frag.js (Main)**
Coordinates all modules into a cohesive game.

**Class: FragGame**

**Initialization:**
```javascript
new FragGame() // Automatically hooks up all systems
```

**Responsibilities:**
- Create and initialize all modules
- Set up event listeners
- Manage game loop
- Coordinate UI, input, rendering, and networking

**Game Loop Features:**
- 30 Hz input sending
- 24 Hz look direction sending
- 2 second ping checks
- 60 FPS render loop with interpolation
- Delta-time based animation

**Usage:**
Game initializes automatically when DOM loads via:
```javascript
document.addEventListener("DOMContentLoaded", () => {
  new FragGame();
});
```

---

## Architecture Diagram

```
┌─────────────────────────────────────────┐
│         User Input (Keyboard/Mouse)      │
└────────────────┬────────────────────────┘
                 │
          ┌──────▼──────────┐
          │  InputHandler   │
          └──────┬──────────┘
                 │
         ┌───────▼────────────┐
         │  FragGame (Main)   │
         └───────┬────────────┘
         ┌───────┴────────┬─────────────────────┐
         │                │                     │
    ┌────▼────┐   ┌──────▼─────┐   ┌──────────▼────┐
    │GameState│   │SocketMgr   │   │Renderer       │
    └────┬────┘   └──────┬─────┘   └───────┬──────┘
         │               │                  │
    ┌────▼┐         ┌────▼──┐        ┌────▼────┐
    │ I/O │         │Network│        │Three.js │
    │State│         │Events │        │Rendering
    └─────┘         └───────┘        └─────────┘
         │               │                  │
         └───────┬───────┴──────┬──────────┘
                 │              │
         ┌──────▼─┐      ┌─────▼────┐
         │  Utils │      │ UIManager │
         └────────┘      └───────────┘
```

---

## Data Flow

### Game Loop Sequence:
1. **Input Collection** (InputHandler)
   - Keyboard: WASD, Shift, 1/2/3, R
   - Mouse: Movement, LMB (fire), RMB (scope)

2. **Input Send** (30 Hz)
   - Send movement input to server via Socket.IO

3. **Look Send** (24 Hz)
   - Send camera angles to server

4. **Server Response** (AsNeeded)
   - Receive game state updates
   - Store in state buffer

5. **Interpolation** (Game Loop)
   - Interpolate between buffered states
   - Smooth movement across frames

6. **UI Update** (Game Loop)
   - Update HUD with health, ammo, kills/deaths
   - Update kill feed, ping display

7. **Rendering** (60 Hz Game Loop)
   - Update camera position/rotation
   - Update remote player positions
   - Update zone visualization
   - Render scene with Three.js

---

## Key Improvements Over Monolithic Code

### Before (Monolithic)
- 581 lines in single `frag.js`
- Global variables everywhere
- Hard to test individual components
- Difficult to debug
- Tightly coupled systems

### After (Modular)
- ✅ Clear separation of concerns
- ✅ Each module has single responsibility
- ✅ Easy to test modules independently
- ✅ Simple to add new features
- ✅ Clear data flow
- ✅ Reusable components
- ✅ Better error handling
- ✅ Maintainable codebase

---

## Adding New Features

### Example: Add New Weapon
1. Update server weapon config
2. Add weapon rendering in `Renderer`
3. Update ammo display in `UIManager.syncHUD()`
4. Test with existing modules

### Example: Add Chat System
1. Create `chat-manager.js`
2. Hook input in `InputHandler`
3. Render in `UIManager`
4. Integrate in `FragGame`

### Example: Add Audio
1. Create `sound-manager.js`
2. Play sounds from `InputHandler` (weapons)
3. Play from `Renderer` (shot events)
4. Initialize in `FragGame`

---

## Debugging Tips

### Trace Game State
```javascript
// In FragGame.setupGameLoop()
console.log("State:", this.gameState.getStateBuffer());
```

### Monitor Network
```javascript
// In SocketManager
this.socket.on("*", (event, data) => {
  console.log("Socket event:", event, data);
});
```

### Check Interpolation
```javascript
const smoothState = interpState(...);
console.log("Interpolated positions:", smoothState.players);
```

### Monitor FPS
```javascript
let frameCount = 0;
const startTime = performance.now();
// In render loop:
frameCount++;
if (performance.now() - startTime >= 1000) {
  console.log("FPS:", frameCount);
}}
```

---

## Performance Considerations

- **State Buffer**: Keeps last 44 states (~2.2 sec at 20 Hz)
- **Interpolation Delay**: 95ms default
- **Input Rate**: 30 Hz (33ms intervals)
- **Look Rate**: 24 Hz (42ms intervals)
- **Ping Check**: Every 2 seconds
- **Render**: 60 FPS target (game loop limiter)

**Optimization Ideas:**
- Lazy-load meshes for distant players
- Use object pooling for bullets/effects
- Implement frustum culling for props
- Cache DOM queries in UIManager

---

## Testing

Each module can be tested independently:

```javascript
// Test utils
import { clamp, lerp } from './modules/utils.js';
console.assert(clamp(5, 0, 10) === 5);
console.assert(lerp(0, 10, 0.5) === 5);

// Test GameState
import { GameState } from './modules/game-state.js';
const state = new GameState();
state.setPlayerId("test");
console.assert(state.myId === "test");
```

---

## Future Enhancements

1. **Sound System** - Add audio for weapons, impacts, footsteps
2. **Decals** - Add bullet holes and blood splats
3. **Weapon Skins** - Cosmetic weapon customization
4. **Killstreak Announcements** - Voice notifications
5. **Spectator Mode** - Watch other players after death
6. **Custom Maps** - Map editor and loading
7. **Party System** - Team up with friends
8. **Replays** - Record and playback matches
9. **Statistics Tracking** - Save player stats
10. **Ranking System** - ELO or rating based

---

**Last Updated:** February 2026
**Version:** 2.0 (Modular Refactor)
