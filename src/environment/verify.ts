import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  createEnvironment,
  disposeEnvironment,
  getEnvironmentStats,
  getTerrainHeightAt,
  notifyDebrisImpact,
  setEnvironmentQuality,
  updateEnvironment,
  type EarthquakePhase,
  type EarthquakeState,
  type QualityPreset,
} from './index';

async function main() {
  const initW = Math.max(1, window.innerWidth);
  const initH = Math.max(1, window.innerHeight);
  const renderer = new WebGPURenderer({ antialias: true });
  renderer.setSize(initW, initH);
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    52,
    initW / initH,
    0.1,
    350
  );
  camera.position.set(0, 1.7, 22);
  scene.userData.camera = camera;

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 2.2, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.update();

  createEnvironment(scene, renderer, {
    seed: 1337,
    quality: 'high',
    enableAudio: false,
  });

  // Wireframe placeholder bounding box (10 x 8 x 7m) showing where Agent B's house sits
  const houseBoxGeo = new THREE.BoxGeometry(10, 7, 8);
  const houseWire = new THREE.LineSegments(
    new THREE.EdgesGeometry(houseBoxGeo),
    new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.35 })
  );
  houseWire.position.set(0, 3.5, 0);
  scene.add(houseWire);

  // Earthquake simulation state for verification
  let quakeActive = false;
  let quakeStart = 0;
  const eqState: EarthquakeState = {
    elapsedTime: 0,
    intensity: 0,
    phase: 'idle',
    groundDisplacement: new THREE.Vector3(),
    eventSeed: 1337,
  };

  // WASD walk state
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => keys.add(e.code));
  window.addEventListener('keyup', (e) => keys.delete(e.code));

  const qualitySelect = document.getElementById('qualitySelect') as HTMLSelectElement;
  qualitySelect.addEventListener('change', () => {
    setEnvironmentQuality(qualitySelect.value as QualityPreset);
  });

  document.getElementById('quakeBtn')?.addEventListener('click', () => {
    quakeActive = true;
    quakeStart = performance.now() * 0.001;
  });

  document.getElementById('impactBtn')?.addEventListener('click', () => {
    const x = (Math.random() - 0.5) * 12;
    const z = (Math.random() - 0.5) * 10 + 3;
    const y = getTerrainHeightAt(x, z);
    notifyDebrisImpact({ x, y, z }, 15 + Math.random() * 20, 0.8);
  });

  document.getElementById('resetBtn')?.addEventListener('click', () => {
    quakeActive = false;
    eqState.intensity = 0;
    eqState.phase = 'idle';
    eqState.groundDisplacement.x = 0;
    eqState.groundDisplacement.y = 0;
    eqState.groundDisplacement.z = 0;
    camera.position.set(0, 1.7, 22);
    controls.target.set(0, 2.2, 0);
    controls.update();
  });

  window.addEventListener('resize', () => {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });

  window.addEventListener('beforeunload', () => {
    disposeEnvironment();
    renderer.dispose();
  });

  const statsEl = document.getElementById('stats')!;
  const startTime = performance.now() * 0.001;
  let prevTime = startTime;
  let fpsAccum = 0;
  let fpsFrames = 0;
  let currentFps = 0;

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();

  function updateQuake(now: number) {
    if (!quakeActive) return;
    const t = now - quakeStart;
    let phase: EarthquakePhase = 'idle';
    let intensity = 0;

    if (t < 2.5) {
      phase = 'tremor';
      intensity = 0.25 * (t / 2.5);
    } else if (t < 6.0) {
      phase = 'severe';
      intensity = 0.35 + 0.55 * ((t - 2.5) / 3.5);
    } else if (t < 9.5) {
      phase = 'collapse';
      intensity = 0.95;
      if (Math.random() < 0.12) {
        const ix = (Math.random() - 0.5) * 11;
        const iz = (Math.random() - 0.5) * 9;
        notifyDebrisImpact({ x: ix, y: getTerrainHeightAt(ix, iz), z: iz }, 18, 0.7);
      }
    } else if (t < 13.0) {
      phase = 'aftermath';
      intensity = Math.max(0, 0.95 * (1 - (t - 9.5) / 3.5));
    } else {
      quakeActive = false;
      phase = 'idle';
      intensity = 0;
    }

    eqState.phase = phase;
    eqState.intensity = intensity;
    eqState.groundDisplacement.x = Math.sin(t * 27) * 0.08 * intensity;
    eqState.groundDisplacement.y = Math.cos(t * 33) * 0.03 * intensity;
    eqState.groundDisplacement.z = Math.sin(t * 23 + 1.1) * 0.08 * intensity;
  }

  function animate() {
    requestAnimationFrame(animate);
    const now = performance.now() * 0.001;
    const dt = Math.min(now - prevTime, 0.05);
    prevTime = now;
    const elapsed = now - startTime;

    // WASD terrain walk
    const moveSpeed = 5.0 * dt;
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    right.crossVectors(forward, camera.up).normalize();

    let moved = false;
    if (keys.has('KeyW')) {
      camera.position.addScaledVector(forward, moveSpeed);
      controls.target.addScaledVector(forward, moveSpeed);
      moved = true;
    }
    if (keys.has('KeyS')) {
      camera.position.addScaledVector(forward, -moveSpeed);
      controls.target.addScaledVector(forward, -moveSpeed);
      moved = true;
    }
    if (keys.has('KeyA')) {
      camera.position.addScaledVector(right, -moveSpeed);
      controls.target.addScaledVector(right, -moveSpeed);
      moved = true;
    }
    if (keys.has('KeyD')) {
      camera.position.addScaledVector(right, moveSpeed);
      controls.target.addScaledVector(right, moveSpeed);
      moved = true;
    }
    if (moved) {
      const groundY = getTerrainHeightAt(camera.position.x, camera.position.z);
      const dy = groundY + 1.7 - camera.position.y;
      camera.position.y += dy;
      controls.target.y += dy;
    }

    updateQuake(now);
    eqState.elapsedTime = elapsed;

    updateEnvironment(dt, elapsed, eqState);
    controls.update();
    renderer.render(scene, camera);

    fpsAccum += dt;
    fpsFrames++;
    if (fpsAccum >= 0.5) {
      currentFps = Math.round(fpsFrames / fpsAccum);
      fpsAccum = 0;
      fpsFrames = 0;
      const st = getEnvironmentStats();
      const backend =
        (renderer.backend as { isWebGPUBackend?: boolean })?.isWebGPUBackend
          ? 'WebGPU'
          : 'WebGL2';
      statsEl.innerHTML =
        `Backend: <b>${backend}</b> | FPS: <b>${currentFps}</b><br>` +
        `Quality: <b>${st.quality}</b> | CPU update: <b>${st.lastUpdateMs.toFixed(2)} ms</b><br>` +
        `Terrain verts: ${st.terrainVertices.toLocaleString()} | Rain: ${st.rainParticles.toLocaleString()}<br>` +
        `Rocks: ${st.rockInstances} | Grass: ${st.grassInstances} | Splashes: ${st.activeDebrisSplashes}<br>` +
        `Quake: <b>${eqState.phase}</b> (${(eqState.intensity * 100).toFixed(0)}%)`;
    }
  }

  animate();
}

void main();
