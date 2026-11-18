/** Optional observer for the EXISTING application loop. Creates no renderer, timers or RAF callbacks. */
export class BrowserFrameBenchmark {
  private readonly intervals: Float64Array;
  private readonly work: Float64Array;
  private lastFrame = -1; private index = 0;
  private start = 0;
  constructor(readonly capacity = 1800) {
    if (!Number.isInteger(capacity) || capacity < 2) throw new Error('Benchmark capacity must be an integer >= 2.');
    this.intervals = new Float64Array(capacity); this.work = new Float64Array(capacity);
  }
  /** Supply performance.now() at the beginning of each existing frame callback. */
  beginFrame(now: number): void {
    this.start = now;
    if (this.lastFrame >= 0) {
      this.intervals[this.index] = now - this.lastFrame;
    }
    this.lastFrame = now;
  }
  /** After the integrator has submitted its render; this is CPU/submit latency, NOT GPU execution time. */
  endFrame(now: number): void {
    this.work[this.index] = now - this.start;
    this.index = (this.index + 1) % this.capacity;
  }
  reset(): void { this.lastFrame = -1; this.index = 0; this.intervals.fill(0); this.work.fill(0); }
  report(canvas: HTMLCanvasElement) {
    const samples = Array.from(this.intervals).filter(v => v > 0).sort((a, b) => a - b);
    const cpu = Array.from(this.work).filter(v => v > 0).sort((a, b) => a - b);
    const mean = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
    return { width: canvas.width, height: canvas.height, samples: samples.length,
      meanFps: mean ? 1000 / mean : 0, frameP95Ms: samples[Math.floor(samples.length * 0.95)] ?? 0,
      frameP99Ms: samples[Math.floor(samples.length * 0.99)] ?? 0,
      cpuSubmitP95Ms: cpu[Math.floor(cpu.length * 0.95)] ?? 0,
      framesOver20Ms: samples.filter(v => v > 20).length,
      note: 'Frame cadence and CPU/submit latency only. Use Chrome/Edge GPU tracing for GPU execution timing.',
    };
  }
}
