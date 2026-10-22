# Quick Start Guide - Frag Arena Development

## Project Overview

The Frag Arena game is now organized into **7 modular components** that work together to create a complete multiplayer FPS experience.

---

## File Structure Explained

```
frag/
├── public/              # All client-side files
│   ├── frag.js         # 🎯 Main coordinator (70 lines)
│   │                   #    - Initializes all modules
│   │                   #    - Sets up game loop
│   │                   #    - Coordinates systems
│   │
│   ├── modules/        # 📦 Modular components
│   │   ├── utils.js     # 🔧 Helper functions (37 lines)
│   │   ├── game-state.js  # 📊 State management (95 lines)
│   │   ├── socket-manager.js  # 🌐 Network (20 lines)
│   │   ├── input-handler.js   # ⌨️ Input control (67 lines)
│   │   ├── ui-manager.js      # 🎨 UI/HUD (95 lines)
│   │   ├── renderer.js        # 🎮 3D rendering (185 lines)
│   │   └── interpolation.js   # 🔄 Smooth movement (45 lines)
│   │
│   ├── index.html      # Game HTML template
│   └── frag.css        # Game styling
│
└── server.js           # Backend game logic (934 lines)
```

---

## Module Dependencies

```
┌─────────────┐
│  frag.js    │  Main Coordinator
└──────┬──────┘
       │
    ┌──┴──┬────────┬────────┬────────────┐
    │     │        │        │            │
    ▼     ▼        ▼        ▼            ▼
┌─────┐ ┌────┐ ┌────┐ ┌──────┐ ┌──────────┐
│Game │ │I/O │ │Socket│ │Rend │ │UI Mgr  │
│State│ │Hand│ │Mgr  │ │erer │ │        │
└─┬───┘ └────┘ └────┘ └──────┘ └──────────┘
  │
  └─► utils.js (shared)
  └─► interpolation.js
```

---

## How Each Module Works

### 1️⃣ **utils.js** - Math & Utility Functions
*Dependency: None*

```javascript
// Simple helper functions used everywhere
import { clamp, lerp, normalizeAngle } from './modules/utils.js';

clamp(5, 0, 10);        // → 5
lerp(0, 100, 0.5);      // → 50
normalizeAngle(Math.PI * 3);  // → -π
```

**When to use:**
- Math operations (clamping, interpolation, angles)
- String formatting (fmtTime)
- Browser detection (isMobileClient)

---

### 2️⃣ **game-state.js** - Central State Management
*Dependency: None (but uses utils.js internally)*

```javascript
// Store & access all game state
const gameState = new GameState();

// Set state
gameState.setPlayerId("player123");
gameState.setJoined(true);
gameState.pushState(serverState);

// Read state
const buffer = gameState.getStateBuffer();
const isJoined = gameState.joined;
const camera = gameState.camera;
```

**When to use:**
- Storing player info (ID, name, health)
- Managing camera angles
- Buffering server states
- Tracking ammo, weapons
- Recording shot IDs
- Managing tracers (bullet effects)

**Key Properties:**
- `myId` - Your player ID
- `joined` - Are you in a game?
- `input` - Movement/sprint flags
- `camera` - View angles & recoil
- `stateBuffer` - Recent game states
- `tracers` - Active bullet effects

---

### 3️⃣ **socket-manager.js** - Network Communication
*Dependency: None (but needs Socket.IO library)*

```javascript
// Handle all network communication
const socket = new SocketManager();

// Listen for events
socket.on("state", (gameState) => {
  console.log("Got update!", gameState);
});

// Send events
socket.emit("fire", (response) => {
  if (response.ok) {
    console.log("Shot fired!");
  }
});

// Check connection
if (socket.isConnected()) {
  console.log("Connected to server");
}
```

**When to use:**
- Joining a game
- Sending input data
- Receiving game updates
- Handling disconnect

**Events sent:**
- `"join"` - Join with username
- `"input"` - Movement data
- `"look"` - Camera angles
- `"fire"` - Shoot weapon
- `"switch_weapon"` - Change gun
- `"reload"` - Reload ammo
- `"ping_check"` - Measure latency

**Events received:**
- `"joined"` - Initial spawn data
- `"state"` - Game state updates
- `"disconnect"` - Disconnected

---

### 4️⃣ **input-handler.js** - Keyboard & Mouse
*Dependency: gameState, socketManager*

```javascript
// Automatically handles all input
const input = new InputHandler(gameState, socketManager, canvas);

// Handler sends data automatically:
// - 30 Hz: Movement input
// - 24 Hz: Camera angles
// - On event: Fire, scope, weapon switch
```

**What it handles:**
- Keyboard: WASD, Shift, 1/2/3, R
- Mouse: Movement, LMB (fire), RMB (scope)
- Pointer lock (click = lock mouse)

**Automatic Features:**
- Rate limiting (prevents spam)
- Recoil calculation
- Scope toggling
- Weapon switching

**When to use:**
- Any input-related feature
- Custom key bindings
- Adding new input types

---

### 5️⃣ **ui-manager.js** - HUD & User Interface
*Dependency: None (but uses DOM)*

```javascript
// Manage all UI elements
const ui = new UIManager();

// Update HUD
ui.syncHUD(gameState, playerId);
ui.updatePingUI(42);

// Update kill feed
ui.renderKillFeed(killEvents);

// Show score board
ui.renderCooldown(playerList);

// Form handling
ui.setFormSubmitHandler(() => {
  const name = ui.getPlayerName();
  // Join game
});
```

**Elements managed:**
- Entry form (join game)
- HUD (health, ammo, ping, etc.)
- Kill feed (recent kills)
- Cooldown leaderboard
- Respawn timer
- Scope overlay

**When to use:**
- Updating any UI element
- Showing/hiding panels
- Displaying game information

---

### 6️⃣ **renderer.js** - 3D Graphics (Three.js)
*Dependency: gameState, utils.js*

```javascript
// 3D rendering engine
const renderer = new Renderer(canvas);

// Build game world
renderer.buildWorld(worldMetadata);

// Spawn bullets (tracers)
const tracer = renderer.spawnTracer(shotData);
gameState.addTracer(tracer);

// Update what we see
renderer.updateCamera(state, myId, gameState, deltaTime);
renderer.updateRemotePlayers(players, myId, deltaTime);
renderer.updateZone(zoneData);

// Draw everything
renderer.render();
```

**What it renders:**
- Terrain (ground, patches)
- Props (buildings, containers)
- Zone circle (safety area)
- Remote players (capsule mesh)
- Bullets (tracer lines)
- Camera view

**Features:**
- Smooth camera interpolation
- Player model management
- Bullet tracer effects
- Zone visualization
- Auto window resize

**When to use:**
- Any visual updates
- Adding new 3D objects
- Effect rendering
- Camera manipulation

---

### 7️⃣ **interpolation.js** - Smooth Movement
*Dependency: utils.js*

```javascript
// Smooth movement between server states
import { interpState } from './modules/interpolation.js';

const smoothState = interpState(
  gameState.getStateBuffer(),
  Date.now(),
  gameState.serverOffset,
  gameState.INTERP_DELAY_MS
);

// smoothState has interpolated positions for smooth animation
```

**What it does:**
- Smooths between two server states
- Interpolates player positions
- Rotations and camera angles
- Health values
- Ammo counts

**Why needed:**
- Server sends ~20 states/second
- Want 60 FPS rendering
- Need to fill gaps between updates

**When to use:**
- Getting smooth game state for rendering
- Every render frame needs this

---

## Game Flow Diagram

```
User Opens /frag
       │
       ▼
   index.html loaded
       │
       ▼
   frag.js executes (ES modules)
       │
    ┌──┴──┬────────┬────────┬────────────┐
    ▼     ▼        ▼        ▼            ▼
Create GameState  Socket   Input UI   Renderer
       │          Mgr      Handler    Manager
       │
    Setup socket events:
    - "joined" → Got initial state
    - "state" → Got update
    - "disconnect" → Lost connection
       │
    Setup input handlers:
    - Listen to keyboard
    - Listen to mouse
    - Send input 30 Hz
    - Send look 24 Hz
       │
    Setup game loop:
    - Request animation frame
    - Interpolate state
    - Update UI
    - Update camera
    - Render 60 FPS
```

---

## Common Tasks

### Task: Update Weapon Damage Display

**File: `modules/ui-manager.js`**

```javascript
// In syncHUD method
weaponEl.textContent = `Weapon: ${weapon.name} (DMG: ${weapon.damage})`;
```

**Why?**
- UI updates belong in UIManager
- It manages all UI elements
- Keeps rendering separate from display

---

### Task: Add New Input (Crouch with C key)

**File: `modules/input-handler.js`**

```javascript
// Add to setupKeyboardHandlers()
if (key === "c") this.gameState.input.crouch = true;
```

**File: `modules/game-state.js`**

```javascript
// Add to input object
this.input = { ..., crouch: false };
```

**File: `server.js`**

```javascript
// Handle crouch on server
if (input.crouch) {
  // Reduce player height, speed, etc.
}
```

---

### Task: Display New Stat (Accuracy %)

**File: `modules/game-state.js`**

```javascript
// Add to GameState
getAccuracy() {
  return this.totalShots > 0 
    ? (this.hitShots / this.totalShots) * 100
    : 0;
}
```

**File: `modules/ui-manager.js`**

```javascript
// Add to HTML (index.html)
<span id="accuracy">Accuracy: 0%</span>

// Add to syncHUD
accuracyEl.textContent = `Accuracy: ${me.accuracy.toFixed(1)}%`;
```

---

## Debugging Checklist

✅ **Is input working?**
```javascript
// In InputHandler.setupKeyboardHandlers()
console.log("Key pressed:", key);
```

✅ **Is network data arriving?**
```javascript
// In SocketManager
this.socket.on("state", (state) => {
  console.log("Got state:", state);
});
```

✅ **Is state correct?**
```javascript
// In FragGame
console.log("Game state:", this.gameState);
```

✅ **Is interpolation smooth?**
```javascript
// In setupGameLoop()
console.log("Interpolated state:", state);
```

✅ **Is rendering working?**
```javascript
// In Renderer
console.log("Rendering...", this.scene);
```

---

## Testing Pattern

Each module can be tested independently:

```javascript
// Test game state
import { GameState } from './modules/game-state.js';
const gs = new GameState();
gs.setPlayerId("test-id");
console.assert(gs.myId === "test-id", "Player ID not set");

// Test utils
import { clamp, lerp } from './modules/utils.js';
console.assert(clamp(5, 0, 10) === 5, "Clamp broken");
console.assert(lerp(0, 10, 0.5) === 5, "Lerp broken");

// Test interpolation
import { interpState } from './modules/interpolation.js';
const smooth = interpState([], Date.now(), 0, 95);
console.assert(smooth === null, "Empty buffer should return null");
```

---

## Performance Tips

- **GameState**: Store only necessary data
- **SocketManager**: Emit only what changed
- **InputHandler**: Rate-limit input sends
- **UIManager**: Cache DOM elements
- **Renderer**: Use object pooling for effects
- **Interpolation**: Pre-calculate when possible

---

## Common Errors

| Error | Fix |
|-------|-----|
| "Cannot read property 'x' of undefined" | State buffer empty, check server connection |
| "this.socket is undefined" | SocketManager not initialized |
| "Renderer not initialized" | Canvas missing or Three.js not loaded |
| "Cannot set property input" | Check GameState initialization |
| "Module not found" | Check import paths (use `./`) |

---

## Next Steps

1. **Understand the flow**: Read this guide
2. **Explore modules**: Open each file, read comments
3. **Make a small change**: Update HUD text
4. **Add a feature**: Try weapon switching enhancement
5. **Test thoroughly**: Use browser console
6. **Deploy**: Push to production

---

## Resources

- [Complete Architecture Guide](./ARCHITECTURE.md)
- [Game README](./README.md)
- [Three.js Docs](https://threejs.org/docs/)
- [Socket.IO Docs](https://socket.io/docs/)
- [MDN Web Docs](https://developer.mozilla.org/)

---

**Happy coding! 🚀**

**Questions?** Check the modules themselves - they're well-commented!
