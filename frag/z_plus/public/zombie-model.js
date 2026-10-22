/**
 * Procedural zombie models + animation for Z+ mode.
 *
 * Seven types share a jointed humanoid rig (crawler is re-posed quadruped):
 * walker, runner, tank (and boss variant), screamer, crawler, jumper, flyer.
 * Each type has its own body build and a pool of outfits (office worker,
 * patient, construction worker, police, soldier, jogger, prisoner, …) plus
 * seeded decay: exposed ribs, bite wounds, bone shards, missing eyes, torn
 * cheeks and clothes. A zombie's look is picked from a seed (its id), so the
 * horde is varied but each zombie stays the same across frames/clients.
 *
 * Perf (hordes of ~90): each look is built once, merged into one mesh per
 * joint and material (flat parts are vertex-colored over a shared grime
 * texture), then cloned. Only the bulk (hips/torso/head) casts shadows.
 */

import { buildRigidSkin, instantiateRigidSkin } from "../modules/rigid-skin.js";
import { roundedBox, limbGeo } from "../modules/geo-kit.js";

// Animation tuning per type (scale + idle hunch), unchanged from the old rig.
const TYPE_LOOKS = {
  walker: { scale: 1.0, hunch: 0.25 },
  runner: { scale: 0.95, hunch: 0.5 },
  tank: { scale: 1.45, hunch: 0.15 },
  screamer: { scale: 0.9, hunch: 0.1 },
  crawler: { scale: 0.9, hunch: 0 },
  jumper: { scale: 0.95, hunch: 0.45 },
  flyer: { scale: 0.95, hunch: 0.35 },
};

// Body build per type: chest size, limb thickness, belly, neck, decay level.
const BUILDS = {
  walker: { chestW: 0.36, chestD: 0.21, arm: 0.052, leg: 0.072, belly: 0.02, neck: 0.08, decay: 0.5 },
  runner: { chestW: 0.33, chestD: 0.19, arm: 0.047, leg: 0.066, belly: 0, neck: 0.08, decay: 0.25 },
  tank: { chestW: 0.52, chestD: 0.32, arm: 0.082, leg: 0.09, belly: 0.1, neck: 0.05, decay: 0.4 },
  screamer: { chestW: 0.29, chestD: 0.17, arm: 0.04, leg: 0.058, belly: 0, neck: 0.15, decay: 0.6 },
  crawler: { chestW: 0.31, chestD: 0.17, arm: 0.045, leg: 0.06, belly: 0, neck: 0.08, decay: 0.9 },
  jumper: { chestW: 0.31, chestD: 0.18, arm: 0.048, leg: 0.07, belly: 0, neck: 0.08, decay: 0.6 },
  flyer: { chestW: 0.3, chestD: 0.18, arm: 0.045, leg: 0.06, belly: 0, neck: 0.09, decay: 0.7 },
};

// Infected skin tones: grey-green, jaundiced, bruised purple, pale blue, ashen.
const SKINS = [0x7f8c66, 0x9a9a6a, 0x857487, 0x7c8b90, 0x8d8473, 0x6f7d5a];

const SHIRT_COLORS = [0x6b2a2a, 0x2c3a5a, 0x5a5a58, 0x4f5530, 0x8a6a2a, 0x3c5c58];

// Outfit = what covers each region. sleeves: long|short|none; legs: long|shorts|none.
const OUTFITS = {
  civilian: { shirt: "pick", sleeves: "short", pants: 0x34465f, legs: "long", shoes: 0xd8d4cc },
  office: { shirt: 0xd9dbd6, sleeves: "long", pants: 0x26282d, legs: "long", shoes: 0x1a1612, tie: true },
  patient: { gown: 0x9cc4bf, sleeves: "short", legs: "none", shoes: null },
  worker: { shirt: 0x5c5f63, sleeves: "long", pants: 0x4b4234, legs: "long", shoes: 0x4a3a28, hiVis: true, hat: "hardhat" },
  police: { shirt: 0x1f2a44, sleeves: "long", pants: 0x1b1f2a, legs: "long", shoes: 0x111111, vest: 0x15171b, hat: "cap" },
  soldier: { shirt: 0x4d5636, sleeves: "long", pants: 0x4d5636, legs: "long", shoes: 0x2e261d, vest: 0x3f4630, hat: "helmet" },
  jogger: { shirt: "pick", sleeves: "none", pants: 0x1e1e22, legs: "shorts", shoes: 0xe04a3a },
  hoodie: { shirt: "pick", sleeves: "long", pants: 0x2a2b30, legs: "long", shoes: 0xd8d4cc, hood: true },
  prisoner: { shirt: 0xd8652a, sleeves: "short", pants: 0xd8652a, legs: "long", shoes: 0x2a2a2a },
  butcher: { shirt: 0xcfcac0, sleeves: "short", pants: 0x2f3138, legs: "long", shoes: 0x1a1a1a, apron: 0xd9d6cf },
  mutant: { shirt: null, sleeves: "none", pants: 0x3a3a34, legs: "long", shoes: null, mutant: true },
  dress: { gown: 0x6e5c78, sleeves: "none", legs: "none", shoes: null, longHair: true },
  rags: { shirt: 0x5a5046, sleeves: "short", pants: 0x413a33, legs: "shorts", shoes: null },
  riot: { shirt: 0x1c1f24, sleeves: "long", pants: 0x1c1f24, legs: "long", shoes: 0x0f0f10, vest: 0x2a2e35, hat: "helmet", armor: true },
};

const OUTFIT_POOLS = {
  walker: ["civilian", "office", "patient", "worker", "police", "soldier", "hoodie"],
  runner: ["jogger", "hoodie", "civilian", "jogger"],
  tank: ["prisoner", "butcher", "worker", "mutant"],
  screamer: ["patient", "dress", "office", "dress"],
  crawler: ["rags", "patient", "soldier", "civilian"],
  jumper: ["hoodie", "jogger", "rags", "mutant"],
  flyer: ["rags", "mutant", "rags"],
};

const VARIANTS_PER_TYPE = 8;
const EMERGE_MS = 1700;

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

// ---------------------------------------------------------------------------
// Materials (shared by every zombie)
// ---------------------------------------------------------------------------

const materials = new Map();
function cached(key, make) {
  if (!materials.has(key)) materials.set(key, make());
  return materials.get(key);
}

/** Near-white grime/rot map that the vertex colors multiply. */
function grimeTexture() {
  return cached("tex:grime", () => {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    const rand = rng(0x2b1d);
    ctx.fillStyle = "#e6e6e6";
    ctx.fillRect(0, 0, size, size);
    const blot = (count, rMin, rMax, color) => {
      ctx.fillStyle = color;
      for (let i = 0; i < count; i += 1) {
        const x = rand() * size;
        const y = rand() * size;
        const r = rMin + rand() * (rMax - rMin);
        for (const dx of [-size, 0, size]) {
          for (const dy of [-size, 0, size]) {
            ctx.beginPath();
            ctx.ellipse(x + dx, y + dy, r, r * (0.5 + rand() * 0.5), rand() * Math.PI, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    };
    blot(40, 10, 34, "rgba(150,150,140,0.35)"); // mottling
    blot(26, 6, 18, "rgba(90,85,80,0.35)"); // grime
    blot(16, 3, 10, "rgba(110,20,18,0.55)"); // dried blood
    blot(60, 1, 3, "rgba(60,40,35,0.6)"); // specks
    // Dark veins.
    ctx.strokeStyle = "rgba(70,50,80,0.45)";
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 22; i += 1) {
      let x = rand() * size;
      let y = rand() * size;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let k = 0; k < 6; k += 1) {
        x += (rand() - 0.5) * 30;
        y += (rand() - 0.5) * 30;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    const img = ctx.getImageData(0, 0, size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (rand() - 0.5) * 22;
      img.data[i] += n;
      img.data[i + 1] += n;
      img.data[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  });
}

function groupMat(kind) {
  return cached(`group:${kind}`, () =>
    kind === "wet"
      ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.05 })
      : new THREE.MeshStandardMaterial({ vertexColors: true, map: grimeTexture(), roughness: 0.9, metalness: 0.02 }),
  );
}

/** Flat-colored part; merges into the shared "dry" or "wet" group per joint. */
function flat(color, wet = false) {
  return cached(`flat:${color}:${wet}`, () => {
    const m = new THREE.MeshStandardMaterial({ color });
    m.userData.mergeInto = groupMat(wet ? "wet" : "dry");
    return m;
  });
}

function eyeMat(boss) {
  return cached(`eye:${boss}`, () =>
    new THREE.MeshStandardMaterial({ color: 0xe4ec52, emissive: 0xb8c22a, emissiveIntensity: boss ? 2.0 : 1.2, roughness: 0.4 }),
  );
}

function glowMat(color) {
  return cached(`glow:${color}`, () =>
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.3, roughness: 0.5 }),
  );
}

function membraneMat() {
  return cached("membrane", () =>
    new THREE.MeshStandardMaterial({
      color: 0x4e3f58,
      map: grimeTexture(),
      roughness: 0.8,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.93,
    }),
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

function blob(parent, r, sx, sy, sz, material, x = 0, y = 0, z = 0, ws = 10, hs = 8) {
  const mesh = add(parent, new THREE.SphereGeometry(r, ws, hs), material, x, y, z);
  mesh.scale.set(sx, sy, sz);
  return mesh;
}

// Hordes are big: big parts get a single rounded bevel, tiny ones are plain boxes.
function box(parent, w, h, d, r, material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const geo = r < 0.006 ? new THREE.BoxGeometry(w, h, d) : roundedBox(w, h, d, r, 1);
  return add(parent, geo, material, x, y, z, rx, ry, rz);
}

function joint(parent, name, bones, x = 0, y = 0, z = 0) {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(x, y, z);
  parent.add(g);
  if (bones) bones[name] = g;
  return g;
}

/** Ragged hem: hanging strips of torn cloth. */
function tatters(parent, rand, material, width, y, z, depth, count = 5) {
  for (let i = 0; i < count; i += 1) {
    const x = -width / 2 + (width * (i + 0.5)) / count + (rand() - 0.5) * 0.02;
    const len = 0.03 + rand() * 0.07;
    box(parent, width / count * 0.8, len, depth, 0.004, material, x, y - len / 2, z, 0, 0, (rand() - 0.5) * 0.3);
  }
}

// ---------------------------------------------------------------------------
// Look resolution
// ---------------------------------------------------------------------------

function resolveLook(type, boss, seed) {
  const variant = hashString(`${type}:${seed ?? Math.random()}`) % VARIANTS_PER_TYPE;
  const rand = rng(hashString(`${type}:${boss}:${variant}`));
  const pool = boss ? ["mutant", "riot"] : OUTFIT_POOLS[type] || OUTFIT_POOLS.walker;
  const outfitName = pool[(variant + (boss ? 0 : hashString(type))) % pool.length];
  const outfit = { ...OUTFITS[outfitName], name: outfitName };
  if (outfit.shirt === "pick") outfit.shirt = SHIRT_COLORS[Math.floor(rand() * SHIRT_COLORS.length)];
  const build = BUILDS[type] || BUILDS.walker;
  const skin = type === "flyer" ? 0x7d6f86 : SKINS[Math.floor(rand() * SKINS.length)];
  return {
    key: `${type}:${boss ? 1 : 0}:${variant}`,
    type,
    boss,
    outfit,
    build,
    skin,
    rand,
    hair: [0x1d1612, 0x3a2a1c, 0x5a5048, 0x2a2420][Math.floor(rand() * 4)],
  };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function buildHead(head, bones, look, m) {
  const { type, rand, outfit, boss } = look;
  const decay = look.build.decay;
  const r = type === "tank" ? 0.1 : 0.112;

  // Gaunt skull: cranium, sunken cheeks, brow ridge, sockets.
  blob(head, r, 0.9, 1.04, 0.98, m.skin, 0, 0.02, -0.005, 14, 10);
  blob(head, r * 0.62, 0.95, 0.75, 0.9, m.skin, 0, -0.04, 0.035); // upper jaw / cheeks
  box(head, r * 1.25, 0.022, 0.03, 0.01, m.skin, 0, 0.045, r * 0.82); // brow ridge
  blob(head, 0.016, 1, 1.4, 0.8, m.skinDark, 0, 0.0, r * 0.95); // rotten nose
  const missingEye = rand() < decay * 0.45 ? (rand() < 0.5 ? -1 : 1) : 0;
  for (const s of [-1, 1]) {
    blob(head, 0.026, 1.1, 0.85, 0.5, m.socket, s * 0.042, 0.02, r * 0.82); // sunken socket
    if (s !== missingEye) blob(head, 0.014, 1, 1, 0.8, m.eye, s * 0.042, 0.02, r * 0.88, 8, 6);
    if (!(s === 1 && rand() < decay * 0.3)) blob(head, 0.02, 0.45, 1, 0.7, m.skin, s * r * 0.9, 0.0, 0); // ears (sometimes torn off)
  }
  // Lipless upper teeth.
  for (let i = 0; i < 6; i += 1) {
    box(head, 0.011, 0.016, 0.008, 0.002, m.teeth, -0.03 + i * 0.012, -0.055, r * 0.78 - Math.abs(i - 2.5) * 0.004);
  }
  // Torn cheek exposing gums.
  if (rand() < decay * 0.6) box(head, 0.035, 0.03, 0.02, 0.008, m.flesh, 0.045, -0.045, r * 0.6);

  // Hair: patchy, sometimes bald with exposed skull.
  if (!outfit.hat && !outfit.mutant) {
    const scalp = add(head, new THREE.SphereGeometry(r * 1.02, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.42), m.hair, 0, 0.022, -0.01);
    scalp.scale.set(0.92, 1.05, 1.0);
    if (rand() < decay * 0.5) blob(head, 0.035, 1, 0.5, 1, m.bone, -0.03, r * 0.98, 0.02); // scalp torn to bone
  }
  if (outfit.longHair) {
    for (let i = 0; i < 9; i += 1) {
      const a = Math.PI * 0.35 + (i / 8) * Math.PI * 1.3;
      const len = 0.14 + rand() * 0.12;
      box(head, 0.025, len, 0.01, 0.004, m.hair, Math.cos(a) * r * 0.9, -len / 2 + 0.03, -Math.abs(Math.sin(a)) * r * 0.9, 0, -a, 0);
    }
  }
  if (outfit.mutant) {
    // Swollen growths on the skull.
    for (let i = 0; i < 3; i += 1) blob(head, 0.03 + rand() * 0.02, 1, 0.8, 1, m.skinDark, (rand() - 0.5) * 0.12, 0.08, -0.03 - rand() * 0.04);
  }

  // Headwear.
  if (outfit.hat === "hardhat") {
    const shell = add(head, new THREE.SphereGeometry(r * 1.15, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), m.hardhat, 0, 0.04, 0, -0.15, 0, 0.2);
    shell.scale.set(1, 0.85, 1.1);
    box(head, r * 2.1, 0.012, 0.06, 0.005, m.hardhat, 0, 0.035, r * 1.0, -0.15, 0, 0.2);
  } else if (outfit.hat === "cap") {
    add(head, new THREE.CylinderGeometry(r * 1.0, r * 1.02, 0.05, 14), m.outfitDark, 0, 0.085, -0.005, -0.1);
    add(head, new THREE.CylinderGeometry(r * 1.12, r * 1.12, 0.02, 14), m.outfitDark, 0, 0.12, 0.0, -0.1);
    box(head, 0.12, 0.01, 0.06, 0.004, m.black, 0, 0.065, r * 0.95, -0.3);
  } else if (outfit.hat === "helmet") {
    const shell = add(head, new THREE.SphereGeometry(r * 1.2, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.52), m.helmet, 0, 0.03, -0.005, -0.25, 0, 0.12);
    shell.scale.set(1, 0.92, 1.08);
    if (outfit.armor) add(head, new THREE.CylinderGeometry(r * 1.18, r * 1.18, 0.07, 16, 1, true, -1, 2), m.visor, 0, -0.01, 0);
  }

  // Lower jaw: its own joint so it can gape (screamer hangs open further).
  const jaw = joint(head, "jaw", bones, 0, -0.045, 0.0);
  const jawLen = type === "screamer" ? 1.35 : 1;
  blob(jaw, r * 0.58, 0.9, 0.55 * jawLen, 0.95, m.skin, 0, -0.03 * jawLen, 0.035);
  for (let i = 0; i < 6; i += 1) {
    box(jaw, 0.01, 0.014, 0.008, 0.002, m.teeth, -0.028 + i * 0.0112, -0.016, r * 0.72 - Math.abs(i - 2.5) * 0.004);
  }
  if (rand() < 0.7 || boss) box(jaw, 0.04, 0.05, 0.01, 0.004, m.blood, 0.005, -0.05 * jawLen, r * 0.62); // blood drool
  if (type === "screamer") jaw.position.y = -0.065;
}

function buildTorso(torso, look, m, bones) {
  const { type, outfit, build, rand, boss } = look;
  const { chestW, chestD } = build;
  const decay = build.decay;
  const top = outfit.gown || outfit.shirt ? m.outfit : m.skin;

  // Ribcage + abdomen (+ belly for tanks), hunched trapezius.
  box(torso, chestW * 0.86, 0.22, chestD * 0.9, 0.06, top, 0, 0.11, 0);
  box(torso, chestW, 0.3, chestD, 0.08, top, 0, 0.34, 0);
  for (const s of [-1, 1]) box(torso, chestW * 0.42, 0.08, chestD * 0.8, 0.035, top, s * chestW * 0.24, 0.5, -0.01, 0, 0, s * -0.32);
  if (build.belly > 0) blob(torso, chestW * 0.5, 0.95, 0.75, 0.62 + build.belly, outfit.mutant ? m.skin : top, 0, 0.12, chestD * 0.12, 14, 10);
  add(torso, new THREE.CylinderGeometry(0.045, 0.055, 0.06 + build.neck, 10), m.skin, 0, 0.56 + build.neck * 0.3, 0.01, 0.15);

  // Torn hem.
  if (top === m.outfit) tatters(torso, rand, m.outfit, chestW * 0.8, 0.0, chestD * 0.42, 0.02, 5);

  // Exposed ribs through a torn side.
  const chestCovered = outfit.vest || outfit.hiVis || outfit.apron;
  if (!chestCovered && rand() < decay * 0.8) {
    const s = rand() < 0.5 ? -1 : 1;
    blob(torso, chestW * 0.2, 1, 1.15, 0.12, m.cavity, s * chestW * 0.2, 0.3, chestD / 2 - 0.004, 12, 8);
    for (let i = 0; i < 4; i += 1) {
      box(torso, chestW * 0.3, 0.014, 0.014, 0.005, m.bone, s * chestW * 0.2, 0.24 + i * 0.038, chestD / 2 + 0.012, 0, 0, s * 0.18);
    }
  }
  // Bite wound on the shoulder / neck.
  if (rand() < 0.6) blob(torso, 0.04, 1.2, 0.7, 0.3, m.flesh, (rand() < 0.5 ? -1 : 1) * chestW * 0.3, 0.5, chestD * 0.32);
  // Blood soaking down the front: a few overlapping smears.
  if (top === m.outfit && !chestCovered) {
    const bx = (rand() - 0.5) * chestW * 0.4;
    for (let i = 0; i < 3; i += 1) {
      blob(torso, 0.03 + rand() * 0.025, 1, 1.4, 0.1, m.bloodDry, bx + (rand() - 0.5) * 0.06, 0.46 - i * 0.05, chestD / 2 - 0.002);
    }
  }

  // ---- Outfit details ----
  if (outfit.tie) {
    box(torso, 0.04, 0.2, 0.008, 0.003, m.tie, 0.0, 0.36, chestD / 2 + 0.006, 0, 0, 0.12);
    box(torso, 0.05, 0.03, 0.012, 0.004, m.tie, 0, 0.47, chestD / 2 + 0.006);
  }
  if (outfit.hiVis || outfit.vest) {
    const vestMat = outfit.hiVis ? m.hiVis : m.vestMat;
    box(torso, chestW * 1.06, 0.3, chestD * 1.12, Math.min(chestD * 0.4, 0.1), vestMat, 0, 0.3, 0);
    if (outfit.hiVis) {
      for (const y of [0.22, 0.34]) box(torso, chestW * 1.08, 0.025, chestD * 1.14, 0.01, m.reflective, 0, y, 0);
    } else {
      box(torso, chestW * 0.6, 0.12, 0.03, 0.01, m.black, 0, 0.26, chestD * 0.56 + 0.012);
    }
  }
  if (outfit.armor) {
    for (const s of [-1, 1]) box(torso, 0.15, 0.06, 0.16, 0.025, m.vestMat, s * (chestW / 2 + 0.03), 0.5, 0, 0, 0, s * -0.4);
  }
  if (outfit.apron) {
    box(torso, chestW * 0.75, 0.42, 0.012, 0.004, m.apron, 0, 0.24, chestD / 2 + 0.008);
    for (let i = 0; i < 3; i += 1) blob(torso, 0.04 + rand() * 0.03, 1, 1.3, 0.1, m.bloodDry, (rand() - 0.5) * 0.12, 0.12 + i * 0.07, chestD / 2 + 0.012);
  }
  if (outfit.hood) {
    const hood = blob(torso, 0.13, 1.1, 0.55, 0.9, m.outfit, 0, 0.56, -0.08, 12, 8);
    hood.rotation.x = 0.4;
    box(torso, chestW * 0.5, 0.1, 0.03, 0.02, m.outfit, 0, 0.14, chestD / 2 + 0.01); // front pocket
  }
  if (outfit.gown) {
    // Open back of a hospital gown / dress straps.
    box(torso, 0.035, 0.12, 0.02, 0.006, m.outfit, -chestW * 0.25, 0.55, chestD * 0.3);
    box(torso, 0.035, 0.12, 0.02, 0.006, m.outfit, chestW * 0.25, 0.55, chestD * 0.3);
  }

  // ---- Mutations ----
  if (outfit.mutant || type === "tank") {
    for (let i = 0; i < (type === "tank" ? 4 : 2); i += 1) {
      blob(torso, 0.05 + rand() * 0.05, 1, 0.85, 1, m.skinDark, (rand() - 0.5) * chestW, 0.3 + rand() * 0.25, -chestD * 0.45, 10, 8);
    }
  }
  if (type === "screamer") {
    // Swollen, glowing throat sacs.
    for (let i = 0; i < 4; i += 1) blob(torso, 0.022 + rand() * 0.015, 1, 1, 0.8, m.glowSac, (rand() - 0.5) * 0.09, 0.56 + rand() * 0.08, 0.05, 8, 6);
  }
  if (type === "crawler" || type === "jumper" || type === "flyer") {
    // Spine ridge pushing through the back.
    for (let i = 0; i < 6; i += 1) blob(torso, 0.022, 1.2, 0.8, 1, m.bone, 0, 0.08 + i * 0.08, -chestD / 2 - 0.006, 8, 6);
  }
  if (boss) {
    for (let i = 0; i < 5; i += 1) {
      const x = (i % 2 === 0 ? -1 : 1) * (0.04 + (i * 0.02));
      add(torso, new THREE.ConeGeometry(0.035, 0.2 - i * 0.02, 6), m.bone, x, 0.56 - i * 0.1, -chestD / 2 - 0.05, -1.0, 0, x * 2);
    }
    for (let i = 0; i < 6; i += 1) {
      box(torso, 0.012, 0.12 + rand() * 0.1, 0.006, 0.003, m.glowVein, (rand() - 0.5) * chestW * 0.8, 0.25 + rand() * 0.2, chestD / 2 + 0.006, 0, 0, (rand() - 0.5) * 0.8);
    }
  }
}

function buildArm(arm, elbow, s, look, m) {
  const { outfit, build, rand } = look;
  const a = build.arm;
  const tornSleeve = rand() < 0.35;
  const upperMat = outfit.sleeves === "none" || (tornSleeve && s === 1) ? m.skin : outfit.gown ? m.outfit : outfit.shirt ? m.outfit : m.skin;
  const foreMat = outfit.sleeves === "long" && !(tornSleeve && s === 1) ? m.outfit : m.skin;

  blob(arm, a * 1.35, 1, 1.05, 1, upperMat, s * 0.006, -0.01, 0); // shoulder
  add(arm, limbGeo(0.3, [[0, a * 1.1], [0.3, a * 1.12], [0.8, a * 0.9], [1, a * 0.85]], 10), upperMat);
  if (look.type === "tank") blob(arm, a * 1.3, 1, 1.4, 1, m.skin, 0, -0.15, 0); // bulging bicep

  const fore = look.type === "tank" ? 1.25 : 1;
  add(elbow, limbGeo(0.28, [[0, a * 0.9 * fore], [0.35, a * 1.0 * fore], [1, a * 0.7 * fore]], 10), foreMat);
  if (rand() < build.decay * 0.4) {
    // Bone shard tearing through the forearm.
    add(elbow, new THREE.ConeGeometry(0.012, 0.09, 5), m.bone, a * 0.6, -0.14, 0.02, 0, 0, -0.6);
    blob(elbow, 0.025, 1, 1.5, 0.6, m.flesh, a * 0.55, -0.14, 0.01);
  }

  // Clawed hand: palm + splayed long fingers with dark nails.
  const hand = new THREE.Group();
  hand.position.y = -0.3;
  elbow.add(hand);
  const h = look.type === "tank" ? 1.35 : 1;
  box(hand, 0.06 * h, 0.07 * h, 0.03 * h, 0.012, m.skin, 0, -0.025 * h, 0);
  for (let i = 0; i < 4; i += 1) {
    const fx = (-0.022 + i * 0.015) * h;
    const len = (0.055 + (i === 1 || i === 2 ? 0.012 : 0)) * h;
    box(hand, 0.012 * h, len, 0.012 * h, 0.004, m.skin, fx, -0.06 * h - len / 2, 0.01, 0.35, 0, (i - 1.5) * 0.12);
    add(hand, new THREE.ConeGeometry(0.006 * h, 0.022 * h, 4), m.nail, fx * 1.1, -0.06 * h - len - 0.006, 0.03, Math.PI - 0.35);
  }
  box(hand, 0.014 * h, 0.045 * h, 0.014 * h, 0.005, m.skin, s * -0.035 * h, -0.035 * h, 0.018, 0.5, 0, s * 0.4);
}

function buildLeg(leg, knee, s, look, m) {
  const { outfit, build, rand, type } = look;
  const l = build.leg;
  const thighMat = outfit.legs === "none" ? (outfit.gown ? m.skin : m.skin) : m.pants;
  const shinMat = outfit.legs === "long" ? m.pants : m.skin;

  add(leg, limbGeo(0.42, [[0, l * 1.25], [0.3, l * 1.2], [1, l * 0.88]], 10), thighMat);
  if (outfit.legs === "shorts") tatters(leg, rand, m.pants, l * 2.2, -0.24, l * 0.9, 0.01, 2);
  if (rand() < build.decay * 0.35) box(leg, l * 1.1, 0.08, 0.012, 0.005, m.flesh, 0, -0.2, l * 1.05); // torn knee of trousers

  const stump = type === "crawler" && s === 1 && rand() < 0.5;
  if (stump) {
    // Shin torn off below the knee: ragged stump with bone.
    add(knee, limbGeo(0.12, [[0, l * 0.95], [1, l * 0.8]], 10), shinMat);
    blob(knee, l * 0.85, 1, 0.5, 1, m.flesh, 0, -0.13, 0);
    add(knee, new THREE.CylinderGeometry(0.012, 0.014, 0.08, 6), m.bone, 0, -0.16, 0);
    return;
  }
  add(knee, limbGeo(0.38, [[0, l * 0.92], [0.3, l * 0.95], [1, l * 0.68]], 10), shinMat);
  if (outfit.legs === "long") tatters(knee, rand, m.pants, l * 2, -0.33, l * 0.75, 0.01, 2);
  if (type === "jumper") {
    // Mutated calf + heel spur for the leaping legs.
    blob(knee, l * 1.1, 1, 1.6, 1, m.skinDark, 0, -0.14, -l * 0.5);
    add(knee, new THREE.ConeGeometry(0.014, 0.1, 5), m.bone, 0, -0.38, -0.08, -2.3);
  }

  // Footwear (or bare, clawed feet).
  if (outfit.shoes != null) {
    box(knee, 0.1, 0.07, 0.22, 0.03, m.shoes, 0, -0.41, 0.035);
    box(knee, 0.105, 0.018, 0.23, 0.007, m.black, 0, -0.444, 0.035);
  } else {
    box(knee, 0.085, 0.05, 0.19, 0.022, m.skin, 0, -0.42, 0.03);
    for (let i = 0; i < 3; i += 1) add(knee, new THREE.ConeGeometry(0.006, 0.02, 4), m.nail, -0.025 + i * 0.025, -0.43, 0.13, Math.PI / 2);
  }
}

function buildWings(torso, bones, m) {
  // Bat-like wings: three finger bones per side with membrane panels between.
  for (const side of [-1, 1]) {
    const wing = joint(torso, side < 0 ? "leftWing" : "rightWing", bones, side * 0.14, 0.5, -0.14);
    add(wing, new THREE.CylinderGeometry(0.022, 0.03, 0.42, 6), m.bone, side * 0.2, 0.08, 0, 0, 0, side * (Math.PI / 2 - 0.4)); // arm bone
    const knuckle = new THREE.Vector3(side * 0.4, 0.17, 0);
    blob(wing, 0.035, 1, 1, 1, m.skinDark, knuckle.x, knuckle.y, 0, 8, 6);
    const tips = [
      new THREE.Vector3(side * 1.0, 0.32, 0),
      new THREE.Vector3(side * 0.95, -0.12, 0),
      new THREE.Vector3(side * 0.62, -0.38, 0),
    ];
    for (const tip of tips) {
      const dir = tip.clone().sub(knuckle);
      const len = dir.length();
      const bone = add(wing, new THREE.CylinderGeometry(0.008, 0.016, len, 5), m.bone, (knuckle.x + tip.x) / 2, (knuckle.y + tip.y) / 2, 0);
      bone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      add(wing, new THREE.ConeGeometry(0.014, 0.08, 5), m.nail, tip.x, tip.y, 0, 0, 0, Math.atan2(-dir.x, dir.y));
    }
    // Membrane: fan of triangles from the shoulder/knuckle to each finger tip.
    const root = new THREE.Vector3(0, -0.02, 0);
    const body = new THREE.Vector3(side * 0.06, -0.42, 0);
    const pts = [root, knuckle, tips[0], tips[1], tips[2], body];
    const verts = [];
    const uvs = [];
    for (let i = 1; i < pts.length - 1; i += 1) {
      for (const p of [knuckle, pts[i], pts[i + 1]]) {
        verts.push(p.x, p.y, p.z);
        uvs.push(Math.abs(p.x), p.y + 0.5);
      }
    }
    verts.push(root.x, root.y, 0, knuckle.x, knuckle.y, 0, body.x, body.y, 0);
    uvs.push(0, 0.5, 0.4, 0.7, 0.06, 0.1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
    add(wing, geo, m.membrane);
  }
}

function buildMaterials(look) {
  const { outfit, skin } = look;
  const darken = (hex, f) => new THREE.Color(hex).multiplyScalar(f).getHex();
  return {
    skin: flat(skin),
    skinDark: flat(darken(skin, 0.7)),
    socket: flat(0x1a1210),
    eye: eyeMat(look.boss),
    teeth: flat(0xb8ab84),
    bone: flat(0xd4c9a8),
    nail: flat(0x2a2420),
    flesh: flat(0x5e1614, true),
    cavity: flat(0x3a0e0e, true),
    blood: flat(0x5a0d0b, true),
    bloodDry: flat(0x4a1512),
    hair: flat(look.hair),
    outfit: flat(outfit.gown || outfit.shirt || skin),
    outfitDark: flat(darken(outfit.shirt || 0x333333, 0.8)),
    pants: flat(outfit.pants || 0x333333),
    shoes: flat(outfit.shoes ?? 0x222222),
    black: flat(0x141414),
    tie: flat(0x7a1c22),
    hiVis: flat(0xd8b21c),
    reflective: flat(0xbfc4c8),
    vestMat: flat(outfit.vest || 0x222222),
    apron: flat(outfit.apron || 0xd9d6cf),
    hardhat: flat(0xd9a520),
    helmet: flat(outfit.name === "soldier" ? 0x4d5636 : 0x1d2026),
    visor: cached("zvisor", () => new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.2, metalness: 0.5, transparent: true, opacity: 0.6, side: THREE.DoubleSide })),
    glowSac: glowMat(0xb4e04a),
    glowVein: glowMat(0xff5a2a),
    membrane: membraneMat(),
  };
}

const JOINTS = new Set([
  "hips", "torso", "head", "jaw", "leftArm", "rightArm", "leftElbow", "rightElbow",
  "leftLeg", "rightLeg", "leftKnee", "rightKnee", "leftWing", "rightWing",
]);

const templates = new Map();
/**
 * Low-poly stand-in rig (~200 triangles): same joint names as the detailed
 * body, so the same animation drives it, in the zombie's own colors. Used
 * beyond DETAIL range — one draw call, no shadow.
 */
function buildSimpleRig(look, type) {
  const { build, outfit } = look;
  const top = outfit.gown || outfit.shirt || look.skin;
  const legs = outfit.legs === "long" ? outfit.pants || look.skin : look.skin;
  const sleeve = outfit.sleeves === "long" ? top : look.skin;
  const mat = (color) => {
    const m = new THREE.MeshBasicMaterial({ color });
    m.userData.mergeInto = groupMat("dry");
    return m;
  };
  const named = (parent, name, x, y, z) => {
    const g = new THREE.Group();
    g.name = name;
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  };
  const block = (parent, w, h, d, color, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
    m.position.set(x, y, z);
    parent.add(m);
  };
  const W = build.chestW;
  const root = new THREE.Group();
  const hips = named(root, "hips", 0, 0.92, 0);
  block(hips, W * 0.85, 0.2, build.chestD, legs, 0, 0, 0);
  for (const side of ["left", "right"]) {
    const s = side === "left" ? -1 : 1;
    const leg = named(hips, `${side}Leg`, s * 0.1, -0.06, 0);
    block(leg, build.leg * 2.2, 0.42, build.leg * 2.2, legs, 0, -0.21, 0);
    const knee = named(leg, `${side}Knee`, 0, -0.42, 0);
    block(knee, build.leg * 1.8, 0.4, build.leg * 1.8, legs, 0, -0.2, 0);
    block(knee, 0.1, 0.07, 0.2, outfit.shoes ?? look.skin, 0, -0.41, 0.04);
  }
  const torso = named(hips, "torso", 0, 0.1, 0);
  block(torso, W, 0.52, build.chestD, top, 0, 0.28, 0);
  for (const side of ["left", "right"]) {
    const s = side === "left" ? -1 : 1;
    const arm = named(torso, `${side}Arm`, s * (W / 2 + 0.045), 0.48, 0);
    block(arm, build.arm * 2.2, 0.32, build.arm * 2.2, sleeve, 0, -0.16, 0);
    const elbow = named(arm, `${side}Elbow`, 0, -0.32, 0);
    block(elbow, build.arm * 2, 0.32, build.arm * 2, look.skin, 0, -0.16, 0);
  }
  const head = named(torso, "head", 0, 0.62 + build.neck * 0.5, 0.02);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.11, 6, 4), mat(look.skin));
  skull.position.y = 0.02;
  head.add(skull);
  const jaw = named(head, "jaw", 0, -0.045, 0);
  block(jaw, 0.1, 0.05, 0.1, look.skin, 0, -0.03, 0.04);
  if (type === "flyer") {
    for (const side of ["left", "right"]) {
      const s = side === "left" ? -1 : 1;
      const wing = named(torso, side === "left" ? "leftWing" : "rightWing", s * 0.14, 0.5, -0.14);
      block(wing, 1.2, 0.04, 0.6, 0x4e3f58, s * 0.6, 0, 0);
    }
  }
  if (type === "crawler") {
    hips.position.y = 0.42;
    hips.rotation.x = -1.25;
  }
  return root;
}

function buildTemplate(look) {
  const { type, build } = look;
  const m = buildMaterials(look);
  const bones = {};
  const root = new THREE.Group();

  const hips = joint(root, "hips", bones, 0, 0.92, 0);
  const lowerMat = look.outfit.gown ? m.outfit : m.pants;
  box(hips, 0.31, 0.2, 0.2, 0.06, lowerMat, 0, 0, 0);
  if (!look.outfit.gown) box(hips, 0.33, 0.04, 0.22, 0.015, m.black, 0, 0.08, 0); // belt
  if (look.outfit.gown) {
    // Gown / dress skirt down to the knees, torn at the hem.
    add(hips, new THREE.CylinderGeometry(0.19, 0.25, 0.42, 14, 1, true), m.outfit, 0, -0.2, 0);
    tatters(hips, look.rand, m.outfit, 0.4, -0.41, 0.2, 0.012, 6);
  }

  for (const side of ["left", "right"]) {
    const s = side === "left" ? -1 : 1;
    const leg = joint(hips, `${side}Leg`, bones, s * 0.1, -0.06, 0);
    const knee = joint(leg, `${side}Knee`, bones, 0, -0.42, 0);
    buildLeg(leg, knee, s, look, m);
  }

  const torso = joint(hips, "torso", bones, 0, 0.1, 0);
  buildTorso(torso, look, m, bones);

  for (const side of ["left", "right"]) {
    const s = side === "left" ? -1 : 1;
    const arm = joint(torso, `${side}Arm`, bones, s * (build.chestW / 2 + 0.045), 0.48, 0);
    const elbow = joint(arm, `${side}Elbow`, bones, 0, -0.32, 0);
    buildArm(arm, elbow, s, look, m);
  }

  const head = joint(torso, "head", bones, 0, 0.62 + build.neck * 0.5, 0.02);
  buildHead(head, bones, look, m);

  if (type === "flyer") buildWings(torso, bones, m);

  if (type === "crawler") {
    // Re-pose as a quadruped: pitch the body forward, splay the limbs.
    hips.position.y = 0.42;
    hips.rotation.x = -1.25;
  }

  return root;
}

/**
 * Build a zombie. `seed` (e.g. the zombie id) picks one of several designs
 * for the type; omit it for a random one.
 */
export function buildZombieMesh(type, boss = false, seed) {
  const t = TYPE_LOOKS[type] ? type : "walker";
  const look = resolveLook(t, boss, seed);
  if (!templates.has(look.key)) {
    // Both bodies become rigid-skinned meshes: one draw call per material
    // instead of one per limb (the old cost was ~16 calls per zombie).
    const isJoint = (o) => JOINTS.has(o.name);
    templates.set(look.key, {
      full: buildRigidSkin(buildTemplate(look), isJoint, { castShadow: true }),
      simple: buildRigidSkin(buildSimpleRig(look, t), isJoint, { castShadow: false }),
    });
  }
  const tpl = templates.get(look.key);
  const full = instantiateRigidSkin(tpl.full);
  const simple = instantiateRigidSkin(tpl.simple);

  const root = new THREE.Group();
  root.add(full.group);
  root.add(simple.group);
  full.group.visible = false; // starts as the cheap stand-in until it's close
  root.scale.setScalar(TYPE_LOOKS[t].scale * (boss ? 1.22 : 1));
  root.userData.type = t;
  root.userData.rigs = { full, simple };
  root.userData.bones = simple.bones;
  root.userData.far = true;
  root.userData.anim = { time: Math.random() * 10, attackBlend: 0, screamBlend: 0, lastX: 0, lastZ: 0, speed: 0 };
  return root;
}

/**
 * Detailed skinned body up close, low-poly animated stand-in further out.
 * The pose carries over so the swap doesn't pop.
 */
export function setZombieDetail(mesh, far) {
  if (mesh.userData.far === far) return;
  mesh.userData.far = far;
  const { full, simple } = mesh.userData.rigs;
  const from = far ? full : simple;
  const to = far ? simple : full;
  for (const [name, bone] of Object.entries(to.bones)) {
    const src = from.bones[name];
    if (!src) continue;
    bone.rotation.copy(src.rotation);
    if (name === "hips") bone.position.copy(src.position);
  }
  from.group.visible = false;
  to.group.visible = true;
  mesh.userData.bones = to.bones;
}

function damp(cur, target, dt, speed = 12) {
  return cur + (target - cur) * Math.min(1, dt * speed);
}

function setRot(obj, x, y, z, dt, speed = 12) {
  if (!obj) return;
  obj.rotation.x = damp(obj.rotation.x, x, dt, speed);
  obj.rotation.y = damp(obj.rotation.y, y, dt, speed);
  obj.rotation.z = damp(obj.rotation.z, z, dt, speed);
}

/**
 * Animate one zombie mesh from its snapshot entity.
 * z: { x,y,z,yaw, st, atkMs, scrMs, alive, dp, t }
 */
export function updateZombieAnimation(mesh, z, dt) {
  const anim = mesh.userData.anim;
  const type = mesh.userData.type;
  const look = TYPE_LOOKS[type] || TYPE_LOOKS.walker;
  anim.time += dt;

  // Estimate speed from motion for stride rate.
  const moved = Math.hypot(z.x - anim.lastX, z.z - anim.lastZ);
  anim.lastX = z.x;
  anim.lastZ = z.z;
  anim.speed = damp(anim.speed, Math.min(8, moved / Math.max(dt, 1e-4)), dt, 6);

  // O(1) bone lookup from the cache built in buildZombieMesh.
  const bones = mesh.userData.bones || {};
  const g = (n) => bones[n];
  const hips = g("hips");
  const torso = g("torso");
  const head = g("head");
  const jaw = g("jaw");
  const leftArm = g("leftArm");
  const rightArm = g("rightArm");
  const leftElbow = g("leftElbow");
  const rightElbow = g("rightElbow");
  const leftLeg = g("leftLeg");
  const rightLeg = g("rightLeg");
  const leftKnee = g("leftKnee");
  const rightKnee = g("rightKnee");

  // Death collapse (flyers drop out of the sky).
  if (!z.alive) {
    const dp = z.dp || 0;
    setRot(hips, type === "crawler" ? -1.4 : -1.5 * dp, 0, 0.3 * dp, dt, 7);
    if (hips) hips.position.y = damp(hips.position.y, 0.25, dt, 7);
    if (type === "flyer") {
      mesh.position.y = Math.max(0, z.y * (1 - dp * dp)); // accelerating fall
      mesh.rotation.z = dp * 1.2;
      setRot(g("leftWing"), 0, 0, 1.1, dt, 5);
      setRot(g("rightWing"), 0, 0, -1.1, dt, 5);
    } else {
      mesh.position.y = z.y - dp * 0.15;
    }
    mesh.visible = dp < 0.97;
    return;
  }

  // Emerging: claw up out of the ground with a struggling shake.
  if (z.em > 0) {
    const progress = 1 - z.em / EMERGE_MS;
    const buried = 1.9 * (1 - Math.min(1, progress * 1.15));
    mesh.position.y = z.y - buried;
    mesh.rotation.z = Math.sin(anim.time * 22) * 0.05 * (1 - progress);
    // Arms thrust skyward while pulling free.
    setRot(leftArm, -2.6, 0, -0.35, dt, 10);
    setRot(rightArm, -2.6, 0, 0.35, dt, 10);
    setRot(head, -0.5, 0, 0, dt, 10);
    if (jaw) jaw.rotation.x = 0.5 + Math.sin(anim.time * 9) * 0.15;
    if (type === "flyer") {
      const flap = Math.sin(anim.time * 14) * 0.5;
      setRot(g("leftWing"), 0, 0, 0.4 + flap, dt, 20);
      setRot(g("rightWing"), 0, 0, -0.4 - flap, dt, 20);
    }
    return;
  }
  mesh.rotation.z *= 0.9;

  const chasing = z.st === "chase" || z.st === "attack";
  const strideRate = 3 + anim.speed * 1.6;
  const strideAmp = Math.min(0.65, anim.speed * 0.14 + 0.08);
  const stride = Math.sin(anim.time * strideRate) * strideAmp;
  const sway = Math.sin(anim.time * (strideRate * 0.5)) * 0.12;

  anim.attackBlend = damp(anim.attackBlend, z.atkMs > 0 ? 1 : 0, dt, 14);
  anim.screamBlend = damp(anim.screamBlend, z.scrMs > 0 ? 1 : 0, dt, 10);

  if (type === "flyer") {
    // Airborne: wing flaps (faster in combat), hover bob, forward dive lean.
    const flapRate = chasing ? 13 : 8;
    const flap = Math.sin(anim.time * flapRate) * (chasing ? 0.75 : 0.55);
    setRot(g("leftWing"), 0, 0.1, 0.25 + flap, dt, 22);
    setRot(g("rightWing"), 0, -0.1, -0.25 - flap, dt, 22);
    mesh.position.y = z.y + Math.sin(anim.time * 2.1) * 0.16;
    setRot(hips, chasing ? -0.55 : -0.25, sway * 0.3, 0, dt, 8);
    setRot(head, chasing ? 0.35 : 0.1, sway * -0.4, 0, dt, 8);
    if (jaw) jaw.rotation.x = (chasing ? 0.5 : 0.15) + Math.sin(anim.time * 4) * 0.08;
    // Claws reach out mid-dive; legs dangle limp.
    const reach = anim.attackBlend > 0.03 ? -1.7 : chasing ? -1.2 : -0.6;
    setRot(leftArm, reach, 0, -0.25, dt, 12);
    setRot(rightArm, reach, 0, 0.25, dt, 12);
    setRot(leftLeg, 0.5 + Math.sin(anim.time * 1.7) * 0.12, 0, 0.08, dt, 8);
    setRot(rightLeg, 0.45 - Math.sin(anim.time * 1.7) * 0.12, 0, -0.08, dt, 8);
    setRot(leftKnee, 0.5, 0, 0, dt, 8);
    setRot(rightKnee, 0.55, 0, 0, dt, 8);
    return;
  }

  if (type === "crawler") {
    // Quadruped paddle.
    setRot(hips, -1.25, sway * 0.4, 0, dt, 8);
    if (hips) hips.position.y = 0.42 + Math.abs(stride) * 0.05;
    setRot(leftArm, -1.2 + stride * 0.9, 0, -0.35, dt, 12);
    setRot(rightArm, -1.2 - stride * 0.9, 0, 0.35, dt, 12);
    setRot(leftLeg, -0.5 - stride * 0.8, 0, -0.2, dt, 12);
    setRot(rightLeg, -0.5 + stride * 0.8, 0, 0.2, dt, 12);
    setRot(head, 1.05, sway * 0.5, 0, dt, 8);
    if (jaw) jaw.rotation.x = (chasing ? 0.45 : 0.15) + Math.sin(anim.time * 5) * 0.08;
    return;
  }

  // Torso hunch + drunken sway; more upright when idle.
  const hunch = look.hunch + (chasing ? 0.18 : 0.05);
  setRot(torso, hunch, sway * 0.5, sway * 0.4, dt, 8);
  setRot(head, -hunch * 0.7 + anim.screamBlend * -0.6, sway * -0.6, sway * 0.3, dt, 8);
  if (jaw) jaw.rotation.x = anim.screamBlend * 0.9 + (chasing ? 0.35 : 0.1) + Math.sin(anim.time * 3) * 0.06;
  if (hips) {
    hips.position.y = (type === "tank" ? 0.98 : 0.92) + Math.abs(Math.cos(anim.time * strideRate)) * strideAmp * 0.06;
    hips.rotation.y = damp(hips.rotation.y, stride * 0.1, dt, 8);
  }

  // Arms: hang and swing when wandering; classic raised reach when chasing;
  // overhead slam while attacking; both up while screaming.
  let armXL = -0.25 + stride * 0.4;
  let armXR = -0.25 - stride * 0.4;
  let armZL = -0.12;
  let armZR = 0.12;
  let elbowX = -0.25;

  if (chasing) {
    armXL = -1.35 + stride * 0.18;
    armXR = -1.3 - stride * 0.18;
    armZL = -0.06;
    armZR = 0.06;
    elbowX = -0.15;
  }
  if (anim.attackBlend > 0.03) {
    const swing = Math.sin(Math.min(1, 1 - (z.atkMs || 0) / 450) * Math.PI);
    armXL = -1.9 + swing * 1.1;
    armXR = -1.9 + swing * 1.1;
    elbowX = -0.4 + swing * 0.3;
  }
  if (anim.screamBlend > 0.03) {
    armXL = -2.2;
    armXR = -2.2;
    armZL = -0.7;
    armZR = 0.7;
  }

  setRot(leftArm, armXL, 0, armZL, dt, 12);
  setRot(rightArm, armXR, 0, armZR, dt, 12);
  setRot(leftElbow, elbowX, 0, 0, dt, 12);
  setRot(rightElbow, elbowX, 0, 0, dt, 12);

  // Shambling legs: stiff, uneven stride.
  setRot(leftLeg, stride * 0.85, 0, 0.06, dt, 12);
  setRot(rightLeg, -stride * 0.7, 0, -0.06, dt, 12);
  setRot(leftKnee, Math.max(0, -Math.cos(anim.time * strideRate)) * strideAmp * 0.9, 0, 0, dt, 12);
  setRot(rightKnee, Math.max(0, Math.cos(anim.time * strideRate)) * strideAmp * 0.75, 0, 0, dt, 12);
}
