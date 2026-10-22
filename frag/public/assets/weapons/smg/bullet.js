/**
 * SMG Bullet Design
 * Fast, smaller blueish tracers
 */

export function buildSMGBullet() {
    const group = new THREE.Group();

    // Bullet Body
    const headGeo = new THREE.BoxGeometry(0.06, 0.06, 0.15);
    const headMat = new THREE.MeshBasicMaterial({ color: 0x88ffff });
    const head = new THREE.Mesh(headGeo, headMat);
    group.add(head);

    // Trail
    const trailGeo = new THREE.BoxGeometry(0.03, 0.03, 1.0);
    const trailMat = new THREE.MeshBasicMaterial({
        color: 0x00aaff,
        transparent: true,
        opacity: 0.5
    });
    const trail = new THREE.Mesh(trailGeo, trailMat);
    trail.position.z = -0.6; // Behind head
    group.add(trail);

    return group;
}

export const SMGBulletProps = {
    speed: 220,
    color: 0x00aaff,
    sparkColor: 0x88ff88
};
