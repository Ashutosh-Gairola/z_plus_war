/**
 * Backward-compatible player-model API.
 * Delegates to the dedicated full-body character module.
 * opts: { seed } picks a player outfit, { role } an NPC loadout.
 */

import {
  buildFullBodyCharacter,
  createFullBodyAnimationState,
  updateFullBodyAnimations,
} from "./full-body-character.js";

export function buildPlayerBody(opts) {
  return buildFullBodyCharacter(opts);
}

export function createPlayerAnimationState() {
  return createFullBodyAnimationState();
}

export function updatePlayerAnimations(mesh, playerData, state, deltaTime) {
  updateFullBodyAnimations(mesh, playerData, state, deltaTime);
}
