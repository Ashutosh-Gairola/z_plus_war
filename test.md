# AI Companion (NPC Recruitment) System — Implementation Plan

## Context

The game (`micro-football/frag`) is a 3D multiplayer FPS with two modes that **share one
client codebase** (`frag/public/modules/*`): **Frag** (PvP free-for-all, `frag/server.js`,
namespace `/frag`) and **Z+** (co-op zombie survival, `frag/z_plus/server.js`). We are adding
a recruitable **AI companion** system: four NPCs (Healer, Defender, Attacker, Alchemist) placed
at fixed, well-separated map locations that a player can recruit (10-second hold → drop-pod
arrival), after which they follow, auto-fight, use role abilities, and — if killed — become
re-recruitable after a 5-minute cooldown.

**Decisions locked with the user:**
- **Both modes** (Frag + Z+).
- **Phased build:** this plan delivers the **full framework + Healer + Attacker** end-to-end in
  both modes (Phase A). **Defender + Alchemist/minions** follow in Phase B (outlined at the end).

**Why this is tractable:** the codebase already contains near-exact templates —
`frag/vehicle-system.js` (a pure functional `update(env, dt, now)` subsystem whose entity array
is host-owned) and `frag/z_plus/server.js` (a full server-side NPC AI: FSM entities that spawn,
avoid obstacles, take bullet damage, damage players, and serialize with distance culling). The
client renderer already has a keep→create→update→prune entity pattern (`updateVehicles`) and the
interpolator already handles a secondary entity array (`zombies`). We reuse all of it.

## Architecture

One new **shared, mode-agnostic** server module, wired into both servers via an injected `env`
(exactly how `vehicle-system.js` is wired). All client changes land in the **shared** modules, so
both `frag.js` and `z_plus.js` get them for free.

### Mode abstraction (the one real design point)
Frag is free-for-all (no teams; "enemy" = "not me"). Z+ is co-op vs zombies. The NPC module never
knows the mode — the host injects these `env` hooks:
- `env.getAllies(npc)` → players the NPC supports. Frag: `[owner]`. Z+: all alive players.
- `env.getHostiles(npc)` → entities the NPC may attack, each `{id,x,y,z,alive,...}`. Frag: all alive
  players except owner **+** other players' NPCs/minions. Z+: alive zombies.
- `env.applyDamage(target, amount, npc, part)` → host routes to the right damage path
  (player `health -=`, zombie `damageZombie(...)`, or NPC `damageNpc(...)`).
- `env.healPlayer(player, amount)`, `env.addEvent(type, payload)` (discrete client FX, mirrors
  `vehicleEvents`), `env.emitTracer(fromId, ox,oy,oz, dx,dy,dz, dist, hit)` (reuse existing
  `addShotEvent` so NPC gunfire renders through the existing tracer/muzzle path).
- Movement/collision/world helpers are reused directly from the frag exports
  (`clamp, pointInsideObstacle, obstacleBlocksPlayer, supportHeightAt, propsNear,
  resolveObstacleCollision, rayAabbDistance, PLAYER_CONSTANTS`) — all already `module.exports`ed at
  `frag/server.js:2068-2094` and already consumed this way by `z_plus/server.js`.

### Allegiance / friendly-fire (Frag only)
No team system exists; friendly fire is prevented only by `id === self`. Minimal model:
- **NPC attacks are hitscan** (LOS check via `rayAabbDistance` against `worldProps`, then
  `env.applyDamage`) and additionally push a `shotEvent` for the visual tracer — this keeps NPC
  offense mode-agnostic and avoids threading a team field through the projectile system.
- **NPCs taking fire:** extend frag's `simulateBullets` (`frag/server.js:1664-1756`) with an
  npc/minion hit pass, skipping any NPC whose `ownerId === bullet.shooterId` (don't shoot your own
  companion). On lethal hit → start the NPC's 5-min respawn. Z+: extend the zombie-side so NPCs are
  attackable by zombies (they already can't be shot by co-op players).

## New file: `frag/npc-system.js`
Functional module (no class), mirroring `vehicle-system.js`. Exports:
- `NPC_ROLES` — per-role config. **Phase A populates `healer` + `attacker`**; `defender` +
  `alchemist` added in Phase B. Fields: `label, color, maxHealth, moveSpeed, detectRadius,
  attackRange, damage, fireIntervalMs, abilityCooldownMs`, role-specific extras
  (healer: `healRadius, healAmount, healCooldownPerPlayerMs`; attacker: `overheatMs, spreadBase,
  spreadGrowth`).
- `buildNpcSpawns(env)` — returns 4 fixed, well-separated spawn points (rejection-sampled with a
  min pairwise distance, kept off roads/props via existing `blockedSpot`-style checks and
  `pointInsideObstacle`), each assigned a role. Host stores this as the `npcs` array.
- `updateNpcFleet(env, dtSec, now)` — single per-tick entry point. Handles, per NPC: recruitment
  progress + drop-pod arrival state machine (`available → arriving → active → dead → (cooldown) →
  available`), follow/formation steering (per-owner slot offset; `resolveObstacleCollision` +
  `supportHeightAt` for obstacle-avoidance & ground), target acquisition from `env.getHostiles`,
  role behavior + ability cadence, and respawn timers.
- `serializeNpc(npc)` — compact per-client shape.

## Server wiring (both hosts, same shape as vehicles)
`frag/server.js` **and** `frag/z_plus/server.js`:
1. `require("./npc-system")` (Z+: `require("../npc-system")`).
2. Build `npcs` from `buildNpcSpawns(...)` at world init.
3. In `tick()`, after the vehicle update (frag `:1878`, z_plus `:1703`) and before/with bullets,
   call `updateNpcFleet(env, dt, now)` with the mode-specific `env`.
4. Extend the bullet/zombie damage pass so NPCs are damageable (per Allegiance section).
5. Add socket handlers `recruit_start ({npcId})` and `recruit_cancel` next to the existing
   handlers (frag `:1937` `vehicle_toggle` is the template). **Server times the 10-s hold** (robust
   vs. cheating/disconnect): progress accrues only while the player is alive and within
   `RECRUIT_RADIUS` of that NPC's home; leaving/cancelling resets it.
6. Serialize `npcs` into the snapshot (`getSnapshot`, frag `:1762-1853`) as a top-level
   `npcs: [...]`; include each NPC's `homeX/homeZ/available/respawnMs` for the minimap and
   `x/y/z/yaw/role/state/health` for world rendering + `recruitProgressMs` for the hold ring.

## Client wiring (shared modules — done once, both modes benefit)
- **`modules/renderer.js`**: add `this.npcMeshes`/`this.npcStates` maps (ctor ~`:24`);
  `getOrCreateNpcMesh(id, role)`, `updateNpcs(npcs, dt, worldMeta)`, `pruneNpcMeshes(keep)` modeled
  on `updateRemotePlayers` (`:272-318`) and `updateVehicles` (`:717-807`). Reuse
  `buildPlayerBody()` + `updatePlayerAnimations()` for humanoid NPCs, **tinted per role** (post-build
  material clone by role color — non-invasive). Healer: additive healing-aura sphere child
  (toggle/pulse like the lazy vehicle headlight beam `:771-781`). Attacker: reuse `tpMuzzleFlash`.
  Drop-pod arrival: a damped-descent pod mesh during `state==="arriving"`, with
  `spawnDirtBurst(x,z,true)` + a flash light + `shakeIntensity` on touchdown (both helpers already
  exist, currently unwired: `spawnDirtBurst :996`, `spawnBossBeacon :1026`).
- **`modules/interpolation.js`**: add an `npcs` block (and `minions` in Phase B) modeled exactly on
  the existing `zombies` block (`:69-83`) — lerp `x,y,z,yaw`, spread the rest — and add `npcs` to
  the return object (`:85-101`).
- **`modules/ui-manager.js`**: `updateRecruitPrompt(me, npcs)` modeled on `updateInteractPrompt`
  (`:135-179`), called from `syncHUD` (`:71-132`); shows "Hold **F** to Recruit" + a 10-s progress
  read from `recruitProgressMs`. Extend `renderMinimap` (`:289-422`) to plot the 4 NPC homes using
  the existing `(x+320)*scale` mapping, colored **available vs. on-cooldown** (mirror the vehicle
  `driverId` occupied/free color swap `:338`) with a per-role glyph.
- **`modules/input-handler.js`**: contextual **hold-F** recruit — when a recruitable NPC is in range
  and no vehicle is (vehicle keeps priority when both, which is rare given spawn separation), F emits
  `recruit_start` on first press (auto-repeat-guarded like the movement flags) and `recruit_cancel`
  on release/out-of-range.
- **`modules/touch-controls.js`**: a contextual `makeHoldButton("RECRUIT", …)` in a new signature-
  cached block modeled on `updateVehicleButtons` (`:751-805`), emitting the same events.
- **Render loops**: add `renderer.updateNpcs(state.npcs||[], dt, worldMeta)` after `updateVehicles`
  in **both** `frag.js` (`:338`) and `z_plus/public/z_plus.js`. NPC gunfire renders automatically via
  the existing `shotEvents` path; drop-pod/ability discrete events are consumed with the existing
  `seen…`-Set dedupe used for `vehicleEvents` (`frag.js:296-330`).
- **`frag/public/index.html`** and **`frag/z_plus/public/index.html`**: add
  `<div id="recruitPrompt" class="interact-prompt hidden"></div>` next to `#interactPrompt`; reuse
  existing `.interact-prompt` / `.hidden` CSS (no new stylesheet needed).

## Phase A deliverable (this build)
Full framework in both modes + **Healer** (aura heal of allies, 60-s per-player cooldown, weak
attack) and **Attacker** (hitscan machine gun, high DPS, 60-s overheat, accuracy falloff, slow
move). Recruit → drop pod → follow/formation → auto-fight → death → 5-min cooldown → re-recruit,
with minimap indicators, desktop hold-F, and mobile RECRUIT button.

## Phase B (next pass, after A is verified)
- **Defender** (tank): aura damage-reduction for allies in radius; destructible shield with 2-min
  regen. Adds a `shieldHp` field + a client shield-bubble mesh; damage routing consults the nearest
  ally Defender's mitigation.
- **Alchemist** (summoner): spawns 3 minions (own `minions` array + `updateMinionFleet`, serialized
  `minions[]`, interpolation block, `renderer.updateMinions`, `spawnDirtBurst(x,z,false)` on
  summon); no re-summon until all 3 die; low self-damage.

## Verification
- **Static:** `node --check frag/npc-system.js frag/server.js frag/z_plus/server.js`, and
  `node --check --input-type=module < ` each changed `frag/public/modules/*.js`.
- **Boot both servers** (`node frag/server.js` via `npm start`; confirm the Dockerfile/entry) and
  open `/frag` and the Z+ route in two browser tabs.
- **End-to-end (per the spec's own acceptance points):** confirm 4 well-separated highlighted map
  markers; walk to a Healer/Attacker, hold F (and the mobile button) 10 s → drop pod lands, NPC
  arrives; NPC follows within distance and doesn't stack on others; spawn a target (second tab
  player in frag / zombies in Z+) → Attacker fires with overheat cooldown & spread growth, Healer
  heals an ally on the 60-s/player cadence and never heals through cooldown; verify the NPC does not
  damage its owner and the owner's bullets don't kill it; kill the NPC → it vanishes, minimap flips
  to "cooldown", and after 5 min it's recruitable again at its original location.
- **Regression:** existing players/vehicles/zombies still render and interpolate; mobile FPS work
  from earlier in this session is untouched.
