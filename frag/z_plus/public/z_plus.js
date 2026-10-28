/**
 * Z+ zombie survival — client controller.
 * Auto-joins with a random survivor name, renders the shared frag world plus
 * the zombie horde, drives the day/night lighting, wave HUD, and audio cues.
 */

// Must load first: converts every authored sRGB color to linear.
import "../modules/color-management.js";
import { GameState } from "../modules/game-state.js";
import { SocketManager } from "../modules/socket-manager.js";
import { InputHandler } from "../modules/input-handler.js";
import { Renderer } from "../modules/renderer.js";
import { AudioManager } from "../modules/audio-manager.js";
import { interpState } from "../modules/interpolation.js";
import { VehiclePredictor, applyVehiclePose } from "../modules/vehicle-prediction.js";
import { LocalPredictor } from "../modules/local-prediction.js";
import { recruitContext } from "../modules/recruit-client.js";
import { RiftFx } from "./rift-fx.js";
import { BossFx } from "./boss-fx.js";
import { BossMarkers, bossTargets } from "./boss-marker.js";
import { normalizeAngle, fmtTime } from "../modules/utils.js";
import { isTouchClient } from "../modules/touch-controls.js";
import { buildZombieMesh, updateZombieAnimation, setZombieDetail } from "./zombie-model.js";

const SWITCH_TOTAL_MS = 700;
let WORLD_SIZE = 640; // updated from world meta

/** Compass bearing (8-wind) from `from` to `to` in world coords (-z = north). */
function bearingFrom(from, to) {
  const angle = Math.atan2(to.x - from.x, -(to.z - from.z)); // 0 = N, +90deg = E
  const winds = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round(((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return winds[idx];
}

function randomSurvivorName() {
  const adj = ["Rusty", "Silent", "Grim", "Lucky", "Feral", "Ashen", "Broken", "Swift", "Iron", "Pale"];
  const noun = ["Fox", "Wolf", "Crow", "Rat", "Hound", "Viper", "Moth", "Bear", "Hawk", "Ghost"];
  return `${adj[Math.floor(Math.random() * adj.length)]}${noun[Math.floor(Math.random() * noun.length)]}-${Math.floor(
    Math.random() * 900 + 100,
  )}`;
}

class ZPlusUI {
  constructor() {
    this.waveEl = document.getElementById("wave");
    this.cycleEl = document.getElementById("cycle");
    this.healthEl = document.getElementById("health");
    this.weaponEl = document.getElementById("weapon");
    this.ammoEl = document.getElementById("ammo");
    this.scoreEl = document.getElementById("score");
    this.killsEl = document.getElementById("kills");
    this.pingEl = document.getElementById("ping");
    this.killFeedEl = document.getElementById("killFeed");
    this.crosshairEl = document.getElementById("crosshair");
    this.damageOverlay = document.getElementById("damageOverlay");
    this.nightVignette = document.getElementById("nightVignette");
    this.zombieCounter = document.getElementById("zombieCounter");
    this.waveBanner = document.getElementById("waveBanner");
    this.leaderboardList = document.getElementById("leaderboardList");
    this.respawnNotice = document.getElementById("respawnNotice");
    this.interactPrompt = document.getElementById("interactPrompt");
    this.recruitPrompt = document.getElementById("recruitPrompt");
    this.minimapCanvas = document.getElementById("minimapCanvas");
    this.minimapCtx = this.minimapCanvas ? this.minimapCanvas.getContext("2d") : null;
    this.companionPanel = document.getElementById("companionPanel");
    this.lastHealth = 100;
  }

  /**
   * Left-side roster of the player's recruited companions: role, health bar,
   * and live combat status (attacker overheat/reload, defender shield timer or
   * regen, summoner minion count).
   */
  renderCompanionPanel(state, myId) {
    if (!this.companionPanel) return;
    const roleColor = { healer: "#37d98a", attacker: "#e8563a", defender: "#4aa0ff", summoner: "#b066ff" };
    const roleLabel = { healer: "Healer", attacker: "Attacker", defender: "Defender", summoner: "Summoner" };
    const mine = (state.npcs || []).filter(
      (n) => n.ownerId === myId && roleLabel[n.role] && (n.state === "active" || n.state === "arriving"),
    );
    if (mine.length === 0) {
      if (this.companionPanel.childElementCount) this.companionPanel.innerHTML = "";
      return;
    }
    const parts = [];
    for (const n of mine) {
      const color = roleColor[n.role] || "#88bbdd";
      const hpPct = Math.max(0, Math.min(100, Math.round((n.health / (n.maxHealth || 1)) * 100)));
      const hurt = hpPct < 45 ? " hurt" : "";
      let status = "READY";
      let cls = "good";
      if (n.state === "arriving") {
        status = "ARRIVING";
        cls = "busy";
      } else if (n.role === "attacker") {
        if (n.overheatMs > 0) {
          status = `RELOADING ${Math.ceil(n.overheatMs / 1000)}s`;
          cls = "warn";
        }
      } else if (n.role === "defender") {
        const sh = n.shield || {};
        if (sh.active) {
          status = `SHIELD ${Math.ceil((sh.ms || 0) / 1000)}s`;
          cls = "good";
        } else if (sh.cooldownMs > 0) {
          status = `REGEN ${Math.ceil(sh.cooldownMs / 1000)}s`;
          cls = "busy";
        }
      } else if (n.role === "summoner") {
        const c = n.minionCount || 0;
        const m = n.minionMax || 3;
        if (c > 0) {
          status = `MINIONS ${c}/${m}`;
          cls = "good";
        } else {
          status = "SUMMONING";
          cls = "busy";
        }
      } else if (n.role === "healer") {
        status = "AURA";
      }
      parts.push(
        `<div class="companion-card${hurt}" style="border-left-color:${color}">` +
          `<div class="row"><span class="name" style="color:${color}">${roleLabel[n.role]}</span>` +
          `<span class="status ${cls}">${status}</span></div>` +
          `<div class="hpbar"><div class="hpfill" style="width:${hpPct}%"></div></div>` +
          `</div>`,
      );
    }
    this.companionPanel.innerHTML = parts.join("");
  }

  updatePing(pingMs) {
    this.pingEl.textContent = `Ping: ${typeof pingMs === "number" ? Math.round(pingMs) : "--"} ms`;
  }

  showWaveBanner(text, sub = "") {
    this.waveBanner.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ""}`;
    this.waveBanner.classList.add("show");
    clearTimeout(this.bannerTimeout);
    this.bannerTimeout = setTimeout(() => this.waveBanner.classList.remove("show"), 3200);
  }

  flashDamage() {
    this.damageOverlay.classList.remove("active");
    void this.damageOverlay.offsetWidth;
    this.damageOverlay.classList.add("active");
    clearTimeout(this.damageTimeout);
    this.damageTimeout = setTimeout(() => this.damageOverlay.classList.remove("active"), 500);
  }

  showHitMarker(part, damage) {
    this.crosshairEl.classList.remove("hit", "critical");
    void this.crosshairEl.offsetWidth;
    this.crosshairEl.classList.add("hit");
    if (part === "head") this.crosshairEl.classList.add("critical");
    this.crosshairEl.dataset.hit = part ? `${part.toUpperCase()} ${Math.round(damage || 0)}` : "HIT";
    clearTimeout(this.hitMarkerTimeout);
    this.hitMarkerTimeout = setTimeout(() => {
      this.crosshairEl.classList.remove("hit", "critical");
      this.crosshairEl.dataset.hit = "";
    }, 230);
  }

  sync(state, myId) {
    const me = state.players.find((p) => p.id === myId);
    const wave = state.wave || {};
    const night = state.night || { f: 0, isNight: false };

    this.waveEl.textContent = wave.n > 0 ? `Wave: ${wave.n}` : "Wave: --";
    const dayNum = night.day || 1;
    this.cycleEl.textContent = night.isNight ? `Night ${dayNum}` : `Day ${dayNum}`;
    this.cycleEl.className = night.isNight ? "night" : "day";
    this.nightVignette.style.opacity = String(night.f * 0.55);

    // Time-based waves: show the live alive count plus a countdown to the
    // next wave, which always keeps coming and stacks on the survivors.
    const nextIn = wave.nextInMs !== null && wave.nextInMs !== undefined ? fmtTime(wave.nextInMs) : null;
    let counterText;
    if (wave.n === 0) {
      counterText = nextIn ? `First wave in ${nextIn}` : "";
    } else {
      counterText = `${wave.remaining} zombies`;
      if (nextIn) counterText += `  ·  Wave ${wave.n + 1} in ${nextIn}`;
    }
    // Live boss tracker: exact distance + compass direction.
    if (me) {
      const boss = (state.zombies || []).find((z) => z.boss && z.alive);
      if (boss) {
        const dist = Math.round(Math.hypot(boss.x - me.x, boss.z - me.z));
        counterText += `${counterText ? "  ·  " : ""}☠ BOSS ${dist}m ${bearingFrom(me, boss)}`;
      }
    }
    this.zombieCounter.textContent = counterText;

    // Kill feed.
    this.killFeedEl.innerHTML = "";
    for (const item of state.killFeed || []) {
      const div = document.createElement("div");
      div.className = "kill-item";
      div.textContent = `${item.killer} -> ${item.victim}`;
      this.killFeedEl.appendChild(div);
    }

    // Leaderboard by score.
    this.leaderboardList.innerHTML = "";
    const sorted = [...state.players].sort((a, b) => (b.score || 0) - (a.score || 0));
    for (let i = 0; i < sorted.length; i += 1) {
      const p = sorted[i];
      const row = document.createElement("div");
      row.className = "cooldown-row";
      row.innerHTML = `<span style="min-width:20px">${i + 1}.</span><span style="flex:1">${p.name}</span><span>${p.score || 0} pts / ${p.kills || 0}K</span>`;
      this.leaderboardList.appendChild(row);
    }

    this.renderMinimap(state, myId);
    this.renderCompanionPanel(state, myId);

    if (!me) return;
    if (me.health < this.lastHealth - 0.5) this.flashDamage();
    this.lastHealth = me.health;

    this.healthEl.textContent = `HP: ${Math.max(0, Math.round(me.health))}`;
    this.scoreEl.textContent = `Score: ${me.score || 0}`;
    this.killsEl.textContent = `Kills: ${me.kills || 0}`;
    this.weaponEl.textContent = me.inVehicle ? "Vehicle: Driving" : `Weapon: ${String(me.weapon || "rifle").toUpperCase()}`;
    this.ammoEl.textContent =
      me.reloadingMs > 0
        ? `Ammo: Reloading ${Math.ceil(me.reloadingMs / 1000)}s`
        : `Ammo: ${Math.max(0, me.ammoInMag)}/${me.magSize}`;

    if (!me.alive) {
      this.respawnNotice.textContent = `You were torn apart — respawn in ${fmtTime(me.respawnMs || 0)}`;
      this.respawnNotice.classList.remove("hidden");
    } else {
      this.respawnNotice.classList.add("hidden");
    }

    // "Press F" vehicle prompt with fuel + condition readout.
    let promptHtml = null;
    if (me.alive && me.inVehicle) {
      const v = (state.vehicles || []).find((x) => x.id === me.inVehicle);
      const fuel = v ? (v.fuel ?? 100) : 100;
      const carHp = v ? (v.health ?? 100) : 100;
      const fuelTag = fuel <= 0 ? "OUT OF FUEL" : `Fuel ${fuel}%`;
      const hpTag = carHp <= 0 ? "WRECKED" : `Car ${carHp}%`;
      promptHtml = `<b>F</b> Exit &nbsp;·&nbsp; ${fuelTag} &nbsp;·&nbsp; ${hpTag}`;
    } else if (me.alive) {
      for (const v of state.vehicles || []) {
        if (v.driverId) continue;
        if (Math.hypot(v.x - me.x, v.z - me.z) <= 6.2) {
          promptHtml = (v.health ?? 100) <= 0 ? "Wrecked — find another car" : "<b>F</b> Drive";
          break;
        }
      }
    }
    if (promptHtml) {
      if (this.interactPrompt.innerHTML !== promptHtml) this.interactPrompt.innerHTML = promptHtml;
      this.interactPrompt.classList.remove("hidden");
    } else {
      this.interactPrompt.classList.add("hidden");
    }

    // Hold-to-recruit prompt while standing in the roaming recruit beacon.
    let recruitHtml = null;
    const rc = recruitContext(state, me);
    if (this.recruitPrompt && rc && rc.inRange) {
      const pct = Math.round(Math.min(1, rc.progressMs / rc.holdMs) * 100);
      recruitHtml = pct > 0 ? `Recruiting a random companion… ${pct}%` : "<b>F</b> Hold 10s to recruit a random companion";
    }
    if (this.recruitPrompt) {
      if (recruitHtml) {
        if (this.recruitPrompt.innerHTML !== recruitHtml) this.recruitPrompt.innerHTML = recruitHtml;
        this.recruitPrompt.classList.remove("hidden");
      } else {
        this.recruitPrompt.classList.add("hidden");
      }
    }
  }

  renderMinimap(state, myId) {
    if (!this.minimapCtx) return;
    const ctx = this.minimapCtx;
    const w = this.minimapCanvas.width;
    const h = this.minimapCanvas.height;
    const scale = w / WORLD_SIZE;
    const night = state.night || { f: 0 };

    ctx.fillStyle = night.isNight ? "rgba(6, 10, 20, 0.92)" : "rgba(10, 25, 40, 0.9)";
    ctx.fillRect(0, 0, w, h);

    // Zombies: red dots; the boss is a pulsing ringed marker.
    for (const zb of state.zombies || []) {
      if (!zb.alive) continue;
      const px = (zb.x + WORLD_SIZE / 2) * scale;
      const py = (zb.z + WORLD_SIZE / 2) * scale;
      if (zb.boss) {
        const pulse = 4.5 + Math.sin(Date.now() * 0.008) * 1.6;
        ctx.strokeStyle = "#ff8c2a";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, pulse + 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "#ff8c2a";
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.fillStyle = zb.t === "flyer" ? "#c79aff" : zb.st === "chase" || zb.st === "attack" ? "#ff4136" : "rgba(255, 100, 90, 0.55)";
      ctx.beginPath();
      ctx.arc(px, py, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // The rift / the Wyrm / hatchlings.
    const rift = state.rift;
    if (rift?.vortex) {
      const px = (rift.vortex.x + WORLD_SIZE / 2) * scale;
      const py = (rift.vortex.z + WORLD_SIZE / 2) * scale;
      ctx.fillStyle = "#000";
      ctx.strokeStyle = "#c06bff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 5 + Math.sin(Date.now() * 0.01) * 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (rift?.dragon) {
      const d = rift.dragon;
      const px = (d.x + WORLD_SIZE / 2) * scale;
      const py = (d.z + WORLD_SIZE / 2) * scale;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(-d.yaw);
      ctx.fillStyle = "#7dff4a";
      ctx.strokeStyle = "#103010";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.lineTo(8, 4);
      ctx.lineTo(0, 1);
      ctx.lineTo(-8, 4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    const champ = state.champ;
    if (champ && champ.ph !== "none" && !champ.hid) {
      const px = (champ.x + WORLD_SIZE / 2) * scale;
      const py = (champ.z + WORLD_SIZE / 2) * scale;
      const pulse = 5 + Math.sin(Date.now() * 0.009) * 1.5;
      ctx.strokeStyle = "#ffcf5a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, pulse + 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#c0201a";
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const pet of rift?.pets || []) {
      if (pet[7] === 3) continue;
      ctx.fillStyle = "#ffae42";
      ctx.beginPath();
      ctx.arc((pet[1] + WORLD_SIZE / 2) * scale, (pet[3] + WORLD_SIZE / 2) * scale, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // Players: green dots (me: white ring + heading).
    for (const p of state.players || []) {
      if (!p.alive) continue;
      const px = (p.x + WORLD_SIZE / 2) * scale;
      const py = (p.z + WORLD_SIZE / 2) * scale;
      const isMe = p.id === myId;
      ctx.fillStyle = isMe ? "#4fc2ff" : "#7ddc8a";
      ctx.beginPath();
      ctx.arc(px, py, isMe ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
      if (isMe) {
        const fx = -Math.sin(p.yaw);
        const fy = -Math.cos(p.yaw);
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + fx * 9, py + fy * 9);
        ctx.stroke();
      }
    }

    // AI companions: haloed home markers when recruitable, hollow ring when on
    // cooldown, small live dots when recruited.
    const roleCss = { healer: "#37d98a", attacker: "#e8563a", defender: "#4aa0ff", summoner: "#b066ff", minion: "#ff8a3c" };
    // Recruit beacon: pulsing gold marker (hidden once my party is full).
    const meP = (state.players || []).find((p) => p.id === myId);
    const rc = recruitContext(state, meP);
    if (rc && rc.visible) {
      const bx = (rc.beacon.x + WORLD_SIZE / 2) * scale;
      const by = (rc.beacon.z + WORLD_SIZE / 2) * scale;
      ctx.strokeStyle = "rgba(255, 210, 90, 0.95)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(bx, by, 6 + Math.sin(performance.now() * 0.006) * 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#ffd45a";
      ctx.beginPath();
      ctx.arc(bx, by, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const n of state.npcs || []) {
      if (n.ownerId && n.ownerId !== myId) continue;
      const color = roleCss[n.role] || "#ffffff";
      if (n.state === "dead") {
        const hx = (n.homeX + WORLD_SIZE / 2) * scale;
        const hy = (n.homeZ + WORLD_SIZE / 2) * scale;
        ctx.strokeStyle = "rgba(160, 160, 170, 0.65)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(hx, hy, 5, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const nx = (n.x + WORLD_SIZE / 2) * scale;
        const ny = (n.z + WORLD_SIZE / 2) * scale;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(nx, ny, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.strokeStyle = "rgba(255, 81, 72, 0.6)";
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, w, h);
  }
}

class ZPlusGame {
  constructor() {
    this.gameState = new GameState();
    this.socketManager = new SocketManager("/frag-zplus");
    this.ui = new ZPlusUI();
    this.audio = new AudioManager();

    const canvas = document.getElementById("gameCanvas");
    this.renderer = new Renderer(canvas);
    this.predictor = new LocalPredictor();
    // Every 10th wave: the rift, the Undead Wyrm, mini-dragon companions.
    this.riftFx = new RiftFx({ renderer: this.renderer, audio: this.audio, root: document.getElementById("gameScreen") });
    // Waves 5, 15, 25...: champion bosses.
    this.bossFx = new BossFx({ renderer: this.renderer, audio: this.audio, root: document.getElementById("gameScreen") });
    // Name + distance marker on every boss (edge arrow when off-screen).
    this.bossMarkers = new BossMarkers(document.getElementById("gameScreen"));
    this.setupBossTestPanel();
    if (!this.renderer.isInitialized()) {
      document.getElementById("startOverlay").innerHTML =
        "<h1>WebGL failed</h1><p>Enable hardware acceleration and refresh.</p>";
      return;
    }
    this.inputHandler = new InputHandler(this.gameState, this.socketManager, canvas);
    if (this.renderer.atmosphere) {
      this.renderer.atmosphere.onThunder = (dist) => this.audio.playThunder(dist);
    }

    this.zombieMeshes = new Map();
    this.displayedWeapon = null;
    this.prevFireStamp = 0;
    this.prevSwitchingMs = 0;
    this.prevReloadStage = { out: false, in: false, charge: false };
    this.prevInVehicle = null;
    this.prevVy = 0;
    this.stepPhase = 0;
    this.prevMeleeMs = 0;
    this.lastMeHealth = undefined;
    this.prevCamYaw = 0;
    this.prevCamPitch = 0;
    this.lastHudUpdateAt = 0;
    this.lastWaveSeen = 0;
    this.seenZombieEvents = new Set();
    this.seenVehicleEvents = new Set();
    this.prevZombieAlive = new Map();
    this.nextAmbientGroanAt = 0;
    this.smoothedNight = 0;

    this.setupOverlay();
    this.setupSocketEvents();
    this.autoJoin();
    this.setupGameLoop();
  }

  setupOverlay() {
    const overlay = document.getElementById("startOverlay");
    overlay.addEventListener("click", () => {
      this.audio.ensureContext();
      if (isTouchClient()) {
        // No pointer lock on touch devices — go fullscreen instead (the tap
        // is the user gesture the fullscreen/orientation APIs require).
        document.documentElement.requestFullscreen?.({ navigationUI: "hide" })?.catch?.(() => {});
        try {
          screen.orientation?.lock?.("landscape")?.catch?.(() => {});
        } catch (_err) {
          /* orientation lock unsupported */
        }
      } else {
        document.getElementById("gameCanvas").click();
      }
      overlay.style.display = "none";
    });
    document.addEventListener("pointerlockchange", () => {
      const locked = document.pointerLockElement === document.getElementById("gameCanvas");
      this.gameState.setPointerLocked(locked);
      // Touch clients never hold pointer lock; don't nag them with the overlay.
      if (!locked && this.gameState.joined && !isTouchClient()) overlay.style.display = "flex";
      else overlay.style.display = "none";
    });
  }

  /**
   * Boss Test panel — open the game with ?bosstest=<token> (the server must
   * have ZPLUS_BOSS_TEST_TOKEN set to the same value). Summon any champion or
   * the dragon at any level, optionally with low HP, or end the fight.
   */
  setupBossTestPanel() {
    const token = new URLSearchParams(window.location.search).get("bosstest");
    if (!token) return;
    const root = document.getElementById("gameScreen") || document.body;
    const panel = document.createElement("div");
    panel.className = "boss-test";
    const bosses = [
      ["scarlet", "Seraphine"],
      ["titan", "Varkhan"],
      ["omen", "Morcant"],
      ["beast", "Kael'dris"],
      ["blood", "Sanguis"],
      ["dragon", "Undead Wyrm"],
    ];
    panel.innerHTML = `
      <div class="bt-title">Boss Test <button class="bt-min" title="Minimize">–</button></div>
      <div class="bt-body">
        <div class="bt-row">${bosses.map(([k, n]) => `<button data-kind="${k}">${n}</button>`).join("")}</div>
        <div class="bt-row">
          <label>Level <select class="bt-level">${[1, 2, 3, 4, 5].map((l) => `<option>${l}</option>`).join("")}</select></label>
          <label><input type="checkbox" class="bt-low" /> Low HP (quick test)</label>
          <button data-kind="end" class="bt-end">End fight</button>
        </div>
        <div class="bt-msg">Pick a boss to summon it near you.</div>
      </div>`;
    root.appendChild(panel);
    const msg = panel.querySelector(".bt-msg");
    panel.querySelector(".bt-min").addEventListener("click", (e) => {
      e.stopPropagation();
      panel.classList.toggle("min");
    });
    for (const btn of panel.querySelectorAll("button[data-kind]")) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        msg.textContent = "…";
        this.socketManager.emit(
          "dev_boss",
          {
            token,
            kind: btn.dataset.kind,
            level: Number(panel.querySelector(".bt-level").value),
            lowHp: panel.querySelector(".bt-low").checked,
          },
          (res) => {
            msg.textContent = res?.ok ? res.msg : `✖ ${res?.reason || "no response"}`;
            msg.classList.toggle("err", !res?.ok);
          },
        );
      });
    }
    // Clicking the panel must not grab pointer lock / fire.
    for (const ev of ["mousedown", "mouseup", "click", "pointerdown"]) panel.addEventListener(ev, (e) => e.stopPropagation());
  }

  setupSocketEvents() {
    const ingest = (state) => {
      if (!state) return;
      if (!this.gameState.worldMeta && state.meta) {
        // Survival mode has no shrink zone at all.
        if (state.meta?.worldHalfSize) WORLD_SIZE = state.meta.worldHalfSize * 2;
        // Boss + dragon models are compiled with the world (behind the load
        // screen) so a boss arriving mid-game doesn't freeze the frame.
        this.renderer.prewarmObjects = this.bossFx.prewarmModels().concat(this.riftFx.prewarmModels());
        this.renderer.buildWorld(state.meta, { zone: false });
        this.gameState.setWorldMeta(state.meta);
        this.predictor.setWorld(state.meta);
        if (state.meta.structure) {
          this.predictor.applyStructure(state.meta.structure);
        }
      }
      this.gameState.pushState(state);
    };
    this.socketManager.on("joined", ingest);
    this.socketManager.on("state", ingest);
    // Building damage / collapses (sent only when something changes): hide
    // knocked-out panels, play breaks / creaks / collapses, stop them
    // blocking my own movement, and update the wall health bar.
    this.renderer.onStructureSound = (kind, pos) => {
      const me = this.gameState.latestState?.players?.find((p) => p.id === this.gameState.myId);
      const dist = me && pos ? Math.hypot(pos.x - me.x, pos.z - me.z) : 30;
      if (kind === "break") this.audio.playWallBreak(dist);
      else if (kind === "creak") this.audio.playCreak(dist);
    };
    this.socketManager.on("structure", (payload) => {
      if (this.renderer.structureView) this.renderer.applyStructure(payload);
      this.predictor.applyStructure(payload);
    });
    this.socketManager.on("connect", () => this.autoJoin());
    this.socketManager.on("disconnect", () => {
      this.gameState.reset();
      this.audio.stopEngine();
      this.ui.updatePing(null);
    });
  }

  autoJoin() {
    if (this.gameState.joined) return;
    const name = randomSurvivorName();
    this.socketManager.emit("join", name, (res) => {
      if (!res || !res.ok) return;
      this.gameState.setPlayerId(res.id);
      this.gameState.setJoined(true);
      document.getElementById("survivorName").textContent = res.name || name;
    });
  }

  weaponData(weaponKey) {
    return this.gameState.worldMeta?.weapons?.find((w) => w.key === weaponKey) || null;
  }

  resolveDisplayedWeapon(me) {
    if (me.switchingMs > SWITCH_TOTAL_MS * 0.5 && me.previousWeapon && me.previousWeapon !== me.weapon) {
      return me.previousWeapon;
    }
    return me.weapon;
  }

  // ---- Zombie rendering ----

  updateZombies(state, me, deltaTime, now) {
    const keep = new Set();
    // Animation LOD: the limb rig is only worth animating when it's close
    // enough to read. Beyond ANIM_FAR we skip the per-joint work entirely
    // (the mesh is still positioned, and frustum-culled if off-screen); in the
    // mid band we animate at a throttled cadence. This is what keeps the frame
    // rate up when a large horde closes in on the player.
    const DETAIL_NEAR_SQ = 15 * 15; // detailed body + shadow inside this
    const ANIM_NEAR_SQ = 60 * 60; // full-rate animation
    const ANIM_FAR_SQ = 130 * 130; // beyond this: freeze the pose
    const mx = me ? me.x : 0;
    const mz = me ? me.z : 0;
    for (const zb of state.zombies || []) {
      keep.add(zb.id);
      let mesh = this.zombieMeshes.get(zb.id);
      if (!mesh) {
        mesh = buildZombieMesh(zb.t, Boolean(zb.boss), zb.id);
        this.renderer.scene.add(mesh);
        this.zombieMeshes.set(zb.id, mesh);
      }
      mesh.position.set(zb.x, zb.y, zb.z);
      mesh.rotation.y = zb.yaw + Math.PI; // models face +Z; world forward is -Z
      // Caught in the rift: flailing, tumbling up into the black hole.
      if (zb.st === "pulled") {
        const tumble = (mesh.userData.tumble = (mesh.userData.tumble || 0) + deltaTime * 3.5);
        mesh.rotation.x = Math.sin(tumble) * 1.2;
        mesh.rotation.z = Math.cos(tumble * 0.7) * 1.4;
        setZombieDetail(mesh, (zb.x - mx) ** 2 + (zb.z - mz) ** 2 > DETAIL_NEAR_SQ);
        updateZombieAnimation(mesh, { ...zb, st: "chase" }, deltaTime * 2.5);
        keep.add(zb.id);
        continue;
      } else if (mesh.userData.tumble) {
        mesh.userData.tumble = 0;
        mesh.rotation.x = 0;
        mesh.rotation.z = 0;
      }

      const distSq = (zb.x - mx) * (zb.x - mx) + (zb.z - mz) * (zb.z - mz);
      // Beyond ~15m a zombie is drawn as its low-poly stand-in (same bones and
      // animation, 1 draw call, no shadow).
      setZombieDetail(mesh, distSq > DETAIL_NEAR_SQ);
      if (distSq <= ANIM_NEAR_SQ) {
        updateZombieAnimation(mesh, zb, deltaTime);
      } else if (distSq <= ANIM_FAR_SQ) {
        // Throttle to ~every other frame; accumulate dt so stride stays smooth.
        mesh.userData.lodDt = (mesh.userData.lodDt || 0) + deltaTime;
        if ((mesh.userData.lodTick = (mesh.userData.lodTick || 0) + 1) % 2 === 0) {
          updateZombieAnimation(mesh, zb, mesh.userData.lodDt);
          mesh.userData.lodDt = 0;
        }
      }
      // else: too far to matter — leave the pose frozen.

      // Death groan once per zombie.
      const wasAlive = this.prevZombieAlive.get(zb.id);
      if (wasAlive && !zb.alive && me) {
        this.audio.playZombieDeath(Math.hypot(zb.x - me.x, zb.z - me.z));
      }
      this.prevZombieAlive.set(zb.id, zb.alive);
    }
    for (const [id, mesh] of this.zombieMeshes) {
      if (keep.has(id)) continue;
      this.renderer.scene.remove(mesh);
      this.zombieMeshes.delete(id);
      this.prevZombieAlive.delete(id);
    }

    // Ambient groans from nearby wanderers.
    if (me && now > this.nextAmbientGroanAt) {
      this.nextAmbientGroanAt = now + 2200 + Math.random() * 2600;
      const near = (state.zombies || []).filter((zb) => zb.alive && Math.hypot(zb.x - me.x, zb.z - me.z) < 42);
      if (near.length) {
        const zb = near[Math.floor(Math.random() * near.length)];
        this.audio.playZombieGroan(Math.hypot(zb.x - me.x, zb.z - me.z));
      }
    }
  }

  handleZombieEvents(state, me) {
    for (const ev of state.zombieEvents || []) {
      const key = `${ev.type}-${ev.at}-${ev.x}`;
      if (this.seenZombieEvents.has(key)) continue;
      this.seenZombieEvents.add(key);
      if (this.seenZombieEvents.size > 200) {
        this.seenZombieEvents = new Set(Array.from(this.seenZombieEvents).slice(-80));
      }
      const dist = me ? Math.hypot(ev.x - me.x, ev.z - me.z) : 999;
      if (ev.type === "scream") this.audio.playZombieScream(dist);
      else if (ev.type === "attack" && dist < 26) this.audio.playZombieAttack(dist);
      else if (ev.type === "emerge") {
        this.renderer.spawnDirtBurst(ev.x, ev.z, Boolean(ev.boss));
        // Throttle so a whole wave emerging doesn't stack 30 rumbles.
        if (dist < 70 && performance.now() - (this.lastEmergeSoundAt || 0) > 280) {
          this.lastEmergeSoundAt = performance.now();
          this.audio.playEmerge(dist);
        }
      } else if (ev.type === "summon") {
        this.audio.playSummon(dist);
        if (dist < 30) this.ui.showWaveBanner("REINFORCEMENTS INBOUND", "they burst from the ground around you");
      } else if (ev.type === "horde") {
        this.ui.showWaveBanner("THE HORDE HAS YOUR SCENT", "every zombie now knows where you are");
        // A ragged chorus of groans rolls across the map.
        for (let i = 0; i < 3; i += 1) {
          setTimeout(() => this.audio.playZombieGroan(12 + Math.random() * 25), i * 420);
        }
      } else if (ev.type === "boss") {
        this.renderer.spawnBossBeacon(ev.x, ev.z);
        this.audio.playBossRoar();
        const where = me ? `${Math.round(dist)}m ${bearingFrom(me, ev)}` : "";
        this.ui.showWaveBanner("☠ TANK BOSS HAS RISEN", `follow the red beacon — ${where}`);
      } else if (ev.type === "wave") {
        this.ui.showWaveBanner(`WAVE ${ev.wave}`, state.night?.isNight ? "THE NIGHT DOUBLES THEM" : "");
        this.audio.playWaveHorn();
      }
    }
  }

  updateAudioCues(me, state, deltaTime, justFired) {
    if (justFired) this.audio.playGunshot(me.weapon, 0);

    if (me.switchingMs > 0 && this.prevSwitchingMs <= 0) this.audio.playWeaponSwitch();
    this.prevSwitchingMs = me.switchingMs;

    if (me.reloadingMs > 0) {
      const total = this.weaponData(me.weapon)?.reloadMs || 1500;
      const progress = 1 - me.reloadingMs / total;
      const sfx = this.renderer.fpvWeapon?.userData?.cfg?.reloadSfx || { out: 0.2, in: 0.55, charge: 0.8 };
      for (const stage of ["out", "in", "charge"]) {
        if (progress >= sfx[stage] && !this.prevReloadStage[stage]) {
          this.audio.playReloadStage(stage);
          this.prevReloadStage[stage] = true;
        }
      }
    } else {
      this.prevReloadStage.out = false;
      this.prevReloadStage.in = false;
      this.prevReloadStage.charge = false;
    }

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

    if ((me.meleeMs || 0) > (this.prevMeleeMs || 0)) this.audio.playMelee();
    this.prevMeleeMs = me.meleeMs || 0;

    if (this.lastMeHealth !== undefined && me.health < this.lastMeHealth - 0.5 && me.alive) {
      this.audio.playDamage();
      this.renderer.shakeIntensity = Math.min(0.6, this.renderer.shakeIntensity + 0.22);
    }
    this.lastMeHealth = me.health;
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
      canMove: true,
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
      this.socketManager.emit("ping_check", () => {
        const pingMs = performance.now() - started;
        this.gameState.setPingMs(pingMs);
        this.ui.updatePing(pingMs);
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

        // Smooth the day/night factor a touch on top of server dusk windows.
        const targetNight = state.night ? state.night.f : 0;
        this.smoothedNight += (targetNight - this.smoothedNight) * Math.min(1, deltaTime * 2);
        this.renderer.setDayNight(this.smoothedNight);

        if (now - this.lastHudUpdateAt >= 120) {
          this.ui.sync(state, this.gameState.myId);
          this.lastHudUpdateAt = now;
        }

        if (me) {
          const displayWeapon = this.resolveDisplayedWeapon(me);
          if (displayWeapon !== this.displayedWeapon) {
            this.renderer.updateFPVWeapon(displayWeapon);
            this.displayedWeapon = displayWeapon;
          }
        }

        for (const shot of state.shotEvents || []) {
          if (this.gameState.hasShotId(shot.id)) continue;
          this.gameState.addShotId(shot.id);
          const tracer = this.renderer.spawnTracer(shot);
          this.gameState.addTracer(tracer);
          if (shot.fromId === this.gameState.myId) {
            if (shot.hitZombieId || shot.hitPlayerId) {
              this.ui.showHitMarker(shot.hitPart, shot.damage);
              this.audio.playHitMarker(shot.hitPart === "head");
            }
          } else if (me) {
            this.renderer.spawnRemoteMuzzleFlash(shot);
            const dist = Math.hypot(shot.ox - me.x, shot.oy - me.y, shot.oz - me.z);
            this.audio.playGunshot(shot.weapon, dist);
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
            this.audio.playCollapse(dist);
            if (dist < 80) this.renderer.shakeIntensity = Math.min(0.9, this.renderer.shakeIntensity + 0.6 * (1 - dist / 80));
          } else if (ev.type === "npc_arrive") {
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
        this.renderer.updateStructures(deltaTime); // debris, leaning, collapses

        this.renderer.updateCamera(state, this.gameState.myId, this.gameState, deltaTime);
        this.renderer.updateRemotePlayers(state.players, this.gameState.myId, deltaTime, this.gameState.worldMeta);
        this.renderer.updateVehicles(state.vehicles || [], this.gameState.myId, deltaTime);
        this.renderer.updateRiders(state.players, state.vehicles || [], this.gameState.myId, this.gameState.worldMeta, deltaTime);
        this.renderer.setWildlifeThreats(state.players);
        this.renderer.updateNpcs(state.npcs || [], deltaTime, this.gameState.worldMeta);
        this.renderer.updateRecruitBeacon(state, this.gameState.myId, deltaTime);
        this.renderer.updateShields(state.npcs || []);
        this.renderer.updateTracersFx(this.gameState.getTracers(), deltaTime);
        this.renderer.updateWorldFlashes(deltaTime);
        this.renderer.updateEnvironmentFx(deltaTime);
        this.updateZombies(state, me, deltaTime, now);
        this.riftFx.update(state, me, this.gameState.myId, deltaTime);
        this.bossFx.update(state, me, this.gameState.myId, deltaTime);
        this.bossMarkers.update(this.renderer.camera, bossTargets(state), me);
        this.handleZombieEvents(state, me);

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
  window.__game = new ZPlusGame();
});
