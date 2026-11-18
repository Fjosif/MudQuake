import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  attribute,
  float,
  Fn,
  fract,
  length,
  positionLocal,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { clamp, SeededRandom } from '../math/prng';
import type { Vec3Like } from '../types';

export interface RainAndSplashSystem {
  rainCount: number;
  getActiveDebrisSplashes: () => number;
  notifyDebrisImpact: (position: Vec3Like, impulse: number, radius?: number) => void;
  update: (
    deltaTime: number,
    elapsedTime: number,
    cameraPos: THREE.Vector3,
    rainIntensity: number,
    quakeIntensity: number
  ) => void;
  dispose: () => void;
}

interface DebrisParticle {
  active: boolean;
  age: number;
  life: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  size: number;
  isMudClod: boolean;
}

/**
 * Creates a 3-layer GPU storm rain system:
 * 1) Dense motion-blurred wind-swept rain streaks (inner + outer toroidal volumes)
 * 2) GPU-animated 3D vertical ground splash crowns & spray
 * 3) Ballistic debris mud clod & water splashes via notifyDebrisImpact()
 */
export function createRainAndSplashSystem(
  scene: THREE.Scene,
  getTerrainHeightAt: (x: number, z: number) => number,
  seed: number,
  rainCount: number,
  rainSplashCount: number,
  debrisSplashPoolSize: number
): RainAndSplashSystem {
  const rng = new SeededRandom(seed + 5150);
  const dummy = new THREE.Object3D();

  const uTime = uniform(0);
  const uRainIntensity = uniform(0.85);
  const uCameraPos = uniform(new THREE.Vector3(0, 1.7, 22));
  const uGust = uniform(0.0);

  // -------------------------------------------------------------------------
  // 1. GPU-driven Hyperrealistic Hair-Thin Rain Streaks
  // -------------------------------------------------------------------------
  const streakGeo = new THREE.BufferGeometry();
  const w = 0.0024;
  const h = 0.48;
  const positions = new Float32Array([
    -w, 0, 0,  w, 0, 0,  w, h, 0,
    -w, 0, 0,  w, h, 0, -w, h, 0,
    0, 0, -w,  0, 0, w,  0, h, w,
    0, 0, -w,  0, h, w,  0, h, -w,
  ]);
  const uvs = new Float32Array([
    0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1,
  ]);
  streakGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  streakGeo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

  const rainData = new Float32Array(rainCount * 4);
  for (let i = 0; i < rainCount; i++) {
    const o = i * 4;
    rainData[o] = rng.next();     // norm X
    rainData[o + 1] = rng.next(); // norm Y phase
    rainData[o + 2] = rng.next(); // norm Z
    // 75% dense near-field streaks, 25% wider mid-field streaks
    const isNear = i < rainCount * 0.75 ? 1.0 : -1.0;
    rainData[o + 3] = isNear * rng.range(0.85, 1.45);
  }
  streakGeo.setAttribute('aRainData', new THREE.InstancedBufferAttribute(rainData, 4));

  const rainMat = new MeshBasicNodeMaterial();
  rainMat.name = 'MudquakeRainStreaksMaterial';
  rainMat.transparent = true;
  rainMat.depthWrite = false;
  rainMat.side = THREE.DoubleSide;

  const aRain = attribute('aRainData', 'vec4');

  rainMat.positionNode = Fn(() => {
    const local = positionLocal.toVar();
    const isNear = aRain.w.greaterThan(0.0);
    const speedMult = aRain.w.abs();

    const boxW = isNear.select(float(18.0), float(44.0));
    const boxH = isNear.select(float(14.0), float(22.0));

    const fallSpeed = speedMult.mul(22.0);
    const fallPhase = fract(aRain.y.sub(uTime.mul(fallSpeed.div(boxH))));

    // Dynamic storm wind gusts
    const windSpeedX = float(4.2).add(uGust.mul(2.8));
    const windSpeedZ = float(1.6).add(uGust.mul(1.1));
    const windX = uTime.mul(windSpeedX);
    const windZ = uTime.mul(windSpeedZ);

    const worldX = fract(aRain.x.add(windX.sub(uCameraPos.x).div(boxW)))
      .sub(0.5)
      .mul(boxW)
      .add(uCameraPos.x);
    const worldZ = fract(aRain.z.add(windZ.sub(uCameraPos.z).div(boxW)))
      .sub(0.5)
      .mul(boxW)
      .add(uCameraPos.z);
    const worldY = fallPhase.mul(boxH).sub(1.8).add(uCameraPos.y.mul(0.25));

    // Strong wind slant along streak length
    const tipRatio = local.y.div(h);
    const slantX = float(-0.11).sub(uGust.mul(0.07));
    const slantZ = float(-0.04).sub(uGust.mul(0.025));
    local.x.addAssign(tipRatio.mul(slantX));
    local.z.addAssign(tipRatio.mul(slantZ));
    local.y.mulAssign(speedMult.mul(isNear.select(float(0.85), float(1.1))));

    return local.add(vec3(worldX, worldY, worldZ));
  })();

  rainMat.colorNode = vec3(0.55, 0.61, 0.67);
  rainMat.opacityNode = Fn(() => {
    const vUv = uv();
    const edgeFade = smoothstep(0.0, 0.35, vUv.y).mul(smoothstep(1.0, 0.5, vUv.y));
    const widthFade = smoothstep(0.0, 0.5, vUv.x).mul(smoothstep(1.0, 0.5, vUv.x));
    const nearBoost = aRain.w.greaterThan(0.0).select(float(0.17), float(0.10));
    // Subtle per-drop luminance variation
    const dropVar = float(0.65).add(fract(aRain.x.mul(73.1).add(aRain.z.mul(31.7))).mul(0.65));
    return edgeFade.mul(widthFade).mul(uRainIntensity).mul(nearBoost).mul(dropVar);
  })();

  const rainMesh = new THREE.InstancedMesh(streakGeo, rainMat, rainCount);
  rainMesh.name = 'MudquakeRainStreaks';
  rainMesh.frustumCulled = false;
  const ident = new THREE.Matrix4();
  for (let i = 0; i < rainCount; i++) {
    rainMesh.setMatrixAt(i, ident);
  }
  rainMesh.instanceMatrix.needsUpdate = true;
  scene.add(rainMesh);

  // Distant haze comes from scene fog. Large transparent sheets intersected the
  // terrain and camera, exposing a hard diagonal boundary when looking down.

  // -------------------------------------------------------------------------
  // 3. GPU-Animated Micro-Droplet Ground Impact Mist (Zero CPU loop)
  // -------------------------------------------------------------------------
  const sw = 0.018;
  const sh = 0.036;
  const splashGeo = new THREE.BufferGeometry();
  const sPos = new Float32Array([
    -sw, 0, 0,  sw, 0, 0,  sw, sh, 0,
    -sw, 0, 0,  sw, sh, 0, -sw, sh, 0,
    0, 0, -sw,  0, 0, sw,  0, sh, sw,
    0, 0, -sw,  0, sh, sw,  0, sh, -sw,
  ]);
  const sUv = new Float32Array([
    0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1,
  ]);
  splashGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
  splashGeo.setAttribute('uv', new THREE.BufferAttribute(sUv, 2));

  const splashData = new Float32Array(rainSplashCount * 4);
  for (let i = 0; i < rainSplashCount; i++) {
    const x = rng.range(-22, 22);
    const z = rng.range(-18, 28);
    const y = getTerrainHeightAt(x, z);
    const o = i * 4;
    splashData[o] = x;
    splashData[o + 1] = y;
    splashData[o + 2] = z;
    splashData[o + 3] = rng.next();
  }
  splashGeo.setAttribute('aSplashData', new THREE.InstancedBufferAttribute(splashData, 4));

  const aSplash = attribute('aSplashData', 'vec4');
  const splashMat = new MeshBasicNodeMaterial();
  splashMat.name = 'MudquakeRainSplashMaterial';
  splashMat.transparent = true;
  splashMat.depthWrite = false;
  splashMat.side = THREE.DoubleSide;

  splashMat.positionNode = Fn(() => {
    const local = positionLocal.toVar();
    const phase = fract(aSplash.w.add(uTime.mul(2.8)));
    // Pop upward quickly then collapse
    const popY = sin(phase.mul(Math.PI)).mul(1.25);
    const spreadXZ = float(0.45).add(phase.mul(1.15));
    local.x.mulAssign(spreadXZ);
    local.z.mulAssign(spreadXZ);
    local.y.mulAssign(popY);
    return local.add(aSplash.xyz);
  })();

  splashMat.colorNode = vec3(0.42, 0.47, 0.52);
  splashMat.opacityNode = Fn(() => {
    const vUv = uv();
    const phase = fract(aSplash.w.add(uTime.mul(2.8)));
    const lifeFade = smoothstep(0.0, 0.18, phase).mul(smoothstep(1.0, 0.3, phase));
    // Soft radial droplet mist (no hard rectangular corners)
    const radial = length(vUv.sub(vec2(0.5, 0.45))).mul(2.0);
    const softDisc = smoothstep(1.0, 0.15, radial);
    return softDisc.mul(lifeFade).mul(uRainIntensity).mul(0.13);
  })();

  const rainSplashMesh = new THREE.InstancedMesh(splashGeo, splashMat, rainSplashCount);
  rainSplashMesh.name = 'MudquakeRainSplashes';
  rainSplashMesh.frustumCulled = false;
  for (let i = 0; i < rainSplashCount; i++) {
    rainSplashMesh.setMatrixAt(i, ident);
  }
  rainSplashMesh.instanceMatrix.needsUpdate = true;
  scene.add(rainSplashMesh);

  // -------------------------------------------------------------------------
  // 4. Localized Debris Impact Mud Splashes (ballistic clods + water spray)
  // -------------------------------------------------------------------------
  const debrisGeo = new THREE.IcosahedronGeometry(0.06, 0);
  const debrisMat = new MeshBasicNodeMaterial();
  debrisMat.name = 'MudquakeDebrisSplashMaterial';
  debrisMat.transparent = true;
  debrisMat.opacity = 0.88;

  const debrisMesh = new THREE.InstancedMesh(debrisGeo, debrisMat, debrisSplashPoolSize);
  debrisMesh.name = 'MudquakeDebrisSplashes';
  debrisMesh.frustumCulled = false;
  debrisMesh.setColorAt(0, new THREE.Color(0x2d241c));
  debrisMesh.count = 0;

  const pool: DebrisParticle[] = Array.from({ length: debrisSplashPoolSize }, () => ({
    active: false,
    age: 0,
    life: 1,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    size: 1,
    isMudClod: true,
  }));
  let cursor = 0;
  let activeCount = 0;

  const mudColor = new THREE.Color(0x2d241c);
  const sprayColor = new THREE.Color(0x636b6e);

  const notifyDebrisImpact = (position: Vec3Like, impulse: number, radius = 0.6) => {
    const clampedImpulse = clamp(impulse, 0.2, 50.0);
    const spawnCount = Math.min(
      48,
      Math.max(10, Math.round(8 + clampedImpulse * 1.4))
    );
    const speedScale = 1.8 + Math.sqrt(clampedImpulse) * 1.15;

    for (let i = 0; i < spawnCount; i++) {
      const p = pool[cursor];
      cursor = (cursor + 1) % debrisSplashPoolSize;

      const ang = rng.range(0, Math.PI * 2);
      const rOff = rng.range(0, radius * 0.75);
      const outSpeed = rng.range(0.35, 1.0) * speedScale;

      p.active = true;
      p.age = 0;
      p.life = rng.range(0.45, 1.15);
      p.x = position.x + Math.cos(ang) * rOff;
      p.y = position.y + 0.05;
      p.z = position.z + Math.sin(ang) * rOff;
      p.vx = Math.cos(ang) * outSpeed;
      p.vy = rng.range(0.65, 1.45) * speedScale;
      p.vz = Math.sin(ang) * outSpeed;
      p.isMudClod = rng.next() > 0.42;
      p.size = p.isMudClod ? rng.range(0.6, 1.8) : rng.range(0.45, 1.15);
    }
  };

  scene.add(debrisMesh);

  const update = (
    deltaTime: number,
    elapsedTime: number,
    cameraPos: THREE.Vector3,
    rainIntensity: number,
    _quakeIntensity: number
  ) => {
    uTime.value = elapsedTime;
    uRainIntensity.value = rainIntensity;
    uCameraPos.value.copy(cameraPos);
    uGust.value = 0.5 + 0.5 * Math.sin(elapsedTime * 0.65) * Math.cos(elapsedTime * 0.29);

    rainSplashMesh.count = Math.floor(rainSplashCount * clamp(rainIntensity, 0, 1));

    // Update ballistic debris mud splashes
    let renderIdx = 0;
    for (let i = 0; i < debrisSplashPoolSize; i++) {
      const p = pool[i];
      if (!p.active) continue;

      p.age += deltaTime;
      if (p.age >= p.life) {
        p.active = false;
        continue;
      }

      p.vy -= 9.81 * deltaTime;
      p.x += p.vx * deltaTime;
      p.y += p.vy * deltaTime;
      p.z += p.vz * deltaTime;

      const groundY = getTerrainHeightAt(p.x, p.z);
      if (p.y < groundY) {
        p.y = groundY;
        p.vx *= 0.4;
        p.vz *= 0.4;
        p.vy = 0;
      }

      const lifeFade = 1.0 - p.age / p.life;
      const s = p.size * (0.4 + 0.6 * lifeFade);
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(p.age * 5.0, p.age * 3.0, 0);
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();

      debrisMesh.setMatrixAt(renderIdx, dummy.matrix);
      debrisMesh.setColorAt(renderIdx, p.isMudClod ? mudColor : sprayColor);
      renderIdx++;
    }

    activeCount = renderIdx;
    debrisMesh.count = renderIdx;
    if (renderIdx > 0) {
      debrisMesh.instanceMatrix.needsUpdate = true;
      if (debrisMesh.instanceColor) debrisMesh.instanceColor.needsUpdate = true;
    }
  };

  const dispose = () => {
    scene.remove(rainMesh);
    scene.remove(rainSplashMesh);
    scene.remove(debrisMesh);

    streakGeo.dispose();
    rainMat.dispose();
    splashGeo.dispose();
    splashMat.dispose();
    debrisGeo.dispose();
    debrisMat.dispose();
  };

  return {
    rainCount,
    getActiveDebrisSplashes: () => activeCount,
    notifyDebrisImpact,
    update,
    dispose,
  };
}
