import './style.css';
import RAPIER from '@dimforge/rapier3d-compat';
import { DirectionalLight, PerspectiveCamera, Scene } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { createEnvironment, disposeEnvironment, updateEnvironment, getEnvironmentStats, getTerrainHeightAt, type QualityPreset } from './environment';
import { createEnvironmentAudio, type EnvironmentAudioSystem } from './environment/audio/environmentAudio';
import { DEFAULT_EVENT_SEED, FIXED_DELTA_TIME, sampleEarthquake, type DestructionEvent, type EarthquakeState } from './destruction';
import { createSimulationWorld } from './app/world';
import { Player } from './app/player';
import { RunMetrics } from './app/metrics';
import { createCinematicPipeline } from './app/cinematic';
import { loadPhotoLibrary, photographicSky, photoLibraryStats } from './materials/photoLibrary';

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id); if (!found) throw new Error(`Missing UI: ${id}`); return found as T;
}
const ui = {
  viewport: element('viewport'), loading: element('loading'), loadingText: element('loadingText'), notice: element('notice'),
  quake: element<HTMLButtonElement>('quake'), reset: element<HTMLButtonElement>('reset'), pause: element<HTMLButtonElement>('pause'),
  audio: element<HTMLButtonElement>('audio'), quality: element<HTMLSelectElement>('quality'), resolution: element<HTMLSelectElement>('resolution'),
  phase: element('phaseLabel'), clock: element('clock'), progress: element('progress'), backend: element('backend'), fps: element('fps'),
  resolutionLabel: element('resolutionLabel'), diagnostics: element('diagnostics'), download: element<HTMLButtonElement>('download'),
};
const phaseText = { idle: ['Klid před otřesy.', 'Déšť pokračuje. První otřesy přijdou ve třetí sekundě.', 'KLID'],
  tremor: ['První varování.', 'Slabé otřesy rozechvívají konstrukci. Spoje se postupně oslabují.', 'SLABÉ OTŘESY'],
  severe: ['Země ztrácí klid.', 'Zdivo praská, sklo povoluje. Nosná konstrukce přebírá zatížení.', 'SILNÉ OTŘESY'],
  collapse: ['Konstrukce povoluje.', 'Poruchy se šíří mezi podporami. Střecha a stropy ztrácejí oporu.', 'KOLAPS'],
  aftermath: ['Jen déšť a dozvuky.', 'Trosky dosedají do rozmoklé země. Každý náraz zanechá stopu.', 'DOZVUKY'] } as const;

async function main() {
  await RAPIER.init();
  ui.loadingText.textContent = 'Načítám fotografické materiály…';
  await loadPhotoLibrary();
  if (!navigator.gpu) throw new Error('WebGPU není dostupné. Otevřete aplikaci v aktuálním Chrome nebo Edge s hardwarovou akcelerací.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('Prohlížeč neposkytl WebGPU adaptér. Zkontrolujte hardwarovou akceleraci.');
  const device = await adapter.requestDevice({ requiredFeatures: Array.from(adapter.features) as GPUFeatureName[] });
  const adapterInfo = adapter.info;
  const gpuInfo = { vendor: adapterInfo.vendor, architecture: adapterInfo.architecture, device: adapterInfo.device,
    description: adapterInfo.description, fallback: adapterInfo.isFallbackAdapter ?? false };
  const renderer = new WebGPURenderer({ device, antialias: true, trackTimestamp: adapter.features.has('timestamp-query') });
  await renderer.init();
  if (!(renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend) throw new Error('Aplikace vyžaduje skutečný WebGPU backend.');
  renderer.info.autoReset = false;
  ui.viewport.append(renderer.domElement); renderer.domElement.tabIndex = 0;
  const scene = new Scene(), camera = new PerspectiveCamera(52, 16 / 9, 0.1, 350);
  scene.userData.camera = camera;
  const cinematic = createCinematicPipeline(renderer, scene, camera);
  const audioContext = new AudioContext();
  let ambience: EnvironmentAudioSystem | null = null;
  let sound = false, quality: QualityPreset = 'high', ready = false, resetting = false, disposed = false, paused = false;
  let hidden = document.hidden, previous = performance.now(), accumulator = 0, simulationTime = 0, quakeFrame = -1;
  let currentState: EarthquakeState = sampleEarthquake(0, DEFAULT_EVENT_SEED);
  let run: RunMetrics | null = null, lastReport: ReturnType<typeof getReport> | null = null;
  let impacts = 0, requests = 0, resetCount = 0, droppedSimulationSeconds = 0, generation = 0;
  let lastHud = 0, rollingFrames = 0, rollingSeconds = 0, latestFps = 0, gpuPending = false;
  let automaticScale = 1, adaptiveGpuSum = 0, adaptiveGpuCount = 0, lastAdaptation = 0;
  let events: DestructionEvent[] = [];
  const errors: string[] = [];
  let simulation: ReturnType<typeof createSimulationWorld>;
  let player: Player;
  const shadowLights: DirectionalLight[] = [];

  function notify(message: string): void { ui.notice.textContent = message; }
  function fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message); ready = false; paused = true; run?.invalidate(message);
    ui.loading.hidden = false; ui.loading.style.display = 'flex'; ui.loadingText.textContent = message; ui.loadingText.classList.add('error');
    console.error(error);
  }
  device.addEventListener('uncapturederror', event => fail((event as GPUUncapturedErrorEvent).error));
  renderer.onDeviceLost = info => fail(`WebGPU zařízení bylo ztraceno: ${info.message}`);
  function onEvent(event: DestructionEvent): void {
    if (event.type === 'earthquake-request') {
      requests++; if (quakeFrame >= 0) return;
      void beginEvent().catch(fail);
    }
    if (event.type === 'impact') impacts++;
    if (event.type !== 'earthquake-request' && events.length < 12000) events.push(event);
  }
  async function beginEvent(): Promise<void> {
    if (resetting || !ready) return;
    resetting = true; ready = false; generation++;
    ui.quake.disabled = ui.reset.disabled = ui.pause.disabled = ui.quality.disabled = true;
    // Idle walking may run for any number of ticks. Rebuild the owned physics world at the
    // event boundary, so that Rapier broadphase/contact history cannot change seeded replay.
    // Keep the observer's chosen location and viewing direction.
    const position = player.getPosition(), yaw = player.yaw, pitch = player.pitch;
    position.x = Math.round(position.x * 1000) / 1000; position.z = Math.round(position.z * 1000) / 1000;
    position.y = getTerrainHeightAt(position.x, position.z) + 0.90;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    player.dispose(); simulation.destruction.disposeDestruction(); simulation.world.free();
    simulation = createSimulationWorld(scene, audioContext, onEvent); player = new Player(simulation.world, camera, getTerrainHeightAt(0, 22));
    player.setPose(position, yaw, pitch); player.sync(0, 0);
    await renderer.compileAsync(scene, camera);
    if (sound) await simulation.destruction.unlockAudio();
    quakeFrame = 0; accumulator = 0; currentState = sampleEarthquake(0); previous = performance.now();
    run = new RunMetrics(); lastReport = null; events = []; impacts = 0; droppedSimulationSeconds = 0;
    resetting = false; ready = true; ui.reset.disabled = ui.pause.disabled = false; ui.quality.disabled = false; ui.download.disabled = true;
    notify('Probíhá 25sekundová sekvence. Měření zahrnuje fyziku, prostředí i vykreslování.');
  }
  function resize(): void {
    run?.invalidate('Během měření se změnilo rozlišení nebo velikost okna.');
    const mode = ui.resolution.value;
    const nativeScale = Math.min(devicePixelRatio, 1.5, Math.sqrt(2560 * 1440 / (innerWidth * innerHeight)));
    const autoScale = nativeScale * automaticScale;
    const width = mode === '1440' ? 2560 : mode === '1080' ? 1920 : mode === 'auto' ? Math.max(2, Math.round(innerWidth * autoScale / 2) * 2) : Math.max(1, Math.round(innerWidth * Math.min(devicePixelRatio, 2)));
    const height = mode === '1440' ? 1440 : mode === '1080' ? 1080 : mode === 'auto' ? Math.max(2, Math.round(innerHeight * autoScale / 2) * 2) : Math.max(1, Math.round(innerHeight * Math.min(devicePixelRatio, 2)));
    renderer.setPixelRatio(1); renderer.setSize(width, height, false);
    const scale = Math.min(innerWidth / width, innerHeight / height);
    renderer.domElement.style.width = `${Math.round(width * scale)}px`; renderer.domElement.style.height = `${Math.round(height * scale)}px`;
    camera.aspect = width / height; camera.updateProjectionMatrix(); ui.resolutionLabel.textContent = `${width} × ${height}`;
  }
  async function rebuild(initial = false): Promise<void> {
    if (resetting || disposed) return;
    resetting = true; ready = false; generation++; run = null; lastReport = null; events = [];
    ui.loading.style.display = 'flex'; ui.loadingText.textContent = initial ? 'Připravuji krajinu a konstrukci…' : 'Obnovuji dům, krajinu a fyziku…';
    ui.quake.disabled = ui.reset.disabled = ui.pause.disabled = true; ui.quality.disabled = true;
    ui.audio.disabled = true;
    // Give the overlay a paint before CPU geometry creation. This is initialization, not a second loop.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (!initial) { player.dispose(); simulation.destruction.disposeDestruction(); simulation.world.free(); disposeEnvironment(); resetCount++; }
    createEnvironment(scene, renderer, { seed: 1337, quality, enableAudio: false });
    shadowLights.length = 0;
    scene.traverse(object => { if (object instanceof DirectionalLight && object.castShadow) { object.shadow.autoUpdate = false; shadowLights.push(object); } });
    const sky = photographicSky();
    if (sky) {
      const proceduralSky = scene.getObjectByName('MudquakeStormSky'); if (proceduralSky) proceduralSky.visible = false;
      scene.background = sky; scene.environment = sky;
      scene.backgroundIntensity = 0.12; scene.environmentIntensity = 0.15;
      scene.backgroundRotation.y = scene.environmentRotation.y = 0.7;
    }
    simulation = createSimulationWorld(scene, audioContext, onEvent); player = new Player(simulation.world, camera, getTerrainHeightAt(0, 22));
    simulationTime = 0; quakeFrame = -1; accumulator = 0; currentState = sampleEarthquake(0); paused = false;
    impacts = requests = 0; droppedSimulationSeconds = 0;
    player.sync(0, 0); resize();
    updateEnvironment(0, 0, currentState);
    ui.loadingText.textContent = 'Připravuji WebGPU shadery…';
    await renderer.compileAsync(scene, camera);
    shadowLights.forEach(light => { light.shadow.needsUpdate = true; });
    renderer.info.reset(); if (quality === 'low') renderer.render(scene, camera); else cinematic.render();
    if (sound) { await audioContext.resume(); await simulation.destruction.unlockAudio(); }
    previous = performance.now(); ready = true; resetting = false;
    ui.loading.style.display = 'none'; ui.quake.disabled = ui.reset.disabled = ui.pause.disabled = false; ui.quality.disabled = false;
    ui.audio.disabled = false;
    ui.download.disabled = true; document.body.classList.remove('paused'); ui.pause.innerHTML = 'Ⅱ <span>Pauza</span><kbd>P</kbd>';
    notify(initial ? '' : 'Dům i fyzikální svět jsou obnovené. Stejný seed, stejná výchozí scéna.'); updateHud(performance.now(), true);
  }
  function getReport() {
    return { measuredAt: new Date().toISOString(), gpu: gpuInfo, userAgent: navigator.userAgent, backend: 'WebGPU',
      width: renderer.domElement.width, height: renderer.domElement.height, quality, seed: DEFAULT_EVENT_SEED,
      resolutionMode: ui.resolution.value,
      fixedTimestep: FIXED_DELTA_TIME, solverIterations: 6, eventSeconds: currentState.elapsedTime,
      droppedSimulationSeconds, impacts, destruction: simulation.destruction.getStats(),
      roof: simulation.getRoofDiagnostics(), photographicMaterials: photoLibraryStats(),
      timing: run?.report() ?? null, errors: [...errors],
    };
  }
  function updateHud(now: number, force = false): void {
    if (!force && now - lastHud < 200) return; lastHud = now;
    const stats = simulation.destruction.getStats(), environment = getEnvironmentStats();
    const entry = phaseText[currentState.phase];
    element('phaseDescription').textContent = quakeFrame < 0 ? 'Projděte se. Prohlédněte si dům. Potom dejte zemi pohyb.' : entry[1];
    document.querySelector('h1')!.textContent = quakeFrame < 0 ? 'Klid před otřesy.' : entry[0];
    ui.phase.textContent = paused || hidden ? 'POZASTAVENO' : quakeFrame < 0 ? 'PŘIPRAVENO' : currentState.elapsedTime >= 25 ? 'SEKVENCE DOKONČENA' : entry[2];
    ui.clock.innerHTML = `${Math.min(25, currentState.elapsedTime).toFixed(2).padStart(5, '0')} <small>/ 25 s</small>`;
    ui.progress.style.width = `${Math.min(100, currentState.elapsedTime * 4)}%`;
    ui.backend.textContent = 'WEBGPU'; ui.fps.innerHTML = `${latestFps ? latestFps.toFixed(0) : '—'}<small> FPS</small>`;
    ui.diagnostics.textContent = `${gpuInfo.description || [gpuInfo.vendor, gpuInfo.architecture].filter(Boolean).join(' / ')}\n${renderer.domElement.width} × ${renderer.domElement.height} · ${quality}\n${stats.failed} / ${stats.components} porušených částí\n${stats.dynamicBodies} dynamických těles · ${stats.awakeBodies} aktivních\n${impacts} nárazů · ${environment.activeDebrisSplashes} bahenních částic\n${renderer.info.render.drawCalls} draw calls · ${renderer.info.render.triangles.toLocaleString('cs')} trojúhelníků\nGPU čas: ${renderer.info.render.timestamp > 0 ? renderer.info.render.timestamp.toFixed(2) + ' ms' : 'čeká na dotaz'}${lastReport?.timing ? '\nBěh: ' + lastReport.timing.meanFps.toFixed(1) + ' FPS · p95 ' + lastReport.timing.frameIntervals.p95Ms.toFixed(1) + ' ms' : ''}`;
  }
  function setPause(): void {
    if (!ready) return; paused = !paused; player.clearKeys(); accumulator = 0; previous = performance.now();
    run?.invalidate('Sekvence byla ručně pozastavena.'); document.body.classList.toggle('paused', paused);
    ui.pause.innerHTML = paused ? '▶ <span>Pokračovat</span><kbd>P</kbd>' : 'Ⅱ <span>Pauza</span><kbd>P</kbd>'; updateHud(previous, true);
  }
  function start(): void { if (ready && !paused && quakeFrame < 0) simulation.destruction.triggerEarthquake(); }
  ui.quake.addEventListener('click', start);
  ui.reset.addEventListener('click', () => { void rebuild().catch(fail); });
  ui.pause.addEventListener('click', setPause);
  ui.quality.addEventListener('change', () => { quality = ui.quality.value as QualityPreset; void rebuild().catch(fail); });
  ui.resolution.addEventListener('change', () => { automaticScale = 1; resize(); }); window.addEventListener('resize', resize);
  ui.audio.addEventListener('click', () => {
    sound = !sound; ui.audio.setAttribute('aria-pressed', String(sound));
    ui.audio.innerHTML = `♫ <span>Zvuk ${sound ? 'zapnutý' : 'vypnutý'}</span>`;
    if (sound) { void audioContext.resume(); void simulation.destruction.unlockAudio(); ambience = createEnvironmentAudio(true); ambience.resume(); }
    else { void audioContext.suspend(); ambience?.dispose(); ambience = null; }
  });
  element('fullscreen').addEventListener('click', () => { if (!document.fullscreenElement) void document.documentElement.requestFullscreen(); else void document.exitFullscreen(); });
  let dragPointer: number | null = null, dragX = 0, dragY = 0, dragDistance = 0;
  const lockMouse = () => {
    if (!ready) return;
    void Promise.resolve(renderer.domElement.requestPointerLock()).catch(() => notify('Rozhlížet se můžete také tažením myši ve scéně. Chůze: WASD, zatáčení: Q/E.'));
  };
  renderer.domElement.addEventListener('pointerdown', event => {
    if (!ready || event.button !== 0 || document.pointerLockElement) return;
    dragPointer = event.pointerId; dragX = event.clientX; dragY = event.clientY; dragDistance = 0;
    renderer.domElement.setPointerCapture(event.pointerId);
  });
  renderer.domElement.addEventListener('pointermove', event => {
    if (!ready || dragPointer !== event.pointerId || document.pointerLockElement) return;
    const dx = event.clientX - dragX, dy = event.clientY - dragY;
    dragDistance += Math.abs(dx) + Math.abs(dy); player.look(dx, dy); dragX = event.clientX; dragY = event.clientY;
  });
  renderer.domElement.addEventListener('pointerup', event => {
    if (dragPointer === event.pointerId) { dragPointer = null; renderer.domElement.releasePointerCapture(event.pointerId); }
  });
  renderer.domElement.addEventListener('click', () => { if (dragDistance < 5) lockMouse(); dragDistance = 0; });
  element('walk').addEventListener('click', () => {
    if (!ready) return;
    lockMouse();
    notify('WASD: chůze kolem domu · myš: rozhlížení · Shift: rychleji · Esc: návrat k ovládání.');
  });
  window.addEventListener('mousemove', event => { if (ready && document.pointerLockElement === renderer.domElement) player.look(event.movementX, event.movementY); });
  window.addEventListener('keydown', event => {
    if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement) return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) event.preventDefault();
    if (!ready) return; player.key(event.code, true);
    if (!event.repeat) { if (event.code === 'Space') start(); if (event.code === 'KeyR') void rebuild().catch(fail); if (event.code === 'KeyP') setPause(); }
  });
  window.addEventListener('keyup', event => { if (ready) player.key(event.code, false); });
  window.addEventListener('blur', () => { if (ready) player.clearKeys(); });
  document.addEventListener('visibilitychange', () => {
    hidden = document.hidden; accumulator = 0; previous = performance.now(); if (ready) player.clearKeys();
    if (hidden) run?.invalidate('Karta byla během měření skrytá.');
  });
  ui.download.addEventListener('click', () => {
    if (!lastReport) return; const url = URL.createObjectURL(new Blob([JSON.stringify(lastReport, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `mudquake-${lastReport.width}x${lastReport.height}.json`; link.click(); URL.revokeObjectURL(url);
  });
  function frame(now: number): void {
    if (disposed) return;
    requestAnimationFrame(frame);
    const wallDelta = (now - previous) / 1000; previous = now;
    if (!ready || paused || hidden) return;
    const begin = performance.now(); let physicsMs = 0, advanced = false;
    if (wallDelta > 0.25) { droppedSimulationSeconds += wallDelta - 0.25; run?.invalidate('Snímek přesáhl 250 ms; simulace omezila dohánění.'); }
    accumulator += Math.min(0.25, Math.max(0, wallDelta));
    try {
      while (accumulator >= FIXED_DELTA_TIME) {
        advanced = true;
        currentState = sampleEarthquake(quakeFrame >= 0 ? quakeFrame * FIXED_DELTA_TIME : 0, DEFAULT_EVENT_SEED);
        const beforePhysics = performance.now();
        simulation.destruction.updateDestruction(FIXED_DELTA_TIME, currentState); player.step(FIXED_DELTA_TIME);
        simulation.stepPhysics(currentState); simulation.destruction.syncVisuals();
        physicsMs += performance.now() - beforePhysics;
        updateEnvironment(FIXED_DELTA_TIME, simulationTime, currentState); ambience?.update(0.85, currentState.intensity);
        simulationTime += FIXED_DELTA_TIME; if (quakeFrame >= 0) quakeFrame++; accumulator -= FIXED_DELTA_TIME;
      }
      player.sync(currentState.intensity, currentState.elapsedTime);
      simulation.destruction.setListenerPosition(camera.position); simulation.destruction.syncVisuals(accumulator / FIXED_DELTA_TIME);
      // Bake the intact house/terrain shadow once. During the quake, update only after a physics tick.
      shadowLights.forEach(light => { light.shadow.needsUpdate = advanced && quakeFrame >= 0; });
      renderer.info.reset(); if (quality === 'low') renderer.render(scene, camera); else cinematic.render();
      const cpu = performance.now() - begin;
      run?.record(begin, cpu, physicsMs, currentState, renderer.info.render.drawCalls);
      if (adapter!.features.has('timestamp-query') && !gpuPending) {
        gpuPending = true; const captured = run, currentGeneration = generation;
        void renderer.resolveTimestampsAsync().then(duration => {
          if (duration !== undefined && duration > 0 && currentGeneration === generation && captured?.active) captured.gpu.push(duration);
          if (duration !== undefined && duration > 0 && ready && ui.resolution.value === 'auto') {
            adaptiveGpuSum += duration; adaptiveGpuCount++;
            const now = performance.now();
            if (now - lastAdaptation > 1500 && adaptiveGpuCount >= 30) {
              const average = adaptiveGpuSum / adaptiveGpuCount, oldScale = automaticScale;
              if (average > 11) automaticScale = Math.max(0.6, automaticScale * Math.sqrt(9 / average));
              else if (average < 6 && automaticScale < 1) automaticScale = Math.min(1, automaticScale + 0.05);
              adaptiveGpuSum = adaptiveGpuCount = 0; lastAdaptation = now;
              if (Math.abs(oldScale - automaticScale) > 0.02) resize();
            }
          }
        }).catch(fail).finally(() => { gpuPending = false; });
      }
      if (run?.active && currentState.elapsedTime >= 25) {
        run.active = false; lastReport = getReport(); ui.download.disabled = false;
        notify(`Sekvence dokončena · ${lastReport.timing!.meanFps.toFixed(1)} FPS · p95 ${lastReport.timing!.frameIntervals.p95Ms.toFixed(1)} ms. Reset obnoví celý svět.`);
      }
      rollingFrames++; rollingSeconds += wallDelta;
      if (rollingSeconds >= 0.5) { latestFps = rollingFrames / rollingSeconds; rollingFrames = rollingSeconds = 0; }
      updateHud(now);
    } catch (error) { fail(error); }
  }
  // Read-only diagnostics + the same UI commands used by browser regression tests.
  const debug = {
    get ready() { return ready; }, get resetting() { return resetting; }, get paused() { return paused; },
    getState: () => ({ ...currentState, quakeFrame, simulationTime, impacts, requests, resetCount, quality, sound, audioState: audioContext.state,
      yaw: player.yaw, pitch: player.pitch,
      player: player.getPosition(), camera: camera.position.toArray(), destruction: simulation.destruction.getStats(),
      width: renderer.domElement.width, height: renderer.domElement.height, worldBodies: simulation.world.bodies.len(),
      worldColliders: simulation.world.colliders.len(), sceneChildren: scene.children.length, errors: [...errors] }),
    textures: photoLibraryStats,
    getReport: () => lastReport, getSnapshot: () => simulation.destruction.getSnapshot(), getEvents: () => events,
    gpu: gpuInfo, start, reset: () => rebuild(), setPause,
  };
  Object.assign(window, { mudquake: debug });
  await rebuild(true);
  requestAnimationFrame(frame);
  window.addEventListener('pagehide', () => {
    if (disposed) return; disposed = true; player.dispose(); simulation.destruction.disposeDestruction(); simulation.world.free();
    disposeEnvironment(); ambience?.dispose(); void audioContext.close(); cinematic.dispose(); renderer.dispose();
  });
}
void main().catch(error => {
  console.error(error); ui.loadingText.textContent = error instanceof Error ? error.message : String(error); ui.loadingText.classList.add('error');
});
