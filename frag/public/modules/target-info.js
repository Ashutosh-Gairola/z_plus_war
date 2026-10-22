/**
 * "What am I aiming at?" health bar. ~10x a second, casts a ray from the
 * camera through the crosshair against breakable walls / roof tiles, trees and
 * vehicles (anything solid in front blocks the view) and shows the target's
 * remaining health under the crosshair, plus roughly how many shots of the
 * current weapon it would take — so you can tell whether to shoot it or ram it.
 */

import { vehicleShape } from "./vehicle-shapes.js";

// Must match the server's damage scaling.
const WALL_BULLET_SCALE = 0.3;
const VEHICLE_BULLET_SCALE = 0.2;
const TREE_HP = 160;
const MAX_RANGE = 90;

function rayBox(o, d, min, max) {
  let t0 = 0;
  let t1 = MAX_RANGE;
  for (const a of ["x", "y", "z"]) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < min[a] || o[a] > max[a]) return null;
      continue;
    }
    let ta = (min[a] - o[a]) / d[a];
    let tb = (max[a] - o[a]) / d[a];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0;
}

export class TargetInfo {
  constructor(root) {
    this.el = document.createElement("div");
    this.el.className = "target-info hidden";
    this.el.innerHTML = '<div class="ti-name"></div><div class="ti-bar"><div class="ti-fill"></div></div><div class="ti-hint"></div>';
    root.appendChild(this.el);
    this.nameEl = this.el.querySelector(".ti-name");
    this.fillEl = this.el.querySelector(".ti-fill");
    this.hintEl = this.el.querySelector(".ti-hint");
    this.wallHp = new Map(); // prop id -> 0..1
    this.lastAt = 0;
    this.key = "";
  }

  /** Structure payload: exact panel health. */
  applyStructure(payload) {
    if (!payload) return;
    this.wallHp = new Map(payload.hp || []);
    this.broken = new Set(payload.broken || []);
  }

  update({ camera, meta, state, me, weapon }) {
    const now = performance.now();
    if (now - this.lastAt < 100) return;
    this.lastAt = now;
    const target = me && me.alive && meta ? this.pick(camera, meta, state, me) : null;
    if (!target) {
      this.el.classList.add("hidden");
      this.key = "";
      return;
    }
    const pct = Math.max(0, Math.min(1, target.frac));
    const hp = Math.round(pct * target.maxHp);
    const perShot = (weapon?.damage || 30) * (weapon?.pellets || weapon?.fan || 1) * target.scale;
    const shots = Math.max(1, Math.ceil(hp / Math.max(1, perShot)));
    const hint =
      target.kind === "vehicle"
        ? `~${shots} shots to wreck`
        : target.kind === "tree"
          ? `~${shots} shots to fell`
          : `~${shots} shots · or ram it with a vehicle`;
    const key = `${target.name}|${hp}|${hint}`;
    if (key !== this.key) {
      this.key = key;
      this.nameEl.textContent = `${target.name}  ${hp} / ${target.maxHp}`;
      this.fillEl.style.width = `${(pct * 100).toFixed(0)}%`;
      this.fillEl.style.background = pct > 0.6 ? "#58d27a" : pct > 0.3 ? "#f0c048" : "#ef5a4a";
      this.hintEl.textContent = hint;
    }
    this.el.classList.remove("hidden");
  }

  pick(camera, meta, state, me) {
    const o = camera.position;
    const d = new THREE.Vector3();
    camera.getWorldDirection(d);
    let best = null;
    let bestT = MAX_RANGE;
    const consider = (t, info) => {
      if (t !== null && t > 0.3 && t < bestT) {
        bestT = t;
        best = info;
      }
    };
    const destroyed = new Set(state?.destroyedProps || []);
    const treeHp = new Map(state?.treeHp || []);
    for (const p of meta.props || []) {
      if (p.collidable === false || p.type === "glass") continue;
      if (this.broken?.has(p.id) || destroyed.has(p.id)) continue;
      // Cheap reject: props far from the ray's reach.
      if (Math.abs(p.x - o.x) > MAX_RANGE + p.sx || Math.abs(p.z - o.z) > MAX_RANGE + p.sz) continue;
      const base = p.py || 0;
      const t = rayBox(o, d, { x: p.x - p.sx / 2, y: base, z: p.z - p.sz / 2 }, { x: p.x + p.sx / 2, y: base + p.sy, z: p.z + p.sz / 2 });
      if (t === null) continue;
      if (p.breakable) {
        const label = p.roofTile ? "Roof" : p.side ? "Wall" : p.type.charAt(0).toUpperCase() + p.type.slice(1);
        consider(t, { kind: "wall", name: label, frac: this.wallHp.get(p.id) ?? 1, maxHp: Math.round(p.maxHp), scale: WALL_BULLET_SCALE });
      } else if (p.type === "tree") {
        consider(t, { kind: "tree", name: "Tree", frac: treeHp.get(p.id) ?? 1, maxHp: TREE_HP, scale: 1 });
      } else {
        consider(t, null); // solid but unbreakable: blocks what's behind it
      }
    }
    for (const v of state?.vehicles || []) {
      if (v.destroyed || v.id === me.inVehicle) continue;
      const sh = vehicleShape(v);
      // Ray in the vehicle's local frame.
      const c = Math.cos(v.yaw);
      const s = Math.sin(v.yaw);
      const dx = o.x - v.x;
      const dz = o.z - v.z;
      const lo = { x: dx * c - dz * s, y: o.y - (v.y || 0), z: dx * s + dz * c };
      const ld = { x: d.x * c - d.z * s, y: d.y, z: d.x * s + d.z * c };
      const t = rayBox(lo, ld, { x: -sh.hx, y: 0.25, z: -sh.hz }, { x: sh.hx, y: sh.h, z: sh.hz });
      const name = { car: "Car", sports: "Sports car", suv: "SUV", pickup: "Pickup", truck: "Truck", bike: "Bike", apc: "APC", heli: "Helicopter", plane: "Plane" }[v.type] || "Vehicle";
      consider(t, { kind: "vehicle", name, frac: (v.health ?? 100) / 100, maxHp: 100, scale: VEHICLE_BULLET_SCALE });
    }
    return best;
  }
}
