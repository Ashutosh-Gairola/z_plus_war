/**
 * Server-side weather cycle shared by frag and Z+. Everyone sees the same
 * sky: the server picks the next weather at random (weighted), holds it for a
 * few minutes and fades between them; clients render the transition.
 *
 * Gameplay: wet roads and snow cost vehicles grip (weatherGrip). Fog and
 * storms cut visibility client-side.
 *
 * FORCE_WEATHER=<kind> pins the weather (testing / events).
 */

const KINDS = {
  clear: { weight: 3.2, minS: 150, maxS: 320 },
  cloudy: { weight: 2.2, minS: 120, maxS: 260 },
  rain: { weight: 1.8, minS: 120, maxS: 240 },
  storm: { weight: 0.8, minS: 90, maxS: 180 },
  fog: { weight: 1.1, minS: 90, maxS: 200 },
  snow: { weight: 1.2, minS: 120, maxS: 240 },
};
const TRANSITION_MS = 25000;

function pickNext(current) {
  const options = Object.entries(KINDS).filter(([k]) => k !== current);
  let r = Math.random() * options.reduce((n, [, v]) => n + v.weight, 0);
  for (const [k, v] of options) {
    r -= v.weight;
    if (r <= 0) return k;
  }
  return "clear";
}

function holdFor(kind) {
  const k = KINDS[kind];
  return (k.minS + Math.random() * (k.maxS - k.minS)) * 1000;
}

function createWeather(now = Date.now()) {
  const forced = process.env.FORCE_WEATHER && KINDS[process.env.FORCE_WEATHER] ? process.env.FORCE_WEATHER : null;
  const kind = forced || "clear";
  return { kind, prev: kind, changedAt: now - TRANSITION_MS, until: forced ? Infinity : now + holdFor(kind), forced };
}

function updateWeather(w, now = Date.now()) {
  if (w.forced || now < w.until) return false;
  w.prev = w.kind;
  w.kind = pickNext(w.kind);
  w.changedAt = now;
  w.until = now + holdFor(w.kind);
  return true;
}

function serializeWeather(w, now = Date.now()) {
  return {
    kind: w.kind,
    prev: w.prev,
    t: Math.round(Math.min(1, Math.max(0, (now - w.changedAt) / TRANSITION_MS)) * 100) / 100,
  };
}

/** Vehicle traction multiplier for the current (blended) weather. */
function weatherGrip(w, now = Date.now()) {
  const g = (k) => (k === "snow" ? 0.62 : k === "rain" || k === "storm" ? 0.8 : 1);
  const t = Math.min(1, Math.max(0, (now - w.changedAt) / TRANSITION_MS));
  return g(w.prev) + (g(w.kind) - g(w.prev)) * t;
}

module.exports = { createWeather, updateWeather, serializeWeather, weatherGrip, WEATHER_KINDS: Object.keys(KINDS) };
