import type { Group, Scene } from 'three';
import type { Collider, RigidBody, World } from '@dimforge/rapier3d-compat';

/** Approved 2026-11-17. Structural typing permits the shared application's type. */
export interface Vec3 { readonly x: number; readonly y: number; readonly z: number }
export type EarthquakePhase = 'idle' | 'tremor' | 'severe' | 'collapse' | 'aftermath';
export interface EarthquakeState {
  /** Seconds since the integration layer started the current event. */
  readonly elapsedTime: number;
  readonly intensity: number;
  readonly phase: EarthquakePhase;
  readonly groundDisplacement: Vec3;
  readonly eventSeed: number;
}
export type ComponentKind = 'foundation' | 'post' | 'beam' | 'wall' | 'floor' | 'roof' | 'glass' | 'door' | 'chimney';
export type DestructionEventType = 'earthquake-request' | 'crack' | 'glass' | 'failure' | 'impact' | 'reset';
/** Event vectors are immutable snapshots; safe to retain. */
export interface DestructionEvent {
  readonly type: DestructionEventType;
  readonly time: number;
  readonly componentId: number;
  readonly kind: ComponentKind | 'simulation';
  readonly position: Vec3;
  readonly energy: number;
  readonly seed: number;
}
export interface DestructionOptions {
  readonly seed?: number;
  /** Normally 0; align the environment's house pad to this elevation. */
  readonly baseElevation?: number;
  /** Called on failure, impact, cracking, reset and trigger request. */
  readonly onEvent?: (event: DestructionEvent) => void;
  /** World-space height sampler. Cosmetic fragments only; terrain needs Rapier colliders. */
  readonly sampleGroundHeight?: (x: number, z: number) => number;
  readonly audio?: boolean;
  readonly audioContext?: AudioContext;
  readonly fragmentCapacity?: number;
  readonly dustCapacity?: number;
}
export interface ComponentSnapshot {
  readonly id: number;
  readonly kind: ComponentKind;
  readonly damage: number;
  readonly failed: boolean;
  readonly position: Vec3;
}
export interface CollisionGeometry {
  readonly componentId: number;
  readonly kind: ComponentKind;
  readonly body: RigidBody;
  readonly collider: Collider;
}
export interface DestructionStats {
  readonly components: number;
  readonly failed: number;
  readonly dynamicBodies: number;
  readonly awakeBodies: number;
  readonly activeFragments: number;
  readonly activeDust: number;
  readonly drawBatches: number;
  readonly lastUpdateMilliseconds: number;
}
export interface DestructionInstance {
  readonly root: Group;
  /** Reacquire after reset. Rapier collider/body handles are invalidated when owned physics is rebuilt. */
  readonly collisionGeometry: readonly CollisionGeometry[];
  /** Call BEFORE the integrator's single world.step(), once per 1/60 s. */
  updateDestruction(fixedDeltaTime: number, state: EarthquakeState): void;
  /** Call AFTER world.step(). Interpolation alpha can be supplied by the renderer. */
  syncVisuals(alpha?: number): void;
  /** Emits earthquake-request. The integrator remains owner of time and phase. */
  triggerEarthquake(): void;
  /** Seed changes require reconstructing the instance; replay keeps the original seed. */
  resetDestruction(): void;
  disposeDestruction(): void;
  /** Call directly from a user gesture, for browser autoplay policy. */
  unlockAudio(): Promise<void>;
  setListenerPosition(position: Vec3): void;
  getStats(): DestructionStats;
  getSnapshot(): readonly ComponentSnapshot[];
}
export type CreateDestruction = (scene: Scene, physicsWorld: World, options?: DestructionOptions) => DestructionInstance;

export const FIXED_DELTA_TIME = 1 / 60;
export const DEFAULT_EVENT_SEED = 0x4d554451;
export const DEPENDENCY_VERSIONS = Object.freeze({ three: '0.187.0', rapier: '0.19.3' });
