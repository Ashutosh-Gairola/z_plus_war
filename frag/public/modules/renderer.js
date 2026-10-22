/**
 * Three.js rendering engine — orchestrates the world, characters, vehicles,
 * FPV viewmodel, camera (incl. vehicle chase cam), lighting/shadows, and
 * transient effects (tracers, muzzle flashes, screen shake).
 */

import { clamp, normalizeAngle } from "./utils.js";
import { buildPlayerBody, createPlayerAnimationState, updatePlayerAnimations } from "./player-model.js";
import { buildWeapon, updatePlayerWeapon } from "./weapon-model.js";
import { buildFPVWeapon, updateFPVAnimations, switchFPVWeapon, setScope } from "./fpv-weapon.js";
import { buildWorld, updateZone } from "./world-builder.js";
import { spawnTracer, updateTracers, updateLiveProjectiles } from "./tracer-effects.js";
import { RARITY } from "./loot.js";
import { buildGroundVehicle, isGroundVehicleType } from "./vehicle-models.js";
import { StructureView } from "./destruction-fx.js";
import { vehicleShape } from "./vehicle-shapes.js";
import { recruitContext } from "./recruit-client.js";
import { Atmosphere } from "./atmosphere.js";
import { Wildlife } from "./wildlife.js";
import { createGrassField } from "./grass-field.js";
import { PostFX } from "./post-fx.js";
import { isTouchClient } from "./touch-controls.js";

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.floor = null;
    this.zoneMesh = null;
    this.zoneInnerMesh = null;
    this.remoteMeshes = new Map();
    this.vehicleMeshes = new Map();
    this.playerStates = new Map();
    this.groundWeaponMeshes = new Map(); // loot on the ground, keyed by item id
    this.liveProjectiles = new Map(); // slow orbs / rockets in flight, keyed by bullet id
    this.npcMeshes = new Map(); // AI companions, keyed by npc id
    this.npcStates = new Map();
    this.shieldMeshes = new Map(); // defender domes, keyed by defender npc id
    this.worldHalf = 320;

    this.fpvScene = null;
    this.fpvCamera = null;
    this.fpvWeapon = null;
    this.initError = null;

    this.vehicleCamBlend = 0;
    this.worldFlashes = [];
    this.screenShake = new THREE.Vector3();
    this.shakeIntensity = 0;
    this.isSprinting = false;
    this.processedDestroyed = new Set();
    this.fallingTrees = [];
    this.impactFx = [];
    this.vehicleSmokeTimers = new Map();
    this.firstDestroyedSync = true;
    this.structureView = null;

    this.init();
  }

  init() {
    // Phones/tablets get a lighter graphics profile: no MSAA, a capped pixel
    // ratio, and smaller/harder shadows. Rendering at the desktop settings on
    // a high-DPR phone is the main cause of low FPS (and, because long frames
    // stall the socket callbacks, of inflated ping too).
    this.isMobile = isTouchClient();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9cc0e0);
    this.scene.fog = new THREE.FogExp2(0x9db8cd, 0.00135);
    this.addSkyDome();

    this.camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.1, 2600);
    this.baseFar = 2600;
    this.camera.position.set(0, 1.7, 0);
    this.camera.rotation.order = "YXZ";

    // FPV overlay scene renders on top with its own depth.
    this.fpvScene = new THREE.Scene();
    this.fpvScene.background = null;
    this.fpvCamera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.02, 20);
    this.fpvCamera.rotation.order = "YXZ";

    this.fpvArmLight = new THREE.DirectionalLight(0xfff2dd, 0.9);
    this.fpvArmLight.position.set(0.6, 1, 0.8);
    this.fpvScene.add(this.fpvArmLight);
    this.fpvFill = new THREE.AmbientLight(0xdfe8f2, 0.55);
    this.fpvScene.add(this.fpvFill);

    this.fireLight = new THREE.PointLight(0xffaa44, 0, 9);
    this.fireLight.position.set(0.3, -0.2, -1);
    this.fpvScene.add(this.fireLight);

    const tryGetContext = (name, attrs) => {
      try {
        return this.canvas.getContext(name, attrs);
      } catch (_err) {
        return null;
      }
    };

    // MSAA is expensive on mobile GPUs (it multiplies the fragment cost of
    // every pixel), so we turn it off there. The context attribute is what
    // actually controls AA here, since we pass this context into WebGLRenderer.
    const highPerfAttrs = {
      alpha: false,
      antialias: !this.isMobile,
      depth: true,
      stencil: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    };
    const fallbackAttrs = { ...highPerfAttrs, antialias: false, powerPreference: "default" };

    let gl =
      tryGetContext("webgl2", highPerfAttrs) ||
      tryGetContext("webgl", highPerfAttrs) ||
      tryGetContext("experimental-webgl", highPerfAttrs) ||
      tryGetContext("webgl2", fallbackAttrs) ||
      tryGetContext("webgl", fallbackAttrs) ||
      tryGetContext("experimental-webgl", fallbackAttrs);

    if (!gl) {
      this.initError = new Error("WebGL is unavailable in this browser/device context.");
      console.error("WebGL init failed:", this.initError);
      return;
    }

    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        context: gl,
        alpha: false,
        antialias: true,
        powerPreference: "high-performance",
      });
    } catch (_err) {
      gl =
        tryGetContext("webgl2", fallbackAttrs) ||
        tryGetContext("webgl", fallbackAttrs) ||
        tryGetContext("experimental-webgl", fallbackAttrs);
      if (!gl) {
        this.initError = new Error("WebGL context lost during renderer initialization.");
        console.error("WebGL init failed:", this.initError);
        return;
      }
      try {
        this.renderer = new THREE.WebGLRenderer({
          canvas: this.canvas,
          context: gl,
          alpha: false,
          antialias: false,
          powerPreference: "default",
        });
      } catch (err2) {
        this.initError = err2 || new Error("Unable to initialize WebGL renderer.");
        console.error("WebGL init failed:", this.initError);
        return;
      }
    }

    // Fragment work scales with pixelRatio². Desktops render up to 1.8x; on a
    // 3x-DPR phone that would be ~9x the pixels of a 1x render, so we cap the
    // phone at 1x. Bump this toward 1.25 if you want crisper edges over FPS.
    const maxPixelRatio = this.isMobile ? 1 : 1.8;
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
    this.pixelRatio = this.maxPixelRatio;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.perf = { frames: 0, since: performance.now() };
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.sortObjects = true;
    this.renderer.autoClear = false;
    this.renderer.shadowMap.enabled = true;
    // Soft (PCF) shadows sample the shadow map many times per pixel; on mobile
    // we use the cheaper hard PCF filter instead.
    this.renderer.shadowMap.type = this.isMobile ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;

    // Lighting: warm sun + cool sky bounce. The sun's shadow frustum follows
    // the player so shadow texels stay dense near the action.
    this.hemi = new THREE.HemisphereLight(0xd9ecff, 0x40573b, 0.85);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1d6, 1.15);
    this.sun.position.set(120, 180, 80);
    this.sun.castShadow = true;
    this.shadowsWanted = true;
    // A 2048² shadow map is 4x the texels (and fill cost) of 1024²; halve it
    // on mobile.
    const shadowRes = this.isMobile ? 1024 : 2048;
    this.sun.shadow.mapSize.set(shadowRes, shadowRes);
    this.sun.shadow.camera.near = 20;
    this.sun.shadow.camera.far = 500;
    this.sun.shadow.camera.left = -85;
    this.sun.shadow.camera.right = 85;
    this.sun.shadow.camera.top = 85;
    this.sun.shadow.camera.bottom = -85;
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.initLightPool();

    this.canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.initError = new Error("WebGL context lost.");
      console.error(this.initError.message);
    });

    window.addEventListener("resize", () => this.onWindowResize());

    // Sky, fog, weather, sRGB + filmic tone mapping.
    this.atmosphere = new Atmosphere(this);
    // HDR bloom + filmic grade on desktop WebGL2 (phones keep the cheap path).
    this.post = new PostFX(this.renderer, { allowed: !this.isMobile });
    this.lastRenderAt = performance.now();
  }

  addSkyDome() {
    const geo = new THREE.SphereGeometry(1100, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x3d7ac2) },
        horizonColor: { value: new THREE.Color(0xcfe4ef) },
        bottomColor: { value: new THREE.Color(0x86a36d) },
        sunDir: { value: new THREE.Vector3(0.55, 0.62, 0.37).normalize() },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        uniform vec3 bottomColor;
        uniform vec3 sunDir;
        varying vec3 vWorldPosition;
        void main() {
          vec3 dir = normalize(vWorldPosition);
          float h = dir.y;
          vec3 low = mix(bottomColor, horizonColor, smoothstep(-0.35, 0.12, h));
          vec3 col = mix(low, topColor, smoothstep(0.06, 0.65, h));
          float sunAmount = pow(max(dot(dir, sunDir), 0.0), 350.0);
          float halo = pow(max(dot(dir, sunDir), 0.0), 18.0) * 0.35;
          col += vec3(1.0, 0.93, 0.78) * (sunAmount * 1.6 + halo);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const sky = new THREE.Mesh(geo, mat);
    sky.name = "skyDome";
    this.scene.add(sky);
  }

  buildWorld(meta, opts = {}) {
    this.worldHalf = meta.worldHalfSize;
    const gl = this.renderer.getContext();
    const denseGrass = gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) > 0;
    const result = buildWorld(this.scene, meta, { ...opts, skipGrass: denseGrass });
    this.grassField = denseGrass ? createGrassField(this.scene, meta, this.renderer) : null;
    this.floor = result.floor;
    this.zoneMesh = result.zoneMesh;
    this.zoneInnerMesh = result.zoneInnerMesh;
    this.processedDestroyed = new Set();
    this.fallingTrees = [];
    this.impactFx = [];
    this.vehicleSmokeTimers = new Map();
    this.firstDestroyedSync = true;
    // Destructible buildings: state arrives with the meta, then as "structure" events.
    this.structureView = new StructureView(this.scene, {
      onSound: (kind, pos) => this.onStructureSound && this.onStructureSound(kind, pos),
    });
    if (meta.structure) this.structureView.apply(meta.structure, { snap: true });
    this.wildlife = new Wildlife(this.scene, meta);
    // Compile every world shader now (behind the loading screen) instead of
    // hitching the first time each area / material comes into view.
    try {
      this.renderer.compile(this.scene, this.camera);
    } catch (err) {
      console.warn("Shader precompile skipped:", err);
    }
    this.cullTimer = 0;
  }

  /** Players spook nearby animals; called with the interpolated player list. */
  setWildlifeThreats(players) {
    this.wildlifePlayers = players;
  }

  /**
   * Small buildings beyond ~420m are skipped entirely (towers stay for the
   * skyline). The countryside made the map 4x larger; without this the far
   * village / hamlets cost hundreds of draw calls for a few pixels.
   */
  cullDistantBuildings() {
    const groups = this.scene.userData.buildingGroups;
    if (!groups) return;
    const cx = this.camera.position.x;
    const cz = this.camera.position.z;
    const lim = Math.min(this.isMobile ? 260 : 420, this.camera.far * 0.9);
    for (const g of groups.values()) {
      if (g.userData.gone) continue;
      const def = g.userData.def;
      if (def && def.h > 14) continue;
      const near = Math.abs(g.position.x - cx) < lim && Math.abs(g.position.z - cz) < lim && Math.hypot(g.position.x - cx, g.position.z - cz) < lim;
      if (g.visible !== near) g.visible = near;
    }
  }

  // ---- Remote players ----

  getOrCreateRemoteMesh(id) {
    let node = this.remoteMeshes.get(id);
    if (node) return node;

    const group = new THREE.Group();
    const playerBody = buildPlayerBody({ seed: id });
    playerBody.name = "playerBody";
    group.add(playerBody);

    this.playerStates.set(id, createPlayerAnimationState());
    this.scene.add(group);
    this.remoteMeshes.set(id, group);
    return group;
  }

  pruneRemoteMeshes(keepIds) {
    for (const [id, mesh] of this.remoteMeshes) {
      if (keepIds.has(id)) continue;
      this.scene.remove(mesh);
      this.remoteMeshes.delete(id);
      this.playerStates.delete(id);
    }
  }

  updateRemotePlayers(players, myId, deltaTime, worldMeta) {
    const keepIds = new Set();
    for (const p of players) {
      if (p.id === myId) continue;
      keepIds.add(p.id);
      const mesh = this.getOrCreateRemoteMesh(p.id);
      if (p.inVehicle) {
        mesh.visible = false;
        continue;
      }

      // p.y is the eye height; feet = eye - stance eye offset.
      const eyeOffset = p.crouching ? 1.18 : 1.7;
      const groundY = (p.y ?? eyeOffset) - eyeOffset;
      mesh.position.set(p.x, groundY, p.z);
      // Character models are built facing +Z; world forward at yaw is -Z.
      mesh.rotation.y = p.yaw + Math.PI;

      if (worldMeta && worldMeta.weapons) {
        const weaponData = worldMeta.weapons.find((w) => w.key === p.weapon);
        if (weaponData && mesh.userData.currentWeapon !== p.weapon) {
          updatePlayerWeapon(mesh, p.weapon, weaponData);
        }
      }

      const state = this.playerStates.get(p.id);
      updatePlayerAnimations(mesh, p, state, deltaTime);

      // Third-person muzzle flash while firing.
      const flash = mesh.getObjectByName("tpMuzzleFlash");
      if (flash) flash.visible = Date.now() - (p.lastShotAt || 0) < 60;

      if (!p.alive) {
        // Collapse pose comes from the animation state machine; just settle
        // the body slightly into the ground and fade out late.
        const fallTilt = (p.deathTilt || 0) * (p.deathProgress || 0);
        mesh.rotation.z = fallTilt * 0.5;
        mesh.position.y -= (p.deathProgress || 0) * 0.3;
        mesh.visible = p.deathProgress <= 0.97;
      } else {
        mesh.visible = true;
        mesh.rotation.z *= Math.exp(-deltaTime * 18);
        mesh.rotation.x *= Math.exp(-deltaTime * 18);
      }
    }
    this.pruneRemoteMeshes(keepIds);
  }

  // ---- Ground weapons (loot + drops) ----

  /** Loot marker: the gun hovering and turning above a rarity-colored ring and light beam. */
  buildGroundWeapon(item, worldMeta) {
    const info = worldMeta?.weapons?.find((w) => w.key === item.key);
    const rarity = RARITY[info?.rarity] || RARITY.default;
    const color = item.drop && rarity === RARITY.default ? 0xffffff : rarity.hex;
    const group = new THREE.Group();

    const spinner = new THREE.Group();
    spinner.name = "spinner";
    spinner.position.y = 0.55;
    const gun = buildWeapon(item.key);
    gun.scale.setScalar(1.7);
    gun.rotation.z = Math.PI / 2 - 0.25; // lying on its side, slightly tilted
    spinner.add(gun);
    group.add(spinner);

    const additive = (opacity) =>
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.72, 32), additive(0.75));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    ring.name = "ring";
    group.add(ring);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.55, 32), additive(0.18));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.035;
    group.add(disc);
    // Better loot gets a taller beam so it can be spotted across the map.
    const beamHeight = info?.rarity === "legendary" ? 9 : info?.rarity === "epic" ? 6 : info?.rarity === "rare" ? 3.5 : 1.6;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.32, beamHeight, 12, 1, true), additive(0.13));
    beam.position.y = beamHeight / 2;
    group.add(beam);
    return group;
  }

  updateGroundWeapons(items, deltaTime, worldMeta) {
    const keep = new Set();
    const t = performance.now() * 0.001;
    for (const item of items || []) {
      keep.add(item.id);
      let mesh = this.groundWeaponMeshes.get(item.id);
      if (!mesh) {
        mesh = this.buildGroundWeapon(item, worldMeta);
        mesh.position.set(item.x, item.y || 0, item.z);
        mesh.userData.phase = (item.id * 1.7) % (Math.PI * 2);
        this.scene.add(mesh);
        this.groundWeaponMeshes.set(item.id, mesh);
      }
      const spinner = mesh.getObjectByName("spinner");
      if (spinner) {
        spinner.rotation.y += deltaTime * 1.2;
        spinner.position.y = 0.55 + Math.sin(t * 2 + mesh.userData.phase) * 0.08;
      }
      const ring = mesh.getObjectByName("ring");
      if (ring) ring.material.opacity = 0.55 + Math.sin(t * 3 + mesh.userData.phase) * 0.2;
    }
    for (const [id, mesh] of this.groundWeaponMeshes) {
      if (keep.has(id)) continue;
      this.scene.remove(mesh);
      this.groundWeaponMeshes.delete(id);
    }
  }

  updateLiveProjectiles(bullets, deltaTime) {
    updateLiveProjectiles(this.scene, this.liveProjectiles, bullets, deltaTime);
  }

  // ---- AI companions (NPCs) ----

  npcRoleColor(role, worldMeta) {
    const fromMeta = worldMeta?.npcRoles?.[role]?.color;
    if (typeof fromMeta === "number") return fromMeta;
    const fallback = { healer: 0x37d98a, attacker: 0xe8563a, defender: 0x4a90e2, alchemist: 0xa46bff };
    return fallback[role] || 0xffffff;
  }

  getOrCreateNpcMesh(id, role, worldMeta) {
    let node = this.npcMeshes.get(id);
    if (node) return node;

    const color = this.npcRoleColor(role, worldMeta);
    const group = new THREE.Group();

    // Each role has its own loadout with glowing role-color accents.
    const body = buildPlayerBody({ role });
    body.name = "playerBody";
    group.add(body);

    // Equip a weapon so the hands/aim pose look right.
    const weaponKey = role === "attacker" ? "smg" : "rifle";
    if (worldMeta && worldMeta.weapons) {
      const wd = worldMeta.weapons.find((w) => w.key === weaponKey);
      if (wd) updatePlayerWeapon(group, weaponKey, wd);
    }

    const additive = (opts) =>
      new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        ...opts,
      });

    // Spinning role ring above the head (recruitable + active).
    const ring = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, 0.05, 18, 1, true),
      additive({ color, opacity: 0.75 }),
    );
    ring.name = "npcRing";
    ring.position.y = 2.35;
    group.add(ring);

    // Tall beacon column so recruitable NPC locations are easy to find.
    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.65, 26, 12, 1, true),
      additive({ color, opacity: 0.16 }),
    );
    beacon.name = "npcBeacon";
    beacon.position.y = 13;
    group.add(beacon);

    if (role === "healer") {
      const aura = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), additive({ color: 0x37d98a, opacity: 0.14 }));
      aura.name = "npcAura";
      aura.position.y = 1.1;
      aura.visible = false;
      group.add(aura);
    }

    // Drop pod, shown only during the arrival animation.
    const pod = new THREE.Group();
    pod.name = "npcPod";
    const podBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.85, 1.15, 2.2, 12),
      new THREE.MeshStandardMaterial({ color: 0x2b3038, metalness: 0.55, roughness: 0.5 }),
    );
    podBody.position.y = 1.1;
    pod.add(podBody);
    const thruster = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.4, 12, 1, true), additive({ color, opacity: 0.5 }));
    thruster.position.y = -0.4;
    pod.add(thruster);
    pod.visible = false;
    group.add(pod);

    this.npcStates.set(id, createPlayerAnimationState());
    this.scene.add(group);
    this.npcMeshes.set(id, group);
    return group;
  }

  pruneNpcMeshes(keepIds) {
    for (const [id, mesh] of this.npcMeshes) {
      if (keepIds.has(id)) continue;
      this.scene.remove(mesh);
      this.npcMeshes.delete(id);
      this.npcStates.delete(id);
    }
  }

  updateNpcs(npcs, deltaTime, worldMeta) {
    const keepIds = new Set();
    const now = Date.now();
    for (const npc of npcs || []) {
      keepIds.add(npc.id);
      const mesh = this.getOrCreateNpcMesh(npc.id, npc.role, worldMeta);

      // Killed / on cooldown NPCs are hidden entirely (map shows the timer).
      if (npc.state === "dead") {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;

      const groundY = (npc.y ?? 1.7) - 1.7;
      mesh.position.set(npc.x, groundY, npc.z);
      mesh.rotation.y = npc.yaw + Math.PI; // models face +Z; world forward is -Z

      const arriving = npc.state === "arriving";
      const body = mesh.getObjectByName("playerBody");
      const pod = mesh.getObjectByName("npcPod");
      const beacon = mesh.getObjectByName("npcBeacon");
      const ring = mesh.getObjectByName("npcRing");
      const aura = mesh.getObjectByName("npcAura");

      // Pod plunges from the sky during the arrival window.
      if (pod) {
        pod.visible = arriving;
        if (arriving) pod.position.y = Math.min(1, (npc.arriveMs || 0) / 2200) * 42;
      }
      if (body) body.visible = !arriving;
      if (beacon) beacon.visible = npc.state === "available";
      if (ring) {
        ring.visible = npc.state === "available" || npc.state === "active";
        ring.rotation.y += deltaTime * 1.8;
      }
      if (aura) {
        aura.visible = npc.state === "active";
        if (aura.visible) aura.scale.setScalar(8.5 * (0.92 + 0.08 * Math.sin(now * 0.004)));
      }

      // Drive the humanoid animations once it's out of the pod.
      if (!arriving) {
        const state = this.npcStates.get(npc.id);
        updatePlayerAnimations(
          mesh,
          {
            vx: npc.vx || 0,
            vz: npc.vz || 0,
            vy: 0,
            yaw: npc.yaw,
            pitch: 0,
            crouching: false,
            alive: true,
            lastShotAt: npc.lastShotAt || 0,
            reloadingMs: 0,
            meleeMs: 0,
          },
          state,
          deltaTime,
        );
        const flash = mesh.getObjectByName("tpMuzzleFlash");
        if (flash) flash.visible = now - (npc.lastShotAt || 0) < 60;
      }
    }
    this.pruneNpcMeshes(keepIds);
  }

  /**
   * Render active Defender domes: a translucent additive hemisphere + a bright
   * ground ring at the shield centre, pulsing (and flickering near expiry).
   * Keyed by defender npc id; removed when the shield drops.
   */
  updateShields(npcs) {
    const keep = new Set();
    const now = Date.now();
    for (const npc of npcs || []) {
      const sh = npc.shield;
      if (npc.role !== "defender" || !sh || !sh.active) continue;
      keep.add(npc.id);
      let dome = this.shieldMeshes.get(npc.id);
      if (!dome) {
        dome = new THREE.Group();
        const domeMat = new THREE.MeshBasicMaterial({
          color: 0x4aa0ff,
          transparent: true,
          opacity: 0.12,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
        });
        const sphere = new THREE.Mesh(
          new THREE.SphereGeometry(1, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
          domeMat,
        );
        sphere.name = "dome";
        dome.add(sphere);
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.93, 1, 48),
          new THREE.MeshBasicMaterial({
            color: 0x9fd4ff,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.06;
        ring.name = "ring";
        dome.add(ring);
        this.scene.add(dome);
        this.shieldMeshes.set(npc.id, dome);
      }
      const r = sh.radius || 8;
      dome.position.set(sh.x, 0, sh.z);
      const domeMesh = dome.getObjectByName("dome");
      const ring = dome.getObjectByName("ring");
      if (domeMesh) {
        domeMesh.scale.set(r, r * 0.85, r);
        const expiring = (sh.ms || 0) < 3000;
        const pulse = 0.1 + 0.04 * Math.sin(now * 0.006);
        domeMesh.material.opacity = expiring && Math.floor(now / 150) % 2 === 0 ? 0.04 : pulse;
      }
      if (ring) ring.scale.setScalar(r);
    }
    for (const [id, dome] of this.shieldMeshes) {
      if (keep.has(id)) continue;
      this.scene.remove(dome);
      this.shieldMeshes.delete(id);
    }
  }

  // ---- Vehicles ----

  buildVehicleMesh(vehicle) {
    if (isGroundVehicleType(vehicle.type)) {
      const g = buildGroundVehicle(vehicle.type, vehicle.color);
      g.name = `vehicle-${vehicle.id}`;
      return g;
    }
    const group = new THREE.Group();
    group.name = `vehicle-${vehicle.id}`;

    const paintColor = typeof vehicle.color === "number" ? vehicle.color : 0x2f6f9f;
    const paint = new THREE.MeshStandardMaterial({ color: paintColor, roughness: 0.24, metalness: 0.6 });
    const paintDark = new THREE.MeshStandardMaterial({
      color: new THREE.Color(paintColor).offsetHSL(0, 0, -0.1).getHex(),
      roughness: 0.3,
      metalness: 0.55,
    });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x141619, roughness: 0.82, metalness: 0.1 });
    const chromeMat = new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: 0.15, metalness: 0.9 });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x6f9cc0,
      roughness: 0.05,
      metalness: 0.35,
      transparent: true,
      opacity: 0.5,
    });
    const interiorMat = new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.92 });

    group.userData.type = vehicle.type || "car";
    if (group.userData.type === "heli") {
      this.buildHeliParts(group, { paint, paintDark, darkMat, chromeMat, glassMat, interiorMat });
      return group;
    }
    if (group.userData.type === "plane") {
      this.buildPlaneParts(group, { paint, paintDark, darkMat, chromeMat, glassMat, interiorMat });
      return group;
    }

    // Underbody + rocker panels.
    const underbody = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.24, 4.35), darkMat);
    underbody.position.y = 0.4;
    group.add(underbody);
    for (const sx of [-1.08, 1.08]) {
      const rocker = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 2.5), paintDark);
      rocker.position.set(sx, 0.5, 0);
      group.add(rocker);
    }

    // Main body: belt-line box with tapered hood and trunk decks.
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.28, 0.52, 4.55), paint);
    body.position.y = 0.78;
    body.castShadow = true;
    group.add(body);
    const hood = new THREE.Mesh(new THREE.BoxGeometry(2.12, 0.14, 1.45), paint);
    hood.position.set(0, 1.06, -1.5);
    hood.rotation.x = 0.055;
    hood.castShadow = true;
    group.add(hood);
    const cowl = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.1, 0.4), paintDark);
    cowl.position.set(0, 1.1, -0.78);
    group.add(cowl);
    const trunk = new THREE.Mesh(new THREE.BoxGeometry(2.12, 0.13, 1.05), paint);
    trunk.position.set(0, 1.08, 1.75);
    trunk.rotation.x = -0.045;
    trunk.castShadow = true;
    group.add(trunk);
    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.05, 0.28), paintDark);
    spoiler.position.set(0, 1.17, 2.18);
    group.add(spoiler);

    // Fender flares over the wheels.
    for (const [fx, fz] of [[-1.12, -1.45], [1.12, -1.45], [-1.12, 1.42], [1.12, 1.42]]) {
      const flare = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.28, 1.15), paintDark);
      flare.position.set(fx, 0.78, fz);
      group.add(flare);
    }

    // Greenhouse: raked windshield/backlight, side glass, slim pillars, roof.
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.78, 0.1, 1.9), paint);
    roof.position.set(0, 1.76, 0.16);
    roof.castShadow = true;
    group.add(roof);
    const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.78, 0.05), glassMat);
    windshield.position.set(0, 1.4, -0.86);
    windshield.rotation.x = 0.42;
    group.add(windshield);
    const rearGlass = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.7, 0.05), glassMat);
    rearGlass.position.set(0, 1.4, 1.22);
    rearGlass.rotation.x = -0.4;
    group.add(rearGlass);
    for (const sx of [-0.9, 0.9]) {
      const sideGlass = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.46, 1.62), glassMat);
      sideGlass.position.set(sx, 1.4, 0.16);
      group.add(sideGlass);
      const aPillar = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.75, 0.09), paintDark);
      aPillar.position.set(sx, 1.38, -0.72);
      aPillar.rotation.x = 0.4;
      group.add(aPillar);
      const cPillar = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.7, 0.11), paintDark);
      cPillar.position.set(sx, 1.38, 1.05);
      cPillar.rotation.x = -0.38;
      group.add(cPillar);
      const bPillar = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.07), darkMat);
      bPillar.position.set(sx, 1.4, 0.2);
      group.add(bPillar);
    }

    // Door seams + handles + mirrors.
    for (const sx of [-1.15, 1.15]) {
      const seam = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.4, 0.02), darkMat);
      seam.position.set(sx, 0.82, 0.15);
      group.add(seam);
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.045, 0.24), chromeMat);
      handle.position.set(sx, 0.95, -0.15);
      group.add(handle);
      const mirrorArm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.04), paintDark);
      mirrorArm.position.set(sx * 1.06, 1.22, -0.62);
      group.add(mirrorArm);
      const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.13, 0.2), paintDark);
      mirror.position.set(sx * 1.13, 1.22, -0.62);
      group.add(mirror);
    }

    // Interior: seats, dash, steering wheel.
    for (const sx of [-0.48, 0.48]) {
      const seatBase = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.14, 0.56), interiorMat);
      seatBase.position.set(sx, 1.12, 0.34);
      group.add(seatBase);
      const seatBack = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.55, 0.12), interiorMat);
      seatBack.position.set(sx, 1.44, 0.62);
      seatBack.rotation.x = -0.12;
      group.add(seatBack);
    }
    const dash = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.2, 0.38), interiorMat);
    dash.position.set(0, 1.24, -0.6);
    group.add(dash);
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.028, 8, 16), darkMat);
    wheel.position.set(-0.48, 1.32, -0.4);
    wheel.rotation.x = 1.0;
    wheel.name = "steeringWheel";
    group.add(wheel);

    // Front fascia: grille, chrome bar, headlights with lenses, bumper.
    const grille = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.24, 0.08), darkMat);
    grille.position.set(0, 0.74, -2.31);
    group.add(grille);
    const grilleBar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.04, 0.1), chromeMat);
    grilleBar.position.set(0, 0.74, -2.32);
    group.add(grilleBar);
    const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(2.32, 0.26, 0.3), paintDark);
    frontBumper.position.set(0, 0.46, -2.32);
    group.add(frontBumper);
    const bumperInsert = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 0.06), darkMat);
    bumperInsert.position.set(0, 0.42, -2.46);
    group.add(bumperInsert);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.03), new THREE.MeshStandardMaterial({ color: 0xe8e4d5, roughness: 0.6 }));
    plate.position.set(0, 0.58, -2.47);
    group.add(plate);

    const headMat = new THREE.MeshStandardMaterial({ color: 0xfff4cf, emissive: 0xffe9a8, emissiveIntensity: 0.85, roughness: 0.2 });
    const tailMat = new THREE.MeshStandardMaterial({ color: 0xa03030, emissive: 0xd82c2c, emissiveIntensity: 0.6, roughness: 0.3 });
    for (const sx of [-0.78, 0.78]) {
      const headLamp = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.15, 0.07), headMat);
      headLamp.position.set(sx, 0.86, -2.33);
      group.add(headLamp);
      const tailLamp = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.13, 0.05), tailMat);
      tailLamp.position.set(sx, 0.9, 2.32);
      group.add(tailLamp);
    }
    const rearBumper = new THREE.Mesh(new THREE.BoxGeometry(2.32, 0.26, 0.26), paintDark);
    rearBumper.position.set(0, 0.46, 2.3);
    group.add(rearBumper);
    const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.22, 10), chromeMat);
    exhaust.rotation.x = Math.PI / 2;
    exhaust.position.set(-0.7, 0.34, 2.42);
    group.add(exhaust);
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.008, 0.5, 6), darkMat);
    antenna.position.set(0.75, 1.95, 1.0);
    antenna.rotation.z = -0.15;
    group.add(antenna);

    // Wheels: tire + chrome rim + center cap.
    const tireGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 18);
    tireGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.31, 12);
    rimGeo.rotateZ(Math.PI / 2);
    const capGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.33, 8);
    capGeo.rotateZ(Math.PI / 2);
    const wheelPositions = [
      [-1.12, 0.42, -1.45],
      [1.12, 0.42, -1.45],
      [-1.12, 0.42, 1.42],
      [1.12, 0.42, 1.42],
    ];
    group.userData.wheels = [];
    for (const [x, y, z] of wheelPositions) {
      const wheelGroup = new THREE.Group();
      wheelGroup.position.set(x, y, z);
      const tire = new THREE.Mesh(tireGeo, darkMat);
      tire.castShadow = true;
      wheelGroup.add(tire);
      wheelGroup.add(new THREE.Mesh(rimGeo, chromeMat));
      wheelGroup.add(new THREE.Mesh(capGeo, darkMat));
      group.add(wheelGroup);
      group.userData.wheels.push(wheelGroup);
    }

    // Anchor for damage smoke over the engine bay.
    const smokeAnchor = new THREE.Group();
    smokeAnchor.name = "smokeAnchor";
    smokeAnchor.position.set(0.3, 1.1, -1.6);
    group.add(smokeAnchor);

    return group;
  }

  /** Low-poly helicopter parts. Nose faces -Z like the cars. */
  buildHeliParts(group, mats) {
    const { paint, paintDark, darkMat, chromeMat, glassMat, interiorMat } = mats;

    // Fuselage: rounded-ish cabin box over a slimmer belly pan.
    const belly = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.45, 2.9), paintDark);
    belly.position.y = 0.95;
    group.add(belly);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.05, 3.2), paint);
    cabin.position.y = 1.6;
    cabin.castShadow = true;
    group.add(cabin);
    const engineHousing = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.4, 1.5), paintDark);
    engineHousing.position.set(0, 2.28, 0.35);
    group.add(engineHousing);

    // Cockpit glass across the raked nose + side windows.
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.85, 0.07), glassMat);
    canopy.position.set(0, 1.68, -1.62);
    canopy.rotation.x = 0.34;
    group.add(canopy);
    for (const sx of [-0.86, 0.86]) {
      const sideGlass = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 1.3), glassMat);
      sideGlass.position.set(sx, 1.75, -0.6);
      group.add(sideGlass);
    }

    // Seats.
    for (const sx of [-0.42, 0.42]) {
      const seatBase = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.14, 0.52), interiorMat);
      seatBase.position.set(sx, 1.2, -0.35);
      group.add(seatBase);
      const seatBack = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.5, 0.12), interiorMat);
      seatBack.position.set(sx, 1.5, -0.08);
      group.add(seatBack);
    }

    // Tail boom + vertical fin.
    const boom = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 3.2), paintDark);
    boom.position.set(0, 1.75, 3.0);
    boom.castShadow = true;
    group.add(boom);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.05, 0.6), paint);
    fin.position.set(0, 2.3, 4.45);
    group.add(fin);

    // Landing skids with struts.
    for (const sx of [-0.85, 0.85]) {
      const skid = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 3.0), chromeMat);
      skid.position.set(sx, 0.12, -0.1);
      group.add(skid);
      for (const sz of [-0.95, 0.85]) {
        const strut = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.65, 0.07), darkMat);
        strut.position.set(sx, 0.48, sz);
        group.add(strut);
      }
    }

    // Main rotor: hub + two long crossed blades, spun around Y.
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.35, 8), darkMat);
    mast.position.set(0, 2.55, 0);
    group.add(mast);
    const rotor = new THREE.Group();
    rotor.position.set(0, 2.74, 0);
    const rotorHub = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.12, 10), darkMat);
    rotor.add(rotorHub);
    for (const ry of [0, Math.PI / 2]) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.04, 7.2), darkMat);
      blade.rotation.y = ry;
      rotor.add(blade);
    }
    group.add(rotor);
    group.userData.rotor = rotor;

    // Tail rotor mounted on the fin's side, spun around X.
    const tailRotor = new THREE.Group();
    tailRotor.position.set(0.16, 2.15, 4.55);
    const tailHub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.1, 8), darkMat);
    tailHub.rotation.z = Math.PI / 2;
    tailRotor.add(tailHub);
    const tailBladeV = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.15, 0.1), darkMat);
    tailRotor.add(tailBladeV);
    const tailBladeH = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.1, 1.15), darkMat);
    tailRotor.add(tailBladeH);
    group.add(tailRotor);
    group.userData.tailRotor = tailRotor;

    // Anchor for damage smoke over the engine housing.
    const smokeAnchor = new THREE.Group();
    smokeAnchor.name = "smokeAnchor";
    smokeAnchor.position.set(0, 2.4, 0.35);
    group.add(smokeAnchor);
  }

  /** Low-poly prop plane parts. Nose faces -Z like the cars. */
  buildPlaneParts(group, mats) {
    const { paint, paintDark, darkMat, chromeMat, glassMat, interiorMat } = mats;

    // Fuselage: three boxes tapering toward the tail (+Z).
    const noseSec = new THREE.Mesh(new THREE.BoxGeometry(1.15, 1.0, 1.7), paint);
    noseSec.position.set(0, 1.2, -1.6);
    noseSec.castShadow = true;
    group.add(noseSec);
    const midSec = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.15, 2.3), paint);
    midSec.position.set(0, 1.22, 0.2);
    midSec.castShadow = true;
    group.add(midSec);
    const tailSec = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.72, 2.5), paintDark);
    tailSec.position.set(0, 1.4, 2.4);
    tailSec.castShadow = true;
    group.add(tailSec);

    // Cockpit canopy glass.
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.55, 1.0), glassMat);
    canopy.position.set(0, 1.9, -0.35);
    group.add(canopy);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.5, 0.5), interiorMat);
    seat.position.set(0, 1.55, -0.2);
    group.add(seat);

    // Main wings straight across the fuselage.
    const wing = new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.13, 1.55), paint);
    wing.position.set(0, 1.35, -0.45);
    wing.castShadow = true;
    group.add(wing);
    for (const sx of [-4.35, 4.35]) {
      const wingTip = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.15, 1.55), paintDark);
      wingTip.position.set(sx, 1.35, -0.45);
      group.add(wingTip);
    }

    // Rear tail wings + vertical stabilizer.
    const tailWing = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.1, 0.95), paint);
    tailWing.position.set(0, 1.55, 3.35);
    group.add(tailWing);
    const stabilizer = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.25, 1.05), paint);
    stabilizer.position.set(0, 2.15, 3.4);
    group.add(stabilizer);

    // Nose cone + propeller (spins around Z, the nose's facing axis).
    const noseCone = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.5, 0.6, 10), chromeMat);
    noseCone.rotation.x = -Math.PI / 2;
    noseCone.position.set(0, 1.2, -2.7);
    group.add(noseCone);
    const propeller = new THREE.Group();
    propeller.position.set(0, 1.2, -3.02);
    const propHub = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.18, 8), darkMat);
    propHub.rotation.x = Math.PI / 2;
    propeller.add(propHub);
    for (const off of [0.66, -0.66]) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.2, 0.05), darkMat);
      blade.position.y = off;
      propeller.add(blade);
    }
    group.add(propeller);
    group.userData.propeller = propeller;

    // Three fixed wheels: two under the wings, one under the tail.
    const planeTireGeo = new THREE.CylinderGeometry(0.27, 0.27, 0.2, 12);
    planeTireGeo.rotateZ(Math.PI / 2);
    const tailTireGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.14, 10);
    tailTireGeo.rotateZ(Math.PI / 2);
    for (const sx of [-1.5, 1.5]) {
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.95, 0.08), darkMat);
      strut.position.set(sx, 0.78, -0.55);
      group.add(strut);
      const tire = new THREE.Mesh(planeTireGeo, darkMat);
      tire.position.set(sx, 0.27, -0.55);
      tire.castShadow = true;
      group.add(tire);
    }
    const tailStrut = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.75, 0.07), darkMat);
    tailStrut.position.set(0, 0.6, 3.15);
    group.add(tailStrut);
    const tailTire = new THREE.Mesh(tailTireGeo, darkMat);
    tailTire.position.set(0, 0.17, 3.15);
    group.add(tailTire);

    // Anchor for damage smoke over the engine cowl.
    const smokeAnchor = new THREE.Group();
    smokeAnchor.name = "smokeAnchor";
    smokeAnchor.position.set(0, 1.75, -1.9);
    group.add(smokeAnchor);
  }

  // ---------------------------------------------------------------------------
  // Fixed light budget.
  //
  // three.js bakes the NUMBER of lights into every lit shader. Adding a light
  // for each muzzle flash / explosion / headlight (and removing it 90ms later)
  // made every material in the world switch shader programs — and r128 deletes
  // programs nobody uses, so switching back recompiled them: a full-scene
  // shader rebuild per gunshot. That froze the main thread (and with it the
  // WebSocket) whenever anyone fired. Now a few lights always exist; effects
  // borrow one and only change its color / intensity / position.
  // ---------------------------------------------------------------------------

  initLightPool() {
    const points = this.isMobile ? 2 : 3;
    const spots = this.isMobile ? 1 : 2;
    this.pointPool = [];
    for (let i = 0; i < points; i += 1) {
      const light = new THREE.PointLight(0xffffff, 0, 10, 2);
      light.position.set(0, -500, 0);
      this.scene.add(light);
      this.pointPool.push({ light, owner: null, born: 0 });
    }
    this.spotPool = [];
    for (let i = 0; i < spots; i += 1) {
      const spot = new THREE.SpotLight(0xfff2c9, 0, 46, 0.46, 0.55, 1.2);
      spot.position.set(0, -500, 0);
      spot.target.position.set(0, -501, 0);
      this.scene.add(spot);
      this.scene.add(spot.target);
      this.spotPool.push(spot);
    }
  }

  /** Borrow a pooled point light (steals the oldest if all are busy). */
  borrowPointLight(color, intensity, distance, decay = 2) {
    if (!this.pointPool || !this.pointPool.length) return null;
    let slot = this.pointPool.find((p) => !p.owner);
    if (!slot) slot = this.pointPool.reduce((a, b) => (a.born <= b.born ? a : b));
    const token = {};
    slot.owner = token;
    slot.born = performance.now();
    const light = slot.light;
    light.color.setHex(color);
    light.intensity = intensity;
    light.distance = distance;
    light.decay = decay;
    token.light = light;
    token.owned = () => slot.owner === token;
    token.release = () => {
      if (slot.owner !== token) return;
      slot.owner = null;
      light.intensity = 0;
      light.position.set(0, -500, 0);
    };
    return token;
  }

  /** Point the pooled spot lights at the nearest running vehicles' headlights. */
  updateHeadlights(vehicles) {
    if (!this.spotPool) return;
    const cam = this.camera.position;
    const running = [];
    for (const v of vehicles || []) {
      if (!v.engineOn || v.destroyed) continue;
      const mesh = this.vehicleMeshes.get(v.id);
      if (!mesh || !mesh.visible || mesh.userData.type === "heli" || mesh.userData.type === "plane") continue;
      running.push({ mesh, d: (v.x - cam.x) ** 2 + (v.z - cam.z) ** 2 });
    }
    running.sort((a, b) => a.d - b.d);
    for (let i = 0; i < this.spotPool.length; i += 1) {
      const spot = this.spotPool[i];
      const r = running[i];
      if (!r || r.d > 160 * 160) {
        spot.intensity = 0;
        continue;
      }
      const z = r.mesh.userData.beamZ ?? -2.2;
      r.mesh.updateMatrixWorld();
      spot.position.set(0, r.mesh.userData.beamY ?? 1.0, z).applyMatrix4(r.mesh.matrixWorld);
      spot.target.position.set(0, 0.2, z - 14).applyMatrix4(r.mesh.matrixWorld);
      spot.target.updateMatrixWorld();
      spot.intensity = 2.4;
    }
  }

  updateVehicles(vehicles, myId, deltaTime) {
    const keepIds = new Set();
    for (const vehicle of vehicles || []) {
      keepIds.add(vehicle.id);
      let mesh = this.vehicleMeshes.get(vehicle.id);
      if (!mesh) {
        mesh = this.buildVehicleMesh(vehicle);
        this.scene.add(mesh);
        this.vehicleMeshes.set(vehicle.id, mesh);
      }

      // Destroyed vehicles hide but stay cached — they may respawn.
      if (vehicle.destroyed) {
        mesh.visible = false;
        continue;
      }

      const isAircraft = mesh.userData.type === "heli" || mesh.userData.type === "plane";

      // Shadows only for vehicles near the camera: distant ones cost a whole
      // extra shadow-pass draw per part for a few unseen pixels.
      const camDx = vehicle.x - this.camera.position.x;
      const camDz = vehicle.z - this.camera.position.z;
      const shadowOn = camDx * camDx + camDz * camDz < 60 * 60;
      if (mesh.userData.shadowOn !== shadowOn) {
        mesh.userData.shadowOn = shadowOn;
        mesh.traverse((o) => {
          if (!o.isMesh) return;
          if (o.userData.baseCast === undefined) o.userData.baseCast = o.castShadow;
          o.castShadow = shadowOn && o.userData.baseCast;
        });
      }

      const k = Math.min(1, deltaTime * 14);
      const ky = Math.min(1, deltaTime * 18);
      mesh.position.x += (vehicle.x - mesh.position.x) * k;
      mesh.position.y += ((vehicle.y || 0) - mesh.position.y) * ky;
      mesh.position.z += (vehicle.z - mesh.position.z) * k;
      mesh.rotation.y += normalizeAngle(vehicle.yaw - mesh.rotation.y) * Math.min(1, deltaTime * 12);

      if (isAircraft) {
        // Visual pitch tilt from the server (nose down when moving forward etc).
        mesh.rotation.x += ((vehicle.tilt || 0) - mesh.rotation.x) * k;

        // Rotors / propeller: spin up fast with the engine, wind down slowly.
        const spinTarget = vehicle.engineOn ? 18 + Math.abs(vehicle.speed || 0) * 0.35 : 0;
        const cur = mesh.userData.spinSpeed || 0;
        const ease = vehicle.engineOn ? Math.min(1, deltaTime * 2.5) : Math.min(1, deltaTime * 0.6);
        mesh.userData.spinSpeed = cur + (spinTarget - cur) * ease;
        if (!vehicle.engineOn && mesh.userData.spinSpeed < 0.05) mesh.userData.spinSpeed = 0;
        const spin = mesh.userData.spinSpeed * deltaTime;
        if (mesh.userData.rotor) mesh.userData.rotor.rotation.y += spin;
        if (mesh.userData.tailRotor) mesh.userData.tailRotor.rotation.x += spin * 1.7;
        if (mesh.userData.propeller) mesh.userData.propeller.rotation.z += spin * 1.4;
      } else {
        // Subtle body roll into the turn and squat under acceleration.
        const lean = mesh.userData.lean ?? 0.05;
        mesh.rotation.z += ((vehicle.steer || 0) * Math.min(1, Math.abs(vehicle.speed || 0) / 18) * lean - mesh.rotation.z) * k;

        const wheelSpin = ((vehicle.speed || 0) * deltaTime) / (mesh.userData.wheelR || 0.42);
        for (const wheelGroup of mesh.userData.wheels || []) {
          wheelGroup.rotation.x += wheelSpin;
          if (wheelGroup.position.z < 0) wheelGroup.rotation.y = (vehicle.steer || 0) * 0.42;
        }
        const steering = mesh.getObjectByName("steeringWheel");
        if (steering) steering.rotation.z = -(vehicle.steer || 0) * 1.6;

        // (Headlight beams come from the pooled spot lights — updateHeadlights.)
      }

      // Damage smoke from the engine bay/housing once the vehicle is beaten up
      // (cars, helis, and planes all carry a smokeAnchor).
      if ((vehicle.health ?? 100) < 45) {
        const nextAt = this.vehicleSmokeTimers?.get(vehicle.id) || 0;
        const nowMs = performance.now();
        if (nowMs >= nextAt && this.vehicleSmokeTimers) {
          this.vehicleSmokeTimers.set(vehicle.id, nowMs + (vehicle.health < 15 ? 90 : 220));
          const anchor = mesh.getObjectByName("smokeAnchor");
          const p = new THREE.Vector3();
          if (anchor) anchor.getWorldPosition(p);
          else p.set(vehicle.x, 1.2, vehicle.z);
          this.spawnSmokePuff(p, vehicle.health < 15 ? 0x2b2b2b : 0x9aa0a6);
        }
      }

      mesh.visible = true;
    }

    for (const [id, mesh] of this.vehicleMeshes) {
      if (keepIds.has(id)) continue;
      this.scene.remove(mesh);
      this.vehicleMeshes.delete(id);
    }
    this.updateHeadlights(vehicles);
  }

  // ---- Recruit beacon ----

  /** The roaming recruit point: gold light column, ring and a floating emblem. */
  buildRecruitBeacon() {
    const g = new THREE.Group();
    g.name = "recruitBeacon";
    g.userData.dynamic = true; // animated: the static-world merge must leave it alone
    const add = (opacity) =>
      new THREE.MeshBasicMaterial({ color: 0xffc94a, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.6, 70, 20, 1, true), add(0.16));
    column.position.y = 35;
    g.add(column);
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.3, 70, 10, 1, true), add(0.45));
    core.position.y = 35;
    g.add(core);
    const ring = new THREE.Mesh(new THREE.RingGeometry(5.6, 6.5, 48), add(0.7));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    ring.name = "ring";
    g.add(ring);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(5.6, 48), add(0.12));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.05;
    g.add(disc);
    // Floating emblem: four role-colored shards around a gold core.
    const emblem = new THREE.Group();
    emblem.name = "emblem";
    emblem.position.y = 3.2;
    emblem.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.55), new THREE.MeshStandardMaterial({ color: 0xffd45a, emissive: 0xffb020, emissiveIntensity: 1.4 })));
    [0x37d98a, 0xe8563a, 0x4aa0ff, 0xb066ff].forEach((c, i) => {
      const shard = new THREE.Mesh(new THREE.OctahedronGeometry(0.22), new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 1.3 }));
      const a = (i / 4) * Math.PI * 2;
      shard.position.set(Math.cos(a) * 1.2, 0, Math.sin(a) * 1.2);
      emblem.add(shard);
    });
    g.add(emblem);
    return g; // (no PointLight: toggling it with the beacon recompiled every shader)
  }

  updateRecruitBeacon(state, myId, deltaTime) {
    const me = state?.players?.find((p) => p.id === myId);
    const ctx = recruitContext(state, me);
    if (!this.recruitBeacon) {
      this.recruitBeacon = this.buildRecruitBeacon();
      this.scene.add(this.recruitBeacon);
    }
    const g = this.recruitBeacon;
    g.visible = Boolean(ctx && ctx.visible);
    if (!g.visible) return;
    g.position.set(ctx.beacon.x, 0, ctx.beacon.z);
    const t = performance.now() * 0.001;
    const emblem = g.getObjectByName("emblem");
    const ring = g.getObjectByName("ring");
    if (!emblem || !ring) return; // never let a cosmetic stop the game loop
    emblem.rotation.y += deltaTime * 1.2;
    emblem.position.y = 3.2 + Math.sin(t * 1.8) * 0.25;
    // Ring fills up brighter as my hold progresses.
    const p = ctx.progressMs / ctx.holdMs;
    ring.material.opacity = 0.45 + 0.25 * Math.sin(t * 3) + p * 0.4;
    ring.scale.setScalar(1 - p * 0.15);
  }

  // ---- Riders: occupants drawn in their seats ----

  /**
   * Everyone in a vehicle is drawn sitting in their seat: straddling and
   * leaning over the bars on a bike, hands on the wheel in a car. Anyone
   * shooting (passengers always, drivers right after firing) turns their upper
   * body toward where they aim with the gun up.
   */
  updateRiders(players, vehicles, myId, worldMeta, deltaTime) {
    if (!this.riders) this.riders = new Map();
    const keep = new Set();
    const byId = new Map((players || []).map((p) => [p.id, p]));
    const now = Date.now();
    for (const v of vehicles || []) {
      if (v.destroyed) continue;
      const vmesh = this.vehicleMeshes.get(v.id);
      if (!vmesh) continue;
      for (const seat of ["driver", "passenger"]) {
        const pid = seat === "driver" ? v.driverId : v.passengerId;
        const p = pid ? byId.get(pid) : null;
        if (!p || !p.alive) continue;
        const key = `${v.id}:${seat}`;
        keep.add(key);
        let r = this.riders.get(key);
        if (!r || r.pid !== pid) {
          if (r) r.vmesh.remove(r.group);
          const group = new THREE.Group();
          const body = buildPlayerBody({ seed: pid });
          body.name = "playerBody";
          group.add(body);
          r = { pid, group, vmesh, state: createPlayerAnimationState(), yaw: Math.PI };
          vmesh.add(group);
          this.riders.set(key, r);
        }
        // In first person my own body would sit inside the camera.
        r.group.visible = !(pid === myId && this.vehicleCamBlend < 0.5);
        const [lx, ly, lz] = vehicleShape(v).seats[seat];
        r.group.position.set(lx, ly - 0.95, lz); // body hips (0.95 up) on the seat

        const aiming = seat === "passenger" || now - (p.lastShotAt || 0) < 1500;
        // Model faces +Z, vehicles face -Z: PI = facing forward in the seat.
        const target = aiming ? normalizeAngle(p.yaw + Math.PI - v.yaw) : Math.PI;
        r.yaw += normalizeAngle(target - r.yaw) * Math.min(1, deltaTime * 10);
        r.group.rotation.y = r.yaw;

        if (worldMeta?.weapons && r.group.userData.currentWeapon !== p.weapon) {
          const wd = worldMeta.weapons.find((w) => w.key === p.weapon);
          if (wd) updatePlayerWeapon(r.group, p.weapon, wd);
        }
        updatePlayerAnimations(
          r.group,
          { alive: true, vx: 0, vz: 0, vy: 0, pitch: aiming ? p.pitch : 0, crouching: false, lastShotAt: p.lastShotAt, reloadingMs: p.reloadingMs, meleeMs: 0 },
          r.state,
          deltaTime,
        );
        this.poseSeated(r.group, v.type, seat, aiming);
      }
    }
    for (const [key, r] of this.riders) {
      if (keep.has(key)) continue;
      r.vmesh.remove(r.group);
      this.riders.delete(key);
    }
  }

  /** Override the legs (and idle arms) of an animated body into a seated pose. */
  poseSeated(group, type, seat, aiming) {
    const body = group.getObjectByName("playerBody");
    if (!body) return;
    const j = (n) => body.getObjectByName(n);
    const bike = type === "bike";
    for (const [side, s] of [["left", -1], ["right", 1]]) {
      const leg = j(`${side}Leg`);
      const knee = j(`${side}Knee`);
      // Bike: straddling, knees bent back to the pegs. Car: thighs forward.
      if (leg) leg.rotation.set(bike ? -1.0 : -1.5, 0, bike ? s * 0.28 : s * 0.06);
      if (knee) knee.rotation.set(bike ? 1.75 : 1.45, 0, 0);
    }
    const hips = j("hips");
    if (hips) {
      hips.position.y = 0.95;
      hips.rotation.set(0, 0, 0);
    }
    const torso = j("torso");
    if (torso && !aiming) torso.rotation.x = bike ? 0.45 : -0.18; // tuck over the tank / lean back in the seat
    const socket = j("weaponSocket");
    if (socket) socket.visible = aiming;
    if (!aiming && seat === "driver") {
      // Hands on the wheel / bars.
      for (const [side, s] of [["left", -1], ["right", 1]]) {
        const arm = j(`${side}Arm`);
        const elbow = j(`${side}Elbow`);
        if (arm) arm.rotation.set(bike ? -1.25 : -1.05, 0, s * (bike ? -0.35 : -0.12));
        if (elbow) elbow.rotation.set(bike ? -0.25 : -0.55, 0, 0);
      }
    }
  }

  // ---- Effects ----

  spawnTracer(shot) {
    return spawnTracer(this.scene, shot);
  }

  applyStructure(payload) {
    if (this.structureView) this.structureView.apply(payload);
  }

  updateStructures(deltaTime) {
    if (this.structureView) this.structureView.update(deltaTime);
  }

  updateTracersFx(tracers, deltaTime) {
    updateTracers(this.scene, tracers);
  }

  /** Brief world-space flash + light at a remote shooter's muzzle. */
  spawnRemoteMuzzleFlash(shot) {
    const light = this.borrowPointLight(0xffbb55, 2.2, 14);
    if (light) light.light.position.set(shot.ox, shot.oy, shot.oz);
    if (!this.flashGeo) this.flashGeo = new THREE.SphereGeometry(0.12, 8, 6); // shared: was leaked per shot
    const glow = new THREE.Mesh(
      this.flashGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffd56b,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    glow.position.set(shot.ox, shot.oy, shot.oz);
    this.scene.add(glow);
    this.worldFlashes.push({ light, glow, life: 0 });
  }

  updateWorldFlashes(deltaTime) {
    for (let i = this.worldFlashes.length - 1; i >= 0; i -= 1) {
      const f = this.worldFlashes[i];
      f.life += deltaTime;
      const fade = Math.max(0, 1 - f.life / 0.08);
      if (f.light && f.light.owned()) f.light.light.intensity = 2.2 * fade;
      f.glow.material.opacity = 0.9 * fade;
      if (f.life > 0.09) {
        if (f.light) f.light.release();
        this.scene.remove(f.glow);
        f.glow.material.dispose();
        this.worldFlashes.splice(i, 1);
      }
    }
  }

  updateZone(zone) {
    updateZone(this.zoneMesh, this.zoneInnerMesh, zone);
  }

  // ---- Vehicle world interaction effects ----

  spawnSmokePuff(worldPos, color = 0x9aa0a6) {
    const puff = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 7, 5),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, depthWrite: false }),
    );
    puff.position.copy(worldPos);
    this.scene.add(puff);
    this.impactFx.push({
      mesh: puff,
      life: 0,
      maxLife: 1.1,
      vel: new THREE.Vector3((Math.random() - 0.5) * 0.6, 1.3 + Math.random() * 0.8, (Math.random() - 0.5) * 0.6),
      grow: 2.2,
      fade: 0.4,
      gravity: 0,
    });
  }

  /** Dust + debris burst where a car slams into something. */
  spawnCrashEffect(x, y, z, power = 10) {
    if (!this.impactFx) return;
    const count = Math.min(14, 5 + Math.floor(power * 0.5));
    for (let i = 0; i < count; i += 1) {
      const isDust = i % 2 === 0;
      const mesh = new THREE.Mesh(
        isDust ? new THREE.SphereGeometry(0.16, 6, 5) : new THREE.BoxGeometry(0.09, 0.09, 0.09),
        new THREE.MeshBasicMaterial({
          color: isDust ? 0xb8ac96 : 0x54575c,
          transparent: true,
          opacity: isDust ? 0.5 : 0.95,
          depthWrite: false,
        }),
      );
      mesh.position.set(x + (Math.random() - 0.5) * 1.2, y + Math.random() * 0.7, z + (Math.random() - 0.5) * 1.2);
      this.scene.add(mesh);
      this.impactFx.push({
        mesh,
        life: 0,
        maxLife: isDust ? 0.9 : 0.7,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * power * 0.35,
          Math.random() * power * 0.22 + 1,
          (Math.random() - 0.5) * power * 0.35,
        ),
        grow: isDust ? 2.6 : 0,
        fade: isDust ? 0.5 : 1,
        gravity: isDust ? 0.6 : 9,
      });
    }
  }

  /** Full vehicle explosion: fireball, glowing debris, smoke column, flash light. */
  spawnExplosionEffect(x, y, z, power = 12) {
    if (!this.impactFx) return;

    // Expanding fireball: layered spheres, hot core -> dark red shell.
    const fireball = [
      { color: 0xffd76a, radius: 0.55, opacity: 0.95, grow: 4.2, blending: THREE.AdditiveBlending },
      { color: 0xff7a1f, radius: 0.85, opacity: 0.8, grow: 3.4, blending: THREE.AdditiveBlending },
      { color: 0x7d1c0c, radius: 1.15, opacity: 0.6, grow: 2.6, blending: THREE.NormalBlending },
    ];
    for (const f of fireball) {
      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(f.radius * (0.8 + power * 0.02), 10, 8),
        new THREE.MeshBasicMaterial({
          color: f.color,
          transparent: true,
          opacity: f.opacity,
          depthWrite: false,
          blending: f.blending,
        }),
      );
      ball.position.set(x + (Math.random() - 0.5) * 0.4, y + 0.4 + Math.random() * 0.5, z + (Math.random() - 0.5) * 0.4);
      this.scene.add(ball);
      this.impactFx.push({
        mesh: ball,
        life: 0,
        maxLife: 0.9,
        vel: new THREE.Vector3(0, 1.6 + Math.random() * 1.2, 0),
        grow: f.grow,
        fade: f.opacity,
        gravity: 0,
      });
    }

    // Glowing debris chunks thrown out with gravity.
    const debrisCount = Math.min(16, 10 + Math.floor(power * 0.35));
    const debrisColors = [0xffc24d, 0xff8a2a, 0xff5a1a, 0x4a4038];
    for (let i = 0; i < debrisCount; i += 1) {
      const s = 0.08 + Math.random() * 0.1;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(s, s, s),
        new THREE.MeshBasicMaterial({
          color: debrisColors[i % debrisColors.length],
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
        }),
      );
      mesh.position.set(x + (Math.random() - 0.5) * 0.8, y + 0.4 + Math.random() * 0.8, z + (Math.random() - 0.5) * 0.8);
      this.scene.add(mesh);
      this.impactFx.push({
        mesh,
        life: 0,
        maxLife: 0.8 + Math.random() * 0.5,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * (4 + power * 0.45),
          2.5 + Math.random() * (3 + power * 0.3),
          (Math.random() - 0.5) * (4 + power * 0.45),
        ),
        grow: 0,
        fade: 1,
        gravity: 9,
      });
    }

    // Burst of dark smoke rising out of the blast.
    const puffCount = Math.min(8, 4 + Math.floor(power * 0.2));
    const puffPos = new THREE.Vector3();
    for (let i = 0; i < puffCount; i += 1) {
      puffPos.set(x + (Math.random() - 0.5) * 1.6, y + 0.6 + Math.random() * 1.4, z + (Math.random() - 0.5) * 1.6);
      this.spawnSmokePuff(puffPos, i % 2 === 0 ? 0x1f1f1f : 0x3a3a3a);
    }

    // Short-lived orange flash light.
    const light = this.borrowPointLight(0xff8a3c, Math.max(2, power), 60, 1.6);
    if (light) {
      light.light.position.set(x, y + 1.2, z);
      if (!this.explosionLights) this.explosionLights = [];
      this.explosionLights.push({ light, life: 0, maxLife: 0.5, intensity: light.light.intensity });
    }

    this.shakeIntensity = Math.min(3, this.shakeIntensity + Math.min(2.2, power * 0.12));
  }

  /** Soil erupting where something claws out of the ground. */
  spawnDirtBurst(x, z, big = false) {
    if (!this.impactFx) return;
    const y = 0.15;
    const count = big ? 16 : 9;
    for (let i = 0; i < count; i += 1) {
      const isClod = i % 3 !== 0;
      const shade = 0x51422e + Math.floor(Math.random() * 0x101008);
      const mesh = new THREE.Mesh(
        isClod ? new THREE.BoxGeometry(0.12, 0.1, 0.12) : new THREE.SphereGeometry(0.2, 6, 5),
        new THREE.MeshBasicMaterial({ color: shade, transparent: true, opacity: isClod ? 0.95 : 0.5, depthWrite: false }),
      );
      mesh.position.set(x + (Math.random() - 0.5) * 1.1, y, z + (Math.random() - 0.5) * 1.1);
      this.scene.add(mesh);
      this.impactFx.push({
        mesh,
        life: 0,
        maxLife: isClod ? 0.85 : 1.2,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * (big ? 4 : 2.6),
          2.2 + Math.random() * (big ? 3.4 : 2.2),
          (Math.random() - 0.5) * (big ? 4 : 2.6),
        ),
        grow: isClod ? 0 : 2.0,
        fade: isClod ? 1 : 0.5,
        gravity: isClod ? 8 : 1.2,
      });
    }
  }

  /** Tall red light column marking a boss spawn location. */
  spawnBossBeacon(x, z) {
    if (!this.impactFx) return;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(1.4, 2.2, 90, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff2a20,
        transparent: true,
        opacity: 0.34,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    beam.position.set(x, 45, z);
    this.scene.add(beam);
    this.impactFx.push({
      mesh: beam,
      life: 0,
      maxLife: 8,
      vel: new THREE.Vector3(0, 0, 0),
      grow: 0,
      fade: 0.34,
      gravity: 0,
    });
  }

  /**
   * Knock down destroyed trees. Treefall events animate with the impact
   * direction; ids seen only in the snapshot (e.g. on late join) snap flat.
   */
  syncDestroyedProps(destroyedIds, treefallEvents) {
    const map = this.scene?.userData?.propMeshes;
    if (!map || !this.processedDestroyed) return;
    const snap = this.firstDestroyedSync; // catch-up on join: lay flat instantly
    this.firstDestroyedSync = false;

    // New round: the server cleared its list, so stand every fallen tree back up.
    if ((destroyedIds || []).length === 0 && this.processedDestroyed.size > 0 && !(treefallEvents || []).length) {
      for (const id of this.processedDestroyed) {
        const mesh = map.get(id);
        if (!mesh || !mesh.userData.restQuaternion) continue;
        mesh.quaternion.copy(mesh.userData.restQuaternion);
        mesh.position.y = mesh.userData.restY;
        if (mesh.userData.attach) mesh.userData.attach(); // back into the merged chunk
      }
      this.processedDestroyed.clear();
      this.fallingTrees = [];
    }
    const remember = (mesh) => {
      if (mesh.userData.detach) mesh.userData.detach(); // out of the merged chunk, ready to fall
      if (mesh.userData.restQuaternion) return;
      mesh.userData.restQuaternion = mesh.quaternion.clone();
      mesh.userData.restY = mesh.position.y;
    };

    for (const ev of treefallEvents || []) {
      if (this.processedDestroyed.has(ev.propId)) continue;
      const mesh = map.get(ev.propId);
      if (!mesh) continue;
      remember(mesh);
      this.processedDestroyed.add(ev.propId);
      const dx = ev.dx || 1;
      const dz = ev.dz || 0;
      this.fallingTrees.push({
        mesh,
        t: 0,
        axis: new THREE.Vector3(dz, 0, -dx).normalize(),
        q0: mesh.quaternion.clone(),
      });
    }

    for (const id of destroyedIds || []) {
      if (this.processedDestroyed.has(id)) continue;
      const mesh = map.get(id);
      if (!mesh) continue;
      remember(mesh);
      this.processedDestroyed.add(id);
      if (snap) {
        const angle = Math.random() * Math.PI * 2;
        const axis = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
        const q = new THREE.Quaternion().setFromAxisAngle(axis, 1.45);
        mesh.quaternion.premultiply(q);
        mesh.position.y = -0.15;
      } else {
        this.fallingTrees.push({
          mesh,
          t: 0,
          axis: new THREE.Vector3(1, 0, 0),
          q0: mesh.quaternion.clone(),
        });
      }
    }
  }

  updateEnvironmentFx(deltaTime) {
    // Falling trees: ease over with a small settle bounce.
    for (let i = (this.fallingTrees || []).length - 1; i >= 0; i -= 1) {
      const f = this.fallingTrees[i];
      f.t += deltaTime;
      const u = Math.min(1, f.t / 1.3);
      const eased = 1 - Math.pow(1 - u, 3);
      const settle = u >= 1 ? Math.sin(Math.min(1, (f.t - 1.3) / 0.5) * Math.PI) * 0.05 : 0;
      const angle = 1.45 * eased - settle;
      const q = new THREE.Quaternion().setFromAxisAngle(f.axis, angle);
      f.mesh.quaternion.copy(q).multiply(f.q0);
      f.mesh.position.y = -0.15 * eased;
      if (f.t > 2.2) this.fallingTrees.splice(i, 1);
    }

    // Debris / dust / smoke particles.
    for (let i = (this.impactFx || []).length - 1; i >= 0; i -= 1) {
      const p = this.impactFx[i];
      p.life += deltaTime;
      p.vel.y -= p.gravity * deltaTime;
      p.mesh.position.addScaledVector(p.vel, deltaTime);
      if (p.mesh.position.y < 0.05 && p.gravity > 2) {
        p.mesh.position.y = 0.05;
        p.vel.y *= -0.3;
        p.vel.x *= 0.6;
        p.vel.z *= 0.6;
      }
      if (p.grow) p.mesh.scale.setScalar(1 + p.life * p.grow);
      const fade = Math.max(0, 1 - p.life / p.maxLife);
      p.mesh.material.opacity = fade * (p.fade < 1 ? p.fade + 0.2 : 1);
      if (p.life >= p.maxLife) {
        this.scene.remove(p.mesh);
        p.mesh.material.dispose();
        p.mesh.geometry.dispose();
        this.impactFx.splice(i, 1);
      }
    }

    // Explosion flash lights fade out fast and are removed.
    for (let i = (this.explosionLights || []).length - 1; i >= 0; i -= 1) {
      const f = this.explosionLights[i];
      f.life += deltaTime;
      if (f.light.owned()) f.light.light.intensity = f.intensity * Math.max(0, 1 - f.life / f.maxLife);
      if (f.life >= f.maxLife) {
        f.light.release();
        this.explosionLights.splice(i, 1);
      }
    }
  }

  // ---- FPV ----

  updateFPVWeapon(weaponKey) {
    if (!this.fpvWeapon || weaponKey !== this.fpvWeapon.userData.currentWeapon) {
      this.fpvWeapon = switchFPVWeapon(this.fpvWeapon, weaponKey);
      this.fpvScene.add(this.fpvWeapon);
    }
  }

  /** ctx comes from FragGame; see fpv-weapon.js for the field list. */
  updateFPV(deltaTime, ctx) {
    if (!this.fpvWeapon) return;

    setScope(this.fpvWeapon, ctx.isScoped);
    updateFPVAnimations(this.fpvWeapon, deltaTime, ctx);
    this.isSprinting = ctx.isSprinting;

    if (ctx.justFired) {
      this.fireLight.intensity = 2.4 + Math.random() * 1.6;
      const weaponKey = this.fpvWeapon.userData.currentWeapon;
      const SHAKE = { sniper: 0.16, rifle: 0.07, shotgun: 0.2, revolver: 0.12, launcher: 0.24, lmg: 0.05, burst: 0.06, laser: 0.04, spread: 0.06 };
      const shakeAmount = SHAKE[weaponKey] ?? 0.045;
      this.shakeIntensity = Math.min(0.3, this.shakeIntensity + shakeAmount);
    } else {
      this.fireLight.intensity *= Math.exp(-deltaTime * 30);
    }
  }

  // ---- Camera ----

  updateCamera(state, myId, gameState, deltaTime) {
    const me = state.players.find((p) => p.id === myId);
    let vehicle = null;
    if (me) {
      // Chase cam only for the driver; passengers keep the on-foot FPV camera
      // (their position is synced to the vehicle server-side, so FPV = riding).
      const myVehicle =
        me.inVehicle && me.seat === "driver"
          ? (state.vehicles || []).find((v) => v.id === me.inVehicle)
          : null;
      vehicle = myVehicle || null;

      // Blend into a chase camera while driving.
      const targetBlend = vehicle ? 1 : 0;
      this.vehicleCamBlend += (targetBlend - this.vehicleCamBlend) * Math.min(1, deltaTime * 4.5);
      const blend = this.vehicleCamBlend;

      if (vehicle && blend > 0.3) {
        // Auto-align the view behind the car's heading so steering reads
        // naturally; the mouse can still glance around and it re-centers.
        const speedAbs = Math.abs(vehicle.speed || 0);
        const align = Math.min(1, deltaTime * (1.4 + speedAbs * 0.09));
        gameState.camera.yaw = normalizeAngle(
          gameState.camera.yaw + normalizeAngle(vehicle.yaw - gameState.camera.yaw) * align,
        );
      }

      const speedAbs = vehicle ? Math.abs(vehicle.speed || 0) : 0;
      const camDist = 6.4 + Math.min(2.6, speedAbs * 0.08);
      const camHeight = 2.6 + Math.min(0.8, speedAbs * 0.018);
      const backX = Math.sin(gameState.camera.yaw);
      const backZ = Math.cos(gameState.camera.yaw);
      const baseX = vehicle ? vehicle.x : me.x;
      // Use the vehicle's altitude so the chase cam tracks flying vehicles.
      const baseY = vehicle ? (vehicle.y || 0) + 1.5 : me.y;
      const baseZ = vehicle ? vehicle.z : me.z;
      const targetX = baseX + backX * camDist * blend;
      const targetY = baseY + camHeight * blend;
      const targetZ = baseZ + backZ * camDist * blend;

      const k = Math.min(1, deltaTime * (vehicle ? 18 : 16));
      this.camera.position.x += (targetX - this.camera.position.x) * k;
      this.camera.position.y += (targetY - this.camera.position.y) * k;
      this.camera.position.z += (targetZ - this.camera.position.z) * k;
      if (this.vehicleCamBlend > 0.05) {
        this.camera.position.y = Math.max(this.camera.position.y, 1.1);
      }
    }

    this.shakeIntensity *= Math.exp(-deltaTime * 12);
    this.screenShake.set(
      (Math.random() - 0.5) * this.shakeIntensity,
      (Math.random() - 0.5) * this.shakeIntensity,
      (Math.random() - 0.5) * this.shakeIntensity,
    );
    this.camera.position.add(this.screenShake);

    gameState.camera.recoilPitchKick *= Math.exp(-deltaTime * 14);
    gameState.camera.recoilYawKick *= Math.exp(-deltaTime * 12);

    this.camera.rotation.y = normalizeAngle(gameState.camera.yaw + gameState.camera.recoilYawKick);
    this.camera.rotation.x = clamp(
      gameState.camera.pitch + gameState.camera.recoilPitchKick - this.vehicleCamBlend * 0.2,
      -1.2,
      1.1,
    );

    // FOV: ADS zoom, sprint widen, speed rush while driving.
    let baseFov = 78;
    if (gameState.isScoped && !this.vehicleCamBlend) {
      const cfg = this.fpvWeapon?.userData?.cfg;
      baseFov = cfg?.adsZoomFov || 58;
    }
    if (this.isSprinting && !gameState.isScoped) baseFov += 10;
    if (vehicle) baseFov += Math.min(14, Math.abs(vehicle.speed || 0) * 0.4);

    this.camera.fov += (baseFov - this.camera.fov) * Math.min(1, deltaTime * 10);
    this.camera.updateProjectionMatrix();

    if (this.fpvCamera) {
      // Keep the viewmodel FOV fixed so the gun doesn't warp; only nudge for ADS.
      const fpvTarget = gameState.isScoped ? 58 : 70;
      this.fpvCamera.fov += (fpvTarget - this.fpvCamera.fov) * Math.min(1, deltaTime * 10);
      this.fpvCamera.updateProjectionMatrix();
    }

    // Sun shadow frustum follows the player.
    if (this.sun && me) {
      this.sun.position.set(me.x + 90, 160, me.z + 60);
      this.sun.target.position.set(me.x, 0, me.z);
      this.sun.target.updateMatrixWorld();
    }
  }

  onWindowResize() {
    if (!this.renderer || !this.camera) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this.fpvCamera) {
      this.fpvCamera.aspect = window.innerWidth / window.innerHeight;
      this.fpvCamera.updateProjectionMatrix();
    }
  }

  /**
   * Adaptive quality. Every 1.5s, if the frame rate sags (big horde, weak
   * phone GPU), step down one rung; when there's headroom, step back up:
   *   first   render resolution (down to 0.6x)
   *   then    shadows off (drops the whole shadow pass)
   *   last    shorter draw distance
   */
  adaptResolution() {
    const p = this.perf;
    if (!p) return;
    p.frames += 1;
    const now = performance.now();
    const elapsed = now - p.since;
    if (elapsed < 1500) return;
    const fps = (p.frames * 1000) / elapsed;
    p.frames = 0;
    p.since = now;
    const minPR = 0.6;
    // Hysteresis: anything that recompiles shaders (shadows on/off) is a
    // multi-second hitch, so it may switch off once and only comes back after
    // a long stretch of high FPS — never ping-pong every few seconds.
    p.good = fps > 57 ? (p.good || 0) + 1 : 0;
    if (fps < 45) {
      if (this.pixelRatio > minPR + 0.01) {
        this.setRenderScale(Math.max(minPR, this.pixelRatio * 0.85));
      } else if (this.sun && this.sun.castShadow) {
        this.sun.castShadow = false; // one-time shader rebuild, then no shadow pass
        this.shadowDrops = (this.shadowDrops || 0) + 1;
      } else if (this.post && this.post.enabled) {
        // Post-processing off for good (re-enabling would recompile everything).
        this.post.setEnabled(false);
      } else if (this.grassField && !this.grassField.off) {
        this.grassField.off = true; // dense blades are the next biggest cost
      } else if (this.camera && this.camera.far > 300) {
        this.camera.far = 300;
        this.camera.updateProjectionMatrix();
      }
    } else if (fps > 57) {
      if (this.camera && this.camera.far < this.baseFar) {
        this.camera.far = this.baseFar;
        this.camera.updateProjectionMatrix();
      } else if (this.pixelRatio < this.maxPixelRatio - 0.01 && p.good >= 3) {
        // (resizing reallocates the frame buffers: only after ~4.5s of headroom)
        this.setRenderScale(Math.min(this.maxPixelRatio, this.pixelRatio * 1.1));
      } else if (this.sun && !this.sun.castShadow && this.shadowsWanted && (this.shadowDrops || 0) < 2 && p.good >= 8) {
        // ~12s of solid FPS at full resolution: try shadows again (max twice).
        this.sun.castShadow = true;
      }
    }
  }

  setRenderScale(pr) {
    this.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  render() {
    if (!this.renderer || !this.camera) return;
    this.adaptResolution();
    const nowMs = performance.now();
    const dt = Math.min(0.1, (nowMs - (this.lastRenderAt || nowMs)) / 1000);
    this.lastRenderAt = nowMs;
    if (this.atmosphere) this.atmosphere.update(dt, this.camera);
    if (this.wildlife) this.wildlife.update(dt, this.camera, this.wildlifePlayers || [], this.atmosphere?.stormAmount?.() || 0);
    this.cullTimer = (this.cullTimer || 0) - dt;
    if (this.cullTimer <= 0) {
      this.cullTimer = 0.4;
      this.cullDistantBuildings();
    }

    // Animate water shader time.
    const t = performance.now() * 0.001;
    for (const mat of this.scene.userData.waterMaterials || []) {
      mat.uniforms.time.value = t;
    }

    if (this.grassField) this.grassField.update(this.camera);

    const usePost = this.post && this.post.enabled;
    if (usePost) {
      this.post.grade(this.atmosphere?.current, this.atmosphere?.night || 0);
      this.post.begin();
    }
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    if (this.fpvWeapon && this.vehicleCamBlend < 0.4) {
      this.renderer.render(this.fpvScene, this.fpvCamera);
    }
    if (usePost) this.post.end(t);
  }

  /**
   * Blend the whole environment between day (0) and night (1).
   * Used by Z+ mode's 5-minute day/night cycle.
   */
  /** Server weather ({ kind, prev, t }) — see weather-system.js. */
  setWeather(w) {
    if (this.atmosphere) this.atmosphere.setWeather(w);
  }

  setDayNight(f) {
    if (this.atmosphere) {
      // Sky, fog and lights are driven by the atmosphere (weather x day/night).
      this.atmosphere.setNight(f);
      const t = Math.max(0, Math.min(1, f));
      if (this.fpvArmLight) this.fpvArmLight.intensity = 0.9 * (1 - t) + 0.45 * t;
      if (this.fpvFill) this.fpvFill.intensity = 0.55 * (1 - t) + 0.32 * t;
      return;
    }
    if (!this.sun || !this.scene) return;
    const t = Math.max(0, Math.min(1, f));
    if (this._dnScratch === undefined) {
      this._dnScratch = {
        a: new THREE.Color(),
        b: new THREE.Color(),
      };
    }
    const lerpColor = (target, dayHex, nightHex) => {
      this._dnScratch.a.setHex(dayHex);
      this._dnScratch.b.setHex(nightHex);
      target.copy(this._dnScratch.a).lerp(this._dnScratch.b, t);
    };

    this.sun.intensity = 1.15 * (1 - t) + 0.34 * t;
    lerpColor(this.sun.color, 0xfff1d6, 0xa9bce4); // warm sun -> bright moonlight
    this.hemi.intensity = 0.85 * (1 - t) + 0.4 * t;
    lerpColor(this.hemi.color, 0xd9ecff, 0x3a4c6e);
    lerpColor(this.scene.background, 0x9cc0e0, 0x101a2c);
    if (this.scene.fog) {
      lerpColor(this.scene.fog.color, 0x9db8cd, 0x16202f);
      this.scene.fog.density = 0.00135 * (1 - t) + 0.0019 * t;
    }
    const sky = this.scene.getObjectByName("skyDome");
    if (sky?.material?.uniforms) {
      lerpColor(sky.material.uniforms.topColor.value, 0x3d7ac2, 0x0c1630);
      lerpColor(sky.material.uniforms.horizonColor.value, 0xcfe4ef, 0x2a3c5c);
      lerpColor(sky.material.uniforms.bottomColor.value, 0x86a36d, 0x18211a);
    }
    if (this.fpvArmLight) this.fpvArmLight.intensity = 0.9 * (1 - t) + 0.45 * t;
    if (this.fpvFill) this.fpvFill.intensity = 0.55 * (1 - t) + 0.32 * t;
  }

  isInitialized() {
    return Boolean(this.scene && this.camera && this.renderer);
  }

  getInitError() {
    return this.initError;
  }
}
