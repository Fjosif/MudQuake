import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--start-maximized'] });
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();
await page.goto(process.env.MUDQUAKE_URL ?? 'http://127.0.0.1:4173/');
await page.waitForFunction(() => window.mudquake?.ready, undefined, { timeout: 90000 });
console.log('MUDQUAKE OPEN:', JSON.stringify(await page.evaluate(() => ({ ...window.mudquake.getState(), mode: document.getElementById('resolution').value }))));
// Keep the interactive browser alive; the user controls and closes this window.
await new Promise(resolve => browser.on('disconnected', resolve));
