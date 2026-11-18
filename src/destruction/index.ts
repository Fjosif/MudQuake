import type { Scene } from 'three';
import type { World } from '@dimforge/rapier3d-compat';
import type { DestructionInstance, DestructionOptions, EarthquakeState } from './contracts';
import { StructuralDestruction } from './engine';

export type * from './contracts';
export { DEFAULT_EVENT_SEED, DEPENDENCY_VERSIONS, FIXED_DELTA_TIME } from './contracts';
export { sampleEarthquake } from './timeline';
export { buildHouse } from './house';
export { BrowserFrameBenchmark } from './performance';

let active: DestructionInstance | null = null;
export function createDestruction(scene: Scene, physicsWorld: World, options: DestructionOptions = {}): DestructionInstance {
  if (active) throw new Error('Dispose the active destruction module before creating another.');
  active = new StructuralDestruction(scene, physicsWorld, options, () => { active = null; });
  return active;
}
export function updateDestruction(fixedDeltaTime: number, earthquakeState: EarthquakeState): void { instance().updateDestruction(fixedDeltaTime, earthquakeState); }
export function triggerEarthquake(): void { instance().triggerEarthquake(); }
export function resetDestruction(): void { instance().resetDestruction(); }
export function disposeDestruction(): void { active?.disposeDestruction(); active = null; }
function instance(): DestructionInstance { if (!active) throw new Error('Call createDestruction(scene, physicsWorld, options) first.'); return active; }
