import { optimizeStaticWorld } from "./scene-optimizer.js";
import { patchSurface } from "./atmosphere.js";
import {
  buildTreeVariant,
  addHipRoof,
  addPagoda,
  addTorii,
  addStoneLantern,
  addRockMass,
  addCrystal,
  addWaterfall,
  addFarmProp,
  addFields,
  COUNTRY_PATCH_LOOK,
} from "./countryside.js";

/**
 * World construction: terrain layers, animated water, buildings with glass and
 * roofs, vegetation (instanced grass, trees, bushes), street furniture, and
 * the shrinking-zone visuals. Prop data comes from the server; this module
 * only decides how each prop type looks.
 */

const tmpColor = new THREE.Color();

function std(color, roughness = 0.9, metalness = 0.02, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
}

/** Tag a material with its surface kind (see atmosphere.js patchSurface). */
function surf(material, kind) {
  material.userData.surface = { ...(material.userData.surface || {}), kind };
  return material;
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

function buildWaterMaterial(color) {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        time: { value: 0 },
        shallow: { value: new THREE.Color(color).offsetHSL(0, -0.05, 0.12) },
        deep: { value: new THREE.Color(color).offsetHSL(0, 0.02, -0.12) },
        skyCol: { value: new THREE.Color(0xa9c6dc) },
        sunDir: { value: new THREE.Vector3(0.5, 0.8, 0.4).normalize() },
      },
    ]),
    vertexShader: `
      #include <fog_pars_vertex>
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: `
      #include <common>
      #include <fog_pars_fragment>
      uniform float time;
      uniform vec3 shallow;
      uniform vec3 deep;
      uniform vec3 skyCol;
      uniform vec3 sunDir;
      varying vec3 vWorld;
      void main() {
        float w1 = sin(vWorld.x * 0.14 + time * 1.1) * sin(vWorld.z * 0.11 - time * 0.9);
        float w2 = sin(vWorld.x * 0.31 - time * 1.7) * sin(vWorld.z * 0.27 + time * 1.3);
        float ripple = w1 * 0.6 + w2 * 0.4;
        vec3 n = normalize(vec3(-cos(vWorld.x * 0.14 + time * 1.1) * 0.12, 1.0, cos(vWorld.z * 0.27 + time * 1.3) * 0.1));
        vec3 v = normalize(cameraPosition - vWorld);
        // Fresnel: looking across the water shows the sky, looking down shows depth.
        float fres = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 4.0);
        vec3 col = mix(deep, shallow, ripple * 0.5 + 0.5);
        col = mix(col, skyCol, 0.08 + 0.4 * fres);
        float spec = pow(max(dot(reflect(-sunDir, n), v), 0.0), 120.0);
        col += vec3(1.0, 0.95, 0.82) * spec * 1.6;
        gl_FragColor = vec4(col, mix(0.78, 0.95, fres));
        #include <tonemapping_fragment>
        #include <encodings_fragment>
        #include <fog_fragment>
      }
    `,
  });
  return mat;
}

export function addTerrainPatch(scene, patch, layerIndex = 0) {
  const geo = new THREE.PlaneGeometry(patch.sx, patch.sz);
  let mesh;

  if (patch.type === "river" || patch.type === "lake") {
    const mat = buildWaterMaterial(patch.color || 0x2e6b8f);
    mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(patch.x, 0.06, patch.z);
    scene.add(mesh);
    scene.userData.waterMaterials = scene.userData.waterMaterials || [];
    scene.userData.waterMaterials.push(mat);
    return;
  }

  const look = COUNTRY_PATCH_LOOK[patch.type];
  const SURFACE_OF = {
    road: "road", lot: "road", sidewalk: "sidewalk", dirt: "dirt", dirtroad: "dirt", scorch: "dirt",
    sand: "sand", cave: "dirt", paddy: "dirt", pampas: "dirt",
  };
  const surfaceKind = SURFACE_OF[patch.type] || "grass";
  const roughness = look ? look.roughness : patch.type === "road" ? 0.85 : 0.96;
  const mat = patchSurface(
    std(patch.color || 0x4b7a46, roughness, look?.metalness || 0, {
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: layerIndex + 1,
    }),
    { ground: true, variation: 0.3, kind: surfaceKind },
  );
  mat.userData.surface = { kind: surfaceKind, ground: true, variation: 0.3 };
  mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(patch.x, layerIndex * 0.005, patch.z);
  mesh.receiveShadow = true;
  scene.add(mesh);

  if (patch.type === "road") {
    const horizontal = patch.sx > patch.sz;
    const roadLen = horizontal ? patch.sx : patch.sz;
    const markerCount = Math.floor(roadLen / 16);
    const markerMat = new THREE.MeshBasicMaterial({ color: 0xd9d2a8, transparent: true, opacity: 0.8 });
    const markerGeo = new THREE.PlaneGeometry(horizontal ? 5 : 0.5, horizontal ? 0.5 : 5);
    for (let i = 0; i < markerCount; i += 1) {
      const marker = new THREE.Mesh(markerGeo, markerMat);
      marker.rotation.x = -Math.PI / 2;
      const offset = (i - markerCount / 2 + 0.5) * 16;
      marker.position.set(
        patch.x + (horizontal ? offset : 0),
        layerIndex * 0.005 + 0.02,
        patch.z + (horizontal ? 0 : offset),
      );
      scene.add(marker);
    }
    // Edge lines.
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0xb9b4a1, transparent: true, opacity: 0.5 });
    for (const side of [-1, 1]) {
      const edge = new THREE.Mesh(
        new THREE.PlaneGeometry(horizontal ? patch.sx : 0.28, horizontal ? 0.28 : patch.sz),
        edgeMat,
      );
      edge.rotation.x = -Math.PI / 2;
      edge.position.set(
        patch.x + (horizontal ? 0 : side * (patch.sx / 2 - 0.4)),
        layerIndex * 0.005 + 0.018,
        patch.z + (horizontal ? side * (patch.sz / 2 - 0.4) : 0),
      );
      scene.add(edge);
    }
  }

  if (patch.type === "lot") {
    // Painted parking stall lines.
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xcdc7b0, transparent: true, opacity: 0.6 });
    const lineGeo = new THREE.PlaneGeometry(0.25, 6);
    const cols = Math.floor(patch.sx / 8);
    for (let i = 0; i <= cols; i += 1) {
      for (const row of [-1, 1]) {
        const line = new THREE.Mesh(lineGeo, lineMat);
        line.rotation.x = -Math.PI / 2;
        line.position.set(
          patch.x - patch.sx / 2 + 8 + i * 8,
          layerIndex * 0.005 + 0.02,
          patch.z + row * (patch.sz / 4),
        );
        scene.add(line);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Vegetation & nature props
// ---------------------------------------------------------------------------

function addTree(scene, prop) {
  if (prop.variant) {
    const tree = new THREE.Group();
    buildTreeVariant(tree, prop);
    tree.position.set(prop.x, 0, prop.z);
    tree.rotation.y = ((prop.x * 7.31 + prop.z * 3.17) % 6.283);
    scene.add(tree);
    scene.userData.propMeshes = scene.userData.propMeshes || new Map();
    scene.userData.propMeshes.set(prop.id, tree);
    return;
  }
  const tree = new THREE.Group();
  const trunkH = prop.sy * 0.45;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(prop.sx * 0.32, prop.sx * 0.5, trunkH, 8),
    surf(std(0x5d4326, 0.95), "bark"),
  );
  trunk.position.y = trunkH / 2;
  trunk.castShadow = true;
  tree.add(trunk);

  const baseColor = new THREE.Color(prop.color || 0x2f5e23);
  for (let i = 0; i < 3; i += 1) {
    tmpColor.copy(baseColor).offsetHSL(0, 0, (i - 1) * 0.035 + (Math.random() - 0.5) * 0.03);
    const r = prop.sy * (0.3 - i * 0.055);
    const blob = new THREE.Mesh(
      new THREE.SphereGeometry(r, 8, 6),
      std(tmpColor.getHex(), 0.92, 0, { flatShading: true }),
    );
    blob.position.set(
      (Math.random() - 0.5) * r * 0.7,
      trunkH + prop.sy * (0.18 + i * 0.2),
      (Math.random() - 0.5) * r * 0.7,
    );
    blob.scale.y = 0.82;
    blob.castShadow = true;
    tree.add(blob);
  }

  tree.position.set(prop.x, 0, prop.z);
  tree.rotation.y = Math.random() * Math.PI * 2;
  scene.add(tree);

  // Register so gameplay can knock trees down (vehicle impacts).
  scene.userData.propMeshes = scene.userData.propMeshes || new Map();
  scene.userData.propMeshes.set(prop.id, tree);
}

function addBush(scene, prop) {
  const bush = new THREE.Group();
  const blobs = 3;
  for (let i = 0; i < blobs; i += 1) {
    tmpColor.set(prop.color || 0x3c6b2e).offsetHSL(0, 0, (Math.random() - 0.5) * 0.06);
    const r = prop.sy * (0.6 + Math.random() * 0.35);
    const blob = new THREE.Mesh(
      new THREE.SphereGeometry(r, 7, 5),
      surf(std(tmpColor.getHex(), 0.95, 0, { flatShading: true }), "foliage"),
    );
    blob.position.set((Math.random() - 0.5) * prop.sx * 0.6, r * 0.7, (Math.random() - 0.5) * prop.sz * 0.6);
    blob.castShadow = true;
    bush.add(blob);
  }
  bush.position.set(prop.x, 0, prop.z);
  scene.add(bush);
}

function addRock(scene, prop) {
  const rock = new THREE.Mesh(
    new THREE.IcosahedronGeometry(Math.max(prop.sx, prop.sz) * 0.55, 0),
    surf(std(prop.color || 0x77797b, 0.95, 0.04, { flatShading: true }), "rock"),
  );
  rock.position.set(prop.x, (prop.py || 0) + prop.sy * 0.35, prop.z);
  rock.scale.y = prop.sy / Math.max(prop.sx, prop.sz);
  rock.rotation.set(Math.random(), Math.random() * Math.PI, Math.random() * 0.4);
  rock.castShadow = true;
  scene.add(rock);
}

function addGrass(scene, meta) {
  const patches = meta.terrainPatches || [];
  const avoid = [];
  const avoidPatchTypes = new Set(["road", "sidewalk", "river", "lake", "sand", "dirt", "lot", "scorch", "dirtroad", "paddy", "pampas", "cave"]);
  for (const p of patches) {
    if (avoidPatchTypes.has(p.type)) {
      avoid.push({ x: p.x, z: p.z, hw: p.sx / 2 + 1, hd: p.sz / 2 + 1 });
    }
  }
  // Keep grass out of building/structure footprints.
  const avoidPropTypes = new Set(["roof", "tower", "shop", "container", "bus", "truck", "gravelpile", "plane-fuselage", "plane-wing", "plane-tail", "scaffold", "cranemast", "cliff", "cavewall", "terrace", "stairs"]);
  for (const p of meta.props || []) {
    if (avoidPropTypes.has(p.type)) avoid.push({ x: p.x, z: p.z, hw: p.sx / 2 + 1, hd: p.sz / 2 + 1 });
  }

  // Low-poly grass clumps: squat 4-sided cones read as tufts from any angle
  // (flat billboards look like floating cards at distance).
  const half = meta.worldHalfSize || 320;
  const lowEnd = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const COUNT = Math.round(2600 * Math.min(lowEnd ? 1.5 : 3, (half / 300) ** 2));
  const geo = new THREE.ConeGeometry(0.16, 0.34, 4);
  geo.translate(0, 0.17, 0);
  const mat = patchSurface(
    new THREE.MeshStandardMaterial({
      color: 0x4a7a36,
      roughness: 1,
      flatShading: true,
    }),
    { sway: 0.35, variation: 0.35 },
  );
  const grass = new THREE.InstancedMesh(geo, mat, COUNT);
  const dummy = new THREE.Object3D();
  let placed = 0;
  let guard = 0;
  while (placed < COUNT && guard < COUNT * 6) {
    guard += 1;
    const x = (Math.random() * 2 - 1) * (half - 4);
    const z = (Math.random() * 2 - 1) * (half - 4);
    if (avoid.some((a) => Math.abs(x - a.x) < a.hw && Math.abs(z - a.z) < a.hd)) continue;
    dummy.position.set(x, 0, z);
    dummy.rotation.y = Math.random() * Math.PI;
    const s = 0.55 + Math.random() * 0.75;
    dummy.scale.set(s, s * (0.7 + Math.random() * 0.6), s);
    dummy.updateMatrix();
    grass.setMatrixAt(placed, dummy.matrix);
    placed += 1;
  }
  grass.count = placed;
  grass.instanceMatrix.needsUpdate = true;
  scene.add(grass);
}

function addClouds(scene) {
  const cloudMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
  });
  for (let i = 0; i < 14; i += 1) {
    const cloud = new THREE.Group();
    const blobs = 3 + Math.floor(Math.random() * 3);
    for (let b = 0; b < blobs; b += 1) {
      const r = 14 + Math.random() * 22;
      const blob = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), cloudMat);
      blob.position.set((b - blobs / 2) * r * 1.1, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 16);
      blob.scale.y = 0.4;
      cloud.add(blob);
    }
    const angle = Math.random() * Math.PI * 2;
    const dist = 250 + Math.random() * 480;
    cloud.position.set(Math.cos(angle) * dist, 150 + Math.random() * 90, Math.sin(angle) * dist);
    scene.add(cloud);
  }
}

// ---------------------------------------------------------------------------
// Structures & furniture
// ---------------------------------------------------------------------------

const BOX_GEO = new THREE.BoxGeometry(1, 1, 1);

function box(scene, prop, material, { shadow = true, yOffset = 0 } = {}) {
  const mesh = new THREE.Mesh(BOX_GEO, material);
  mesh.scale.set(prop.sx, prop.sy, prop.sz);
  mesh.position.set(prop.x, (prop.py || 0) + prop.sy / 2 + yOffset, prop.z);
  if (shadow) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
  scene.add(mesh);
  return mesh;
}

function addStreetlight(scene, prop) {
  const g = new THREE.Group();
  const poleMat = std(0x2b2e31, 0.6, 0.4);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, prop.sy, 8), poleMat);
  pole.position.y = prop.sy / 2;
  pole.castShadow = true;
  g.add(pole);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 1.2), poleMat);
  arm.position.set(0, prop.sy - 0.05, -0.55);
  g.add(arm);
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xfff0c0,
    emissive: 0xffdf8a,
    emissiveIntensity: 0.9,
    roughness: 0.4,
  });
  const lampHead = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.55), headMat);
  lampHead.position.set(0, prop.sy - 0.02, -1.05);
  g.add(lampHead);
  g.position.set(prop.x, 0, prop.z);
  // Lean the arm toward the road (roads are at x/z ~ 0).
  g.rotation.y = Math.abs(prop.x) < Math.abs(prop.z) ? (prop.x > 0 ? Math.PI / 2 : -Math.PI / 2) : prop.z > 0 ? Math.PI : 0;
  scene.add(g);
}

function addBench(scene, prop) {
  const g = new THREE.Group();
  const woodMat = std(prop.color || 0x6e5433, 0.88);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(prop.sx, 0.07, 0.45), woodMat);
  seat.position.y = 0.42;
  seat.castShadow = true;
  g.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(prop.sx, 0.32, 0.06), woodMat);
  back.position.set(0, 0.62, -0.2);
  back.rotation.x = -0.12;
  g.add(back);
  const legMat = std(0x33363a, 0.7, 0.3);
  for (const sx of [-prop.sx / 2 + 0.15, prop.sx / 2 - 0.15]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.42, 0.4), legMat);
    leg.position.set(sx, 0.21, 0);
    g.add(leg);
  }
  g.position.set(prop.x, 0, prop.z);
  g.rotation.y = (prop.x + prop.z) % 2 > 1 ? Math.PI / 2 : 0;
  scene.add(g);
}

function addFence(scene, prop) {
  const g = new THREE.Group();
  const woodMat = std(prop.color || 0x8a6f43, 0.9);
  const horizontal = prop.sx > prop.sz;
  const len = horizontal ? prop.sx : prop.sz;
  const postCount = Math.max(2, Math.round(len / 2.2));
  for (let i = 0; i < postCount; i += 1) {
    const t = postCount === 1 ? 0 : i / (postCount - 1) - 0.5;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, prop.sy, 0.12), woodMat);
    post.position.set(horizontal ? t * len : 0, prop.sy / 2, horizontal ? 0 : t * len);
    post.castShadow = true;
    g.add(post);
  }
  for (const railY of [prop.sy * 0.45, prop.sy * 0.85]) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(horizontal ? len : 0.08, 0.08, horizontal ? 0.08 : len),
      woodMat,
    );
    rail.position.y = railY;
    g.add(rail);
  }
  g.position.set(prop.x, prop.py || 0, prop.z);
  scene.add(g);
}

function addLampProp(scene, prop) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.14, prop.sy, 8), std(0x25282b, 0.65, 0.3));
  pole.position.y = prop.sy / 2;
  g.add(pole);
  const shade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.26, 0.22, 10, 1, true),
    std(0xd8c49a, 0.7, 0, { side: THREE.DoubleSide }),
  );
  shade.position.y = prop.sy - 0.05;
  g.add(shade);
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xffe9b0 }),
  );
  bulb.position.y = prop.sy - 0.12;
  g.add(bulb);
  g.position.set(prop.x, prop.py || 0, prop.z);
  scene.add(g);
}

// ---------------------------------------------------------------------------
// City structures & street props
// ---------------------------------------------------------------------------

const CYL = (rt, rb, h, seg = 12) => new THREE.CylinderGeometry(rt, rb, h, seg);

// Apartment / office block: solid body + per-floor window bands + rooftop kit.
// Tower facades. The collision box is the same for all; what differs is the
// silhouette and skin: ribbon window bands, punched-window brick grid, a glass
// curtain wall with mullions, stepped setbacks, or art-deco piers + crown.
function towerBands(g, w, h, d, y0, base, office, glassMat) {
  const floorH = office ? 3.3 : 3.0;
  const floors = Math.min(16, Math.max(1, Math.floor((h - 1.6) / floorH)));
  for (const f of TOWER_FACES) {
    const span = f.ax === "z" ? w : d;
    const bandLen = span * 0.82;
    for (let fl = 0; fl < floors; fl += 1) {
      const y = y0 + 2.0 + fl * floorH;
      if (y > y0 + h - 0.9) break;
      const band = new THREE.Mesh(BOX_GEO, glassMat);
      if (f.ax === "z") {
        band.scale.set(bandLen, floorH * 0.55, 0.25);
        band.position.set(0, y, f.n * (d / 2 + 0.03));
      } else {
        band.scale.set(0.25, floorH * 0.55, bandLen);
        band.position.set(f.n * (w / 2 + 0.03), y, 0);
      }
      g.add(band);
      if (!office && f.ax === "z" && fl % 2 === 1) {
        const bal = new THREE.Mesh(BOX_GEO, std(base.clone().offsetHSL(0, 0, -0.1).getHex(), 0.9));
        bal.scale.set(bandLen, 0.14, 1.0);
        bal.position.set(0, y - floorH * 0.32, f.n * (d / 2 + 0.5));
        g.add(bal);
      }
    }
  }
}

function towerGrid(g, w, h, d, y0, base, glassMat) {
  const sillMat = std(base.clone().offsetHSL(0, -0.05, 0.12).getHex(), 0.85);
  const floorH = 3.0;
  const floors = Math.min(14, Math.floor((h - 1) / floorH));
  for (const f of TOWER_FACES) {
    const span = f.ax === "z" ? w : d;
    const bays = Math.max(2, Math.floor(span / 3.4));
    for (let fl = 0; fl < floors; fl += 1) {
      const y = y0 + 1.7 + fl * floorH;
      for (let b = 0; b < bays; b += 1) {
        const off = (b - (bays - 1) / 2) * (span / bays);
        const win = new THREE.Mesh(BOX_GEO, glassMat);
        const sill = new THREE.Mesh(BOX_GEO, sillMat);
        if (f.ax === "z") {
          win.scale.set(1.3, 1.6, 0.2);
          win.position.set(off, y, f.n * (d / 2 + 0.02));
          sill.scale.set(1.6, 0.15, 0.35);
          sill.position.set(off, y - 0.88, f.n * (d / 2 + 0.1));
        } else {
          win.scale.set(0.2, 1.6, 1.3);
          win.position.set(f.n * (w / 2 + 0.02), y, off);
          sill.scale.set(0.35, 0.15, 1.6);
          sill.position.set(f.n * (w / 2 + 0.1), y - 0.88, off);
        }
        g.add(win, sill);
      }
    }
  }
  // Cornice.
  const cornice = new THREE.Mesh(BOX_GEO, sillMat);
  cornice.scale.set(w + 0.8, 0.5, d + 0.8);
  cornice.position.y = y0 + h - 0.25;
  g.add(cornice);
}

function towerCurtain(g, w, h, d, y0) {
  const mullMat = std(0xb8c0c8, 0.35, 0.7);
  for (const f of TOWER_FACES) {
    const span = f.ax === "z" ? w : d;
    const n = Math.max(2, Math.floor(span / 2.4));
    for (let i = 0; i <= n; i += 1) {
      const off = -span / 2 + (i * span) / n;
      const fin = new THREE.Mesh(BOX_GEO, mullMat);
      if (f.ax === "z") {
        fin.scale.set(0.16, h, 0.35);
        fin.position.set(off, y0 + h / 2, f.n * (d / 2 + 0.1));
      } else {
        fin.scale.set(0.35, h, 0.16);
        fin.position.set(f.n * (w / 2 + 0.1), y0 + h / 2, off);
      }
      g.add(fin);
    }
    for (let y = y0 + 3.6; y < y0 + h - 1; y += 3.6) {
      const sp = new THREE.Mesh(BOX_GEO, mullMat);
      if (f.ax === "z") {
        sp.scale.set(w, 0.12, 0.3);
        sp.position.set(0, y, f.n * (d / 2 + 0.08));
      } else {
        sp.scale.set(0.3, 0.12, d);
        sp.position.set(f.n * (w / 2 + 0.08), y, 0);
      }
      g.add(sp);
    }
  }
}

function towerDecoPiers(g, w, h, d, y0, base) {
  const pierMat = std(base.clone().offsetHSL(0, 0, 0.08).getHex(), 0.7);
  const recess = std(0x2c3440, 0.3, 0.4, { emissive: 0x1a2430, emissiveIntensity: 0.3 });
  for (const f of TOWER_FACES) {
    const span = f.ax === "z" ? w : d;
    const n = Math.max(3, Math.floor(span / 3));
    for (let i = 0; i < n; i += 1) {
      const off = (i - (n - 1) / 2) * (span / n);
      const strip = new THREE.Mesh(BOX_GEO, recess);
      if (f.ax === "z") {
        strip.scale.set((span / n) * 0.55, h - 2.4, 0.12);
        strip.position.set(off, y0 + h / 2, f.n * (d / 2 + 0.01));
      } else {
        strip.scale.set(0.12, h - 2.4, (span / n) * 0.55);
        strip.position.set(f.n * (w / 2 + 0.01), y0 + h / 2, off);
      }
      g.add(strip);
      const pier = new THREE.Mesh(BOX_GEO, pierMat);
      const po = off + (span / n) / 2;
      if (f.ax === "z") {
        pier.scale.set(0.5, h + 0.6, 0.5);
        pier.position.set(Math.min(span / 2, po), y0 + h / 2 + 0.3, f.n * (d / 2 + 0.1));
      } else {
        pier.scale.set(0.5, h + 0.6, 0.5);
        pier.position.set(f.n * (w / 2 + 0.1), y0 + h / 2 + 0.3, Math.min(span / 2, po));
      }
      g.add(pier);
    }
  }
}

function towerRoofKit(g, kit, w, d, top, seedStr) {
  const r = (k) => {
    const v = Math.sin((seedStr.length * 31 + k) * 12.9898) * 43758.5453;
    return v - Math.floor(v);
  };
  if (kit === "helipad") {
    const pad = new THREE.Mesh(CYL(Math.min(w, d) * 0.36, Math.min(w, d) * 0.36, 0.25, 20), std(0x34383d, 0.8));
    pad.position.y = top + 0.15;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(Math.min(w, d) * 0.28, 0.18, 4, 24), std(0xf0c020, 0.6));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = top + 0.3;
    g.add(pad, ring);
    const white = std(0xf2f2f0, 0.6);
    for (const [sx, sz, x] of [[0.5, 4, -1.2], [0.5, 4, 1.2], [2.4, 0.5, 0]]) {
      const bar = new THREE.Mesh(BOX_GEO, white);
      bar.scale.set(sx, 0.08, sz);
      bar.position.set(x, top + 0.31, 0);
      g.add(bar);
    }
  } else if (kit === "watertower") {
    const wood = std(0x6b4c33, 0.95);
    const x = w * 0.18;
    const z = -d * 0.15;
    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const leg = new THREE.Mesh(BOX_GEO, std(0x3a3d42, 0.6, 0.4));
      leg.scale.set(0.2, 3, 0.2);
      leg.position.set(x + lx * 1.3, top + 1.5, z + lz * 1.3);
      g.add(leg);
    }
    const tank = new THREE.Mesh(CYL(1.8, 1.8, 3.2, 12), wood);
    tank.position.set(x, top + 4.6, z);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(2, 1.2, 12), std(0x4a4f55, 0.7));
    cap.position.set(x, top + 6.8, z);
    tank.castShadow = true;
    g.add(tank, cap);
  } else if (kit === "garden") {
    const soil = new THREE.Mesh(BOX_GEO, std(0x4f6a36, 1));
    soil.scale.set(w * 0.7, 0.4, d * 0.7);
    soil.position.y = top + 0.2;
    g.add(soil);
    for (let i = 0; i < 5; i += 1) {
      const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9 + r(i) * 0.6, 0), std(0x3f7a33, 0.9, 0, { flatShading: true }));
      bush.position.set((r(i + 9) - 0.5) * w * 0.55, top + 1.0, (r(i + 19) - 0.5) * d * 0.55);
      g.add(bush);
    }
    const pergola = new THREE.Mesh(BOX_GEO, std(0x7a5a3a, 0.9));
    pergola.scale.set(w * 0.3, 0.15, d * 0.2);
    pergola.position.set(-w * 0.15, top + 2.6, d * 0.2);
    g.add(pergola);
  } else if (kit === "antenna") {
    for (let i = 0; i < 3; i += 1) {
      const hgt = 6 + r(i) * 8;
      const mast = new THREE.Mesh(CYL(0.08, 0.14, hgt, 6), std(0x30343a, 0.6, 0.4));
      mast.position.set((r(i + 3) - 0.5) * w * 0.5, top + hgt / 2, (r(i + 7) - 0.5) * d * 0.5);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 4), std(0xff3a2a, 0.5, 0, { emissive: 0xff2010, emissiveIntensity: 1.5 }));
      tip.position.set(mast.position.x, top + hgt, mast.position.z);
      g.add(mast, tip);
    }
  } else {
    const acMat = std(0x9a9ea3, 0.8, 0.2);
    for (const [ox, oz] of [[-w * 0.2, d * 0.15], [w * 0.22, -d * 0.18]]) {
      const ac = new THREE.Mesh(BOX_GEO, acMat);
      ac.scale.set(w * 0.22, 1.1, d * 0.2);
      ac.position.set(ox, top + 0.55, oz);
      ac.castShadow = true;
      g.add(ac);
    }
  }
}

const TOWER_FACES = [
  { ax: "z", n: 1 },
  { ax: "z", n: -1 },
  { ax: "x", n: 1 },
  { ax: "x", n: -1 },
];

function addTower(scene, prop) {
  const g = new THREE.Group();
  const w = prop.sx;
  const h = prop.sy;
  const d = prop.sz;
  const office = prop.kind === "office";
  const style = prop.style || (office ? "bands" : "grid");
  const base = new THREE.Color(prop.color || 0x8b93a1);
  const glassMat = new THREE.MeshStandardMaterial({
    color: office ? 0x3f5a72 : 0x4a5866,
    roughness: 0.14,
    metalness: 0.55,
    emissive: office ? 0x1f3e5e : 0x263340,
    emissiveIntensity: 0.28,
  });
  const solid = (bw, bh, bd, y0, material) => {
    const body = new THREE.Mesh(BOX_GEO, material);
    body.scale.set(bw, bh, bd);
    body.position.y = y0 + bh / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);
    return body;
  };
  const wallMat = std(base.getHex(), office ? 0.5 : 0.88, office ? 0.25 : 0.04);
  let top = h;
  let topW = w;
  let topD = d;

  if (style === "curtain") {
    const curtain = std(base.getHex(), 0.08, 0.75, { emissive: 0x0e1c2a, emissiveIntensity: 0.4 });
    solid(w, h, d, 0, curtain);
    towerCurtain(g, w, h, d, 0);
  } else if (style === "setback" || style === "deco") {
    // Three tiers, each stepping in; deco adds piers and a stepped crown + spire.
    const tiers = [
      [1, 0.58],
      [0.8, 0.26],
      [0.6, 0.16],
    ];
    let y = 0;
    for (const [k, frac] of tiers) {
      const tw = w * k;
      const td = d * k;
      const th = h * frac;
      solid(tw, th, td, y, wallMat);
      if (style === "deco") towerDecoPiers(g, tw, th, td, y, base);
      else towerBands(g, tw, th, td, y, base, office, glassMat);
      // Ledge at each step.
      const ledge = new THREE.Mesh(BOX_GEO, std(base.clone().offsetHSL(0, 0, -0.1).getHex(), 0.8));
      ledge.scale.set(tw + 0.5, 0.35, td + 0.5);
      ledge.position.y = y + th;
      g.add(ledge);
      y += th;
      topW = tw;
      topD = td;
    }
    top = y;
    if (style === "deco") {
      const crownMat = std(base.clone().offsetHSL(0, 0, 0.1).getHex(), 0.6, 0.2);
      for (let i = 0; i < 3; i += 1) {
        const k = 0.5 - i * 0.14;
        const c = solid(w * k, 1.6, d * k, top + i * 1.6, crownMat);
        c.castShadow = false;
      }
      const spire = new THREE.Mesh(new THREE.ConeGeometry(0.6, 9, 8), std(0xc9b27a, 0.3, 0.7));
      spire.position.y = top + 4.8 + 4.5;
      g.add(spire);
    }
  } else {
    solid(w, h, d, 0, wallMat);
    if (style === "grid") towerGrid(g, w, h, d, 0, base, glassMat);
    else towerBands(g, w, h, d, 0, base, office, glassMat);
    // Corner pilasters.
    const edgeMat = std(base.clone().offsetHSL(0, 0, -0.14).getHex(), 0.75, 0.15);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const edge = new THREE.Mesh(BOX_GEO, edgeMat);
        edge.scale.set(0.6, h, 0.6);
        edge.position.set(sx * (w / 2 - 0.2), h / 2, sz * (d / 2 - 0.2));
        g.add(edge);
      }
    }
  }

  // Parapet + rooftop kit.
  const roofMat = std(base.clone().offsetHSL(0, 0, -0.08).getHex(), 0.8);
  for (const f of TOWER_FACES) {
    const rail = new THREE.Mesh(BOX_GEO, roofMat);
    if (f.ax === "z") {
      rail.scale.set(topW + 0.2, 0.7, 0.3);
      rail.position.set(0, top + 0.35, f.n * (topD / 2));
    } else {
      rail.scale.set(0.3, 0.7, topD + 0.2);
      rail.position.set(f.n * (topW / 2), top + 0.35, 0);
    }
    g.add(rail);
  }
  if (style !== "deco") towerRoofKit(g, prop.roofKit || "plant", topW, topD, top, prop.id || "t");

  // The tower mass sits on top of the enterable lobby (prop.py); lift the whole
  // facade group so window bands / rooftop align with the mass, not the ground.
  g.position.set(prop.x, prop.py || 0, prop.z);
  scene.add(g);
}

// ---------------------------------------------------------------------------
// Supertall (Burj Khalifa style): Y-shaped plan — a hexagonal core with three
// wings 120° apart. Each tier steps back; the shortest wing spirals round as
// it climbs. Silver glass with vertical mullion fins, a spire with aviation
// lights on top.
// ---------------------------------------------------------------------------

let supertallMats = null;
function getSupertallMats() {
  if (supertallMats) return supertallMats;
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#9fb4c8";
  ctx.fillRect(0, 0, 64, 256);
  for (let y = 0; y < 256; y += 8) {
    // Floor bands: darker spandrel + lit/unlit window rows.
    ctx.fillStyle = "#6f8396";
    ctx.fillRect(0, y, 64, 2);
    ctx.fillStyle = Math.random() < 0.18 ? "#e8e2c8" : "#8ea5bb";
    ctx.fillRect(0, y + 2, 64, 6);
  }
  ctx.fillStyle = "#dfe6ec"; // vertical mullion fins
  for (let x = 0; x < 64; x += 8) ctx.fillRect(x, 0, 2, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  supertallMats = {
    glass: new THREE.MeshStandardMaterial({ map: tex, color: 0xffffff, roughness: 0.18, metalness: 0.62, emissive: 0x1a2a3a, emissiveIntensity: 0.25 }),
    steel: std(0xd5dbe0, 0.3, 0.8),
    dark: std(0x59626b, 0.6, 0.4),
    beacon: new THREE.MeshStandardMaterial({ color: 0xff2a2a, emissive: 0xff1a1a, emissiveIntensity: 2.2 }),
  };
  return supertallMats;
}

function glassBox(g, mats, w, h, d, x, y, z, ry = 0) {
  const geo = new THREE.BoxGeometry(w, h, d);
  // Scale UVs so the floor bands keep a real-world size (~3.3m per floor).
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * Math.max(w, d) / 10, uv.getY(i) * h / 33);
  const m = new THREE.Mesh(geo, mats.glass);
  m.position.set(x, y, z);
  m.rotation.y = ry;
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

function addSupertallTier(scene, prop) {
  const mats = getSupertallMats();
  const g = new THREE.Group();
  g.position.set(prop.x, prop.py || 0, prop.z);
  const h = prop.sy;
  const reach = prop.reach || prop.sx / 2;
  const core = reach * 0.42;
  const coreMesh = new THREE.Mesh(CYL(core, core, h, 6), mats.glass);
  coreMesh.position.y = h / 2;
  coreMesh.castShadow = true;
  g.add(coreMesh);
  const wingW = Math.max(3, reach * 0.62);
  for (let k = 0; k < 3; k += 1) {
    const a = (k / 3) * Math.PI * 2 + Math.PI / 2;
    // One wing per tier is set back further — it rotates as the tower climbs.
    const short = k === (prop.tier || 0) % 3;
    const len = reach * (short ? 0.72 : 1);
    const mid = len / 2;
    glassBox(g, mats, wingW, short ? h * 0.92 : h, len, Math.cos(a) * mid, short ? h * 0.46 : h / 2, Math.sin(a) * mid, -a + Math.PI / 2);
    // Rounded wing nose + a steel fin running up its centerline.
    const nose = new THREE.Mesh(CYL(wingW / 2, wingW / 2, short ? h * 0.92 : h, 12), mats.glass);
    nose.position.set(Math.cos(a) * len, short ? h * 0.46 : h / 2, Math.sin(a) * len);
    g.add(nose);
    const fin = new THREE.Mesh(BOX_GEO, mats.steel);
    fin.scale.set(0.35, h, 0.6);
    fin.position.set(Math.cos(a) * (len + wingW / 2), h / 2, Math.sin(a) * (len + wingW / 2));
    fin.rotation.y = Math.PI / 2 - a;
    g.add(fin);
  }
  // Mechanical floor band at the tier joint.
  const band = new THREE.Mesh(CYL(core * 1.04, core * 1.04, 1.2, 6), mats.dark);
  band.position.y = h - 0.6;
  g.add(band);
  scene.add(g);
}

function addSpire(scene, prop) {
  const mats = getSupertallMats();
  const g = new THREE.Group();
  g.position.set(prop.x, prop.py || 0, prop.z);
  const h = prop.sy;
  // Stepped needle: three tapering stages, then the mast.
  let y = 0;
  for (const [r0, r1, len] of [[2.4, 1.6, h * 0.28], [1.5, 0.9, h * 0.3], [0.8, 0.35, h * 0.24]]) {
    const seg = new THREE.Mesh(CYL(r1, r0, len, 6), mats.steel);
    seg.position.y = y + len / 2;
    seg.castShadow = true;
    g.add(seg);
    y += len;
  }
  const mast = new THREE.Mesh(CYL(0.08, 0.3, h * 0.18, 6), mats.steel);
  mast.position.y = y + h * 0.09;
  g.add(mast);
  // Aviation warning lights up the needle.
  for (const fy of [0.25, 0.55, 0.82, 1.0]) {
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 6), mats.beacon);
    beacon.position.y = h * fy;
    g.add(beacon);
  }
  scene.add(g);
}

// Storefront: body + glass front + striped awning + sign on the `face` side.
function addShop(scene, prop) {
  const g = new THREE.Group();
  const w = prop.sx;
  const h = prop.sy;
  const d = prop.sz;
  const body = new THREE.Mesh(BOX_GEO, std(prop.color || 0xb8a98c, 0.85));
  body.scale.set(w, h, d);
  body.position.y = h / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  // Parapet lip.
  const lip = new THREE.Mesh(BOX_GEO, std(new THREE.Color(prop.color || 0xb8a98c).offsetHSL(0, 0, -0.12).getHex(), 0.85));
  lip.scale.set(w + 0.3, 0.5, d + 0.3);
  lip.position.y = h + 0.1;
  g.add(lip);

  const front = new THREE.Group();
  // Storefront glass.
  const glass = new THREE.Mesh(BOX_GEO, std(0x9fc8e8, 0.1, 0.4, { transparent: true, opacity: 0.4 }));
  glass.scale.set(w * 0.82, 2.4, 0.2);
  glass.position.set(0, 1.3, d / 2 + 0.06);
  front.add(glass);
  // Door.
  const door = new THREE.Mesh(BOX_GEO, std(0x2b2f36, 0.4, 0.3));
  door.scale.set(w * 0.2, 2.3, 0.16);
  door.position.set(w * 0.28, 1.15, d / 2 + 0.1);
  front.add(door);
  // Striped awning.
  const awning = new THREE.Mesh(BOX_GEO, std(prop.sign || 0xcf5b48, 0.85));
  awning.scale.set(w * 0.9, 0.16, 1.6);
  awning.position.set(0, 2.85, d / 2 + 0.7);
  awning.rotation.x = 0.18;
  front.add(awning);
  // Sign board.
  const sign = new THREE.Mesh(BOX_GEO, new THREE.MeshStandardMaterial({ color: prop.sign || 0xcf5b48, emissive: prop.sign || 0xcf5b48, emissiveIntensity: 0.3, roughness: 0.6 }));
  sign.scale.set(w * 0.8, 0.8, 0.15);
  sign.position.set(0, h - 0.6, d / 2 + 0.12);
  front.add(sign);
  front.rotation.y = prop.face || 0;
  g.add(front);

  g.position.set(prop.x, 0, prop.z);
  scene.add(g);
}

// Shared wheel helper for street vehicles.
function addWheels(group, positions, r = 0.4) {
  const tireGeo = CYL(r, r, 0.32, 12);
  tireGeo.rotateZ(Math.PI / 2);
  const tireMat = std(0x14161a, 0.85, 0.05);
  for (const [x, y, z] of positions) {
    const wheel = new THREE.Mesh(tireGeo, tireMat);
    wheel.position.set(x, y, z);
    wheel.castShadow = true;
    group.add(wheel);
  }
}

// Static bus (long axis local x; rotate for alongZ).
function addBus(scene, prop) {
  const g = new THREE.Group();
  const len = prop.alongZ ? prop.sz : prop.sx;
  const wide = prop.alongZ ? prop.sx : prop.sz;
  const body = new THREE.Mesh(BOX_GEO, std(prop.color || 0x2f6f9f, 0.5, 0.3));
  body.scale.set(len, 2.4, wide);
  body.position.y = 1.5;
  body.castShadow = true;
  g.add(body);
  const roof = new THREE.Mesh(BOX_GEO, std(new THREE.Color(prop.color || 0x2f6f9f).offsetHSL(0, 0, 0.08).getHex(), 0.5));
  roof.scale.set(len * 0.98, 0.3, wide * 0.94);
  roof.position.y = 2.8;
  g.add(roof);
  // Window band both sides.
  const winMat = std(0x27333f, 0.15, 0.5, { transparent: true, opacity: 0.7 });
  for (const s of [-1, 1]) {
    const win = new THREE.Mesh(BOX_GEO, winMat);
    win.scale.set(len * 0.86, 0.9, 0.06);
    win.position.set(0, 1.9, s * (wide / 2 + 0.02));
    g.add(win);
  }
  // Windshield + destination sign.
  const wsMat = std(0x2b3946, 0.12, 0.5, { transparent: true, opacity: 0.65 });
  const ws = new THREE.Mesh(BOX_GEO, wsMat);
  ws.scale.set(0.08, 1.0, wide * 0.85);
  ws.position.set(-len / 2 + 0.1, 1.9, 0);
  g.add(ws);
  const dest = new THREE.Mesh(BOX_GEO, new THREE.MeshStandardMaterial({ color: 0x2a2f1a, emissive: 0xd8a828, emissiveIntensity: 0.5 }));
  dest.scale.set(0.06, 0.4, wide * 0.6);
  dest.position.set(-len / 2 + 0.05, 2.55, 0);
  g.add(dest);
  addWheels(g, [
    [-len * 0.32, 0.42, wide / 2 - 0.1],
    [-len * 0.32, 0.42, -wide / 2 + 0.1],
    [len * 0.34, 0.42, wide / 2 - 0.1],
    [len * 0.34, 0.42, -wide / 2 + 0.1],
  ]);
  g.position.set(prop.x, 0, prop.z);
  if (prop.alongZ) g.rotation.y = Math.PI / 2;
  scene.add(g);
}

// Static box truck (cab + trailer).
function addTruck(scene, prop) {
  const g = new THREE.Group();
  const len = prop.alongZ ? prop.sz : prop.sx;
  const wide = prop.alongZ ? prop.sx : prop.sz;
  const cabLen = len * 0.3;
  const cab = new THREE.Mesh(BOX_GEO, std(prop.color || 0x8a4a3a, 0.55, 0.25));
  cab.scale.set(cabLen, 2.3, wide);
  cab.position.set(-len / 2 + cabLen / 2, 1.35, 0);
  cab.castShadow = true;
  g.add(cab);
  const cabWin = new THREE.Mesh(BOX_GEO, std(0x27333f, 0.15, 0.5, { transparent: true, opacity: 0.7 }));
  cabWin.scale.set(0.08, 0.8, wide * 0.85);
  cabWin.position.set(-len / 2 + 0.06, 1.9, 0);
  g.add(cabWin);
  const box = new THREE.Mesh(BOX_GEO, std(0xd7d2c8, 0.8));
  box.scale.set(len * 0.68, 2.9, wide);
  box.position.set(len * 0.15, 1.75, 0);
  box.castShadow = true;
  g.add(box);
  addWheels(g, [
    [-len * 0.36, 0.42, wide / 2 - 0.05],
    [-len * 0.36, 0.42, -wide / 2 + 0.05],
    [len * 0.2, 0.42, wide / 2 - 0.05],
    [len * 0.2, 0.42, -wide / 2 + 0.05],
    [len * 0.36, 0.42, wide / 2 - 0.05],
    [len * 0.36, 0.42, -wide / 2 + 0.05],
  ]);
  g.position.set(prop.x, 0, prop.z);
  if (prop.alongZ) g.rotation.y = Math.PI / 2;
  scene.add(g);
}

// Static parked car (simple sedan silhouette).
function addParkedCar(scene, prop) {
  const g = new THREE.Group();
  const len = prop.alongZ ? prop.sz : prop.sx;
  const wide = prop.alongZ ? prop.sx : prop.sz;
  const paint = std(prop.color || 0x555a63, 0.4, 0.5);
  const lower = new THREE.Mesh(BOX_GEO, paint);
  lower.scale.set(len, 0.7, wide);
  lower.position.y = 0.7;
  lower.castShadow = true;
  g.add(lower);
  const cabin = new THREE.Mesh(BOX_GEO, paint);
  cabin.scale.set(len * 0.55, 0.6, wide * 0.9);
  cabin.position.set(-len * 0.05, 1.25, 0);
  g.add(cabin);
  const glass = new THREE.Mesh(BOX_GEO, std(0x2b3946, 0.12, 0.5, { transparent: true, opacity: 0.6 }));
  glass.scale.set(len * 0.5, 0.5, wide * 0.82);
  glass.position.set(-len * 0.05, 1.3, 0);
  g.add(glass);
  addWheels(g, [
    [-len * 0.3, 0.34, wide / 2 - 0.02],
    [-len * 0.3, 0.34, -wide / 2 + 0.02],
    [len * 0.3, 0.34, wide / 2 - 0.02],
    [len * 0.3, 0.34, -wide / 2 + 0.02],
  ], 0.34);
  g.position.set(prop.x, 0, prop.z);
  if (prop.alongZ) g.rotation.y = Math.PI / 2;
  scene.add(g);
}

function addTrafficLight(scene, prop) {
  const g = new THREE.Group();
  const poleMat = std(0x26292d, 0.6, 0.4);
  const pole = new THREE.Mesh(CYL(0.12, 0.15, prop.sy, 8), poleMat);
  pole.position.y = prop.sy / 2;
  pole.castShadow = true;
  g.add(pole);
  const arm = new THREE.Mesh(BOX_GEO, poleMat);
  arm.scale.set(0.12, 0.12, 2.4);
  arm.position.set(0, prop.sy - 0.2, 1.2);
  g.add(arm);
  const housing = new THREE.Mesh(BOX_GEO, std(0x18191c, 0.7));
  housing.scale.set(0.4, 1.1, 0.4);
  housing.position.set(0, prop.sy - 0.6, 2.3);
  g.add(housing);
  const lights = [
    [0.5, 0xff3b30, 0.45],
    [0.0, 0xffb02a, 0.15],
    [-0.5, 0x37d24a, 0.7],
  ];
  for (const [oy, col, emi] of lights) {
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: emi, roughness: 0.4 }));
    lens.position.set(0, prop.sy - 0.6 + oy, 2.51);
    g.add(lens);
  }
  g.position.set(prop.x, 0, prop.z);
  g.rotation.y = prop.face || 0;
  scene.add(g);
}

function addRoadSign(scene, prop) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(CYL(0.06, 0.06, prop.sy, 6), std(0x9aa0a6, 0.5, 0.5));
  pole.position.y = prop.sy / 2;
  g.add(pole);
  const kind = prop.kind || "warn";
  let board;
  if (kind === "stop") {
    board = new THREE.Mesh(CYL(0.5, 0.5, 0.08, 8), new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.6 }));
    board.rotation.x = Math.PI / 2;
  } else {
    board = new THREE.Mesh(BOX_GEO, new THREE.MeshStandardMaterial({ color: 0xe8b924, roughness: 0.6 }));
    board.scale.set(0.9, 0.9, 0.08);
    board.rotation.z = Math.PI / 4;
  }
  board.position.set(0, prop.sy + 0.1, 0.05);
  g.add(board);
  g.position.set(prop.x, 0, prop.z);
  g.rotation.y = prop.face || 0;
  scene.add(g);
}

function addBillboardPanel(scene, prop) {
  const g = new THREE.Group();
  const frame = new THREE.Mesh(BOX_GEO, std(0x2b2e31, 0.7, 0.2));
  const adMat = new THREE.MeshStandardMaterial({ color: prop.color || 0x2b6cb0, emissive: prop.color || 0x2b6cb0, emissiveIntensity: 0.25, roughness: 0.7 });
  const ad = new THREE.Mesh(BOX_GEO, adMat);
  if (prop.alongZ) {
    frame.scale.set(prop.sx + 0.3, prop.sy + 0.3, prop.sz + 0.05);
    ad.scale.set(prop.sx + 0.05, prop.sy, prop.sz * 0.7);
  } else {
    frame.scale.set(prop.sx + 0.3, prop.sy + 0.3, prop.sz + 0.05);
    ad.scale.set(prop.sx * 0.96, prop.sy * 0.9, prop.sz + 0.06);
  }
  g.add(frame);
  g.add(ad);
  g.position.set(prop.x, (prop.py || 0) + prop.sy / 2, prop.z);
  scene.add(g);
}

function addBusStop(scene, prop) {
  const g = new THREE.Group();
  const metal = std(0x39424e, 0.5, 0.4);
  const glassMat = std(0xbfe3ff, 0.1, 0.3, { transparent: true, opacity: 0.3, side: THREE.DoubleSide });
  // Back glass panel + two posts + roof + bench (built facing +z).
  const back = new THREE.Mesh(BOX_GEO, glassMat);
  back.scale.set(4.4, 2.3, 0.08);
  back.position.set(0, 1.2, -0.8);
  g.add(back);
  for (const sx of [-2.1, 2.1]) {
    const post = new THREE.Mesh(CYL(0.07, 0.07, 2.6, 6), metal);
    post.position.set(sx, 1.3, 0.8);
    g.add(post);
    const postB = new THREE.Mesh(CYL(0.07, 0.07, 2.6, 6), metal);
    postB.position.set(sx, 1.3, -0.8);
    g.add(postB);
  }
  const roof = new THREE.Mesh(BOX_GEO, std(0x2f3742, 0.6, 0.3));
  roof.scale.set(4.8, 0.16, 2.0);
  roof.position.set(0, 2.6, 0);
  roof.castShadow = true;
  g.add(roof);
  const bench = new THREE.Mesh(BOX_GEO, std(0x5a6068, 0.7));
  bench.scale.set(3.4, 0.14, 0.5);
  bench.position.set(0, 0.55, -0.5);
  g.add(bench);
  const signPost = new THREE.Mesh(BOX_GEO, new THREE.MeshStandardMaterial({ color: 0x2f6f9f, emissive: 0x2f6f9f, emissiveIntensity: 0.3 }));
  signPost.scale.set(0.7, 0.5, 0.1);
  signPost.position.set(2.6, 2.3, 0.8);
  g.add(signPost);
  g.position.set(prop.x, 0, prop.z);
  g.rotation.y = prop.face || 0;
  scene.add(g);
}

function addTrashBin(scene, prop) {
  const g = new THREE.Group();
  const can = new THREE.Mesh(CYL(prop.sx * 0.42, prop.sx * 0.38, prop.sy * 0.85, 10), std(prop.color || 0x2f6f4f, 0.7, 0.2));
  can.position.y = prop.sy * 0.42;
  can.castShadow = true;
  g.add(can);
  const lid = new THREE.Mesh(CYL(prop.sx * 0.46, prop.sx * 0.44, prop.sy * 0.15, 10), std(0x22252a, 0.6));
  lid.position.y = prop.sy * 0.9;
  g.add(lid);
  g.position.set(prop.x, 0, prop.z);
  scene.add(g);
}

function addHydrant(scene, prop) {
  const g = new THREE.Group();
  const mat = std(prop.color || 0xd23b2f, 0.6, 0.25);
  const body = new THREE.Mesh(CYL(0.16, 0.2, prop.sy * 0.7, 8), mat);
  body.position.y = prop.sy * 0.35;
  body.castShadow = true;
  g.add(body);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), mat);
  cap.position.y = prop.sy * 0.72;
  g.add(cap);
  for (const sx of [-1, 1]) {
    const nozzle = new THREE.Mesh(CYL(0.06, 0.06, 0.18, 6), mat);
    nozzle.rotation.z = Math.PI / 2;
    nozzle.position.set(sx * 0.2, prop.sy * 0.45, 0);
    g.add(nozzle);
  }
  g.position.set(prop.x, 0, prop.z);
  scene.add(g);
}

function addCone(scene, prop) {
  const g = new THREE.Group();
  const mat = std(prop.color || 0xe8721c, 0.7);
  const cone = new THREE.Mesh(new THREE.ConeGeometry(prop.sx * 0.36, prop.sy * 0.85, 10), mat);
  cone.position.y = prop.sy * 0.45;
  g.add(cone);
  const stripe = new THREE.Mesh(CYL(prop.sx * 0.26, prop.sx * 0.3, 0.12, 10), std(0xf0f0f0, 0.7));
  stripe.position.y = prop.sy * 0.45;
  g.add(stripe);
  const foot = new THREE.Mesh(BOX_GEO, mat);
  foot.scale.set(prop.sx * 0.8, 0.08, prop.sz * 0.8);
  foot.position.y = 0.04;
  g.add(foot);
  g.position.set(prop.x, 0, prop.z);
  scene.add(g);
}

function addPlanter(scene, prop) {
  const g = new THREE.Group();
  const box2 = new THREE.Mesh(BOX_GEO, std(prop.color || 0x6b5a44, 0.9));
  box2.scale.set(prop.sx, prop.sy * 0.6, prop.sz);
  box2.position.y = prop.sy * 0.3;
  box2.castShadow = true;
  g.add(box2);
  for (let i = 0; i < 3; i += 1) {
    const shrub = new THREE.Mesh(new THREE.SphereGeometry(prop.sx * 0.32, 6, 5), std(0x3c6b2e, 0.95, 0, { flatShading: true }));
    shrub.position.set((Math.random() - 0.5) * prop.sx * 0.5, prop.sy * 0.7 + Math.random() * 0.2, (Math.random() - 0.5) * prop.sz * 0.5);
    g.add(shrub);
  }
  g.position.set(prop.x, 0, prop.z);
  scene.add(g);
}

// Crashed airliner sections.
function addPlaneFuselage(scene, prop) {
  const g = new THREE.Group();
  const len = prop.alongZ ? prop.sz : prop.sx;
  const r = Math.min(prop.sy, prop.alongZ ? prop.sx : prop.sz) * 0.5;
  const hull = new THREE.Mesh(CYL(r, r, len, 16), std(prop.color || 0xdfe3e8, 0.55, 0.25));
  hull.rotation.z = Math.PI / 2;
  hull.position.y = r + 0.2;
  hull.castShadow = true;
  g.add(hull);
  // Window row.
  const winMat = new THREE.MeshStandardMaterial({ color: 0x1c2733, roughness: 0.2, metalness: 0.4 });
  const winCount = Math.floor(len / 1.4);
  for (let i = 0; i < winCount; i += 1) {
    for (const s of [-1, 1]) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.28, 0.1), winMat);
      win.position.set(-len / 2 + 0.7 + i * 1.4, r + 0.5, s * r * 0.92);
      g.add(win);
    }
  }
  if (prop.section === "front") {
    // Cockpit windows + nose.
    const nose = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), std(0xdfe3e8, 0.55, 0.25));
    nose.scale.set(0.7, 1, 1);
    nose.position.set(-len / 2, r + 0.2, 0);
    g.add(nose);
    const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, r * 1.3), std(0x2b3946, 0.15, 0.5));
    cockpit.position.set(-len / 2 + 0.7, r + 0.7, 0);
    g.add(cockpit);
  } else {
    // Torn rear opening.
    const tear = new THREE.Mesh(CYL(r * 0.92, r * 0.6, 0.6, 12), std(0x2a2d31, 0.8));
    tear.rotation.z = Math.PI / 2;
    tear.position.set(len / 2, r + 0.2, 0);
    g.add(tear);
  }
  g.position.set(prop.x, prop.py || 0, prop.z);
  if (prop.alongZ) g.rotation.y = Math.PI / 2;
  if (prop.tilt) g.rotation.z = prop.tilt;
  scene.add(g);
}

function addPlaneWing(scene, prop) {
  const wing = new THREE.Mesh(BOX_GEO, std(prop.color || 0xc8ced4, 0.55, 0.25));
  wing.scale.set(prop.sx, prop.sy, prop.sz);
  wing.position.set(prop.x, (prop.py || 0) + prop.sy / 2, prop.z);
  wing.rotation.y = 0.12;
  wing.castShadow = true;
  scene.add(wing);
}

function addPlaneTail(scene, prop) {
  const g = new THREE.Group();
  const fin = new THREE.Mesh(BOX_GEO, std(prop.color || 0xc45a44, 0.6, 0.2));
  fin.scale.set(prop.sx, prop.sy, prop.sz * 0.4);
  fin.position.y = prop.sy / 2;
  fin.rotation.x = 0.2;
  fin.castShadow = true;
  g.add(fin);
  const stab = new THREE.Mesh(BOX_GEO, std(0xc8ced4, 0.55, 0.25));
  stab.scale.set(prop.sx * 0.8, 0.4, prop.sz * 1.8);
  stab.position.y = prop.sy * 0.35;
  g.add(stab);
  g.position.set(prop.x, prop.py || 0, prop.z);
  scene.add(g);
}

function addSimpleColumn(scene, prop, mat, seg = 6) {
  const c = new THREE.Mesh(CYL(prop.sx * 0.5, prop.sx * 0.5, prop.sy, seg), mat);
  c.position.set(prop.x, (prop.py || 0) + prop.sy / 2, prop.z);
  c.castShadow = true;
  scene.add(c);
  return c;
}

function addPlayground(scene, prop) {
  if (prop.type === "slide") {
    const g = new THREE.Group();
    const mat = std(prop.color || 0xd94f4f, 0.7);
    const platform = new THREE.Mesh(BOX_GEO, mat);
    platform.scale.set(prop.sx, 0.2, prop.sx);
    platform.position.set(0, prop.sy - 0.3, prop.sz / 2 - prop.sx / 2);
    g.add(platform);
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(CYL(0.08, 0.08, prop.sy, 6), std(0x7a8088, 0.6, 0.3));
      leg.position.set(sx * prop.sx * 0.35, (prop.sy) / 2, prop.sz / 2 - prop.sx / 2);
      g.add(leg);
    }
    const slope = new THREE.Mesh(BOX_GEO, std(0xf0d040, 0.5, 0.3));
    slope.scale.set(prop.sx * 0.7, 0.12, prop.sz);
    slope.position.set(0, prop.sy * 0.5, 0);
    slope.rotation.x = -0.6;
    g.add(slope);
    g.position.set(prop.x, 0, prop.z);
    scene.add(g);
    return;
  }
  if (prop.type === "roundabout") {
    const g = new THREE.Group();
    const disc = new THREE.Mesh(CYL(prop.sx * 0.5, prop.sx * 0.5, 0.3, 14), std(prop.color || 0x3f7f9f, 0.6, 0.3));
    disc.position.y = 0.9;
    g.add(disc);
    const center = new THREE.Mesh(CYL(0.1, 0.1, 1.0, 6), std(0x7a8088, 0.5, 0.4));
    center.position.y = 0.9;
    g.add(center);
    for (let i = 0; i < 4; i += 1) {
      const bar = new THREE.Mesh(BOX_GEO, std(0xf0c040, 0.6));
      bar.scale.set(prop.sx * 0.9, 0.08, 0.08);
      bar.position.y = 1.3;
      bar.rotation.y = (i * Math.PI) / 4;
      g.add(bar);
    }
    g.position.set(prop.x, 0, prop.z);
    scene.add(g);
    return;
  }
  // fountain
  const g = new THREE.Group();
  const basin = new THREE.Mesh(CYL(prop.sx * 0.5, prop.sx * 0.5, prop.sy, 16), std(prop.color || 0x8f96a0, 0.8));
  basin.position.y = prop.sy / 2;
  g.add(basin);
  const water = new THREE.Mesh(CYL(prop.sx * 0.44, prop.sx * 0.44, 0.1, 16), std(0x3f7fa8, 0.1, 0.3, { transparent: true, opacity: 0.8 }));
  water.position.y = prop.sy * 0.9;
  water.userData.water = true;
  g.add(water);
  const spout = new THREE.Mesh(CYL(0.15, 0.2, prop.sy * 1.2, 8), std(0x8f96a0, 0.8));
  spout.position.y = prop.sy * 1.1;
  g.add(spout);
  g.position.set(prop.x, 0, prop.z);
  scene.add(g);
}

/**
 * Building props render into their own holder group inside a per-building
 * group pivoted at the building's base, so the destruction view can hide a
 * knocked-out panel, or lean / topple the whole structure. Holders are
 * offset by -center so the builders below can keep using world coordinates.
 */
function propHolder(scene, prop) {
  const ud = scene.userData;
  ud.propDefs = ud.propDefs || new Map();
  ud.propMeshes = ud.propMeshes || new Map();
  ud.buildingGroups = ud.buildingGroups || new Map();
  ud.propDefs.set(prop.id, prop);
  let bg = ud.buildingGroups.get(prop.buildingId);
  if (!bg) {
    const def = ud.buildingDefs?.get(prop.buildingId) || { id: prop.buildingId, x: 0, z: 0, w: 10, d: 10, h: 4 };
    bg = new THREE.Group();
    bg.name = `building-${prop.buildingId}`;
    bg.position.set(def.x, 0, def.z);
    bg.userData.def = def;
    scene.add(bg);
    ud.buildingGroups.set(prop.buildingId, bg);
  }
  const holder = new THREE.Group();
  holder.position.set(-bg.position.x, 0, -bg.position.z);
  holder.userData.propId = prop.id;
  bg.add(holder);
  ud.propMeshes.set(prop.id, holder);
  return holder;
}

export function addProp(scene, prop) {
  if (prop.buildingId && scene.isScene) {
    addPropTo(propHolder(scene, prop), prop);
    return;
  }
  addPropTo(scene, prop);
}

function addPropTo(scene, prop) {
  switch (prop.type) {
    case "tree":
      addTree(scene, prop);
      return;
    case "hiproof":
      addHipRoof(scene, prop);
      return;
    case "pagoda":
      addPagoda(scene, prop);
      return;
    case "torii":
      addTorii(scene, prop);
      return;
    case "toriipost":
      return; // collision only — the torii draws its own posts
    case "stonelantern":
      addStoneLantern(scene, prop);
      return;
    case "cliff":
    case "cavewall":
    case "caveroof":
      addRockMass(scene, prop);
      return;
    case "crystal":
      addCrystal(scene, prop);
      return;
    case "waterfall":
      addWaterfall(scene, prop);
      return;
    case "haystack":
    case "well":
    case "cart":
    case "woodpile":
    case "scarecrow":
    case "campfire":
      addFarmProp(scene, prop);
      return;
    case "bush":
      addBush(scene, prop);
      return;
    case "rock":
    case "mountain":
      if (prop.type === "mountain") {
        // Jagged ridge-y peak: a many-sided cone with noisy radius per ring,
        // forested lower slopes, bare rock above, snow on the tall ones.
        const R = Math.max(prop.sx, prop.sz) * 0.62;
        const geo = new THREE.ConeGeometry(R, prop.sy, 11, 6);
        const pos = geo.attributes.position;
        const seed = prop.x * 0.013 + prop.z * 0.029;
        for (let i = 0; i < pos.count; i += 1) {
          const x = pos.getX(i);
          const y = pos.getY(i);
          const z = pos.getZ(i);
          const a = Math.atan2(z, x);
          const k = 1 + 0.22 * Math.sin(a * 3 + seed) + 0.12 * Math.sin(a * 7 + seed * 3) + 0.08 * Math.sin(y * 0.05 + seed);
          pos.setXYZ(i, x * k, y + (Math.abs(x) + Math.abs(z) > 1 ? Math.sin(a * 5 + seed) * prop.sy * 0.03 : 0), z * k);
        }
        geo.computeVertexNormals();
        const rot = (prop.x * 13.37) % Math.PI;
        const sz = prop.sz / Math.max(prop.sx, prop.sz);
        const m = new THREE.Mesh(geo, surf(std(prop.color || 0x5c6068, 0.95, 0, { flatShading: true }), "rock"));
        m.position.set(prop.x, prop.sy * 0.48, prop.z);
        m.scale.z = sz;
        m.rotation.y = rot;
        scene.add(m);
        const skirt = new THREE.Mesh(
          new THREE.ConeGeometry(R * 1.08, prop.sy * 0.36, 11),
          surf(std(0x34482c, 1, 0, { flatShading: true }), "foliage"),
        );
        skirt.position.set(prop.x, prop.sy * 0.17, prop.z);
        skirt.scale.z = sz;
        skirt.rotation.y = rot + 0.3;
        scene.add(skirt);
        if (prop.sy > 180) {
          const cap = new THREE.Mesh(
            new THREE.ConeGeometry(R * 0.3, prop.sy * 0.3, 11),
            std(0xeef1f5, 0.9, 0, { flatShading: true }),
          );
          cap.position.set(prop.x, prop.sy * 0.84, prop.z);
          cap.scale.z = sz;
          cap.rotation.y = rot;
          scene.add(cap);
        }
      } else {
        addRock(scene, prop);
      }
      return;
    case "streetlight":
      addStreetlight(scene, prop);
      return;
    case "bench":
      addBench(scene, prop);
      return;
    case "fence":
      addFence(scene, prop);
      return;
    case "lamp":
      addLampProp(scene, prop);
      return;
    case "supertall":
      addSupertallTier(scene, prop);
      return;
    case "spire":
      addSpire(scene, prop);
      return;
    case "tower":
      addTower(scene, prop);
      return;
    case "shop":
      addShop(scene, prop);
      return;
    case "bus":
      addBus(scene, prop);
      return;
    case "truck":
      addTruck(scene, prop);
      return;
    case "parkedcar":
      addParkedCar(scene, prop);
      return;
    case "trafficlight":
      addTrafficLight(scene, prop);
      return;
    case "roadsign":
      addRoadSign(scene, prop);
      return;
    case "billboard":
      addBillboardPanel(scene, prop);
      return;
    case "busstop":
      addBusStop(scene, prop);
      return;
    case "trashbin":
      addTrashBin(scene, prop);
      return;
    case "hydrant":
      addHydrant(scene, prop);
      return;
    case "cone":
      addCone(scene, prop);
      return;
    case "planter":
      addPlanter(scene, prop);
      return;
    case "plane-fuselage":
      addPlaneFuselage(scene, prop);
      return;
    case "plane-wing":
      addPlaneWing(scene, prop);
      return;
    case "plane-tail":
      addPlaneTail(scene, prop);
      return;
    case "plane-engine":
      addSimpleColumn(scene, prop, std(prop.color || 0x3a3d42, 0.5, 0.4), 12);
      return;
    case "cranemast":
      addSimpleColumn(scene, prop, std(prop.color || 0xf0c020, 0.6, 0.3), 4);
      return;
    case "scaffold":
    case "post":
      addSimpleColumn(scene, prop, std(prop.color || 0x8a7a3a, 0.7, 0.2), 5);
      return;
    case "slide":
    case "roundabout":
    case "fountain":
      addPlayground(scene, prop);
      return;
    case "gravelpile": {
      const pile = new THREE.Mesh(new THREE.ConeGeometry(prop.sx * 0.62, prop.sy, 8), std(prop.color || 0x9a8f7a, 0.98, 0, { flatShading: true }));
      pile.position.set(prop.x, (prop.py || 0) + prop.sy / 2, prop.z);
      pile.castShadow = true;
      scene.add(pile);
      return;
    }
    case "porta": {
      const g = new THREE.Group();
      const body2 = new THREE.Mesh(BOX_GEO, std(prop.color || 0x2f8f6f, 0.75));
      body2.scale.set(prop.sx, prop.sy, prop.sz);
      body2.position.y = prop.sy / 2;
      body2.castShadow = true;
      g.add(body2);
      const door = new THREE.Mesh(BOX_GEO, std(0x1f5f45, 0.7));
      door.scale.set(prop.sx * 0.7, prop.sy * 0.85, 0.1);
      door.position.set(0, prop.sy * 0.45, prop.sz / 2 + 0.02);
      g.add(door);
      g.position.set(prop.x, 0, prop.z);
      scene.add(g);
      return;
    }
    case "cranejib":
    case "scaffoldplank":
    case "swingbar":
    case "canopy": {
      // Elevated decorative slabs / bars.
      const bar = new THREE.Mesh(BOX_GEO, std(prop.color || 0x8a8a8a, 0.7, 0.2));
      bar.scale.set(prop.sx, prop.sy, prop.sz);
      bar.position.set(prop.x, (prop.py || 0) + prop.sy / 2, prop.z);
      scene.add(bar);
      return;
    }
    case "awning": {
      const awn = new THREE.Mesh(BOX_GEO, std(prop.color || 0xcf5b48, 0.85));
      awn.scale.set(prop.sx, prop.sy, prop.sz);
      awn.position.set(prop.x, (prop.py || 0) + prop.sy / 2, prop.z);
      awn.rotation.x = prop.face && Math.abs(prop.face) > 1.2 ? 0 : 0.18; // tilt down toward the street
      scene.add(awn);
      return;
    }
    case "shopsign": {
      const board = new THREE.Mesh(
        BOX_GEO,
        new THREE.MeshStandardMaterial({ color: prop.color || 0xcf5b48, emissive: prop.color || 0xcf5b48, emissiveIntensity: 0.4, roughness: 0.6 }),
      );
      board.scale.set(prop.sx, prop.sy, prop.sz);
      board.position.set(prop.x, (prop.py || 0) + prop.sy / 2, prop.z);
      scene.add(board);
      return;
    }
    case "debris": {
      const chunk = new THREE.Mesh(
        new THREE.IcosahedronGeometry(Math.max(prop.sx, prop.sz) * 0.55, 0),
        std(prop.color || 0x8a8f94, 0.8, 0.3, { flatShading: true }),
      );
      chunk.position.set(prop.x, (prop.py || 0) + prop.sy * 0.4, prop.z);
      chunk.rotation.set(Math.random(), Math.random() * Math.PI, Math.random());
      chunk.castShadow = true;
      scene.add(chunk);
      return;
    }
    case "glass": {
      const glass = box(scene, prop, std(0x9fc8e8, 0.08, 0.3, { transparent: true, opacity: 0.32 }), { shadow: false });
      glass.castShadow = false;
      // Thin frame lines.
      const frame = new THREE.Mesh(BOX_GEO, std(0x4b4640, 0.7, 0.2));
      frame.scale.set(prop.sx * 1.03, 0.06, prop.sz * 1.03);
      frame.position.set(prop.x, (prop.py || 0) + prop.sy / 2, prop.z);
      scene.add(frame);
      return;
    }
    case "ceilinglamp": {
      const lampMesh = new THREE.Mesh(
        BOX_GEO,
        new THREE.MeshStandardMaterial({ color: 0xfff2c4, emissive: 0xffeab0, emissiveIntensity: 1.4, roughness: 0.5 }),
      );
      lampMesh.scale.set(prop.sx, prop.sy, prop.sz);
      lampMesh.position.set(prop.x, (prop.py || 0) + prop.sy / 2, prop.z);
      scene.add(lampMesh);
      return;
    }
    case "rug": {
      const rug = new THREE.Mesh(
        new THREE.PlaneGeometry(prop.sx, prop.sz),
        std(prop.color || 0x7a3b33, 0.98, 0, { polygonOffset: true, polygonOffsetFactor: -2 }),
      );
      rug.rotation.x = -Math.PI / 2;
      rug.position.set(prop.x, (prop.py || 0) + 0.01, prop.z);
      scene.add(rug);
      return;
    }
    case "floor":
      box(scene, prop, std(prop.color || 0x8a6f4d, 0.92), { shadow: false }).receiveShadow = true;
      return;
    case "roof": {
      const roof = box(scene, prop, std(prop.color || 0x66584a, 0.88));
      if (prop.roofTile) return roof; // breakable tile: a trim per tile would leave ridges
      // Trim board around the roof edge.
      const trim = new THREE.Mesh(BOX_GEO, std(0x4b4238, 0.85));
      trim.scale.set(prop.sx + 0.2, 0.18, prop.sz + 0.2);
      trim.position.set(prop.x, (prop.py || 0) + 0.02, prop.z);
      scene.add(trim);
      return;
    }
    case "container": {
      const c = box(scene, prop, std(prop.color || 0x596f82, 0.72, 0.28));
      // Corrugation hint: darker side stripes.
      const stripe = new THREE.Mesh(BOX_GEO, std(0x000000, 0.9, 0.1, { transparent: true, opacity: 0.18 }));
      stripe.scale.set(prop.sx + 0.02, prop.sy * 0.12, prop.sz + 0.02);
      stripe.position.set(prop.x, (prop.py || 0) + prop.sy * 0.5, prop.z);
      scene.add(stripe);
      return;
    }
    case "terrace":
      box(scene, prop, std(prop.color || 0x567741, 0.98));
      return;
    case "stairs":
      box(scene, prop, std(prop.color || 0x7d7365, 0.92));
      return;
    case "table": {
      const woodMat = std(prop.color || 0x6e4f35, 0.85);
      const top = new THREE.Mesh(BOX_GEO, woodMat);
      top.scale.set(prop.sx, 0.08, prop.sz);
      top.position.set(prop.x, (prop.py || 0) + prop.sy - 0.04, prop.z);
      top.castShadow = true;
      scene.add(top);
      for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const leg = new THREE.Mesh(BOX_GEO, woodMat);
        leg.scale.set(0.09, prop.sy - 0.08, 0.09);
        leg.position.set(
          prop.x + lx * (prop.sx / 2 - 0.1),
          (prop.py || 0) + (prop.sy - 0.08) / 2,
          prop.z + lz * (prop.sz / 2 - 0.1),
        );
        scene.add(leg);
      }
      return;
    }
    case "sofa": {
      const sofaMat = std(prop.color || 0x35546a, 0.94);
      const base = new THREE.Mesh(BOX_GEO, sofaMat);
      base.scale.set(prop.sx, prop.sy * 0.55, prop.sz);
      base.position.set(prop.x, (prop.py || 0) + prop.sy * 0.28, prop.z);
      base.castShadow = true;
      scene.add(base);
      const back = new THREE.Mesh(BOX_GEO, sofaMat);
      back.scale.set(prop.sx, prop.sy * 0.75, prop.sz * 0.3);
      back.position.set(prop.x, (prop.py || 0) + prop.sy * 0.6, prop.z - prop.sz * 0.35);
      scene.add(back);
      for (const sx of [-1, 1]) {
        const armRest = new THREE.Mesh(BOX_GEO, sofaMat);
        armRest.scale.set(prop.sx * 0.12, prop.sy * 0.7, prop.sz);
        armRest.position.set(prop.x + sx * prop.sx * 0.46, (prop.py || 0) + prop.sy * 0.38, prop.z);
        scene.add(armRest);
      }
      return;
    }
    case "bed": {
      const frame = box(scene, { ...prop, sy: prop.sy * 0.5 }, std(0x5a4634, 0.9));
      const mattress = new THREE.Mesh(BOX_GEO, std(0xcfc7b8, 0.95));
      mattress.scale.set(prop.sx * 0.94, prop.sy * 0.35, prop.sz * 0.94);
      mattress.position.set(prop.x, (prop.py || 0) + prop.sy * 0.62, prop.z);
      scene.add(mattress);
      const pillow = new THREE.Mesh(BOX_GEO, std(0xe8e2d4, 0.95));
      pillow.scale.set(prop.sx * 0.3, prop.sy * 0.18, prop.sz * 0.6);
      pillow.position.set(prop.x - prop.sx * 0.3, (prop.py || 0) + prop.sy * 0.85, prop.z);
      scene.add(pillow);
      return;
    }
    default: {
      // wall, partition, cabinet, crate, barrier, door-threshold, etc.
      const material = std(prop.color || 0x726a62, prop.type === "crate" ? 0.85 : 0.9, prop.type === "barrier" ? 0.2 : 0.04);
      const mesh = box(scene, prop, material);
      if (prop.type === "wall" && prop.sy > 2.5) {
        const capMat = std(0x565046, 0.88);
        const cap = new THREE.Mesh(BOX_GEO, capMat);
        cap.scale.set(prop.sx + 0.06, 0.1, prop.sz + 0.06);
        cap.position.set(prop.x, (prop.py || 0) + prop.sy + 0.05, prop.z);
        scene.add(cap);
      }
      return mesh;
    }
  }
}

// ---------------------------------------------------------------------------
// Zone + assembly
// ---------------------------------------------------------------------------

export function createZoneMeshes(scene) {
  const zoneHeight = 300;
  const zoneGeo = new THREE.CylinderGeometry(1, 1, zoneHeight, 64, 1, true);
  const zoneMat = new THREE.MeshBasicMaterial({
    color: 0x4ca8ff,
    opacity: 0.16,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const zoneMesh = new THREE.Mesh(zoneGeo, zoneMat);
  zoneMesh.position.y = zoneHeight / 2;
  scene.add(zoneMesh);

  const zoneInnerMesh = new THREE.Mesh(
    new THREE.CircleGeometry(1, 64),
    new THREE.MeshBasicMaterial({
      color: 0x2d72b5,
      opacity: 0.08,
      transparent: true,
      depthWrite: false,
    }),
  );
  zoneInnerMesh.rotation.x = -Math.PI / 2;
  zoneInnerMesh.position.y = 0.02;
  scene.add(zoneInnerMesh);

  return { zoneMesh, zoneInnerMesh };
}

export function buildWorld(scene, meta, opts = {}) {
  const { zone = true } = opts;
  // Anything already in the scene (players, vehicles, the recruit beacon...
  // live state can arrive before the world meta) is dynamic: never merge it.
  const preexisting = new Set(scene.children);
  let floor = null;

  for (const [index, patch] of (meta.terrainPatches || []).entries()) {
    addTerrainPatch(scene, patch, index);
  }

  if (!meta.terrainPatches || meta.terrainPatches.length === 0) {
    const geo = new THREE.PlaneGeometry(1400, 1400);
    floor = new THREE.Mesh(geo, std(0x4b7a46, 0.95));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
  }

  scene.userData.buildingDefs = new Map((meta.buildings || []).map((b) => [b.id, b]));
  for (const prop of meta.props || []) {
    addProp(scene, prop);
  }

  if (!opts.skipGrass) addGrass(scene, meta); // (renderer draws dense blades instead)
  addFields(scene, meta);
  // (Clouds are drawn by the sky shader now — see atmosphere.js.)
  // Collapse ~6,000 prop meshes into a few hundred draw calls.
  optimizeStaticWorld(scene, preexisting);

  if (!zone) return { floor, zoneMesh: null, zoneInnerMesh: null };
  const { zoneMesh, zoneInnerMesh } = createZoneMeshes(scene);
  return { floor, zoneMesh, zoneInnerMesh };
}

export function updateZone(zoneMesh, zoneInnerMesh, zone) {
  if (!zoneMesh || !zoneInnerMesh) return;
  const radius = Math.max(0.1, zone.radius);
  zoneMesh.position.set(zone.x, zoneMesh.position.y, zone.z);
  zoneInnerMesh.position.set(zone.x, 0.02, zone.z);
  zoneMesh.scale.set(radius, 1, radius);
  zoneInnerMesh.scale.set(radius, 1, radius);
  const pulse = 0.13 + Math.sin(Date.now() * 0.002) * 0.05;
  zoneMesh.material.opacity = pulse;
}
