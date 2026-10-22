/**
 * Client helpers for the 3-slot loadout and ground loot (frag mode).
 * The server is authoritative; these just read the snapshot.
 */

export const DEFAULT_SLOTS = ["rifle", "smg", "sniper"];
export const PICKUP_RADIUS = 2.4; // a touch under the server's 2.6 so prompts never lie

export const RARITY = {
  default: { label: "Standard", color: "#c8ced6", hex: 0xc8ced6 },
  rare: { label: "Rare", color: "#4aa8ff", hex: 0x4aa8ff },
  epic: { label: "Epic", color: "#b066ff", hex: 0xb066ff },
  legendary: { label: "Legendary", color: "#ffb020", hex: 0xffb020 },
};

export function weaponInfo(worldMeta, key) {
  const w = worldMeta?.weapons?.find((x) => x.key === key);
  return w || { key, label: String(key || "rifle").toUpperCase(), rarity: "default", fireMode: "semi" };
}

export function rarityOf(worldMeta, key) {
  return RARITY[weaponInfo(worldMeta, key).rarity] || RARITY.default;
}

export function slotsOf(me) {
  return Array.isArray(me?.slots) && me.slots.length ? me.slots : DEFAULT_SLOTS;
}

/** Nearest ground weapon within pickup range of the player, or null. */
export function nearestGroundWeapon(state, me) {
  if (!me || !me.alive || me.inVehicle) return null;
  let best = null;
  let bestDist = PICKUP_RADIUS;
  for (const g of state?.groundWeapons || []) {
    const d = Math.hypot(g.x - me.x, g.z - me.z);
    if (d <= bestDist) {
      bestDist = d;
      best = g;
    }
  }
  return best;
}
