import { writeFile } from 'node:fs/promises';
import { createFixture } from './fixture';
const fixture = await createFixture();
const seen = new Map<number, number>();
let maxUpward = { speed: 0, time: 0, id: -1, y: 0 };
let maxHeight = { y: 0, time: 0, id: -1, velocity: 0 };
const samples: unknown[] = [];
try {
  const roof = [...new Map(fixture.module.collisionGeometry.filter(c => c.kind === 'roof').map(c => [c.componentId, c.body])).entries()];
  for (let frame = 0; frame < 1500; frame++) {
    fixture.step(frame);
    for (const [id, body] of roof) {
      const p = body.translation(), v = body.linvel();
      if (body.isDynamic() && !seen.has(id)) seen.set(id, frame / 60);
      if (v.y > maxUpward.speed) maxUpward = { speed: v.y, time: frame / 60, id, y: p.y };
      if (p.y > maxHeight.y) maxHeight = { y: p.y, time: frame / 60, id, velocity: v.y };
      if (frame % 30 === 0) samples.push({ time: frame / 60, id, position: { x: p.x, y: p.y, z: p.z }, velocity: { x: v.x, y: v.y, z: v.z } });
    }
  }
  const report = { maxUpward, maxHeight, released: Object.fromEntries(seen), samples };
  await writeFile(new URL('../../../verification/roof-motion.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ maxUpward, maxHeight, released: Object.fromEntries(seen) }));
} finally { fixture.dispose(); }
