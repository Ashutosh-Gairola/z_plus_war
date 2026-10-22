/**
 * Utility functions
 */

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function clamp01(v) {
  return clamp(v, 0, 1);
}

export function normalizeAngle(rad) {
  let x = rad;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function lerpAngle(a, b, t) {
  const d = normalizeAngle(b - a);
  return normalizeAngle(a + d * t);
}

export function fmtTime(ms) {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function isMobileClient() {
  const MOBILE_RE =
    /iPhone|iPad|iPod|Android|Mobile|webOS|BlackBerry|IEMobile|Opera Mini|Windows Phone/i;
  return MOBILE_RE.test(navigator.userAgent || "");
}
