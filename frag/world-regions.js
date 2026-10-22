/**
 * The countryside around the city (the map is 1280m across; the city grid
 * fills the middle ~660m). Inspired by Ghost of Tsushima:
 *
 *   West   — a farming village: tiled / thatched minka houses you can enter
 *            (and break), a five-storey pagoda, a hillside shrine reached
 *            through a row of torii gates, stone lanterns, terraced rice
 *            paddies, a bamboo grove and a horse pasture.
 *   North  — a mountain wall: jagged cliffs, a waterfall into a plunge pool
 *            and stream, a walk-in cave with a crystal chamber, and a stone
 *            trail up onto a mesa lookout. Pine forest on the foothills.
 *   South  — a sea of golden pampas grass with lone red maples and a hamlet.
 *   East   — mixed forest with a deer meadow and hunters' cabins.
 *
 * Everything here is plain props / terrain patches / buildings, so collision,
 * bullets, destruction and the client renderer treat it like the rest of the
 * world. `wildlife` zones tell the client where to graze animals.
 */

const CITY_HALF = 335;

function buildRegions(api) {
  const {
    addProp,
    addVehicle,
    terrainPatches,
    beginBuilding,
    endBuilding,
    wallRun,
    addRoofTiles,
    buildingRects,
    WALL_H,
    WALL_T,
    rand,
    worldHalf,
  } = api;

  const wildlife = [];
  // Areas kept clear of scattered trees / rocks.
  const reserved = [];
  const reserve = (x, z, hw, hd) => reserved.push({ x, z, hw, hd });
  const isFree = (x, z, pad = 0) => {
    if (Math.abs(x) < CITY_HALF + pad && Math.abs(z) < CITY_HALF + pad) return false;
    if (Math.abs(x) > worldHalf - 4 || Math.abs(z) > worldHalf - 4) return false;
    if (x > -278 - pad && x < -222 + pad) return false; // river
    if (reserved.some((r) => Math.abs(x - r.x) < r.hw + pad && Math.abs(z - r.z) < r.hd + pad)) return false;
    return !buildingRects.some((b) => Math.abs(x - b.x) < b.hw + pad && Math.abs(z - b.z) < b.hd + pad);
  };
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // ---- Trees -----------------------------------------------------------------
  // Same "tree" prop as the city (shootable, fellable); `variant` picks the
  // silhouette on the client.
  const TREE = {
    pine: { colors: [0x2c4a2a, 0x2f5230, 0x26422a], h: [11, 18], r: [0.45, 0.7] },
    maple: { colors: [0xb8321e, 0xc9481f, 0xd2662a, 0xa82a22], h: [7, 11], r: [0.4, 0.6] },
    cherry: { colors: [0xe6a3b6, 0xf0b8c8], h: [6, 8.5], r: [0.35, 0.5] },
    oak: { colors: [0x3a6a2c, 0x467833, 0x55803a], h: [8, 12], r: [0.5, 0.8] },
    birch: { colors: [0x7e9a3e, 0x9aab48, 0xc9a640], h: [9, 13], r: [0.3, 0.42] },
  };
  const addTree = (x, z, variant = "oak") => {
    const t = TREE[variant];
    const r = rand(t.r[0], t.r[1]);
    const p = addProp(x, z, r * 2, rand(t.h[0], t.h[1]), r * 2, "tree", pick(t.colors), true);
    p.variant = variant;
    return p;
  };
  const addBamboo = (x, z) => {
    const p = addProp(x, z, 1.6, rand(9, 14), 1.6, "tree", pick([0x6f8f3a, 0x7a9a42, 0x5f8233]), true);
    p.variant = "bamboo";
    return p;
  };
  const scatter = (n, x0, x1, z0, z1, place, pad = 2) => {
    let placed = 0;
    for (let i = 0; i < n * 3 && placed < n; i += 1) {
      const x = rand(x0, x1);
      const z = rand(z0, z1);
      if (!isFree(x, z, pad)) continue;
      place(x, z);
      placed += 1;
    }
  };
  const addBoulder = (x, z, s = 1) =>
    addProp(x, z, rand(1.6, 3.4) * s, rand(1.0, 2.4) * s, rand(1.6, 3.2) * s, "rock", pick([0x6f6a62, 0x7b766c, 0x5f5d58]), true);

  // ---- Japanese building kit ---------------------------------------------------

  // Hip roof with a concave sweep and upturned eaves (cosmetic, sits on the
  // breakable roof tiles and falls with the building).
  const addHipRoof = (cx, cz, w, d, h, py, color, style = "tile") => {
    const r = addProp(cx, cz, w, h, d, "hiproof", color, false, py);
    r.style = style;
    return r;
  };

  // Minka: timber-frame farmhouse. Plaster/wood walls, sliding-door openings,
  // tatami floor, low table + chest inside, tiled or thatched hip roof.
  // door: which face carries the main entrance ("+z" | "-z" | "+x" | "-x").
  const addMinka = (cx, cz, w, d, opts = {}) => {
    const {
      door = "+z",
      wall = pick([0xd9cfbd, 0xcfc3ad, 0x6b4a32, 0x5d4230]),
      roof = pick([0x3b4048, 0x454a52, 0x8c7650, 0x7f6b47]),
      style,
    } = opts;
    const roofStyle = style || (roof === 0x8c7650 || roof === 0x7f6b47 ? "thatch" : "tile");
    buildingRects.push({ x: cx, z: cz, hw: w / 2 + 3, hd: d / 2 + 3 });
    beginBuilding("minka", cx, cz, w, d, WALL_H + 2.6, wall, 200);
    const main = (side) => (side === door ? [{ at: 0, w: 2.2, type: "door" }, { at: (side === "+z" || side === "-z" ? w : d) * 0.3, w: 2.2, type: "window" }] : null);
    const others = (len) => [{ at: -len * 0.25, w: 1.8, type: "window" }, { at: len * 0.25, w: 1.8, type: "window" }];
    wallRun(cx, cz + d / 2, w, true, main("+z") || others(w), wall, WALL_H, "+z");
    wallRun(cx, cz - d / 2, w, true, main("-z") || others(w), wall, WALL_H, "-z");
    wallRun(cx - w / 2, cz, d, false, main("-x") || [{ at: 0, w: 2.0, type: "door" }], wall, WALL_H, "-x");
    wallRun(cx + w / 2, cz, d, false, main("+x") || others(d), wall, WALL_H, "+x");
    addProp(cx, cz, w - WALL_T, 0.1, d - WALL_T, "floor", 0xb7a26a, false, 0.02); // tatami
    // Raised engawa veranda along the front.
    const ax = door === "+x" ? 1 : door === "-x" ? -1 : 0;
    const az = door === "+z" ? 1 : door === "-z" ? -1 : 0;
    addProp(cx + ax * (w / 2 + 1.1), cz + az * (d / 2 + 1.1), ax ? 1.6 : w, 0.45, ax ? d : 1.6, "terrace", 0x6a4d33, true);
    addRoofTiles(cx, cz, w + 0.4, d + 0.4, 0.25, 0x4a3b2c, WALL_H, 120);
    addHipRoof(cx, cz, w + 3.2, d + 3.2, Math.min(w, d) * 0.42, WALL_H + 0.25, roof, roofStyle);
    // Inside: low table, chest, a lantern.
    addProp(cx - w * 0.15, cz, 1.8, 0.45, 1.1, "table", 0x4a3424, true);
    addProp(cx + w * 0.32, cz - d * 0.3, 1.4, 1.1, 0.6, "cabinet", 0x5a3d26, true);
    addProp(cx + w * 0.2, cz + d * 0.25, 0.5, 1.2, 0.5, "lamp", 0xf3c77a, false);
    endBuilding();
  };

  const addTorii = (x, z, alongX = true, scale = 1, color = 0xc4402a) => {
    const t = addProp(x, z, alongX ? 0.8 : 5.6 * scale, 5.2 * scale, alongX ? 5.6 * scale : 0.8, "torii", color, false);
    t.alongX = alongX;
    // The two posts are solid.
    const off = 2.2 * scale;
    addProp(alongX ? x : x - off, alongX ? z - off : z, 0.55, 4.6 * scale, 0.55, "toriipost", color, true);
    addProp(alongX ? x : x + off, alongX ? z + off : z, 0.55, 4.6 * scale, 0.55, "toriipost", color, true);
  };
  const addLantern = (x, z) => addProp(x, z, 0.9, 2.1, 0.9, "stonelantern", 0x8d8a82, true);

  const addPagoda = (cx, cz) => {
    reserve(cx, cz, 14, 14);
    addProp(cx, cz, 18, 0.55, 18, "terrace", 0x8d8a82, true); // stone plinth (walkable step)
    const core = addProp(cx, cz, 8, 30, 8, "pagoda", 0x8a3a26, true, 0.55);
    core.tiers = 5;
    addLantern(cx - 7, cz + 11);
    addLantern(cx + 7, cz + 11);
  };

  // =============================================================================
  // WEST — the village
  // =============================================================================
  const VX = -455;
  terrainPatches.push(
    { x: -470, z: 0, sx: 290, sz: 9, color: 0x8a7454, type: "dirtroad" },
    { x: VX, z: 0, sx: 8, sz: 660, color: 0x8a7454, type: "dirtroad" },
    { x: VX, z: 0, sx: 34, sz: 34, color: 0x9a8a6a, type: "dirt" }, // village square
  );
  reserve(-470, 0, 145, 7);
  reserve(VX, 0, 6, 330);
  // Houses lining the two lanes.
  const houses = [
    [-410, -22, 14, 10, "+z"], [-500, -22, 13, 10, "+z"], [-410, 24, 13, 10, "-z"], [-500, 26, 14, 11, "-z"],
    [-432, -82, 10, 12, "+x"], [-480, -88, 11, 12, "-x"], [-432, 84, 11, 12, "+x"], [-480, 86, 10, 11, "-x"],
    [-548, -24, 12, 10, "+z"], [-552, 28, 13, 10, "-z"], [-372, 60, 11, 9, "-z"],
  ];
  for (const [x, z, w, d, door] of houses) addMinka(x, z, w, d, { door });
  // Square: a well, lanterns, a cart and hay.
  addProp(VX + 9, 9, 2.4, 1.0, 2.4, "well", 0x7d776c, true);
  for (const [lx, lz] of [[VX - 13, -13], [VX + 13, -13], [VX - 13, 13], [VX + 13, 13]]) addLantern(lx, lz);
  addProp(VX - 8, 9, 3.2, 1.4, 1.6, "cart", 0x6b4a30, true);
  for (const [hx, hz] of [[-520, -52], [-523, -60], [-390, -55], [-386, 108], [-525, 110]]) {
    addProp(hx, hz, 2.6, 2.4, 2.6, "haystack", 0xc2a25a, true);
  }
  for (const [wx, wz] of [[-418, -48], [-492, 52], [-560, 6]]) addProp(wx, wz, 2.6, 1.2, 1.2, "woodpile", 0x6a4a2c, true);

  // Pagoda on the north side of the village.
  addPagoda(-555, -150);

  // Shrine at the far west end of a torii-lined approach.
  terrainPatches.push({ x: -530, z: 175, sx: 110, sz: 6, color: 0xa39a88, type: "dirtroad" });
  reserve(-530, 175, 56, 6);
  for (const tx of [-490, -508, -526, -544]) addTorii(tx, 175, true, 1, 0xc4402a);
  for (const lx of [-498, -517, -535]) {
    addLantern(lx, 170.5);
    addLantern(lx, 179.5);
  }
  addMinka(-598, 175, 12, 9, { door: "+x", wall: 0xe8e0d0, roof: 0x3b4048 });
  addTorii(-470, 175, true, 1.5, 0xb33a24); // great gate
  for (let i = 0; i < 14; i += 1) {
    const a = (i / 14) * Math.PI * 2;
    const x = -585 + Math.cos(a) * rand(22, 34);
    const z = 175 + Math.sin(a) * rand(22, 34);
    if (isFree(x, z, 2)) addTree(x, z, i % 4 === 0 ? "cherry" : "maple");
  }

  // Rice paddies between the village and the river (east bank of the farm).
  for (const pz of [-270, -236, -202, -168, -134, 130, 164, 198, 232, 266]) {
    for (const px of [-352, -384]) {
      terrainPatches.push({ x: px, z: pz, sx: 29, sz: 31, color: 0x5b7a52, type: "paddy" });
      reserve(px, pz, 15, 16);
    }
  }
  addProp(-368, -100, 0.6, 2.2, 0.6, "scarecrow", 0x8a6a40, false);
  addProp(-368, 100, 0.6, 2.2, 0.6, "scarecrow", 0x8a6a40, false);

  // Bamboo grove NW of the village.
  scatter(80, -630, -515, -335, -215, addBamboo, 0.5);
  // Maples / cherries around the village houses.
  scatter(30, -600, -370, -130, 130, (x, z) => addTree(x, z, Math.random() < 0.25 ? "cherry" : "maple"), 4);
  // Pasture fence + horses south-west.
  for (let i = 0; i < 6; i += 1) addProp(-600 + i * 12, 240, 12, 1.1, 0.25, "fence", 0x6a4a2c, true);
  wildlife.push({ kind: "horse", x: -565, z: 270, r: 30, count: 5 });
  wildlife.push({ kind: "deer", x: -560, z: -260, r: 40, count: 4 });
  scatter(40, -640, -380, 300, 560, (x, z) => addTree(x, z, pick(["pine", "maple", "oak"])), 3);

  // =============================================================================
  // NORTH — cliffs, waterfall, cave, mesa trail, pine foothills
  // =============================================================================
  const CLIFF_Z = -572;
  const cliffDepth = worldHalf + CLIFF_Z; // to the map edge
  const cliff = (x0, x1, z0, z1, h, py = 0, type = "cliff") => {
    const p = addProp((x0 + x1) / 2, (z0 + z1) / 2, x1 - x0, h, z1 - z0, type, type === "cliff" ? pick([0x6d675d, 0x75705f, 0x655f57]) : 0x4c4842, true, py);
    reserve(p.x, p.z, p.sx / 2, p.sz / 2);
    return p;
  };
  // Cave footprint (x -205..-145) and mesa handled separately.
  const CAVE = { x0: -205, x1: -145 };
  let x = -worldHalf;
  while (x < worldHalf) {
    let x1 = Math.min(worldHalf, x + rand(48, 86));
    if (x < CAVE.x0 && x1 > CAVE.x0) x1 = CAVE.x0;
    if (x >= CAVE.x0 && x < CAVE.x1) {
      x = CAVE.x1;
      continue;
    }
    // The waterfall face gets a tall, flat-topped segment.
    const fall = x <= 140 && x1 >= 140;
    cliff(x, x1, -worldHalf, fall ? CLIFF_Z : CLIFF_Z + rand(-4, 4), fall ? 36 : rand(24, 46));
    x = x1;
  }

  // Waterfall into a plunge pool, then a stream running south.
  addProp(140, CLIFF_Z + 0.8, 15, 36, 1.2, "waterfall", 0xdfeff7, false);
  terrainPatches.push(
    { x: 140, z: CLIFF_Z + 22, sx: 46, sz: 36, color: 0x2e6b7f, type: "lake" },
    { x: 140, z: CLIFF_Z + 22, sx: 58, sz: 46, color: 0x6b6a62, type: "sand" },
    { x: 146, z: -460, sx: 9, sz: 186, color: 0x3a7891, type: "river" },
  );
  reserve(140, CLIFF_Z + 22, 30, 24);
  reserve(146, -460, 7, 94);
  for (const [bx, bz] of [[118, -545], [163, -547], [112, -530], [168, -528], [130, -528]]) addBoulder(bx, bz, 1.3);

  // Cave: corridor into the mountain opening onto a crystal chamber.
  const cz0 = CLIFF_Z;
  cliff(-205, -180, -600, cz0, 34, 0, "cliff");
  cliff(-170, -145, -600, cz0, 34, 0, "cliff");
  cliff(-205, -199, -634, -600, 34, 0, "cavewall");
  cliff(-151, -145, -634, -600, 34, 0, "cavewall");
  cliff(-205, -145, -worldHalf, -634, 34, 0, "cavewall");
  cliff(-180, -170, -600, cz0, 29, 5.2, "caveroof");
  cliff(-199, -151, -634, -600, 27, 7, "caveroof");
  terrainPatches.push({ x: -175, z: -603, sx: 50, sz: 62, color: 0x3b3833, type: "cave" });
  for (const [kx, kz, s] of [[-192, -628, 1], [-158, -626, 1.2], [-188, -608, 0.7], [-162, -607, 0.8], [-175, -630, 1.4]]) {
    addProp(kx, kz, 1.2 * s, 2.6 * s, 1.2 * s, "crystal", pick([0x63c7ff, 0x9a7bff, 0x5fffd0]), false);
  }
  for (const [sx_, sz_] of [[-184, -617], [-166, -620], [-178, -611]]) addProp(sx_, sz_, 1.4, rand(1.2, 2.4), 1.4, "rock", 0x4f4a44, true);
  addProp(-175, -618, 1.6, 0.4, 1.6, "campfire", 0x5a3a22, false);
  addProp(-196, -614, 1.4, 1.2, 1.4, "crate", 0x7a5d3b, true);
  addProp(-155, -614, 1.4, 1.2, 1.4, "crate", 0x7a5d3b, true);

  // Mesa lookout jutting out of the cliffs on the east, reached by a stone trail.
  const MESA_H = 12;
  cliff(420, 560, CLIFF_Z, -500, MESA_H);
  const steps = 24;
  for (let i = 0; i < steps; i += 1) {
    addProp(416.5, -433.5 - i * 3, 7, (MESA_H / steps) * (i + 1), 3, "stairs", 0x8a8478, true);
  }
  reserve(416.5, -468, 6, 38);
  addProp(470, -535, 6, 0.3, 6, "terrace", 0x6a4d33, false, MESA_H);
  addProp(470, -535, 1.6, 1.2, 1.6, "crate", 0x7a5d3b, true, MESA_H);
  addLantern(436, -506);

  // Foothills: dense pines thinning out toward the city, boulders.
  scatter(260, -640, 640, -566, -440, (x_, z_) => addTree(x_, z_, Math.random() < 0.85 ? "pine" : "birch"), 3);
  scatter(60, -640, 640, -440, -345, (x_, z_) => addTree(x_, z_, pick(["pine", "pine", "oak", "birch"])), 4);
  scatter(40, -640, 640, -566, -345, (x_, z_) => addBoulder(x_, z_), 2);
  wildlife.push({ kind: "deer", x: 40, z: -470, r: 50, count: 5 });

  // =============================================================================
  // SOUTH — golden pampas + hamlet
  // =============================================================================
  terrainPatches.push(
    { x: -10, z: 480, sx: 600, sz: 230, color: 0x6e6238, type: "pampas" },
    { x: 0, z: 470, sx: 7, sz: 270, color: 0x8a7454, type: "dirtroad" },
  );
  reserve(0, 470, 5, 135);
  addMinka(200, 452, 13, 10, { door: "-x" });
  addMinka(236, 488, 11, 10, { door: "-z", roof: 0x8c7650 });
  addMinka(186, 506, 12, 9, { door: "+x", roof: 0x8c7650 });
  addProp(214, 478, 2.4, 1.0, 2.4, "well", 0x7d776c, true);
  addProp(222, 455, 2.6, 2.4, 2.6, "haystack", 0xc2a25a, true);
  addTorii(0, 352, false, 1.2, 0xc4402a);
  scatter(26, -300, 290, 370, 590, (x_, z_) => addTree(x_, z_, Math.random() < 0.8 ? "maple" : "birch"), 6);
  scatter(14, -300, 290, 370, 590, (x_, z_) => addBoulder(x_, z_, 0.8), 3);
  scatter(50, 290, 640, 340, 640, (x_, z_) => addTree(x_, z_, pick(["pine", "oak", "maple"])), 3);
  wildlife.push({ kind: "horse", x: -120, z: 480, r: 70, count: 6 });
  wildlife.push({ kind: "deer", x: 120, z: 560, r: 50, count: 3 });

  // =============================================================================
  // EAST — forest, meadow, hunters' cabins
  // =============================================================================
  terrainPatches.push({ x: 488, z: 120, sx: 100, sz: 90, color: 0x587a36, type: "meadow" });
  reserve(488, 120, 50, 45);
  addMinka(560, 210, 10, 8, { door: "-z", wall: 0x5d4230, roof: 0x8c7650 });
  addMinka(536, -80, 10, 9, { door: "-x", wall: 0x6b4a32, roof: 0x3b4048 });
  addProp(548, -70, 2.6, 1.2, 1.2, "woodpile", 0x6a4a2c, true);
  scatter(300, 340, 640, -340, 340, (x_, z_) => addTree(x_, z_, pick(["oak", "oak", "pine", "maple", "birch"])), 3);
  scatter(24, 340, 640, -340, 340, (x_, z_) => addBoulder(x_, z_), 2);
  wildlife.push({ kind: "deer", x: 488, z: 120, r: 38, count: 6 });

  // =============================================================================
  // Vehicles out in the countryside
  // =============================================================================
  addVehicle(-440, -8, 0, 0x6a5038, "pickup");
  addVehicle(-470, 140, Math.PI * 0.5, 0x2a2a2a, "bike");
  addVehicle(-380, 10, Math.PI * 0.5, 0x8a2a1a, "bike");
  addVehicle(-500, -200, 0, 0x7f8c8d, "heli");
  addVehicle(10, 420, 0, 0xc0a040, "bike");
  addVehicle(250, 470, Math.PI, 0x4b5a35, "pickup");
  addVehicle(400, -420, Math.PI, 0x4b5a35, "apc");
  addVehicle(60, -420, 0, 0x2f3a46, "suv");
  addVehicle(500, 60, Math.PI * 0.5, 0x3d5fa8, "suv");

  return { wildlife };
}

module.exports = { buildRegions };
