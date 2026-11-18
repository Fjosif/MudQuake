import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1912, height: 948 } });
await page.addInitScript(() => {
  window.__scenes = [];
  window.__THREE_DEVTOOLS__ = new EventTarget();
  window.__THREE_DEVTOOLS__.addEventListener('observe', e => {
    if (e.detail.isScene) window.__scenes.push(e.detail);
  });
});
await page.goto('http://127.0.0.1:4173/');
await page.waitForFunction(() => window.mudquake?.ready, { timeout: 90000 });
if (process.argv.includes('--collapse')) {
  await page.locator('#quake').click();
  for (const time of [9, 11.5, 13.5, 14.5, 15.5, 17]) {
    await page.waitForFunction(t => window.mudquake.getState().elapsedTime >= t, time);
    await page.screenshot({ path: `verification/masonry-${time}.png` });
    console.log('FRAME', time, await page.evaluate(() => window.mudquake.getState().destruction));
  }
  const events = await page.evaluate(() => window.mudquake.getEvents());
  const structure = events.filter(e => e.type === 'failure' && ['wall', 'post'].includes(e.kind) && e.position.y < 5.3);
  const roof = events.filter(e => e.type === 'failure' && e.kind === 'roof');
  const first = structure[0];
  const far = structure.find(e => Math.hypot(e.position.x - first.position.x, e.position.z - first.position.z) > 9);
  const summary = { firstCornerFailures: structure.slice(0, 12), firstDistantFailure: far, roofFailures: roof };
  await writeFile('verification/corner-progression.json', JSON.stringify(summary, null, 2));
  console.log('PROGRESSION', JSON.stringify({ first: first.time, distant: far?.time, firstRoof: roof[0]?.time, lastRoof: roof.at(-1)?.time }));
  await browser.close();
  process.exit(0);
}
await page.mouse.move(950, 400); await page.mouse.down();
await page.mouse.move(1500, 620, { steps: 20 }); await page.mouse.up();
await page.waitForTimeout(1000);
console.log(await page.evaluate(() => ({ state: window.mudquake.getState(), scenes: window.__scenes.map(s => s.children.map(c => c.name)) })));
await page.screenshot({ path: process.argv.includes('--fixed') ? 'verification/stripe-fixed.png' : 'verification/stripe-before.png' });
await page.evaluate(() => window.__scenes.forEach(s => { const o = s.getObjectByName('MudquakeRainCurtains'); if(o) o.visible = false; }));
await page.waitForTimeout(500);
await page.screenshot({ path: 'verification/stripe-curtains-off.png' });
await browser.close();
