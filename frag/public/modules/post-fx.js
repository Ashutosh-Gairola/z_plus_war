/**
 * Post-processing (desktop / WebGL2): the frame renders into an HDR,
 * multisampled target, then one small pipeline adds
 *   - bloom: bright highlights (sun glints, wet reflections, lamps, muzzle
 *     flashes, crystals) bleed softly, at half + quarter resolution
 *   - ACES filmic tone mapping (done here instead of per material)
 *   - grading: weather-aware saturation / contrast, warm highlights and cool
 *     shadows, vignette and a touch of film grain
 * Phones / WebGL1 skip it and keep per-material tone mapping.
 */

const VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const BRIGHT = `
uniform sampler2D tSrc; uniform vec2 texel; uniform float threshold;
varying vec2 vUv;
vec3 tap(vec2 o) {
  vec3 c = texture2D(tSrc, vUv + o * texel).rgb;
  float l = max(c.r, max(c.g, c.b));
  return c * smoothstep(threshold, threshold * 1.8, l);
}
void main() {
  vec3 c = tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0));
  gl_FragColor = vec4(min(c * 0.25, vec3(30.0)), 1.0);
}
`;

const BLUR = `
uniform sampler2D tSrc; uniform vec2 dir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.227027;
  c += texture2D(tSrc, vUv + dir * 1.3846).rgb * 0.316216;
  c += texture2D(tSrc, vUv - dir * 1.3846).rgb * 0.316216;
  c += texture2D(tSrc, vUv + dir * 3.2308).rgb * 0.070270;
  c += texture2D(tSrc, vUv - dir * 3.2308).rgb * 0.070270;
  gl_FragColor = vec4(c, 1.0);
}
`;

const COMPOSITE = `
uniform sampler2D tScene; uniform sampler2D tBloomA; uniform sampler2D tBloomB;
uniform float exposure; uniform float bloom; uniform float saturation; uniform float contrast;
uniform float warmth; uniform float vignette; uniform float time;
varying vec2 vUv;
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 color) {
  const mat3 inM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 outM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  color *= exposure / 0.6;
  color = inM * color;
  color = RRTAndODTFit(color);
  color = outM * color;
  return clamp(color, 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
  vec3 c = texture2D(tScene, vUv).rgb;
  c += (texture2D(tBloomA, vUv).rgb * 0.55 + texture2D(tBloomB, vUv).rgb * 0.45) * bloom;
  c = aces(c);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, saturation);
  // Contrast around mid-grey in a perceptual-ish space.
  c = pow(c, vec3(1.0 / 2.2));
  c = clamp((c - 0.5) * contrast + 0.5, 0.0, 1.0);
  c = pow(c, vec3(2.2));
  // Split toning: warm highlights (sunny), cool shadows.
  c *= mix(vec3(0.97, 1.0, 1.04), vec3(1.0), smoothstep(0.0, 0.35, l));
  c *= mix(vec3(1.0), vec3(1.0 + 0.05 * warmth, 1.0 + 0.015 * warmth, 1.0 - 0.04 * warmth), smoothstep(0.3, 0.9, l));
  vec2 q = vUv - 0.5;
  c *= 1.0 - vignette * smoothstep(0.25, 0.85, dot(q, q) * 2.2);
  c = toSRGB(c);
  float grain = fract(sin(dot(vUv * (time + 1.0), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  c += grain * 0.018;
  gl_FragColor = vec4(c, 1.0);
}
`;

export class PostFX {
  constructor(renderer, { allowed = true } = {}) {
    this.r = renderer;
    const caps = renderer.capabilities;
    this.supported =
      allowed && caps.isWebGL2 && renderer.extensions.has("EXT_color_buffer_float") && Boolean(THREE.WebGLMultisampleRenderTarget);
    this.enabled = this.supported;
    this.bloomOn = true;
    this.params = { bloom: 0.55, saturation: 1.08, contrast: 1.06, warmth: 1, vignette: 0.32, threshold: 1.9 };
    if (!this.supported) return;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    const mk = (frag, uniforms) =>
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, toneMapped: false });
    this.brightMat = mk(BRIGHT, { tSrc: { value: null }, texel: { value: new THREE.Vector2() }, threshold: { value: 1.9 } });
    this.blurMat = mk(BLUR, { tSrc: { value: null }, dir: { value: new THREE.Vector2() } });
    this.compMat = mk(COMPOSITE, {
      tScene: { value: null },
      tBloomA: { value: null },
      tBloomB: { value: null },
      exposure: { value: 1 },
      bloom: { value: 0.55 },
      saturation: { value: 1.08 },
      contrast: { value: 1.06 },
      warmth: { value: 1 },
      vignette: { value: 0.32 },
      time: { value: 0 },
    });
    this.w = 0;
    this.h = 0;
    this.size = new THREE.Vector2();
    this.applyToneMapping();
  }

  /** Materials tone-map themselves only when post-processing is off. */
  applyToneMapping() {
    const want = this.enabled ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    if (this.r.toneMapping !== want) this.r.toneMapping = want;
  }

  setEnabled(on) {
    on = on && this.supported;
    if (on === this.enabled) return;
    this.enabled = on;
    this.applyToneMapping();
  }

  ensureTargets() {
    this.r.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x);
    const h = Math.max(1, this.size.y);
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    for (const t of [this.main, this.half1, this.half2, this.q1, this.q2]) if (t) t.dispose();
    const opts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    this.main = new THREE.WebGLMultisampleRenderTarget(w, h, { ...opts, depthBuffer: true });
    this.main.samples = 4;
    const hw = Math.max(1, w >> 1);
    const hh = Math.max(1, h >> 1);
    const qw = Math.max(1, w >> 2);
    const qh = Math.max(1, h >> 2);
    this.half1 = new THREE.WebGLRenderTarget(hw, hh, opts);
    this.half2 = new THREE.WebGLRenderTarget(hw, hh, opts);
    this.q1 = new THREE.WebGLRenderTarget(qw, qh, opts);
    this.q2 = new THREE.WebGLRenderTarget(qw, qh, opts);
  }

  /** Start of frame: redirect rendering into the HDR target. */
  begin() {
    this.ensureTargets();
    this.r.setRenderTarget(this.main);
  }

  pass(material, target) {
    this.quad.material = material;
    this.r.setRenderTarget(target);
    this.r.render(this.scene, this.camera);
  }

  /** End of frame: bloom + tone map + grade to the screen. */
  end(timeSec) {
    const P = this.params;
    if (this.bloomOn && P.bloom > 0.01) {
      this.brightMat.uniforms.tSrc.value = this.main.texture;
      this.brightMat.uniforms.texel.value.set(1 / this.w, 1 / this.h);
      this.brightMat.uniforms.threshold.value = P.threshold;
      this.pass(this.brightMat, this.half1);
      const blur = (src, dst, dx, dy) => {
        this.blurMat.uniforms.tSrc.value = src.texture;
        this.blurMat.uniforms.dir.value.set(dx / src.width, dy / src.height);
        this.pass(this.blurMat, dst);
      };
      blur(this.half1, this.half2, 1, 0);
      blur(this.half2, this.half1, 0, 1);
      blur(this.half1, this.q1, 1, 0); // also downsamples
      blur(this.q1, this.q2, 0, 1);
      blur(this.q2, this.q1, 2, 0);
      blur(this.q1, this.q2, 0, 2);
    }
    const u = this.compMat.uniforms;
    u.tScene.value = this.main.texture;
    u.tBloomA.value = this.half1.texture;
    u.tBloomB.value = this.q2.texture;
    u.bloom.value = this.bloomOn ? P.bloom : 0;
    u.exposure.value = this.r.toneMappingExposure;
    u.saturation.value = P.saturation;
    u.contrast.value = P.contrast;
    u.warmth.value = P.warmth;
    u.vignette.value = P.vignette;
    u.time.value = timeSec % 100;
    this.pass(this.compMat, null);
  }

  /** Weather mood: sunny = warm and punchy, storms = flat and cold. */
  grade(p, night = 0) {
    if (!p) return;
    const P = this.params;
    P.saturation = 1.12 - 0.3 * p.dark - 0.15 * night - (p.snow || 0) * 0.08;
    P.contrast = 1.08 - 0.06 * p.dark;
    P.warmth = p.sun * (1 - night);
    P.bloom = 0.45 + 0.25 * (p.rain || 0);
  }
}
