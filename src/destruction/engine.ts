import RAPIER, { ColliderDesc, JointData, RigidBodyDesc, RigidBodyType, type Collider, type ImpulseJoint, type RigidBody, type World } from '@dimforge/rapier3d-compat';
import { Group, Quaternion, Vector3, type Scene } from 'three';
import { DestructionAudio } from './audio';
import { DEFAULT_EVENT_SEED, FIXED_DELTA_TIME, type CollisionGeometry, type ComponentSnapshot, type DestructionEvent, type DestructionEventType, type DestructionInstance, type DestructionOptions, type DestructionStats, type EarthquakeState, type Vec3 } from './contracts';
import { DestructionEffects } from './effects';
import { buildHouse, type HouseComponent } from './house';
import { hash } from './random';
import { HouseVisuals } from './visuals';
import { createFailureField, type LocalFailureProperties } from './failureField';

interface Piece {
  readonly definition: HouseComponent; body: RigidBody; colliders: Collider[];
  readonly previousPosition: Vector3; readonly currentPosition: Vector3;
  readonly previousRotation: Quaternion; readonly currentRotation: Quaternion;
  damage: number; failed: boolean; cracked: boolean; lastImpact: number;
  joint: ImpulseJoint | null; jointExpires: number; trailAt: number; impactStress: number;
  readonly velocityBeforeStep: Vector3;
  quietTime: number;
  failureAt: number; readyToFail: boolean;
}

export class StructuralDestruction implements DestructionInstance {
  readonly root = new Group();
  private collisions: readonly CollisionGeometry[] = [];
  get collisionGeometry(): readonly CollisionGeometry[] { return this.collisions; }
  private readonly pieces: Piece[] = []; private readonly visuals: HouseVisuals;
  private readonly effects: DestructionEffects; private readonly audio: DestructionAudio;
  private readonly seed: number; private eventSeed: number;
  private readonly options: DestructionOptions;
  private readonly failureProperties: readonly LocalFailureProperties[];
  private readonly displacement = new Vector3(); private readonly lastDisplacement = new Vector3();
  private readonly velocity = new Vector3(); private readonly lastVelocity = new Vector3();
  private readonly acceleration = new Vector3(); private readonly position = new Vector3(); private readonly rotation = new Quaternion();
  private readonly zero = { x: 0, y: 0, z: 0 };
  private time = 0; private lastTime = -1; private disposed = false; private pendingStep = false;
  private updateMilliseconds = 0; private requestPending = false;
  private readonly colliderOwners = new Map<number, Piece>();
  private currentImpactCollider: Collider | null = null;
  private maxImpactImpulse = 0;
  private impactOther: Piece | null = null;
  private readonly impactPoint = new Vector3();
  // Reused callbacks: do not allocate closures for each contact in the update path.
  private readonly visitContact = (other: Collider): void => {
    const previous = this.maxImpactImpulse;
    this.world.contactPair(this.currentImpactCollider!, other, this.visitManifold);
    if (this.maxImpactImpulse > previous) this.impactOther = this.colliderOwners.get(other.handle) ?? null;
  };
  private readonly visitManifold = (manifold: RAPIER.TempContactManifold): void => {
    for (let i = 0; i < manifold.numContacts(); i++) {
      const impulse = manifold.contactImpulse(i);
      if (impulse > this.maxImpactImpulse) {
        this.maxImpactImpulse = impulse;
        if (manifold.numSolverContacts() > 0) {
          const p = manifold.solverContactPoint(0); this.impactPoint.set(p.x, p.y, p.z);
        }
      }
    }
  };

  constructor(scene: Scene, private readonly world: World, options: DestructionOptions = {}, private readonly onDispose?: () => void) {
    this.options = options; this.seed = options.seed ?? DEFAULT_EVENT_SEED; this.eventSeed = this.seed;
    const base = options.baseElevation ?? 0;
    if (!Number.isFinite(base)) throw new Error('baseElevation must be finite.');
    for (const [label, value, limit] of [['fragmentCapacity', options.fragmentCapacity ?? 1400, 8192], ['dustCapacity', options.dustCapacity ?? 320, 2048]] as const) {
      if (!Number.isInteger(value) || value < 1 || value > limit) throw new Error(`${label} must be an integer in 1..${limit}.`);
    }
    const blueprint = buildHouse(this.seed, base);
    this.failureProperties = createFailureField(blueprint.components, this.seed, base).properties;
    const collisionGeometry: CollisionGeometry[] = [];
    for (const definition of blueprint.components) {
      const { body, colliders } = this.createPhysics(definition);
      const piece: Piece = { definition, body, colliders,
        previousPosition: definition.position.clone(), currentPosition: definition.position.clone(),
        previousRotation: definition.rotation.clone(), currentRotation: definition.rotation.clone(),
        damage: 0, failed: false, cracked: false, lastImpact: -100, joint: null, jointExpires: 0, trailAt: 0, impactStress: 0,
        velocityBeforeStep: new Vector3(),
        quietTime: 0,
        failureAt: Infinity, readyToFail: false,
      };
      this.pieces.push(piece);
      for (const collider of colliders) { collisionGeometry.push({ componentId: definition.id, kind: definition.kind, body, collider }); this.colliderOwners.set(collider.handle, piece); }
    }
    this.collisions = Object.freeze(collisionGeometry);
    this.visuals = new HouseVisuals(blueprint, this.seed);
    this.effects = new DestructionEffects(this.seed, options.fragmentCapacity ?? 1400, options.dustCapacity ?? 320, options.sampleGroundHeight ?? (() => base));
    this.audio = new DestructionAudio(this.seed, options.audio ?? true, options.audioContext);
    this.root.name = 'mudquake-destruction'; this.root.add(this.visuals.root, this.effects.root); scene.add(this.root);
  }

  private createPhysics(definition: HouseComponent): { body: RigidBody; colliders: Collider[] } {
    const descriptor = RigidBodyDesc.kinematicPositionBased().setTranslation(definition.position.x, definition.position.y, definition.position.z)
      .setRotation(definition.rotation).setLinearDamping(0.35).setAngularDamping(0.8).setCanSleep(true).setCcdEnabled(true);
    const body = this.world.createRigidBody(descriptor);
    body.userData = { module: 'mudquake-destruction', componentId: definition.id, kind: definition.kind };
    const h = definition.halfExtents;
    const shapes: ColliderDesc[] = definition.colliderBoxes
      ? definition.colliderBoxes.map(b => {
        const s = ColliderDesc.cuboid(b.size.x / 2, b.size.y / 2, b.size.z / 2).setTranslation(b.position.x, b.position.y, b.position.z);
        if (b.rotation) s.setRotation(b.rotation);
        return s;
      })
      : [definition.hull ? ColliderDesc.convexHull(definition.hull)! : ColliderDesc.cuboid(h.x, h.y, h.z)];
    if (shapes.some(s => !s)) throw new Error(`Invalid collision hull for component ${definition.id}.`);
    const colliders = shapes.map(shape => this.world.createCollider(shape.setDensity(definition.density).setFriction(definition.kind === 'roof' ? 0.57 : 0.79)
      .setRestitution(0.025), body));
    return { body, colliders };
  }

  updateDestruction(fixedDeltaTime: number, state: EarthquakeState): void {
    this.assertAlive();
    if (Math.abs(fixedDeltaTime - FIXED_DELTA_TIME) > 1e-8) throw new Error('Destruction requires a fixed timestep of 1/60 s.');
    if (this.pendingStep) throw new Error('Call world.step() and syncVisuals() between destruction updates.');
    if (!Number.isFinite(state.elapsedTime) || state.elapsedTime < 0 || state.elapsedTime < this.lastTime - 1e-8
      || !Number.isFinite(state.intensity) || state.intensity < 0 || state.intensity > 1
      || !Number.isFinite(state.groundDisplacement.x) || !Number.isFinite(state.groundDisplacement.y) || !Number.isFinite(state.groundDisplacement.z)) {
      throw new Error('Invalid earthquake state or clock moved backwards; call resetDestruction() before replay.');
    }
    const start = performance.now(); this.time = state.elapsedTime; this.lastTime = this.time; this.eventSeed = state.eventSeed;
    this.displacement.set(state.groundDisplacement.x, state.groundDisplacement.y, state.groundDisplacement.z);
    this.velocity.copy(this.displacement).sub(this.lastDisplacement).multiplyScalar(1 / fixedDeltaTime);
    this.acceleration.copy(this.velocity).sub(this.lastVelocity).multiplyScalar(1 / fixedDeltaTime);
    // Sudden user timeline scrubbing must not generate unbounded impulses.
    this.velocity.clampLength(0, 4); this.acceleration.clampLength(0, 35);
    this.lastDisplacement.copy(this.displacement); this.lastVelocity.copy(this.velocity);
    const shaking = state.phase !== 'idle' && state.intensity > 0;
    const lateralLoad = Math.hypot(this.acceleration.x, this.acceleration.z) / 9.81;
    for (const piece of this.pieces) {
      piece.previousPosition.copy(piece.currentPosition); piece.previousRotation.copy(piece.currentRotation);
      if (piece.failed && piece.body.isDynamic()) {
        const v = piece.body.linvel(); piece.velocityBeforeStep.set(v.x, v.y, v.z);
        const w = piece.body.angvel();
        if (state.phase === 'aftermath' && state.intensity < 0.01 && v.x * v.x + v.y * v.y + v.z * v.z < 0.0064
          && w.x * w.x + w.y * w.y + w.z * w.z < 0.0225) piece.quietTime += fixedDeltaTime;
        else piece.quietTime = 0;
        // Rapier's default island sleep can be held awake by tiny contact jitter in a large rubble pile.
        // Use a conservative sustained velocity threshold; later physical collisions can wake it normally.
        if (piece.quietTime > 0.75) piece.body.sleep();
      }
      if (piece.joint && (this.time >= piece.jointExpires || this.jointSupportFailed(piece))) this.removeJoint(piece);
      const d = piece.definition;
      if (!piece.failed) {
        // Sub-millimetre residual motion must not keep the entire rubble island awake forever.
        const rest = state.phase === 'aftermath' && state.intensity < 0.01 && this.displacement.lengthSq() < 1e-6;
        if (rest) {
          if (!piece.body.isFixed()) piece.body.setBodyType(RigidBodyType.Fixed, false);
        } else {
          if (!piece.body.isKinematic()) piece.body.setBodyType(RigidBodyType.KinematicPositionBased, true);
          this.position.copy(d.position).add(this.displacement);
          piece.body.setNextKinematicTranslation(this.position);
        }
        if (d.permanent) continue;
        if (shaking || piece.impactStress > 0) {
          let remaining = 0;
          for (const id of d.supportIds) { const s = this.pieces[id]!; remaining += s.failed ? 0 : 1 - Math.max(0, s.damage - 0.7) * 1.3; }
          const supported = d.supportIds.length ? remaining / d.supportIds.length : 1;
          let neighbors = 0;
          for (const id of d.neighborIds) if (this.pieces[id]!.failed) neighbors++;
          const heightAmplification = 0.68 + Math.max(0, d.position.y - (this.options.baseElevation ?? 0)) * 0.09;
          const vulnerability = d.kind === 'glass' ? 2.6 : d.kind === 'chimney' ? 1.6 : d.kind === 'wall' ? 1.12 : d.kind === 'post' ? 0.72 : 0.75;
          const local = this.failureProperties[d.id]!;
          const activation = Math.min(1, Math.max(0, (this.time - local.onset) / 1.4));
          const localDemand = 0.12 + local.cornerWeakness + activation * activation * (3 - 2 * activation) * local.lateDemand;
          const demand = state.intensity * (0.13 + lateralLoad * 0.095) * heightAmplification * vulnerability * localDemand;
          const lostSupport = (1 - supported) * (d.kind === 'roof' || d.kind === 'floor' ? 1.1 : 0.85) * local.propagation;
          const fatigue = local.fatigue / d.strength;
          const previousDamage = piece.damage;
          piece.damage = Math.min(1, piece.damage + fixedDeltaTime * (demand * fatigue + lostSupport + neighbors * 0.017 * local.propagation) + piece.impactStress);
          piece.impactStress = 0;
          if (!piece.cracked && piece.damage >= 0.22) {
            piece.cracked = true; this.visuals.setDamage(d.id, piece.damage); this.emit('crack', piece, piece.damage);
          }
          if (d.kind === 'wall' && piece.cracked) {
            this.visuals.setDamage(d.id, piece.damage);
            if ((previousDamage < 0.48 && piece.damage >= 0.48) || (previousDamage < 0.72 && piece.damage >= 0.72)
              || (previousDamage < 0.9 && piece.damage >= 0.9)) this.emit('crack', piece, piece.damage);
          }
          const trusses = d.kind === 'roof' ? d.supportIds.filter(id => {
            const candidate = this.pieces[id]!.definition;
            return candidate.kind === 'beam' && candidate.halfExtents.y > 0.7 && candidate.halfExtents.z > 3;
          }) : null;
          const roofSupported = trusses && trusses.length > 0 && trusses.some(id => !this.pieces[id]!.failed);
          // Roof sections cannot tear away while their spanning trusses remain infinitely rigid.
          // Their rafter load path must fail first, otherwise collision recovery launches panels upward.
          if (!roofSupported && (piece.damage >= 1 || (supported < 0.15 && piece.damage > 0.3))) {
            if (!Number.isFinite(piece.failureAt)) piece.failureAt = this.time + local.delay;
            piece.readyToFail = this.time >= piece.failureAt;
          } else piece.readyToFail = false;
        }
      }
    }
    // Commit after evaluating every load path. A facade's component ID order must
    // not allow an entire row to cascade instantaneously within a single step.
    for (const piece of this.pieces) if (!piece.failed && piece.readyToFail) this.fail(piece);
    this.effects.update(fixedDeltaTime); this.audio.update(state); this.pendingStep = true;
    this.updateMilliseconds = performance.now() - start;
  }

  syncVisuals(alpha = 1): void {
    this.assertAlive();
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) throw new Error('Interpolation alpha must be in 0..1.');
    for (const piece of this.pieces) {
      if (this.pendingStep) {
        const p = piece.body.translation(), q = piece.body.rotation();
        piece.currentPosition.set(p.x, p.y, p.z); piece.currentRotation.set(q.x, q.y, q.z, q.w);
        if (piece.failed && piece.definition.kind !== 'glass' && piece.body.isDynamic() && !piece.body.isSleeping()) {
          this.inspectImpact(piece);
          if (this.time >= piece.trailAt && piece.body.linvel().y < -1.4) {
            this.effects.emitDust(piece.currentPosition, 0.12); piece.trailAt = this.time + 0.22;
          }
        }
      }
      this.position.lerpVectors(piece.previousPosition, piece.currentPosition, alpha);
      this.rotation.slerpQuaternions(piece.previousRotation, piece.currentRotation, alpha);
      this.visuals.setTransform(piece.definition.id, this.position, this.rotation);
    }
    this.pendingStep = false;
  }

  private fail(piece: Piece): void {
    const d = piece.definition; piece.failed = true; piece.damage = 1;
    this.visuals.setDamage(d.id, 1, d.kind === 'glass');
    if (d.kind === 'glass') {
      piece.body.setEnabled(false); this.emit('glass', piece, 0.45); return;
    }
    piece.body.setBodyType(RigidBodyType.Dynamic, true);
    piece.body.setLinvel(this.velocity, true); piece.body.enableCcd(true);
    const mass = piece.body.mass();
    // Ground motion is inherited on release. No scripted launch or continuing airborne force.
    piece.body.setAngvel(this.zero, true);
    // Roof and timber can rotate briefly around the last nail/connection before tearing free.
    if (d.kind === 'roof' || d.kind === 'beam' || d.kind === 'floor') {
      const localAnchor = new Vector3(0, -d.halfExtents.y, 0);
      if (d.kind === 'roof') localAnchor.z = Math.sign(d.position.z) * d.halfExtents.z * 0.88;
      const worldAnchor = localAnchor.clone().applyQuaternion(piece.currentRotation).add(piece.currentPosition);
      let parentId: number | undefined, nearest = Infinity;
      for (const id of d.supportIds) {
        const candidate = this.pieces[id]!; if (candidate.failed) continue;
        const distance = candidate.currentPosition.distanceToSquared(worldAnchor);
        if (distance < nearest) { nearest = distance; parentId = id; }
      }
      if (parentId !== undefined) {
        const parent = this.pieces[parentId]!;
        const localParent = worldAnchor.clone().sub(parent.currentPosition).applyQuaternion(parent.currentRotation.clone().invert());
        const joint = this.world.createImpulseJoint(JointData.spherical(localAnchor, localParent), piece.body, parent.body, true);
        joint.setContactsEnabled(false); piece.joint = joint;
        piece.jointExpires = this.time + (d.kind === 'roof' ? 0.45 : 0.2) + hash(this.eventSeed ^ 0x4e41494c, d.id) * (d.kind === 'roof' ? 0.9 : 0.5);
      }
    }
    this.emit('failure', piece, Math.min(1, mass / 1100));
  }
  private jointSupportFailed(piece: Piece): boolean {
    if (!piece.joint) return false;
    const other = piece.joint.body2();
    return other.isDynamic();
  }
  private removeJoint(piece: Piece): void { if (piece.joint) { this.world.removeImpulseJoint(piece.joint, true); piece.joint = null; } }
  private inspectImpact(piece: Piece): void {
    if (this.time - piece.lastImpact < 0.22 || !piece.colliders[0]) return;
    const after = piece.body.linvel();
    const incomingSpeed = piece.velocityBeforeStep.length();
    const velocityChange = Math.hypot(after.x - piece.velocityBeforeStep.x, after.y - piece.velocityBeforeStep.y, after.z - piece.velocityBeforeStep.z);
    // Static support impulses carry the weight of a pile; they are not new impacts.
    if (incomingSpeed < 0.85 || velocityChange < 0.45) return;
    this.maxImpactImpulse = 0; this.impactOther = null;
    this.impactPoint.copy(piece.currentPosition);
    for (const collider of piece.colliders) { this.currentImpactCollider = collider; this.world.contactPairsWith(collider, this.visitContact); }
    const deltaVelocity = this.maxImpactImpulse / Math.max(1, piece.body.mass());
    if (deltaVelocity > 0.75) {
      piece.lastImpact = this.time;
      const energy = Math.min(1, deltaVelocity / 7);
      this.emit('impact', piece, energy, this.impactPoint);
      const other = this.impactOther as Piece | null;
      if (other && !other.failed && !other.definition.permanent) other.impactStress = Math.min(0.45, other.impactStress + energy * 0.25);
    }
  }
  private emit(type: DestructionEventType, piece: Piece | null, energy: number, position?: Vec3): void {
    const p = position ?? piece?.currentPosition ?? this.zero;
    const event: DestructionEvent = Object.freeze({ type, time: this.time, componentId: piece?.definition.id ?? -1,
      kind: piece?.definition.kind ?? 'simulation', position: Object.freeze({ x: p.x, y: p.y, z: p.z }), energy,
      seed: (this.eventSeed ^ Math.imul((piece?.definition.id ?? 0) + 1, 0x9e3779b1)) >>> 0 });
    this.effects.emit(event); this.audio.emit(event); this.options.onEvent?.(event);
  }
  triggerEarthquake(): void {
    this.assertAlive();
    if (this.requestPending) return;
    this.requestPending = true; this.emit('earthquake-request', null, 0);
  }
  resetDestruction(): void {
    this.assertAlive();
    for (const piece of this.pieces) this.removeJoint(piece);
    // Recreate owned bodies/colliders, removing their contact manifolds and cached impulses.
    // Reacquire collisionGeometry after reset; external terrain/world remains untouched.
    for (let i = this.pieces.length - 1; i >= 0; i--) this.world.removeRigidBody(this.pieces[i]!.body);
    this.colliderOwners.clear();
    const collisionGeometry: CollisionGeometry[] = [];
    for (const piece of this.pieces) {
      const d = piece.definition;
      const physics = this.createPhysics(d); piece.body = physics.body; piece.colliders = physics.colliders;
      for (const collider of piece.colliders) {
        collisionGeometry.push({ componentId: d.id, kind: d.kind, body: piece.body, collider }); this.colliderOwners.set(collider.handle, piece);
      }
      piece.damage = 0; piece.failed = piece.cracked = false; piece.lastImpact = -100; piece.trailAt = piece.impactStress = 0;
      piece.velocityBeforeStep.setScalar(0);
      piece.quietTime = 0;
      piece.failureAt = Infinity; piece.readyToFail = false;
      piece.previousPosition.copy(d.position); piece.currentPosition.copy(d.position);
      piece.previousRotation.copy(d.rotation); piece.currentRotation.copy(d.rotation);
      this.visuals.setDamage(d.id, 0); this.visuals.setTransform(d.id, d.position, d.rotation);
    }
    this.collisions = Object.freeze(collisionGeometry);
    this.displacement.setScalar(0); this.lastDisplacement.setScalar(0); this.velocity.setScalar(0); this.lastVelocity.setScalar(0); this.acceleration.setScalar(0);
    this.time = 0; this.lastTime = -1; this.pendingStep = false; this.requestPending = false; this.eventSeed = this.seed;
    this.effects.clear(); this.audio.reset(); this.emit('reset', null, 0);
  }
  async unlockAudio(): Promise<void> { this.assertAlive(); await this.audio.unlock(); }
  setListenerPosition(position: Vec3): void { this.assertAlive(); this.effects.setListenerPosition(position); this.audio.setListenerPosition(position); }
  getStats(): DestructionStats {
    this.assertAlive();
    let failed = 0, dynamicBodies = 0, awakeBodies = 0;
    for (const p of this.pieces) { if (p.failed) failed++; if (p.body.isDynamic()) { dynamicBodies++; if (!p.body.isSleeping()) awakeBodies++; } }
    return { components: this.pieces.length, failed, dynamicBodies, awakeBodies, activeFragments: this.effects.activeFragments,
      activeDust: this.effects.activeDust, drawBatches: this.visuals.drawBatches + 2, lastUpdateMilliseconds: this.updateMilliseconds };
  }
  getSnapshot(): readonly ComponentSnapshot[] {
    this.assertAlive();
    return this.pieces.map(p => ({ id: p.definition.id, kind: p.definition.kind, damage: p.damage, failed: p.failed,
      position: { x: p.currentPosition.x, y: p.currentPosition.y, z: p.currentPosition.z } }));
  }
  disposeDestruction(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const p of this.pieces) this.removeJoint(p);
    for (const p of this.pieces) this.world.removeRigidBody(p.body);
    this.colliderOwners.clear(); this.collisions = []; this.effects.dispose(); this.visuals.dispose(); this.audio.dispose(); this.root.clear(); this.root.removeFromParent();
    this.onDispose?.();
  }
  private assertAlive(): void { if (this.disposed) throw new Error('Destruction instance has been disposed.'); }
}
