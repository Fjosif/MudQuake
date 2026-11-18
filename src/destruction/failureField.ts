import type { HouseComponent } from './house';
import { hash } from './random';

export interface LocalFailureProperties {
  readonly onset: number;
  readonly cornerWeakness: number;
  readonly fatigue: number;
  readonly lateDemand: number;
  readonly propagation: number;
  readonly delay: number;
}

/** Spatially correlated construction defects: one weak footing, irregular surrounding bays.
 * These modulate damage; support loss and real impacts still determine actual release.
 */
export function createFailureField(components: readonly HouseComponent[], seed: number, base: number) {
  const cornerIndex = Math.floor(hash(seed ^ 0x434f524e, 0) * 4);
  const corner = { x: (cornerIndex & 1 ? 1 : -1) * 4.82, z: (cornerIndex & 2 ? 1 : -1) * 3.82 };
  function noise(x: number, z: number): number {
    const gx = Math.floor(x / 2.8), gz = Math.floor(z / 2.8);
    let u = x / 2.8 - gx, v = z / 2.8 - gz;
    u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
    const n = (ix: number, iz: number) => hash(seed ^ Math.imul(ix, 73856093), Math.imul(iz, 19349663));
    const a = n(gx, gz) * (1 - u) + n(gx + 1, gz) * u;
    const b = n(gx, gz + 1) * (1 - u) + n(gx + 1, gz + 1) * u;
    return a * (1 - v) + b * v;
  }
  const properties: LocalFailureProperties[] = components.map(c => {
    const height = Math.max(0, c.position.y - base);
    const distance = Math.hypot(c.position.x - corner.x, c.position.z - corner.z);
    const correlated = noise(c.position.x, c.position.z);
    return {
      onset: 8.4 + distance * 0.20 + height * 0.06 + correlated * 1.3,
      cornerWeakness: 2.8 * Math.exp(-distance * distance / 7) * Math.max(0.15, Math.min(1, (3 - height) / 2))
        * (c.kind === 'post' && height < 2 ? 1.65 : 1),
      fatigue: 0.65 + hash(seed ^ 0x46415449, c.id) * 1.05,
      lateDemand: 0.9 + hash(seed ^ 0x4c4f4144, c.id) * 0.65,
      propagation: 0.75 + hash(seed ^ 0x50415448, c.id) * 0.65,
      delay: 0.08 + hash(seed ^ 0x44454c41, c.id) * 0.62,
    };
  });
  return { corner, properties };
}
