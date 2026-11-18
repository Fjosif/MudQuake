import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserFrameBenchmark } from '../performance';

test('browser observer measures actual frame cadence and canvas resolution without its own loop', () => {
  const probe = new BrowserFrameBenchmark(120);
  const canvas = { width: 2560, height: 1440 } as HTMLCanvasElement;
  for (let i = 0; i < 61; i++) { probe.beginFrame(i * 1000 / 60); probe.endFrame(i * 1000 / 60 + 4); }
  const report = probe.report(canvas);
  assert.equal(report.width, 2560); assert.equal(report.height, 1440); assert.equal(report.samples, 60);
  assert.ok(Math.abs(report.meanFps - 60) < 0.00001); assert.equal(report.cpuSubmitP95Ms, 4);
  assert.equal(report.framesOver20Ms, 0);
  probe.reset(); assert.equal(probe.report(canvas).samples, 0);
});
