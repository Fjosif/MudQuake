import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const smoke = process.argv.includes('--smoke');
const headed = process.argv.includes('--headed');
const keepOpen = process.argv.includes('--keep-open');
const output = new URL('../verification/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: !headed,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const system = await (await browser.newBrowserCDPSession()).send('SystemInfo.getInfo');
const gpuDevices = system.gpu.devices;
const errors = [], warnings = [];
page.on('pageerror', error => { errors.push(error.message); console.log('PAGE ERROR:', error.message); });
page.on('console', message => {
  if (message.type() === 'error') { errors.push(message.text()); console.log('CONSOLE ERROR:', message.text().slice(0, 2200)); }
  if (message.type() === 'warning' && warnings.length < 50) warnings.push(message.text());
});
try {
  await page.goto(process.env.MUDQUAKE_URL ?? 'http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.mudquake?.ready, { timeout: 90000 });
  await page.locator('#resolution').selectOption('1440');
  const initial = await page.evaluate(() => ({ state: window.mudquake.getState(), gpu: window.mudquake.gpu }));
  console.log('READY:', JSON.stringify({ ...initial, gpuDevices }));
  assert.equal(initial.state.width, 2560); assert.equal(initial.state.height, 1440);
  assert.equal(initial.state.destruction.failed, 0);
  await page.waitForFunction(() => window.mudquake.getState().simulationTime > 0.6);
  await page.screenshot({ path: fileURLToPath(new URL('01-intact.png', output)) });
  if (smoke) {
    await page.waitForTimeout(2000);
    const result = { ...initial, errors, warnings };
    await writeFile(new URL('smoke.json', output), JSON.stringify(result, null, 2));
    assert.equal(errors.length, 0, 'browser errors detected');
    console.log('SMOKE PASSED');
  } else {
    await page.locator('#audio').click();
    await page.waitForFunction(() => window.mudquake.getState().audioState === 'running');
    await page.locator('#audio').click();
    await page.waitForFunction(() => window.mudquake.getState().audioState === 'suspended');
    const yaw = await page.evaluate(() => window.mudquake.getState().yaw);
    await page.mouse.move(1250, 500); await page.mouse.down(); await page.mouse.move(1320, 500, { steps: 8 }); await page.mouse.up();
    assert.notEqual(await page.evaluate(() => window.mudquake.getState().yaw), yaw, 'drag did not rotate the view');
    // Verify actual keyboard locomotion and pause through the production UI.
    await page.keyboard.down('KeyW'); await page.waitForTimeout(600); await page.keyboard.up('KeyW');
    const walked = await page.evaluate(() => window.mudquake.getState());
    assert.ok(walked.player.z < initial.state.player.z - 0.7, 'W did not move the player');
    await page.locator('#pause').click();
    const pausedAt = await page.evaluate(() => window.mudquake.getState().simulationTime);
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => window.mudquake.getState().simulationTime), pausedAt);
    await page.locator('#pause').click();
    await page.locator('#reset').click(); await page.waitForFunction(() => window.mudquake.ready && !window.mudquake.resetting);
    const resetInitial = await page.evaluate(() => window.mudquake.getState());
    assert.equal(resetInitial.destruction.failed, 0); assert.ok(Math.abs(resetInitial.player.z - 22) < 0.001);
    const runs = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      await page.waitForTimeout(1800); // steady render warm-up, outside the 25-second measurement
      await page.locator('#quake').click();
      if (repeat === 0 && process.argv.includes('--screenshots')) {
        await page.waitForFunction(() => window.mudquake.getState().elapsedTime >= 7);
        await page.screenshot({ path: fileURLToPath(new URL('02-cracking.png', output)) });
        await page.waitForFunction(() => window.mudquake.getState().elapsedTime >= 12.5);
        await page.screenshot({ path: fileURLToPath(new URL('03-collapse.png', output)) });
      }
      await page.waitForFunction(() => window.mudquake.getReport() !== null, { timeout: 90000 });
      const run = await page.evaluate(() => ({ report: window.mudquake.getReport(), state: window.mudquake.getState(), snapshot: window.mudquake.getSnapshot(), events: window.mudquake.getEvents() }));
      runs.push(run);
      await writeFile(new URL(`run-${repeat + 1}.json`, output), JSON.stringify(run.report, null, 2));
      console.log('RUN', repeat + 1, JSON.stringify(run.report));
      assert.ok(run.state.destruction.failed > run.state.destruction.components * 0.7, 'house did not collapse');
      assert.ok(run.report.impacts > 0, 'no debris impacts');
      assert.equal(run.report.timing.valid, true, 'performance run was interrupted or resolution changed');
      assert.equal(run.report.droppedSimulationSeconds, 0, 'simulation discarded wall-clock time');
      assert.ok(run.snapshot.every(piece => Object.values(piece.position).every(Number.isFinite)), 'physics produced a non-finite pose');
      assert.ok(run.report.roof.peakRoofAirborneUpwardSpeed < 1.5, 'roof launched upward instead of collapsing');
      assert.ok(run.report.roof.peakRoofCenterY < 6.6, 'roof rose above its original support height');
      assert.equal(run.report.width, 2560); assert.equal(run.report.height, 1440);
      assert.ok(run.snapshot.filter(c => c.kind === 'roof').filter(c => c.position.y < 3.5).length >= 10, 'roof did not fall');
      if (repeat === 0) await page.screenshot({ path: fileURLToPath(new URL('04-aftermath.png', output)) });
      await page.locator('#reset').click(); await page.waitForFunction(() => window.mudquake.ready && !window.mudquake.resetting);
      const after = await page.evaluate(() => window.mudquake.getState());
      assert.equal(after.destruction.failed, 0); assert.equal(after.worldBodies, resetInitial.worldBodies);
      assert.equal(after.worldColliders, resetInitial.worldColliders); assert.equal(after.sceneChildren, resetInitial.sceneChildren);
    }
    // Compare only deterministic simulation timestamps, not callback/RAF batching around the 25s boundary.
    const failures = run => run.events.filter(e => ['glass', 'failure'].includes(e.type) && e.time < 25).map(e => [e.type, e.componentId, e.time]);
    assert.deepEqual(failures(runs[0]), failures(runs[1]), 'failure replay differed after full world reset');
    const summary = { measuredAt: new Date().toISOString(), browser: browser.version(), headed, viewport: { width: 2560, height: 1440 },
      gpu: initial.gpu, gpuDevices, screenshotCaptureDuringMeasuredFrames: process.argv.includes('--screenshots'),
      checks: { keyboardWalk: true, mouseLook: true, audioToggle: true, pause: true, completeCollapse: true, terrainImpacts: true, fullReset: true, deterministicFailureReplay: true },
      runs: runs.map(run => run.report), errors, warnings };
    await writeFile(new URL('browser-results.json', output), JSON.stringify(summary, null, 2) + '\n');
    assert.equal(errors.length, 0, 'browser errors detected');
    await page.screenshot({ path: fileURLToPath(new URL('05-reset.png', output)) });
    console.log('VERIFICATION PASSED:', new URL('browser-results.json', output).pathname);
  }
} catch (error) {
  await writeFile(new URL('failure.json', output), JSON.stringify({ error: String(error), errors, warnings }, null, 2));
  await page.screenshot({ path: fileURLToPath(new URL('failure.png', output)) }).catch(() => {});
  console.error(error); process.exitCode = 1;
} finally {
  if (keepOpen && !process.exitCode) { console.log('Browser remains open for interaction.'); await new Promise(resolve => browser.on('disconnected', resolve)); }
  else await browser.close();
}
