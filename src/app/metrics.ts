import type { EarthquakeState } from '../destruction/contracts';

export interface FrameSample { interval: number; cpu: number; physics: number; time: number; phase: string; drawCalls: number }
export function distribution(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return { samples: sorted.length, meanMs: sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length),
    p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0, p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    p99Ms: sorted[Math.floor(sorted.length * 0.99)] ?? 0, maxMs: sorted.at(-1) ?? 0 };
}
export class RunMetrics {
  readonly frames: FrameSample[] = [];
  readonly gpu: number[] = [];
  readonly invalidReasons = new Set<string>();
  active = true;
  private previous = -1;
  record(now: number, cpu: number, physics: number, state: EarthquakeState, drawCalls: number): void {
    if (!this.active) return;
    if (this.previous >= 0) this.frames.push({ interval: now - this.previous, cpu, physics, time: state.elapsedTime, phase: state.phase, drawCalls });
    this.previous = now;
  }
  invalidate(reason: string): void { if (this.active) this.invalidReasons.add(reason); }
  report() {
    const cadence = distribution(this.frames.map(f => f.interval));
    const stages = Object.fromEntries(['idle', 'tremor', 'severe', 'collapse', 'aftermath'].map(phase => {
      const data = this.frames.filter(f => f.phase === phase);
      const timing = distribution(data.map(f => f.interval));
      return [phase, { ...timing, meanFps: timing.meanMs ? 1000 / timing.meanMs : 0, cpu: distribution(data.map(f => f.cpu)) }];
    }));
    return { valid: this.invalidReasons.size === 0, invalidReasons: [...this.invalidReasons],
      meanFps: cadence.meanMs ? 1000 / cadence.meanMs : 0, frameIntervals: cadence,
      cpuFrame: distribution(this.frames.map(f => f.cpu)), physics: distribution(this.frames.map(f => f.physics)),
      gpuRenderPasses: distribution(this.gpu), stages, framesOver20Ms: this.frames.filter(f => f.interval > 20).length,
      framesOver33Ms: this.frames.filter(f => f.interval > 33.34).length,
      maxDrawCalls: Math.max(0, ...this.frames.map(f => f.drawCalls)),
      note: 'Frame intervals use performance.now() at actual RAF callback execution, not only scheduled vsync timestamps. CPU includes simulation and command submission. GPU samples sum render-pass timestamp queries, excluding presentation and idle waits. These are callback timings, not hardware-presented-frame telemetry.',
    };
  }
}
