import { readFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { decodeEcd, decodeTiles4bpp, uiResources } from './localize-ui.mjs';

const rom = readFileSync(process.env.COSTUME_UI_ROM ?? new URL('../work/Super Real Mahjong Dousoukai (Japan).gba', import.meta.url));
const previewDirectory = new URL(process.env.COSTUME_UI_ROM ? '../work/costume-ui/translated/' : '../work/costume-ui/', import.meta.url);
mkdirSync(previewDirectory, { recursive: true });
if (process.argv[2] === 'frames') {
  const resources = uiResources(rom, 1);
  const imageId = Number(process.argv[3] ?? 36);
  const patternId = Number(process.argv[4] ?? 37);
  const imageResource = resources[imageId];
  const image = imageResource.type === 'ECD' ? decodeEcd(rom.subarray(imageResource.offset)) : rom.subarray(imageResource.offset);
  const atlasWidth = image[5] * 8;
  const atlas = decodeTiles4bpp(image.subarray(8), atlasWidth, image[6] * 8);
  const pattern = rom.subarray(resources[patternId].offset, resources[patternId + 1].offset);
  const sizes = [[[8, 8], [16, 16], [32, 32], [64, 64]],
    [[16, 8], [32, 8], [32, 16], [64, 32]], [[8, 16], [8, 32], [16, 32], [32, 64]]];
  const paths = [];
  for (let frame = 0; frame < pattern.readUInt32LE(4); frame++) {
    let cursor = pattern.readUInt32LE(8 + frame * 4);
    const count = pattern.readUInt16LE(cursor);
    cursor += 2;
    const pieces = [];
    for (let index = 0; index < count; index++) {
      const flags = pattern.readUInt16LE(cursor);
      cursor += 2;
      let left = 0;
      let top = 0;
      if (flags & 0x2000) {
        left = pattern.readInt16LE(cursor);
        top = pattern.readInt16LE(cursor + 2);
        cursor += 4;
      }
      const tile = pattern.readUInt16LE(cursor);
      cursor += 2;
      const [width, height] = sizes[flags >> 6 & 3][flags >> 4 & 3];
      pieces.push({ flags, left, top, tile, width, height });
    }
    const minX = Math.min(...pieces.map(piece => piece.left));
    const minY = Math.min(...pieces.map(piece => piece.top));
    const width = Math.max(...pieces.map(piece => piece.left + piece.width)) - minX;
    const height = Math.max(...pieces.map(piece => piece.top + piece.height)) - minY;
    const pixels = Buffer.alloc(width * height);
    for (const piece of pieces) {
      for (let row = 0; row < piece.height; row++) {
        for (let column = 0; column < piece.width; column++) {
          const sourceX = piece.tile % 32 * 8 + (piece.flags & 0x200 ? piece.width - column - 1 : column);
          const sourceY = Math.floor(piece.tile / 32) * 8 + (piece.flags & 0x400 ? piece.height - row - 1 : row);
          const value = atlas[sourceY * atlasWidth + sourceX];
          if (value) pixels[(piece.top - minY + row) * width + piece.left - minX + column] = value;
        }
      }
    }
    const path = new URL(`frame-${imageId}-${frame}.png`, previewDirectory).pathname;
    const result = spawnSync('magick', ['pgm:-', '-filter', 'point', '-resize', '400%',
      '-background', '#303030', '-gravity', 'northwest', '-extent', `${Math.max(320, width * 4)}x${height * 4 + 24}`,
      '-font', '/System/Library/Fonts/Menlo.ttc', '-fill', 'white', '-pointsize', '14',
      '-gravity', 'southwest', '-annotate', '+2+2', `${frame}: ${width}x${height} (${pieces.length} pieces)`, path], {
      input: Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), pixels.map(value => value * 17)]),
    });
    if (result.status !== 0) throw new Error(result.stderr.toString());
    paths.push(path);
  }
  const result = spawnSync('magick', ['montage', '-font', '/System/Library/Fonts/Menlo.ttc', ...paths,
    '-tile', '3x', '-geometry', '+3+3', new URL(`frames-${imageId}.png`, previewDirectory).pathname]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
  console.log(`Reassembled ${paths.length} PAT frames from image ${imageId}, pattern ${patternId}`);
  process.exit(0);
}
const packageId = Number(process.argv[2] ?? 1);
const output = new URL(packageId === 1 ? './' : `package-${packageId}/`, previewDirectory);
mkdirSync(output, { recursive: true });
const images = [];
for (const resource of uiResources(rom, packageId)) {
  if (!['IMG', 'ECD'].includes(resource.type)) continue;
  if (resource.type === 'ECD' && rom[resource.offset + 3] !== 1) {
    console.log(`Skipping ECD variant ${rom[resource.offset + 3]} at ${resource.id}`);
    continue;
  }
  const data = resource.type === 'ECD' ? decodeEcd(rom.subarray(resource.offset)) : rom.subarray(resource.offset);
  if (data.toString('ascii', 0, 3) !== 'IMG' || data[4] !== 0) continue;
  const width = data[5] * 8;
  const height = data[6] * 8;
  if (height > 96) continue;
  const pixels = decodeTiles4bpp(data.subarray(8), width, height);
  const path = new URL(`atlas-${resource.id}.png`, output).pathname;
  const result = spawnSync('magick', ['pgm:-', '-background', '#303030', '-gravity', 'northwest',
    '-extent', '256x112', '-fill', 'white', '-font', '/System/Library/Fonts/Menlo.ttc', '-pointsize', '12',
    '-gravity', 'southwest', '-annotate', '+2+2', `${resource.id}: ${width}x${height}`, path], {
    input: Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), pixels.map(value => value * 17)]),
  });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  images.push(path);
}
for (let start = 0; start < images.length; start += 40) {
  const result = spawnSync('magick', ['montage', '-font', '/System/Library/Fonts/Menlo.ttc', ...images.slice(start, start + 40), '-tile', '4x',
    '-geometry', '+3+3', new URL(`sheet-${start / 40}.png`, output).pathname]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}
console.log(`Decoded ${images.length} small UI atlases into ${output.pathname}`);