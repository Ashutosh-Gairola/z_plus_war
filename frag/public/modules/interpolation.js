/**
 * State interpolation logic
 */

import { clamp01, lerp, lerpAngle, normalizeAngle } from "./utils.js";

export function interpState(stateBuffer, now, serverOffset, INTERP_DELAY_MS) {
  if (stateBuffer.length === 0) return null;
  if (stateBuffer.length === 1) return stateBuffer[0];

  const target = now - serverOffset - INTERP_DELAY_MS;
  const first = stateBuffer[0];
  const last = stateBuffer[stateBuffer.length - 1];

  if (target <= first.serverTime) return first;
  if (target >= last.serverTime) return last;

  for (let i = 0; i < stateBuffer.length - 1; i += 1) {
    const a = stateBuffer[i];
    const b = stateBuffer[i + 1];
    if (target < a.serverTime || target > b.serverTime) continue;

    const t = clamp01(
      (target - a.serverTime) / Math.max(1, b.serverTime - a.serverTime)
    );
    const amap = new Map(a.players.map((p) => [p.id, p]));
    const bmap = new Map(b.players.map((p) => [p.id, p]));
    const ids = new Set([...amap.keys(), ...bmap.keys()]);
    const players = [];

    for (const id of ids) {
      const p0 = amap.get(id) || bmap.get(id);
      const p1 = bmap.get(id) || p0;
      players.push({
        id,
        name: p1.name,
        x: lerp(p0.x, p1.x, t),
        y: lerp(p0.y, p1.y, t),
        z: lerp(p0.z, p1.z, t),
        vx: lerp(p0.vx ?? 0, p1.vx ?? 0, t),
        vy: lerp(p0.vy ?? 0, p1.vy ?? 0, t),
        vz: lerp(p0.vz ?? 0, p1.vz ?? 0, t),
        yaw: lerpAngle(p0.yaw, p1.yaw, t),
        pitch: lerp(p0.pitch, p1.pitch, t),
        health: lerp(p0.health, p1.health, t),
        kills: p1.kills,
        score: p1.score,
        deaths: p1.deaths,
        alive: p1.alive,
        respawnMs: Math.round(lerp(p0.respawnMs || 0, p1.respawnMs || 0, t)),
        weapon: p1.weapon,
        previousWeapon: p1.previousWeapon,
        ammoInMag: Math.round(lerp(p0.ammoInMag || 0, p1.ammoInMag || 0, t)),
        magSize: p1.magSize,
        reloadingMs: Math.round(lerp(p0.reloadingMs || 0, p1.reloadingMs || 0, t)),
        switchingMs: Math.round(lerp(p0.switchingMs || 0, p1.switchingMs || 0, t)),
        meleeMs: Math.round(lerp(p0.meleeMs || 0, p1.meleeMs || 0, t)),
        movementPenaltyMs: p1.movementPenaltyMs || 0,
        inVehicle: p1.inVehicle || null,
        seat: p1.seat || null,
        crouching: Boolean(p1.crouching),
        lastShotAt: p1.lastShotAt || 0,
        deathTilt: p1.deathTilt || 0,
        deathRoll: p1.deathRoll || 0,
        deathProgress: lerp(p0.deathProgress || 0, p1.deathProgress || 0, t),
      });
    }

    // Zombies (Z+ mode): interpolate positions/yaw, pass state through.
    let zombiesOut;
    if (Array.isArray(b.zombies)) {
      const zmap = new Map((a.zombies || []).map((z) => [z.id, z]));
      zombiesOut = b.zombies.map((z1) => {
        const z0 = zmap.get(z1.id) || z1;
        return {
          ...z1,
          x: lerp(z0.x, z1.x, t),
          y: lerp(z0.y, z1.y, t),
          z: lerp(z0.z, z1.z, t),
          yaw: lerpAngle(z0.yaw, z1.yaw, t),
        };
      });
    }

    // AI companions: same treatment — smooth pose, pass role/state through.
    let npcsOut;
    if (Array.isArray(b.npcs)) {
      const nmap = new Map((a.npcs || []).map((n) => [n.id, n]));
      npcsOut = b.npcs.map((n1) => {
        const n0 = nmap.get(n1.id) || n1;
        return {
          ...n1,
          x: lerp(n0.x, n1.x, t),
          y: lerp(n0.y, n1.y, t),
          z: lerp(n0.z, n1.z, t),
          yaw: lerpAngle(n0.yaw, n1.yaw, t),
        };
      });
    }

    // Z+ rift event: dragon, vortex, fireballs and mini-dragon pets glide
    // between snapshots like everything else.
    let riftOut = b.rift;
    if (b.rift && a.rift) {
      const r0 = a.rift;
      const r1 = b.rift;
      riftOut = { ...r1 };
      if (r1.dragon && r0.dragon) {
        riftOut.dragon = {
          ...r1.dragon,
          x: lerp(r0.dragon.x, r1.dragon.x, t),
          y: lerp(r0.dragon.y, r1.dragon.y, t),
          z: lerp(r0.dragon.z, r1.dragon.z, t),
          yaw: lerpAngle(r0.dragon.yaw, r1.dragon.yaw, t),
          pitch: lerp(r0.dragon.pitch, r1.dragon.pitch, t),
          roll: lerpAngle(r0.dragon.roll, r1.dragon.roll, t),
        };
      }
      if (r1.vortex && r0.vortex) {
        riftOut.vortex = { ...r1.vortex, x: lerp(r0.vortex.x, r1.vortex.x, t), y: lerp(r0.vortex.y, r1.vortex.y, t), z: lerp(r0.vortex.z, r1.vortex.z, t), r: lerp(r0.vortex.r, r1.vortex.r, t) };
      }
      if (r1.fb && r0.fb) {
        const m = new Map(r0.fb.map((f) => [f[0], f]));
        riftOut.fb = r1.fb.map((f) => {
          const g = m.get(f[0]);
          return g ? [f[0], lerp(g[1], f[1], t), lerp(g[2], f[2], t), lerp(g[3], f[3], t)] : f;
        });
      }
      if (r1.pets && r0.pets) {
        const m = new Map(r0.pets.map((p) => [p[0], p]));
        riftOut.pets = r1.pets.map((p) => {
          const q = m.get(p[0]);
          return q ? [p[0], lerp(q[1], p[1], t), lerp(q[2], p[2], t), lerp(q[3], p[3], t), lerpAngle(q[4], p[4], t), ...p.slice(5)] : p;
        });
      }
    }

    // Champion bosses: smooth body + projectiles.
    let champOut = b.champ;
    if (b.champ && a.champ && a.champ.k === b.champ.k) {
      const c0 = a.champ;
      const c1 = b.champ;
      champOut = { ...c1, x: lerp(c0.x, c1.x, t), y: lerp(c0.y, c1.y, t), z: lerp(c0.z, c1.z, t), yaw: lerpAngle(c0.yaw, c1.yaw, t) };
      if (c1.pr && c0.pr) {
        const m = new Map(c0.pr.map((p) => [p[0], p]));
        champOut.pr = c1.pr.map((p) => {
          const q = m.get(p[0]);
          return q ? [p[0], p[1], lerp(q[2], p[2], t), lerp(q[3], p[3], t), lerp(q[4], p[4], t), p[5]] : p;
        });
      }
    }

    return {
      ...b,
      rift: riftOut,
      champ: champOut,
      timerMs: b.timerMs !== undefined && a.timerMs !== undefined ? Math.round(lerp(a.timerMs, b.timerMs, t)) : b.timerMs,
      zone:
        b.zone && a.zone
          ? {
              ...b.zone,
              x: lerp(a.zone.x, b.zone.x, t),
              z: lerp(a.zone.z, b.zone.z, t),
              radius: lerp(a.zone.radius, b.zone.radius, t),
            }
          : b.zone,
      players,
      zombies: zombiesOut,
      npcs: npcsOut,
      serverTime: Math.round(lerp(a.serverTime, b.serverTime, t)),
    };
  }

  return last;
}
