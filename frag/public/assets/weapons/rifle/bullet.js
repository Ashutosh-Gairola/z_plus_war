/**
 * Rifle Bullet Design
 * Tactical yellow tracer projectile
 */

export function buildRifleBullet() {
    const group = new THREE.Group();

    // Bullet Body (The actual projectile head)
    const headGeo = new THREE.BoxGeometry(0.1, 0.1, 0.2);
    const headMat = new THREE.MeshBasicMaterial({ color: 0xffff88 });
    const head = new THREE.Mesh(headGeo, headMat);
    group.add(head);

    // Glowing Trail (The streak behind the bullet)
    const trailGeo = new THREE.BoxGeometry(0.05, 0.05, 1.5);
    const trailMat = new THREE.MeshBasicMaterial({
        color: 0xffaa00,
        transparent: true,
        opacity: 0.6
    });
    const trail = new THREE.Mesh(trailGeo, trailMat);
    trail.position.z = -0.8; // Behind the head (negative Z)
    group.add(trail);

    return group;
}

export const RifleBulletProps = {
    speed: 180, // m/s (visual speed)
    color: 0xffaa00,
    sparkColor: 0x88ff88
};
