import RAPIER from '@dimforge/rapier3d-compat';
import type { Scene } from 'three';
import { createDestruction, DEFAULT_EVENT_SEED, FIXED_DELTA_TIME, type DestructionEvent, type EarthquakeState } from '../destruction';
import { getTerrainHeightAt, notifyDebrisImpact } from '../environment';

/** Sole production physics-world factory; reset recreates the same collider/body insertion order. */
export function createSimulationWorld(scene: Scene, audioContext: AudioContext, onEvent: (event: DestructionEvent) => void) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DELTA_TIME; world.numSolverIterations = 6;
  world.integrationParameters.contact_natural_frequency = 10;
  const segments = 160, size = 160, heights = new Float32Array((segments + 1) ** 2);
  for (let x = 0; x <= segments; x++) for (let z = 0; z <= segments; z++) {
    heights[x * (segments + 1) + z] = getTerrainHeightAt((x / segments - 0.5) * size, (z / segments - 0.5) * size);
  }
  const terrain = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
  world.createCollider(RAPIER.ColliderDesc.heightfield(segments, segments, heights, { x: size, y: 1, z: size }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES)
    .setFriction(0.92).setCollisionGroups(0x00080001), terrain);
  // Rapier's character motor can stick on a position-based kinematic heightfield.
  // A query-only fixed copy follows the same surface; collision groups isolate it from debris.
  const walkingGround = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.heightfield(segments, segments, heights, { x: size, y: 1, z: size }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES)
    .setCollisionGroups(0x00020004), walkingGround);
  const destruction = createDestruction(scene, world, {
    seed: DEFAULT_EVENT_SEED, audioContext, sampleGroundHeight: getTerrainHeightAt,
    onEvent(event) {
      if (event.type === 'impact' && Math.abs(event.position.y - getTerrainHeightAt(event.position.x, event.position.z)) < 0.28) {
        notifyDebrisImpact(event.position, event.energy * 35, 0.2 + event.energy * 0.6);
      }
      onEvent(event);
    },
  });
  for (const entry of destruction.collisionGeometry) entry.collider.setCollisionGroups(0x0001ffff);
  const roofBodies = [...new Map(destruction.collisionGeometry.filter(entry => entry.kind === 'roof').map(entry => [entry.componentId, entry.body])).values()];
  let peakRoofCenterY = 6.15, peakRoofUpwardSpeed = 0, peakRoofAirborneUpwardSpeed = 0;
  return { world, destruction, stepPhysics(state: EarthquakeState) {
    const rest = state.phase === 'aftermath' && state.intensity < 0.01;
    if (rest) { if (!terrain.isFixed()) terrain.setBodyType(RAPIER.RigidBodyType.Fixed, false); }
    else { if (!terrain.isKinematic()) terrain.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true); terrain.setNextKinematicTranslation(state.groundDisplacement); }
    if (!rest) walkingGround.setTranslation(state.groundDisplacement, false);
    world.step();
    for (const body of roofBodies) {
      const y = body.translation().y, vy = body.linvel().y;
      peakRoofCenterY = Math.max(peakRoofCenterY, y);
      peakRoofUpwardSpeed = Math.max(peakRoofUpwardSpeed, vy);
      if (y > 4) peakRoofAirborneUpwardSpeed = Math.max(peakRoofAirborneUpwardSpeed, vy);
    }
  }, getRoofDiagnostics() { return { peakRoofCenterY, peakRoofUpwardSpeed, peakRoofAirborneUpwardSpeed, contactNaturalFrequencyHz: 10 }; } };
}
