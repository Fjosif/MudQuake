import { expect, test } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { PerspectiveCamera, Scene } from 'three';
import { createEnvironment, disposeEnvironment, getTerrainHeightAt } from '../../environment';
import { createSimulationWorld } from '../world';
import { Player } from '../player';
import { sampleEarthquake } from '../../destruction';

test('player collides with the intact house and can walk around either side on actual terrain', async () => {
  await RAPIER.init();
  const scene = new Scene(); createEnvironment(scene, null, { quality: 'low' });
  const audio = {} as AudioContext; // Audio is never unlocked in this headless test.
  const simulation = createSimulationWorld(scene, audio, () => {});
  const player = new Player(simulation.world, new PerspectiveCamera(), getTerrainHeightAt(0, 22));
  function walk(key: string, steps: number) {
    player.key(key, true);
    for (let i = 0; i < steps; i++) {
      simulation.destruction.updateDestruction(1 / 60, sampleEarthquake(0)); player.step(1 / 60);
      simulation.stepPhysics(sampleEarthquake(0)); simulation.destruction.syncVisuals();
    }
    player.key(key, false);
  }
  try {
    walk('KeyW', 500);
    expect(player.getPosition().z).toBeGreaterThan(4.1); expect(player.getPosition().z).toBeLessThan(4.8);
    walk('KeyD', 180); expect(player.getPosition().x).toBeGreaterThan(6);
    walk('KeyW', 260); expect(player.getPosition().z).toBeLessThan(-7);
    expect(player.getPosition().y).toBeGreaterThan(-1);
  } finally { player.dispose(); simulation.destruction.disposeDestruction(); simulation.world.free(); disposeEnvironment(); }
}, 15000);

test('roof follows support failure downward without a solver-driven upward launch', async () => {
  await RAPIER.init(); const scene = new Scene();
  createEnvironment(scene, null, { quality: 'low' });
  const simulation = createSimulationWorld(scene, {} as AudioContext, () => {});
  const initialRoof = new Map(simulation.destruction.getSnapshot().filter(p => p.kind === 'roof').map(p => [p.id, p.position.y]));
  try {
    for (let frame = 0; frame < 1500; frame++) {
      const state = sampleEarthquake(frame / 60);
      simulation.destruction.updateDestruction(1 / 60, state); simulation.stepPhysics(state); simulation.destruction.syncVisuals();
    }
    const roof = simulation.getRoofDiagnostics();
    // Secondary impacts near ground may bounce; an airborne whole roof must never be launched.
    expect(roof.peakRoofAirborneUpwardSpeed).toBeLessThan(1.5);
    expect(roof.peakRoofCenterY).toBeLessThan(6.6);
    const pieces = simulation.destruction.getSnapshot().filter(piece => piece.kind === 'roof');
    // Different ground shapes produce different rubble piles. Measure descent
    // from each panel's support height, including panels resting tilted on rubble.
    expect(pieces.every(piece => piece.failed && piece.position.y < initialRoof.get(piece.id)! - 1)).toBe(true);
    expect(pieces.filter(piece => piece.position.y < initialRoof.get(piece.id)! - 2.5).length).toBeGreaterThanOrEqual(12);
  } finally { simulation.destruction.disposeDestruction(); simulation.world.free(); disposeEnvironment(); }
}, 20000);
