import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { createAtmosphere, type AtmosphereSystem } from './atmosphere/skyAndFog';
import { createEnvironmentAudio, type EnvironmentAudioSystem } from './audio/environmentAudio';
import { generateMudTextures, type MudTextureSet } from './materials/proceduralTextures';
import { createMudMaterial, type MudMaterialResult } from './materials/mudMaterial';
import { resolveQualityConfig } from './quality';
import { createScatterSystem, type ScatterSystem } from './rocks/rockScatter';
import { buildTerrain, type TerrainBuildResult } from './terrain/terrainGenerator';
import type {
  EarthquakeState,
  EnvironmentHandle,
  EnvironmentOptions,
  EnvironmentStats,
  QualityConfig,
  QualityPreset,
  Vec3Like,
} from './types';
import { createRainAndSplashSystem, type RainAndSplashSystem } from './weather/rainSystem';

export * from './types';
export { QUALITY_PRESETS, resolveQualityConfig } from './quality';

interface EnvironmentRuntime {
  scene: THREE.Scene;
  renderer: WebGPURenderer | THREE.WebGLRenderer | null;
  options: Required<
    Pick<EnvironmentOptions, 'seed' | 'terrainSize' | 'rainIntensity' | 'fogMultiplier' | 'enableAudio'>
  > & {
    houseFootprint?: EnvironmentOptions['houseFootprint'];
  };
  qualityConfig: QualityConfig;
  textures: MudTextureSet;
  mudMaterial: MudMaterialResult;
  terrain: TerrainBuildResult;
  atmosphere: AtmosphereSystem;
  scatter: ScatterSystem;
  rain: RainAndSplashSystem;
  audio: EnvironmentAudioSystem;
  cameraPos: THREE.Vector3;
  lastUpdateMs: number;
}

let activeRuntime: EnvironmentRuntime | null = null;

/**
 * Initializes the MUDQUAKE rainy, muddy environment in the provided Three.js scene.
 */
export function createEnvironment(
  scene: THREE.Scene,
  renderer: WebGPURenderer | THREE.WebGLRenderer | null = null,
  options: EnvironmentOptions = {}
): EnvironmentHandle {
  if (activeRuntime) {
    disposeEnvironment();
  }

  const seed = options.seed ?? 1337;
  const qualityConfig = resolveQualityConfig(options.quality ?? 'high');
  const terrainSize = options.terrainSize ?? 160;
  const terrainSegments = options.terrainSegments ?? qualityConfig.terrainSegments;
  const rainIntensity = options.rainIntensity ?? 0.85;
  const fogMultiplier = options.fogMultiplier ?? 1.0;
  const enableAudio = options.enableAudio ?? false;

  if (renderer && typeof window !== 'undefined') {
    const dpr = Math.min(window.devicePixelRatio || 1, qualityConfig.maxPixelRatio);
    renderer.setPixelRatio(dpr);
  }

  const textures = generateMudTextures(qualityConfig.textureSize, seed);
  const mudMaterial = createMudMaterial(textures);
  const terrain = buildTerrain(
    terrainSize,
    terrainSegments,
    seed,
    mudMaterial.material,
    options.houseFootprint
  );
  scene.add(terrain.mesh);

  const atmosphere = createAtmosphere(
    scene,
    renderer,
    seed,
    qualityConfig.shadowMapSize,
    fogMultiplier
  );

  const scatter = createScatterSystem(
    scene,
    terrain.sampleAt,
    terrain.getNormalAt,
    seed,
    qualityConfig.rockCount,
    qualityConfig.grassCount,
    options.houseFootprint
  );

  const rain = createRainAndSplashSystem(
    scene,
    terrain.getHeightAt,
    seed,
    qualityConfig.rainCount,
    qualityConfig.rainSplashCount,
    qualityConfig.debrisSplashPoolSize
  );

  const audio = createEnvironmentAudio(enableAudio);

  activeRuntime = {
    scene,
    renderer,
    options: {
      seed,
      terrainSize,
      rainIntensity,
      fogMultiplier,
      enableAudio,
      houseFootprint: options.houseFootprint,
    },
    qualityConfig,
    textures,
    mudMaterial,
    terrain,
    atmosphere,
    scatter,
    rain,
    audio,
    cameraPos: new THREE.Vector3(0, 1.7, 22),
    lastUpdateMs: 0,
  };

  return {
    notifyDebrisImpact,
    getTerrainHeightAt,
    getTerrainNormalAt,
    setQuality: setEnvironmentQuality,
    getStats: getEnvironmentStats,
    dispose: disposeEnvironment,
  };
}

/**
 * Updates rain, puddles, terrain tremor, lighting, and debris splashes each frame.
 */
export function updateEnvironment(
  deltaTime: number,
  elapsedTime: number,
  earthquakeState: EarthquakeState
): void {
  if (!activeRuntime) return;

  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const rt = activeRuntime;
  const dt = Math.min(Math.max(deltaTime, 0), 0.1);
  const quake = Math.min(Math.max(earthquakeState.intensity, 0), 1);

  // Allow integration layer to pass camera via scene.userData.camera
  const sceneCam = rt.scene.userData?.camera as THREE.Camera | undefined;
  if (sceneCam && 'position' in sceneCam) {
    rt.cameraPos.copy(sceneCam.position);
  }

  // Update mud & puddle shader uniforms
  const u = rt.mudMaterial.uniforms;
  u.uTime.value = elapsedTime;
  u.uRainIntensity.value = rt.options.rainIntensity;
  u.uQuakeIntensity.value = quake;
  u.uGroundDisp.value.set(
    earthquakeState.groundDisplacement.x,
    earthquakeState.groundDisplacement.y,
    earthquakeState.groundDisplacement.z
  );

  // Update atmosphere, scatter, rain, and optional audio
  rt.atmosphere.update(
    dt,
    elapsedTime,
    rt.options.rainIntensity,
    quake,
    rt.qualityConfig.enableLightning
  );
  rt.scatter.update(elapsedTime, quake);
  rt.rain.update(dt, elapsedTime, rt.cameraPos, rt.options.rainIntensity, quake);
  rt.audio.update(rt.options.rainIntensity, quake);

  if (typeof performance !== 'undefined') {
    rt.lastUpdateMs = performance.now() - t0;
  }
}

/**
 * Triggers localized mud & water splash particles where collapsing house debris hits the ground.
 */
export function notifyDebrisImpact(
  position: Vec3Like,
  impulse: number,
  radius = 0.6
): void {
  if (!activeRuntime) return;
  activeRuntime.rain.notifyDebrisImpact(position, impulse, radius);
}

/**
 * Queries the deterministic terrain height in meters at world (x, z).
 */
export function getTerrainHeightAt(x: number, z: number): number {
  if (!activeRuntime) return 0;
  return activeRuntime.terrain.getHeightAt(x, z);
}

/**
 * Queries the deterministic terrain surface normal at world (x, z).
 */
export function getTerrainNormalAt(
  x: number,
  z: number,
  target = new THREE.Vector3()
): THREE.Vector3 {
  if (!activeRuntime) return target.set(0, 1, 0);
  return activeRuntime.terrain.getNormalAt(x, z, target);
}

/**
 * Switches quality preset at runtime by rebuilding environment resources cleanly.
 */
export function setEnvironmentQuality(quality: QualityPreset): void {
  if (!activeRuntime) return;
  const { scene, renderer, options } = activeRuntime;
  disposeEnvironment();
  createEnvironment(scene, renderer, { ...options, quality });
}

/**
 * Returns current environment diagnostics and resource counts.
 */
export function getEnvironmentStats(): EnvironmentStats {
  if (!activeRuntime) {
    return {
      quality: 'high',
      terrainVertices: 0,
      rainParticles: 0,
      rockInstances: 0,
      grassInstances: 0,
      activeDebrisSplashes: 0,
      lastUpdateMs: 0,
    };
  }
  const rt = activeRuntime;
  return {
    quality: rt.qualityConfig.preset,
    terrainVertices: rt.terrain.vertexCount,
    rainParticles: rt.rain.rainCount,
    rockInstances: rt.scatter.rockCount,
    grassInstances: rt.scatter.grassCount,
    activeDebrisSplashes: rt.rain.getActiveDebrisSplashes(),
    lastUpdateMs: rt.lastUpdateMs,
  };
}

/**
 * Disposes all geometries, textures, materials, lights, and audio resources created by the environment.
 */
export function disposeEnvironment(): void {
  if (!activeRuntime) return;
  const rt = activeRuntime;
  activeRuntime = null;

  rt.scene.remove(rt.terrain.mesh);
  rt.terrain.geometry.dispose();
  rt.mudMaterial.dispose();
  rt.textures.dispose();
  rt.atmosphere.dispose();
  rt.scatter.dispose();
  rt.rain.dispose();
  rt.audio.dispose();
}
