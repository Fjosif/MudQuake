import * as THREE from 'three';
import { MeshPhysicalNodeMaterial } from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  cos,
  distance,
  dot,
  float,
  floor,
  Fn,
  fract,
  length,
  max,
  mix,
  normalLocal,
  normalize,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  texture,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import type { MudTextureSet } from './proceduralTextures';

export interface MudMaterialUniforms {
  uTime: { value: number };
  uRainIntensity: { value: number };
  uQuakeIntensity: { value: number };
  uGroundDisp: { value: THREE.Vector3 };
  uWaterLevel: { value: number };
}

export interface MudMaterialResult {
  material: MeshPhysicalNodeMaterial;
  uniforms: MudMaterialUniforms;
  dispose: () => void;
}

/**
 * Creates a photorealistic TSL/WGSL-compiled wet mud, gravel, and rain-rippled puddle material.
 */
export function createMudMaterial(textures: MudTextureSet): MudMaterialResult {
  const uTime = uniform(0);
  const uRainIntensity = uniform(0.85);
  const uQuakeIntensity = uniform(0);
  const uGroundDisp = uniform(new THREE.Vector3(0, 0, 0));
  const uWaterLevel = uniform(1.0);

  const material = new MeshPhysicalNodeMaterial();
  material.name = 'MudquakeWetMudMaterial';
  material.metalness = 0.0;
  material.ior = 1.333;
  material.envMapIntensity = 1.15;

  // Vertex attribute: vec4(puddleDepth, rutMask, gravelMask, erosionAO)
  const terrainData = attribute('aTerrainData', 'vec4');
  const vPuddleDepth = terrainData.x;
  const vRutMask = terrainData.y;
  const vGravelMask = terrainData.z;
  const vErosionAO = terrainData.w;

  // 3-octave world-space UVs (macro + medium clods + crisp close-up grit)
  const worldXZ = positionWorld.xz;
  const cosR = float(0.7986);
  const sinR = float(0.6018);
  const rotXZ = vec2(
    worldXZ.x.mul(cosR).sub(worldXZ.y.mul(sinR)),
    worldXZ.x.mul(sinR).add(worldXZ.y.mul(cosR))
  );

  const uvMacro = rotXZ.mul(0.068);
  const uvMed = worldXZ.mul(0.42);
  const uvMicro = rotXZ.mul(1.85);
  const uvGrav = worldXZ.mul(0.55);

  // Sample procedural mud & gravel textures across 3 scales
  const mudColMacro = texture(textures.mudAlbedo, uvMacro).rgb;
  const mudColMed = texture(textures.mudAlbedo, uvMed).rgb;
  const mudColMicro = texture(textures.mudAlbedo, uvMicro).rgb;
  const mudCol = mix(mix(mudColMacro, mudColMed, 0.58), mudColMicro, 0.34);

  const mudDetMacro = texture(textures.mudDetail, uvMacro);
  const mudDetMed = texture(textures.mudDetail, uvMed);
  const mudDetMicro = texture(textures.mudDetail, uvMicro);

  const mudRoughBase = mix(mudDetMed.r, mudDetMicro.r, 0.45);
  const mudHeightTex = mix(mix(mudDetMacro.g, mudDetMed.g, 0.6), mudDetMicro.g, 0.35);
  const mudAOTex = mix(mudDetMed.b, mudDetMicro.b, 0.45);

  const mudNormMacro = texture(textures.mudNormal, uvMacro).xyz.mul(2.0).sub(1.0);
  const mudNormMed = texture(textures.mudNormal, uvMed).xyz.mul(2.0).sub(1.0);
  const mudNormMicro = texture(textures.mudNormal, uvMicro).xyz.mul(2.0).sub(1.0);
  const mudNormTS = normalize(
    mudNormMacro.mul(0.25).add(mudNormMed.mul(0.5)).add(mudNormMicro.mul(0.45))
  );

  const gravCol = texture(textures.gravelAlbedo, uvGrav).rgb;
  const gravNormTS = texture(textures.gravelNormal, uvGrav).xyz.mul(2.0).sub(1.0);

  // Blend mud & gravel near house pad
  const gravelBlend = smoothstep(0.08, 0.75, vGravelMask);
  const baseSoilCol = mix(mudCol, gravCol, gravelBlend);
  const baseSoilNormTS = normalize(mix(mudNormTS, gravNormTS, gravelBlend));

  // Height-modulated organic puddle shoreline, strictly on flat/gentle slopes
  const flatSlope = smoothstep(0.86, 0.96, normalLocal.y);
  const effectiveDepth = vPuddleDepth.mul(uWaterLevel).mul(flatSlope).mul(0.3);
  const waterColumn = effectiveDepth.sub(float(1.0).sub(mudHeightTex).mul(0.035));
  const puddleMask = smoothstep(0.012, 0.075, waterColumn).mul(flatSlope);
  const wetShore = smoothstep(-0.04, 0.045, waterColumn.add(vRutMask.mul(0.02)));

  // Wet soil porosity darkening: crevices & puddle margins become saturated espresso-black mud
  const dampColor = baseSoilCol.mul(vErosionAO).mul(mudAOTex.mul(0.55).add(0.45));
  const wetSoilColor = dampColor.mul(mix(1.0, 0.6, wetShore));

  // Murky translucent shallow water -> opaque dark storm water in deeper basins
  const shallowDepth = smoothstep(0.02, 0.24, waterColumn);
  const deepOpacity = smoothstep(0.12, 0.62, waterColumn);
  const submergedMud = wetSoilColor.mul(0.58);
  const siltWaterTint = vec3(0.048, 0.038, 0.026);
  const deepWaterTint = vec3(0.035, 0.03, 0.022);
  const murkyWater = mix(
    mix(submergedMud, siltWaterTint, shallowDepth.mul(0.75)),
    deepWaterTint,
    deepOpacity
  );

  material.colorNode = mix(wetSoilColor, murkyWater, puddleMask);

  // Rain-roughened shallow water, with a broad reflection rather than an oily mirror.
  const rainWetBoost = uRainIntensity.mul(0.10);
  const soilRough = mudRoughBase
    .add(gravelBlend.mul(0.1))
    .sub(vRutMask.mul(0.16))
    .sub(rainWetBoost)
    .clamp(0.36, 0.88);
  const wetMudRough = mix(soilRough, float(0.32), wetShore.mul(0.45));
  const puddleRough = float(0.19).add(uRainIntensity.mul(0.025)).add(uQuakeIntensity.mul(0.035));
  material.roughnessNode = mix(wetMudRough, puddleRough, puddleMask);

  // Clearcoat water-film sheen on wet mud + natural storm-water coat on puddles
  material.clearcoatNode = mix(wetShore.mul(0.1), float(0.14), puddleMask);
  material.clearcoatRoughnessNode = mix(float(0.35), float(0.2), puddleMask);

  // 3-layer incommensurate rain ripples + wind capillary waves + earthquake slosh
  const rippleLayer = (
    scale: number,
    speed: number,
    offsetX: number,
    offsetY: number,
    ringFreq: number
  ) => {
    const p = worldXZ.mul(scale).add(vec2(offsetX, offsetY));
    const cell = floor(p);
    const f = fract(p).sub(0.5);

    const h1 = fract(sin(dot(cell, vec2(127.1, 311.7))).mul(43758.5453));
    const h2 = fract(sin(dot(cell, vec2(269.5, 183.3))).mul(43758.5453));

    const t = fract(uTime.mul(speed).add(h1));
    const center = vec2(h1.sub(0.5), h2.sub(0.5)).mul(0.32);
    const d = length(f.sub(center));
    // A short outward-moving wave packet around one drop, not concentric waves
    // filling every grid cell continuously. Centers/radii stay inside each cell.
    const radius = t.mul(0.29).add(0.025);
    const front = d.sub(radius);
    const packet = float(1).sub(front.abs().div(0.07)).max(0);
    const ring = sin(front.mul(ringFreq)).mul(packet.mul(packet))
      .mul(float(1).sub(t).pow(2))
      .mul(smoothstep(0.0, 0.08, t));
    const dir = normalize(f.sub(center).add(vec2(0.0001, 0.0001)));
    return dir.mul(ring);
  };

  const computePuddleRipple = Fn(() => {
    const r1 = rippleLayer(2.3, 0.87, 0.0, 0.0, 82.0);
    const r2 = rippleLayer(3.71, 1.13, 13.7, 7.3, 91.0).mul(0.65);

    // Subtle wind-driven capillary micro-waves across open water
    const windWaveX = sin(worldXZ.x.mul(5.1).add(worldXZ.y.mul(3.7)).add(uTime.mul(2.2))).mul(0.0025);
    const windWaveZ = cos(worldXZ.y.mul(6.3).sub(worldXZ.x.mul(2.4)).add(uTime.mul(1.7))).mul(0.0025);

    const detailFade = float(1).sub(smoothstep(12, 42, distance(cameraPosition, positionWorld)));
    const rainXY = r1.add(r2).mul(uRainIntensity).mul(0.027).mul(detailFade);

    // Earthquake-induced sloshing & Faraday capillary waves in puddles
    const quakeWaveX = sin(worldXZ.x.mul(1.7).add(worldXZ.y.mul(0.8)).add(sin(worldXZ.y.mul(0.7)).mul(0.45)).add(uTime.mul(5.3)));
    const quakeWaveZ = cos(worldXZ.y.mul(1.3).sub(worldXZ.x.mul(0.6)).add(sin(worldXZ.x.mul(0.61)).mul(0.35)).sub(uTime.mul(4.2)));
    const quakeAmp = uQuakeIntensity.mul(0.018);

    const nx = rainXY.x.add(windWaveX).add(quakeWaveX.mul(quakeAmp));
    const nz = rainXY.y.add(windWaveZ).add(quakeWaveZ.mul(quakeAmp));

    return normalize(vec3(nx, float(1.0), nz));
  });

  // Combine terrain vertex normal with high-detail tangent-space mud normal
  const mudWorldNormal = normalize(
    vec3(
      normalLocal.x.add(baseSoilNormTS.x.mul(0.45)),
      max(normalLocal.y, float(0.22)),
      normalLocal.z.add(baseSoilNormTS.y.mul(0.45))
    )
  );
  const puddleNormal = computePuddleRipple();
  // NodeMaterial normalNode is VIEW-space. Supplying an up-vector in world/local
  // space made reflections rotate with the camera and exaggerated the wave bands.
  const surfaceNormalView = transformNormalToView(normalize(mix(mudWorldNormal, puddleNormal, puddleMask)));
  material.normalNode = surfaceNormalView;
  material.clearcoatNormalNode = surfaceNormalView;

  // Subtle seismic vertex tremor on terrain during earthquake
  material.positionNode = Fn(() => {
    const pos = positionLocal.toVar();
    const seismicWave = sin(pos.x.mul(0.55).add(uTime.mul(22.0)))
      .mul(cos(pos.z.mul(0.48).sub(uTime.mul(19.0))))
      .mul(uQuakeIntensity)
      .mul(0.035);
    const dispScale = uQuakeIntensity.mul(0.35);
    pos.x.addAssign(uGroundDisp.x.mul(dispScale));
    pos.y.addAssign(seismicWave.add(uGroundDisp.y.mul(dispScale.mul(0.5))));
    pos.z.addAssign(uGroundDisp.z.mul(dispScale));
    return pos;
  })();

  return {
    material,
    uniforms: {
      uTime,
      uRainIntensity,
      uQuakeIntensity,
      uGroundDisp,
      uWaterLevel,
    },
    dispose: () => {
      material.dispose();
    },
  };
}
