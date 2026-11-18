import RAPIER from '@dimforge/rapier3d-compat';
import { Scene } from 'three';
import { StructuralDestruction } from '../engine';
import { FIXED_DELTA_TIME, type DestructionEvent } from '../contracts';
import { sampleEarthquake } from '../timeline';

/** Headless module scene, not a second application or a competing rendering loop. */
export async function createFixture(seed = 1297433681) {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DELTA_TIME;
  world.numSolverIterations = 6;
  world.integrationParameters.contact_natural_frequency = 10;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const groundCollider = world.createCollider(RAPIER.ColliderDesc.cuboid(40, 0.25, 40).setTranslation(0, -0.25, 0).setFriction(0.9), ground);
  const events: DestructionEvent[] = [], scene = new Scene();
  const module = new StructuralDestruction(scene, world, { seed, audio: false, onEvent: event => events.push(event) });
  function step(frame: number): void {
    module.updateDestruction(FIXED_DELTA_TIME, sampleEarthquake(frame * FIXED_DELTA_TIME, seed));
    world.step(); module.syncVisuals();
  }
  function run(seconds: number): void { for (let frame = 0; frame < Math.round(seconds * 60); frame++) step(frame); }
  function dispose(): void { module.disposeDestruction(); world.free(); }
  return { world, ground, groundCollider, events, scene, module, step, run, dispose };
}
