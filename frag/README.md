# Frag Arena - FPS Game

A real-time multiplayer first-person shooter built with Node.js, Socket.IO, and Three.js.

## Features

✨ **Core Features:**
- Real-time multiplayer gameplay (up to 20+ players)
- First-person camera with smooth movement
- Multiple weapons with different stats (Rifle, SMG, Sniper)
- Health/death/respawn system
- Blue zone shrinking mechanic (like Fortnite/PUBG)
- Live kill feed and leaderboard
- Ping monitoring and interpolation
- Bullet tracers with visual feedback

🎮 **Game Mechanics:**
- **Movement**: WASD + Shift sprint
- **Aiming**: Mouse movement
- **Firing**: Left mouse button (hold to shoot)
- **Scope**: Right mouse button
- **Weapon Switch**: 1/2/3 keys
- **Reload**: R key
- **Pointer Lock**: Click canvas to lock mouse

🛠️ **Technical Features:**
- Client-side prediction and interpolation
- Server-authoritative hit detection
- Optimized state synchronization
- Responsive UI with HUD elements
- Mobile detection (desktop only)

---

## Setup & Running

### Prerequisites
- Node.js 14+ with npm
- Three.js library (included via CDN)

### Installation

```bash
# Navigate to project directory
cd micro-football

# Install dependencies
npm install

# Start the server
npm start
```

The game will be available at:
```
http://localhost:3000/frag
```

### Development

The game is structured with modular components in `/frag/public/modules/`:

```
frag/
├── public/
│   ├── frag.js              # Main game coordinator
│   ├── index.html           # Game UI
│   ├── frag.css             # Styles
│   └── modules/
│       ├── utils.js         # Utility functions
│       ├── game-state.js    # State management
│       ├── socket-manager.js # Networking
│       ├── input-handler.js # Input handling
│       ├── ui-manager.js    # UI management
│       ├── renderer.js      # Three.js rendering
│       └── interpolation.js # State smoothing
└── server.js                # Backend game logic
```

---

## Game Modes

### Current: Deathmatch
- Free-for-all combat
- Players respawn on death
- Zone forces players together
- Match lasts 10 minutes
- Cooldown period between matches

---

## Controls Reference

| Input | Action |
|-------|--------|
| **W** | Move forward (toward camera facing direction) |
| **A** | Move left |
| **S** | Move backward (away from camera) |
| **D** | Move right |
| **Shift** | Sprint (faster movement) |
| **Mouse Move** | Look around |
| **Left Click** | Fire weapon |
| **Right Click** | Scope/ADS (aim down sights) |
| **1** | Switch to Rifle |
| **2** | Switch to SMG |
| **3** | Switch to Sniper |
| **R** | Reload current weapon |
| **Esc** | Lock/unlock pointer |

---

## Weapons

### 🔫 **Rifle**
- **Damage**: 26 per shot
- **Fire Rate**: 120ms between shots
- **Mag Size**: 30 rounds
- **Reload Time**: 1.75s
- **Range**: 130m
- **Spread**: Moderate
- *Balanced all-around weapon*

### 🔷 **SMG**
- **Damage**: 15 per shot
- **Fire Rate**: 80ms between shots
- **Mag Size**: 40 rounds
- **Reload Time**: 1.5s
- **Range**: 92m
- **Spread**: High (close range)
- *High fire rate, close quarters*

### 🎯 **Sniper**
- **Damage**: 88 per shot
- **Fire Rate**: 980ms between shots
- **Mag Size**: 5 rounds
- **Reload Time**: 2.2s
- **Range**: 240m (longest)
- **Spread**: Minimal
- *One-shot potential, hardest to use*

---

## HUD Elements

| Element | Shows |
|---------|-------|
| **Phase** | Current game phase (Playing/Cooldown) |
| **Timer** | Time remaining in match/cooldown |
| **Health** | Current HP (0-100) |
| **Weapon** | Currently equipped gun |
| **Ammo** | Current mag / Total rounds |
| **K/D** | Kills / Deaths ratio |
| **Zone** | Safe zone radius in meters |
| **Ping** | Connection latency in ms |
| **Kill Feed** | Recent kills in match |

---

## Architecture Improvements

This version features a **complete refactor** from monolithic code into **modular components**:

### Old Structure (Before)
- Single 581-line file
- Global variables everywhere
- Tightly coupled systems
- Difficult to maintain/test

### New Structure (After)
- 7 specialized modules
- Clear separation of concerns
- Easy to test and extend
- Well-documented codebase

For detailed architecture documentation, see [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## Performance Specs

- **Render Rate**: 60 FPS target
- **Input Rate**: 30 Hz (updates)
- **Look Rate**: 24 Hz (camera sync)
- **Interpolation Delay**: 95ms
- **Max Players per Server**: ~50 (configurable)
- **Network Code**: Socket.IO with WebSocket fallback

---

## Browser Support

✅ **Recommended Browsers:**
- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

❌ **Not Supported:**
- Internet Explorer
- Mobile browsers (intentionally disabled)

---

## Troubleshooting

### "Frag mode is desktop/laptop only"
- You're using a mobile device
- Desktop gaming experience is required

### Lag/High Ping
- Check internet connection
- Move closer to server
- Reduce background network usage

### Low FPS
- Close other applications
- Lower graphics settings
- Update GPU drivers

### Weapon Not Firing
- Check ammunition count
- Wait for reload to complete
- Verify pointer is locked

### Can't Move
- Click canvas to lock pointer
- Check for stray keyboard input
- Reload page if stuck

---

## Development Notes

### Adding New Features

**New Weapon:**
1. Update server weapon stats in `server.js`
2. Update weapon display in `modules/ui-manager.js`
3. Add firing sound (if audio implemented)

**New Game Mode:**
1. Create mode logic in `server.js`
2. Update HUD display in `modules/ui-manager.js`
3. Add mode rules to interpolation if needed

**New UI Element:**
1. Add HTML element to `index.html`
2. Update `modules/ui-manager.js` to manage it
3. Style in `frag.css`

### Debugging

Enable console logging:
```javascript
// In FragGame constructor
if (process.env.DEBUG) {
  console.log("Game State:", this.gameState);
}
```

Monitor socket events:
```javascript
// In SocketManager constructor
this.socket.onAny((event, ...args) => {
  console.log("Socket:", event, args);
});
```

---

## File Sizes & Load Times

| File | Size | Purpose |
|------|------|---------|
| frag.js (main) | ~8KB | Game coordinator |
| modules/ | ~20KB | All modules combined |
| frag.css | ~8KB | Styling |
| three.js (CDN) | ~600KB | Rendering engine |
| **Total** | ~650KB | **Full game** |

**Load Time**: ~2-3 seconds on 5G/Fiber

---

## Future Roadmap

### Phase 2 (Next Sprint)
- [ ] Audio system (weapon sounds, footsteps)
- [ ] Blood effects and decals
- [ ] Weapon inspect animations
- [ ] Chat system

### Phase 3 (Later)
- [ ] Custom maps/map editor
- [ ] Ranked matchmaking
- [ ] Cosmetics system
- [ ] Replays and statistics
- [ ] Team modes (TDM, CTF)
- [ ] Streaming integration

---

## Known Limitations

1. **No Persistence**: Stats not saved between sessions
2. **No Accounts**: No login system
3. **No Sound**: Audio features not implemented
4. **Server Performance**: Optimal at ~20 players per server
5. **Mobile**: Desktop only (intentional)
6. **Graphics**: Simplified models for performance

---

## Community & Feedback

- 🐛 Found a bug? Report it!
- 💡 Got an idea? Suggest it!
- 🤝 Want to contribute? Join us!

---

## License

Build for Gigmos Solutions Pvt Ltd

---

## Credits

- **Engine**: Three.js
- **Networking**: Socket.IO
- **Backend**: Node.js + Express
- **Tech Stack**: JavaScript, WebGL

---

## Quick Stats

- **Lines of Code**: ~1000 (well-organized modules)
- **Modules**: 7 specialized components
- **Weapons**: 3 balanced options
- **Max Match Length**: 10 minutes
- **Cooldown Duration**: 3 minutes
- **Player Limit**: Theoretically unlimited (per server)

---

**Version**: 2.0 (Modular Refactor)  
**Last Updated**: February 2026  
**Status**: ✅ Playable & Tested

---

## Getting Started

1. **Start Server**: `npm start`
2. **Open Browser**: `http://localhost:3000/frag`
3. **Enter Name**: Type your player name
4. **Click Play**: Join the game
5. **Lock Pointer**: Click canvas
6. **Start Playing**: WASD to move, Mouse to aim, Click to fire

**Enjoy the game! 🎮**
