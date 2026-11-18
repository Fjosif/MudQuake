import * as THREE from 'three';
import { clamp, fbm2D, ridgedFbm2D, smoothstep, valueNoise2D } from '../math/prng';
import type { HouseFootprintOptions } from '../types';

export interface TerrainSample {
  height: number;
  puddleDepth: number;
  rutMask: number;
  gravelMask: number;
  erosionAO: number;
}

export interface TerrainBuildResult {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  sampleAt: (x: number, z: number) => TerrainSample;
  getHeightAt: (x: number, z: number) => number;
  getNormalAt: (x: number, z: number, target?: THREE.Vector3) => THREE.Vector3;
  vertexCount: number;
}

const DEFAULT_FOOTPRINT: HouseFootprintOptions = {
  halfWidth: 5.2,
  halfDepth: 4.2,
  blendRadius: 11.5,
  foundationY: 0,
};

/**
 * Computes the horizontal signed distance to the rounded house pad rectangle.
 */
function roundedBoxSDF(x: number, z: number, hx: number, hz: number, r: number): number {
  const qx = Math.abs(x) - (hx - r);
  const qz = Math.abs(z) - (hz - r);
  const outDist = Math.hypot(Math.max(qx, 0), Math.max(qz, 0));
  const inDist = Math.min(Math.max(qx, qz), 0);
  return outDist + inDist - r;
}

/**
 * Creates a deterministic terrain sampler for height, puddles, ruts, gravel, and AO.
 */
export function createTerrainSampler(
  seed: number,
  footprintOverrides?: Partial<HouseFootprintOptions>
): (x: number, z: number) => TerrainSample {
  const fp: HouseFootprintOptions = { ...DEFAULT_FOOTPRINT, ...footprintOverrides };

  return (x: number, z: number): TerrainSample => {
    const distFromCenter = Math.hypot(x, z);

    // 1. Domain-warped macro hills framing the rural valley
    const warpX = fbm2D(x * 0.018, z * 0.018, seed + 11, 3) * 8.0;
    const warpZ = fbm2D(x * 0.018, z * 0.018, seed + 37, 3) * 8.0;
    const wx = x + warpX;
    const wz = z + warpZ;

    const macroHills = fbm2D(wx * 0.016, wz * 0.016, seed + 71, 4);
    const valleyBowl = smoothstep(16, 68, distFromCenter);
    const ridgeDetail = ridgedFbm2D(wx * 0.032, wz * 0.032, seed + 113, 3);

    let h =
      macroHills * (1.2 + 5.5 * valleyBowl) +
      valleyBowl * (2.8 + ridgeDetail * 4.2);

    // 2. Mid-frequency muddy undulations and micro-clods
    const midUndulation = fbm2D(x * 0.09, z * 0.09, seed + 211, 3) * 0.28;
    const microClods = fbm2D(x * 0.42, z * 0.42, seed + 307, 2) * 0.055;
    h += midUndulation + microClods;

    // 3. Hydraulic erosion gullies radiating subtly in mid-ground
    const gullyNoise = Math.abs(fbm2D(wx * 0.065, wz * 0.065, seed + 409, 3));
    const gullyMask = (1.0 - smoothstep(0.0, 0.22, gullyNoise)) * smoothstep(9.0, 22.0, distFromCenter);
    h -= gullyMask * 0.34;

    // 4. Winding muddy cart/tractor ruts from foreground (z=45) toward house apron (z=6.2)
    // Centerline of the track curves gently in X as a function of Z with organic wobble
    const trackWobble = fbm2D(z * 0.18, 4.7, seed + 487, 2) * 0.5;
    const trackCenterX =
      Math.sin(z * 0.055 + 0.4) * 1.45 - 0.65 * smoothstep(10, 42, z) + trackWobble;
    const trackActive = smoothstep(6.5, 11.5, z) * (1.0 - smoothstep(32, 46, z));

    const dxTrack = x - trackCenterX;
    const halfGauge = 0.85;
    const dLeft = Math.abs(dxTrack + halfGauge);
    const dRight = Math.abs(dxTrack - halfGauge);
    const dRut = Math.min(dLeft, dRight);
    // Shallow, independently worn wheel marks. Neither wheel forms a continuous
    // metre-wide canal, and no repeated sine-wave tire lugs emboss the water.
    const leftWear = 0.12 + 0.88 * smoothstep(-0.17, 0.23, fbm2D(x * 0.38 + 8, z * 0.48, seed + 491, 2));
    const rightWear = 0.12 + 0.88 * smoothstep(-0.17, 0.23, fbm2D(x * 0.38 - 5, z * 0.43, seed + 499, 2));
    const rutWidth = 0.2 + valueNoise2D(x * 0.55, z * 0.55, seed + 497) * 0.065;
    const rutTrough = Math.max(
      (1 - smoothstep(0.035, rutWidth, dLeft)) * leftWear,
      (1 - smoothstep(0.035, rutWidth * 1.13, dRight)) * rightWear
    ) * trackActive;
    const rutBerm =
      smoothstep(0.16, 0.28, dRut) *
      (1.0 - smoothstep(0.28, 0.46, dRut)) *
      trackActive;
    const rutChurned = 0.62 + 0.38 * fbm2D(x * 1.35, z * 1.35, seed + 503, 3);
    h -= rutTrough * 0.085 * rutChurned;
    h += rutBerm * 0.022 * rutChurned;

    // Subtle track compaction between the two ruts
    const betweenRuts = (1.0 - smoothstep(0.75, 1.35, Math.abs(dxTrack))) * trackActive;
    h -= betweenRuts * 0.012;

    // Small closed depressions, rather than flooding the entire connected gully
    // network. Their shape also depresses the actual terrain/collision sampler.
    const basinNoise = fbm2D(x * 0.11, z * 0.11, seed + 613, 3);
    const poolNoise = fbm2D(x * 0.32 + warpX * 0.025, z * 0.32 + warpZ * 0.025, seed + 619, 3);
    const poolIslands = smoothstep(-0.045, -0.29, poolNoise);
    h -= poolIslands * 0.055;

    // 5. House pad grading (keeps 10x8m house foundation at fp.foundationY = 0)
    const padSdf = roundedBoxSDF(x, z, fp.halfWidth, fp.halfDepth, 0.8);
    const padFlatMask = 1.0 - smoothstep(0.0, 2.0, padSdf);
    const padBlendMask = 1.0 - smoothstep(0.5, fp.blendRadius - Math.max(fp.halfWidth, fp.halfDepth), padSdf);

    // Slight drainage slope away from foundation outside the immediate footprint
    const apronSlope = clamp(padSdf, 0, 3.0) * -0.025;
    const targetPadH = fp.foundationY + apronSlope;
    h = h * (1.0 - padBlendMask) + targetPadH * padBlendMask;
    h = h * (1.0 - padFlatMask) + fp.foundationY * padFlatMask;

    // 6. Puddle depth computation (low-lying basins + rut troughs + erosion gullies)
    // Keep puddles off the house foundation itself, but allow rich puddles in the yard & ruts!
    const outsideHouse = smoothstep(0.15, 1.3, padSdf);
    const localLow = poolIslands * (0.48 + 0.12 * smoothstep(-0.2, 0.3, basinNoise));
    const rutWater = smoothstep(0.48, 0.88, rutTrough) * poolIslands * 0.55;
    const gullyWater = smoothstep(0.78, 0.98, gullyMask) * poolIslands * 0.42;

    const rawPuddle = Math.max(rutWater, Math.max(localLow, gullyWater));
    // Restrict puddles to flat low-lying basins and ruts, never on hillside slopes
    const flatEnough = 1.0 - smoothstep(0.25, 1.5, Math.max(0, h));
    const puddleDepth = clamp(rawPuddle * outsideHouse * flatEnough, 0, 1);

    // 7. Gravel / compacted mud apron mask around the house
    const gravelNoise = valueNoise2D(x * 0.65, z * 0.65, seed + 709) * 0.25;
    const gravelMask = clamp(
      (1.0 - smoothstep(0.2, 3.4, padSdf + gravelNoise)) * outsideHouse + padFlatMask * 0.6,
      0,
      1
    );

    // 8. Erosion / crevice AO
    const erosionAO = clamp(
      1.0 - rutTrough * 0.28 - gullyMask * 0.22 + rutBerm * 0.06,
      0.45,
      1.0
    );

    return {
      height: h,
      puddleDepth,
      rutMask: clamp(rutTrough + betweenRuts * 0.35, 0, 1),
      gravelMask,
      erosionAO,
    };
  };
}

/**
 * Builds the terrain BufferGeometry and Mesh with aTerrainData vertex attribute.
 */
export function buildTerrain(
  size: number,
  segments: number,
  seed: number,
  material: THREE.Material,
  footprint?: Partial<HouseFootprintOptions>
): TerrainBuildResult {
  const sampleAt = createTerrainSampler(seed, footprint);

  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);

  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const vertexCount = posAttr.count;
  const terrainData = new Float32Array(vertexCount * 4);

  for (let i = 0; i < vertexCount; i++) {
    const x = posAttr.getX(i);
    const z = posAttr.getZ(i);
    const s = sampleAt(x, z);
    posAttr.setY(i, s.height);

    const o = i * 4;
    terrainData[o] = s.puddleDepth;
    terrainData[o + 1] = s.rutMask;
    terrainData[o + 2] = s.gravelMask;
    terrainData[o + 3] = s.erosionAO;
  }

  geometry.setAttribute('aTerrainData', new THREE.BufferAttribute(terrainData, 4));
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'MudquakeTerrain';
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  const getHeightAt = (x: number, z: number): number => sampleAt(x, z).height;

  const getNormalAt = (
    x: number,
    z: number,
    target = new THREE.Vector3()
  ): THREE.Vector3 => {
    const eps = 0.2;
    const hL = sampleAt(x - eps, z).height;
    const hR = sampleAt(x + eps, z).height;
    const hD = sampleAt(x, z - eps).height;
    const hU = sampleAt(x, z + eps).height;
    return target.set(hL - hR, 2 * eps, hD - hU).normalize();
  };

  return {
    mesh,
    geometry,
    sampleAt,
    getHeightAt,
    getNormalAt,
    vertexCount,
  };
}
