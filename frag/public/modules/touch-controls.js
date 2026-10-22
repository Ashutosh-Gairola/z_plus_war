/**
 * Mobile touch controls (self-contained ES module)
 *
 * Adds an on-screen control layer for phones/tablets:
 *   - Virtual joystick (bottom-left) driving gameState.input movement flags
 *   - Sprint pill that appears while the stick is pushed forward
 *   - Invisible "look" drag surface covering the right half of the screen
 *   - Large FIRE button with auto-repeat while held
 *   - Action cluster: JUMP / CROUCH / SCOPE / RELOAD
 *   - Weapon bar (RIFLE / SMG / SNIPER) mirroring the equipped weapon
 *   - Contextual vehicle buttons (DRIVE / SIT IN / EXIT) and aircraft
 *     UP/DOWN hold-buttons for heli/plane drivers
 *
 * The module injects its own <style id="touchControlsStyle"> element and
 * builds all DOM under <div id="touchControls"> appended to document.body.
 * Nothing outside this file needs to change: movement flags are picked up
 * by the existing 30 Hz input transmitter, and look/fire/reload/etc. go
 * through the same socket events the keyboard/mouse handler uses.
 *
 * Usage:
 *   import { isTouchClient, TouchControls } from "./touch-controls.js";
 *   if (isTouchClient()) new TouchControls({ gameState, socketManager });
 */

import { clamp, normalizeAngle } from "./utils.js";
import { nearestGroundWeapon, slotsOf, weaponInfo } from "./loot.js";
import { recruitContext } from "./recruit-client.js";

/** How close (world units) a player must be to a vehicle to enter it. */
const VEHICLE_ENTER_RADIUS = 6.5;

/** Auto-fire repeat period while FIRE is held (server enforces cooldowns). */
const FIRE_REPEAT_MS = 90;

/** UI/context poll period. */
const POLL_MS = 200;

/** Pitch limits (must match input-handler.js). */
const PITCH_MIN = -1.2;
const PITCH_MAX = 1.1;

/**
 * Look-drag sensitivity (radians per px). Halved while scoped.
 * At 0.0042 a 180° turn needed ~750px of drag — wider than the look area, so
 * aiming felt sluggish. ~0.009 turns a full 180° in a single comfortable swipe.
 */
const LOOK_SENS = 0.009;
const LOOK_SENS_SCOPED = 0.0045;

/** Joystick tuning. */
const JOY_DEADZONE = 0.22;
const JOY_AXIS_THRESHOLD = 0.3;
const JOY_SPRINT_SHOW = -0.45; // pill appears when dy < this
const JOY_SPRINT_CANCEL = -0.2; // sprint clears when dy > this

let cachedIsTouch = null;

/**
 * True when running on a touch-first device (phone/tablet). Result is cached.
 * @returns {boolean}
 */
export function isTouchClient() {
  if (cachedIsTouch !== null) return cachedIsTouch;
  const hasTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  const coarse =
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent);
  cachedIsTouch = hasTouch && coarse;
  return cachedIsTouch;
}

const STYLE_ID = "touchControlsStyle";

const CSS = `
#touchControls {
  position: fixed;
  inset: 0;
  z-index: 40;
  pointer-events: none;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
  --tc-bg: rgba(10, 14, 20, 0.42);
  --tc-border: rgba(255, 255, 255, 0.35);
  --tc-active: rgba(90, 160, 255, 0.55);
  --tc-joy-size: clamp(110px, 22vmin, 150px);
  --tc-pad-x: calc(clamp(14px, 4vmin, 30px) + env(safe-area-inset-left, 0px));
  --tc-pad-r: calc(clamp(12px, 3vmin, 24px) + env(safe-area-inset-right, 0px));
  --tc-pad-b: calc(clamp(16px, 5vmin, 34px) + env(safe-area-inset-bottom, 0px));
}
#touchControls * {
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
#touchControls.tc-hidden,
#touchControls .tc-hidden {
  display: none !important;
}

/* --- Look surface: right half of the screen, invisible, under buttons --- */
#touchControls .tc-look {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 50%;
  z-index: 1;
  pointer-events: auto;
}

/* --- Joystick --- */
#touchControls .tc-joy {
  position: absolute;
  left: var(--tc-pad-x);
  bottom: var(--tc-pad-b);
  width: var(--tc-joy-size);
  height: var(--tc-joy-size);
  border-radius: 50%;
  background: var(--tc-bg);
  border: 1.5px solid var(--tc-border);
  z-index: 2;
  pointer-events: auto;
}
#touchControls .tc-joy-thumb {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 42%;
  height: 42%;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.3);
  border: 1.5px solid var(--tc-border);
  transform: translate(-50%, -50%);
  pointer-events: none;
}

/* --- Generic button base --- */
#touchControls .tc-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--tc-bg);
  border: 1.5px solid var(--tc-border);
  color: #fff;
  font-weight: 700;
  font-size: clamp(10px, 2.2vmin, 13px);
  letter-spacing: 0.05em;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7);
  z-index: 2;
  pointer-events: auto;
}
#touchControls .tc-btn.pressed,
#touchControls .tc-btn.active {
  background: var(--tc-active);
  border-color: rgba(255, 255, 255, 0.6);
}

/* --- Sprint pill (floats above the joystick) --- */
#touchControls .tc-sprint {
  position: absolute;
  left: var(--tc-pad-x);
  bottom: calc(var(--tc-pad-b) + var(--tc-joy-size) + clamp(8px, 2vmin, 14px));
  width: var(--tc-joy-size);
  padding: clamp(7px, 1.8vmin, 11px) 0;
  border-radius: 999px;
}

/* --- FIRE button (big circle, mid-right, above the cluster) --- */
#touchControls .tc-fire {
  position: absolute;
  right: calc(var(--tc-pad-r) + clamp(26px, 7vmin, 56px));
  bottom: calc(var(--tc-pad-b) + clamp(120px, 26vmin, 190px));
  width: clamp(70px, 15vmin, 96px);
  height: clamp(70px, 15vmin, 96px);
  border-radius: 50%;
  font-size: clamp(12px, 2.6vmin, 15px);
}

/* --- Action cluster (small circles, bottom-right, 2x2) --- */
#touchControls .tc-cluster {
  position: absolute;
  right: var(--tc-pad-r);
  bottom: var(--tc-pad-b);
  display: grid;
  grid-template-columns: repeat(2, auto);
  gap: clamp(8px, 2vmin, 14px);
  z-index: 2;
  pointer-events: none;
}
#touchControls .tc-cluster .tc-btn {
  width: clamp(48px, 10vmin, 64px);
  height: clamp(48px, 10vmin, 64px);
  border-radius: 50%;
}

/* --- Weapon bar (long bar of 3 slots, bottom-center) --- */
#touchControls .tc-weaponbar {
  position: absolute;
  left: 50%;
  bottom: var(--tc-pad-b);
  transform: translateX(-50%);
  display: flex;
  gap: clamp(5px, 1.2vmin, 8px);
  padding: clamp(5px, 1.2vmin, 8px);
  border-radius: 12px;
  background: var(--tc-bg);
  border: 1.5px solid var(--tc-border);
  z-index: 2;
  pointer-events: auto;
}
#touchControls .tc-wslot {
  min-width: clamp(58px, 13vmin, 92px);
  padding: clamp(8px, 2vmin, 12px) clamp(6px, 1.5vmin, 10px);
  border-radius: 8px;
  border-width: 1px;
  background: rgba(255, 255, 255, 0.06);
}

/* --- Vehicle context buttons (top-center) --- */
#touchControls .tc-vehicle {
  position: absolute;
  left: 50%;
  top: calc(clamp(52px, 10vmin, 76px) + env(safe-area-inset-top, 0px));
  transform: translateX(-50%);
  display: flex;
  gap: clamp(8px, 2vmin, 14px);
  z-index: 2;
  pointer-events: none;
}
#touchControls .tc-vbtn {
  padding: clamp(9px, 2.2vmin, 13px) clamp(14px, 3.5vmin, 22px);
  border-radius: 999px;
  font-size: clamp(12px, 2.6vmin, 15px);
  white-space: nowrap;
}

/* --- Aircraft driver controls (stacked hold-buttons, right side) --- */
#touchControls .tc-aircraft {
  position: absolute;
  right: var(--tc-pad-r);
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: clamp(10px, 2.5vmin, 16px);
  z-index: 2;
  pointer-events: none;
}
#touchControls .tc-airbtn {
  width: clamp(58px, 12vmin, 80px);
  height: clamp(58px, 12vmin, 80px);
  border-radius: 16px;
  font-size: clamp(12px, 2.6vmin, 15px);
}

/* --- Recruit context button (top-center, below the vehicle buttons) --- */
#touchControls .tc-recruit {
  position: absolute;
  left: 50%;
  top: calc(clamp(96px, 18vmin, 132px) + env(safe-area-inset-top, 0px));
  transform: translateX(-50%);
  z-index: 2;
  pointer-events: none;
}
#touchControls .tc-recruit .tc-btn {
  padding: clamp(9px, 2.2vmin, 13px) clamp(16px, 4vmin, 26px);
  border-radius: 999px;
  font-size: clamp(12px, 2.6vmin, 15px);
  white-space: nowrap;
}
`;

/**
 * On-screen touch control layer. Construct once; it polls gameState.joined
 * every 200 ms and shows/hides itself automatically.
 */
export class TouchControls {
  /**
   * @param {{ gameState: import("./game-state.js").GameState,
   *           socketManager: import("./socket-manager.js").SocketManager }} deps
   */
  constructor({ gameState, socketManager }) {
    this.gameState = gameState;
    this.socketManager = socketManager;

    this.destroyed = false;
    this.fireTimer = null;
    this.lastFullscreenAttempt = 0;

    // Joystick/pill state.
    this.joyPointerId = null;
    this.joyDy = 0;
    this.joyForwardStrong = false;

    // Per-pointer positions for the look surface.
    this.lookPointers = new Map();

    // Context tracking for the poll loop.
    this.inVehicle = false;
    this.scopeOn = false;
    this.lastWeapon = null;
    this.lastContext = "foot"; // "foot" | "passenger" | "car" | "aircraft"
    this.vehicleSignature = "";

    // Hold-to-recruit (mobile) state.
    this.recruitSignature = "";
    this.recruitHeldId = null;
    this.recruitTimer = null;

    this.injectStyle();
    this.buildDom();
    document.body.classList.add("touch-mode");

    this.pollTimer = setInterval(() => this.tick(), POLL_MS);
  }

  /* ------------------------------------------------------------------ *
   *  Public API
   * ------------------------------------------------------------------ */

  /** Make the control layer visible. */
  show() {
    this.root.classList.remove("tc-hidden");
  }

  /** Hide the control layer and release every held input. */
  hide() {
    this.root.classList.add("tc-hidden");
    this.releaseAllInputs();
  }

  /** Tear everything down: timers, inputs, DOM, body class. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.pollTimer);
    this.releaseAllInputs();
    this.root.remove();
    document.body.classList.remove("touch-mode");
    // The shared <style> is left in place; it is id-guarded and inert.
  }

  /* ------------------------------------------------------------------ *
   *  DOM construction
   * ------------------------------------------------------------------ */

  injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  buildDom() {
    this.root = document.createElement("div");
    this.root.id = "touchControls";
    this.root.classList.add("tc-hidden"); // starts hidden; poll reveals it

    // Fullscreen + orientation lock on any interaction (throttled to 1/s).
    this.root.addEventListener(
      "pointerdown",
      () => this.maybeRequestFullscreen(),
      { capture: true }
    );

    this.buildLookSurface();
    this.buildJoystick();
    this.buildSprintPill();
    this.buildFireButton();
    this.buildActionCluster();
    this.buildWeaponBar();
    this.buildVehicleButtons();
    this.buildAircraftControls();
    this.buildRecruitButton();

    document.body.appendChild(this.root);
  }

  /** Invisible drag layer over the right half of the screen (camera look). */
  buildLookSurface() {
    const look = document.createElement("div");
    look.className = "tc-look";

    look.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.capture(look, e.pointerId);
      this.lookPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    look.addEventListener("pointermove", (e) => {
      const prev = this.lookPointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      prev.x = e.clientX;
      prev.y = e.clientY;

      const sens = this.gameState.isScoped ? LOOK_SENS_SCOPED : LOOK_SENS;
      const cam = this.gameState.camera;
      cam.yaw = normalizeAngle(cam.yaw - dx * sens);
      cam.pitch = clamp(cam.pitch - dy * sens, PITCH_MIN, PITCH_MAX);
    });
    const end = (e) => this.lookPointers.delete(e.pointerId);
    look.addEventListener("pointerup", end);
    look.addEventListener("pointercancel", end);

    this.root.appendChild(look);
  }

  buildJoystick() {
    const joy = document.createElement("div");
    joy.className = "tc-joy";
    const thumb = document.createElement("div");
    thumb.className = "tc-joy-thumb";
    joy.appendChild(thumb);
    this.joyThumb = thumb;

    const update = (e) => {
      const rect = joy.getBoundingClientRect();
      const half = rect.width / 2;
      let dx = (e.clientX - (rect.left + half)) / half;
      let dy = (e.clientY - (rect.top + half)) / half;
      const mag = Math.hypot(dx, dy);
      if (mag > 1) {
        dx /= mag;
        dy /= mag;
      }

      // Move the thumb (kept inside the ring).
      thumb.style.transform = `translate(-50%, -50%) translate(${dx * half * 0.62}px, ${dy * half * 0.62}px)`;

      const input = this.gameState.input;
      const dead = mag < JOY_DEADZONE;
      input.forward = !dead && dy < -JOY_AXIS_THRESHOLD;
      input.back = !dead && dy > JOY_AXIS_THRESHOLD;
      input.left = !dead && dx < -JOY_AXIS_THRESHOLD;
      input.right = !dead && dx > JOY_AXIS_THRESHOLD;

      this.joyDy = dead ? 0 : dy;
      this.joyForwardStrong = !dead && dy < JOY_SPRINT_SHOW;
      // Sprint cancels as soon as the stick is pulled back toward neutral.
      if (this.joyDy > JOY_SPRINT_CANCEL) input.sprint = false;
      this.updateSprintPill();
    };

    joy.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (this.joyPointerId !== null) return; // one finger drives the stick
      this.joyPointerId = e.pointerId;
      this.capture(joy, e.pointerId);
      update(e);
    });
    joy.addEventListener("pointermove", (e) => {
      if (e.pointerId === this.joyPointerId) update(e);
    });
    const release = (e) => {
      if (e.pointerId !== this.joyPointerId) return;
      this.joyPointerId = null;
      this.resetJoystick();
    };
    joy.addEventListener("pointerup", release);
    joy.addEventListener("pointercancel", release);

    this.root.appendChild(joy);
  }

  /** Recentre the thumb and clear every movement flag (incl. sprint). */
  resetJoystick() {
    this.joyThumb.style.transform = "translate(-50%, -50%)";
    const input = this.gameState.input;
    input.forward = false;
    input.back = false;
    input.left = false;
    input.right = false;
    input.sprint = false;
    this.joyDy = 0;
    this.joyForwardStrong = false;
    this.updateSprintPill();
  }

  buildSprintPill() {
    const pill = document.createElement("div");
    pill.className = "tc-btn tc-sprint tc-hidden";
    pill.textContent = "SPRINT";
    pill.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      // Only engages while the stick is actually pushed forward.
      if (this.joyForwardStrong && !this.inVehicle) {
        this.gameState.input.sprint = true;
        this.updateSprintPill();
      }
    });
    this.sprintPill = pill;
    this.root.appendChild(pill);
  }

  updateSprintPill() {
    const visible = this.joyForwardStrong && !this.inVehicle;
    this.sprintPill.classList.toggle("tc-hidden", !visible);
    this.sprintPill.classList.toggle("active", this.gameState.input.sprint);
  }

  buildFireButton() {
    const fire = document.createElement("div");
    fire.className = "tc-btn tc-fire";
    fire.textContent = "FIRE";
    let pid = null;

    fire.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (pid !== null) return;
      pid = e.pointerId;
      this.capture(fire, e.pointerId);
      fire.classList.add("pressed");
      this.fireOnce();
      this.stopFireRepeat();
      this.fireTimer = setInterval(() => this.fireOnce(), FIRE_REPEAT_MS);
    });
    const release = (e) => {
      if (e.pointerId !== pid) return;
      pid = null;
      fire.classList.remove("pressed");
      this.stopFireRepeat();
    };
    fire.addEventListener("pointerup", release);
    fire.addEventListener("pointercancel", release);

    this.fireBtn = fire;
    this.root.appendChild(fire);
  }

  /** Send current aim, then a fire request (recoil applied on success). */
  fireOnce() {
    const gs = this.gameState;
    this.socketManager.emit("look", {
      yaw: gs.camera.yaw,
      pitch: gs.camera.pitch,
    });
    this.socketManager.emit("fire", (res) => {
      if (!res || !res.ok) return;
      gs.lastFiredAt = Date.now();
      gs.camera.recoilPitchKick -= res.recoilPitch || 0.03;
      gs.camera.recoilYawKick += (Math.random() * 2 - 1) * (res.recoilYaw || 0.012);
    });
  }

  stopFireRepeat() {
    if (this.fireTimer !== null) {
      clearInterval(this.fireTimer);
      this.fireTimer = null;
    }
  }

  buildActionCluster() {
    const cluster = document.createElement("div");
    cluster.className = "tc-cluster";

    // JUMP: momentary hold.
    this.jumpBtn = this.makeHoldButton("JUMP", (held) => {
      this.gameState.input.jump = held;
    });

    // CROUCH: toggle.
    this.crouchBtn = this.makeTapButton("CROUCH", () => {
      const next = !this.gameState.input.crouch;
      this.gameState.input.crouch = next;
      this.crouchBtn.classList.toggle("active", next);
    });

    // SCOPE: toggle (sniper gets the full-screen overlay).
    this.scopeBtn = this.makeTapButton("SCOPE", () => {
      this.setScope(!this.scopeOn);
    });

    // RELOAD: single tap.
    this.reloadBtn = this.makeTapButton("RELOAD", () => {
      this.socketManager.emit("reload");
    });

    cluster.appendChild(this.jumpBtn);
    cluster.appendChild(this.crouchBtn);
    cluster.appendChild(this.scopeBtn);
    cluster.appendChild(this.reloadBtn);
    this.cluster = cluster;
    this.root.appendChild(cluster);
  }

  /** Toggle scoping; the sniper overlay only shows for the sniper rifle. */
  setScope(on) {
    this.scopeOn = on;
    this.gameState.setScoped(on);
    this.scopeBtn.classList.toggle("active", on);
    const overlay = document.getElementById("scopeOverlay");
    if (overlay) {
      const me = this.getMe();
      const showOverlay = on && Boolean(me && weaponInfo(this.gameState.worldMeta, me.weapon).scopeOverlay);
      overlay.classList.toggle("hidden", !showOverlay);
    }
  }

  buildWeaponBar() {
    const bar = document.createElement("div");
    bar.className = "tc-weaponbar";
    // Three loadout slots; labels follow whatever weapon sits in each slot.
    this.weaponSlots = [];
    for (let i = 0; i < 3; i += 1) {
      const slot = this.makeTapButton(["RIFLE", "SMG", "SNIPER"][i], () => {
        this.socketManager.emit("switch_weapon", i);
      });
      slot.classList.add("tc-wslot");
      this.weaponSlots.push(slot);
      bar.appendChild(slot);
    }
    this.weaponBar = bar;
    this.root.appendChild(bar);
  }

  buildVehicleButtons() {
    // Populated dynamically by the poll loop.
    const box = document.createElement("div");
    box.className = "tc-vehicle";
    this.vehicleBox = box;
    this.root.appendChild(box);
  }

  buildRecruitButton() {
    // Populated dynamically by the poll loop when near a recruitable NPC.
    const box = document.createElement("div");
    box.className = "tc-recruit";
    this.recruitBox = box;
    this.root.appendChild(box);
  }

  buildAircraftControls() {
    const box = document.createElement("div");
    box.className = "tc-aircraft tc-hidden";

    const up = this.makeHoldButton("▲ UP", (held) => {
      this.gameState.input.jump = held;
    });
    up.classList.add("tc-airbtn");
    const down = this.makeHoldButton("▼ DOWN", (held) => {
      this.gameState.input.crouch = held;
    });
    down.classList.add("tc-airbtn");

    box.appendChild(up);
    box.appendChild(down);
    this.aircraftBox = box;
    this.root.appendChild(box);
  }

  /* ------------------------------------------------------------------ *
   *  Button factories (pointer-event based, per-pointerId)
   * ------------------------------------------------------------------ */

  /** Circle button that fires `onTap` on pointerdown (responsive on touch). */
  makeTapButton(label, onTap) {
    const btn = document.createElement("div");
    btn.className = "tc-btn";
    btn.textContent = label;
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.capture(btn, e.pointerId);
      btn.classList.add("pressed");
      onTap();
    });
    const release = () => btn.classList.remove("pressed");
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    return btn;
  }

  /** Button that reports held state: onHold(true) on press, (false) on release. */
  makeHoldButton(label, onHold) {
    const btn = document.createElement("div");
    btn.className = "tc-btn";
    btn.textContent = label;
    let pid = null;
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (pid !== null) return;
      pid = e.pointerId;
      this.capture(btn, e.pointerId);
      btn.classList.add("pressed");
      onHold(true);
    });
    const release = (e) => {
      if (e.pointerId !== pid) return;
      pid = null;
      btn.classList.remove("pressed");
      onHold(false);
    };
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    return btn;
  }

  /** setPointerCapture that never throws (pointer may already be gone). */
  capture(el, pointerId) {
    try {
      el.setPointerCapture(pointerId);
    } catch (_err) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ *
   *  Poll loop: visibility + contextual UI
   * ------------------------------------------------------------------ */

  getMe() {
    const st = this.gameState.latestState;
    return st?.players?.find((p) => p.id === this.gameState.myId) || null;
  }

  tick() {
    // Auto show/hide with join state.
    const joined = !!this.gameState.joined;
    const hidden = this.root.classList.contains("tc-hidden");
    if (joined && hidden) this.show();
    if (!joined && !hidden) this.hide();
    if (!joined) return;

    const st = this.gameState.latestState;
    const me = this.getMe();
    const myVehicle =
      me?.inVehicle != null
        ? st?.vehicles?.find((v) => v.id === me.inVehicle) || null
        : null;

    this.inVehicle = !!me?.inVehicle;
    const isDriver = this.inVehicle && me?.seat === "driver";
    const vType = myVehicle?.type || "car";
    const isAircraftDriver = isDriver && (vType === "heli" || vType === "plane");

    // Detect context switches and clear held flags so nothing gets stuck
    // (e.g. holding UP while the aircraft controls disappear).
    const context = isDriver
      ? isAircraftDriver
        ? "aircraft"
        : "car"
      : this.inVehicle
        ? "passenger"
        : "foot";
    if (context !== this.lastContext) {
      this.lastContext = context;
      this.gameState.input.jump = false;
      this.gameState.input.crouch = false;
      this.gameState.input.sprint = false;
      this.crouchBtn.classList.remove("active");
      this.jumpBtn.classList.remove("pressed");
      if (isDriver) this.stopFireRepeat();
    }

    // Everyone can shoot from a vehicle (drive-by); drivers just lose the
    // jump/crouch cluster. Aircraft drivers get UP/DOWN.
    this.fireBtn.classList.toggle("tc-hidden", false);
    this.cluster.classList.toggle("tc-hidden", isDriver);
    this.weaponBar.classList.toggle("tc-hidden", false);
    this.aircraftBox.classList.toggle("tc-hidden", !isAircraftDriver);
    this.updateSprintPill();

    // Weapon highlight + auto-unscope when swapping away from the sniper.
    const weapon = me?.weapon || null;
    const slots = slotsOf(me);
    this.weaponSlots.forEach((slot, i) => {
      const label = weaponInfo(this.gameState.worldMeta, slots[i]).label.toUpperCase();
      if (slot.textContent !== label) slot.textContent = label;
      slot.classList.toggle("active", slots[i] === weapon);
    });
    const hasOverlay = (k) => Boolean(k && weaponInfo(this.gameState.worldMeta, k).scopeOverlay);
    if (weapon !== this.lastWeapon && hasOverlay(this.lastWeapon) && !hasOverlay(weapon) && this.scopeOn) {
      this.setScope(false);
    }
    this.lastWeapon = weapon;

    this.updateVehicleButtons(st, me, myVehicle);
    this.updateRecruitButton(st, me);
  }

  /** Rebuild the top-center vehicle buttons when the situation changes. */
  updateVehicleButtons(st, me, myVehicle) {
    let signature = "";
    let build = null;

    if (me && this.inVehicle) {
      signature = `exit:${me.inVehicle}`;
      build = () => {
        this.vehicleBox.appendChild(
          this.makeVehicleButton("⏏ EXIT", () => {
            this.socketManager.emit("vehicle_toggle", {});
          })
        );
      };
    } else if (me && me.alive) {
      // Nearest usable vehicle within enter range.
      let nearest = null;
      let nearestDist = Infinity;
      for (const v of st?.vehicles || []) {
        if (v.destroyed || !(v.health > 0)) continue;
        const dist = Math.hypot(v.x - me.x, v.z - me.z);
        if (dist <= VEHICLE_ENTER_RADIUS && dist < nearestDist) {
          nearest = v;
          nearestDist = dist;
        }
      }
      if (nearest) {
        const icon =
          nearest.type === "heli" ? "\u{1F681}" : nearest.type === "plane" ? "✈️" : "\u{1F697}";
        const canDrive = !nearest.driverId;
        const canSit = !nearest.passengerId;
        signature = `enter:${nearest.id}:${canDrive}:${canSit}`;
        build = () => {
          if (canDrive) {
            this.vehicleBox.appendChild(
              this.makeVehicleButton(`${icon} DRIVE`, () => {
                this.socketManager.emit("vehicle_toggle", { seat: "driver" });
              })
            );
          }
          if (canSit) {
            this.vehicleBox.appendChild(
              this.makeVehicleButton("\u{1F4BA} SIT IN", () => {
                this.socketManager.emit("vehicle_toggle", { seat: "passenger" });
              })
            );
          }
        };
      }
    }

    if (signature === this.vehicleSignature) return;
    this.vehicleSignature = signature;
    this.vehicleBox.textContent = ""; // drop previous buttons
    if (build) build();
  }

  makeVehicleButton(label, onTap) {
    const btn = this.makeTapButton(label, onTap);
    btn.classList.add("tc-vbtn");
    return btn;
  }

  /** Show a hold-to-recruit button when standing on a recruitable NPC. */
  updateRecruitButton(st, me) {
    let signature = "";
    let npcId = null;
    // Standing in the recruit beacon (and the party isn't full yet).
    const rc = recruitContext(st, me);
    if (rc && rc.inRange && !this.inVehicle) {
      npcId = "beacon";
      signature = "recruit:beacon";
    }
    // No NPC here: offer a weapon on the ground instead.
    let loot = null;
    if (!npcId) {
      const item = nearestGroundWeapon(st, me);
      if (item && !slotsOf(me).includes(item.key)) {
        loot = item;
        signature = `loot:${item.id}`;
      }
    }
    if (signature === this.recruitSignature) return;
    // Context changed — tear down any active hold before rebuilding.
    this.stopTouchRecruit();
    this.recruitSignature = signature;
    this.recruitBox.textContent = "";
    if (loot) {
      const label = weaponInfo(this.gameState.worldMeta, loot.key).label.toUpperCase();
      const btn = this.makeTapButton(`PICK UP ${label}`, () => {
        this.socketManager.emit("pickup_weapon", { id: loot.id });
      });
      this.recruitBox.appendChild(btn);
    } else if (npcId) {
      const btn = this.makeHoldButton("RECRUIT", (held) => {
        if (held) this.startTouchRecruit(npcId);
        else this.stopTouchRecruit();
      });
      this.recruitBox.appendChild(btn);
    }
  }

  startTouchRecruit(npcId) {
    this.stopTouchRecruit();
    this.recruitHeldId = npcId;
    this.socketManager.emit("recruit_start", { npcId });
    this.recruitTimer = setInterval(() => {
      this.socketManager.emit("recruit_start", { npcId });
    }, 500);
  }

  stopTouchRecruit() {
    if (this.recruitTimer !== null) {
      clearInterval(this.recruitTimer);
      this.recruitTimer = null;
    }
    if (this.recruitHeldId) {
      this.socketManager.emit("recruit_cancel");
      this.recruitHeldId = null;
    }
  }

  /* ------------------------------------------------------------------ *
   *  Fullscreen / cleanup helpers
   * ------------------------------------------------------------------ */

  /** Enter fullscreen + landscape on interaction, at most once per second. */
  maybeRequestFullscreen() {
    if (document.fullscreenElement) return;
    const now = Date.now();
    if (now - this.lastFullscreenAttempt < 1000) return;
    this.lastFullscreenAttempt = now;
    try {
      const p = document.documentElement.requestFullscreen({
        navigationUI: "hide",
      });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_err) {
      /* fullscreen unavailable */
    }
    try {
      const p = screen.orientation?.lock?.("landscape");
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_err) {
      /* orientation lock unavailable */
    }
  }

  /** Clear every input flag, transient timer, and pressed/active visual. */
  releaseAllInputs() {
    this.stopFireRepeat();
    this.stopTouchRecruit();
    const input = this.gameState.input;
    input.forward = false;
    input.back = false;
    input.left = false;
    input.right = false;
    input.sprint = false;
    input.jump = false;
    input.crouch = false;

    this.joyPointerId = null;
    this.lookPointers.clear();
    if (this.joyThumb) this.joyThumb.style.transform = "translate(-50%, -50%)";
    this.joyDy = 0;
    this.joyForwardStrong = false;

    if (this.scopeOn) this.setScope(false);
    for (const el of this.root.querySelectorAll(".pressed, .active")) {
      el.classList.remove("pressed", "active");
    }
    this.updateSprintPill();
  }
}
