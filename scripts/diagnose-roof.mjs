import { Scene } from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createEnvironment, disposeEnvironment } from '../src/environment/index.ts';
import { createSimulationWorld } from '../src/app/world.ts';
import { sampleEarthquake } from '../src/destruction/index.ts';
import { writeFile } from 'node:fs/promises';
await RAPIER.init();
const scene = new Scene(); createEnvironment(scene, null, { quality: 'low' });
const simulation = createSimulationWorld(scene, undefined, () => {});
const roof = [...new Map(simulation.destruction.collisionGeometry.filter(c => c.kind === 'roof').map(c => [c.componentId, c.body])).entries()];
let maxUpward = { speed: 0, time: 0, id: -1, y: 0 }, maxHeight = { y: 0, time: 0, id: -1 };
const samples = [];
try {
  for (let frame = 0; frame < 1500; frame++) {
    const state = sampleEarthquake(frame / 60); simulation.destruction.updateDestruction(1 / 60, state);
    simulation.stepPhysics(state); simulation.destruction.syncVisuals();
    for (const [id, body] of roof) {
      const p = body.translation(), v = body.linvel();
      if (v.y > maxUpward.speed) maxUpward = { speed: v.y, time: frame / 60, id, y: p.y };
      if (p.y > maxHeight.y) maxHeight = { y: p.y, time: frame / 60, id };
      if (frame % 15 === 0) samples.push({ time: frame / 60, id, y: p.y, vy: v.y });
    }
  }
  const report = { maxUpward, maxHeight, samples };
  await writeFile(new URL('../verification/roof-motion-integrated.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ maxUpward, maxHeight, stats: simulation.destruction.getStats(),
    finalRoof: simulation.destruction.getSnapshot().filter(c => c.kind === 'roof') }));
} finally { simulation.destruction.disposeDestruction(); simulation.world.free(); disposeEnvironment(); }
