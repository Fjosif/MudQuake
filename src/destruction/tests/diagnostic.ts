import { createFixture } from './fixture';
const f = await createFixture(120);
try {
  for (let i = 0; i < 2100; i++) {
    f.step(i);
    if ([719, 1019, 1499, 2099].includes(i)) {
      const speeds: number[] = [], rotations: number[] = [];
      const ys: number[] = [];
      for (const entry of f.module.collisionGeometry) {
        if (!entry.body.isDynamic()) continue;
        const v = entry.body.linvel(), w = entry.body.angvel();
        speeds.push(Math.hypot(v.x, v.y, v.z)); rotations.push(Math.hypot(w.x, w.y, w.z)); ys.push(entry.body.translation().y);
      }
      speeds.sort((a, b) => a - b); rotations.sort((a, b) => a - b);
      console.log((i + 1) / 60, f.module.getStats(), { speed50: speeds[Math.floor(speeds.length / 2)], speed90: speeds[Math.floor(speeds.length * 0.9)], speedMax: speeds.at(-1), rotation50: rotations[Math.floor(rotations.length / 2)], rotation90: rotations[Math.floor(rotations.length * 0.9)], minY: Math.min(...ys), maxY: Math.max(...ys), impactEvents: f.events.filter(e => e.type === 'impact').length });
    }
  }
} finally { f.dispose(); }
