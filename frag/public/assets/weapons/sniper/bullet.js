/**
 * Sniper Bullet Design
 * Heavy rail-gun style blue streak
 */

export function buildSniperBullet() {
    const group = new THREE.Group();

    // Bullet Body
    const headGeo = new THREE.BoxGeometry(0.15, 0.15, 0.4);
    const headMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const head = new THREE.Mesh(headGeo, headMat);
    group.add(head);

    // Thick Trail
    const trailGeo = new THREE.BoxGeometry(0.1, 0.1, 3.0);
    const trailMat = new THREE.MeshBasicMaterial({
        color: 0x00ffff,
        transparent: true,
        opacity: 0.8
    });
    const trail = new THREE.Mesh(trailGeo, trailMat);
    trail.position.z = -1.7; // Behind head
    group.add(trail);

    // Core glow
    const coreGeo = new THREE.BoxGeometry(0.04, 0.04, 3.2);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.position.z = -1.7; // Behind head
    group.add(core);

    return group;
}

export const SniperBulletProps = {
    speed: 400,
    color: 0x00ffff,
    sparkColor: 0x88ff88
};
