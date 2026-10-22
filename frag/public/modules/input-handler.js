/**
 * Input handling (keyboard and mouse; on phones/tablets the on-screen
 * touch controls are attached automatically).
 */

import { normalizeAngle } from "./utils.js";
import { TouchControls, isTouchClient } from "./touch-controls.js";
import { nearestGroundWeapon, slotsOf, weaponInfo } from "./loot.js";
import { recruitContext } from "./recruit-client.js";

export class InputHandler {
  constructor(gameState, socketManager, canvas) {
    this.gameState = gameState;
    this.socketManager = socketManager;
    this.canvas = canvas;
    this.lastSentInput = "";
    this.lastSentLook = { yaw: null, pitch: null };
    // Hold-to-recruit state (F key). While set, F is "recruiting", not "vehicle".
    this.recruitHeld = null;
    this.recruitTimer = null;
    // Hold-to-fire for automatic weapons.
    this.fireHeld = false;
    this.nextAutoFireAt = 0;

    this.setupKeyboardHandlers();
    this.setupMouseHandlers();

    // Mobile/tablet: virtual joystick, look surface, fire/action buttons and
    // contextual vehicle controls. Both frag and Z+ construct InputHandler,
    // so both modes get touch support from this single hook.
    this.touchControls = isTouchClient()
      ? new TouchControls({ gameState, socketManager })
      : null;
  }

  setupKeyboardHandlers() {
    const isMovementKey = (key) =>
      ["w", "a", "s", "d", "shift", "control", "c", " ", "space", "spacebar"].includes(key);

    const flushInputIfJoined = () => {
      if (this.gameState.joined) this.sendInput();
    };

    const resetMovementInput = () => {
      this.stopRecruit();
      this.fireHeld = false;
      this.gameState.input.forward = false;
      this.gameState.input.back = false;
      this.gameState.input.left = false;
      this.gameState.input.right = false;
      this.gameState.input.sprint = false;
      this.gameState.input.jump = false;
      this.gameState.input.crouch = false;
      this.lastSentInput = "";
      flushInputIfJoined();
    };

    window.addEventListener("keydown", (e) => {
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)
      ) {
        return;
      }

      const key = e.key.toLowerCase();
      if (key === "w") this.gameState.input.forward = true;
      if (key === "s") this.gameState.input.back = true;
      if (key === "a") this.gameState.input.left = true;
      if (key === "d") this.gameState.input.right = true;
      if (key === "shift") this.gameState.input.sprint = true;
      if (key === "control" || key === "c") this.gameState.input.crouch = true;
      if (key === " " || key === "space" || key === "spacebar") this.gameState.input.jump = true;
      if (isMovementKey(key)) {
        e.preventDefault();
        flushInputIfJoined();
      }
      // 1/2/3 pick a loadout slot (whatever weapon currently sits in it).
      if (key === "1" || key === "2" || key === "3") this.socketManager.emit("switch_weapon", Number(key) - 1);
      // F is contextual: hold it on a recruitable NPC to recruit; otherwise
      // pick up a weapon at your feet; otherwise drive/exit a vehicle. E is an
      // alias. G is the passenger seat.
      if (key === "f" || key === "e") {
        if (this.recruitHeld || e.repeat) {
          e.preventDefault(); // already recruiting / key auto-repeat
        } else {
          const npc = this.findRecruitContext();
          const loot = npc ? null : this.findLootContext();
          if (npc) this.startRecruit(npc.id);
          else if (loot) this.socketManager.emit("pickup_weapon", { id: loot.id });
          else this.socketManager.emit("vehicle_toggle", { seat: "driver" });
        }
      }
      if (key === "g") this.socketManager.emit("vehicle_toggle", { seat: "passenger" });
      if (key === "v") {
        this.socketManager.emit("melee", (res) => {
          this.gameState.lastMeleeAt = Date.now();
          if (res?.ok) this.gameState.camera.recoilPitchKick -= 0.015;
        });
      }
      if (key === "r") this.socketManager.emit("reload");
      if (key === "tab") {
        e.preventDefault();
        document.getElementById("leaderboard").classList.remove("hidden");
      }
    });

    window.addEventListener("keyup", (e) => {
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)
      ) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "w") this.gameState.input.forward = false;
      if (key === "s") this.gameState.input.back = false;
      if (key === "a") this.gameState.input.left = false;
      if (key === "d") this.gameState.input.right = false;
      if (key === "shift") this.gameState.input.sprint = false;
      if (key === "control" || key === "c") this.gameState.input.crouch = false;
      if (key === " " || key === "space" || key === "spacebar") this.gameState.input.jump = false;
      if (isMovementKey(key)) {
        e.preventDefault();
        flushInputIfJoined();
      }
      if ((key === "f" || key === "e") && this.recruitHeld) this.stopRecruit();
      if (key === "tab") {
        e.preventDefault();
        document.getElementById("leaderboard").classList.add("hidden");
      }
    });

    window.addEventListener("blur", resetMovementInput);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) resetMovementInput();
    });
  }

  setupMouseHandlers() {
    const isSniperEquipped = () => {
      const state = this.gameState.latestState;
      const myId = this.gameState.myId;
      if (!state || !myId) return false;
      const me = state.players?.find((p) => p.id === myId);
      return Boolean(me && weaponInfo(this.gameState.worldMeta, me.weapon).scopeOverlay);
    };

    // window.__TEST_POINTER_LOCK lets automated (headless) test drivers aim
    // and fire where real pointer lock is unavailable.
    const isLocked = () => this.gameState.pointerLocked || window.__TEST_POINTER_LOCK;

    window.addEventListener("mousemove", (e) => {
      if (!isLocked()) return;
      const sens = this.gameState.isScoped ? 0.0012 : 0.0024;
      this.gameState.camera.yaw = normalizeAngle(
        this.gameState.camera.yaw - e.movementX * sens
      );
      this.gameState.camera.pitch = Math.max(
        -1.2,
        Math.min(1.1, this.gameState.camera.pitch - e.movementY * sens)
      );
    });

    window.addEventListener("mousedown", (e) => {
      if (!this.gameState.joined || !isLocked()) return;
      if (e.button === 0) {
        this.fireHeld = true;
        this.fireOnce();
        this.nextAutoFireAt = performance.now() + this.autoFireIntervalMs();
      }
      if (e.button === 2) {
        this.gameState.setScoped(true);
        if (isSniperEquipped()) {
          document.getElementById("scopeOverlay").classList.remove("hidden");
        }
      }
    });

    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.fireHeld = false;
      if (e.button === 2) {
        this.gameState.setScoped(false);
        document.getElementById("scopeOverlay").classList.add("hidden");
      }
    });

    window.addEventListener("contextmenu", (e) => e.preventDefault());

    // Automatic weapons keep firing while the trigger is held. The server
    // enforces the real rate (incl. LMG spin-up); this just paces requests.
    setInterval(() => {
      if (!this.fireHeld) return;
      if (!this.gameState.joined || !isLocked()) {
        this.fireHeld = false;
        return;
      }
      const now = performance.now();
      if (now < this.nextAutoFireAt || this.currentWeaponInfo().fireMode !== "auto") return;
      this.nextAutoFireAt = now + this.autoFireIntervalMs();
      this.fireOnce();
    }, 16);

    this.canvas.addEventListener("click", () => {
      try {
        const result = this.canvas.requestPointerLock();
        if (result && typeof result.catch === "function") result.catch(() => {});
      } catch (_err) {
        // Pointer lock unavailable (e.g. headless/iframe contexts).
      }
    });
  }

  getMe() {
    const st = this.gameState.latestState;
    return st?.players?.find((p) => p.id === this.gameState.myId) || null;
  }

  currentWeaponInfo() {
    return weaponInfo(this.gameState.worldMeta, this.getMe()?.weapon);
  }

  autoFireIntervalMs() {
    return Math.max(50, this.currentWeaponInfo().fireIntervalMs || 120);
  }

  /** Send current aim, then one trigger pull (recoil applied on success). */
  fireOnce() {
    const yaw = this.gameState.camera.yaw;
    const pitch = this.gameState.camera.pitch;
    this.socketManager.emit("look", { yaw, pitch });
    this.lastSentLook.yaw = yaw;
    this.lastSentLook.pitch = pitch;
    this.socketManager.emit("fire", (res) => {
      if (!res || !res.ok) return;
      this.gameState.lastFiredAt = Date.now();
      this.gameState.camera.recoilPitchKick -= res.recoilPitch || 0.03;
      this.gameState.camera.recoilYawKick += (Math.random() * 2 - 1) * (res.recoilYaw || 0.012);
    });
  }

  /** Ground weapon the player can pick up right now (not one already carried). */
  findLootContext() {
    const me = this.getMe();
    const item = nearestGroundWeapon(this.gameState.latestState, me);
    if (!item || slotsOf(me).includes(item.key)) return null;
    return item;
  }

  /** The recruit beacon if I'm standing in it (and can still recruit), else null. */
  findRecruitContext() {
    const st = this.gameState.latestState;
    const me = st?.players?.find((p) => p.id === this.gameState.myId);
    const ctx = recruitContext(st, me);
    return ctx && ctx.inRange ? { id: "beacon" } : null;
  }

  /** Begin a hold-to-recruit; re-asserts every 500ms so brief blips don't drop it. */
  startRecruit(npcId) {
    this.stopRecruit();
    this.recruitHeld = npcId;
    this.socketManager.emit("recruit_start", { npcId });
    this.recruitTimer = setInterval(() => {
      this.socketManager.emit("recruit_start", { npcId });
    }, 500);
  }

  stopRecruit() {
    if (this.recruitTimer) {
      clearInterval(this.recruitTimer);
      this.recruitTimer = null;
    }
    if (this.recruitHeld) {
      this.socketManager.emit("recruit_cancel");
      this.recruitHeld = null;
    }
  }

  sendInput() {
    if (!this.gameState.joined) return;
    // Facing is sent with movement so the server always walks us the way we look.
    const payload = { ...this.gameState.input, yaw: this.gameState.camera.yaw, pitch: this.gameState.camera.pitch };
    const serialized = `${payload.forward ? 1 : 0}${payload.back ? 1 : 0}${payload.left ? 1 : 0}${payload.right ? 1 : 0}${payload.sprint ? 1 : 0}${payload.jump ? 1 : 0}${payload.crouch ? 1 : 0}`;
    if (serialized === this.lastSentInput) {
      this.socketManager.emitVolatile("input", payload);
      return;
    }
    this.lastSentInput = serialized;
    this.socketManager.emit("input", payload);
  }

  sendLook() {
    if (!this.gameState.joined) return;
    const yaw = this.gameState.camera.yaw;
    const pitch = this.gameState.camera.pitch;
    const yawDelta = Math.abs(yaw - (this.lastSentLook.yaw !== null ? this.lastSentLook.yaw : yaw + 1));
    const pitchDelta = Math.abs(pitch - (this.lastSentLook.pitch !== null ? this.lastSentLook.pitch : pitch + 1));
    if (this.lastSentLook.yaw !== null && yawDelta < 0.002 && pitchDelta < 0.002) return;

    this.lastSentLook.yaw = yaw;
    this.lastSentLook.pitch = pitch;
    this.socketManager.emitVolatile("look", { yaw, pitch });
  }
}
