import { DataTexture, EquirectangularReflectionMapping, LinearMipmapLinearFilter, RepeatWrapping, RGBAFormat, SRGBColorSpace, type Texture } from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

type Surface = 'mud' | 'plaster' | 'wood' | 'tile' | 'brick';
type Channel = 'color' | 'normal' | 'roughness' | 'height' | 'ao';
interface Pixels { readonly data: Uint8Array; readonly width: number; readonly height: number }
const cache = new Map<string, Pixels>();
let loading: Promise<void> | null = null;
let sky: Texture | null = null;

/** Optional local CC0 photographic maps. Headless module tests retain procedural fallback. */
export function loadPhotoLibrary(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    const manifest = await fetch('/textures/manifest.json').then(response => { if (!response.ok) throw new Error('Texture manifest unavailable'); return response.json(); });
    await Promise.all(Object.entries(manifest.assets as Record<string, { maps: Record<string, { file: string }> }>).flatMap(([surface, asset]) =>
      Object.entries(asset.maps).map(async ([channel, file]) => {
        const response = await fetch(`/textures/${file.file}`); if (!response.ok) throw new Error(`Missing texture ${file.file}`);
        const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none' });
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('Unable to decode texture');
        ctx.drawImage(bitmap, 0, 0);
        const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
        cache.set(`${surface}-${channel}`, { data: new Uint8Array(data.data), width: bitmap.width, height: bitmap.height });
        bitmap.close();
      })));
    sky = await new HDRLoader().loadAsync('/textures/storm-sky.hdr'); sky.mapping = EquirectangularReflectionMapping;
  })();
  return loading;
}
export function photographicTexture(surface: Surface, channel: Channel, repeat = 1): DataTexture | null {
  const pixels = cache.get(`${surface}-${channel}`); if (!pixels) return null;
  const texture = new DataTexture(pixels.data, pixels.width, pixels.height, RGBAFormat);
  texture.wrapS = texture.wrapT = RepeatWrapping; texture.repeat.set(repeat, repeat);
  texture.generateMipmaps = true; texture.minFilter = LinearMipmapLinearFilter; texture.anisotropy = 8;
  if (channel === 'color') texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true; return texture;
}
let packedMud: Pixels | null = null;
export function photographicMudDetail(): DataTexture | null {
  const rough = cache.get('mud-roughness'), height = cache.get('mud-height'), ao = cache.get('mud-ao');
  if (!rough || !height || !ao) return null;
  if (!packedMud) {
    const data = new Uint8Array(rough.width * rough.height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = rough.data[i]!; data[i + 1] = height.data[i]!; data[i + 2] = ao.data[i]!; data[i + 3] = 255;
    }
    packedMud = { data, width: rough.width, height: rough.height };
  }
  const texture = new DataTexture(packedMud.data, packedMud.width, packedMud.height, RGBAFormat);
  texture.wrapS = texture.wrapT = RepeatWrapping; texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter; texture.anisotropy = 8; texture.needsUpdate = true;
  return texture;
}
export function photoLibraryStats(): { loadedMaps: number } { return { loadedMaps: cache.size }; }
export function photographicSky(): Texture | null { return sky; }
