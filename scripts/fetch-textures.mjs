import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
const root = new URL('../public/textures/', import.meta.url);
await mkdir(root, { recursive: true });
const assets = { mud: 'brown_mud_03', plaster: 'plastered_wall_02', wood: 'weathered_planks', tile: 'clay_roof_tiles_02', brick: 'red_brick_03' };
const manifest = { license: 'CC0-1.0', licenseUrl: 'https://polyhaven.com/license', resolution: '1k', assets: {} };
for (const [key, id] of Object.entries(assets)) {
  const response = await fetch(`https://api.polyhaven.com/files/${id}`);
  if (!response.ok) throw new Error(`Asset ${id}: ${response.status}`);
  const files = await response.json();
  const entries = {};
  const maps = { color: files.Diffuse ?? files.diff, normal: files.nor_gl, roughness: files.Rough ?? files.rough,
    ...(key === 'mud' ? { height: files.Displacement ?? files.disp, ao: files.AO ?? files.ao } : {}) };
  await Promise.all(Object.entries(maps).map(async ([type, variants]) => {
    const file = variants?.['1k']?.jpg;
    if (!file) throw new Error(`Missing 1k JPEG: ${id} ${type}`);
    const filename = `${key}-${type}.jpg`, destination = new URL(filename, root);
    let bytes;
    try { bytes = await readFile(destination); } catch { /* download below */ }
    if (!bytes || (file.md5 && createHash('md5').update(bytes).digest('hex') !== file.md5)) {
      const download = await fetch(file.url); if (!download.ok) throw new Error(`Download ${download.status}: ${file.url}`); bytes = Buffer.from(await download.arrayBuffer());
    }
    const md5 = createHash('md5').update(bytes).digest('hex');
    if (file.md5 && md5 !== file.md5) throw new Error(`Checksum mismatch: ${filename}`);
    await writeFile(destination, bytes); entries[type] = { file: filename, source: file.url, bytes: bytes.length, md5 };
  }));
  manifest.assets[key] = { id, page: `https://polyhaven.com/a/${id}`, maps: entries };
  console.log(key, Object.keys(entries).join(', '));
}
const skyId = 'kloofendal_overcast_puresky';
const skyFiles = await (await fetch(`https://api.polyhaven.com/files/${skyId}`)).json();
const sky = skyFiles.hdri['1k'].hdr;
const skyBytes = Buffer.from(await (await fetch(sky.url)).arrayBuffer());
if (createHash('md5').update(skyBytes).digest('hex') !== sky.md5) throw new Error('Sky checksum mismatch');
await writeFile(new URL('storm-sky.hdr', root), skyBytes);
manifest.sky = { id: skyId, page: `https://polyhaven.com/a/${skyId}`, source: sky.url, bytes: skyBytes.length, md5: sky.md5 };
await writeFile(new URL('manifest.json', root), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(new URL('CREDITS.md', root), '# Textures\n\nCC0 assets from Poly Haven. License: https://polyhaven.com/license\n\n' + Object.values(manifest.assets).map(asset => `- [${asset.id}](${asset.page}) — 1K color, OpenGL normal and roughness maps. Original download URLs and checksums are in manifest.json.`).join('\n') + `\n- [${skyId}](https://polyhaven.com/a/${skyId}) — 1K HDR sky and image-based lighting.\n`);
