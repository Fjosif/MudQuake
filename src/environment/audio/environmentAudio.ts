export interface EnvironmentAudioSystem {
  update: (rainIntensity: number, quakeIntensity: number) => void;
  resume: () => void;
  dispose: () => void;
}

/**
 * Procedural Web Audio API storm rain + earthquake sub-bass rumble.
 * Gracefully no-ops in headless/Node environments without AudioContext.
 */
export function createEnvironmentAudio(enabled: boolean): EnvironmentAudioSystem {
  if (!enabled || typeof window === 'undefined') {
    return {
      update: () => {},
      resume: () => {},
      dispose: () => {},
    };
  }

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioCtx) {
    return {
      update: () => {},
      resume: () => {},
      dispose: () => {},
    };
  }

  const ctx = new AudioCtx();
  const bufferSize = ctx.sampleRate * 2;
  const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);

  // Pink-ish noise for natural rainfall
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < bufferSize; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.96300 * b1 + white * 0.2965164;
    b2 = 0.57000 * b2 + white * 1.0526913;
    data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.12;
  }

  const rainSource = ctx.createBufferSource();
  rainSource.buffer = noiseBuffer;
  rainSource.loop = true;

  const rainFilter = ctx.createBiquadFilter();
  rainFilter.type = 'bandpass';
  rainFilter.frequency.value = 1800;
  rainFilter.Q.value = 0.55;

  const rainGain = ctx.createGain();
  rainGain.gain.value = 0.18;

  rainSource.connect(rainFilter);
  rainFilter.connect(rainGain);
  rainGain.connect(ctx.destination);
  rainSource.start();

  // Sub-bass earthquake rumble
  const rumbleSource = ctx.createBufferSource();
  rumbleSource.buffer = noiseBuffer;
  rumbleSource.loop = true;

  const rumbleFilter = ctx.createBiquadFilter();
  rumbleFilter.type = 'lowpass';
  rumbleFilter.frequency.value = 65;

  const rumbleGain = ctx.createGain();
  rumbleGain.gain.value = 0.0;

  rumbleSource.connect(rumbleFilter);
  rumbleFilter.connect(rumbleGain);
  rumbleGain.connect(ctx.destination);
  rumbleSource.start();

  const update = (rainIntensity: number, quakeIntensity: number) => {
    if (ctx.state === 'suspended') return;
    rainGain.gain.setTargetAtTime(0.05 + rainIntensity * 0.22, ctx.currentTime, 0.1);
    rumbleGain.gain.setTargetAtTime(quakeIntensity * 0.45, ctx.currentTime, 0.06);
  };

  const resume = () => {
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
  };

  const dispose = () => {
    try {
      rainSource.stop();
      rumbleSource.stop();
      rainSource.disconnect();
      rumbleSource.disconnect();
      void ctx.close();
    } catch {
      // Ignore cleanup errors on already-closed contexts
    }
  };

  return { update, resume, dispose };
}
