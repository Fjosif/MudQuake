import { Color, DataTexture, DoubleSide, MeshPhysicalMaterial, MeshStandardMaterial, RepeatWrapping, RGBAFormat, SRGBColorSpace, Vector2, type Material, type Texture } from 'three';
import { photographicTexture } from '../materials/photoLibrary';
import { randomSource } from './random';

export type MaterialKey = 'plaster' | 'brick' | 'wood' | 'tile' | 'concrete' | 'metal' | 'glass' | 'interior' | 'fracture';
export interface HouseMaterials { readonly materials: Record<MaterialKey, MeshStandardMaterial>; dispose(): void }

/** CPU-generated PBR textures work in Node tests and WebGPU without GLSL hooks or external assets. */
export function createMaterials(seed: number): HouseMaterials {
  const textures: Texture[] = [];
  const rng = randomSource(seed ^ 0x746578);
  function surface(key: MaterialKey, hex: number, roughness: number, repeat: number): MeshStandardMaterial {
    if (key === 'plaster' || key === 'wood' || key === 'tile' || key === 'brick') {
      const map = photographicTexture(key, 'color', repeat), normalMap = photographicTexture(key, 'normal', repeat), roughnessMap = photographicTexture(key, 'roughness', repeat);
      if (map && normalMap && roughnessMap) {
        textures.push(map, normalMap, roughnessMap);
        return new MeshStandardMaterial({ map, normalMap, roughnessMap, roughness: 0.96, normalScale: new Vector2(key === 'tile' ? 0.3 : 0.6, key === 'tile' ? 0.3 : 0.6), ...(key === 'tile' ? { side: DoubleSide } : {}) });
      }
    }
    const n = 128, pixels = new Uint8Array(n * n * 4), roughPixels = new Uint8Array(n * n * 4);
    const heights = new Float32Array(n * n), normals = new Uint8Array(n * n * 4);
    const base = new Color(hex).convertLinearToSRGB();
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const grain = (rng() - 0.5) * 0.14;
      const coarse = Math.sin(x * 0.18 + Math.sin(y * 0.07) * 2) * Math.sin(y * 0.11) * 0.05;
      const mortar = key === 'brick' && ((y % 24 < 2) || ((x + Math.floor(y / 24) % 2 * 28) % 56 < 2));
      const wood = key === 'wood' ? Math.sin(x * 1.7 + Math.sin(y * 0.06) * 2) * 0.13 + Math.sin(x * 0.3) * 0.06 : 0;
      const streak = key === 'plaster' ? -0.12 * Math.max(0, Math.sin(x * 0.19 + Math.sin(y * 0.022))) : 0;
      const f = mortar ? 0.55 : 0.88 + grain + coarse + wood + streak;
      for (let c = 0; c < 3; c++) pixels[i * 4 + c] = Math.min(255, (c === 0 ? base.r : c === 1 ? base.g : base.b) * f * 255);
      pixels[i * 4 + 3] = 255;
      const r = Math.max(0, Math.min(255, (roughness + grain * 0.7) * 255));
      roughPixels.set([r, r, r, 255], i * 4);
      heights[i] = mortar ? -0.65 : grain + wood * 0.3;
    }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const dx = heights[y * n + (x + 1) % n]! - heights[y * n + (x + n - 1) % n]!;
      const dy = heights[((y + 1) % n) * n + x]! - heights[((y + n - 1) % n) * n + x]!;
      const inv = 1 / Math.hypot(dx, dy, 1);
      normals.set([(1 - dx * inv) * 127.5, (1 - dy * inv) * 127.5, (1 + inv) * 127.5, 255], (y * n + x) * 4);
    }
    function texture(data: Uint8Array, srgb = false): DataTexture {
      const t = new DataTexture(data, n, n, RGBAFormat);
      t.wrapS = t.wrapT = RepeatWrapping; t.repeat.set(repeat, repeat);
      t.generateMipmaps = true; t.anisotropy = 4;
      if (srgb) t.colorSpace = SRGBColorSpace;
      t.needsUpdate = true; textures.push(t); return t;
    }
    return new MeshStandardMaterial({ map: texture(pixels, true), roughness: 1, roughnessMap: texture(roughPixels), normalMap: texture(normals), metalness: key === 'metal' ? 0.78 : 0, ...(key === 'tile' ? { side: DoubleSide } : {}) });
  }
  const materials: Record<MaterialKey, MeshStandardMaterial> = {
    plaster: surface('plaster', 0xc2b9a2, 0.87, 0.65),
    brick: surface('brick', 0x835947, 0.92, 0.7),
    wood: surface('wood', 0x655143, 0.85, 1.4),
    tile: surface('tile', 0x744a37, 0.73, 1),
    concrete: surface('concrete', 0x6e7069, 0.97, 0.8),
    metal: surface('metal', 0x4a4c47, 0.63, 2),
    glass: new MeshPhysicalMaterial({ color: 0x79918b, roughness: 0.19, metalness: 0.16, transparent: true, opacity: 0.32, depthWrite: false, side: DoubleSide }),
    interior: surface('interior', 0x999584, 0.94, 1),
    fracture: new MeshStandardMaterial({ color: 0x29251f, roughness: 1 }),
  };
  return { materials, dispose() { Object.values(materials).forEach((m: Material) => m.dispose()); textures.forEach(t => t.dispose()); } };
}
