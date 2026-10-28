/**
 * Undead pass for the champion bosses: turns the clean knight / lord /
 * beast models into risen, rotting horrors.
 *
 *  1. Surfaces — every non-glowing material gets a decay shader (object
 *     space, so it rides with the body): grime blotches, sickly rot tint,
 *     rust on metal, dark streaks dripping down, faintly glowing veins, and
 *     a lumpy displaced surface so nothing is perfectly smooth.
 *  2. Corpse details — a torn-open glowing ribcage, bone spikes through the
 *     back, swollen growths, broken arrows and blades stuck in the body,
 *     rusted chains, hollow glowing eyes.
 *  3. Per-boss signature decay (scarlet rot blooms, an arrow-riddled titan
 *     on a rotting horse, grave-pale skin, an exposed spine, bleeding cracks).
 */

const DECAY = {
  // rot: tint the decay pushes toward; vein: glow colour of the veins.
  scarlet: { rot: 0x6a2a14, vein: 0xff4a18, tint: 0.3, grime: 0.55, torsoR: 0.1, spikes: 5, arrows: 2 },
  titan: { rot: 0x3c3a2c, vein: 0xa060ff, tint: 0.4, grime: 0.6, torsoR: 0.18, spikes: 7, arrows: 14 },
  omen: { rot: 0x4a5034, vein: 0xffc040, tint: 0.45, grime: 0.6, torsoR: 0.11, spikes: 4, arrows: 3 },
  beast: { rot: 0x2a2a24, vein: 0xff2410, tint: 0.25, grime: 0.5, torsoR: 0.12, spikes: 9, arrows: 4 },
  blood: { rot: 0x3a1410, vein: 0xff1418, tint: 0.35, grime: 0.6, torsoR: 0.165, spikes: 6, arrows: 3 },
};

const NOISE = `
float dHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float dNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dHash(i), dHash(i + vec3(1,0,0)), f.x), mix(dHash(i + vec3(0,1,0)), dHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(dHash(i + vec3(0,0,1)), dHash(i + vec3(1,0,1)), f.x), mix(dHash(i + vec3(0,1,1)), dHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float dFbm(vec3 p) { return dNoise(p) * 0.55 + dNoise(p * 2.07) * 0.3 + dNoise(p * 4.13) * 0.15; }
`;

const patched = new Map();

/** Decay version of a material (cached per source material + boss). */
function decayed(src, cfg, isMetal) {
  const key = `${src.uuid}|${cfg.rot}`;
  if (patched.has(key)) return patched.get(key);
  const m = src.clone();
  // Desaturate and darken the base colour; metal goes dull and rusty.
  const c = m.color.clone();
  const grey = (c.r + c.g + c.b) / 3;
  c.lerp(new THREE.Color(grey, grey, grey), 0.35).multiplyScalar(0.82);
  m.color.copy(c);
  if (isMetal) {
    m.metalness = Math.min(m.metalness, 0.65);
    m.roughness = Math.max(m.roughness, 0.55);
  } else {
    m.roughness = Math.max(m.roughness, 0.7);
  }
  const uniforms = {
    uRot: { value: new THREE.Color(cfg.rot) },
    uVein: { value: new THREE.Color(cfg.vein) },
    uTint: { value: cfg.tint },
    uGrime: { value: cfg.grime },
    uRust: { value: isMetal ? 1 : 0 },
    uTime: { value: 0 },
  };
  m.userData.decayUniforms = uniforms;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vDecayPos;
${NOISE}`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vDecayPos = position;
// Lumpy, uneven decay: push the surface in and out a little.
transformed += objectNormal * (dFbm(position * 38.0) - 0.5) * 0.007;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform vec3 uRot; uniform vec3 uVein; uniform float uTint; uniform float uGrime; uniform float uRust; uniform float uTime;
varying vec3 vDecayPos;
${NOISE}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
vec3 dp = vDecayPos * 26.0;
float n1 = dFbm(dp);
float n2 = dFbm(dp * 0.6 + 11.3);
// Rot spreading in patches.
diffuseColor.rgb = mix(diffuseColor.rgb, uRot, smoothstep(0.42, 0.72, n2) * uTint + uTint * 0.25);
// Rust blooms on metal.
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32, 0.15, 0.06), smoothstep(0.55, 0.8, n1) * uRust * 0.75);
// Grime blotches.
diffuseColor.rgb *= 1.0 - smoothstep(0.45, 0.78, n1) * uGrime;
// Dark streaks running down (blood / filth drips).
float drip = dNoise(vec3(vDecayPos.x * 90.0 + vDecayPos.z * 90.0, vDecayPos.y * 6.0, 0.0));
diffuseColor.rgb *= 1.0 - smoothstep(0.62, 0.9, drip) * 0.55;
// Pitting / cracks.
float crack = 1.0 - smoothstep(0.0, 0.035, abs(dNoise(dp * 1.8) - 0.5));
diffuseColor.rgb *= 1.0 - crack * 0.5;`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
// Faint glowing veins under the rot, slowly pulsing.
float vein = 1.0 - smoothstep(0.0, 0.022, abs(dFbm(vDecayPos * 14.0 + 3.7) - 0.5));
totalEmissiveRadiance += uVein * vein * (0.55 + 0.35 * sin(uTime * 2.2 + vDecayPos.y * 30.0));`,
      );
  };
  m.customProgramCacheKey = () => `undead|${isMetal ? 1 : 0}`;
  patched.set(key, m);
  return m;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function M(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}
const BONE = () => new THREE.MeshStandardMaterial({ color: 0xbfb49a, roughness: 0.7, metalness: 0.02 });
const FLESH = () => new THREE.MeshStandardMaterial({ color: 0x5a4a3a, roughness: 0.6, metalness: 0.0 });
const RUST = () => new THREE.MeshStandardMaterial({ color: 0x4a2e1c, roughness: 0.8, metalness: 0.5 });
const WOOD = () => new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.9, metalness: 0.0 });

/** A lumpy growth: a cluster of displaced spheres. */
function growth(r, mat, n = 5) {
  const g = new THREE.Group();
  for (let i = 0; i < n; i += 1) {
    const geo = new THREE.IcosahedronGeometry(r * (0.5 + Math.random() * 0.6), 1);
    const pos = geo.attributes.position;
    for (let k = 0; k < pos.count; k += 1) {
      const s = 1 + (Math.random() - 0.5) * 0.35;
      pos.setXYZ(k, pos.getX(k) * s, pos.getY(k) * s, pos.getZ(k) * s);
    }
    geo.computeVertexNormals();
    g.add(M(geo, mat, (Math.random() - 0.5) * r * 1.4, (Math.random() - 0.5) * r * 1.2, (Math.random() - 0.5) * r * 1.2));
  }
  return g;
}

/** A broken arrow / bolt sticking out along +Z of its group. */
function arrow(len, wood, fletch) {
  const g = new THREE.Group();
  g.add(M(new THREE.CylinderGeometry(0.004, 0.004, len, 5).rotateX(Math.PI / 2), wood, 0, 0, len / 2));
  if (Math.random() < 0.6) {
    for (let i = 0; i < 3; i += 1) {
      const f = M(new THREE.PlaneGeometry(0.012, 0.035), fletch, 0, 0, len - 0.02);
      f.material.side = THREE.DoubleSide;
      f.rotation.set(Math.PI / 2, (i / 3) * Math.PI * 2, 0);
      g.add(f);
    }
  }
  return g;
}

/** Rusted chain hanging down from a point. */
function chain(links, mat) {
  const g = new THREE.Group();
  for (let i = 0; i < links; i += 1) {
    const l = M(new THREE.TorusGeometry(0.011, 0.003, 4, 8), mat, 0, -i * 0.017, 0);
    l.rotation.y = i % 2 ? Math.PI / 2 : 0;
    g.add(l);
  }
  return g;
}

/** Torn-open chest: dark cavity, glowing heart-rot, exposed ribs. */
function ribcage(r, glowColor, bone) {
  const g = new THREE.Group();
  const cavity = M(new THREE.SphereGeometry(r * 0.55, 12, 10), new THREE.MeshStandardMaterial({ color: 0x120806, roughness: 1 }));
  cavity.scale.set(0.8, 1.2, 0.5);
  g.add(cavity);
  const core = M(new THREE.SphereGeometry(r * 0.22, 10, 8), new THREE.MeshStandardMaterial({ color: glowColor, emissive: glowColor, emissiveIntensity: 2.6 }));
  core.position.z = -r * 0.1;
  core.castShadow = false;
  g.add(core);
  for (let i = 0; i < 5; i += 1) {
    const rib = M(new THREE.TorusGeometry(r * 0.5, r * 0.045, 5, 12, Math.PI * 0.85), bone, 0, r * (0.42 - i * 0.2), -r * 0.12);
    rib.rotation.set(0, Math.PI / 2, Math.PI * 0.6);
    g.add(rib);
  }
  g.userData.core = core;
  return g;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export function undeadify(R, kind) {
  const cfg = DECAY[kind] || DECAY.scarlet;
  const bone = BONE();
  const flesh = FLESH();
  const rust = RUST();
  const wood = WOOD();
  const veinMat = new THREE.MeshStandardMaterial({ color: cfg.vein, emissive: cfg.vein, emissiveIntensity: 2.4 });
  const T = cfg.torsoR;

  // ---- 2. Corpse details ----
  // Torn-open chest on the left side.
  const rc = ribcage(T, cfg.vein, bone);
  rc.position.set(-T * 0.45, 0.17, -T * 0.72);
  rc.rotation.y = 0.35;
  R.torso.add(rc);
  R.extras.heart = rc.userData.core;

  // Bone spikes bursting out through the back and shoulders.
  for (let i = 0; i < cfg.spikes; i += 1) {
    const h = 0.05 + Math.random() * 0.07;
    const sp = M(new THREE.ConeGeometry(0.009 + Math.random() * 0.008, h, 5), bone, (Math.random() - 0.5) * T * 1.4, 0.1 + Math.random() * 0.2, T * 0.75);
    sp.rotation.set(Math.PI / 2 - 0.5 + (Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.8);
    R.torso.add(sp);
  }
  // Swollen growths on a shoulder and the opposite thigh.
  const g1 = growth(0.035, flesh, 6);
  g1.position.set(0.02, -0.06, 0.02);
  R.arms[1].sh.add(g1);
  const g2 = growth(0.03, flesh, 5);
  g2.position.set(0.03, -0.1, -0.01);
  R.legs[0].hip.add(g2);
  // Arrows and broken blades buried in the body.
  const fletch = new THREE.MeshStandardMaterial({ color: 0x5a5048, roughness: 0.9, side: THREE.DoubleSide });
  for (let i = 0; i < cfg.arrows; i += 1) {
    const a = arrow(0.08 + Math.random() * 0.09, wood, fletch);
    const ang = (Math.random() - 0.5) * 2.4;
    a.position.set(Math.sin(ang) * T * 0.9, 0.05 + Math.random() * 0.24, Math.cos(ang) * T * 0.75);
    a.rotation.set((Math.random() - 0.5) * 0.6, ang + (Math.random() - 0.5) * 0.5, 0);
    R.torso.add(a);
  }
  const shard = M(new THREE.BoxGeometry(0.012, 0.003, 0.12), rust, T * 0.6, 0.1, -T * 0.5);
  shard.rotation.set(0.3, 0.9, 0.2);
  R.torso.add(shard);
  // Rusted shackle chains dragging from the wrists.
  for (const A of R.arms) {
    A.hand.add(M(new THREE.TorusGeometry(0.03, 0.008, 5, 12), rust, 0, 0.04, 0).rotateX(Math.PI / 2));
    const ch = chain(7 + Math.floor(Math.random() * 5), rust);
    ch.position.set(0.02 * A.side, 0.03, 0);
    A.hand.add(ch);
  }
  // Hollow, glowing undead eyes (in front of whatever face / helm).
  for (const s of [-1, 1]) {
    const e = M(new THREE.SphereGeometry(0.009, 8, 6), new THREE.MeshStandardMaterial({ color: cfg.vein, emissive: cfg.vein, emissiveIntensity: 3.2 }), s * 0.02, 0.012, -0.06);
    e.castShadow = false;
    R.head.add(e);
  }

  // ---- 3. Signature decay ----
  if (kind === "scarlet") {
    // Scarlet rot blooming out of the armor.
    const bloom = new THREE.MeshStandardMaterial({ color: 0xd8401c, emissive: 0x9a1a08, emissiveIntensity: 0.9, roughness: 0.6 });
    const sites = [[R.torso, 0.06, 0.12, -0.08], [R.torso, -0.07, 0.22, 0.06], [R.arms[1].sh, 0, -0.08, 0.03], [R.legs[1].knee, 0.02, -0.06, -0.03], [R.hips, -0.05, -0.02, -0.06]];
    for (const [parent, x, y, z] of sites) {
      const g = growth(0.022, bloom, 6);
      g.position.set(x, y, z);
      parent.add(g);
    }
  } else if (kind === "titan") {
    // The horse is a rotting corpse too: grey-green, ribs showing.
    const horse = R.props.horse;
    if (horse) {
      horse.traverse((o) => {
        if (o.isMesh && o.material.color && o.material.metalness < 0.5) o.material = decayed(o.material, { ...cfg, rot: 0x4a4a38, tint: 0.55 }, false);
      });
      for (let i = 0; i < 4; i += 1) {
        const rib = M(new THREE.TorusGeometry(0.06, 0.006, 4, 10, Math.PI * 0.8), bone, -0.07, 0.3, -0.06 + i * 0.04);
        rib.rotation.set(0, Math.PI / 2, Math.PI * 0.6);
        horse.add(rib);
      }
    }
  } else if (kind === "omen") {
    // Grave-pale, sunken skin.
    R.head.traverse((o) => {
      if (o.isMesh && o.material.color && o.material.color.getHex() === 0x9c8c78) o.material.color.setHex(0x8a9078);
    });
  } else if (kind === "beast") {
    // Spine vertebrae ripped through the fur along the back.
    for (let i = 0; i < 8; i += 1) {
      const v = M(new THREE.CylinderGeometry(0.014, 0.018, 0.02, 6), bone, 0, 0.05 + i * 0.032, T * 0.8);
      v.rotation.x = Math.PI / 2;
      R.torso.add(v);
      const fin = M(new THREE.ConeGeometry(0.008, 0.035, 4), bone, 0, 0.05 + i * 0.032, T * 0.8 + 0.02);
      fin.rotation.x = Math.PI / 2;
      R.torso.add(fin);
    }
  } else if (kind === "blood") {
    // Bleeding gashes across the robe and head.
    const wound = new THREE.MeshStandardMaterial({ color: 0x7a0008, emissive: 0xc00010, emissiveIntensity: 1.6, roughness: 0.3 });
    for (let i = 0; i < 6; i += 1) {
      const gash = M(new THREE.BoxGeometry(0.004, 0.07 + Math.random() * 0.06, 0.012), wound, (Math.random() - 0.5) * T * 1.4, 0.06 + Math.random() * 0.2, -T * 0.72);
      gash.rotation.z = (Math.random() - 0.5) * 1.2;
      R.torso.add(gash);
    }
    for (let i = 0; i < 3; i += 1) {
      const c = M(new THREE.BoxGeometry(0.003, 0.05, 0.004), wound, (i - 1) * 0.02, 0.03, -0.055);
      c.rotation.z = (i - 1) * 0.4;
      R.head.add(c);
    }
  }

  // ---- 1. Decay every surface (except things that should glow) ----
  R.root.traverse((o) => {
    if (!o.isMesh || !o.material || o.material.isShaderMaterial) return;
    if (o.material.emissiveIntensity > 0.5 && o.material.emissive && o.material.emissive.getHex() !== 0) return;
    if (o.material.userData.decayUniforms) return;
    const isMetal = (o.material.metalness || 0) > 0.5;
    o.material = decayed(o.material, cfg, isMetal);
  });
  void veinMat;
}

/** Pulse the veins / heart (call every frame). */
export function animateUndead(R, t) {
  for (const m of patched.values()) m.userData.decayUniforms.uTime.value = t;
  if (R.extras.heart) {
    const k = 1 + 0.18 * Math.max(0, Math.sin(t * 5.5)) ** 4;
    R.extras.heart.scale.setScalar(k);
  }
}
