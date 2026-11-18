import { cpus, platform, release } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { createFixture } from './fixture';
import { sampleEarthquake } from '../timeline';

function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { samples: sorted.length, meanMs: samples.reduce((a, b) => a + b, 0) / sorted.length,
    p50Ms: sorted[Math.floor(sorted.length * 0.5)], p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    p99Ms: sorted[Math.floor(sorted.length * 0.99)], maxMs: sorted.at(-1) };
}
// Warm Rapier/WASM, V8 and geometry paths once. Rendering is deliberately NOT part of this test.
const warm = await createFixture();
try { warm.run(25); } finally { warm.dispose(); }
const update: number[] = [], physics: number[] = [], sync: number[] = [], total: number[] = [];
const stages: Record<string, number[]> = { calm: [], tremor: [], severe: [], failure: [], collapse: [], aftermath: [] };
let finalStats, vertices = 0, maxDynamic = 0, maxAwake = 0;
for (let repeat = 0; repeat < 3; repeat++) {
  const f = await createFixture();
  try {
    f.module.root.traverse((object: any) => { if (repeat === 0 && object.geometry) vertices += object.geometry.getAttribute('position')?.count ?? 0; });
    for (let frame = 0; frame < 1500; frame++) {
      // Fixture splits the real integration order for separate timing without a new application.
      const t = frame / 60, state = sampleEarthquake(t, 1297433681);
      const begin = performance.now(); f.module.updateDestruction(1 / 60, state); const afterUpdate = performance.now();
      f.world.step(); const afterPhysics = performance.now(); f.module.syncVisuals(); const afterSync = performance.now();
      update.push(afterUpdate - begin); physics.push(afterPhysics - afterUpdate); sync.push(afterSync - afterPhysics); total.push(afterSync - begin);
      const stage = t < 3 ? 'calm' : t < 6 ? 'tremor' : t < 9 ? 'severe' : t < 12 ? 'failure' : t < 17 ? 'collapse' : 'aftermath';
      stages[stage]!.push(afterSync - begin);
      const stats = f.module.getStats(); maxDynamic = Math.max(maxDynamic, stats.dynamicBodies); maxAwake = Math.max(maxAwake, stats.awakeBodies);
    }
    finalStats = f.module.getStats();
  } finally { f.dispose(); }
}
const report = {
  measuredAt: new Date().toISOString(), kind: 'headless CPU only — no browser, rendering, GPU timing or FPS claim',
  runtime: process.version, platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model,
  dependencies: { three: '0.187.0', rapier: '0.19.3' }, fixedTimestep: 1 / 60, seed: 1297433681,
  repeats: 3, simulatedSecondsPerRepeat: 25, worldSolverIterations: 6, contactNaturalFrequencyHz: 10,
  update: summarize(update), physics: summarize(physics), sync: summarize(sync), combined: summarize(total),
  stages: Object.fromEntries(Object.entries(stages).map(([stage, samples]) => [stage, summarize(samples)])),
  finalStats, maxDynamic, maxAwake, allocatedGeometryVertices: vertices,
  caveats: ['WebGPU shader compilation and visual quality unverified.', 'Draw batches are scene objects, not a measured GPU draw-call count.', '1440p/60 FPS on RTX 4090 requires profiling the shared browser application.'],
};
await writeFile(new URL('./benchmark-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
