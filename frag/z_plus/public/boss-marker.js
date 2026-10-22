/**
 * "Where is it?" markers for bosses (champions, the Undead Wyrm, the rift).
 *
 * On screen: a marker floating above the boss with its name and distance.
 * Off screen (or behind you): an arrow pinned to the screen edge pointing
 * toward it, with the distance. Plain DOM overlay projected every frame.
 */

const _v = new THREE.Vector3();

export class BossMarkers {
  constructor(root) {
    this.root = root;
    this.items = new Map(); // id -> { el, arrow }
  }

  ensure(id, color) {
    let it = this.items.get(id);
    if (!it) {
      const el = document.createElement("div");
      el.className = "boss-marker";
      el.innerHTML = '<div class="bm-name"></div><div class="bm-icon">▼</div><div class="bm-dist"></div>';
      const arrow = document.createElement("div");
      arrow.className = "boss-arrow";
      arrow.innerHTML = '<div class="ba-tip">➤</div><div class="ba-text"></div>';
      this.root.appendChild(el);
      this.root.appendChild(arrow);
      it = { el, arrow, name: el.querySelector(".bm-name"), dist: el.querySelector(".bm-dist"), aText: arrow.querySelector(".ba-text"), aTip: arrow.querySelector(".ba-tip") };
      this.items.set(id, it);
    }
    it.el.style.setProperty("--bm-color", color);
    it.arrow.style.setProperty("--bm-color", color);
    return it;
  }

  /**
   * targets: [{ id, x, y, z, label, color }] in world space (y = where the
   * marker floats). me: my player (for distance).
   */
  update(camera, targets, me) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const keep = new Set();
    for (const t of targets) {
      keep.add(t.id);
      const it = this.ensure(t.id, t.color || "#ffcf5a");
      const dist = me ? Math.round(Math.hypot(t.x - me.x, t.y - me.y, t.z - me.z)) : 0;
      const distText = `${dist} m`;
      if (it.name.textContent !== t.label) it.name.textContent = t.label;
      if (it.dist.textContent !== distText) it.dist.textContent = distText;

      // Position relative to the camera.
      _v.set(t.x, t.y, t.z).applyMatrix4(camera.matrixWorldInverse);
      const behind = _v.z > 0;
      _v.set(t.x, t.y, t.z).project(camera);
      const sx = (_v.x * 0.5 + 0.5) * w;
      const sy = (-_v.y * 0.5 + 0.5) * h;
      const margin = 60;
      const onScreen = !behind && sx > margin && sx < w - margin && sy > margin && sy < h - margin;

      if (onScreen) {
        it.el.style.display = "block";
        it.arrow.style.display = "none";
        it.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
        // Nearby: smaller and fainter so it doesn't cover the fight.
        it.el.style.opacity = dist < 25 ? "0.55" : "1";
      } else {
        it.el.style.display = "none";
        it.arrow.style.display = "flex";
        // Direction from screen center toward the target (flip if behind).
        let dx = _v.x;
        let dy = -_v.y;
        if (behind) {
          dx = -dx;
          dy = -dy;
        }
        if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) dy = 1;
        const ang = Math.atan2(dy, dx);
        // Pin to an inset rectangle along that direction.
        const hw = w / 2 - margin;
        const hh = h / 2 - margin;
        const k = Math.min(hw / Math.abs(Math.cos(ang) || 1e-6), hh / Math.abs(Math.sin(ang) || 1e-6));
        const ax = w / 2 + Math.cos(ang) * k;
        const ay = h / 2 + Math.sin(ang) * k;
        it.arrow.style.transform = `translate(${ax.toFixed(1)}px, ${ay.toFixed(1)}px) translate(-50%, -50%)`;
        it.aTip.style.transform = `rotate(${ang.toFixed(3)}rad)`;
        const txt = `${t.label} · ${distText}`;
        if (it.aText.textContent !== txt) it.aText.textContent = txt;
      }
    }
    for (const [id, it] of this.items) {
      if (keep.has(id)) continue;
      it.el.remove();
      it.arrow.remove();
      this.items.delete(id);
    }
  }
}

/** Build the marker list from a Z+ state. */
export function bossTargets(state) {
  const out = [];
  const c = state.champ;
  if (c && (c.ph === "intro" || c.ph === "fight") && !c.hid) {
    out.push({ id: "champ", x: c.x, y: c.y + c.H * 1.12, z: c.z, label: c.name, color: "#ffcf5a" });
  }
  const r = state.rift;
  if (r && r.dragon && (r.ph === "dragon" || r.ph === "burst")) {
    const d = r.dragon;
    out.push({ id: "dragon", x: d.x, y: d.y + 8 * (d.sc || 1), z: d.z, label: "Undead Wyrm", color: "#9dff5a" });
  } else if (r && r.vortex && r.vortex.kind === "rift" && (r.ph === "vortex" || r.ph === "burst")) {
    out.push({ id: "rift", x: r.vortex.x, y: r.vortex.y + 12, z: r.vortex.z, label: "The Rift", color: "#c27bff" });
  }
  return out;
}
