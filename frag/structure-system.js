/**
 * Destructible buildings.
 *
 * Every building is a set of props (see buildWorldLayout); its outer walls are
 * ~3m "panels" tagged with the face they belong to (+x, -x, +z, -z). Panels
 * take damage from bullets, explosions and vehicle rams; at 0 HP a panel is
 * knocked out (no longer collides, bullets and cars pass through the hole).
 *
 * Structural rules (per building, outer faces only):
 *   - a face is BROKEN once less than 45% of its wall mass is standing
 *   - 2 broken faces  -> UNSTABLE: the building leans toward the open side,
 *     its remaining walls take extra damage, and it will give way on its own
 *     after a while
 *   - 3+ broken faces -> COLLAPSE: everything above the floor comes down,
 *     anyone inside is crushed, and a rubble field is left in its footprint
 *     for the rest of the round (rubble is solid cover you can climb).
 *
 * The host server owns this state; clients get it via payload() (sent on join
 * and whenever it changes) and animate breaks / leans / collapses locally.
 */

const FACE_BROKEN_BELOW = 0.45;
const UNSTABLE_DAMAGE_MULT = 1.6;
const UNSTABLE_SELF_COLLAPSE_MS = [22000, 45000];
// Props that stay standing when the rest of a building comes down.
const SURVIVES_COLLAPSE = new Set(["floor", "rug", "door-threshold"]);

const FACE_NORMAL = {
  "+x": [1, 0],
  "-x": [-1, 0],
  "+z": [0, 1],
  "-z": [0, -1],
};

function createStructureSystem({ worldProps, buildings, onCollapse }) {
  const propById = new Map(worldProps.map((p) => [p.id, p]));
  const state = new Map(); // building id -> runtime state
  const broken = new Set(); // prop ids knocked out
  const stages = new Map(); // prop id -> damage stage (1 = cracked, 2 = crumbling)
  const hpFrac = new Map(); // prop id -> remaining health 0..1 (damaged props only)
  let rubble = [];
  let version = 1;
  let dirty = false;

  function weightOf(p) {
    return Math.max(p.sx, p.sz) * p.sy;
  }

  function init() {
    for (const b of buildings) {
      const faces = {};
      for (const key of Object.keys(FACE_NORMAL)) faces[key] = { total: 0, alive: 0 };
      for (const id of b.propIds) {
        const p = propById.get(id);
        if (!p) continue;
        p.originalCollidable = p.collidable;
        if (p.breakable) p.hp = p.maxHp;
        if (p.breakable && p.side && faces[p.side]) {
          faces[p.side].total += weightOf(p);
          faces[p.side].alive += weightOf(p);
        }
      }
      state.set(b.id, {
        def: b,
        faces,
        state: "intact",
        lean: [0, 0],
        collapseAt: 0,
        collapsedAt: 0,
        lastAttacker: null,
      });
    }
  }

  function brokenFaces(st) {
    const out = [];
    for (const [key, f] of Object.entries(st.faces)) {
      if (f.total > 0 && f.alive / f.total < FACE_BROKEN_BELOW) out.push(key);
    }
    return out;
  }

  function invalidateGrid() {
    // Collision broad-phase is memoized on the props array; rebuild it.
    if (worldProps.__grid) delete worldProps.__grid;
  }

  function knockOut(p) {
    p.destroyed = true;
    p.collidable = false;
    broken.add(p.id);
    stages.delete(p.id);
    hpFrac.delete(p.id);
  }

  /**
   * A roof tile gave way: whatever sat on it (crates, a parapet section) and
   * whatever hung under it (ceiling lamps) comes down too.
   */
  function dropDependents(tile, st) {
    const top = tile.py + tile.sy;
    for (const id of st.def.propIds) {
      const q = propById.get(id);
      if (!q || q === tile || q.destroyed || q.roofTile) continue;
      if (Math.abs(q.x - tile.x) > tile.sx / 2 || Math.abs(q.z - tile.z) > tile.sz / 2) continue;
      const restsOn = Math.abs((q.py || 0) - top) < 0.15;
      const hangsUnder = Math.abs((q.py || 0) + q.sy - tile.py) < 0.35;
      if (restsOn || hangsUnder) knockOut(q);
    }
  }

  function buildRubble(st) {
    const b = st.def;
    const tall = b.h > 10;
    const supertall = b.h > 60;
    const out = [];
    const count = supertall ? 18 : tall ? 9 : 5;
    const maxH = supertall ? 14 : tall ? Math.min(6.5, 2.2 + b.h * 0.12) : 2.0;
    // Debris slides toward the side the building leaned/fell to.
    const [lx, lz] = st.lean;
    for (let i = 0; i < count; i += 1) {
      // A supertall's debris field spreads well past its footprint.
      const spread = supertall ? 1.7 : 0.85;
      const fx = (Math.random() - 0.5) * spread + lx * 1.6;
      const fz = (Math.random() - 0.5) * spread + lz * 1.6;
      const sx = b.w * (0.22 + Math.random() * 0.22);
      const sz = b.d * (0.22 + Math.random() * 0.22);
      const sy = maxH * (0.35 + Math.random() * 0.65);
      out.push({
        id: `rubble-${b.id}-${i}`,
        buildingId: b.id,
        x: b.x + fx * b.w * 0.5,
        z: b.z + fz * b.d * 0.5,
        sx,
        sy,
        sz,
        py: 0,
        y: sy / 2,
        type: "rubble",
        color: b.color,
        collidable: true,
      });
    }
    return out;
  }

  function collapse(st, now) {
    if (st.state === "collapsed") return;
    const b = st.def;
    if (!st.lean[0] && !st.lean[1]) {
      const a = Math.random() * Math.PI * 2;
      st.lean = [Math.cos(a) * 0.05, Math.sin(a) * 0.05];
    }
    st.state = "collapsed";
    st.collapsedAt = now;
    for (const id of b.propIds) {
      const p = propById.get(id);
      if (!p || SURVIVES_COLLAPSE.has(p.type)) continue;
      knockOut(p);
    }
    const pile = buildRubble(st);
    for (const r of pile) worldProps.push(r);
    rubble = rubble.concat(pile);
    invalidateGrid();
    version += 1;
    dirty = true;
    if (onCollapse) onCollapse(b, st.lastAttacker, now);
  }

  function evaluate(st, now) {
    if (st.state === "collapsed") return;
    const faces = brokenFaces(st);
    if (faces.length >= 3) {
      collapse(st, now);
    } else if (faces.length === 2 && st.state === "intact") {
      st.state = "unstable";
      // Lean away from the standing walls, i.e. toward the broken faces.
      let lx = 0;
      let lz = 0;
      for (const f of faces) {
        lx += FACE_NORMAL[f][0];
        lz += FACE_NORMAL[f][1];
      }
      const len = Math.hypot(lx, lz) || 1;
      st.lean = [(lx / len) * 0.05, (lz / len) * 0.05];
      const [a, z] = UNSTABLE_SELF_COLLAPSE_MS;
      st.collapseAt = now + a + Math.random() * (z - a);
      version += 1;
      dirty = true;
    }
  }

  /**
   * Damage a prop. Returns true if this hit knocked it out.
   * attacker: { id, name } of whoever is responsible (for crush kills).
   */
  function damageProp(p, amount, now, attacker = null) {
    if (!p || !p.breakable || p.destroyed || amount <= 0) return false;
    const st = state.get(p.buildingId);
    if (!st || st.state === "collapsed") return false;
    if (attacker) st.lastAttacker = attacker;
    p.hp -= amount * (st.state === "unstable" ? UNSTABLE_DAMAGE_MULT : 1);
    if (p.hp <= 0) {
      knockOut(p);
      if (p.roofTile) dropDependents(p, st);
      if (p.side && st.faces[p.side]) st.faces[p.side].alive -= weightOf(p);
      version += 1;
      dirty = true;
      evaluate(st, now);
      return true;
    }
    const stage = p.hp < p.maxHp * 0.34 ? 2 : p.hp < p.maxHp * 0.67 ? 1 : 0;
    if (stage !== (stages.get(p.id) || 0)) stages.set(p.id, stage);
    // Exact health goes out too (HUD health bar when you aim at it).
    hpFrac.set(p.id, Math.max(0, Math.round((p.hp / p.maxHp) * 100) / 100));
    version += 1;
    dirty = true;
    return false;
  }

  /** Splash damage (rockets, vehicle explosions) to every panel in range. */
  function applyBlast(point, radius, damage, now, attacker = null) {
    let hits = 0;
    for (const st of state.values()) {
      const b = st.def;
      if (st.state === "collapsed") continue;
      if (Math.abs(point.x - b.x) > b.w / 2 + radius || Math.abs(point.z - b.z) > b.d / 2 + radius) continue;
      for (const id of b.propIds) {
        const p = propById.get(id);
        if (!p || !p.breakable || p.destroyed) continue;
        // Distance from the blast to the panel's box.
        const dx = Math.max(Math.abs(point.x - p.x) - p.sx / 2, 0);
        const dz = Math.max(Math.abs(point.z - p.z) - p.sz / 2, 0);
        const dy = Math.max(Math.abs((point.y || 0) - (p.py + p.sy / 2)) - p.sy / 2, 0);
        const d = Math.hypot(dx, dy, dz);
        if (d > radius) continue;
        if (damageProp(p, damage * (1 - d / radius), now, attacker)) hits += 1;
      }
    }
    return hits;
  }

  function update(now) {
    for (const st of state.values()) {
      if (st.state === "unstable" && now >= st.collapseAt) collapse(st, now);
    }
  }

  /** New round: every building stands again and the rubble is cleared. */
  function reset() {
    for (const st of state.values()) {
      st.state = "intact";
      st.lean = [0, 0];
      st.collapseAt = 0;
      st.collapsedAt = 0;
      st.lastAttacker = null;
      for (const f of Object.values(st.faces)) f.alive = f.total;
      for (const id of st.def.propIds) {
        const p = propById.get(id);
        if (!p) continue;
        p.destroyed = false;
        p.collidable = p.originalCollidable;
        if (p.breakable) p.hp = p.maxHp;
      }
    }
    if (rubble.length) {
      const ids = new Set(rubble.map((r) => r.id));
      for (let i = worldProps.length - 1; i >= 0; i -= 1) if (ids.has(worldProps[i].id)) worldProps.splice(i, 1);
    }
    rubble = [];
    broken.clear();
    stages.clear();
    hpFrac.clear();
    invalidateGrid();
    version += 1;
    dirty = true;
  }

  function payload(now = Date.now()) {
    const bstates = [];
    for (const st of state.values()) {
      if (st.state === "intact") continue;
      bstates.push([
        st.def.id,
        st.state,
        Math.round(st.lean[0] * 1000) / 1000,
        Math.round(st.lean[1] * 1000) / 1000,
        st.state === "collapsed" ? now - st.collapsedAt : 0,
      ]);
    }
    return {
      v: version,
      broken: Array.from(broken),
      stages: Array.from(stages.entries()),
      hp: Array.from(hpFrac.entries()),
      buildings: bstates,
      rubble: rubble.map((r) => ({ id: r.id, buildingId: r.buildingId, x: r.x, z: r.z, sx: r.sx, sy: r.sy, sz: r.sz, color: r.color })),
    };
  }

  /** True once since the last call if anything changed (for emitting). */
  function takeDirty() {
    const d = dirty;
    dirty = false;
    return d;
  }

  function stateOf(buildingId) {
    return state.get(buildingId)?.state || null;
  }

  init();
  return { damageProp, applyBlast, update, reset, payload, takeDirty, stateOf };
}

module.exports = { createStructureSystem };
