import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Box3 } from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { buildHouse } from '../house';
import { polygonArea, fracturePlaster, fractureRectangle, subtractOpening } from '../geometry';
import { randomSource } from '../random';
import { sampleEarthquake } from '../timeline';
import { FIXED_DELTA_TIME } from '../contracts';
import { createFixture } from './fixture';
import { createDestruction, disposeDestruction, resetDestruction, triggerEarthquake } from '../index';
import { createFailureField } from '../failureField';

test('timeline matches the contract and is deterministic, finite and continuous at boundaries', () => {
  assert.equal(sampleEarthquake(0).phase, 'idle'); assert.equal(sampleEarthquake(3).phase, 'tremor');
  assert.equal(sampleEarthquake(6).phase, 'severe'); assert.equal(sampleEarthquake(9).phase, 'collapse');
  assert.equal(sampleEarthquake(17).phase, 'aftermath');
  assert.deepEqual(sampleEarthquake(10, 42), sampleEarthquake(10, 42));
  assert.notDeepEqual(sampleEarthquake(10, 42).groundDisplacement, sampleEarthquake(10, 43).groundDisplacement);
  for (const boundary of [3, 6, 9, 12, 17, 25]) {
    const before = sampleEarthquake(boundary - 1e-6), after = sampleEarthquake(boundary + 1e-6);
    assert.ok(Math.abs(before.intensity - after.intensity) < 0.00001);
    for (const axis of ['x', 'y', 'z'] as const) assert.ok(Math.abs(before.groundDisplacement[axis] - after.groundDisplacement[axis]) < 0.00001);
  }
  for (let i = 0; i < 1500; i++) {
    const s = sampleEarthquake(i / 60);
    assert.ok(s.intensity >= 0 && s.intensity <= 1);
    assert.ok(Math.abs(s.groundDisplacement.y) < 0.025);
    assert.ok(Object.values(s.groundDisplacement).every(Number.isFinite));
  }
});

test('Voronoi wall shards cover a continuous face without overlaps or missing area', () => {
  const polygons = fractureRectangle(-5, 0.3, 5, 5.3, randomSource(91));
  assert.ok(polygons.length > 20);
  assert.ok(Math.abs(polygons.reduce((s, p) => s + polygonArea(p), 0) - 50) < 1e-7);
  assert.ok(polygons.some(p => p.length !== 4));
});

test('window subtraction preserves uncut irregular cells and removes precisely the opening area', () => {
  const cells = fractureRectangle(-5, 0, 5, 5, randomSource(91));
  const clipped = cells.flatMap(p => subtractOpening(p, -0.7, 1, 0.7, 2.2));
  assert.ok(Math.abs(clipped.reduce((sum, p) => sum + polygonArea(p), 0) - (50 - 1.4 * 1.2)) < 1e-7);
  const untouched = cells.find(p => p.every(v => v[0] < -1))!;
  assert.deepEqual(subtractOpening(untouched, -0.7, 1, 0.7, 2.2), [untouched]);
  const fullRectangle = [[-5, 0], [5, 0], [5, 5], [-5, 5]] as const;
  assert.equal(subtractOpening(fullRectangle, -6, -1, 6, 6).length, 0);
});

test('plaster is partitioned into smaller irregular patches without holes or adding physics bodies', () => {
  const core = [[-0.6, -0.4], [0.2, -0.5], [0.65, 0.1], [0.3, 0.55], [-0.5, 0.4]] as const;
  const patches = fracturePlaster(core, randomSource(17));
  assert.ok(patches.length >= 6);
  assert.ok(Math.abs(patches.reduce((sum, p) => sum + polygonArea(p), 0) - polygonArea(core)) < 1e-7);
  assert.ok(patches.every(p => polygonArea(p) < polygonArea(core) * 0.3));
});

test('seeded structural weakness can originate at all four corners without changing the replay', () => {
  const corners = new Set<string>();
  for (let seed = 0; seed < 32; seed++) {
    const a = createFailureField([], seed, 0), b = createFailureField([], seed, 0);
    assert.deepEqual(a, b); corners.add(JSON.stringify(a.corner));
  }
  assert.equal(corners.size, 4);
});

test('house geometry is reproducible, has a bottom-up support graph and a controlled body budget', () => {
  const a = buildHouse(42), b = buildHouse(42);
  assert.equal(a.components.length, b.components.length);
  assert.ok(a.components.length <= 400, `body count: ${a.components.length}`);
  const masonry = a.components.filter(c => c.kind === 'wall' && c.parts.some(p => p.material === 'brick'));
  assert.ok(masonry.length > 200);
  assert.ok(masonry.every(c => c.parts.some(p => p.material === 'plaster' && p.detachAtDamage !== undefined)));
  const bounds = new Box3();
  for (const c of a.components) {
    const other = b.components[c.id]!;
    assert.equal(c.strength, other.strength); assert.deepEqual(c.position, other.position);
    if (!c.permanent) assert.ok(c.supportIds.length, `${c.kind} ${c.id} has no support`);
    for (const id of c.supportIds) assert.ok(a.components[id]!.position.y < c.position.y, `${c.id} has a cyclic/upward support`);
    for (const p of c.parts) {
      p.geometry.computeBoundingBox();
      const local = p.geometry.boundingBox!.clone();
      const points = [local.min.clone(), local.max.clone()];
      for (const v of points) bounds.expandByPoint(v.applyQuaternion(c.rotation).add(c.position));
      const positions = p.geometry.getAttribute('position');
      for (let i = 0; i < positions.array.length; i++) assert.ok(Number.isFinite(positions.array[i]));
      p.geometry.dispose();
    }
  }
  assert.ok(bounds.max.y < 7.7 && bounds.max.y > 7);
  assert.ok(bounds.max.x - bounds.min.x > 10);
  b.components.forEach(c => c.parts.forEach(p => p.geometry.dispose()));
});

test('intact house is stable during calm, publishes collisions and preserves caller-owned terrain', async () => {
  const f = await createFixture();
  try {
    f.run(3);
    assert.equal(f.module.getStats().failed, 0);
    assert.equal(f.module.getStats().dynamicBodies, 0);
    assert.ok(f.module.collisionGeometry.length > 150);
    const start = f.module.getSnapshot();
    assert.ok(start.every(p => Number.isFinite(p.position.y)));
    f.module.disposeDestruction(); f.module.disposeDestruction();
    assert.ok(f.world.getRigidBody(f.ground.handle)); assert.ok(f.world.getCollider(f.groundCollider.handle));
    assert.equal(f.world.bodies.len(), 1); assert.equal(f.scene.children.length, 0);
    assert.throws(() => f.module.triggerEarthquake(), /disposed/);
  } finally { f.dispose(); }
});

test('progressive structural failure produces glass, cracks, impacts and settled debris', async () => {
  const f = await createFixture();
  try {
    const timeline: Record<string, number> = {};
    let collapseDust = 0;
    for (let frame = 0; frame < 1500; frame++) {
      f.step(frame);
      if (frame >= 540 && frame <= 1020) collapseDust = Math.max(collapseDust, f.module.getStats().activeDust);
      if ([359, 539, 719, 1019, 1499].includes(frame)) timeline[((frame + 1) / 60).toString()] = f.module.getStats().failed;
    }
    const stats = f.module.getStats();
    console.log('failure-counts-at-seconds', timeline, 'final', stats);
    const types = new Set(f.events.map(e => e.type));
    for (const type of ['glass', 'crack', 'failure', 'impact']) assert.ok(types.has(type as never), `missing ${type}`);
    assert.ok(f.events.some(e => e.type === 'impact' && Math.abs(e.position.y) < 0.15), 'ground impacts must publish contact positions');
    assert.ok(timeline['9']! < timeline['17']!);
    assert.ok(stats.failed > stats.components * 0.7, 'collapse must reach the majority of the structure');
    assert.ok(collapseDust > 40 && collapseDust <= 320, `collapse dust pool: ${collapseDust}`);
    const corner = createFailureField([], 1297433681, 0).corner;
    const structure = f.events.filter(e => e.type === 'failure' && (e.kind === 'wall' || e.kind === 'post') && e.position.y < 5.3);
    const distance = (e: typeof structure[number]) => Math.hypot(e.position.x - corner.x, e.position.z - corner.z);
    assert.ok(structure.slice(0, 10).every(e => distance(e) < 3.3), 'initial damage must remain localized at one corner');
    const opposite = structure.find(e => distance(e) > 9);
    assert.ok(opposite && opposite.time > structure[0]!.time + 2.5, 'the opposite facade must not fail with the initial corner');
    const roofEvents = f.events.filter(e => e.type === 'failure' && e.kind === 'roof');
    assert.ok(roofEvents.at(-1)!.time - roofEvents[0]!.time > 1.5, 'roof release must progress across the house');
    // An island can remain awake while its bodies have settled; verify motion, not a solver flag.
    const bodies = new Map(f.module.collisionGeometry.filter(c => c.body.isDynamic()).map(c => [c.body.handle, c.body]));
    const settled = [...bodies.values()].filter(body => {
      const v = body.linvel(), w = body.angvel();
      return Math.hypot(v.x, v.y, v.z) < 0.12 && Math.hypot(w.x, w.y, w.z) < 0.2;
    }).length;
    assert.ok(settled > bodies.size * 0.8, `${settled}/${bodies.size} debris pieces settled by 25s`);
    const snapshots = f.module.getSnapshot();
    assert.ok(snapshots.every(p => Object.values(p.position).every(Number.isFinite)));
    assert.ok(snapshots.filter(p => p.failed && p.kind !== 'glass').every(p => p.position.y > -0.5), 'debris tunneled through ground');
    const roof = snapshots.filter(p => p.kind === 'roof');
    assert.ok(roof.filter(p => p.position.y < 3).length > roof.length * 0.7, 'roof must actually fall');
    assert.ok(f.world.impulseJoints.len() === 0, 'temporary connections should have torn free');
  } finally { f.dispose(); }
});

test('reset restores the complete house without touching the caller world', async () => {
  const f = await createFixture(120);
  try {
    f.run(25);
    const first = f.module.getSnapshot();
    const bodyCount = f.world.bodies.len(), colliderCount = f.world.colliders.len();
    const terrainHandle = f.ground.handle;
    f.module.resetDestruction(); f.events.length = 0;
    assert.equal(f.module.getStats().failed, 0);
    assert.equal(f.module.getStats().activeFragments, 0);
    assert.equal(f.module.getStats().activeDust, 0);
    assert.equal(f.world.bodies.len(), bodyCount); assert.equal(f.world.colliders.len(), colliderCount);
    assert.ok(f.world.getRigidBody(terrainHandle));
    f.run(3); assert.equal(f.module.getStats().failed, 0);
    f.module.resetDestruction();
    assert.equal(f.world.bodies.len(), bodyCount); assert.equal(f.world.colliders.len(), colliderCount);
    assert.ok(first.some(p => p.failed));
  } finally { f.dispose(); }
});

test('deterministic replay in identically initialized caller worlds repeats events and final poses exactly', async () => {
  const a = await createFixture(120);
  let first: ReturnType<typeof a.module.getSnapshot>;
  let events: string;
  try { a.run(25); first = a.module.getSnapshot(); events = JSON.stringify(a.events); } finally { a.dispose(); }
  const b = await createFixture(120);
  try {
    b.run(25);
    assert.ok(JSON.stringify(b.events) === events, 'event replay differs across identical caller worlds');
    assert.ok(JSON.stringify(b.module.getSnapshot()) === JSON.stringify(first), 'pose replay differs across identical caller worlds');
  } finally { b.dispose(); }
});

test('input guards and singleton exports honor ownership and fixed timestep', async () => {
  const f = await createFixture();
  try {
    assert.throws(() => f.module.updateDestruction(1 / 30, sampleEarthquake(0)), /fixed timestep/);
    assert.throws(() => f.module.updateDestruction(FIXED_DELTA_TIME, { ...sampleEarthquake(0), intensity: NaN }), /Invalid/);
    const singleton = createDestruction(f.scene, f.world, { audio: false });
    assert.throws(() => createDestruction(f.scene, f.world), /Dispose/);
    triggerEarthquake(); resetDestruction();
    singleton.disposeDestruction();
    const replacement = createDestruction(f.scene, f.world, { audio: false });
    replacement.disposeDestruction(); disposeDestruction(); disposeDestruction();
    assert.ok(!singleton.root.parent);
    assert.throws(() => triggerEarthquake(), /createDestruction/);
  } finally { disposeDestruction(); f.dispose(); }
});

test('window and doorway collision openings are hollow after glass/door failure', async () => {
  const f = await createFixture();
  try {
    const glass = f.module.collisionGeometry.find(c => c.kind === 'glass' && c.body.translation().z > 3.9)!;
    glass.body.setEnabled(false);
    f.world.step();
    const p = glass.body.translation();
    const ray = new RAPIER.Ray({ x: p.x + 0.22, y: p.y + 0.25, z: 5 }, { x: 0, y: 0, z: -1 });
    const hit = f.world.castRay(ray, 1.4, true);
    assert.equal(hit, null, 'a window frame has a solid collider filling the opening');
  } finally { f.dispose(); }
});
