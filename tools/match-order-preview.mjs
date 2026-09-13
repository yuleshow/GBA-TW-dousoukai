import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { applyUi, decodeTiles4bpp, uiResources } from './localize-ui.mjs';

export function namePattern(rom, patternId, frame) {
  const resources = uiResources(rom, 1);
  const data = rom.subarray(resources[patternId].offset, resources[patternId + 1].offset);
  if (resources[patternId].type !== 'PAT' || frame < 0 || frame >= data.readUInt32LE(4)) throw new Error('Invalid name PAT frame');
  let cursor = data.readUInt32LE(8 + frame * 4);
  const count = data.readUInt16LE(cursor);
  cursor += 2;
  const sizes = [[[8, 8], [16, 16], [32, 32], [64, 64]],
    [[16, 8], [32, 8], [32, 16], [64, 32]], [[8, 16], [8, 32], [16, 32], [32, 64]]];
  const pieces = [];
  for (let index = 0; index < count; index++) {
    const flags = data.readUInt16LE(cursor);
    cursor += 2;
    let left = 0;
    let top = 0;
    if (flags & 0x2000) {
      left = data.readInt16LE(cursor);
      top = data.readInt16LE(cursor + 2);
      cursor += 4;
    }
    const tile = data.readUInt16LE(cursor);
    cursor += 2;
    const [width, height] = sizes[flags >> 6 & 3][flags >> 4 & 3];
    if (flags & 0x600) throw new Error('Flipped name sprite');
    pieces.push({ rect: [tile % 32 * 8, Math.floor(tile / 32) * 8, width, height], at: [left, top] });
  }
  const origin = [Math.min(...pieces.map(piece => piece.at[0])), Math.min(...pieces.map(piece => piece.at[1]))];
  const slices = pieces.map(piece => ({ ...piece, at: piece.at.map((value, axis) => value - origin[axis]) }));
  const size = [0, 1].map(axis => Math.max(...slices.map(slice => slice.at[axis] + slice.rect[axis + 2])));
  return { size, slices, origin };
}

export function composeName(atlas, width, pattern) {
  const pixels = Buffer.alloc(pattern.size[0] * pattern.size[1]);
  for (const { rect: [left, top, across, down], at: [offsetX, offsetY] } of pattern.slices) {
    for (let row = 0; row < down; row++) {
      for (let column = 0; column < across; column++) {
        const value = atlas[(top + row) * width + left + column];
        if (value === undefined) throw new Error('Name sprite outside atlas');
        if (value) pixels[(offsetY + row) * pattern.size[0] + offsetX + column] = value;
      }
    }
  }
  return pixels;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rom = readFileSync(new URL('../work/Super Real Mahjong Dousoukai (Japan).gba', import.meta.url));
  const digest = data => createHash('sha256').update(data).digest('hex');
  const protectedPaths = ['../work/Super Real Mahjong Dousoukai (Japan).gba', '../build/dousoukai-zh-Hant.gba',
    '../build/dousoukai-zh-Hant.ips', '../build/report.json', '../translations/ui.json', '../tools/localize-ui.mjs',
    '../tools/build-rom.mjs', '../README.md'];
  const protectedHashes = Object.fromEntries(protectedPaths.map(path => [path, digest(readFileSync(new URL(path, import.meta.url)))]));
  const modified = Buffer.from(rom);
  const { patches } = applyUi(rom, modified);
  const asset = JSON.parse(readFileSync(new URL('../translations/names-ui.json', import.meta.url), 'utf8'))
    .assets.find(entry => entry.packageId === 1 && entry.resourceId === 28);
  const resources = uiResources(rom, 1);
  const image = rom.subarray(resources[28].offset);
  const atlas = decodeTiles4bpp(image.subarray(8), image[5] * 8, image[6] * 8);
  const translatedAtlas = decodeTiles4bpp(modified.subarray(resources[28].offset + 8), image[5] * 8, image[6] * 8);
  const output = new URL('../work/match-order/', import.meta.url);
  mkdirSync(output, { recursive: true });
  for (const patternId of [29, 31]) {
    const paths = [];
    const count = rom.readUInt32LE(resources[patternId].offset + 4);
    for (let frame = 0; frame < count; frame++) {
      const pattern = namePattern(rom, patternId, frame);
      const source = composeName(atlas, image[5] * 8, pattern);
      const translated = composeName(translatedAtlas, image[5] * 8, pattern);
      const pixels = Buffer.alloc(pattern.size[0] * 40);
      source.copy(pixels);
      translated.copy(pixels, pattern.size[0] * 24);
      const path = new URL(`comparison-${patternId}-${frame}.png`, output).pathname;
      const result = spawnSync('magick', ['pgm:-', '-filter', 'point', '-resize', '400%',
        '-background', '#303030', '-gravity', 'northwest', '-extent', '384x184',
        '-font', '/System/Library/Fonts/Menlo.ttc', '-fill', 'white', '-pointsize', '14',
        '-gravity', 'southwest', '-annotate', '+2+2', `PAT ${patternId}/${frame}  JP above / zh-Hant below`, path], {
        input: Buffer.concat([Buffer.from(`P5\n${pattern.size[0]} 40\n255\n`), pixels.map(value => value * 17)]),
      });
      if (result.status !== 0) throw new Error(result.stderr.toString());
      paths.push(path);
    }
    const result = spawnSync('magick', ['montage', '-font', '/System/Library/Fonts/Menlo.ttc', ...paths, '-tile', '3x', '-geometry', '+3+3',
      new URL(`comparison-${patternId}-sheet.png`, output).pathname]);
    if (result.status !== 0) throw new Error(result.stderr.toString());
  }
  for (const [path, hash] of Object.entries(protectedHashes)) assert.equal(digest(readFileSync(new URL(path, import.meta.url))), hash);
  const patch = patches.find(entry => entry.packageId === 1 && entry.resourceId === 28);
  writeFileSync(new URL('proof.json', output), `${JSON.stringify({
    method: 'Original and applyUi-in-memory IMG 28 reconstructed through unchanged PAT 31 and shared PAT 29. No ROM file written.',
    limitation: 'Pixel-index name-sheet proof, not an emulator screenshot. Full-name surnames intentionally unchanged; no final build performed.',
    screenEvidence: { descriptorTable: '0x0821fc8c', loader: '0x0801ee24', nameInitializer: '0x0801ee68',
      patternInstruction: '0x0801eeb0: movs r2, #31', image: [1, 28], palette: [1, 24], pattern: [1, 31],
      roleImage: [1, 235], headingImage: [1, 262], screenResource: null },
    originalRomSha256: digest(rom), sourceImageSha256: digest(rom.subarray(resources[28].offset, resources[29].offset)),
    patch: { offset: patch.offset, length: patch.after.length, beforeSha256: digest(patch.before), afterSha256: digest(patch.after) },
    patternSha256: asset.patternSha256, protectedHashes,
    names: asset.labels.map(label => ({ source: label.source, target: label.target, frame: label.patternFrame,
      size: namePattern(rom, 31, label.patternFrame).size,
      sha256: digest(composeName(translatedAtlas, 256, namePattern(rom, 31, label.patternFrame))) })),
    sheets: ['comparison-31-sheet.png', 'comparison-29-sheet.png'],
  }, null, 2)}\n`);
  console.log(`Reconstructed ${asset.labels.length} match-order names and 19 shared full-name frames in ${output.pathname}; protected files unchanged.`);
}