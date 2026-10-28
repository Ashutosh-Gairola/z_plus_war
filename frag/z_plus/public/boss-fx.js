/**
 * Z+ champion bosses — visuals (server: z_plus/boss-system.js).
 *
 * Procedural giant humanoids on a simple skeleton (hips / torso / head,
 * shoulder-elbow-hand arms, hip-knee-foot legs) styled per champion, an
 * animation driver (walk cycle, windups, swings, slams, thrusts, casts,
 * leaps, transformations, death), and all the combat effects: slash arcs,
 * shockwaves, projectiles, scarlet-rot and blood-flame fields, danger
 * markers, the black death ring, plus the boss bar / name card / statuses.
 */

import { FireParticles, Shockwaves, PARTICLE_PALETTES } from "./rift-fx.js";
import { buildChampion, animateCloth, animateUndead } from "./boss-models.js";

const _v = new THREE.Vector3();
const _e = new THREE.Euler();

function std(color, roughness = 0.6, metalness = 0.3, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, flatShading: true, ...extra });
}
function glow(color, intensity = 2.5) {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.4 });
}
function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}
/** Limb segment hanging down (-Y) from its joint. */
function limb(len, r0, r1, mat, sides = 7) {
  const g = new THREE.CylinderGeometry(r1, r0, len, sides);
  g.translate(0, -len / 2, 0);
  return mesh(g, mat);
}
/** Blade/pole pointing forward (-Z) out of the hand. */
function blade(len, w, t, mat, edgeMat = null) {
  const g = new THREE.Group();
  const b = mesh(new THREE.BoxGeometry(w, t, len), mat, 0, 0, -len / 2);
  g.add(b);
  if (edgeMat) {
    const e = mesh(new THREE.BoxGeometry(w * 0.25, t * 1.2, len * 0.98), edgeMat, w * 0.45, 0, -len / 2);
    e.castShadow = false;
    g.add(e);
  }
  return g;
}

const STYLE = {
  scarlet: {
    armor: 0x8a1c1c,
    cloth: 0xa8201e,
    skin: 0xd8c4b0,
    metal: 0xc9a14a,
    accent: 0xff5a3c,
    bulk: 0.85,
    arc: 0xff3a2a,
    palette: "rot",
  },
  titan: {
    armor: 0x3a3029,
    cloth: 0x5a2a1a,
    skin: 0x9a7a62,
    metal: 0x6a5a48,
    accent: 0xb07aff,
    bulk: 1.45,
    arc: 0xa070ff,
    palette: "gravity",
  },
  omen: {
    armor: 0x2e2a26,
    cloth: 0x3a342c,
    skin: 0x8a7a68,
    metal: 0x4a4038,
    accent: 0xffc84a,
    bulk: 1.05,
    arc: 0xffd36a,
    palette: "gold",
  },
  beast: {
    armor: 0x1a1a1e,
    cloth: 0x14141a,
    skin: 0x2a2a30,
    metal: 0x101012,
    accent: 0xff2a2a,
    bulk: 1.0,
    arc: 0xff2020,
    palette: "shadow",
  },
  blood: {
    armor: 0x3a1418,
    cloth: 0x5a0e14,
    skin: 0x6a4a3e,
    metal: 0x2a1a1a,
    accent: 0xff1a2a,
    bulk: 1.2,
    arc: 0xff1a1a,
    palette: "blood",
  },
};

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

// Models live in boss-models.js.
export { buildChampion };

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/**
 * Pose a champion. s: the champion snapshot; dt: seconds.
 * Swings / slams are triggered from combat events (startSwing) so they land
 * exactly when the server's hit does.
 */
export function animateChampion(model, s, dt) {
  const R = model.userData.rig;
  const kind = s.k;
  const act = s.act || "";
  const p = s.dur ? Math.min(1, (s.at || 0) / s.dur) : 0;
  const air = s.air || 0;
  const speed = s.sp || 0;
  const H = s.H || 8;
  R.swingT += dt;
  R.phase += dt * Math.min(2.2, speed / (H * 0.18)) * Math.PI * 2;
  const stride = Math.min(1, speed / (H * 0.9));
  const wave = Math.sin(R.phase);

  // ---- base pose: idle / walk ----
  const hunch = (R.hunch || 0) + (R.beast && !s.p2 ? 0.9 : 0);
  R.torso.rotation.set(hunch + stride * 0.15, 0, 0);
  R.hips.position.y = 0.5 + Math.abs(Math.sin(R.phase)) * 0.015 * stride;
  R.neck.rotation.set(-hunch * 0.7, 0, 0);
  for (const L of R.legs) {
    const sw = wave * L.side * 0.55 * stride;
    L.hip.rotation.set(sw, 0, 0);
    L.knee.rotation.set(Math.max(0, -sw) * 0.9 + 0.05, 0, 0);
    L.foot.rotation.set(0, 0, 0);
  }
  for (const A of R.arms) {
    const sw = -wave * A.side * 0.45 * stride;
    A.sh.rotation.set(sw + (R.beast && !s.p2 ? -hunch * 1.1 : 0), 0, A.side * 0.12);
    A.el.rotation.set(-0.25, 0, 0);
  }
  R.cape.rotation.x = 0.15 + stride * 0.5 + Math.sin(R.phase * 0.5) * 0.05;

  // ---- airborne: tuck legs ----
  if (air > 0.3) {
    for (const L of R.legs) {
      L.hip.rotation.x = -0.9;
      L.knee.rotation.x = 1.5;
    }
  }

  // ---- move archetypes (continuous during the act) ----
  const [armL, armR] = R.arms;
  const raise = (A, x, z = 0) => {
    A.sh.rotation.x = x;
    A.sh.rotation.z = A.side * z;
  };
  if (act === "thrust" || act === "charge") {
    const k = act === "thrust" ? (p < 0.4 ? p / 0.4 : 1) : 1;
    raise(armR, -1.1 - 0.4 * (1 - k), 0.1);
    armR.el.rotation.x = -0.6 + k * 0.6;
    R.torso.rotation.x += 0.3 * k;
  } else if (act === "arrows") {
    raise(armL, -1.55, 0.05); // bow arm out front
    raise(armR, -1.4, -0.3);
    armR.el.rotation.x = -1.6 + Math.sin(p * Math.PI * 10) * 0.4; // drawing
  } else if (act === "gravity" || act === "stones" || act === "daggers" || act === "blood_wave") {
    const k = Math.min(1, p * 2.5);
    raise(armL, -2.6 * k, 0.3);
    armL.el.rotation.x = -0.2;
    if (act === "daggers") raise(armR, -2.3 * k, 0.2);
  } else if (act === "rite" || act.startsWith("p2_")) {
    // Arms spread wide, rising — transformation / ritual.
    const k = Math.min(1, p * 2);
    raise(armL, -0.4 * k, 1.4 * k);
    raise(armR, -0.4 * k, 1.4 * k);
    R.neck.rotation.x = -0.4 * k;
  } else if (act === "dodge") {
    R.torso.rotation.z = 0.35;
  } else if (act === "flurry") {
    raise(armR, -1.6, 1.2);
    R.torso.rotation.y = R.phase * 3;
  } else if (act === "nova" || act === "hammer" || act === "death_ring" || act === "meteor") {
    // Wind up overhead until the hit.
    if (R.swingT > 0.6) {
      const k = Math.min(1, p * 3);
      raise(armR, -2.8 * k, 0.1);
      raise(armL, -2.8 * k, 0.1);
    }
  } else if (act && R.swingT > 0.5) {
    // Generic windup for slashes (raised weapon arm, twisted torso).
    const k = Math.min(1, ((s.at || 0) / 350));
    raise(armR, -2.3 * k, 0.7 * k);
    armR.el.rotation.x = -0.9 * k;
    R.torso.rotation.y = 0.45 * k;
    if (act === "twin_sweep" || act === "claws") raise(armL, -2.3 * k, 0.7 * k);
  }

  // ---- event-driven strikes (exactly when the server hits) ----
  if (R.swingT < 0.45) {
    const k = easeInOut(Math.min(1, R.swingT / 0.22));
    if (R.swingKind === "slam") {
      raise(armR, -2.8 + 2.4 * k, 0.1);
      raise(armL, -2.8 + 2.4 * k, 0.1);
      R.torso.rotation.x += 0.45 * k;
    } else if (R.swingKind === "thrust") {
      raise(armR, -1.5, 0);
      armR.el.rotation.x = 0;
      R.torso.rotation.x += 0.25;
    } else {
      // Sweep across the body.
      raise(armR, -2.3 + 1.6 * k, 0.7 - 1.5 * k);
      armR.el.rotation.x = -0.9 + 0.8 * k;
      R.torso.rotation.y = 0.45 - 1.1 * k;
      if (kind === "titan" || (kind === "beast" && !s.p2)) raise(armL, -2.3 + 1.6 * k, 0.7 - 1.5 * k);
    }
  }

  animateCloth(R, performance.now() * 0.001, stride);
  animateUndead(R, performance.now() * 0.001);

  // ---- per-champion props ----
  const P = R.props;
  if (P.wings) {
    P.wings.visible = Boolean(s.p2);
    if (P.wings.visible) P.wings.rotation.y = Math.sin(R.phase * 0.5 + performance.now() * 0.003) * 0.15;
  }
  if (kind === "omen") {
    P.hammer.visible = act === "hammer";
    P.gblade.visible = act === "gblade";
    if (P.hammer.visible || P.gblade.visible) raise(armL, armR.sh.rotation.x, 0.4);
  }
  if (kind === "beast") {
    P.sword.visible = Boolean(s.p2) && act !== "p2_beast";
  }
  if (P.horse) {
    // Gallop the tiny horse; the giant rides it with legs splayed.
    const g = R.phase * 1.6;
    P.horseLegs.forEach((lg, i) => {
      lg.rotation.x = Math.sin(g + (i % 2 ? Math.PI : 0) + (i > 1 ? 0.6 : 0)) * 0.7 * Math.max(0.15, stride);
    });
    P.horse.position.y = Math.abs(Math.sin(g)) * 0.02 * stride;
    R.hips.position.y = 0.44 + P.horse.position.y;
    for (const L of R.legs) {
      L.hip.rotation.set(-0.5, 0, L.side * 0.75);
      L.knee.rotation.x = 1.1;
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const PROJ_LOOK = {
  gravarrow: { geo: () => new THREE.ConeGeometry(0.4, 3.2, 6).rotateX(-Math.PI / 2), color: [1.6, 0.7, 3.2], trail: "gravity" },
  gravorb: { geo: () => new THREE.SphereGeometry(1.1, 14, 10), color: [1.2, 0.5, 2.8], trail: "gravity" },
  smallmeteor: { geo: () => new THREE.IcosahedronGeometry(1.6, 0), color: [3.2, 1.2, 0.3], trail: "fire" },
  dagger: { geo: () => new THREE.ConeGeometry(0.22, 2.6, 4).rotateX(-Math.PI / 2), color: [3.2, 2.4, 0.8], trail: "gold" },
  stone: { geo: () => new THREE.IcosahedronGeometry(0.9, 0), color: [1.6, 1.3, 0.6], trail: "gold" },
  blackwave: {
    geo: () => new THREE.RingGeometry(3.4, 4.4, 24, 1, Math.PI * 0.15, Math.PI * 0.7).rotateY(Math.PI),
    color: [1.4, 0.05, 0.05],
    trail: "shadow",
  },
};

export class BossFx {
  constructor({ renderer, audio, root }) {
    this.R = renderer;
    this.scene = renderer.scene;
    this.audio = audio;
    this.model = null;
    this.kind = null;
    this.parts = {};
    for (const k of Object.keys(PARTICLE_PALETTES)) {
      if (k === "fire") continue;
      this.parts[k] = new FireParticles(this.scene, 1400, PARTICLE_PALETTES[k]);
    }
    this.parts.fire = new FireParticles(this.scene, 1200, PARTICLE_PALETTES.fire);
    this.shock = new Shockwaves(this.scene);
    this.projMeshes = new Map();
    this.markPool = [];
    this.ringMeshes = [];
    this.decals = [];
    this.arcs = [];
    this.seen = new Set();
    this.buildHud(root);
    // Arrival beacon: a tall pillar of light on the champion for its first
    // seconds so everyone can see where it came down.
    const pg = new THREE.CylinderGeometry(2.4, 2.4, 1, 20, 1, true);
    pg.translate(0, 0.5, 0);
    this.pillar = new THREE.Mesh(
      pg,
      new THREE.MeshBasicMaterial({ color: 0xffd36a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    );
    this.pillar.material.color.setRGB(2.4, 1.7, 0.6);
    this.pillar.scale.set(1, 260, 1);
    this.pillar.visible = false;
    this.pillar.userData.dynamic = true;
    this.scene.add(this.pillar);
    this.pillarT = 99;
  }

  // ---------------- HUD ----------------

  buildHud(root) {
    this.hud = document.createElement("div");
    this.hud.className = "champ-hud hidden";
    this.hud.innerHTML = '<div class="champ-name"></div><div class="champ-bar"><div class="champ-ghost"></div><div class="champ-fill"></div></div>';
    root.appendChild(this.hud);
    this.nameEl = this.hud.querySelector(".champ-name");
    this.fillEl = this.hud.querySelector(".champ-fill");
    this.ghostEl = this.hud.querySelector(".champ-ghost");
    this.card = document.createElement("div");
    this.card.className = "champ-card hidden";
    root.appendChild(this.card);
    this.status = document.createElement("div");
    this.status.className = "champ-status hidden";
    root.appendChild(this.status);
    this.ghost = 1;
    this.cardUntil = 0;
  }

  showCard(html, ms, cls = "") {
    this.card.innerHTML = html;
    this.card.className = `champ-card ${cls}`;
    void this.card.offsetWidth;
    this.card.classList.add("show");
    this.cardUntil = performance.now() + ms;
  }

  updateHud(c, myId, dt) {
    if (performance.now() > this.cardUntil) this.card.classList.add("hidden");
    if (!c || c.ph === "none") {
      this.hud.classList.add("hidden");
      this.status.classList.add("hidden");
      return;
    }
    this.hud.classList.toggle("hidden", c.ph === "intro");
    const nameText = `${c.name}, ${c.title}${c.lvl > 1 ? `  ·  Lv ${c.lvl}` : ""}`;
    if (this.nameEl.textContent !== nameText) this.nameEl.textContent = nameText;
    const frac = c.max ? c.hp / c.max : 0;
    this.fillEl.style.width = `${(frac * 100).toFixed(2)}%`;
    this.ghost = frac > this.ghost ? frac : this.ghost + (frac - this.ghost) * Math.min(1, dt * 1.2);
    this.ghostEl.style.width = `${(this.ghost * 100).toFixed(2)}%`;
    this.hud.classList.toggle("p2", Boolean(c.p2));
    // My status effects.
    const mine = (c.st || []).filter((x) => x[0] === myId);
    if (mine.length) {
      this.status.innerHTML = mine
        .map(([, k, ms]) =>
          k === "death"
            ? `<div class="st death">☠ Black Blade wound — healing blocked ${Math.ceil(ms / 1000)}s</div>`
            : `<div class="st rite">🩸 Blood Rite — draining, you will burst in ${Math.ceil(ms / 1000)}s</div>`,
        )
        .join("");
      this.status.classList.remove("hidden");
    } else this.status.classList.add("hidden");
  }

  /** One model of every champion (for shader precompilation). */
  prewarmModels() {
    return ["scarlet", "titan", "omen", "beast", "blood"].map((k) => {
      const m = buildChampion(k);
      m.position.set(0, -500, 0);
      return m;
    });
  }

  // ---------------- per frame ----------------

  update(state, me, myId, dt) {
    const c = state.champ;
    this.handleEvents(state, me);
    this.updateModel(c, dt);
    this.updateProjectiles(c, dt);
    this.updateMarks(c);
    this.updateRings(c);
    this.updateZones(c, dt);
    this.updateArcs(dt);
    const ps = (this.R.renderer.domElement.height || window.innerHeight) * 0.5;
    for (const k of Object.keys(this.parts)) this.parts[k].update(dt, ps);
    this.shock.update(dt);
    this.updateHud(c, myId, dt);
  }

  updatePillar(c, dt) {
    this.pillarT += dt;
    const on = c && c.ph !== "none" && this.pillarT < 11;
    this.pillar.visible = Boolean(on);
    if (!on) return;
    const fade = this.pillarT < 0.6 ? this.pillarT / 0.6 : Math.max(0, 1 - (this.pillarT - 7) / 4);
    this.pillar.material.opacity = 0.55 * fade;
    this.pillar.position.set(c.x, c.y, c.z);
    const w = 1 + Math.sin(this.pillarT * 6) * 0.08;
    this.pillar.scale.set(w * (c.H / 9), 260, w * (c.H / 9));
  }

  updateModel(c, dt) {
    this.updatePillar(c, dt);
    if (!c || c.ph === "none") {
      if (this.model) {
        this.scene.remove(this.model);
        this.model = null;
      }
      return;
    }
    if (!this.model || this.kind !== c.k) {
      if (this.model) this.scene.remove(this.model);
      this.model = buildChampion(c.k);
      this.model.userData.dynamic = true;
      this.kind = c.k;
      this.scene.add(this.model);
      this.deathT = 0;
    }
    const m = this.model;
    m.visible = !c.hid;
    m.scale.setScalar(c.H);
    m.position.set(c.x, c.y, c.z);
    m.rotation.set(0, c.yaw, 0);
    if (c.ph === "intro") {
      // Rise into being.
      const k = Math.min(1, c.t / 2500);
      m.scale.setScalar(c.H * (0.3 + 0.7 * k));
    }
    if (c.ph === "slain") {
      this.deathT += dt;
      const k = Math.min(1, this.deathT / 1.6);
      const R = m.userData.rig;
      R.body.rotation.x = -k * 1.35; // topples backward
      R.body.position.y = -k * 0.08;
      if (this.deathT > 3) m.visible = Math.random() > (this.deathT - 3) / 2;
      // Dissolving into embers.
      const P = this.parts[STYLE[c.k].palette];
      for (let i = 0; i < 6; i += 1) {
        P.emit(c.x + (Math.random() - 0.5) * c.H * 0.4, c.y + Math.random() * c.H * 0.4, c.z + (Math.random() - 0.5) * c.H * 0.4, 0, 2 + Math.random() * 3, 0, 0.6, 1.6, Math.random(), 0.5);
      }
      return;
    }
    animateChampion(m, c, dt);
    // Ambient particles per champion.
    const P = this.parts[STYLE[c.k].palette];
    const rate = c.p2 ? 30 : 12;
    if (Math.random() < dt * rate) {
      P.emit(c.x + (Math.random() - 0.5) * c.H * 0.25, c.y + Math.random() * c.H * 0.8, c.z + (Math.random() - 0.5) * c.H * 0.25, 0, 1.5, 0, 0.35 * (c.H / 8), 1.2, Math.random(), 0.4);
    }
  }

  // ---------------- events ----------------

  handleEvents(state, me) {
    const c = state.champ;
    for (const ev of state.zombieEvents || []) {
      if (!ev.type.startsWith("boss_")) continue;
      const key = `${ev.type}:${ev.at}:${ev.x}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-250));
      const dist = me ? Math.hypot(ev.x - me.x, ev.z - me.z) : 50;
      const st = STYLE[ev.kind || c?.k || "scarlet"] || STYLE.scarlet;
      const R = this.model?.userData.rig;
      switch (ev.type) {
        case "boss_intro": {
          this.pillarT = 0;
          this.showCard(`<div class="cn">${ev.name}</div><div class="ct">${ev.title}</div>${ev.lvl > 1 ? `<div class="cl">— returns stronger (Lv ${ev.lvl}) —</div>` : ""}`, 4800, "intro");
          this.audio.playRoar?.(dist, 1.1);
          this.arrival(ev);
          break;
        }
        case "boss_arc": {
          if (R) {
            R.swingT = 0;
            R.swingKind = "slash";
          }
          this.spawnArc(ev.x, ev.z, ev.yaw, ev.reach, ev.half, st.arc, c);
          this.audio.playWhoosh?.(dist);
          break;
        }
        case "boss_circle": {
          if (R && c && Math.hypot(ev.x - c.x, ev.z - c.z) < c.H * 1.2) {
            R.swingT = 0;
            R.swingKind = "slam";
          }
          this.shock.spawn(ev.x, 0.4, ev.z, ev.r / 120, { ring: st.arc, noShell: true });
          this.R.spawnDirtBurst?.(ev.x, ev.z, ev.r > 10);
          const P = this.parts[st.palette];
          for (let i = 0; i < Math.min(60, ev.r * 3); i += 1) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.random() * ev.r;
            P.emit(ev.x + Math.cos(a) * r, 0.4, ev.z + Math.sin(a) * r, Math.cos(a) * 4, 3 + Math.random() * 6, Math.sin(a) * 4, 1.2, 0.8 + Math.random() * 0.5, Math.random(), 2);
          }
          this.R.shakeIntensity = Math.min(1.2, (this.R.shakeIntensity || 0) + Math.min(0.9, ev.r / 25) * Math.max(0.1, 1 - dist / 90));
          this.audio.playCrash?.(Math.min(60, ev.r * 2), dist);
          break;
        }
        case "boss_thrust":
          if (R) {
            R.swingT = 0;
            R.swingKind = "thrust";
          }
          this.burst(ev.x, 2, ev.z, st.palette, 25, 8);
          break;
        case "boss_proj_hit": {
          const pal = PROJ_LOOK[ev.pk]?.trail || "fire";
          this.burst(ev.x, ev.y || 1, ev.z, pal, 40, 10);
          if (ev.pk === "smallmeteor" || ev.pk === "gravorb" || ev.pk === "gravarrow") {
            this.R.spawnExplosionEffect?.(ev.x, ev.y || 1, ev.z, ev.pk === "smallmeteor" ? 30 : 14);
          }
          break;
        }
        case "boss_meteor":
          this.shock.spawn(ev.x, 0.5, ev.z, 0.4, { shell: 0xb07aff, ring: 0xffc890 });
          this.R.spawnExplosionEffect?.(ev.x, 2, ev.z, 55);
          this.R.shakeIntensity = 1.6;
          this.audio.playCollapse?.(dist);
          break;
        case "boss_bloom":
          this.shock.spawn(ev.x, 2, ev.z, 0.45, { shell: 0xff5a3c, ring: 0xff8a5a });
          this.burst(ev.x, 6, ev.z, "rot", 260, 22);
          this.showCard('<div class="ct">The scarlet bloom unfurls…</div>', 2500, "small");
          break;
        case "boss_ring":
          this.audio.playCollapse?.(dist);
          break;
        case "boss_bloodwave":
          this.audio.playDragonBreath?.(dist);
          break;
        case "boss_rite":
          this.showCard('<div class="cn rite">BLOOD RITE</div><div class="ct">Your blood is his — kill him or burst</div>', 3500, "rite");
          this.audio.playRoar?.(dist, 1.2);
          break;
        case "boss_phase2":
          this.audio.playRoar?.(dist, 1.3);
          this.R.shakeIntensity = Math.min(1.2, (this.R.shakeIntensity || 0) + 0.6);
          break;
        case "boss_roar":
          this.audio.playRoar?.(dist, 1);
          break;
        case "boss_slain":
          this.showCard('<div class="cn felled">ENEMY FELLED</div>', 4500, "felled");
          this.audio.playRiftBurst?.();
          break;
        default:
      }
    }
  }

  arrival(ev) {
    const pal = STYLE[ev.kind]?.palette || "fire";
    if (ev.kind === "titan") {
      this.shock.spawn(ev.x, 0.5, ev.z, 0.35, { shell: 0xb07aff, ring: 0xffd0a0 });
      this.R.spawnExplosionEffect?.(ev.x, 2, ev.z, 50);
      this.R.shakeIntensity = 1.4;
    } else {
      this.shock.spawn(ev.x, 1, ev.z, 0.2, { shell: STYLE[ev.kind]?.arc || 0xffffff, ring: STYLE[ev.kind]?.arc || 0xffffff });
    }
    this.burst(ev.x, 2, ev.z, pal, 220, 16);
  }

  burst(x, y, z, pal, n, sp) {
    const P = this.parts[pal] || this.parts.fire;
    for (let i = 0; i < n; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const e = Math.random() * 0.9;
      const v = sp * (0.4 + Math.random() * 0.6);
      P.emit(x, y, z, Math.cos(a) * Math.cos(e) * v, Math.sin(e) * v + 2, Math.sin(a) * Math.cos(e) * v, 1.4, 0.7 + Math.random() * 0.6, Math.random(), 2.5);
    }
  }

  // ---------------- slash arcs ----------------

  spawnArc(x, z, yaw, reach, half, color, c) {
    const geo = new THREE.RingGeometry(reach * 0.55, reach, 40, 1, Math.PI / 2 - half, half * 2);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    mat.color.multiplyScalar(2.2);
    const m = new THREE.Mesh(geo, mat);
    m.rotation.set(-Math.PI / 2, 0, yaw);
    m.position.set(x, (c ? c.y + c.H * 0.3 : 2), z);
    this.scene.add(m);
    this.arcs.push({ m, t: 0 });
  }

  updateArcs(dt) {
    for (let i = this.arcs.length - 1; i >= 0; i -= 1) {
      const a = this.arcs[i];
      a.t += dt;
      a.m.material.opacity = Math.max(0, 0.85 * (1 - a.t / 0.35));
      a.m.scale.setScalar(1 + a.t * 0.4);
      if (a.t > 0.35) {
        this.scene.remove(a.m);
        a.m.geometry.dispose();
        a.m.material.dispose();
        this.arcs.splice(i, 1);
      }
    }
  }

  // ---------------- projectiles ----------------

  updateProjectiles(c, dt) {
    const keep = new Set();
    for (const [id, kind, x, y, z, heading] of c?.pr || []) {
      keep.add(id);
      let m = this.projMeshes.get(id);
      const look = PROJ_LOOK[kind] || PROJ_LOOK.stone;
      if (!m) {
        const mat = new THREE.MeshBasicMaterial({ fog: false, side: THREE.DoubleSide, transparent: kind === "blackwave", opacity: 0.9 });
        mat.color.setRGB(look.color[0], look.color[1], look.color[2]);
        m = new THREE.Mesh(look.geo(), mat);
        m.userData.dynamic = true;
        this.scene.add(m);
        this.projMeshes.set(id, m);
      }
      m.position.set(x, y, z);
      m.rotation.set(0, heading, 0);
      if (kind === "gravorb" || kind === "stone" || kind === "smallmeteor") m.rotation.x += performance.now() * 0.004;
      const P = this.parts[look.trail] || this.parts.fire;
      const n = kind === "blackwave" ? 5 : 2;
      for (let i = 0; i < n; i += 1) {
        P.emit(x + (Math.random() - 0.5) * (kind === "blackwave" ? 6 : 1), y + (Math.random() - 0.5), z + (Math.random() - 0.5), 0, 1, 0, kind === "smallmeteor" ? 2.4 : 0.9, 0.45, Math.random(), 2);
      }
    }
    for (const [id, m] of this.projMeshes) {
      if (keep.has(id)) continue;
      this.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
      this.projMeshes.delete(id);
    }
  }

  // ---------------- telegraphs / rings / zones ----------------

  markMesh(i) {
    if (!this.markPool[i]) {
      const g = new THREE.Group();
      const ringMat = new THREE.MeshBasicMaterial({ color: 0xff2a10, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
      const fillMat = new THREE.MeshBasicMaterial({ color: 0xff3a10, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 72), ringMat);
      const fill = new THREE.Mesh(new THREE.CircleGeometry(1, 48), fillMat);
      ring.rotation.x = fill.rotation.x = -Math.PI / 2;
      g.add(ring, fill);
      g.userData = { ring, fill, dynamic: true };
      this.scene.add(g);
      this.markPool[i] = g;
    }
    return this.markPool[i];
  }

  updateMarks(c) {
    const marks = c?.mk || [];
    const t = performance.now() * 0.001;
    for (let i = 0; i < Math.max(marks.length, this.markPool.length); i += 1) {
      const g = this.markMesh(i);
      const mk = marks[i];
      g.visible = Boolean(mk);
      if (!mk) continue;
      const [x, z, r, left, kind] = mk;
      g.position.set(x, 0.18, z);
      g.scale.setScalar(r);
      const urgent = left < 600;
      const pulse = 0.5 + 0.5 * Math.sin(t * (urgent ? 24 : 10));
      g.userData.ring.material.color.setHex(kind === "gravity" ? 0xb070ff : 0xff2a10);
      g.userData.ring.material.opacity = 0.5 + 0.45 * pulse;
      g.userData.fill.material.opacity = (urgent ? 0.28 : 0.12) + 0.1 * pulse;
    }
  }

  updateRings(c) {
    const rings = c?.rg || [];
    while (this.ringMeshes.length < rings.length) {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.9, 1, 96),
        new THREE.MeshBasicMaterial({ color: 0xff1010, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
      );
      m.material.color.setRGB(2.2, 0.05, 0.05);
      m.rotation.x = -Math.PI / 2;
      m.userData.dynamic = true;
      this.scene.add(m);
      this.ringMeshes.push(m);
    }
    this.ringMeshes.forEach((m, i) => {
      const rg = rings[i];
      m.visible = Boolean(rg);
      if (!rg) return;
      m.position.set(rg[0], 1.2, rg[1]);
      m.scale.set(rg[2], rg[2], rg[2]);
      // Black flames along the ring.
      const P = this.parts.shadow;
      for (let k = 0; k < 10; k += 1) {
        const a = Math.random() * Math.PI * 2;
        P.emit(rg[0] + Math.cos(a) * rg[2], 0.5, rg[1] + Math.sin(a) * rg[2], 0, 4 + Math.random() * 4, 0, 1.6, 0.6, Math.random(), 2);
      }
    });
  }

  updateZones(c, dt) {
    const zones = c?.zn || [];
    while (this.decals.length < zones.length) {
      const m = new THREE.Mesh(
        new THREE.CircleGeometry(1, 36),
        new THREE.MeshBasicMaterial({ color: 0x3a0606, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
      );
      m.rotation.x = -Math.PI / 2;
      m.userData.dynamic = true;
      this.scene.add(m);
      this.decals.push(m);
    }
    this.decals.forEach((m, i) => {
      const zn = zones[i];
      m.visible = Boolean(zn);
      if (!zn) return;
      const [kind, x, z, r, left] = zn;
      m.position.set(x, 0.08, z);
      m.scale.setScalar(r);
      m.material.color.setHex(kind === "rot" ? 0x4a1208 : 0x3a0408);
      m.material.opacity = 0.55 * Math.min(1, left / 1500);
      const P = this.parts[kind === "rot" ? "rot" : "blood"];
      let n = r * r * 0.35 * dt * 6 * Math.min(1, left / 1500);
      while (n > 0) {
        if (n < 1 && Math.random() > n) break;
        n -= 1;
        const a = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(Math.random()) * r;
        P.emit(x + Math.cos(a) * rr, 0.2, z + Math.sin(a) * rr, 0, kind === "rot" ? 1.2 : 2.6, 0, kind === "rot" ? 0.5 : 0.9, 0.9, Math.random(), 1.2);
      }
    });
  }
}
