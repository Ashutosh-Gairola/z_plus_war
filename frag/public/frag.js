/**
 * Frag Arena - Main game controller
 * Coordinates networking, input, rendering, FPV animation context, and audio.
 */

// Must load first: converts every authored sRGB color to linear.
import "./modules/color-management.js";
import { GameState } from "./modules/game-state.js";
import { SocketManager } from "./modules/socket-manager.js";
import { InputHandler } from "./modules/input-handler.js";
import { UIManager } from "./modules/ui-manager.js";
import { Renderer } from "./modules/renderer.js";
import { AudioManager } from "./modules/audio-manager.js";
import { interpState } from "./modules/interpolation.js";
import { VehiclePredictor, applyVehiclePose } from "./modules/vehicle-prediction.js";
import { LocalPredictor } from "./modules/local-prediction.js";
import { TargetInfo } from "./modules/target-info.js";
import { normalizeAngle } from "./modules/utils.js";
import { isTouchClient } from "./modules/touch-controls.js";

const SWITCH_TOTAL_MS = 700;

class FragGame {
  constructor() {
    this.gameState = new GameState();
    this.uiManager = new UIManager();

    // Attach the join-form handler BEFORE any init that can fail. If it isn't
    // attached, pressing Continue does a native form submit and the page
    // reloads back to the entry screen with no explanation — which is exactly
    // what mobile users hit whenever boot died before reaching setupUI().
    this.setupUI();

    try {
      this.socketManager = new SocketManager();
      this.audio = new AudioManager();
    } catch (err) {
      // Most likely the socket.io CDN script failed to load (offline / blocked).
      console.error("Boot failed before socket init:", err);
      this.uiManager.updateEntryMessage(
        "Could not load game scripts — check your connection and refresh.",
      );
      return;
    }

    const canvas = document.getElementById("gameCanvas");
    try {
      this.renderer = new Renderer(canvas);
      this.predictor = new LocalPredictor();
      this.targetInfo = new TargetInfo(document.getElementById("gameScreen"));
    } catch (err) {
      console.error("Renderer construction failed:", err);
    }
    if (!this.renderer || !this.renderer.isInitialized()) {
      this.uiManager.updateEntryMessage(
        "WebGL initialization failed. Close heavy tabs/apps, enable hardware acceleration, and refresh.",
      );
      return;
    }
    this.inputHandler = new InputHandler(this.gameState, this.socketManager, canvas);
    if (this.renderer.atmosphere) {
      this.renderer.atmosphere.onThunder = (dist) => this.audio.playThunder(dist);
    }

    // Frame-to-frame trackers for audio/animation edges.
    this.lastHudUpdateAt = 0;
    this.displayedWeapon = null;
    this.prevFireStamp = 0;
    this.prevSwitchingMs = 0;
    this.prevReloadStage = { out: false, in: false, charge: false };
    this.prevReloadingMs = 0;
    this.prevInVehicle = null;
    this.prevVy = 0;
    this.stepPhase = 0;
    this.lastKillFeedAt = 0;
    this.seenVehicleEvents = new Set();
    this.lastVolleyAt = new Map(); // "shooterId:weapon" -> last shot event time (sound dedupe)
    this.lastMeHealth = undefined;
    this.prevCamYaw = 0;
    this.prevCamPitch = 0;

    this.setupSocketEvents();
    this.setupGameLoop();

    // Phones/tablets play with the on-screen touch controls (joystick, look
    // area, fire/action buttons) that InputHandler sets up automatically.
    if (isTouchClient()) {
      this.uiManager.updateEntryMessage("Touch controls enabled — rotate to landscape for the best view.");
    }

    this.uiManager.updatePingUI(null);
  }

  setupUI() {
    this.uiManager.setFormSubmitHandler(() => this.handleJoin());

    document.addEventListener("pointerlockchange", () => {
      this.gameState.setPointerLocked(this.uiManager.onPointerLockChange());
    });

    this.uiManager.voteSkipButton.addEventListener("click", () => {
      if (!this.gameState.joined || this.uiManager.votedToSkip) return;
      this.socketManager.emit("vote_skip");
      this.uiManager.votedToSkip = true;
      this.uiManager.voteSkipButton.classList.add("hidden");
    });
  }

  setupSocketEvents() {
    const ingest = (state) => {
      if (!state) return;
      if (!this.gameState.worldMeta && state.meta) {
        this.renderer.buildWorld(state.meta);
        this.gameState.setWorldMeta(state.meta);
        this.predictor.setWorld(state.meta);
        if (state.meta.structure) this.predictor.applyStructure(state.meta.structure);
        if (state.meta.structure) this.targetInfo.applyStructure(state.meta.structure);
      }
      this.gameState.pushState(state);
    };
    this.socketManager.on("joined", ingest);
    this.socketManager.on("state", ingest);
    // Building damage / collapses (sent only when something changes).
    // Structure sounds are positional: attenuate by distance to the local player.
    this.renderer.onStructureSound = (kind, pos) => {
      const me = this.gameState.latestState?.players?.find((p) => p.id === this.gameState.myId);
      const dist = me && pos ? Math.hypot(pos.x - me.x, pos.z - me.z) : 30;
      if (kind === "break") this.audio.playWallBreak(dist);
      else if (kind === "creak") this.audio.playCreak(dist);
    };
    this.socketManager.on("structure", (payload) => {
      if (this.renderer.structureView) this.renderer.applyStructure(payload);
      this.predictor.applyStructure(payload); // broken walls stop blocking my own movement too
      this.targetInfo.applyStructure(payload); // health bar for whatever I aim at
    });
    this.socketManager.on("disconnect", () => {
      this.gameState.reset();
      this.audio.stopEngine();
      this.uiManager.updatePingUI(null);
    });
  }

  handleJoin() {
    // Boot failed earlier (no renderer/socket) — keep the explanation visible
    // instead of pretending the button did nothing.
    if (!this.inputHandler || !this.socketManager) return;

    const name = this.uiManager.getPlayerName();
    if (!name) return;

    // On touch devices go full screen right away — the join tap is the user
    // gesture browsers require for the fullscreen/orientation APIs.
    if (isTouchClient()) {
      document.documentElement.requestFullscreen?.({ navigationUI: "hide" })?.catch?.(() => {});
      try {
        screen.orientation?.lock?.("landscape")?.catch?.(() => {});
      } catch (_err) {
        /* orientation lock unsupported */
      }
    }

    this.socketManager.emit("join", name, (res) => {
      if (!res || !res.ok) {
        this.uiManager.updateEntryMessage(res?.message || "Unable to join frag mode.");
        return;
      }

      this.gameState.setPlayerId(res.id);
      this.gameState.setJoined(true);
      this.uiManager.updateEntryMessage("");
      this.uiManager.startGameUI();
    });
  }

  weaponData(weaponKey) {
    return this.gameState.worldMeta?.weapons?.find((w) => w.key === weaponKey) || null;
  }

  /** Which weapon the viewmodel should display, honoring the holster phase. */
  resolveDisplayedWeapon(me) {
    if (me.switchingMs > SWITCH_TOTAL_MS * 0.5 && me.previousWeapon && me.previousWeapon !== me.weapon) {
      return me.previousWeapon;
    }
    return me.weapon;
  }

  updateAudioCues(me, state, deltaTime, justFired) {
    // Own gunshot.
    if (justFired) this.audio.playGunshot(me.weapon, 0);

    // Weapon switch start.
    if (me.switchingMs > 0 && this.prevSwitchingMs <= 0) this.audio.playWeaponSwitch();
    this.prevSwitchingMs = me.switchingMs;

    // Staged reload sounds keyed to the viewmodel choreography.
    if (me.reloadingMs > 0) {
      const total = this.weaponData(me.weapon)?.reloadMs || 1500;
      const progress = 1 - me.reloadingMs / total;
      const sfx = this.renderer.fpvWeapon?.userData?.cfg?.reloadSfx || { out: 0.2, in: 0.55, charge: 0.8 };
      if (progress >= sfx.out && !this.prevReloadStage.out) {
        this.audio.playReloadStage("out");
        this.prevReloadStage.out = true;
      }
      if (progress >= sfx.in && !this.prevReloadStage.in) {
        this.audio.playReloadStage("in");
        this.prevReloadStage.in = true;
      }
      if (progress >= sfx.charge && !this.prevReloadStage.charge) {
        this.audio.playReloadStage("charge");
        this.prevReloadStage.charge = true;
      }
    } else {
      this.prevReloadStage.out = false;
      this.prevReloadStage.in = false;
      this.prevReloadStage.charge = false;
    }
    this.prevReloadingMs = me.reloadingMs;

    // Vehicle enter/exit + engine loop (dies with no fuel or a wrecked car).
    if (me.inVehicle !== this.prevInVehicle) {
      if (this.prevInVehicle !== null) this.audio.playVehicleDoor();
      if (!me.inVehicle) this.audio.stopEngine();
      this.prevInVehicle = me.inVehicle;
    }
    if (me.inVehicle) {
      const vehicle = (state.vehicles || []).find((v) => v.id === me.inVehicle);
      if (vehicle && (vehicle.fuel ?? 100) > 0 && (vehicle.health ?? 100) > 0) {
        this.audio.setEngine(vehicle.speed);
      } else {
        this.audio.stopEngine();
      }
    }

    // Footsteps + landing.
    const speed = Math.hypot(me.vx || 0, me.vz || 0);
    const grounded = Math.abs(me.vy || 0) < 1.0;
    if (me.alive && !me.inVehicle && grounded && speed > 1.2) {
      this.stepPhase += deltaTime * speed * 0.42;
      if (this.stepPhase >= 1) {
        this.stepPhase = 0;
        this.audio.playFootstep(speed > 9);
      }
    } else {
      this.stepPhase = 0.6;
    }
    if (this.prevVy < -5 && grounded && me.alive) this.audio.playLand();
    this.prevVy = me.vy || 0;

    // Damage taken.
    if (this.lastMeHealth !== undefined && me.health < this.lastMeHealth - 0.5 && me.alive) {
      this.audio.playDamage();
      this.renderer.shakeIntensity = Math.min(0.6, this.renderer.shakeIntensity + 0.25);
    }
    this.lastMeHealth = me.health;

    // Melee swing.
    if ((me.meleeMs || 0) > (this.prevMeleeMs || 0)) this.audio.playMelee();
    this.prevMeleeMs = me.meleeMs || 0;

    // Kill confirmation.
    for (const item of state.killFeed || []) {
      if (item.at > this.lastKillFeedAt) {
        if (item.killer === me.name) this.audio.playKill();
      }
    }
    this.lastKillFeedAt = Math.max(this.lastKillFeedAt, ...(state.killFeed || []).map((k) => k.at), 0);
  }

  /**
   * Move my own player locally right away (client-side prediction); the
   * server snapshot corrects it. Everyone else stays interpolated.
   */
  predictLocalPlayer(interpolated, deltaTime) {
    if (!interpolated) return interpolated;
    const buffer = this.gameState.getStateBuffer();
    const raw = buffer[buffer.length - 1];
    if (!raw) return interpolated;
    const myId = this.gameState.myId;
    const serverMe = raw.players?.find((p) => p.id === myId);
    // Felled trees stop blocking (cheap: only when the list grows).
    const destroyed = raw.destroyedProps || [];
    if (destroyed.length !== this.lastDestroyedCount) {
      this.lastDestroyedCount = destroyed.length;
      this.predictor.markDestroyed(destroyed);
    }
    this.predictor.update({
      input: this.gameState.input,
      yaw: this.gameState.camera.yaw,
      dt: deltaTime,
      serverMe,
      snapshot: raw,
      rttMs: this.gameState.pingMs,
      canMove: (raw.phase || "playing") === "playing",
    });
    const predicted = this.predictor.applyTo(interpolated, myId);
    // Driving: my own car responds to my keys immediately (see vehicle-prediction.js).
    if (!this.vehiclePredictor) this.vehiclePredictor = new VehiclePredictor();
    const pose = this.vehiclePredictor.update({
      me: serverMe,
      snapshot: raw,
      input: this.gameState.input,
      dt: deltaTime,
      rttMs: this.gameState.pingMs,
      predictor: this.predictor,
      weather: raw.weather,
      half: this.gameState.worldMeta?.worldHalfSize,
    });
    return applyVehiclePose(predicted, pose, myId);
  }

  setupGameLoop() {
    setInterval(() => this.inputHandler.sendInput(), 1000 / 30);
    setInterval(() => this.inputHandler.sendLook(), 1000 / 24);

    setInterval(() => {
      if (!this.gameState.joined || !this.socketManager.isConnected()) return;
      const started = performance.now();
      this.socketManager.emit("ping_check", (payload) => {
        const pingMs = performance.now() - started;
        this.gameState.setPingMs(pingMs);
        if (payload && typeof payload.serverTime === "number") {
          this.gameState.recordOffset(payload.serverTime - pingMs / 2);
        }
        this.uiManager.updatePingUI(pingMs);
      });
    }, 2000);

    let lastFrameTime = performance.now();

    // A bug in any per-frame update must never freeze the game: log it
    // (throttled) and keep the loop alive.
    let lastLoopErrorAt = 0;
    const renderLoop = (now) => {
      try {
        frame(now);
      } catch (err) {
        if (performance.now() - lastLoopErrorAt > 5000) {
          lastLoopErrorAt = performance.now();
          console.error("Frame error (game continues):", err);
        }
        requestAnimationFrame(renderLoop);
      }
    };
    const frame = (now) => {
      const deltaTime = Math.min(0.05, (now - lastFrameTime) / 1000);
      lastFrameTime = now;

      if (!this.renderer.isInitialized()) {
        requestAnimationFrame(renderLoop);
        return;
      }

      const interpolated = interpState(
        this.gameState.getStateBuffer(),
        Date.now(),
        this.gameState.serverOffset,
        this.gameState.INTERP_DELAY_MS,
      );
      const state = this.predictLocalPlayer(interpolated, deltaTime);

      if (state) {
        this.gameState.setLatestState(state);
        const me = state.players.find((p) => p.id === this.gameState.myId);

        if (now - this.lastHudUpdateAt >= 120) {
          this.uiManager.syncHUD(state, this.gameState.myId, this.gameState.worldMeta);
          this.lastHudUpdateAt = now;
        }

        // Viewmodel weapon (respects the holster/draw window).
        if (me) {
          const displayWeapon = this.resolveDisplayedWeapon(me);
          if (displayWeapon !== this.displayedWeapon) {
            this.renderer.updateFPVWeapon(displayWeapon);
            this.displayedWeapon = displayWeapon;
          }
        }

        // Shot events: tracers, remote muzzle flash + distant gunfire audio.
        for (const shot of state.shotEvents || []) {
          if (this.gameState.hasShotId(shot.id)) continue;
          this.gameState.addShotId(shot.id);
          const tracer = this.renderer.spawnTracer(shot);
          this.gameState.addTracer(tracer);
          if (shot.fromId === this.gameState.myId) {
            if (shot.hitPlayerId) {
              this.uiManager.showHitMarker(shot.hitPart, shot.damage);
              this.audio.playHitMarker(shot.hitPart === "head" || shot.hitPart === "neck");
            }
          } else if (me) {
            // Pellet / fan weapons send one event per projectile: one bang per volley.
            const volleyKey = `${shot.fromId}:${shot.weapon}`;
            const lastAt = this.lastVolleyAt.get(volleyKey) || 0;
            if (shot.at - lastAt > 45) {
              this.lastVolleyAt.set(volleyKey, shot.at);
              this.renderer.spawnRemoteMuzzleFlash(shot);
              const dist = Math.hypot(shot.ox - me.x, shot.oy - me.y, shot.oz - me.z);
              this.audio.playGunshot(shot.weapon, dist);
            }
          }
        }

        // Vehicle world-interaction events: crashes + falling trees.
        for (const ev of state.vehicleEvents || []) {
          const key = `${ev.type}-${ev.at}-${ev.propId || ev.x}`;
          if (this.seenVehicleEvents.has(key)) continue;
          this.seenVehicleEvents.add(key);
          const dist = me ? Math.hypot((ev.x || 0) - me.x, (ev.z || 0) - me.z) : 999;
          if (ev.type === "crash") {
            this.renderer.spawnCrashEffect(ev.x, ev.y || 1, ev.z, ev.power || 10);
            this.audio.playCrash(ev.power || 10, dist);
            if (dist < 8) this.renderer.shakeIntensity = Math.min(0.5, this.renderer.shakeIntensity + (ev.power || 10) * 0.016);
          } else if (ev.type === "treefall") {
            this.audio.playTreeFall(dist);
          } else if (ev.type === "explosion") {
            // Aircraft (or wreck) going up — big fireball + hard shake nearby.
            this.renderer.spawnExplosionEffect(ev.x, ev.y || 1, ev.z, ev.power || 20);
            this.audio.playCrash((ev.power || 20) * 1.6, dist);
          } else if (ev.type === "collapse") {
            // A building came down: rumble + heavy shake for anyone nearby.
            this.audio.playCollapse(dist);
            if (dist < 80) this.renderer.shakeIntensity = Math.min(0.9, this.renderer.shakeIntensity + 0.6 * (1 - dist / 80));
          } else if (ev.type === "npc_arrive") {
            // Companion drop pod touches down.
            this.renderer.spawnDirtBurst(ev.x, ev.z, true);
            if (dist < 16) this.renderer.shakeIntensity = Math.min(0.5, this.renderer.shakeIntensity + 0.28);
          } else if (ev.type === "npc_down") {
            this.renderer.spawnDirtBurst(ev.x, ev.z, false);
          }
        }
        this.renderer.syncDestroyedProps(
          state.destroyedProps || [],
          (state.vehicleEvents || []).filter((e) => e.type === "treefall"),
        );

        this.renderer.updateCamera(state, this.gameState.myId, this.gameState, deltaTime);
        this.renderer.updateRemotePlayers(state.players, this.gameState.myId, deltaTime, this.gameState.worldMeta);
        this.renderer.updateVehicles(state.vehicles || [], this.gameState.myId, deltaTime);
        this.renderer.updateRiders(state.players, state.vehicles || [], this.gameState.myId, this.gameState.worldMeta, deltaTime);
        this.renderer.setWildlifeThreats(state.players);
        // Health of the wall / tree / vehicle under the crosshair.
        this.targetInfo.update({
          camera: this.renderer.camera,
          meta: this.gameState.worldMeta,
          state: this.gameState.getStateBuffer().at(-1) || state,
          me,
          weapon: this.weaponData(me?.weapon),
        });
        this.renderer.updateNpcs(state.npcs || [], deltaTime, this.gameState.worldMeta);
        this.renderer.updateRecruitBeacon(state, this.gameState.myId, deltaTime);
        this.renderer.updateGroundWeapons(state.groundWeapons || [], deltaTime, this.gameState.worldMeta);
        this.renderer.updateLiveProjectiles(state.bullets || [], deltaTime);
        this.renderer.updateZone(state.zone);
        this.renderer.updateTracersFx(this.gameState.getTracers(), deltaTime);
        this.renderer.updateStructures(deltaTime);
        this.renderer.updateWorldFlashes(deltaTime);
        this.renderer.updateEnvironmentFx(deltaTime);

        if (me) {
          const justFired = this.gameState.lastFiredAt !== this.prevFireStamp;
          this.prevFireStamp = this.gameState.lastFiredAt;

          const camYaw = this.gameState.camera.yaw;
          const camPitch = this.gameState.camera.pitch;
          const lookDeltaYaw = normalizeAngle(camYaw - this.prevCamYaw);
          const lookDeltaPitch = camPitch - this.prevCamPitch;
          this.prevCamYaw = camYaw;
          this.prevCamPitch = camPitch;

          const input = this.gameState.input;
          const moving = input.forward || input.back || input.left || input.right;
          const isSprinting = input.sprint && moving && !me.inVehicle;

          this.renderer.updateFPV(deltaTime, {
            reloadingMs: me.reloadingMs || 0,
            reloadTotalMs: this.weaponData(this.displayedWeapon || me.weapon)?.reloadMs || 1500,
            switchingMs: me.switchingMs || 0,
            switchTotalMs: SWITCH_TOTAL_MS,
            meleeMs: me.meleeMs || 0,
            justFired,
            isScoped: this.gameState.isScoped,
            isSprinting,
            // Only the driver stows their weapon; a passenger keeps it up so
            // they can shoot out of the vehicle.
            isInVehicle: Boolean(me.inVehicle) && me.seat === "driver",
            moveSpeed: Math.hypot(me.vx || 0, me.vz || 0),
            grounded: Math.abs(me.vy || 0) < 1.0,
            lookDeltaYaw,
            lookDeltaPitch,
          });

          this.updateAudioCues(me, state, deltaTime, justFired);
        }
      }

      this.renderer.setWeather(this.gameState.latestState?.weather);
      this.renderer.render();
      requestAnimationFrame(renderLoop);
    };

    requestAnimationFrame(renderLoop);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // Exposed for debugging/automated verification.
  window.__game = new FragGame();
});
