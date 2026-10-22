/**
 * UI and HUD management
 */

import { fmtTime } from "./utils.js";
import { nearestGroundWeapon, rarityOf, slotsOf, weaponInfo } from "./loot.js";
import { recruitContext } from "./recruit-client.js";

const COOLDOWN_TIME_MS = 3 * 60 * 1000; // 3 minutes
let WORLD_SIZE = 640; // server WORLD_HALF_SIZE * 2 (updated from world meta)

export class UIManager {
  constructor() {
    this.entryScreen = document.getElementById("entryScreen");
    this.gameScreen = document.getElementById("gameScreen");
    this.joinForm = document.getElementById("joinForm");
    this.nameInput = document.getElementById("nameInput");
    this.lockButton = document.getElementById("lockButton");
    this.entryMsg = document.getElementById("entryMsg");

    // HUD elements
    this.phaseEl = document.getElementById("phase");
    this.timeEl = document.getElementById("time");
    this.healthEl = document.getElementById("health");
    this.weaponEl = document.getElementById("weapon");
    this.ammoEl = document.getElementById("ammo");
    this.scoreEl = document.getElementById("score");
    this.zoneEl = document.getElementById("zone");
    this.pingEl = document.getElementById("ping");
    this.killFeedEl = document.getElementById("killFeed");
    this.crosshairEl = document.getElementById("crosshair");
    this.interactPrompt = document.getElementById("interactPrompt");
    this.recruitPrompt = document.getElementById("recruitPrompt");

    // Damage effect
    this.damageOverlay = document.getElementById("damageOverlay");

    // Leaderboard elements
    this.leaderboard = document.getElementById("leaderboard");
    this.leaderboardList = document.getElementById("leaderboardList");

    // HUD minimap
    this.minimapCanvas = document.getElementById("minimapCanvas");
    this.minimapCtx = this.minimapCanvas ? this.minimapCanvas.getContext("2d") : null;

    // Cooldown elements
    this.cooldownPanel = document.getElementById("cooldownPanel");
    this.cooldownTimer = document.getElementById("cooldownTimer");
    this.cooldownList = document.getElementById("cooldownList");
    this.voteSkipButton = document.getElementById("voteSkipButton");

    this.respawnNotice = document.getElementById("respawnNotice");

    // Loadout bar (3 slots, rarity-colored) above the bottom edge.
    this.slotBar = document.createElement("div");
    this.slotBar.className = "weapon-slots hidden";
    this.gameScreen.appendChild(this.slotBar);
    this.slotBarKey = "";

    // State tracking
    this.lastHealth = 100;
    this.votedToSkip = false;
  }

  updateEntryMessage(text) {
    this.entryMsg.textContent = text || "";
  }

  startGameUI() {
    this.entryScreen.classList.add("hidden");
    this.gameScreen.classList.remove("hidden");
    this.lockButton.classList.remove("hidden");
  }

  updatePingUI(pingMs) {
    this.pingEl.textContent = `Ping: ${typeof pingMs === "number" ? Math.round(pingMs) : "--"
      } ms`;
  }

  syncHUD(state, myId, worldMeta) {
    const me = state.players.find((p) => p.id === myId);

    this.phaseEl.textContent = `Phase: ${state.phase === "playing" ? "Playing" : "Cooldown"
      }`;
    this.timeEl.textContent = fmtTime(state.timerMs);
    this.zoneEl.textContent = `Zone: ${Math.round(state.zone.radius)}m`;

    this.renderKillFeed(state.killFeed);
    this.renderMinimap(state.players, state.zone, myId, worldMeta, state.vehicles, state.npcs, state.groundWeapons, state);
    this.renderLeaderboard(state.players);

    // Handle cooldown panel display and content
    if (state.phase === "cooldown") {
      this.cooldownPanel.classList.remove("hidden");
      this.renderCooldownTimer(state.timerMs);
      this.renderCooldownLeaderboard(state.players || []);
      
      if (this.votedToSkip) {
        this.voteSkipButton.classList.add("hidden");
      } else {
        this.voteSkipButton.classList.remove("hidden");
      }

      if (state.voteStatus) {
        this.voteSkipButton.textContent = `Vote to Start (${state.voteStatus.count}/${state.voteStatus.total})`;
      }
    } else {
      this.cooldownPanel.classList.add("hidden");
      this.votedToSkip = false;
    }

    if (!me) return;

    // Damage flash trigger
    if (me.health < this.lastHealth) {
      this.flashDamage();
    }
    this.lastHealth = me.health;

    this.healthEl.textContent = `HP: ${Math.max(0, Math.round(me.health))}`;
    this.scoreEl.textContent = `K/D: ${me.kills}/${me.deaths}`;
    const weaponLabel = weaponInfo(worldMeta, me.weapon).label.toUpperCase();
    this.weaponEl.textContent =
      me.inVehicle && me.seat === "driver"
        ? `Driving · ${weaponLabel}`
        : me.inVehicle
          ? `Passenger · ${weaponLabel}`
          : `Weapon: ${weaponLabel}`;
    this.renderSlotBar(me, worldMeta);
    this.ammoEl.textContent =
      me.reloadingMs > 0
        ? `Ammo: Reloading ${Math.ceil(me.reloadingMs / 1000)}s`
        : `Ammo: ${Math.max(0, me.ammoInMag)}/${me.magSize} (inf)`;

    if (!me.alive) {
      this.respawnNotice.textContent = `Respawn in ${fmtTime(me.respawnMs || 0)}`;
      this.respawnNotice.classList.remove("hidden");
    } else {
      this.respawnNotice.classList.add("hidden");
    }

    this.updateInteractPrompt(me, state.vehicles || [], state, worldMeta);
    this.updateRecruitPrompt(me, state);
  }

  /** Hold-to-recruit hint (and progress) while standing in the recruit beacon. */
  updateRecruitPrompt(me, state) {
    if (!this.recruitPrompt) return;
    const ctx = recruitContext(state, me);
    let html = null;
    if (ctx && ctx.inRange) {
      const pct = Math.round(Math.min(1, ctx.progressMs / ctx.holdMs) * 100);
      html =
        pct > 0
          ? `Recruiting a random companion… ${pct}% ` +
            `<span style="display:inline-block;width:90px;height:6px;margin-left:6px;` +
            `background:rgba(255,255,255,0.2);border-radius:3px;vertical-align:middle;overflow:hidden">` +
            `<span style="display:block;height:100%;width:${pct}%;background:#f0c048"></span></span>`
          : "<b>F</b> Hold 10s to recruit a random companion";
    }
    if (html) {
      if (this.recruitPrompt.innerHTML !== html) this.recruitPrompt.innerHTML = html;
      this.recruitPrompt.classList.remove("hidden");
    } else {
      this.recruitPrompt.classList.add("hidden");
    }
  }

  /** Show drive/sit/exit hints when in — or near — a vehicle. */
  updateInteractPrompt(me, vehicles, state = null, worldMeta = null) {
    if (!this.interactPrompt) return;
    const VEHICLE_NAMES = { heli: "Heli", plane: "Plane", sports: "Sports Car", suv: "SUV", pickup: "Pickup", truck: "Truck", bike: "Bike", apc: "APC" };
    const typeName = (v) => VEHICLE_NAMES[v?.type] || "Car";
    let html = null;
    const loot = nearestGroundWeapon(state, me);
    if (loot) {
      // Weapon on the ground at your feet: F swaps it into the held slot.
      const info = weaponInfo(worldMeta, loot.key);
      const rarity = rarityOf(worldMeta, loot.key);
      const name = `<span style="color:${rarity.color};font-weight:700">${info.label}</span> <span style="opacity:.7">(${rarity.label})</span>`;
      html = slotsOf(me).includes(loot.key)
        ? `${name} — already carried`
        : `<b>F</b> Pick up ${name} &nbsp;·&nbsp; replaces ${weaponInfo(worldMeta, me.weapon).label}`;
    } else if (me.alive && me.inVehicle) {
      const v = vehicles.find((x) => x.id === me.inVehicle);
      const fuel = v ? (v.fuel ?? 100) : 100;
      const carHp = v ? (v.health ?? 100) : 100;
      const fuelTag = fuel <= 0 ? "OUT OF FUEL ⚠" : `Fuel ${fuel}%`;
      const hpTag = carHp <= 0 ? "WRECKED" : `${typeName(v)} ${carHp}%`;
      const seatTag = me.seat === "passenger" ? "Passenger (weapon free)" : "Drive-by: aim + fire";
      const flyTag =
        me.seat === "driver" && (v?.type === "heli" || v?.type === "plane")
          ? "&nbsp;·&nbsp; <b>Space</b>/<b>Ctrl</b> up/down"
          : "";
      html = `<b>F</b> Exit ${seatTag ? `&nbsp;·&nbsp; ${seatTag}` : ""} &nbsp;·&nbsp; ${fuelTag} &nbsp;·&nbsp; ${hpTag}${flyTag}`;
    } else if (me.alive) {
      let nearest = null;
      let nearestDist = Infinity;
      for (const v of vehicles) {
        if (v.destroyed) continue;
        const d = Math.hypot(v.x - me.x, v.z - me.z);
        if (d <= 6.2 && d < nearestDist) {
          nearestDist = d;
          nearest = v;
        }
      }
      if (nearest) {
        if ((nearest.health ?? 100) <= 0) {
          html = `Wrecked — find another ${typeName(nearest).toLowerCase()}`;
        } else {
          const parts = [];
          if (!nearest.driverId) parts.push(`<b>F</b> Drive ${typeName(nearest)}`);
          if (!nearest.passengerId) parts.push("<b>G</b> Sit In");
          html = parts.length ? parts.join(" &nbsp;·&nbsp; ") : `${typeName(nearest)} is full`;
        }
      }
    }
    if (html) {
      if (this.interactPrompt.innerHTML !== html) this.interactPrompt.innerHTML = html;
      this.interactPrompt.classList.remove("hidden");
    } else {
      this.interactPrompt.classList.add("hidden");
    }
  }

  flashDamage() {
    this.damageOverlay.classList.remove("active");
    void this.damageOverlay.offsetWidth; // Trigger reflow
    this.damageOverlay.classList.add("active");

    // Clear existing timeout if any
    if (this.damageTimeout) clearTimeout(this.damageTimeout);

    // Auto-remove after flash - prolonged for visibility
    this.damageTimeout = setTimeout(() => {
      this.damageOverlay.classList.remove("active");
    }, 500);
  }

  showHitMarker(hitPart, damage) {
    if (!this.crosshairEl) return;
    this.crosshairEl.classList.remove("hit", "critical");
    void this.crosshairEl.offsetWidth;
    this.crosshairEl.classList.add("hit");
    if (hitPart === "head" || hitPart === "neck") {
      this.crosshairEl.classList.add("critical");
    }
    this.crosshairEl.dataset.hit = hitPart ? `${hitPart.toUpperCase()} ${Math.round(damage || 0)}` : "HIT";
    clearTimeout(this.hitMarkerTimeout);
    this.hitMarkerTimeout = setTimeout(() => {
      this.crosshairEl.classList.remove("hit", "critical");
      this.crosshairEl.dataset.hit = "";
    }, 230);
  }

  renderKillFeed(feed) {
    this.killFeedEl.innerHTML = "";
    for (const item of feed || []) {
      const div = document.createElement("div");
      div.className = "kill-item";
      div.textContent = `${item.killer} -> ${item.victim}`;
      this.killFeedEl.appendChild(div);
    }
  }

  renderCooldownTimer(timerMs) {
    // Correctly display remaining time
    const totalSeconds = Math.ceil(timerMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    this.cooldownTimer.textContent = `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  renderLeaderboard(players) {
    this.leaderboardList.innerHTML = "";
    const sorted = [...players].sort(
      (a, b) => b.kills - a.kills || b.deaths - a.deaths || a.name.localeCompare(b.name)
    );

    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const row = document.createElement("div");
      row.className = "cooldown-row";

      const rank = document.createElement("span");
      rank.style.minWidth = "20px";
      rank.textContent = `${i + 1}.`;
      row.appendChild(rank);

      const name = document.createElement("span");
      name.style.flex = "1";
      name.textContent = p.name;
      row.appendChild(name);

      const stats = document.createElement("span");
      stats.style.textAlign = "right";
      stats.textContent = `${p.kills}K / ${p.deaths}D`;
      row.appendChild(stats);

      this.leaderboardList.appendChild(row);
    }
  }

  renderCooldownLeaderboard(players) {
    this.cooldownList.innerHTML = "";
    const sorted = [...players].sort(
      (a, b) => b.kills - a.kills || b.deaths - a.deaths || a.name.localeCompare(b.name)
    );

    for (let i = 0; i < Math.min(10, sorted.length); i++) {
      const p = sorted[i];
      const row = document.createElement("div");
      row.className = "cooldown-row";

      const rank = document.createElement("span");
      rank.style.minWidth = "20px";
      rank.textContent = `${i + 1}.`;
      row.appendChild(rank);

      const name = document.createElement("span");
      name.style.flex = "1";
      name.textContent = p.name;
      row.appendChild(name);

      const stats = document.createElement("span");
      stats.style.textAlign = "right";
      stats.textContent = `${p.kills}K / ${p.deaths}D`;
      row.appendChild(stats);

      this.cooldownList.appendChild(row);
    }
  }

  /** Three loadout slots; the held one is highlighted. Re-rendered only on change. */
  renderSlotBar(me, worldMeta) {
    const slots = slotsOf(me);
    const key = `${slots.join(",")}|${me.weapon}|${me.alive}|${me.inVehicle && me.seat === "driver"}`;
    if (key === this.slotBarKey) return;
    this.slotBarKey = key;
    const hide = !me.alive;
    this.slotBar.classList.toggle("hidden", hide);
    this.slotBar.innerHTML = slots
      .map((k, i) => {
        const info = weaponInfo(worldMeta, k);
        const rarity = rarityOf(worldMeta, k);
        const active = k === me.weapon ? " active" : "";
        return `<div class="weapon-slot${active}" style="--rarity:${rarity.color}"><span class="slot-key">${i + 1}</span>${info.label}</div>`;
      })
      .join("");
  }

  renderMinimap(players, zone, myId, worldMeta, vehicles = [], npcs = [], groundWeapons = [], state = null) {
    if (!this.minimapCanvas || !this.minimapCtx) return;

    const w = this.minimapCanvas.width;
    const h = this.minimapCanvas.height;
    const ctx = this.minimapCtx;
    if (worldMeta?.worldHalfSize) WORLD_SIZE = worldMeta.worldHalfSize * 2;
    const scale = w / WORLD_SIZE;

    // Background
    ctx.fillStyle = "rgba(10, 25, 40, 0.9)";
    ctx.fillRect(0, 0, w, h);

    // Draw Static World Props (Top-view blueprint)
    if (worldMeta && worldMeta.props) {
      for (const prop of worldMeta.props) {
        const px = (prop.x + WORLD_SIZE / 2) * scale;
        const pz = (prop.z + WORLD_SIZE / 2) * scale;
        const pw = prop.sx * scale;
        const ph = prop.sz * scale;

        if (prop.type === "tree") {
          ctx.fillStyle = "rgba(45, 90, 39, 0.5)";
          ctx.beginPath();
          ctx.arc(px, pz, pw / 2, 0, Math.PI * 2);
          ctx.fill();
        } else if (prop.type === "mountain") {
          ctx.fillStyle = "rgba(74, 74, 74, 0.4)";
          ctx.beginPath();
          ctx.moveTo(px, pz - ph/2);
          ctx.lineTo(px + pw/2, pz + ph/2);
          ctx.lineTo(px - pw/2, pz + ph/2);
          ctx.closePath();
          ctx.fill();
        } else {
          // Buildings and containers
          ctx.fillStyle = "rgba(114, 106, 98, 0.6)";
          ctx.fillRect(px - pw / 2, pz - ph / 2, pw, ph);
          ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
          ctx.strokeRect(px - pw / 2, pz - ph / 2, pw, ph);
        }
      }
    }

    for (const vehicle of vehicles || []) {
      const px = (vehicle.x + WORLD_SIZE / 2) * scale;
      const py = (vehicle.z + WORLD_SIZE / 2) * scale;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(-(vehicle.yaw || 0));
      ctx.fillStyle = vehicle.driverId ? "rgba(255, 210, 80, 0.95)" : "rgba(210, 230, 240, 0.72)";
      ctx.fillRect(-3.6, -5.2, 7.2, 10.4);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
      ctx.strokeRect(-3.6, -5.2, 7.2, 10.4);
      ctx.restore();
    }

    // Loot: only the good stuff (epic/legendary) shows on the map.
    for (const g of groundWeapons || []) {
      const rarity = weaponInfo(worldMeta, g.key).rarity;
      if (rarity !== "epic" && rarity !== "legendary") continue;
      ctx.fillStyle = rarityOf(worldMeta, g.key).color;
      ctx.beginPath();
      ctx.arc((g.x + WORLD_SIZE / 2) * scale, (g.z + WORLD_SIZE / 2) * scale, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Border
    ctx.strokeStyle = "rgba(79, 194, 255, 0.6)";
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, w, h);

    // Draw safe zone (blue ring)
    const zoneX = (zone.x + WORLD_SIZE / 2) * scale;
    const zoneY = (zone.z + WORLD_SIZE / 2) * scale;
    const zoneRadius = zone.radius * scale;

    ctx.fillStyle = "rgba(79, 194, 255, 0.15)";
    ctx.beginPath();
    ctx.arc(zoneX, zoneY, zoneRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "rgba(79, 194, 255, 0.4)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Draw players. Keep the local player orientation readable without adding noise.
    for (const p of players || []) {
      const px = (p.x + WORLD_SIZE / 2) * scale;
      const py = (p.z + WORLD_SIZE / 2) * scale;
      const isMe = p.id === myId;
      const radius = isMe ? 4.5 : 3.5;

      ctx.fillStyle = isMe ? "#4fc2ff" : "#ff6b6b";
      ctx.strokeStyle = isMe ? "rgba(255, 255, 255, 0.95)" : "rgba(255, 255, 255, 0.65)";
      ctx.lineWidth = isMe ? 1.5 : 1;

      if (isMe) {
        ctx.fillStyle = "rgba(79, 194, 255, 0.2)";
        ctx.beginPath();
        ctx.arc(px, py, radius + 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#4fc2ff";
      }

      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      if (isMe) {
        // Match the server movement vector: forward at yaw 0 is -Z / up on the minimap.
        const fx = -Math.sin(p.yaw);
        const fy = -Math.cos(p.yaw);
        const rx = -fy;
        const ry = fx;
        const offset = radius + 6;
        const chevronX = px + fx * offset;
        const chevronY = py + fy * offset;
        const halfLength = 3.5;
        const halfWidth = 2.8;

        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(
          chevronX - fx * halfLength + rx * halfWidth,
          chevronY - fy * halfLength + ry * halfWidth
        );
        ctx.lineTo(chevronX + fx * halfLength, chevronY + fy * halfLength);
        ctx.lineTo(
          chevronX - fx * halfLength - rx * halfWidth,
          chevronY - fy * halfLength - ry * halfWidth
        );
        ctx.stroke();
      }
    }

    // AI companion markers. Recruitable NPCs get a pulsing haloed dot at their
    // home; killed ones show a hollow "on cooldown" ring; recruited ones show a
    // small live dot wherever they currently are.
    const roleCss = { healer: "#37d98a", attacker: "#e8563a", defender: "#4a90e2", alchemist: "#a46bff" };
    // Recruit beacon: pulsing gold marker (hidden once my party is full).
    const me = (players || []).find((p) => p.id === myId);
    const rc = recruitContext(state, me);
    if (rc && rc.visible) {
      const bx = (rc.beacon.x + WORLD_SIZE / 2) * scale;
      const by = (rc.beacon.z + WORLD_SIZE / 2) * scale;
      const pulse = 6 + Math.sin(performance.now() * 0.006) * 2;
      ctx.strokeStyle = "rgba(255, 210, 90, 0.95)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(bx, by, pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#ffd45a";
      ctx.beginPath();
      ctx.arc(bx, by, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const n of npcs || []) {
      if (n.ownerId && n.ownerId !== myId) continue; // only my party on my map
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
        // active / arriving — live position
        const nx = (n.x + WORLD_SIZE / 2) * scale;
        const ny = (n.z + WORLD_SIZE / 2) * scale;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(nx, ny, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Legend/Center marker
    ctx.fillStyle = "rgba(79, 194, 255, 0.3)";
    ctx.fillRect(zoneX - 2, zoneY - 8, 4, 16);
    ctx.fillRect(zoneX - 8, zoneY - 2, 16, 4);
  }

  onPointerLockChange() {
    const locked = document.pointerLockElement === document.getElementById("gameCanvas");
    this.lockButton.classList.toggle("hidden", locked);
    return locked;
  }

  getPlayerName() {
    return this.nameInput.value.trim();
  }

  setFormSubmitHandler(callback) {
    this.joinForm.addEventListener("submit", (e) => {
      e.preventDefault();
      callback();
    });
  }
}
