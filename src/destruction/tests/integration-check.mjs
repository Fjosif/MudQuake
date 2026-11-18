// Optional integration verification against Agent A's existing module; no renderer/application/RAF.
// JavaScript keeps the independent environment module's TS policy outside B's strict TS project.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import RAPIER from '@dimforge/rapier3d-compat';
import { Scene, PerspectiveCamera } from 'three';
import { createEnvironment, updateEnvironment, disposeEnvironment } from '../../environment/index.ts';
import { createDestruction, disposeDestruction, sampleEarthquake } from '../index.ts';

await RAPIER.init();
const scene = new Scene();
const camera = new PerspectiveCamera(); camera.position.set(0, 1.7, 22); scene.userData.camera = camera;
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = 1 / 60; world.numSolverIterations = 6;
let environment, destruction, maxSplashes = 0, forwardedImpacts = 0;
try {
  environment = createEnvironment(scene, null, { seed: 1337, quality: 'low', enableAudio: false });
  // This is an integrator-owned test heightfield, not production terrain creation by module B.
  const segments = 40, size = 40, heights = new Float32Array((segments + 1) ** 2);
  for (let x = 0; x <= segments; x++) for (let z = 0; z <= segments; z++) {
    heights[x * (segments + 1) + z] = environment.getTerrainHeightAt((x / segments - 0.5) * size, (z / segments - 0.5) * size);
  }
  const terrainBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.heightfield(segments, segments, heights, { x: size, y: 1, z: size }).setFriction(0.92), terrainBody);
  destruction = createDestruction(scene, world, {
    seed: 1297433681, audio: false, sampleGroundHeight: environment.getTerrainHeightAt,
    onEvent(event) {
      if (event.type !== 'impact') return;
      const height = environment.getTerrainHeightAt(event.position.x, event.position.z);
      if (Math.abs(event.position.y - height) < 0.28) {
        environment.notifyDebrisImpact(event.position, event.energy * 35, 0.2 + event.energy * 0.6);
        forwardedImpacts++;
      }
    },
  });
  for (let frame = 0; frame < 1500; frame++) {
    const state = sampleEarthquake(frame / 60, 1297433681);
    destruction.updateDestruction(1 / 60, state); world.step(); destruction.syncVisuals();
    destruction.setListenerPosition(camera.position);
    updateEnvironment(1 / 60, frame / 60, state);
    maxSplashes = Math.max(maxSplashes, environment.getStats().activeDebrisSplashes);
  }
  const stats = destruction.getStats();
  assert.ok(stats.failed > stats.components * 0.7);
  assert.ok(forwardedImpacts > 0 && maxSplashes > 0, 'ground impacts did not reach environment splash effects');
  const terrainHandle = terrainBody.handle;
  destruction.resetDestruction();
  assert.ok(world.getRigidBody(terrainHandle), 'house reset removed the shared terrain');
  assert.equal(destruction.getStats().failed, 0);
  const report = { measuredAt: new Date().toISOString(), mode: 'headless shared scene — no rendering/FPS claim',
    environmentQuality: 'low', simulatedSeconds: 25, stats, forwardedImpacts, maxSplashes, resetPreservedTerrain: true };
  console.log(JSON.stringify(report, null, 2));
  await writeFile(new URL('./integration-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
} finally {
  disposeDestruction(); disposeEnvironment();
  assert.equal(scene.children.length, 0, 'scene retained module objects after disposal');
  world.free();
}
