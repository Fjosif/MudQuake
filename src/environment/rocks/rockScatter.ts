import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  float,
  Fn,
  positionLocal,
  positionWorld,
  sin,
  uniform,
} from 'three/tsl';
import { fbm2D, SeededRandom, valueNoise2D } from '../math/prng';
import type { TerrainSample } from '../terrain/terrainGenerator';
import type { HouseFootprintOptions } from '../types';

export interface ScatterSystem {
  rockMesh: THREE.InstancedMesh;
  grassMesh: THREE.InstancedMesh;
  rockCount: number;
  grassCount: number;
  update: (elapsedTime: number, quakeIntensity: number) => void;
  dispose: () => void;
}

/**
 * Generates an angular fractured rock geometry (never spherical).
 */
function createRockGeometry(seed: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(0.5, 1);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n1 = valueNoise2D(v.x * 3.1 + seed, v.z * 3.1 - seed, seed + 17);
    const n2 = valueNoise2D(v.y * 4.7 - seed, v.x * 4.7 + seed, seed + 53);
    const disp = 0.72 + 0.34 * n1 + 0.18 * n2;
    v.multiplyScalar(disp);
    // Flatten bottom slightly so rock sits embedded in mud
    if (v.y < 0) {
      v.y *= 0.55;
    }
    pos.setXYZ(i, v.x, v.y, v.z);
  }

  geo.computeVertexNormals();
  return geo;
}

/**
 * Creates a small 3-blade tuft of storm-bent dead grass / reeds.
 */
function createGrassTuftGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  const bladeAngles = [0, 1.25, 2.5, 3.8, 5.1];
  const bladeHeights = [0.22, 0.29, 0.18, 0.26, 0.20];
  const bladeWidths = [0.008, 0.009, 0.007, 0.0085, 0.0075];

  for (let b = 0; b < 5; b++) {
    const ang = bladeAngles[b];
    const h = bladeHeights[b];
    const w = bladeWidths[b];
    const cx = Math.cos(ang);
    const cz = Math.sin(ang);
    const px = -cz * w;
    const pz = cx * w;
    const lean = 0.21; // Drooping under heavy rain weight

    // Two-segment curved blade (quad + drooping tip triangle)
    const x0L = -px, z0L = -pz;
    const x0R = px, z0R = pz;
    const x1L = -px * 0.5 + cx * lean * 0.38, z1L = -pz * 0.5 + cz * lean * 0.38;
    const x1R = px * 0.5 + cx * lean * 0.38, z1R = pz * 0.5 + cz * lean * 0.38;
    const xTip = cx * lean, zTip = cz * lean;

    // Tri 1
    positions.push(x0L, 0, z0L, x0R, 0, z0R, x1R, h * 0.62, z1R);
    // Tri 2
    positions.push(x0L, 0, z0L, x1R, h * 0.62, z1R, x1L, h * 0.62, z1L);
    // Tri 3 (drooping tip)
    positions.push(x1L, h * 0.62, z1L, x1R, h * 0.62, z1R, xTip, h * 0.88, zTip);

    for (let k = 0; k < 9; k++) {
      normals.push(0, 1, 0);
    }
    uvs.push(0, 0, 1, 0, 1, 0.55, 0, 0, 1, 0.55, 0, 0.55, 0, 0.55, 1, 0.55, 0.5, 1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Scatters GPU-instanced wet rocks and storm-bent grass tufts across the muddy terrain.
 */
export function createScatterSystem(
  scene: THREE.Scene,
  sampleAt: (x: number, z: number) => TerrainSample,
  getNormalAt: (x: number, z: number, target?: THREE.Vector3) => THREE.Vector3,
  seed: number,
  rockCount: number,
  grassCount: number,
  footprint?: Partial<HouseFootprintOptions>
): ScatterSystem {
  const rng = new SeededRandom(seed + 8080);
  const hw = (footprint?.halfWidth ?? 5.2) + 1.1;
  const hd = (footprint?.halfDepth ?? 4.2) + 1.1;

  // 1. Wet Rocks
  const rockGeo = createRockGeometry(seed + 19);
  const rockMat = new MeshStandardNodeMaterial();
  rockMat.name = 'MudquakeWetRockMaterial';
  rockMat.roughness = 0.26;
  rockMat.metalness = 0.04;
  rockMat.envMapIntensity = 1.1;

  const rockMesh = new THREE.InstancedMesh(rockGeo, rockMat, rockCount);
  rockMesh.name = 'MudquakeRocks';
  rockMesh.castShadow = true;
  rockMesh.receiveShadow = true;

  const dummy = new THREE.Object3D();
  const norm = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const qAlign = new THREE.Quaternion();
  const qYaw = new THREE.Quaternion();
  const col = new THREE.Color();

  let placedRocks = 0;
  let attempts = 0;
  while (placedRocks < rockCount && attempts < rockCount * 6) {
    attempts++;
    // Bias distribution toward visible foreground & mid-ground (r in 6..55m)
    const angle = rng.range(0, Math.PI * 2);
    const radius = 6.5 + Math.pow(rng.next(), 1.25) * 48.0;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;

    if (Math.abs(x) < hw && Math.abs(z) < hd) continue;

    const s = sampleAt(x, z);
    // Avoid deep puddle centers; prefer puddle banks & rut shoulders
    if (s.puddleDepth > 0.45 && rng.next() > 0.25) continue;

    getNormalAt(x, z, norm);
    qAlign.setFromUnitVectors(up, norm);
    qYaw.setFromAxisAngle(up, rng.range(0, Math.PI * 2));
    dummy.quaternion.multiplyQuaternions(qAlign, qYaw);

    const scaleBase = rng.range(0.09, 0.42) * (rng.next() > 0.88 ? 1.85 : 1.0);
    dummy.scale.set(
      scaleBase * rng.range(0.8, 1.35),
      scaleBase * rng.range(0.55, 1.0),
      scaleBase * rng.range(0.8, 1.35)
    );
    dummy.position.set(x, s.height - scaleBase * 0.14, z);
    dummy.updateMatrix();

    rockMesh.setMatrixAt(placedRocks, dummy.matrix);
    const shade = rng.range(0.045, 0.115);
    col.setRGB(shade, shade * 0.94, shade * 0.88);
    rockMesh.setColorAt(placedRocks, col);
    placedRocks++;
  }
  rockMesh.count = placedRocks;
  rockMesh.instanceMatrix.needsUpdate = true;
  if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true;
  scene.add(rockMesh);

  // 2. Storm-bent Dead Grass / Marsh Reeds
  const uTime = uniform(0);
  const uQuake = uniform(0);

  const grassGeo = createGrassTuftGeometry();
  const grassMat = new MeshStandardNodeMaterial();
  grassMat.name = 'MudquakeStormGrassMaterial';
  grassMat.roughness = 0.52;
  grassMat.metalness = 0.0;
  grassMat.side = THREE.DoubleSide;

  grassMat.positionNode = Fn(() => {
    const pos = positionLocal.toVar();
    const tipWeight = pos.y.mul(1.8).clamp(0.0, 1.0);
    const phase = positionWorld.x.mul(0.85).add(positionWorld.z.mul(0.65));
    const gust = sin(uTime.mul(3.4).add(phase)).add(sin(uTime.mul(7.1).add(phase.mul(1.7))).mul(0.35));
    const quakeJitter = sin(uTime.mul(28.0).add(phase.mul(4.0))).mul(uQuake).mul(0.12);
    // Storm wind blowing from -X, -Z toward +X, +Z
    pos.x.addAssign(tipWeight.mul(float(0.09).add(gust.mul(0.055)).add(quakeJitter)));
    pos.z.addAssign(tipWeight.mul(float(0.04).add(gust.mul(0.035))));
    return pos;
  })();

  const grassMesh = new THREE.InstancedMesh(grassGeo, grassMat, grassCount);
  grassMesh.name = 'MudquakeStormGrass';
  grassMesh.castShadow = false;
  grassMesh.receiveShadow = true;

  let placedGrass = 0;
  attempts = 0;
  while (placedGrass < grassCount && attempts < grassCount * 6) {
    attempts++;
    const angle = rng.range(0, Math.PI * 2);
    const radius = 8.0 + Math.pow(rng.next(), 1.1) * 52.0;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;

    if (Math.abs(x) < hw + 1.5 && Math.abs(z) < hd + 1.5) continue;

    const s = sampleAt(x, z);
    // No grass inside wheel ruts or deep puddles; grow in natural organic patches
    if (s.rutMask > 0.2 || s.puddleDepth > 0.15 || s.gravelMask > 0.4) continue;
    const clumpPatch = fbm2D(x * 0.16, z * 0.16, seed + 919, 3);
    if (clumpPatch < 0.04) continue;

    dummy.position.set(x, s.height - 0.02, z);
    dummy.rotation.set(
      rng.range(-0.12, 0.12),
      rng.range(0, Math.PI * 2),
      rng.range(-0.12, 0.12)
    );
    const gs = rng.range(0.65, 1.45);
    dummy.scale.set(gs, gs * rng.range(0.8, 1.3), gs);
    dummy.updateMatrix();

    grassMesh.setMatrixAt(placedGrass, dummy.matrix);
    // Muted wet olive-brown / dead reed tones (linear space)
    col.setRGB(rng.range(0.045, 0.085), rng.range(0.05, 0.082), rng.range(0.025, 0.045));
    grassMesh.setColorAt(placedGrass, col);
    placedGrass++;
  }
  grassMesh.count = placedGrass;
  grassMesh.instanceMatrix.needsUpdate = true;
  if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true;
  scene.add(grassMesh);

  const update = (elapsedTime: number, quakeIntensity: number) => {
    uTime.value = elapsedTime;
    uQuake.value = quakeIntensity;
  };

  const dispose = () => {
    scene.remove(rockMesh);
    scene.remove(grassMesh);
    rockGeo.dispose();
    rockMat.dispose();
    grassGeo.dispose();
    grassMat.dispose();
  };

  return {
    rockMesh,
    grassMesh,
    rockCount: placedRocks,
    grassCount: placedGrass,
    update,
    dispose,
  };
}
