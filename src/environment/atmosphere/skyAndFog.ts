import * as THREE from 'three';
import { MeshBasicNodeMaterial, type Node, type WebGPURenderer } from 'three/webgpu';
import {
  clamp,
  dot,
  float,
  floor,
  Fn,
  fract,
  mix,
  normalize,
  positionLocal,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { fbm2D, SeededRandom } from '../math/prng';

export interface AtmosphereSystem {
  skyMesh: THREE.Mesh;
  hemiLight: THREE.HemisphereLight;
  sunLight: THREE.DirectionalLight;
  rimLight: THREE.DirectionalLight;
  fog: THREE.FogExp2;
  envTexture: THREE.DataTexture;
  update: (
    deltaTime: number,
    elapsedTime: number,
    rainIntensity: number,
    quakeIntensity: number,
    enableLightning: boolean
  ) => void;
  setShadowMapSize: (size: number) => void;
  dispose: () => void;
}

/**
 * Generates an equirectangular overcast storm sky DataTexture for physically-based
 * puddle and wet-mud reflections without requiring a separate GPU PMREM pass.
 */
function generateOvercastEnvTexture(seed: number): THREE.DataTexture {
  const width = 512;
  const height = 256;
  const data = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    const theta = (1.0 - v) * Math.PI; // 0 = zenith, PI = nadir
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);

    for (let x = 0; x < width; x++) {
      const u = x / width;
      const phi = u * Math.PI * 2;
      const dx = sinT * Math.cos(phi);
      const dz = sinT * Math.sin(phi);

      const idx = (y * width + x) * 4;

      if (cosT >= -0.05) {
        // Upper hemisphere: high-contrast turbulent overcast storm clouds + bright cloud break
        const projX = dx / Math.max(0.14, cosT + 0.22);
        const projZ = dz / Math.max(0.14, cosT + 0.22);
        const c1 = fbm2D(projX * 1.5, projZ * 1.5, seed + 901, 5) * 0.5 + 0.5;
        const c2 = fbm2D(projX * 4.2 + 3.1, projZ * 4.2 - 1.7, seed + 1201, 3) * 0.5 + 0.5;
        const cloud = Math.min(1, Math.max(0, c1 * 0.72 + c2 * 0.28));
        const cloudContrast = Math.pow(cloud, 1.25);

        const horizonBlend = 1.0 - Math.min(1, Math.max(0, (cosT + 0.05) / 0.30));

        // Realistic overcast storm cloud palette (no harsh sun hotspot)
        let r = 30 + cloudContrast * 92;
        let g = 37 + cloudContrast * 102;
        let b = 46 + cloudContrast * 114;

        // Blend toward fog horizon color (#2d3540 -> 45, 53, 64)
        r = r * (1 - horizonBlend) + 45 * horizonBlend;
        g = g * (1 - horizonBlend) + 53 * horizonBlend;
        b = b * (1 - horizonBlend) + 64 * horizonBlend;

        data[idx] = Math.min(255, Math.max(0, Math.round(r)));
        data[idx + 1] = Math.min(255, Math.max(0, Math.round(g)));
        data[idx + 2] = Math.min(255, Math.max(0, Math.round(b)));
        data[idx + 3] = 255;
      } else {
        // Lower hemisphere: dark wet mud bounce
        data[idx] = 22;
        data[idx + 1] = 19;
        data[idx + 2] = 16;
        data[idx + 3] = 255;
      }
    }
  }

  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Creates the overcast storm sky dome, atmospheric lighting, fog, and reflection map.
 */
export function createAtmosphere(
  scene: THREE.Scene,
  renderer: WebGPURenderer | THREE.WebGLRenderer | null,
  seed: number,
  shadowMapSize: number,
  fogMultiplier: number
): AtmosphereSystem {
  const prevFog = scene.fog;
  const prevEnv = scene.environment;
  const prevBg = scene.background;
  const prevToneMapping = renderer ? renderer.toneMapping : THREE.NoToneMapping;
  const prevExposure = renderer ? renderer.toneMappingExposure : 1.0;

  if (renderer) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    if ('shadowMap' in renderer && renderer.shadowMap) {
      renderer.shadowMap.enabled = true;
    }
  }

  const fogColor = new THREE.Color(0x2d3540);
  const baseFogDensity = 0.0165 * fogMultiplier;
  const fog = new THREE.FogExp2(fogColor.getHex(), baseFogDensity);
  scene.fog = fog;
  scene.background = fogColor.clone();

  const envTexture = generateOvercastEnvTexture(seed);
  scene.environment = envTexture;

  // Procedural Overcast Sky Dome (TSL -> WGSL)
  const uTime = uniform(0);
  const uLightning = uniform(0);
  const uRain = uniform(0.85);

  const skyGeo = new THREE.SphereGeometry(240, 32, 20);
  const skyMat = new MeshBasicNodeMaterial();
  skyMat.side = THREE.BackSide;
  skyMat.depthWrite = false;
  skyMat.fog = false;

  const hash2 = (p: Node<'vec2'>) =>
    fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));

  const noise2 = (p: Node<'vec2'>) => {
    const i = floor(p);
    const f = fract(p);
    const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
    const a = hash2(i);
    const b = hash2(i.add(vec2(1.0, 0.0)));
    const c = hash2(i.add(vec2(0.0, 1.0)));
    const d = hash2(i.add(vec2(1.0, 1.0)));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  };

  skyMat.colorNode = Fn(() => {
    const dir = normalize(positionLocal);
    const elev = clamp(dir.y, 0.0, 1.0);
    const cloudUV = dir.xz.div(elev.add(0.22)).mul(1.65);
    const drift = vec2(uTime.mul(0.018), uTime.mul(0.008));

    const n1 = noise2(cloudUV.add(drift));
    const n2 = noise2(cloudUV.mul(2.3).sub(drift.mul(1.4)));
    const n3 = noise2(cloudUV.mul(5.1).add(drift.mul(0.7)));
    const clouds = n1.mul(0.55).add(n2.mul(0.3)).add(n3.mul(0.15));

    const darkCloud = vec3(0.085, 0.105, 0.13);
    const midCloud = vec3(0.20, 0.235, 0.28);
    const brightBreak = vec3(0.36, 0.40, 0.45);

    const cloudTone = mix(darkCloud, midCloud, smoothstep(0.25, 0.65, clouds));
    const skyBase = mix(cloudTone, brightBreak, smoothstep(0.65, 0.92, clouds).mul(float(1.0).sub(uRain.mul(0.45))));

    // Subtle sheet lightning glow inside cloud deck
    const lightningGlow = vec3(0.55, 0.65, 0.85).mul(uLightning).mul(smoothstep(0.35, 0.85, clouds));
    const litSky = skyBase.add(lightningGlow);

    // Seamless blend into exponential fog color at the horizon
    const horizonMist = vec3(0.176, 0.208, 0.251);
    const horizonMask = smoothstep(0.0, 0.26, elev);
    return mix(horizonMist, litSky, horizonMask);
  })();

  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  skyMesh.name = 'MudquakeStormSky';
  skyMesh.frustumCulled = false;
  scene.add(skyMesh);

  // Storm lighting: overcast sky dome IBL + hemisphere wrap + ultra-soft shadow key (no harsh sun glare)
  const hemiLight = new THREE.HemisphereLight(0x8899aa, 0x201a14, 1.65);
  hemiLight.name = 'MudquakeHemiLight';
  scene.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(0x9fb0c0, 0.28);
  sunLight.name = 'MudquakeStormKeyLight';
  sunLight.position.set(-22, 34, 18);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  sunLight.shadow.camera.near = 2;
  sunLight.shadow.camera.far = 95;
  sunLight.shadow.camera.left = -28;
  sunLight.shadow.camera.right = 28;
  sunLight.shadow.camera.top = 28;
  sunLight.shadow.camera.bottom = -28;
  sunLight.shadow.bias = -0.0005;
  sunLight.shadow.normalBias = 0.025;
  scene.add(sunLight);

  const rimLight = new THREE.DirectionalLight(0x526478, 0.5);
  rimLight.name = 'MudquakeStormRimLight';
  rimLight.position.set(18, 12, -24);
  scene.add(rimLight);

  // Deterministic lightning state
  const rng = new SeededRandom(seed + 4242);
  let nextLightningIn = rng.range(6.0, 14.0);
  let lightningEnvelope = 0;

  const update = (
    deltaTime: number,
    elapsedTime: number,
    rainIntensity: number,
    quakeIntensity: number,
    enableLightning: boolean
  ) => {
    uTime.value = elapsedTime;
    uRain.value = rainIntensity;

    if (enableLightning) {
      nextLightningIn -= deltaTime;
      if (nextLightningIn <= 0) {
        lightningEnvelope = 1.0;
        nextLightningIn = rng.range(7.0, 18.0);
      }
      lightningEnvelope = Math.max(0, lightningEnvelope - deltaTime * 4.5);
      // Double-flicker envelope
      const flicker =
        lightningEnvelope > 0
          ? lightningEnvelope * (0.65 + 0.35 * Math.sin(elapsedTime * 55.0))
          : 0;
      uLightning.value = flicker;
      sunLight.intensity = 0.28 + flicker * 1.6;
      hemiLight.intensity = 1.65 + flicker * 0.55;
    } else {
      uLightning.value = 0;
      sunLight.intensity = 0.28;
      hemiLight.intensity = 1.65;
    }

    // Subtle fog thickening during rain & earthquake dust/mist
    fog.density = baseFogDensity * (0.85 + rainIntensity * 0.25 + quakeIntensity * 0.3);
  };

  const setShadowMapSize = (size: number) => {
    sunLight.shadow.mapSize.set(size, size);
    if (sunLight.shadow.map) {
      sunLight.shadow.map.dispose();
      sunLight.shadow.map = null;
    }
  };

  const dispose = () => {
    scene.remove(skyMesh);
    scene.remove(hemiLight);
    scene.remove(sunLight);
    scene.remove(rimLight);

    skyGeo.dispose();
    skyMat.dispose();
    envTexture.dispose();

    if (sunLight.shadow.map) {
      sunLight.shadow.map.dispose();
    }

    scene.fog = prevFog;
    scene.environment = prevEnv;
    scene.background = prevBg;

    if (renderer) {
      renderer.toneMapping = prevToneMapping;
      renderer.toneMappingExposure = prevExposure;
    }
  };

  return {
    skyMesh,
    hemiLight,
    sunLight,
    rimLight,
    fog,
    envTexture,
    update,
    setShadowMapSize,
    dispose,
  };
}
