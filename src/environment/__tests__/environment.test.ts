import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  createEnvironment,
  disposeEnvironment,
  getEnvironmentStats,
  getTerrainHeightAt,
  getTerrainNormalAt,
  notifyDebrisImpact,
  QUALITY_PRESETS,
  setEnvironmentQuality,
  updateEnvironment,
  type EarthquakeState,
} from '../index';
import { fbm2D, ridgedFbm2D, SeededRandom } from '../math/prng';
import { generateMudTextures } from '../materials/proceduralTextures';
import { createTerrainSampler } from '../terrain/terrainGenerator';

describe('MUDQUAKE Environment Module', () => {
  it('produces deterministic PRNG and noise sequences for a given seed', () => {
    const a = new SeededRandom(1337);
    const b = new SeededRandom(1337);
    for (let i = 0; i < 20; i++) {
      expect(a.next()).toBe(b.next());
    }
    expect(fbm2D(12.34, -5.67, 1337)).toBe(fbm2D(12.34, -5.67, 1337));
    expect(ridgedFbm2D(3.14, 9.81, 1337)).toBe(ridgedFbm2D(3.14, 9.81, 1337));
  });

  it('grades a flat house pad at y=0 and generates ruts and puddles outside', () => {
    const sample = createTerrainSampler(1337);

    // Inside 10x8m house footprint
    expect(Math.abs(sample(0, 0).height)).toBeLessThan(0.01);
    expect(Math.abs(sample(3.5, 2.5).height)).toBeLessThan(0.02);
    expect(Math.abs(sample(-3.5, -2.5).height)).toBeLessThan(0.02);
    expect(sample(0, 0).puddleDepth).toBe(0);

    // Sample foreground track / yard for ruts and puddles
    let maxPuddle = 0;
    let maxRut = 0;
    let rutSamples = 0, unfloodedRutSamples = 0;
    for (let z = 8; z <= 32; z += 1) {
      for (let x = -10; x <= 10; x += 0.5) {
        const s = sample(x, z);
        if (s.puddleDepth > maxPuddle) maxPuddle = s.puddleDepth;
        if (s.rutMask > maxRut) maxRut = s.rutMask;
        if (s.rutMask > 0.6) { rutSamples++; if (s.puddleDepth < 0.08) unfloodedRutSamples++; }
      }
    }
    expect(maxPuddle).toBeGreaterThan(0.25);
    expect(maxRut).toBeGreaterThan(0.4);
    // Wheel marks may cross a puddle, but must not become two continuous canals.
    expect(rutSamples).toBeGreaterThan(5);
    expect(unfloodedRutSamples / rutSamples).toBeGreaterThan(0.5);
  });

  it('generates tileable procedural PBR mud and gravel textures', () => {
    const tex = generateMudTextures(64, 1337);
    expect(tex.mudAlbedo.image.width).toBe(64);
    expect(tex.mudNormal.image.width).toBe(64);
    expect(tex.mudDetail.image.width).toBe(64);
    expect(tex.gravelAlbedo.image.width).toBe(64);
    expect(tex.gravelNormal.image.width).toBe(64);

    const normalData = tex.mudNormal.image.data as Uint8Array;
    // Average Z normal component should point upward (> 128)
    let zSum = 0;
    for (let i = 2; i < normalData.length; i += 4) {
      zSum += normalData[i];
    }
    expect(zSum / (normalData.length / 4)).toBeGreaterThan(150);
    tex.dispose();
  });

  it('initializes, updates through all earthquake phases, handles debris impacts, and disposes cleanly', () => {
    const scene = new THREE.Scene();
    const initialChildren = scene.children.length;

    const handle = createEnvironment(scene, null, {
      seed: 1337,
      quality: 'low',
      enableAudio: false,
    });

    expect(scene.children.length).toBeGreaterThan(initialChildren);
    expect(scene.fog).not.toBeNull();
    expect(scene.environment).not.toBeNull();

    const stats = getEnvironmentStats();
    expect(stats.quality).toBe('low');
    expect(stats.rainParticles).toBe(QUALITY_PRESETS.low.rainCount);
    expect(stats.terrainVertices).toBe(
      (QUALITY_PRESETS.low.terrainSegments + 1) * (QUALITY_PRESETS.low.terrainSegments + 1)
    );

    const h = getTerrainHeightAt(0, 22);
    const n = getTerrainNormalAt(0, 22);
    expect(Number.isFinite(h)).toBe(true);
    expect(Math.abs(n.length() - 1)).toBeLessThan(1e-4);

    // Trigger debris impact
    notifyDebrisImpact({ x: 2.5, y: getTerrainHeightAt(2.5, 5.5), z: 5.5 }, 18.0, 0.8);

    const phases: EarthquakeState['phase'][] = [
      'idle',
      'tremor',
      'severe',
      'collapse',
      'aftermath',
    ];
    let elapsed = 0;
    for (const phase of phases) {
      elapsed += 0.05;
      updateEnvironment(0.016, elapsed, {
        elapsedTime: elapsed,
        intensity: phase === 'idle' ? 0 : phase === 'severe' || phase === 'collapse' ? 0.9 : 0.3,
        phase,
        groundDisplacement: { x: 0.04, y: -0.02, z: 0.03 },
        eventSeed: 42,
      });
    }

    expect(getEnvironmentStats().activeDebrisSplashes).toBeGreaterThan(0);

    // Advance enough time for splashes to settle/expire
    for (let i = 0; i < 90; i++) {
      elapsed += 0.02;
      updateEnvironment(0.02, elapsed, {
        elapsedTime: elapsed,
        intensity: 0,
        phase: 'aftermath',
        groundDisplacement: { x: 0, y: 0, z: 0 },
        eventSeed: 42,
      });
    }
    expect(getEnvironmentStats().activeDebrisSplashes).toBe(0);

    // Quality switch
    setEnvironmentQuality('medium');
    expect(getEnvironmentStats().quality).toBe('medium');
    expect(getEnvironmentStats().rainParticles).toBe(QUALITY_PRESETS.medium.rainCount);

    // Clean disposal
    handle.dispose();
    disposeEnvironment(); // idempotent
    expect(scene.children.length).toBe(initialChildren);
    expect(scene.fog).toBeNull();
    expect(scene.environment).toBeNull();
  });
});
