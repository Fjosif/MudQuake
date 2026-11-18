import type * as THREE from 'three';

/**
 * Phases of the shared earthquake simulation timeline.
 */
export type EarthquakePhase = 'idle' | 'tremor' | 'severe' | 'collapse' | 'aftermath';

/**
 * Minimal 3D vector interface compatible with THREE.Vector3 and plain objects.
 */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Shared earthquake state passed by the integration layer each frame.
 */
export interface EarthquakeState {
  /** Total elapsed simulation time in seconds. */
  elapsedTime: number;
  /** Normalized earthquake intensity in [0, 1]. */
  intensity: number;
  /** Current earthquake phase. */
  phase: EarthquakePhase;
  /** Instantaneous ground displacement vector in meters. */
  groundDisplacement: Vec3Like;
  /** Deterministic seed for the current earthquake event. */
  eventSeed: number;
}

/**
 * Quality preset tiers for the environment module.
 */
export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';

/**
 * Resolved quality configuration parameters.
 */
export interface QualityConfig {
  preset: QualityPreset;
  terrainSegments: number;
  textureSize: number;
  rainCount: number;
  rainSplashCount: number;
  debrisSplashPoolSize: number;
  rockCount: number;
  grassCount: number;
  shadowMapSize: number;
  maxPixelRatio: number;
  enableLightning: boolean;
}

/**
 * House footprint reservation so terrain grades smoothly around Agent B's structure.
 */
export interface HouseFootprintOptions {
  /** Half-width along X in meters (default 5.2 for a 10m wide house). */
  halfWidth: number;
  /** Half-depth along Z in meters (default 4.2 for an 8m deep house). */
  halfDepth: number;
  /** Outer radius in meters where terrain blends back to natural hills (default 11.5). */
  blendRadius: number;
  /** Target foundation elevation Y in meters (default 0). */
  foundationY: number;
}

/**
 * Options passed to createEnvironment().
 */
export interface EnvironmentOptions {
  /** Deterministic PRNG seed (default 1337). */
  seed?: number;
  /** Quality preset (default 'high'). */
  quality?: QualityPreset;
  /** Square terrain side length in meters (default 160). */
  terrainSize?: number;
  /** Override terrain grid segments per side (defaults to quality preset). */
  terrainSegments?: number;
  /** House pad reservation options. */
  houseFootprint?: Partial<HouseFootprintOptions>;
  /** Base rain intensity in [0, 1] (default 0.85). */
  rainIntensity?: number;
  /** Exponential fog density multiplier (default 1.0). */
  fogMultiplier?: number;
  /** Enable procedural Web Audio storm/rain ambience (default false). */
  enableAudio?: boolean;
}

/**
 * Runtime diagnostics exposed by the environment module.
 */
export interface EnvironmentStats {
  quality: QualityPreset;
  terrainVertices: number;
  rainParticles: number;
  rockInstances: number;
  grassInstances: number;
  activeDebrisSplashes: number;
  lastUpdateMs: number;
}

/**
 * Optional handle returned by createEnvironment() for direct queries and debris impact events.
 */
export interface EnvironmentHandle {
  notifyDebrisImpact(position: Vec3Like, impulse: number, radius?: number): void;
  getTerrainHeightAt(x: number, z: number): number;
  getTerrainNormalAt(x: number, z: number, target?: THREE.Vector3): THREE.Vector3;
  setQuality(quality: QualityPreset): void;
  getStats(): EnvironmentStats;
  dispose(): void;
}
