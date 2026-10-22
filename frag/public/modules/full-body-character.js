/**
 * Third-person soldier: a detailed tactical operator built on a full joint
 * hierarchy (shoulders/elbows/hands, hips/knees, spine, head) driven by a
 * blended animation state machine — idle / walk / run / sprint / jump / fall /
 * land / crouch / aim / fire / reload / melee.
 *
 * Proportions line up with the server hitboxes (head center ~1.66m, chest
 * 0.72–1.34m, legs below 0.76m). The weapon rides a torso-space mount
 * ("weaponSocket") that is shouldered and aimed; both arms reach it with
 * two-bone IK so hands stay on the grip and handguard.
 *
 * Looks are data-driven: players get one of several outfits picked from a
 * seed (their id), NPC roles get a dedicated loadout with glowing role
 * accents. Each look is built once, merged per joint/material, then cloned.
 */

import { mergeStaticMeshes } from "./mesh-merge.js";
import { roundedBox, limbGeo } from "./geo-kit.js";

// ---------------------------------------------------------------------------
// Looks
// ---------------------------------------------------------------------------

const OUTFITS = {
  ranger: {
    camo: ["#5d6247", "#3e4430", "#857c5a", "#2a2e22"],
    vest: 0x4d5138, gear: 0x3c4030, helmet: 0x565c40, boots: 0x3d3126, gloves: 0x2b2b26,
    headgear: "fast", face: "glasses", headset: true, nvg: false, pack: "assault",
  },
  desert: {
    camo: ["#b39d74", "#8c7652", "#cdb88f", "#6f5c40"],
    vest: 0x8a7553, gear: 0x7a6748, helmet: 0xa08c66, boots: 0x7a6248, gloves: 0x5e5040,
    headgear: "fast", face: "shemagh", headset: true, nvg: false, pack: "assault",
  },
  urban: {
    camo: ["#5f6369", "#3e4146", "#858a90", "#2b2d31"],
    vest: 0x2f3237, gear: 0x26292d, helmet: 0x3b3e43, boots: 0x1d1e21, gloves: 0x1f2023,
    headgear: "cap", face: "glasses", headset: true, nvg: false, pack: "none",
  },
  spectre: {
    camo: ["#2c2e31", "#1c1e21", "#3d4045", "#141517"],
    vest: 0x1d1f22, gear: 0x17181b, helmet: 0x222428, boots: 0x141518, gloves: 0x151619,
    headgear: "fast", face: "balaclava", headset: true, nvg: true, pack: "assault",
  },
  jungle: {
    camo: ["#4b5a36", "#2c3620", "#6d5f3c", "#1c2216"],
    vest: 0x3f4a2e, gear: 0x343d26, helmet: 0x4a5634, boots: 0x2e261d, gloves: 0x2a2c22,
    headgear: "boonie", face: "none", headset: false, nvg: false, pack: "radio",
  },
};

const ROLE_LOOKS = {
  healer: {
    ...OUTFITS.ranger, headgear: "boonie", face: "glasses", headset: true, pack: "medic", accent: 0x37d98a,
  },
  attacker: {
    ...OUTFITS.spectre, face: "balaclava", goggles: true, nvg: false, pack: "assault", accent: 0xe8563a,
  },
  defender: {
    camo: ["#3b4552", "#283039", "#55606d", "#1b2128"],
    vest: 0x2a323c, gear: 0x222931, helmet: 0x2d3540, boots: 0x16191d, gloves: 0x1a1d21,
    headgear: "heavy", face: "none", headset: false, nvg: false, pack: "none", heavy: true, accent: 0x4aa0ff,
  },
  summoner: {
    camo: ["#3d3546", "#29232f", "#55495f", "#1b171f"],
    vest: 0x2b2531, gear: 0x231e28, helmet: 0x2b2531, boots: 0x17141a, gloves: 0x1b181e,
    headgear: "hood", face: "visor", headset: false, nvg: false, pack: "radio", accent: 0xb066ff,
  },
  minion: {
    camo: ["#6b5c48", "#4a3f31", "#857257", "#33291f"],
    vest: 0x4a3f31, gear: 0x3b3227, helmet: 0x4a3f31, boots: 0x2a221b, gloves: 0x2a2520,
    headgear: "none", face: "gasmask", headset: false, nvg: false, pack: "none", accent: 0xff8a3c,
  },
};

const SKIN_TONES = [0xc28e6a, 0xa8774f, 0x7d5537, 0xd2a07e, 0x5e3f2a];
const HAIR_TONES = [0x2a1d14, 0x14100c, 0x4a3420, 0x3a2a1c];

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Resolve build options to a concrete look (+ a cache key). */
export function resolveCharacterLook(opts = {}) {
  if (opts.role && ROLE_LOOKS[opts.role]) {
    const h = hashString(`role:${opts.role}`);
    return {
      ...ROLE_LOOKS[opts.role],
      skin: SKIN_TONES[h % SKIN_TONES.length],
      hair: HAIR_TONES[(h >>> 3) % HAIR_TONES.length],
      beard: false,
      key: `role:${opts.role}`,
    };
  }
  const h = hashString(String(opts.seed ?? "player"));
  const names = Object.keys(OUTFITS);
  const outfit = opts.outfit && OUTFITS[opts.outfit] ? opts.outfit : names[h % names.length];
  const skin = SKIN_TONES[(h >>> 5) % SKIN_TONES.length];
  const hair = HAIR_TONES[(h >>> 9) % HAIR_TONES.length];
  const beard = ((h >>> 13) & 3) === 0;
  return { ...OUTFITS[outfit], skin, hair, beard, key: `${outfit}:${skin}:${hair}:${beard}` };
}

// ---------------------------------------------------------------------------
// Textures + materials (shared across every character)
// ---------------------------------------------------------------------------

const textureCache = new Map();
const materialCache = new Map();

function canvasTexture(key, size, paint) {
  if (textureCache.has(key)) return textureCache.get(key);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  paint(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  textureCache.set(key, tex);
  return tex;
}

function addFabricNoise(ctx, size, seed, amount = 16, weaveDepth = 3) {
  const rand = rng(seed);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const weave = (x % 3 === 0 ? -weaveDepth : 0) + (y % 3 === 0 ? -weaveDepth * 0.7 : 0);
      const n = (rand() - 0.5) * amount + weave;
      d[i] = Math.max(0, Math.min(255, d[i] + n));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
    }
  }
  ctx.putImageData(img, 0, 0);
}

function camoTexture(colors) {
  const key = `camo:${colors.join(",")}`;
  return canvasTexture(key, 256, (ctx, size) => {
    const rand = rng(hashString(key));
    ctx.fillStyle = colors[0];
    ctx.fillRect(0, 0, size, size);
    const counts = [0, 26, 22, 30];
    const radii = [0, 20, 15, 7];
    for (let layer = 1; layer < colors.length; layer += 1) {
      ctx.fillStyle = colors[layer];
      for (let b = 0; b < counts[layer]; b += 1) {
        const cx = rand() * size;
        const cy = rand() * size;
        const lobes = 3 + Math.floor(rand() * 4);
        for (let l = 0; l < lobes; l += 1) {
          const ox = cx + (rand() - 0.5) * radii[layer] * 1.6;
          const oy = cy + (rand() - 0.5) * radii[layer] * 1.2;
          const rx = radii[layer] * (0.5 + rand() * 0.7);
          const ry = rx * (0.45 + rand() * 0.5);
          const rot = rand() * Math.PI;
          // Draw wrapped copies so the pattern tiles seamlessly.
          for (const dx of [-size, 0, size]) {
            for (const dy of [-size, 0, size]) {
              ctx.beginPath();
              ctx.ellipse(ox + dx, oy + dy, rx, ry, rot, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      }
    }
    addFabricNoise(ctx, size, hashString(key) ^ 0x9e37, 10);
  });
}

function weaveBumpTexture() {
  return canvasTexture("bump:weave", 256, (ctx, size) => {
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, size, size);
    addFabricNoise(ctx, size, 0x51ed, 40, 10);
    // A few seams / folds.
    ctx.strokeStyle = "rgba(40,40,40,0.5)";
    ctx.lineWidth = 2;
    for (let i = 0; i < 6; i += 1) {
      ctx.beginPath();
      ctx.moveTo(0, 20 + i * 42);
      ctx.bezierCurveTo(80, 10 + i * 42, 170, 40 + i * 42, 256, 24 + i * 42);
      ctx.stroke();
    }
  });
}

function shemaghTexture() {
  return canvasTexture("shemagh", 128, (ctx, size) => {
    ctx.fillStyle = "#8f8466";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#3b3326";
    for (let y = 0; y < size; y += 16) {
      for (let x = 0; x < size; x += 16) {
        if (((x + y) / 16) % 2 === 0) ctx.fillRect(x + 4, y + 4, 8, 8);
      }
    }
    ctx.fillRect(0, 0, size, 3);
    ctx.fillRect(0, 64, size, 3);
    addFabricNoise(ctx, size, 0x77, 14);
  });
}

function cachedMaterial(key, make) {
  if (!materialCache.has(key)) materialCache.set(key, make());
  return materialCache.get(key);
}

function fabricMat(colors) {
  return cachedMaterial(`fabric:${colors.join(",")}`, () =>
    new THREE.MeshStandardMaterial({
      map: camoTexture(colors),
      bumpMap: weaveBumpTexture(),
      bumpScale: 0.004,
      roughness: 0.93,
      metalness: 0.0,
    }),
  );
}

/** Shared vertex-colored materials that flat-colored parts merge into. */
function solidGroup(kind) {
  const presets = {
    cloth: { roughness: 0.88, metalness: 0.04, bump: true },
    skin: { roughness: 0.6, metalness: 0.0, bump: false },
  };
  const p = presets[kind];
  return cachedMaterial(`group:${kind}`, () =>
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: p.roughness,
      metalness: p.metalness,
      bumpMap: p.bump ? weaveBumpTexture() : null,
      bumpScale: p.bump ? 0.003 : 1,
    }),
  );
}

/**
 * Flat-colored part. Only its color matters: at build time it merges into one
 * shared vertex-colored material (cloth / skin) per joint.
 */
function solidMat(color, roughness = 0.85, metalness = 0.05, bump = true) {
  const kind = !bump && roughness <= 0.62 && metalness === 0 ? "skin" : "cloth";
  return cachedMaterial(`solid:${color}:${kind}`, () => {
    const mat = new THREE.MeshStandardMaterial({ color });
    mat.userData.mergeInto = solidGroup(kind);
    return mat;
  });
}

function glowMat(color, intensity = 1.2) {
  return cachedMaterial(`glow:${color}:${intensity}`, () =>
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.4 }),
  );
}

function glassMat(color = 0x0d1116) {
  return cachedMaterial(`glass:${color}`, () =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.28, metalness: 0.45, side: THREE.DoubleSide }),
  );
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function add(parent, geometry, material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  parent.add(mesh);
  return mesh;
}

function ellipsoid(parent, r, sx, sy, sz, material, x = 0, y = 0, z = 0, ws = 18, hs = 14) {
  const mesh = add(parent, new THREE.SphereGeometry(r, ws, hs), material, x, y, z);
  mesh.scale.set(sx, sy, sz);
  return mesh;
}

function group(parent, name, x = 0, y = 0, z = 0) {
  const g = new THREE.Group();
  if (name) g.name = name;
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

// ---------------------------------------------------------------------------
// Body parts
// ---------------------------------------------------------------------------

function buildHead(head, look, m) {
  const covered = look.face === "balaclava" || look.headgear === "heavy";
  const headSkin = look.face === "balaclava" ? m.balaclava : m.skin;

  // Skull + jaw + facial features. Skull center sits ~1.69m when standing.
  ellipsoid(head, 0.104, 0.92, 1.06, 1.0, headSkin, 0, 0.065, 0);
  ellipsoid(head, 0.072, 0.92, 0.78, 0.95, headSkin, 0, 0.012, 0.03); // jaw
  ellipsoid(head, 0.03, 1.15, 0.8, 0.8, headSkin, 0, -0.012, 0.06, 12, 10); // chin
  if (!covered) {
    add(head, roundedBox(0.026, 0.045, 0.03, 0.01), m.skin, 0, 0.055, 0.1, 0.25); // nose
    for (const s of [-1, 1]) {
      ellipsoid(head, 0.022, 0.5, 1.0, 0.75, m.skin, s * 0.093, 0.06, 0.0, 10, 8); // ears
      ellipsoid(head, 0.011, 1.15, 0.55, 0.5, m.eyeWhite, s * 0.035, 0.083, 0.09, 10, 8);
      ellipsoid(head, 0.0062, 1, 1, 0.6, m.pupil, s * 0.035, 0.083, 0.0945, 8, 6);
      add(head, roundedBox(0.04, 0.009, 0.014, 0.004), m.hair, s * 0.036, 0.097, 0.094, 0, 0, s * 0.12); // brows
      add(head, roundedBox(0.03, 0.006, 0.01, 0.003), m.skin, s * 0.035, 0.09, 0.093); // eyelid crease
    }
  }
  if (look.beard && !covered && look.face !== "shemagh" && look.face !== "gasmask") {
    ellipsoid(head, 0.074, 0.95, 0.72, 0.95, m.hair, 0, 0.004, 0.034);
    ellipsoid(head, 0.034, 1.15, 0.85, 0.95, m.hair, 0, -0.022, 0.07, 12, 10);
    add(head, roundedBox(0.055, 0.01, 0.016, 0.005), m.hair, 0, 0.034, 0.099); // moustache
  }
  if (look.headgear === "cap" || look.headgear === "boonie" || look.headgear === "none") {
    // Short hair under soft headgear.
    ellipsoid(head, 0.103, 0.93, 0.85, 1.0, m.hair, 0, 0.09, -0.008);
  }

  // ---- Face gear ----
  if (look.face === "balaclava") {
    add(head, roundedBox(0.12, 0.035, 0.03, 0.012), m.skin, 0, 0.083, 0.083); // eye slit
    for (const s of [-1, 1]) {
      ellipsoid(head, 0.011, 1.15, 0.55, 0.5, m.eyeWhite, s * 0.035, 0.083, 0.098, 8, 6);
      ellipsoid(head, 0.0062, 1, 1, 0.6, m.pupil, s * 0.035, 0.083, 0.1025, 8, 6);
    }
  }
  if (look.face === "glasses" || look.face === "shemagh") {
    const lens = new THREE.CylinderGeometry(0.113, 0.113, 0.034, 22, 1, true, -1.0, 2.0);
    add(head, lens, m.glass, 0, 0.083, 0.003);
  }
  if (look.goggles) {
    add(head, roundedBox(0.17, 0.05, 0.05, 0.018), m.gear, 0, 0.085, 0.075);
    for (const s of [-1, 1]) add(head, roundedBox(0.058, 0.032, 0.012, 0.01), m.accent || m.glass, s * 0.037, 0.085, 0.1);
    add(head, new THREE.TorusGeometry(0.104, 0.01, 6, 24), m.gear, 0, 0.088, 0, Math.PI / 2);
  }
  if (look.face === "shemagh") {
    const wrap = new THREE.SphereGeometry(0.108, 18, 10, Math.PI * 0.05, Math.PI * 0.9, Math.PI * 0.5, Math.PI * 0.32);
    const lower = add(head, wrap, m.shemagh, 0, 0.055, 0.004);
    lower.rotation.y = 0;
    add(head, new THREE.TorusGeometry(0.07, 0.03, 8, 18), m.shemagh, 0, -0.06, 0, Math.PI / 2);
  }
  if (look.face === "gasmask") {
    add(head, roundedBox(0.13, 0.11, 0.07, 0.035), m.mask, 0, 0.03, 0.075);
    for (const s of [-1, 1]) {
      add(head, new THREE.CylinderGeometry(0.022, 0.022, 0.008, 16), m.accent || m.glass, s * 0.036, 0.083, 0.106, Math.PI / 2);
      add(head, new THREE.CylinderGeometry(0.034, 0.034, 0.05, 14), m.gearDark, s * 0.06, 0.005, 0.1, Math.PI / 2 - 0.4, 0, s * 0.5);
    }
    add(head, new THREE.CylinderGeometry(0.028, 0.032, 0.04, 14), m.gearDark, 0, -0.005, 0.12, Math.PI / 2);
  }
  if (look.face === "visor") {
    add(head, new THREE.CylinderGeometry(0.104, 0.104, 0.026, 22, 1, true, -0.95, 1.9), m.accent, 0, 0.083, 0.006);
    add(head, roundedBox(0.12, 0.07, 0.05, 0.025), m.mask, 0, 0.025, 0.07);
  }

  // ---- Headgear ----
  if (look.headgear === "fast" || look.headgear === "heavy") {
    const heavy = look.headgear === "heavy";
    const r = heavy ? 0.132 : 0.125;
    const shell = add(head, new THREE.SphereGeometry(r, 24, 14, 0, Math.PI * 2, 0, Math.PI * (heavy ? 0.62 : 0.5)), m.helmet, 0, 0.08, -0.006);
    shell.scale.set(1, 0.98, 1.08);
    // Brim edge + side rails + NVG shroud + rear counterweight.
    const rim = add(head, new THREE.TorusGeometry(r, 0.008, 6, 32), m.helmet, 0, 0.08, -0.006, Math.PI / 2);
    rim.scale.set(1, 1.08, 1);
    for (const s of [-1, 1]) add(head, roundedBox(0.012, 0.03, 0.12, 0.005), m.gearDark, s * (r + 0.004), 0.1, -0.01);
    add(head, roundedBox(0.06, 0.04, 0.02, 0.008), m.gearDark, 0, 0.17, 0.115, -0.35);
    add(head, roundedBox(0.07, 0.045, 0.02, 0.01), m.gear, 0, 0.13, -0.135, 0.3);
    add(head, roundedBox(0.05, 0.035, 0.012, 0.006), m.gear, 0, 0.2, -0.05, -1.2); // velcro patch
    if (m.accent) add(head, roundedBox(0.016, 0.022, 0.012, 0.005), m.accent, 0, 0.165, -0.13, 0.3); // IR strobe
    if (look.nvg) {
      const nvg = group(head, null, 0, 0.19, 0.12);
      nvg.rotation.x = -0.9;
      add(nvg, roundedBox(0.08, 0.035, 0.04, 0.01), m.gearDark, 0, 0, 0);
      for (const s of [-1, 1]) add(nvg, new THREE.CylinderGeometry(0.017, 0.019, 0.07, 12), m.gearDark, s * 0.032, 0.0, 0.04, Math.PI / 2);
    }
    if (heavy) {
      // Full-face ballistic visor + mandible guard.
      add(head, new THREE.CylinderGeometry(0.128, 0.128, 0.09, 24, 1, true, -1.15, 2.3), m.glass, 0, 0.07, -0.004);
      add(head, new THREE.CylinderGeometry(0.129, 0.129, 0.012, 24, 1, true, -1.1, 2.2), m.accent || m.gear, 0, 0.083, -0.004);
      add(head, new THREE.CylinderGeometry(0.12, 0.112, 0.07, 24, 1, true, -1.2, 2.4), m.helmet, 0, -0.012, 0.0);
      for (const s of [-1, 1]) add(head, roundedBox(0.03, 0.09, 0.1, 0.012), m.helmet, s * 0.12, 0.04, -0.01);
    }
  } else if (look.headgear === "boonie") {
    add(head, new THREE.CylinderGeometry(0.19, 0.2, 0.012, 24), m.cloth, 0, 0.13, -0.005);
    add(head, new THREE.CylinderGeometry(0.098, 0.112, 0.085, 20), m.cloth, 0, 0.175, -0.005);
    ellipsoid(head, 0.098, 1, 0.3, 1, m.cloth, 0, 0.218, -0.005);
    add(head, new THREE.CylinderGeometry(0.113, 0.113, 0.02, 20, 1, true), m.gear, 0, 0.145, -0.005);
    if (m.accent) add(head, new THREE.CylinderGeometry(0.114, 0.114, 0.012, 20, 1, true), m.accent, 0, 0.16, -0.005);
  } else if (look.headgear === "cap") {
    // Backwards cap.
    const crown = add(head, new THREE.SphereGeometry(0.108, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), m.capMat, 0, 0.1, -0.005);
    crown.scale.set(1, 0.85, 1.05);
    add(head, roundedBox(0.14, 0.012, 0.08, 0.005), m.capMat, 0, 0.11, -0.13, -0.15);
  } else if (look.headgear === "hood") {
    const hood = add(head, new THREE.SphereGeometry(0.14, 22, 14, Math.PI * 0.5 + 0.85, Math.PI * 2 - 1.7, 0, Math.PI * 0.72), m.hood, 0, 0.075, -0.012);
    hood.scale.set(1, 1.08, 1.08);
    add(head, new THREE.CylinderGeometry(0.12, 0.17, 0.12, 20, 1, true), m.hood, 0, -0.06, -0.02);
  }

  if (look.headset) {
    for (const s of [-1, 1]) {
      add(head, new THREE.CylinderGeometry(0.042, 0.042, 0.035, 16), m.gearDark, s * 0.104, 0.06, 0, 0, 0, Math.PI / 2);
      add(head, new THREE.CylinderGeometry(0.03, 0.03, 0.038, 12), m.gear, s * 0.106, 0.06, 0, 0, 0, Math.PI / 2);
    }
    add(head, new THREE.CylinderGeometry(0.004, 0.004, 0.1, 6), m.gearDark, 0.085, 0.03, 0.07, 1.25, 0.4, 0); // mic boom
    add(head, roundedBox(0.016, 0.012, 0.016, 0.005), m.gearDark, 0.045, 0.02, 0.112);
  }
}

function buildTorso(torso, look, m) {
  const heavy = Boolean(look.heavy);

  // ---- Body under the gear ----
  add(torso, roundedBox(0.3, 0.2, 0.19, 0.07), m.shirt, 0, 0.08, 0);
  add(torso, roundedBox(0.36, 0.26, 0.22, 0.09), m.shirt, 0, 0.29, 0);
  add(torso, roundedBox(0.4, 0.09, 0.18, 0.045), m.shirt, 0, 0.405, -0.005);
  for (const s of [-1, 1]) add(torso, roundedBox(0.13, 0.06, 0.13, 0.03), m.shirt, s * 0.07, 0.455, -0.01, 0, 0, s * -0.3); // traps
  add(torso, new THREE.CylinderGeometry(0.048, 0.056, 0.1, 12), m.skinNeck, 0, 0.51, 0.0);
  add(torso, new THREE.TorusGeometry(0.06, 0.02, 8, 18), m.shirt, 0, 0.475, 0.0, Math.PI / 2); // collar

  // ---- Plate carrier ----
  const pt = heavy ? 0.07 : 0.045;
  add(torso, roundedBox(0.31, 0.3, pt, 0.02), m.vest, 0, 0.28, 0.11 + pt / 2);
  add(torso, roundedBox(0.31, 0.31, pt, 0.02), m.vest, 0, 0.28, -0.11 - pt / 2);
  add(torso, roundedBox(0.38, 0.12, 0.27, 0.035), m.vest, 0, 0.16, 0); // cummerbund
  for (const s of [-1, 1]) {
    add(torso, roundedBox(0.065, 0.025, 0.27, 0.01), m.vest, s * 0.1, 0.44, 0, 0, 0, s * 0.12); // shoulder straps
    add(torso, roundedBox(0.02, 0.1, 0.12, 0.008), m.gear, s * 0.195, 0.16, 0.02); // side pouch
  }
  // MOLLE rows on the front + back.
  for (let i = 0; i < 4; i += 1) {
    add(torso, roundedBox(0.29, 0.012, 0.006, 0.002), m.gearDark, 0, 0.16 + i * 0.065, 0.111 + pt);
    add(torso, roundedBox(0.29, 0.012, 0.006, 0.002), m.gearDark, 0, 0.16 + i * 0.065, -0.111 - pt);
  }
  // Triple mag pouch with mag tops, admin pouch, name patch.
  const front = 0.112 + pt;
  for (const x of [-0.088, 0, 0.088]) {
    add(torso, roundedBox(0.078, 0.11, 0.05, 0.012), m.gear, x, 0.2, front + 0.022);
    add(torso, roundedBox(0.05, 0.035, 0.03, 0.006), m.polymer, x, 0.265, front + 0.02);
  }
  add(torso, roundedBox(0.2, 0.075, 0.03, 0.01), m.gear, 0, 0.33, front + 0.012);
  add(torso, roundedBox(0.075, 0.04, 0.006, 0.003), m.accent || m.patch, -0.055, 0.34, front + 0.03);
  // Radio + antenna on the left side, tourniquet on the right strap.
  add(torso, roundedBox(0.055, 0.12, 0.04, 0.01), m.gearDark, -0.205, 0.26, -0.04);
  add(torso, new THREE.CylinderGeometry(0.004, 0.006, 0.16, 6), m.gearDark, -0.205, 0.39, -0.05, 0.1);
  add(torso, roundedBox(0.03, 0.09, 0.03, 0.01), m.patch2, 0.1, 0.38, front - 0.01, 0, 0, 0.1);

  if (heavy) {
    // Juggernaut: neck guard, groin flap, thick side plates.
    add(torso, new THREE.CylinderGeometry(0.1, 0.13, 0.08, 18, 1, true), m.vest, 0, 0.49, 0);
    add(torso, roundedBox(0.2, 0.16, 0.035, 0.015), m.vest, 0, -0.03, front - 0.02);
    for (const s of [-1, 1]) add(torso, roundedBox(0.045, 0.2, 0.2, 0.015), m.vest, s * 0.205, 0.24, 0);
    if (m.accent) add(torso, roundedBox(0.2, 0.012, 0.006, 0.003), m.accent, 0, 0.42, front + 0.003);
  }

  // ---- Back ----
  if (look.pack === "assault" || look.pack === "medic") {
    const medic = look.pack === "medic";
    const packMat = medic ? m.packMedic : m.gear;
    add(torso, roundedBox(0.27, 0.32, 0.14, 0.04), packMat, 0, 0.25, -0.215);
    add(torso, roundedBox(0.25, 0.06, 0.15, 0.02), packMat, 0, 0.41, -0.215); // lid
    add(torso, roundedBox(0.2, 0.13, 0.03, 0.012), m.gearDark, 0, 0.2, -0.29); // front pocket
    for (const s of [-1, 1]) add(torso, roundedBox(0.04, 0.16, 0.09, 0.012), packMat, s * 0.15, 0.22, -0.21);
    if (medic && m.accent) {
      add(torso, roundedBox(0.09, 0.025, 0.006, 0.003), m.accent, 0, 0.27, -0.288);
      add(torso, roundedBox(0.025, 0.09, 0.006, 0.003), m.accent, 0, 0.27, -0.288);
    }
    add(torso, new THREE.CylinderGeometry(0.006, 0.006, 0.3, 6), m.gearDark, 0.12, 0.36, -0.02, 0.4, 0, 0.35); // hydration tube
  } else if (look.pack === "radio") {
    add(torso, roundedBox(0.22, 0.28, 0.12, 0.03), m.gear, 0, 0.26, -0.2);
    add(torso, roundedBox(0.16, 0.12, 0.03, 0.01), m.gearDark, 0, 0.3, -0.27);
    add(torso, new THREE.CylinderGeometry(0.004, 0.007, 0.6, 6), m.gearDark, -0.07, 0.62, -0.22, -0.12);
    if (m.accent) ellipsoid(torso, 0.014, 1, 1, 1, m.accent, -0.07, 0.92, -0.255, 10, 8);
  }
}

function buildArm(arm, s, look, m) {
  ellipsoid(arm, 0.068, 1.05, 1.1, 1.0, m.shirt, s * 0.008, -0.02, 0); // deltoid
  add(arm, limbGeo(0.3, [[0, 0.06], [0.3, 0.064], [0.75, 0.052], [1, 0.047]]), m.shirt);
  add(arm, roundedBox(0.016, 0.07, 0.07, 0.006), m.gear, s * 0.06, -0.1, 0); // sleeve pocket
  add(arm, roundedBox(0.008, 0.045, 0.06, 0.003), m.accent || m.patch, s * 0.07, -0.1, 0);
  if (look.heavy) {
    add(arm, roundedBox(0.13, 0.05, 0.15, 0.022), m.vest, s * 0.03, 0.035, 0, 0, 0, s * -0.35);
    add(arm, roundedBox(0.11, 0.05, 0.13, 0.02), m.vest, s * 0.04, -0.015, 0, 0, 0, s * -0.5);
  }
  if (m.accent && look.pack === "medic") {
    add(arm, new THREE.CylinderGeometry(0.068, 0.066, 0.04, 14, 1, true), m.accent, 0, -0.16, 0);
  }
}

function buildForearm(elbow, look, m) {
  add(elbow, limbGeo(0.27, [[0, 0.048], [0.25, 0.05], [0.8, 0.039], [1, 0.034]]), m.shirt);
  add(elbow, roundedBox(0.075, 0.07, 0.04, 0.015), m.gear, 0, -0.005, -0.04); // elbow pad
  add(elbow, new THREE.CylinderGeometry(0.043, 0.04, 0.05, 12), m.gloves, 0, -0.245, 0); // glove cuff
}

function buildHand(hand, s, m) {
  // Palm center sits 0.06 below the wrist; fingers wrap forward (+Z).
  add(hand, roundedBox(0.07, 0.085, 0.035, 0.014), m.gloves, 0, -0.045, 0);
  add(hand, roundedBox(0.072, 0.03, 0.05, 0.012), m.gloves, 0, -0.09, 0.012, 0.6);
  add(hand, roundedBox(0.062, 0.026, 0.04, 0.01), m.gloves, 0, -0.098, 0.04, 1.4);
  add(hand, roundedBox(0.058, 0.014, 0.01, 0.004), m.gearDark, 0, -0.084, 0.032, 0.6); // knuckle pad
  add(hand, roundedBox(0.022, 0.06, 0.024, 0.009), m.gloves, s * -0.037, -0.05, 0.03, 0.7, 0, s * 0.35); // thumb
}

function buildLeg(leg, knee, s, look, m) {
  add(leg, limbGeo(0.42, [[0, 0.085], [0.25, 0.083], [0.7, 0.066], [1, 0.057]], 16), m.pants);
  add(leg, roundedBox(0.03, 0.12, 0.11, 0.012), m.pants, s * 0.078, -0.23, 0.0); // cargo pocket
  add(leg, roundedBox(0.032, 0.014, 0.115, 0.005), m.pants, s * 0.08, -0.17, 0.0); // pocket flap
  if (s === 1) {
    // Drop-leg holster + sidearm.
    add(leg, roundedBox(0.035, 0.03, 0.07, 0.01), m.gearDark, s * 0.08, -0.06, -0.005);
    add(leg, roundedBox(0.045, 0.15, 0.08, 0.015), m.gearDark, s * 0.095, -0.13, 0.005);
    add(leg, roundedBox(0.03, 0.06, 0.035, 0.008), m.polymer, s * 0.095, -0.04, -0.012, -0.25);
  } else {
    add(leg, roundedBox(0.035, 0.11, 0.09, 0.012), m.gear, s * 0.085, -0.09, 0.0); // dump pouch
  }
  if (look.heavy) add(leg, roundedBox(0.12, 0.2, 0.04, 0.015), m.vest, 0, -0.17, 0.075);

  add(knee, limbGeo(0.33, [[0, 0.06], [0.2, 0.06], [0.75, 0.047], [1, 0.044]], 16), m.pants);
  add(knee, roundedBox(0.105, 0.11, 0.045, 0.02), m.gear, 0, -0.02, 0.058); // knee pad
  add(knee, roundedBox(0.07, 0.02, 0.012, 0.004), m.gearDark, 0, -0.02, 0.083);
  // Combat boot.
  add(knee, new THREE.CylinderGeometry(0.056, 0.062, 0.15, 14), m.boots, 0, -0.33, -0.005);
  add(knee, roundedBox(0.105, 0.085, 0.25, 0.035), m.boots, 0, -0.405, 0.04);
  add(knee, roundedBox(0.112, 0.024, 0.265, 0.008), m.sole, 0, -0.445, 0.04);
  for (let i = 0; i < 4; i += 1) add(knee, roundedBox(0.05, 0.006, 0.01, 0.002), m.gearDark, 0, -0.29 - i * 0.03, 0.055);
}

function buildMaterials(look) {
  const accent = typeof look.accent === "number" ? glowMat(look.accent, 1.1) : null;
  return {
    shirt: fabricMat(look.camo),
    pants: fabricMat(look.camo),
    cloth: fabricMat(look.camo),
    hood: cachedMaterial(`hood:${look.camo.join(",")}`, () => {
      const mat = fabricMat(look.camo).clone();
      mat.side = THREE.DoubleSide;
      return mat;
    }),
    vest: solidMat(look.vest, 0.9),
    gear: solidMat(look.gear, 0.9),
    gearDark: solidMat(0x1a1b1e, 0.8, 0.1),
    polymer: solidMat(0x222326, 0.6, 0.2, false),
    helmet: solidMat(look.helmet, 0.7, 0.1),
    boots: solidMat(look.boots, 0.8, 0.05),
    sole: solidMat(0x121212, 0.95, 0.0, false),
    gloves: solidMat(look.gloves, 0.75, 0.05),
    skin: solidMat(look.skin, 0.62, 0.0, false),
    skinNeck: solidMat(look.face === "balaclava" ? 0x1a1b1d : look.skin, 0.62, 0.0, false),
    balaclava: solidMat(0x1a1b1d, 0.95, 0.0),
    hair: solidMat(look.hair, 0.9, 0.0),
    eyeWhite: solidMat(0xcfc6b8, 0.35, 0.0, false),
    pupil: solidMat(0x1a120c, 0.2, 0.0, false),
    glass: glassMat(),
    mask: solidMat(0x2a2c2f, 0.6, 0.1),
    shemagh: cachedMaterial("mat:shemagh", () =>
      new THREE.MeshStandardMaterial({ map: shemaghTexture(), roughness: 0.95, side: THREE.DoubleSide }),
    ),
    capMat: solidMat(look.gear, 0.9),
    packMedic: solidMat(0x3f4a38, 0.9),
    patch: solidMat(0x6b6f5a, 0.9),
    patch2: solidMat(0x1d1e20, 0.8),
    accent,
  };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const JOINTS = new Set([
  "hips", "torso", "head", "leftLeg", "rightLeg", "leftKnee", "rightKnee",
  "leftArm", "rightArm", "leftElbow", "rightElbow", "leftHand", "rightHand",
  "aimFrame", "weaponSocket",
]);

const templates = new Map();

function buildTemplate(look) {
  const m = buildMaterials(look);
  const root = new THREE.Group();

  const hips = group(root, "hips", 0, 0.95, 0);
  add(hips, roundedBox(0.33, 0.2, 0.22, 0.07), m.pants, 0, -0.02, 0);
  add(hips, roundedBox(0.37, 0.06, 0.25, 0.02), m.gear, 0, 0.06, 0); // battle belt
  add(hips, roundedBox(0.05, 0.04, 0.012, 0.005), m.polymer, 0, 0.06, 0.128); // buckle
  add(hips, roundedBox(0.1, 0.08, 0.05, 0.015), m.gear, -0.1, 0.03, -0.13); // butt pouch
  add(hips, roundedBox(0.06, 0.08, 0.04, 0.012), m.gear, 0.13, 0.04, 0.09); // pistol mag pouch

  for (const side of ["left", "right"]) {
    const s = side === "left" ? -1 : 1;
    const leg = group(hips, `${side}Leg`, s * 0.105, -0.06, 0);
    const knee = group(leg, `${side}Knee`, 0, -0.42, 0);
    buildLeg(leg, knee, s, look, m);
  }

  const torso = group(hips, "torso", 0, 0.08, 0);
  buildTorso(torso, look, m);

  for (const side of ["left", "right"]) {
    const s = side === "left" ? -1 : 1;
    const arm = group(torso, `${side}Arm`, s * 0.205, 0.4, 0);
    buildArm(arm, s, look, m);
    const elbow = group(arm, `${side}Elbow`, 0, -0.3, 0);
    buildForearm(elbow, look, m);
    const hand = group(elbow, `${side}Hand`, 0, -0.27, 0);
    buildHand(hand, s, m);
  }

  const head = group(torso, "head", 0, 0.57, 0);
  buildHead(head, look, m);

  // Weapon mount: a frame that cancels hip/torso rotation (so the gun aims
  // where the player looks) holding the socket the gun's pistol grip sits on.
  const aimFrame = group(torso, "aimFrame");
  group(aimFrame, "weaponSocket");

  mergeStaticMeshes(root, { isJoint: (o) => JOINTS.has(o.name), castShadow: true, receiveShadow: true });
  return root;
}

export function buildFullBodyCharacter(opts = {}) {
  const look = resolveCharacterLook(opts);
  if (!templates.has(look.key)) templates.set(look.key, buildTemplate(look));
  const body = templates.get(look.key).clone();
  body.userData.look = look.key;
  return body;
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

export function createFullBodyAnimationState() {
  return {
    time: Math.random() * 10,
    lastVy: 0,
    landBlend: 0,
    fireBlend: 0,
    reloadTime: 0,
    reloadBlend: 0,
    meleeBlend: 0,
    crouchBlend: 0,
    airBlend: 0,
    sprintBlend: 0,
    current: "idle",
  };
}

function damp(current, target, dt, speed = 12) {
  return current + (target - current) * Math.min(1, dt * speed);
}

function setEulerDamped(obj, x, y, z, dt, speed = 12) {
  if (!obj) return;
  obj.rotation.x = damp(obj.rotation.x, x, dt, speed);
  obj.rotation.y = damp(obj.rotation.y, y, dt, speed);
  obj.rotation.z = damp(obj.rotation.z, z, dt, speed);
}

const UPPER_ARM = 0.3;
const FOREARM = 0.27 + 0.06; // wrist + palm center
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _p = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _euler = new THREE.Euler();
const _target = new THREE.Vector3();
const _mat = new THREE.Matrix4();

/**
 * Two-bone IK in the arm's parent (torso) space. The upper arm hangs along -Y;
 * the elbow is a hinge on X that folds the forearm toward +Z.
 */
function solveArmIK(arm, elbow, target, pole) {
  _d.copy(target).sub(arm.position);
  const maxReach = UPPER_ARM + FOREARM - 0.002;
  const dist = Math.min(Math.max(_d.length(), 0.08), maxReach);
  _d.normalize();
  const cosInner = (UPPER_ARM * UPPER_ARM + FOREARM * FOREARM - dist * dist) / (2 * UPPER_ARM * FOREARM);
  const bend = Math.PI - Math.acos(Math.min(1, Math.max(-1, cosInner)));

  // Hand position in the unrotated arm frame with the elbow bent.
  _v1.set(0, -UPPER_ARM - FOREARM * Math.cos(bend), FOREARM * Math.sin(bend)).normalize();
  _q1.setFromUnitVectors(_v1, _d);

  // Twist about the reach axis so the elbow points toward the pole.
  _e.set(0, -UPPER_ARM, 0).applyQuaternion(_q1);
  _e.addScaledVector(_d, -_e.dot(_d));
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_e.lengthSq() > 1e-8 && _p.lengthSq() > 1e-8) {
    _e.normalize();
    _p.normalize();
    const angle = Math.atan2(_cross.crossVectors(_e, _p).dot(_d), _e.dot(_p));
    _q2.setFromAxisAngle(_d, angle);
    _q1.premultiply(_q2);
  }
  arm.quaternion.copy(_q1);
  elbow.rotation.set(-bend, 0, 0);
}

const POLE_RIGHT = new THREE.Vector3(0.7, -1, -0.35);
const POLE_LEFT = new THREE.Vector3(-0.45, -1, -0.1);
const SHOULDER_POCKET = new THREE.Vector3(0.095, 0.37, 0.13);

/** Position the weapon (aimFrame/socket) and solve both arms onto it. */
function poseWeaponAndArms(parts, playerData, state, anchors, aimPitch, dt) {
  const { hips, torso, aimFrame, socket, leftArm, rightArm, leftElbow, rightElbow } = parts;

  // aimFrame cancels the body's hip + torso rotation.
  _qa.copy(hips.quaternion).multiply(torso.quaternion).invert();
  aimFrame.quaternion.copy(_qa);

  const sprint = state.sprintBlend;
  const reload = state.reloadBlend;
  const melee = Math.sin(Math.min(1, state.meleeBlend) * Math.PI);

  // Shoulder pocket (torso space) expressed in aim space; the stock butt sits there.
  _v1.copy(SHOULDER_POCKET).applyQuaternion(_qa);
  const buttDepth = -anchors.buttZ;

  // Aim pose: shouldered, barrel along the look direction.
  const pitch = -aimPitch + state.fireBlend * -0.07;
  _euler.set(pitch, 0, 0);
  socket.quaternion.setFromEuler(_euler);
  _v2.set(0, -0.055, buttDepth - state.fireBlend * 0.035).applyQuaternion(socket.quaternion);
  socket.position.copy(_v1).add(_v2);

  // Sprint: tactical carry, muzzle low and across the chest.
  if (sprint > 0.001) {
    _euler.set(0.75, 0.75, -0.35);
    _q2.setFromEuler(_euler);
    socket.quaternion.slerp(_q2, sprint);
    _v2.set(-0.02, 0.2, 0.3).applyQuaternion(_qa);
    socket.position.lerp(_v2, sprint);
  }
  // Reload: gun rolls inward and dips so the mag well faces the left hand.
  if (reload > 0.001) {
    _euler.set(-aimPitch * 0.3 + 0.35, 0.25, -0.55);
    _q2.setFromEuler(_euler);
    socket.quaternion.slerp(_q2, reload * 0.9);
    _v2.set(0.06, 0.24, 0.32).applyQuaternion(_qa);
    socket.position.lerp(_v2, reload * 0.9);
  }
  // Melee: buttstroke thrust.
  if (melee > 0.001) {
    _euler.set(-0.5, -0.4, 0.2);
    _q2.setFromEuler(_euler);
    socket.quaternion.slerp(_q2, melee);
    socket.position.z += melee * 0.18;
    socket.position.y += melee * 0.08;
  }

  // Hands: anchors in socket space -> torso space.
  aimFrame.updateMatrix();
  socket.updateMatrix();
  _mat.multiplyMatrices(aimFrame.matrix, socket.matrix);

  _target.set(0, -0.015, -0.035).applyMatrix4(_mat); // palm wraps the pistol grip
  solveArmIK(rightArm, rightElbow, _target, POLE_RIGHT);

  _target.copy(anchors.support).add(_v2.set(0, -0.02, 0)).applyMatrix4(_mat);
  if (reload > 0.02) {
    // Left hand: support -> mag well -> belt pouch -> mag well -> support.
    const cycle = Math.min(1, state.reloadTime / 1.6);
    const magWell = _v1.set(0, -0.09, 0.07).applyMatrix4(_mat);
    const pouch = _p.set(-0.08, 0.02, 0.18);
    const toPouch = Math.sin(Math.min(1, Math.max(0, (cycle - 0.15) / 0.55)) * Math.PI);
    const atWell = Math.min(1, cycle / 0.15) * (1 - Math.max(0, (cycle - 0.8) / 0.2));
    _e.copy(_target).lerp(magWell, atWell).lerp(pouch, toPouch);
    _target.lerp(_e, reload);
  }
  solveArmIK(leftArm, leftElbow, _target, POLE_LEFT);
}

export function updateFullBodyAnimations(mesh, playerData, state, deltaTime) {
  if (!state) return;
  const body = mesh.getObjectByName("playerBody");
  if (!body) return;

  if (!state.parts || state.parts.body !== body) {
    const g = (n) => body.getObjectByName(n);
    state.parts = {
      body,
      hips: g("hips"),
      torso: g("torso"),
      head: g("head"),
      leftArm: g("leftArm"),
      rightArm: g("rightArm"),
      leftElbow: g("leftElbow"),
      rightElbow: g("rightElbow"),
      leftLeg: g("leftLeg"),
      rightLeg: g("rightLeg"),
      leftKnee: g("leftKnee"),
      rightKnee: g("rightKnee"),
      aimFrame: g("aimFrame"),
      socket: g("weaponSocket"),
    };
  }
  const parts = state.parts;
  const { hips, torso, head, leftArm, rightArm, leftElbow, rightElbow, leftLeg, rightLeg, leftKnee, rightKnee } = parts;

  state.time += deltaTime;

  // ---- Death collapse ----
  if (!playerData.alive) {
    setEulerDamped(hips, -1.35, 0, playerData.deathTilt || 0.3, deltaTime, 6);
    setEulerDamped(torso, 0.3, 0, playerData.deathRoll || 0.2, deltaTime, 6);
    setEulerDamped(leftArm, -0.4, 0, -0.5, deltaTime, 6);
    setEulerDamped(rightArm, -0.3, 0, 0.6, deltaTime, 6);
    setEulerDamped(leftElbow, -0.3, 0, 0, deltaTime, 6);
    setEulerDamped(rightElbow, -0.3, 0, 0, deltaTime, 6);
    if (hips) hips.position.y = damp(hips.position.y, 0.3, deltaTime, 6);
    // Gun drops with the body instead of floating at the aim point.
    if (parts.aimFrame) parts.aimFrame.quaternion.slerp(_q1.identity(), Math.min(1, deltaTime * 6));
    if (parts.socket) {
      // Torso lies on its back here, so +Z is up and -Y runs toward the feet.
      parts.socket.position.lerp(_v1.set(0.2, 0.25, 0.17), Math.min(1, deltaTime * 6));
      parts.socket.quaternion.slerp(_q2.setFromEuler(_euler.set(Math.PI / 2, 0, 0.3)), Math.min(1, deltaTime * 6));
    }
    return;
  }

  // ---- Locomotion classification ----
  const speed = Math.hypot(playerData.vx || 0, playerData.vz || 0);
  const vy = playerData.vy || 0;
  const airborne = Math.abs(vy) > 1.1;
  const jumping = vy > 1.1;
  const falling = vy < -1.1;
  const sprinting = speed > 9.0 && !airborne;
  const running = speed > 5.6;
  const walking = speed > 0.35;
  const crouching = Boolean(playerData.crouching);

  // Landing detection: was falling, now grounded.
  if (state.lastVy < -3.5 && !airborne) state.landBlend = 1;
  state.lastVy = vy;
  state.landBlend = damp(state.landBlend, 0, deltaTime, 6);

  const firing = Date.now() - (playerData.lastShotAt || 0) < 130;
  state.fireBlend = damp(state.fireBlend, firing ? 1 : 0, deltaTime, 20);
  const reloading = (playerData.reloadingMs || 0) > 0;
  state.reloadBlend = damp(state.reloadBlend, reloading ? 1 : 0, deltaTime, 10);
  state.reloadTime = reloading ? state.reloadTime + deltaTime : 0;
  state.meleeBlend = damp(state.meleeBlend, (playerData.meleeMs || 0) > 0 ? 1 : 0, deltaTime, 16);
  state.crouchBlend = damp(state.crouchBlend, crouching ? 1 : 0, deltaTime, 10);
  state.airBlend = damp(state.airBlend, airborne ? 1 : 0, deltaTime, 8);
  state.sprintBlend = damp(state.sprintBlend, sprinting && !reloading ? 1 : 0, deltaTime, 8);

  state.current = crouching ? "crouch" : jumping ? "jump" : falling ? "fall" : sprinting ? "sprint" : running ? "run" : walking ? "walk" : "idle";

  // ---- Stride oscillators ----
  const strideScale = sprinting ? 1.0 : running ? 0.78 : walking ? 0.5 : 0;
  const strideRate = sprinting ? 12.5 : running ? 9.6 : 6.6;
  const stride = Math.sin(state.time * strideRate) * strideScale;
  const counter = Math.cos(state.time * strideRate) * strideScale;
  const breathe = Math.sin(state.time * 1.8) * 0.008;

  // ---- Hips: crouch drop, land dip, sprint lean, run bounce ----
  const crouchDrop = state.crouchBlend * -0.34;
  const landDrop = state.landBlend * -0.16;
  const bounce = walking ? Math.abs(Math.cos(state.time * strideRate)) * strideScale * 0.045 : 0;
  if (hips) {
    hips.position.y = 0.95 + crouchDrop + landDrop + bounce + breathe;
    hips.rotation.x = damp(hips.rotation.x, state.crouchBlend * 0.06 + (sprinting ? 0.14 : 0), deltaTime, 10);
    hips.rotation.y = damp(hips.rotation.y, stride * 0.08, deltaTime, 10);
  }

  // ---- Torso: lean + aim pitch + bladed shooting stance ----
  const aimPitch = playerData.pitch || 0;
  const aimBlend = 1 - state.sprintBlend;
  const blade = 0.38 * aimBlend;
  // Model faces +Z (renderer yaw-flips it), so looking up = negative rot.x here.
  setEulerDamped(
    torso,
    (sprinting ? 0.22 : walking ? 0.05 : 0.02) + state.crouchBlend * 0.28 - aimPitch * 0.25 + state.landBlend * 0.12,
    blade - stride * 0.06,
    0,
    deltaTime,
    10,
  );
  // Head counters the blade and drops onto the stock to look down the sights.
  setEulerDamped(
    head,
    -aimPitch * 0.5 - state.crouchBlend * 0.15 + aimBlend * 0.08,
    -blade * 0.9 + stride * 0.04,
    aimBlend * 0.1,
    deltaTime,
    12,
  );

  // ---- Arms ----
  const anchors = mesh.userData.weaponAnchors;
  if (anchors && parts.aimFrame && parts.socket) {
    poseWeaponAndArms(parts, playerData, state, anchors, aimPitch, deltaTime);
  } else {
    // No weapon equipped yet: relaxed ready pose.
    setEulerDamped(rightArm, -0.5 + stride * 0.4, 0, 0.12, deltaTime, 14);
    setEulerDamped(leftArm, -0.5 - stride * 0.4, 0, -0.12, deltaTime, 14);
    setEulerDamped(rightElbow, -0.6, 0, 0, deltaTime, 14);
    setEulerDamped(leftElbow, -0.6, 0, 0, deltaTime, 14);
  }

  // ---- Legs ----
  let leftLegX;
  let rightLegX;
  let leftKneeX;
  let rightKneeX;

  if (crouching) {
    leftLegX = -0.95;
    rightLegX = -0.6;
    leftKneeX = 1.35;
    rightKneeX = 1.15;
    if (walking) {
      leftLegX += stride * 0.3;
      rightLegX -= stride * 0.3;
    }
  } else if (jumping) {
    leftLegX = -0.55;
    rightLegX = 0.15;
    leftKneeX = 0.9;
    rightKneeX = 0.35;
  } else if (falling) {
    leftLegX = -0.25;
    rightLegX = -0.1;
    leftKneeX = 0.55;
    rightKneeX = 0.4;
  } else {
    leftLegX = stride * 0.62;
    rightLegX = -stride * 0.62;
    // Knee bends on the back-swing leg.
    leftKneeX = Math.max(0, -counter) * strideScale * 1.1;
    rightKneeX = Math.max(0, counter) * strideScale * 1.1;
    leftLegX += state.landBlend * -0.4;
    rightLegX += state.landBlend * -0.4;
    leftKneeX += state.landBlend * 0.8;
    rightKneeX += state.landBlend * 0.8;
  }

  setEulerDamped(leftLeg, leftLegX, 0, state.crouchBlend * 0.1, deltaTime, 13);
  setEulerDamped(rightLeg, rightLegX, 0, state.crouchBlend * -0.1, deltaTime, 13);
  setEulerDamped(leftKnee, leftKneeX, 0, 0, deltaTime, 13);
  setEulerDamped(rightKnee, rightKneeX, 0, 0, deltaTime, 13);
}
