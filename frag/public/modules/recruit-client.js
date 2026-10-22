/**
 * Client view of the roaming recruit beacon (server: npc-system
 * createRecruitBeacon). One beacon for everyone; each player can have one
 * companion per role (4 roles), and the beacon is hidden for a full party.
 */

export const RECRUIT_RADIUS = 6.5;
export const PARTY_ROLES = ["healer", "attacker", "defender", "summoner"];

/** Roles this player currently has (alive or on their way). */
export function partyRoles(state, myId) {
  return new Set(
    (state?.npcs || [])
      .filter((n) => n.ownerId === myId && n.role !== "minion" && n.state !== "dead")
      .map((n) => n.role),
  );
}

/**
 * { beacon, visible, inRange, dist, progressMs, holdMs, fullParty } for the
 * local player, or null before the first snapshot.
 */
export function recruitContext(state, me) {
  const beacon = state?.recruit;
  if (!beacon || !me) return null;
  const fullParty = partyRoles(state, me.id).size >= PARTY_ROLES.length;
  const dist = Math.hypot(beacon.x - me.x, beacon.z - me.z);
  const visible = beacon.active && !fullParty;
  return {
    beacon,
    visible,
    fullParty,
    dist,
    inRange: visible && me.alive && !me.inVehicle && dist <= RECRUIT_RADIUS,
    progressMs: (beacon.progress || {})[me.id] || 0,
    holdMs: beacon.holdMs || 10000,
  };
}
