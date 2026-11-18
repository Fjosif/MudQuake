import type { DestructionEvent, EarthquakeState, Vec3 } from './contracts';
import { randomSource } from './random';

/** No AudioContext until a user gesture. Supplied contexts always remain integrator-owned. */
export class DestructionAudio {
  private context: AudioContext | undefined; private ownsContext = false;
  private master: GainNode | undefined; private rumble: GainNode | undefined;
  private bed: AudioBufferSourceNode | undefined; private noise: AudioBuffer | undefined;
  private readonly voices = new Set<AudioBufferSourceNode>();
  private listener: Vec3 = { x: 0, y: 1.7, z: 22 };
  private enabled: boolean; private disposed = false;
  constructor(private readonly seed: number, enabled: boolean, supplied?: AudioContext) { this.enabled = enabled; this.context = supplied; }
  async unlock(): Promise<void> {
    if (!this.enabled || this.disposed) return;
    if (!this.context) {
      if (typeof globalThis.AudioContext === 'undefined') return;
      this.context = new AudioContext(); this.ownsContext = true;
    }
    const ctx = this.context;
    if (!this.master) {
      this.master = ctx.createGain(); this.master.gain.value = 0.6;
      const compressor = ctx.createDynamicsCompressor(); compressor.threshold.value = -14; compressor.ratio.value = 5;
      this.master.connect(compressor); compressor.connect(ctx.destination);
      // Keep compressor in the owned graph; disconnect via master and source stop at dispose.
      this.compressor = compressor;
      const rng = randomSource(this.seed ^ 0xa0d10);
      this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      let smooth = 0;
      for (let i = 0; i < data.length; i++) { smooth = smooth * 0.92 + (rng() * 2 - 1) * 0.08; data[i] = smooth * 3; }
      this.bed = ctx.createBufferSource(); this.bed.buffer = this.noise; this.bed.loop = true;
      const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 95;
      this.bedFilter = filter;
      this.rumble = ctx.createGain(); this.rumble.gain.value = 0;
      this.bed.connect(filter); filter.connect(this.rumble); this.rumble.connect(this.master); this.bed.start();
    }
    if (ctx.state === 'suspended') await ctx.resume();
  }
  private compressor: DynamicsCompressorNode | undefined; private bedFilter: BiquadFilterNode | undefined;
  private readonly voiceGraphs = new Map<AudioBufferSourceNode, AudioNode[]>();
  setListenerPosition(position: Vec3): void { this.listener = { x: position.x, y: position.y, z: position.z }; }
  update(state: EarthquakeState): void {
    if (this.context && this.rumble) this.rumble.gain.setTargetAtTime(Math.min(1, Math.max(0, state.intensity)) * 0.7, this.context.currentTime, 0.06);
  }
  emit(event: DestructionEvent): void {
    const ctx = this.context;
    if (!ctx || !this.master || !this.noise || ctx.state !== 'running' || this.voices.size >= 24) return;
    if (!['crack', 'glass', 'failure', 'impact'].includes(event.type)) return;
    const source = ctx.createBufferSource(); source.buffer = this.noise;
    const gain = ctx.createGain(), filter = ctx.createBiquadFilter(), panner = ctx.createPanner();
    filter.type = 'bandpass'; filter.frequency.value = event.type === 'glass' ? 3900 : event.type === 'crack' ? 1300 : event.kind === 'roof' ? 380 : 130;
    filter.Q.value = event.type === 'glass' ? 0.6 : 1.2;
    const duration = event.type === 'crack' ? 0.13 : event.type === 'glass' ? 0.48 : 0.65;
    const now = ctx.currentTime, amplitude = Math.min(0.8, 0.12 + event.energy * 0.6);
    gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(amplitude, now + 0.006); gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    // Position relative to listener avoids modifying a borrowed AudioContext's global listener.
    panner.positionX.value = event.position.x - this.listener.x;
    panner.positionY.value = event.position.y - this.listener.y;
    panner.positionZ.value = event.position.z - this.listener.z;
    panner.panningModel = 'equalpower'; panner.refDistance = 8; panner.maxDistance = 100; panner.rolloffFactor = 0.6;
    source.connect(filter); filter.connect(gain); gain.connect(panner); panner.connect(this.master);
    this.voices.add(source); this.voiceGraphs.set(source, [filter, gain, panner]);
    source.onended = () => { source.disconnect(); this.voiceGraphs.get(source)?.forEach(n => n.disconnect()); this.voiceGraphs.delete(source); this.voices.delete(source); };
    source.playbackRate.value = 0.86 + (event.seed % 29) / 100;
    source.start(now, (event.seed % 700) / 1000, duration); source.stop(now + duration + 0.05);
  }
  reset(): void {
    for (const source of this.voices) { source.stop(); source.disconnect(); this.voiceGraphs.get(source)?.forEach(n => n.disconnect()); }
    this.voices.clear(); this.voiceGraphs.clear();
    if (this.context && this.rumble) { this.rumble.gain.cancelScheduledValues(this.context.currentTime); this.rumble.gain.setValueAtTime(0, this.context.currentTime); }
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.reset(); this.bed?.stop(); this.bed?.disconnect();
    this.bedFilter?.disconnect(); this.rumble?.disconnect(); this.master?.disconnect(); this.compressor?.disconnect();
    if (this.context && this.ownsContext) void this.context.close();
    this.noise = undefined;
  }
}
