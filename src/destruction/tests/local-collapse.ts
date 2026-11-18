import { createFixture } from './fixture';
import { createFailureField } from '../failureField';
import { buildHouse } from '../house';
for (const seed of process.argv.includes('--default') ? [0x4d554451] : [0x4d554451, 120, 42]) {
  const house = buildHouse(seed);
  const corner = createFailureField(house.components, seed, 0).corner;
  house.components.forEach(c => c.parts.forEach(p => p.geometry.dispose()));
  const fixture = await createFixture(seed);
  try {
    const stages = [];
    for (let frame = 0; frame < 1500; frame++) {
      fixture.step(frame);
      if (frame % 60 === 0) stages.push([frame / 60, fixture.module.getStats().failed]);
    }
    const structural = fixture.events.filter(e => e.type === 'failure' && (e.kind === 'wall' || e.kind === 'post') && e.position.y < 5.3);
    console.log(JSON.stringify({seed,corner,stages,first:structural.slice(0,12).map(e=>({t:e.time,kind:e.kind,x:e.position.x,y:e.position.y,z:e.position.z})),
      far: structural.find(e=>Math.hypot(e.position.x-corner.x,e.position.z-corner.z)>9),
      roof:fixture.events.filter(e=>e.type==='failure'&&e.kind==='roof').map(e=>[e.time,e.position.x,e.position.z]),
      posts:fixture.events.filter(e=>e.type==='failure'&&e.kind==='post').map(e=>[e.time,e.position.x,e.position.y,e.position.z]),
      stats:fixture.module.getStats()}));
  } finally { fixture.dispose(); }
}
