/**
 * Browser copy of vehicle-system.js VEHICLE_SHAPES (body box + seats per
 * type; vehicle-local: +x right, -z forward, y up). Keep the two in sync.
 */

export const VEHICLE_SHAPES = {
  car: { hx: 1.15, hz: 2.35, h: 1.8, seats: { driver: [-0.47, 0.8, 0.35], passenger: [0.47, 0.8, 0.35] } },
  sports: { hx: 1.1, hz: 2.3, h: 1.35, seats: { driver: [-0.42, 0.52, 0.3], passenger: [0.42, 0.52, 0.3] } },
  suv: { hx: 1.22, hz: 2.35, h: 2.4, seats: { driver: [-0.5, 1.2, 0.2], passenger: [0.5, 1.2, 0.2] } },
  pickup: { hx: 1.22, hz: 2.85, h: 2.2, seats: { driver: [-0.5, 1.1, -0.35], passenger: [0.5, 1.1, -0.35] } },
  truck: { hx: 1.35, hz: 4.0, h: 3.8, seats: { driver: [-0.6, 1.85, -2.35], passenger: [0.6, 1.85, -2.35] } },
  bike: { hx: 0.38, hz: 1.3, h: 1.35, seats: { driver: [0, 1.0, 0.3], passenger: [0, 1.12, 0.85] } },
  apc: { hx: 1.45, hz: 3.3, h: 3.0, seats: { driver: [-0.6, 1.9, -2.0], passenger: [0, 2.85, 0.4] } },
  heli: { hx: 1.3, hz: 3.2, h: 2.8, seats: { driver: [-0.42, 1.2, -0.35], passenger: [0.42, 1.2, -0.35] } },
  plane: { hx: 1.0, hz: 4.2, h: 2.6, seats: { driver: [0, 1.5, -0.2], passenger: [0, 1.5, 0.6] } },
};

export function vehicleShape(v) {
  return VEHICLE_SHAPES[v?.type] || VEHICLE_SHAPES.car;
}

/** Push a walking body (circle) out of every solid vehicle — mirrors the server. */
export function resolveCircleVsVehicles(x, z, r, vehicles, feetY = 0) {
  for (const v of vehicles || []) {
    if (v.destroyed) continue;
    const shape = vehicleShape(v);
    const vy = v.y || 0;
    if (feetY > vy + shape.h - 0.3 || feetY + 1.8 < vy) continue;
    const dx = x - v.x;
    const dz = z - v.z;
    const c = Math.cos(v.yaw);
    const s = Math.sin(v.yaw);
    let lx = dx * c - dz * s;
    let lz = dx * s + dz * c;
    const ex = shape.hx + r - Math.abs(lx);
    const ez = shape.hz + r - Math.abs(lz);
    if (ex <= 0 || ez <= 0) continue;
    if (ex < ez) lx += lx >= 0 ? ex : -ex;
    else lz += lz >= 0 ? ez : -ez;
    x = v.x + lx * c + lz * s;
    z = v.z - lx * s + lz * c;
  }
  return { x, z };
}
