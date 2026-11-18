import RAPIER, { type Collider, type KinematicCharacterController, type RigidBody, type World } from '@dimforge/rapier3d-compat';
import { PerspectiveCamera, Vector3 } from 'three';

export class Player {
  readonly body: RigidBody;
  readonly collider: Collider;
  private readonly controller: KinematicCharacterController;
  private readonly keys = new Set<string>();
  private readonly move = new Vector3(); private readonly position = new Vector3();
  yaw = 0; pitch = 0.035;
  constructor(private readonly world: World, private readonly camera: PerspectiveCamera, groundHeight = 0) {
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, groundHeight + 0.90, 22));
    this.collider = world.createCollider(RAPIER.ColliderDesc.capsule(0.55, 0.28).setFriction(0).setCollisionGroups(0x00040003), this.body);
    this.controller = world.createCharacterController(0.015);
    this.controller.setSlideEnabled(true);
    this.controller.enableAutostep(0.22, 0.2, false); this.controller.enableSnapToGround(0.25);
    this.controller.setMaxSlopeClimbAngle(Math.PI / 4); this.controller.setMinSlopeSlideAngle(Math.PI / 3);
    // The observer does not kick structural pieces: walking inputs cannot alter a benchmark replay.
    this.controller.setApplyImpulsesToDynamicBodies(false);
  }
  key(code: string, down: boolean): void { if (down) this.keys.add(code); else this.keys.delete(code); }
  clearKeys(): void { this.keys.clear(); }
  look(dx: number, dy: number): void { this.yaw -= dx * 0.0019; this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch - dy * 0.0019)); }
  step(dt: number): void {
    this.yaw += (Number(this.keys.has('KeyQ')) - Number(this.keys.has('KeyE'))) * dt * 1.6;
    const forward = Number(this.keys.has('KeyW') || this.keys.has('ArrowUp')) - Number(this.keys.has('KeyS') || this.keys.has('ArrowDown'));
    const right = Number(this.keys.has('KeyD') || this.keys.has('ArrowRight')) - Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft'));
    const speed = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) ? 4.8 : 2.8;
    this.move.set(-Math.sin(this.yaw) * forward + Math.cos(this.yaw) * right, 0, -Math.cos(this.yaw) * forward - Math.sin(this.yaw) * right);
    if (this.move.lengthSq() > 0) this.move.normalize().multiplyScalar(speed * dt);
    this.move.y = -2 * dt;
    this.controller.computeColliderMovement(this.collider, this.move, undefined, 0x00040003);
    const p = this.body.translation(), corrected = this.controller.computedMovement();
    this.position.set(Math.max(-65, Math.min(65, p.x + corrected.x)), p.y + corrected.y, Math.max(-65, Math.min(65, p.z + corrected.z)));
    this.body.setNextKinematicTranslation(this.position);
  }
  sync(intensity: number, time: number): void {
    const p = this.body.translation();
    this.camera.position.set(p.x + Math.sin(time * 18) * intensity * 0.012, p.y + 0.87, p.z);
    this.camera.rotation.set(this.pitch + Math.sin(time * 23) * intensity * 0.0025, this.yaw, Math.sin(time * 13) * intensity * 0.0015, 'YXZ');
  }
  getPosition(): { x: number; y: number; z: number } { const p = this.body.translation(); return { x: p.x, y: p.y, z: p.z }; }
  setPose(position: { x: number; y: number; z: number }, yaw: number, pitch: number): void {
    this.body.setTranslation(position, true); this.body.setNextKinematicTranslation(position); this.yaw = yaw; this.pitch = pitch;
  }
  dispose(): void { this.world.removeCharacterController(this.controller); this.world.removeRigidBody(this.body); }
}
