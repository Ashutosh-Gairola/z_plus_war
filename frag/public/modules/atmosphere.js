/**
 * Atmosphere + weather rendering (frag + Z+).
 *
 *   - sRGB output + ACES filmic tone mapping (with color-management.js)
 *   - physically-inspired sky: zenith/horizon gradient, sun disk + glow, and
 *     procedural drifting clouds whose coverage follows the weather
 *   - fog matched to the sky horizon
 *   - weather (server-synced): clear, cloudy, rain, storm, fog, snow — rain /
 *     snow particles around the camera, lightning, wet & snow-covered surfaces
 *   - patchSurface(): world materials get natural color variation, wetness,
 *     snow cover on upward faces, and wind sway (grass / foliage)
 */

// Shared uniforms every patched material reads (one update per frame).
export const WEATHER_UNIFORMS = {
  uTime: { value: 0 },
  uWet: { value: 0 },
  uSnow: { value: 0 },
  uWind: { value: 0.25 },
  uSunDir: { value: new THREE.Vector3(0.53, 0.79, 0.35) },
  uSunAmt: { value: 1 },
};

// Phones skip the per-pixel bump / micro-detail work.
export const LOW_END = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

// Look of each weather kind (blended during transitions).
const KINDS = {
  clear: { zenith: 0x3a78c8, horizon: 0xbcd6ea, sun: 1.0, hemi: 1.0, fog: 0.0009, fogColor: 0xb8cfe2, clouds: 0.28, dark: 0.0, rain: 0, snow: 0, wind: 0.22 },
  cloudy: { zenith: 0x6f8296, horizon: 0xc2cad2, sun: 0.42, hemi: 1.05, fog: 0.0016, fogColor: 0xb6bec7, clouds: 0.72, dark: 0.12, rain: 0, snow: 0, wind: 0.4 },
  rain: { zenith: 0x4c5865, horizon: 0x8c97a2, sun: 0.22, hemi: 0.85, fog: 0.0028, fogColor: 0x8a949e, clouds: 0.9, dark: 0.3, rain: 0.75, snow: 0, wind: 0.55 },
  storm: { zenith: 0x272f39, horizon: 0x5d6670, sun: 0.1, hemi: 0.62, fog: 0.0036, fogColor: 0x59626b, clouds: 1.0, dark: 0.5, rain: 1.0, snow: 0, wind: 1.0 },
  fog: { zenith: 0x9aa6b1, horizon: 0xc9ced2, sun: 0.38, hemi: 1.0, fog: 0.0085, fogColor: 0xc4c9cd, clouds: 0.6, dark: 0.08, rain: 0, snow: 0, wind: 0.12 },
  snow: { zenith: 0x9eaab8, horizon: 0xe2e7ec, sun: 0.48, hemi: 1.12, fog: 0.0034, fogColor: 0xd9dee4, clouds: 0.85, dark: 0.05, rain: 0, snow: 1.0, wind: 0.35 },
};

// ---------------------------------------------------------------------------
// Fog: exponential-squared distance fog thinned with altitude (valleys and
// the ground get hazier than the mountain tops) and lit warm toward the sun.
// Replaces three's fog chunks globally, so every material picks it up.
// ---------------------------------------------------------------------------

THREE.ShaderChunk.fog_pars_vertex = `#ifdef USE_FOG
  varying float fogDepth;
  varying vec3 vFogWorldPos;
#endif`;
THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
  fogDepth = - mvPosition.z;
  {
    mat3 fogVm = mat3(viewMatrix);
    vec3 fogT = mvPosition.xyz - viewMatrix[3].xyz;
    vFogWorldPos = vec3(dot(fogVm[0], fogT), dot(fogVm[1], fogT), dot(fogVm[2], fogT));
  }
#endif`;
THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float fogDepth;
  varying vec3 vFogWorldPos;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
  vec3 fogRay = vFogWorldPos - cameraPosition;
  float fogDist = length(fogRay);
  #ifdef FOG_EXP2
    float fogHb = 0.016;
    float fogY0 = max(cameraPosition.y, 0.0);
    float fogY1 = max(vFogWorldPos.y, 0.0);
    float fogDy = fogY1 - fogY0;
    float fogH = abs(fogDy) > 0.05 ? (exp(-fogHb * fogY0) - exp(-fogHb * fogY1)) / (fogHb * fogDy) : exp(-fogHb * fogY0);
    float fogFactor = 1.0 - exp(- fogDensity * fogDensity * fogDist * fogDist * clamp(fogH * 1.5, 0.12, 1.5));
  #else
    float fogFactor = smoothstep(fogNear, fogFar, fogDepth);
  #endif
  vec3 fogDirN = fogRay / max(fogDist, 0.001);
  float fogSun = pow(max(dot(fogDirN, normalize(vec3(0.53, 0.79, 0.35)) * vec3(1.0, 0.0, 1.0) / 0.636), 0.0), 5.0);
  vec3 fogCol = mix(fogColor, fogColor * vec3(1.3, 1.14, 0.9), fogSun * 0.75);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogCol, fogFactor);
#endif`;

// ---------------------------------------------------------------------------
// Surface patch: micro-detail, bump, wetness, snow, wind
// ---------------------------------------------------------------------------

const NOISE_GLSL = `
float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), f.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float wFbm(vec2 p) { return wNoise(p) * 0.55 + wNoise(p * 2.13) * 0.3 + wNoise(p * 4.37) * 0.15; }
`;

// Per-kind albedo detail + a procedural height (wH) for bump shading.
// p = world position, up = how upward-facing, tri() = triplanar noise.
const KIND_GLSL = {
  grass: `
    float gm = wFbm(p.xz * 0.045);
    float gm2 = wFbm(p.xz * 0.21 + 7.0);
    vec3 gcol = mix(diffuseColor.rgb * vec3(0.78, 1.0, 0.8), diffuseColor.rgb * vec3(1.3, 1.12, 0.62), smoothstep(0.35, 0.78, gm));
    gcol *= 0.8 + 0.36 * gm2;
    float bare = smoothstep(0.7, 0.82, wFbm(p.xz * 0.055 + 13.0));
    gcol = mix(gcol, vec3(0.085, 0.066, 0.042), bare * 0.75);
    gcol *= 0.84 + 0.3 * wNoise(p.xz * 7.0);
    diffuseColor.rgb = gcol * 0.82; // (matches the darker blade roots near the camera)
    wH = wNoise(p.xz * 3.1) * 0.6 + wNoise(p.xz * 11.0) * 0.4;
    wBumpAmt = 0.9;`,
  road: `
    float sp = wNoise(p.xz * 14.0);
    float patchs = smoothstep(0.62, 0.66, wFbm(p.xz * 0.08 + 3.0));
    float crack = 1.0 - smoothstep(0.0, 0.025, abs(wFbm(p.xz * 0.22) - 0.5));
    diffuseColor.rgb *= (0.86 + 0.26 * sp) * (1.0 - 0.18 * patchs) * (1.0 - 0.45 * crack);
    diffuseColor.rgb *= 0.9 + 0.2 * wFbm(p.xz * 0.6);
    wH = sp * 0.5 - crack * 1.2;
    wBumpAmt = 0.6;`,
  sidewalk: `
    vec2 tg = abs(fract(p.xz / 1.8) - 0.5);
    float joint = smoothstep(0.465, 0.49, max(tg.x, tg.y));
    float slab = wHash(floor(p.xz / 1.8));
    diffuseColor.rgb *= (0.9 + 0.12 * slab) * (1.0 - 0.35 * joint) * (0.9 + 0.18 * wNoise(p.xz * 9.0));
    diffuseColor.rgb *= 1.0 - 0.2 * smoothstep(0.6, 0.9, wFbm(p.xz * 0.3)); // stains
    wH = -joint + wNoise(p.xz * 9.0) * 0.2;
    wBumpAmt = 0.8;`,
  dirt: `
    float dm = wFbm(p.xz * 0.12);
    diffuseColor.rgb *= 0.75 + 0.45 * dm;
    float peb = smoothstep(0.78, 0.86, wNoise(p.xz * 5.5));
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.45, peb);
    diffuseColor.rgb *= 0.85 + 0.3 * wNoise(p.xz * 16.0);
    wH = wNoise(p.xz * 2.2) * 0.7 + peb * 0.8;
    wBumpAmt = 1.2;`,
  sand: `
    float rip = sin(p.x * 1.7 + wNoise(p.xz * 0.4) * 5.0) * 0.5 + 0.5;
    diffuseColor.rgb *= 0.88 + 0.16 * wNoise(p.xz * 20.0) + 0.06 * rip;
    wH = rip * 0.6;
    wBumpAmt = 0.6;`,
  rock: `
    float strata = sin(p.y * 1.4 + wFbm(p.xz * 0.08) * 6.0) * 0.5 + 0.5;
    float rn = tri(0.45);
    diffuseColor.rgb *= (0.72 + 0.4 * rn) * (0.85 + 0.2 * strata);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.2, 0.09), smoothstep(0.5, 0.9, up) * smoothstep(0.45, 0.7, wFbm(p.xz * 0.2)) * 0.7);
    wH = rn * 0.8 + tri(2.3) * 0.4 + strata * 0.3;
    wBumpAmt = 1.6;`,
  foliage: `
    diffuseColor.rgb *= 0.75 + 0.4 * wFbm(p.xz * 0.9 + p.y * 0.7);
    diffuseColor.rgb *= mix(0.78, 1.04, smoothstep(-0.6, 0.6, vWNormal.y)); // self-shadowed underside
    diffuseColor.rgb *= mix(1.0, 1.12, smoothstep(0.5, 1.0, vWNormal.y));
    wH = tri(4.0);
    wBumpAmt = 1.4;
    wLeaf = 1.0;`,
  bark: `
    diffuseColor.rgb *= 0.7 + 0.5 * wNoise(vec2(atan(vWNormal.z, vWNormal.x) * 6.0, p.y * 0.8));
    wH = wNoise(vec2(atan(vWNormal.z, vWNormal.x) * 10.0, p.y * 1.5));
    wBumpAmt = 1.5;`,
  paint: `
    wBumpAmt = 0.0;`,
  wall: `
    float g1 = tri(2.6);
    diffuseColor.rgb *= 0.9 + 0.16 * g1;
    // Rain grime streaking down vertical faces + darker where it meets the ground.
    float streak = wNoise(vec2(dot(p.xz, vec2(0.71, 0.71)) * 1.4 + p.x * 0.3, p.y * 0.07));
    diffuseColor.rgb *= 1.0 - 0.16 * smoothstep(0.55, 0.95, streak) * (1.0 - up);
    diffuseColor.rgb *= mix(0.62, 1.0, smoothstep(0.0, 1.4, p.y - wBaseY)) * (1.0 - up) + up;
    wH = g1 * 0.5 + tri(9.0) * 0.25;
    wBumpAmt = 0.45;`,
};

/**
 * Give a MeshStandardMaterial the world look. opts:
 *   kind      grass | road | sidewalk | dirt | sand | rock | foliage | bark | paint | wall (default)
 *   ground    flat terrain (gets puddles)
 *   sway      wind sway height scale (grass / foliage)
 *   variation large-scale color variation strength
 */
export function patchSurface(mat, opts = {}) {
  if (!mat || !mat.isMeshStandardMaterial || mat.userData.weatherPatched) return mat;
  mat.userData.weatherPatched = true;
  const sway = opts.sway || 0;
  const variation = opts.variation ?? 0.22;
  const ground = opts.ground ? 1 : 0;
  const kind = KIND_GLSL[opts.kind] ? opts.kind : sway ? "foliage" : "wall";
  const detail = !LOW_END;
  mat.extensions = { ...(mat.extensions || {}), derivatives: true };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, WEATHER_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float uTime;
uniform float uWind;
varying vec3 vWPos;
varying vec3 vWNormal;
${NOISE_GLSL}`,
      )
      .replace(
        "#include <project_vertex>",
        `vec4 wPos = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
wPos = instanceMatrix * wPos;
#endif
wPos = modelMatrix * wPos;
${
  sway
    ? `float swayH = clamp(wPos.y * ${(1 / Math.max(0.3, sway)).toFixed(3)}, 0.0, 1.0);
float gust = 0.6 + 0.4 * sin(uTime * 0.7 + wPos.x * 0.02);
vec2 swayDir = vec2(sin(uTime * 1.9 + wPos.x * 0.35 + wPos.z * 0.21), cos(uTime * 1.6 + wPos.z * 0.33));
wPos.xz += swayDir * swayH * swayH * uWind * gust * ${(0.12 * Math.max(1, sway * 0.5)).toFixed(3)};`
    : ""
}
vWPos = wPos.xyz;
vWNormal = normalize(mat3(modelMatrix) * objectNormal);
vec4 mvPosition = viewMatrix * wPos;
gl_Position = projectionMatrix * mvPosition;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float uWet;
uniform float uSnow;
uniform vec3 uSunDir;
uniform float uSunAmt;
varying vec3 vWPos;
varying vec3 vWNormal;
${NOISE_GLSL}
vec3 wBump(vec3 surfPos, vec3 surfNorm, float h, float amt) {
  vec3 sx = dFdx(surfPos);
  vec3 sy = dFdy(surfPos);
  vec3 r1 = cross(sy, surfNorm);
  vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1);
  vec2 dh = vec2(dFdx(h), dFdy(h)) * amt;
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
vec3 p = vWPos;
vec3 wAn = abs(normalize(vWNormal));
float up = smoothstep(0.45, 0.9, vWNormal.y);
#define tri(f) (wAn.y > max(wAn.x, wAn.z) ? wNoise(p.xz * (f)) : (wAn.x > wAn.z ? wNoise(p.zy * (f)) : wNoise(p.xy * (f))))
float wH = 0.0;
float wBumpAmt = 0.0;
float wLeaf = 0.0;
float wBaseY = 0.0;
float wN = wFbm(vWPos.xz * 0.11 + vWPos.y * 0.05);
diffuseColor.rgb *= 1.0 - ${variation.toFixed(3)} * 0.5 + ${variation.toFixed(3)} * wN;
${detail ? KIND_GLSL[kind] : kind === "foliage" ? "wLeaf = 1.0;" : ""}
float wFade = 1.0 - smoothstep(18.0, 70.0, length(vViewPosition));
wBumpAmt *= wFade;
float wUp = up;
// Snow settles on upward faces, thinner where noise says it drifted away.
float wSnowCover = clamp(uSnow * wUp * (0.7 + 0.6 * wFbm(vWPos.xz * 0.35)), 0.0, 1.0);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.89, 0.93), wSnowCover);
// Wet surfaces darken; flat ground collects puddles.
float wPuddle = ${ground ? "smoothstep(0.62, 0.7, wFbm(vWPos.xz * 0.07)) * wUp" : "0.0"};
float wWet = uWet * (1.0 - wSnowCover);
diffuseColor.rgb *= 1.0 - 0.32 * wWet - 0.25 * wWet * wPuddle;
wBumpAmt *= 1.0 - wPuddle * wWet; // still water is smooth
wBumpAmt *= 1.0 - wSnowCover * 0.7;`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, mix(0.28, 0.04, wPuddle), wWet * (0.55 + 0.45 * wUp));
roughnessFactor = mix(roughnessFactor, 0.85, wSnowCover);`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
if (wBumpAmt > 0.001) normal = wBump(-vViewPosition, normal, wH, wBumpAmt * 0.06);`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
// Leaves glow when the sun shines through them toward the camera.
if (wLeaf > 0.0) {
  vec3 wView = normalize(vWPos - cameraPosition);
  float wTrans = pow(max(dot(wView, normalize(uSunDir)), 0.0), 3.0);
  totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.95, 0.6) * wTrans * 0.6 * uSunAmt;
}`,
      );
  };
  mat.customProgramCacheKey = () => `wx2|${sway}|${variation}|${ground}|${kind}|${detail}`;
  mat.needsUpdate = true;
  return mat;
}

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

function buildSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      zenith: { value: new THREE.Color(KINDS.clear.zenith) },
      horizon: { value: new THREE.Color(KINDS.clear.horizon) },
      ground: { value: new THREE.Color(0x5a6150) },
      sunDir: { value: new THREE.Vector3(0.55, 0.42, 0.37).normalize() },
      sunColor: { value: new THREE.Color(0xfff0d6) },
      sunStrength: { value: 1.0 },
      cloudCover: { value: 0.3 },
      cloudDark: { value: 0.0 },
      flash: { value: 0.0 },
      time: WEATHER_UNIFORMS.uTime,
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // always at the far plane
      }
    `,
    fragmentShader: `
      uniform vec3 zenith; uniform vec3 horizon; uniform vec3 ground;
      uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunStrength;
      uniform float cloudCover; uniform float cloudDark; uniform float flash; uniform float time;
      varying vec3 vDir;
      ${NOISE_GLSL}
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        // Atmospheric gradient: haze thickens toward the horizon.
        vec3 col = mix(horizon, zenith, pow(smoothstep(0.0, 0.85, h), 0.6));
        col = mix(col, ground * 0.9, smoothstep(0.0, -0.18, h));
        float sd = max(dot(d, sunDir), 0.0);
        // Mie glow around the sun + the disk itself.
        col += sunColor * (pow(sd, 8.0) * 0.18 + pow(sd, 64.0) * 0.35) * sunStrength;
        col += sunColor * smoothstep(0.9993, 0.9997, sd) * 6.0 * sunStrength;
        // Clouds: fbm on a dome projection, drifting with time.
        if (h > 0.0) {
          vec2 uv = d.xz / (h + 0.12) * 0.9 + vec2(time * 0.006, time * 0.002);
          float n = wFbm(uv * 1.6) * 0.65 + wFbm(uv * 4.1 + 3.7) * 0.35;
          float c = smoothstep(1.0 - cloudCover, 1.0 - cloudCover + 0.35, n) * smoothstep(0.0, 0.12, h);
          vec3 cloudLit = mix(vec3(1.0, 0.98, 0.95), vec3(0.62, 0.66, 0.71), cloudDark);
          cloudLit += sunColor * pow(sd, 12.0) * 0.4 * sunStrength;
          col = mix(col, cloudLit * mix(1.0, 0.55, cloudDark), c * 0.92);
        }
        col += vec3(0.75, 0.8, 1.0) * flash;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <encodings_fragment>
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 20), mat);
  sky.name = "skyDome";
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return sky;
}

// ---------------------------------------------------------------------------
// Precipitation (GPU-driven streaks / flakes wrapped around the camera)
// ---------------------------------------------------------------------------

function buildRain(count = 7000) {
  const pos = new Float32Array(count * 2 * 3);
  const tip = new Float32Array(count * 2);
  for (let i = 0; i < count; i += 1) {
    const x = Math.random() * 70;
    const y = Math.random() * 40;
    const z = Math.random() * 70;
    for (let k = 0; k < 2; k += 1) {
      pos.set([x, y, z], (i * 2 + k) * 3);
      tip[i * 2 + k] = k;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("tip", new THREE.BufferAttribute(tip, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { time: WEATHER_UNIFORMS.uTime, cam: { value: new THREE.Vector3() }, amount: { value: 0 }, wind: { value: new THREE.Vector2(2, 1) } },
    vertexShader: `
      attribute float tip;
      uniform float time; uniform vec3 cam; uniform float amount; uniform vec2 wind;
      varying float vA;
      void main() {
        vec3 p = position;
        float fall = 26.0;
        p.y = mod(p.y - time * fall, 40.0);
        p.xz = mod(p.xz + wind * time - cam.xz, 70.0) - 35.0 + cam.xz;
        p.y += cam.y - 14.0;
        // Streak: the tip trails up-wind.
        p += tip * vec3(-wind.x * 0.035, 0.7, -wind.y * 0.035);
        // Thin out the field for lighter rain.
        vA = step(fract(position.x * 13.37 + position.z * 7.31), amount) * 0.42;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      varying float vA;
      void main() {
        if (vA <= 0.0) discard;
        gl_FragColor = vec4(0.72, 0.78, 0.86, vA);
        #include <encodings_fragment>
      }
    `,
  });
  const rain = new THREE.LineSegments(geo, mat);
  rain.frustumCulled = false;
  rain.name = "rain";
  return rain;
}

function buildSnow(count = 5000) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) pos.set([Math.random() * 70, Math.random() * 40, Math.random() * 70], i * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { time: WEATHER_UNIFORMS.uTime, cam: { value: new THREE.Vector3() }, amount: { value: 0 }, wind: { value: new THREE.Vector2(1, 0.5) }, scale: { value: 300 } },
    vertexShader: `
      uniform float time; uniform vec3 cam; uniform float amount; uniform vec2 wind; uniform float scale;
      varying float vA;
      void main() {
        vec3 p = position;
        p.y = mod(p.y - time * 2.2, 40.0);
        float sway = sin(time * 0.9 + position.x) * 1.4;
        p.xz = mod(p.xz + wind * time + vec2(sway, cos(time * 0.7 + position.z)) - cam.xz, 70.0) - 35.0 + cam.xz;
        p.y += cam.y - 14.0;
        vA = step(fract(position.x * 9.13 + position.z * 3.71), amount);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_PointSize = scale * 0.06 / -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      varying float vA;
      void main() {
        if (vA <= 0.0) discard;
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        gl_FragColor = vec4(1.0, 1.0, 1.0, (1.0 - d * 2.0) * 0.9);
        #include <encodings_fragment>
      }
    `,
  });
  const snow = new THREE.Points(geo, mat);
  snow.frustumCulled = false;
  snow.name = "snow";
  return snow;
}

// ---------------------------------------------------------------------------
// Atmosphere controller
// ---------------------------------------------------------------------------

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

function blendKinds(prev, kind, t) {
  const a = KINDS[prev] || KINDS.clear;
  const b = KINDS[kind] || KINDS.clear;
  const out = {};
  for (const k of Object.keys(b)) {
    if (k === "zenith" || k === "horizon" || k === "fogColor") {
      out[k] = _c1.setHex(a[k]).clone().lerp(_c2.setHex(b[k]), t);
    } else {
      out[k] = a[k] + (b[k] - a[k]) * t;
    }
  }
  return out;
}

// Small sky used only to bake the environment map (reflections + ambient).
function buildEnvSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      zenith: { value: new THREE.Color() },
      horizon: { value: new THREE.Color() },
      ground: { value: new THREE.Color(0x3d4a33) },
      sunDir: { value: new THREE.Vector3(0.53, 0.79, 0.35) },
      sunColor: { value: new THREE.Color(0xfff0d6) },
      sunStrength: { value: 1 },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 zenith; uniform vec3 horizon; uniform vec3 ground;
      uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunStrength;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = mix(horizon, zenith, pow(smoothstep(0.0, 0.8, d.y), 0.7));
        // Real skylight is far less blue than the sky looks: half-desaturate it
        // so the ambient doesn't tint the whole world blue.
        col = mix(vec3(dot(col, vec3(0.3, 0.59, 0.11))), col, 0.45) * 0.85;
        // Warm bounce light off the sunlit ground.
        vec3 bounce = ground * (1.0 + 1.4 * sunStrength) + vec3(0.05, 0.04, 0.02) * sunStrength;
        col = mix(col, bounce, smoothstep(0.05, -0.2, d.y));
        float sd = max(dot(d, normalize(sunDir)), 0.0);
        col += sunColor * (pow(sd, 6.0) * 0.6 + pow(sd, 120.0) * 8.0) * sunStrength;
        gl_FragColor = vec4(col, 1.0);
        #include <encodings_fragment>
      }
    `,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), mat);
}

export class Atmosphere {
  constructor(renderer) {
    this.r = renderer;
    const gl = renderer.renderer;
    gl.outputEncoding = THREE.sRGBEncoding;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.05;

    // Replace the old gradient dome.
    const old = renderer.scene.getObjectByName("skyDome");
    if (old) renderer.scene.remove(old);
    this.sky = buildSky();
    renderer.scene.add(this.sky);
    this.rain = buildRain(renderer.isMobile ? 2500 : 7000);
    this.snow = buildSnow(renderer.isMobile ? 1800 : 5000);
    renderer.scene.add(this.rain);
    renderer.scene.add(this.snow);
    if (!renderer.scene.fog) renderer.scene.fog = new THREE.FogExp2(KINDS.clear.fogColor, KINDS.clear.fog);

    this.snowCover = 0; // accumulates slowly while snowing, melts slowly after
    this.wetness = 0;
    this.flash = 0;
    this.nextLightningAt = 0;
    this.night = 0; // Z+ day/night factor (0 day .. 1 night)
    this.weather = { kind: "clear", prev: "clear", t: 1 };
    this.onThunder = null;

    // Image-based lighting: bake the current sky into a PMREM environment so
    // metal, glass, paint and wet ground reflect the real sky and every surface
    // gets soft sky-colored ambient light. Re-baked when the sky changes.
    this.envKey = "";
    this.envCheckAt = 0;
    if (!LOW_END && THREE.PMREMGenerator) {
      try {
        this.pmrem = new THREE.PMREMGenerator(gl);
        this.envScene = new THREE.Scene();
        this.envSky = buildEnvSky();
        this.envScene.add(this.envSky);
        this.bakeEnv(blendKinds("clear", "clear", 1), 1);
      } catch (err) {
        console.warn("Environment map unavailable:", err);
        this.pmrem = null;
      }
    }
  }

  bakeEnv(p, dayK) {
    if (!this.pmrem) return;
    const u = this.envSky.material.uniforms;
    u.zenith.value.copy(p.zenith).multiplyScalar(dayK);
    u.horizon.value.copy(p.horizon).multiplyScalar(dayK);
    u.ground.value.setHex(0x3d4a33).multiplyScalar(dayK * (0.6 + 0.4 * p.hemi));
    u.sunStrength.value = p.sun * dayK;
    if (this.r.sun) u.sunDir.value.copy(this.r.sun.position).sub(this.r.sun.target.position).normalize();
    const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 100);
    if (this.envRT) this.envRT.dispose();
    this.envRT = rt;
    this.r.scene.environment = rt.texture;
    // The first-person weapon reflects the same sky (gunmetal needs it).
    if (this.r.fpvScene) this.r.fpvScene.environment = rt.texture;
  }

  setWeather(w) {
    if (w && w.kind) this.weather = w;
  }

  /** 0..1 how rough it is out (birds fly low / roost in rain and storms). */
  stormAmount() {
    return this.current ? Math.min(1, this.current.rain + this.current.snow * 0.5) : 0;
  }

  setNight(f) {
    this.night = Math.max(0, Math.min(1, f));
  }

  update(dt, camera) {
    const W = this.weather;
    const p = blendKinds(W.prev || W.kind, W.kind, W.t ?? 1);
    this.current = p;
    WEATHER_UNIFORMS.uTime.value += dt;
    WEATHER_UNIFORMS.uWind.value += (p.wind - WEATHER_UNIFORMS.uWind.value) * Math.min(1, dt * 0.5);

    // Surfaces get wet quickly, dry slowly; snow builds up and melts slowly.
    const wetTarget = p.rain > 0.05 ? 1 : 0;
    this.wetness += (wetTarget - this.wetness) * Math.min(1, dt * (wetTarget ? 0.12 : 0.025));
    const snowTarget = p.snow > 0.3 ? 0.9 : 0;
    this.snowCover += (snowTarget - this.snowCover) * Math.min(1, dt * (snowTarget ? 0.03 : 0.012));
    WEATHER_UNIFORMS.uWet.value = this.wetness;
    WEATHER_UNIFORMS.uSnow.value = this.snowCover;

    // Lightning during storms.
    const stormy = W.kind === "storm" && (W.t ?? 1) > 0.5;
    const now = performance.now();
    if (stormy && now > this.nextLightningAt) {
      this.nextLightningAt = now + 5000 + Math.random() * 11000;
      this.flash = 1;
      const dist = 200 + Math.random() * 900;
      if (this.onThunder) setTimeout(() => this.onThunder(dist), Math.min(3500, dist * 2.9));
    }
    this.flash = Math.max(0, this.flash - dt * 4.5);
    const flicker = this.flash > 0 ? this.flash * (0.6 + 0.4 * Math.sin(now * 0.08)) : 0;

    // Night dims everything (Z+ cycle).
    const dayK = 1 - this.night * 0.8;
    const u = this.sky.material.uniforms;
    u.zenith.value.copy(p.zenith).multiplyScalar(dayK * (1 - this.night * 0.15));
    u.horizon.value.copy(p.horizon).multiplyScalar(dayK);
    u.cloudCover.value = p.clouds;
    u.cloudDark.value = Math.min(1, p.dark + this.night * 0.5);
    u.sunStrength.value = p.sun * (1 - this.night);
    u.flash.value = flicker * 0.9;

    const R = this.r;
    if (R.sun) {
      R.sun.intensity = (2.6 * p.sun + 0.15) * (1 - this.night * 0.85) + flicker * 2.5;
      u.sunDir.value.copy(R.sun.position).sub(R.sun.target.position).normalize();
    }
    // With the baked sky providing ambient light, the hemisphere light is
    // only a small fill.
    if (R.hemi) R.hemi.intensity = ((this.pmrem ? 0.3 : 0.75) * p.hemi) * (1 - this.night * 0.6) + flicker * 1.5;
    WEATHER_UNIFORMS.uSunDir.value.copy(u.sunDir.value);
    WEATHER_UNIFORMS.uSunAmt.value = p.sun * (1 - this.night);
    if (this.pmrem && now > this.envCheckAt) {
      // Re-bake rarely and only on a visible change (each bake is a GPU
      // spike: 6 cube faces + blur). Coarse key = a handful of bakes per
      // weather transition instead of one every 2.5s.
      this.envCheckAt = now + 6000;
      const q = (c) => [c.r, c.g, c.b].map((x) => Math.round(x * 12)).join(",");
      const key = [q(p.zenith), q(p.horizon), Math.round(p.sun * 6), Math.round(dayK * 6)].join(":");
      if (key !== this.envKey) {
        this.envKey = key;
        this.bakeEnv(p, dayK);
      }
    }
    const fog = R.scene.fog;
    if (fog) {
      fog.color.copy(p.fogColor).multiplyScalar(dayK);
      fog.density = p.fog * (1 + this.night * 0.4);
      R.scene.background = fog.color;
    }

    // Precipitation follows the camera.
    const camPos = camera.position;
    this.rain.material.uniforms.cam.value.copy(camPos);
    this.rain.material.uniforms.amount.value = p.rain;
    this.rain.material.uniforms.wind.value.set(3 * p.wind, 1.5 * p.wind);
    this.rain.visible = p.rain > 0.01;
    this.snow.material.uniforms.cam.value.copy(camPos);
    this.snow.material.uniforms.amount.value = p.snow;
    this.snow.material.uniforms.scale.value = window.innerHeight * (R.pixelRatio || 1);
    this.snow.visible = p.snow > 0.01;
    this.sky.position.copy(camPos);
  }
}
