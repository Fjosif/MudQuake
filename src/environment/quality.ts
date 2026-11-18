import type { QualityConfig, QualityPreset } from './types';

export const QUALITY_PRESETS: Record<QualityPreset, QualityConfig> = {
  low: {
    preset: 'low',
    terrainSegments: 160,
    textureSize: 512,
    rainCount: 4500,
    rainSplashCount: 400,
    debrisSplashPoolSize: 384,
    rockCount: 160,
    grassCount: 600,
    shadowMapSize: 1024,
    maxPixelRatio: 1.0,
    enableLightning: false,
  },
  medium: {
    preset: 'medium',
    terrainSegments: 224,
    textureSize: 1024,
    rainCount: 9000,
    rainSplashCount: 800,
    debrisSplashPoolSize: 640,
    rockCount: 320,
    grassCount: 1400,
    shadowMapSize: 2048,
    maxPixelRatio: 1.5,
    enableLightning: true,
  },
  high: {
    preset: 'high',
    terrainSegments: 320,
    textureSize: 1024,
    rainCount: 15000,
    rainSplashCount: 1400,
    debrisSplashPoolSize: 1024,
    rockCount: 520,
    grassCount: 2600,
    shadowMapSize: 2048,
    maxPixelRatio: 2.0,
    enableLightning: true,
  },
  ultra: {
    preset: 'ultra',
    terrainSegments: 420,
    textureSize: 2048,
    rainCount: 24000,
    rainSplashCount: 2200,
    debrisSplashPoolSize: 1536,
    rockCount: 800,
    grassCount: 4000,
    shadowMapSize: 4096,
    maxPixelRatio: 2.0,
    enableLightning: true,
  },
};

export function resolveQualityConfig(preset: QualityPreset = 'high'): QualityConfig {
  return QUALITY_PRESETS[preset] ?? QUALITY_PRESETS.high;
}
