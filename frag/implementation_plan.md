# Shooter Game Implementation Plan (`/demo/frag`)

## 1. Goal
Build a real-time multiplayer first-person shooter where players join live matches, choose a username, and shoot other players. Entry point should be `GET /demo/frag`.

## 2. Required User Flow
1. User opens `/demo/frag`.
2. Name selection UI appears.
3. User enters username and clicks continue.
4. User joins the live match and spawns inside the FPS game.

## 3. Scope (Phase 1: Playable MVP)
1. Browser FPS client with first-person camera.
2. Real-time multiplayer join/leave.
3. Player movement and shooting (with mouse right click shoot and left click on hold open scope).
4. Multiple guns (at least 3 with different damage/rate/recoil/spread).
5. Health, death, respawn loop.
6. Basic HUD (health, ammo, gun, ping, kill feed).
7. Match loop and scoreboard.

## 4. Technical Approach
1. Keep Node.js + Express + Socket.IO backend.
2. Serve dedicated frontend for `/demo/frag` from `micro-football/frag/public`.
3. Add a new Socket.IO namespace/room model for frag mode to avoid conflicts with football mode.
4. Use server-authoritative combat validation (hit, damage, death) to reduce cheating.
5. Use interpolation/extrapolation + client-side prediction for smooth movement.

## 5. Proposed File/Module Plan
1. `micro-football/server.js`
   Add `/demo/frag` route and frag socket handlers.
2. `micro-football/frag/public/index.html`
   Username screen + game canvas.
3. `micro-football/frag/public/frag.css`
   UI styles for login/HUD/scoreboard.
4. `micro-football/frag/public/frag.js`
   Input, rendering, networking, prediction, weapon handling.
5. `micro-football/frag/public/assets/*`
   Gun sprites/sounds/crosshair placeholders.
6. `micro-football/frag/README.md`
   Run instructions and controls.

## 6. Milestones
1. Milestone A: Entry + Join
   Implement `/demo/frag` page, username form, join event, spawn logic.
2. Milestone B: Core Movement + Camera
   WASD, jump/crouch , mouse look, collision bounds.
3. Milestone C: Combat
   Fire/reload/switch weapon, hit detection, health, death, respawn.
4. Milestone D: Match Systems
   Scoreboard, timer, kill feed, team/deathmatch rules.
5. Milestone E: Polish + Stability
   Net smoothing, mobile/desktop checks, latency display, reconnect flow.

## 7. Networking Design (MVP)
1. Client sends input snapshots and fire intent.
2. Server simulates positions and validates shots.
3. Server broadcasts state snapshots at fixed tick rate.
4. Client renders delayed/interpolated snapshots for remote players.
5. Ping measured with periodic ack event and shown in HUD.

## 8. Weapon Plan (Initial)
1. Rifle: medium damage, medium recoil, auto fire.
2. SMG: low damage, high fire rate, high spread.
3. Sniper: high damage, slow fire rate, low spread, scoped mode optional.

## 9. Acceptance Criteria
1. Visiting `/demo/frag` always shows username UI first.
2. After entering name, player joins active session within 1 second on local network.
3. At least 4 concurrent players can move and shoot with stable sync.
4. Kill/death and respawn cycle works without desync.
5. Ping value is visible and updates periodically.

## 10. Testing Plan
1. Unit-level checks for damage/respawn/timer logic.
2. Local multiplayer manual test with 2 to 6 browser tabs/devices.
3. Latency/jitter simulation checks for movement smoothness.
4. Route test: `/demo/frag` serves frag UI and not football UI.
5. Regression test to confirm existing football mode remains functional.

## 11. Risks and Mitigation
1. High jitter under poor network.
   Use interpolation buffer, clock offset sync, adaptive smoothing.
2. Cheating/client manipulation.
   Keep shot validation and health authority on server.
3. Performance on low-end mobile.
   Lower effects quality and cap render complexity.

## 12. Estimated Execution Order
1. Day 1: Route + username UI + join flow.
2. Day 2: Movement/camera + sync baseline.
3. Day 3: Weapons/combat + health/respawn.
4. Day 4: HUD/scoreboard/ping + polish.
5. Day 5: Test hardening + bug fixes.

## 13. Next Step After Plan Approval
Implement Milestone A only: `/demo/frag` route + username screen + successful join into empty playable arena.
