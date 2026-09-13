import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseBdf } from './font.mjs';
import { ROM_SHA256 } from './inspect-rom.mjs';
import { decodeTiles4bpp, encodeTiles4bpp, renderUiLabel, uiResources } from './localize-ui.mjs';

const root = new URL('../', import.meta.url);
export const scoringAssets = [
  ...JSON.parse(readFileSync(new URL('translations/ui.json', root), 'utf8')).assets
    .filter(asset => asset.packageId === 0 && asset.resourceId >= 119 && asset.resourceId <= 161),
  ...JSON.parse(readFileSync(new URL('translations/scoring-ui.json', root), 'utf8')).assets,
];
export const sha256 = data => createHash('sha256').update(data).digest('hex');

export function scoringImage(rom, resourceId) {
  const resource = uiResources(rom)[resourceId];
  assert.equal(resource.type, 'IMG');
  const data = rom.subarray(resource.offset);
  const width = data[5] * 8;
  const height = data[6] * 8;
  return { width, height, pixels: decodeTiles4bpp(data.subarray(8), width, height) };
}

export function scoringScreen(rom, imageId, screenId) {
  const image = scoringImage(rom, imageId);
  const resources = uiResources(rom);
  assert.equal(resources[screenId].type, 'SCR');
  const screen = rom.subarray(resources[screenId].offset);
  const width = screen[5] * 8;
  const height = screen[6] * 8;
  const pixels = Buffer.alloc(width * height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const entry = screen.readUInt16LE(8 + (Math.floor(row / 8) * width / 8 + Math.floor(column / 8)) * 2);
      const tile = entry & 1023;
      const sourceX = tile % 32 * 8 + (entry & 1024 ? 7 - column % 8 : column % 8);
      const sourceY = Math.floor(tile / 32) * 8 + (entry & 2048 ? 7 - row % 8 : row % 8);
      assert.ok(sourceX < image.width && sourceY < image.height, 'SCR tile outside image');
      pixels[row * width + column] = image.pixels[sourceY * image.width + sourceX];
    }
  }
  return { width, height, pixels };
}

export function patchScoring(original) {
  assert.equal(sha256(original), ROM_SHA256);
  const modified = Buffer.from(original);
  const resources = uiResources(original);
  const glyphs = parseBdf(readFileSync(new URL('assets/fonts/fusion-pixel-12px-monospaced-zh_hant.bdf', root), 'utf8'));
  const ranges = [];
  for (const asset of scoringAssets) {
    const image = scoringImage(original, asset.resourceId);
    for (const label of asset.labels) renderUiLabel(image.pixels, image.width, image.height, label, glyphs, asset.style);
    const tiles = encodeTiles4bpp(image.pixels, image.width, image.height);
    const start = resources[asset.resourceId].offset + 8;
    const end = start + tiles.length;
    assert.ok(end <= resources[asset.resourceId + 1].offset);
    tiles.copy(modified, start);
    ranges.push({ resourceId: asset.resourceId, start, end, before: sha256(original.subarray(start, end)), after: sha256(tiles) });
  }
  const restored = Buffer.from(modified);
  for (const { start, end } of ranges) original.copy(restored, start, start, end);
  assert.deepEqual(restored, original, 'Scoring code, values, palettes, headers, SCR/PAT and non-scoring art must remain identical');
  return { modified, ranges };
}

function blit(destination, source, left, top, transparent = false) {
  assert.ok(left >= 0 && top >= 0 && left + source.width <= destination.width && top + source.height <= destination.height);
  for (let row = 0; row < source.height; row++) {
    for (let column = 0; column < source.width; column++) {
      const value = source.pixels[row * source.width + column];
      if (value || !transparent) destination.pixels[(top + row) * destination.width + left + column] = value;
    }
  }
}

function writePreview(path, image, rom, bank = 0) {
  const palette = uiResources(rom)[118];
  assert.equal(palette.type, 'PLT');
  const rgb = Buffer.alloc(image.pixels.length * 3);
  for (const [index, value] of image.pixels.entries()) {
    const color = rom.readUInt16LE(palette.offset + 8 + (bank * 16 + value) * 2);
    for (let channel = 0; channel < 3; channel++) {
      const component = color >> (channel * 5) & 31;
      rgb[index * 3 + channel] = component << 3 | component >> 2;
    }
  }
  const result = spawnSync('magick', ['ppm:-', '-filter', 'point', '-resize', '400%', path.pathname], {
    input: Buffer.concat([Buffer.from(`P6\n${image.width} ${image.height}\n255\n`), rgb]),
  });
  assert.equal(result.status, 0, result.stderr?.toString());
}

function resultPanel(rom, rows) {
  const panel = scoringScreen(rom, 197, 198);
  for (const [index, [resourceId, numberScreen]] of rows.entries()) {
    const top = 8 + index * 16;
    blit(panel, scoringImage(rom, resourceId), 8, top, true);
    blit(panel, scoringScreen(rom, 182, numberScreen), 112, top, true);
    blit(panel, scoringScreen(rom, 162, 163), 128, top, true);
  }
  return panel;
}

export function writeScoringProof() {
  const original = readFileSync(new URL('work/Super Real Mahjong Dousoukai (Japan).gba', root));
  const buildPath = new URL('build/dousoukai-zh-Hant.gba', root);
  const current = readFileSync(buildPath);
  const { modified, ranges } = patchScoring(original);
  const directory = new URL('work/scoring-ui/', root);
  mkdirSync(directory, { recursive: true });
  const glyphs = parseBdf(readFileSync(new URL('assets/fonts/fusion-pixel-12px-monospaced-zh_hant.bdf', root), 'utf8'));
  const currentMatchesDefaultGradient = scoringAssets.filter(asset => asset.resourceId <= 161).filter(asset => {
    const image = scoringImage(original, asset.resourceId);
    renderUiLabel(image.pixels, image.width, image.height, asset.labels[0], glyphs);
    return image.pixels.equals(scoringImage(current, asset.resourceId).pixels);
  }).map(asset => asset.resourceId);
  const resources = uiResources(original);
  assert.deepEqual(current.subarray(resources[118].offset, resources[119].offset),
    original.subarray(resources[118].offset, resources[119].offset), 'Comparison requires the same result palette');
  const sheet = { width: 280, height: scoringAssets.length * 20, pixels: Buffer.alloc(280 * scoringAssets.length * 20, 1) };
  for (const [index, asset] of scoringAssets.entries()) {
    for (const [column, rom] of [original, current, modified].entries()) {
      blit(sheet, scoringImage(rom, asset.resourceId), column * 96, index * 20);
    }
  }
  writePreview(new URL('all-yaku-before-current-fixed.png', directory), sheet, original);
  writePreview(new URL('all-yaku-alternate-palette.png', directory), sheet, original, 1);
  for (const [name, rom] of [['original', original], ['current', current], ['fixed', modified]]) {
    writePreview(new URL(`result-${name}.png`, directory), resultPanel(rom, [[119, 184], [120, 184], [158, 184], [149, 186]]), original);
  }
  writeFileSync(new URL('verified.gba', directory), modified);
  const proof = {
    boundary: 'Offline IMG/SCR/PLT reconstruction, not an emulator screenshot. Panel row placement is illustrative, not a runtime trace. No VRAM patching.',
    originalSha256: sha256(original), currentBuildSha256: sha256(current), isolatedFixedSha256: sha256(modified),
    yakuFrames: 43, unitFrames: 1, columns: ['original', 'current build', 'isolated fix'],
    currentMatchesDefaultGradient,
    background: 'Fixed rows use opaque palette index 1. The original 1-3 checker pattern is intentionally replaced by a solid result-blue row.',
    rows: scoringAssets.map(asset => ({ resourceId: asset.resourceId, target: asset.labels[0].target })),
    paletteResourceId: 118, resultPanel: { image: 197, screen: 198 },
    unit: { image: 162, screen: 163, integration: 'Add scoring-ui.json to UI_MANIFEST_FILES in tools/localize-ui.mjs; shared loader deliberately not edited.' },
    unchangedOutsideRanges: true, ranges,
  };
  assert.equal(sha256(readFileSync(buildPath)), proof.currentBuildSha256, 'Final build must not change');
  writeFileSync(new URL('proof.json', directory), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify({ directory: directory.pathname, yakuFrames: 43, unitFrames: 1, buildUnchanged: true }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) writeScoringProof();