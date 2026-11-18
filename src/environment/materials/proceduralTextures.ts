import * as THREE from 'three';
import { photographicMudDetail, photographicTexture } from '../../materials/photoLibrary';
import { clamp, hash2D, lerp } from '../math/prng';

export interface MudTextureSet {
  mudAlbedo: THREE.DataTexture;
  mudNormal: THREE.DataTexture;
  mudDetail: THREE.DataTexture; // R: roughness, G: height/porosity, B: AO
  gravelAlbedo: THREE.DataTexture;
  gravelNormal: THREE.DataTexture;
  dispose: () => void;
}

/**
 * Tileable 2D value noise with integer period `period`.
 */
function tileableNoise(u: number, v: number, period: number, seed: number): number {
  const x = u * period;
  const y = v * period;
  const ix0 = Math.floor(x) % period;
  const iy0 = Math.floor(y) % period;
  const ix1 = (ix0 + 1) % period;
  const iy1 = (iy0 + 1) % period;

  const fx = x - Math.floor(x);
  const fy = y - Math.floor(y);
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const n00 = hash2D(ix0 < 0 ? ix0 + period : ix0, iy0 < 0 ? iy0 + period : iy0, seed);
  const n10 = hash2D(ix1 < 0 ? ix1 + period : ix1, iy0 < 0 ? iy0 + period : iy0, seed);
  const n01 = hash2D(ix0 < 0 ? ix0 + period : ix0, iy1 < 0 ? iy1 + period : iy1, seed);
  const n11 = hash2D(ix1 < 0 ? ix1 + period : ix1, iy1 < 0 ? iy1 + period : iy1, seed);

  return lerp(lerp(n00, n10, ux), lerp(n01, n11, ux), uy);
}

function tileableFbm(
  u: number,
  v: number,
  basePeriod: number,
  octaves: number,
  seed: number
): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let period = basePeriod;
  for (let i = 0; i < octaves; i++) {
    sum += amp * tileableNoise(u, v, period, seed + i * 131);
    norm += amp;
    amp *= 0.5;
    period *= 2;
  }
  return sum / norm;
}

function configureTexture(
  data: Uint8Array,
  size: number,
  colorSpace: THREE.ColorSpace
): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.colorSpace = colorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates deterministic, seamlessly tileable procedural PBR textures for wet mud and gravel.
 */
export function generateMudTextures(size: number, seed: number): MudTextureSet {
  const count = size * size;
  const mudHeight = new Float32Array(count);
  const gravelHeight = new Float32Array(count);

  const mudAlbedoData = new Uint8Array(count * 4);
  const mudNormalData = new Uint8Array(count * 4);
  const mudDetailData = new Uint8Array(count * 4);
  const gravelAlbedoData = new Uint8Array(count * 4);
  const gravelNormalData = new Uint8Array(count * 4);

  // Pass 1: Compute heightfields and albedo/detail
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const idx = y * size + x;
      const o = idx * 4;

      // Mud height: macro clods + churned lumps + sharp micro-grit
      const clods = tileableFbm(u, v, 8, 4, seed + 17);
      const lumps = tileableFbm(u, v, 20, 3, seed + 53);
      const grit = tileableFbm(u, v, 48, 3, seed + 89);
      const microSand = tileableNoise(u, v, 128, seed + 233) * 0.14;
      const streak = tileableNoise(u * 0.5, v * 2.0, 16, seed + 173) * 0.18;
      const hMud = clods * 0.45 + lumps * 0.3 + grit * 0.2 + microSand + streak;
      mudHeight[idx] = hMud;

      // Realistic wet loam / clay-silt palette with strong crevice-to-clod-top contrast
      const ridgeTop = clamp(0.5 + hMud * 0.85, 0, 1);
      const siltMix = clamp(0.5 + grit * 0.8, 0, 1);
      const organicSpeck = clamp(tileableNoise(u, v, 64, seed + 293) * 0.5 + 0.5, 0, 1);

      // Crevices: near-black espresso wet mud -> Clod tops: earthy damp umber/olive clay
      const r = lerp(24, 86, ridgeTop) + siltMix * 14 - organicSpeck * 8;
      const g = lerp(20, 70, ridgeTop) + siltMix * 11 - organicSpeck * 7;
      const b = lerp(16, 52, ridgeTop) + siltMix * 8 - organicSpeck * 5;

      mudAlbedoData[o] = clamp(Math.round(r), 0, 255);
      mudAlbedoData[o + 1] = clamp(Math.round(g), 0, 255);
      mudAlbedoData[o + 2] = clamp(Math.round(b), 0, 255);
      mudAlbedoData[o + 3] = 255;

      // Detail: R = base roughness (slick troughs vs slightly matte clod tops), G = height [0..1], B = AO
      const rough = clamp(0.18 + ridgeTop * 0.42 + grit * 0.1, 0.08, 0.78);
      const hNorm = clamp(0.5 + hMud * 0.65, 0, 1);
      const ao = clamp(0.42 + ridgeTop * 0.58, 0.25, 1.0);

      mudDetailData[o] = Math.round(rough * 255);
      mudDetailData[o + 1] = Math.round(hNorm * 255);
      mudDetailData[o + 2] = Math.round(ao * 255);
      mudDetailData[o + 3] = 255;

      // Crushed wet gravel around house pad
      const stones = Math.abs(tileableFbm(u, v, 24, 3, seed + 311));
      const fineSand = tileableFbm(u, v, 64, 2, seed + 401);
      const hGrav = (1.0 - stones) * 0.72 + fineSand * 0.28;
      gravelHeight[idx] = hGrav;

      const gTone = clamp(0.32 + hGrav * 0.48, 0.18, 0.72);
      const gWarm = fineSand * 8;
      gravelAlbedoData[o] = clamp(Math.round(gTone * 105 + gWarm), 0, 255);
      gravelAlbedoData[o + 1] = clamp(Math.round(gTone * 102 + gWarm * 0.6), 0, 255);
      gravelAlbedoData[o + 2] = clamp(Math.round(gTone * 98), 0, 255);
      gravelAlbedoData[o + 3] = 255;
    }
  }

  // Pass 2: Compute wrap-around Sobel/central-difference normal maps
  const mudStrength = 5.2;
  const gravelStrength = 4.2;

  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const idx = y * size + x;
      const o = idx * 4;

      // Mud normal
      {
        const dX = (mudHeight[y * size + xp] - mudHeight[y * size + xm]) * mudStrength;
        const dY = (mudHeight[yp * size + x] - mudHeight[ym * size + x]) * mudStrength;
        const invLen = 1 / Math.hypot(-dX, -dY, 1.0);
        mudNormalData[o] = Math.round((-dX * invLen * 0.5 + 0.5) * 255);
        mudNormalData[o + 1] = Math.round((-dY * invLen * 0.5 + 0.5) * 255);
        mudNormalData[o + 2] = Math.round((invLen * 0.5 + 0.5) * 255);
        mudNormalData[o + 3] = 255;
      }

      // Gravel normal
      {
        const dX = (gravelHeight[y * size + xp] - gravelHeight[y * size + xm]) * gravelStrength;
        const dY = (gravelHeight[yp * size + x] - gravelHeight[ym * size + x]) * gravelStrength;
        const invLen = 1 / Math.hypot(-dX, -dY, 1.0);
        gravelNormalData[o] = Math.round((-dX * invLen * 0.5 + 0.5) * 255);
        gravelNormalData[o + 1] = Math.round((-dY * invLen * 0.5 + 0.5) * 255);
        gravelNormalData[o + 2] = Math.round((invLen * 0.5 + 0.5) * 255);
        gravelNormalData[o + 3] = 255;
      }
    }
  }

  const mudAlbedo = photographicTexture('mud', 'color') ?? configureTexture(mudAlbedoData, size, THREE.SRGBColorSpace);
  const mudNormal = photographicTexture('mud', 'normal') ?? configureTexture(mudNormalData, size, THREE.NoColorSpace);
  const mudDetail = photographicMudDetail() ?? configureTexture(mudDetailData, size, THREE.NoColorSpace);
  const gravelAlbedo = configureTexture(gravelAlbedoData, size, THREE.SRGBColorSpace);
  const gravelNormal = configureTexture(gravelNormalData, size, THREE.NoColorSpace);

  return {
    mudAlbedo,
    mudNormal,
    mudDetail,
    gravelAlbedo,
    gravelNormal,
    dispose: () => {
      mudAlbedo.dispose();
      mudNormal.dispose();
      mudDetail.dispose();
      gravelAlbedo.dispose();
      gravelNormal.dispose();
    },
  };
}
