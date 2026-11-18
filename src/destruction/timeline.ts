import { DEFAULT_EVENT_SEED, type EarthquakeState } from './contracts';

/** Pure reference sampler; no clock, renderer or loop. Integration can use its own timeline. */
export function sampleEarthquake(elapsedTime: number, eventSeed = DEFAULT_EVENT_SEED): EarthquakeState {
  const t = Math.max(0, elapsedTime);
  const phase = t < 3 ? 'idle' : t < 6 ? 'tremor' : t < 9 ? 'severe' : t < 17 ? 'collapse' : 'aftermath';
  const smooth = (x: number) => { const u = Math.min(1, Math.max(0, x)); return u * u * u * (u * (u * 6 - 15) + 10); };
  let intensity = 0;
  if (t >= 3 && t < 6) intensity = 0.14 * smooth((t - 3) / 3);
  else if (t < 9 && t >= 6) intensity = 0.14 + 0.56 * smooth((t - 6) / 3);
  else if (t >= 9 && t < 12) intensity = 0.7 + 0.3 * smooth((t - 9) / 3);
  else if (t >= 12 && t < 17) intensity = 1 - 0.83 * smooth((t - 12) / 5);
  else if (t >= 17 && t < 25) intensity = 0.17 * Math.exp(-0.18 * (t - 17) ** 2) * (1 - smooth((t - 23) / 2));
  const p = (eventSeed >>> 0) * 0.000001;
  const ramp = Math.min(1, Math.max(0, (t - 3) * 2));
  // Superimposed 0.9–3.7 Hz waves, band-limited to avoid fixed-step aliasing.
  const a = intensity * ramp;
  return {
    elapsedTime: t, phase, intensity, eventSeed,
    groundDisplacement: {
      x: a * (0.085 * Math.sin(t * 9.7 + p) + 0.035 * Math.sin(t * 22.8)),
      y: a * (0.018 * Math.sin(t * 15.1 + p * 0.7)),
      z: a * (0.065 * Math.sin(t * 8.3 + p * 1.3) + 0.026 * Math.sin(t * 19.4)),
    },
  };
}
