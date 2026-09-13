import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { parseBdf, rasterizeGlyph } from './font.mjs';
import { buildUi, decodeTiles4bpp, renderUiLabel, uiResources } from './localize-ui.mjs';
import { patchScoring, scoringAssets, scoringImage, scoringScreen } from './scoring-ui-preview.mjs';

const originalPath = new URL('../work/Super Real Mahjong Dousoukai (Japan).gba', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('../translations/ui.json', import.meta.url), 'utf8'));
const yaku = manifest.assets.filter(asset => asset.packageId === 0 && asset.resourceId >= 119 && asset.resourceId <= 161);

test('all 43 yaku retain the original opaque background and white foreground palette',
  { skip: !existsSync(originalPath) }, () => {
    const original = readFileSync(originalPath);
    const resources = uiResources(original);
    const glyphs = parseBdf(readFileSync(new URL('../assets/fonts/fusion-pixel-12px-monospaced-zh_hant.bdf', import.meta.url), 'utf8'));
    assert.equal(yaku.length, 43);
    for (const asset of yaku) {
      const image = original.subarray(resources[asset.resourceId].offset);
      assert.deepEqual([image[5] * 8, image[6] * 8], [88, 16]);
      const pixels = decodeTiles4bpp(image.subarray(8), 88, 16);
      assert.ok(!pixels.includes(0), 'Original result rows are opaque');
      renderUiLabel(pixels, 88, 16, asset.labels[0], glyphs, asset.style);
      assert.ok(!pixels.includes(0), `${asset.resourceId}: transparent pixels expose the result background`);
      assert.ok(!pixels.includes(14) && !pixels.includes(15), `${asset.resourceId}: gold is not yaku text ink`);
    }
  });

test('all yaku and the han unit reconstruct as complete glyphs with no Japanese residue or clipping',
  { skip: !existsSync(originalPath) }, () => {
    const original = readFileSync(originalPath);
    const { modified } = patchScoring(original);
    const glyphs = parseBdf(readFileSync(new URL('../assets/fonts/fusion-pixel-12px-monospaced-zh_hant.bdf', import.meta.url), 'utf8'));
    assert.deepEqual(scoringAssets.map(asset => asset.resourceId), Array.from({ length: 44 }, (_, index) => 119 + index));
    for (const asset of scoringAssets) {
      const image = scoringImage(modified, asset.resourceId);
      assert.equal(asset.labels.length, 1);
      const label = asset.labels[0];
      assert.deepEqual(label.rect, [0, 0, image.width, image.height]);
      assert.deepEqual(asset.style, { fill: 13, outline: 1, background: 1 });
      const characters = [...label.target];
      assert.ok(characters.length * 12 + 2 <= image.width, 'Leave room for the entire longest glyph row');
      const expected = Buffer.alloc(image.width * image.height, 1);
      const originX = Math.floor((image.width - characters.length * 12) / 2);
      for (const [index, character] of characters.entries()) {
        const glyph = rasterizeGlyph(glyphs.get(character.codePointAt(0)));
        assert.ok(glyph.some(Boolean), `Blank glyph: ${character}`);
        for (let row = 0; row < 12; row++) {
          for (let column = 0; column < 12; column++) {
            if (glyph.readUInt16BE(row * 2) & 0x8000 >>> column) {
              expected[(row + 2) * image.width + originX + index * 12 + column] = 13;
            }
          }
        }
      }
      assert.deepEqual(image.pixels, expected, `${asset.resourceId}: every foreground AND background pixel must match`);
    }
    assert.deepEqual(scoringScreen(modified, 162, 163), scoringImage(modified, 162));
    assert.equal(scoringAssets.at(-1).labels[0].target, '番');
  });

test('normal and alternate result palettes keep their intended white and yellow foregrounds',
  { skip: !existsSync(originalPath) }, () => {
    const original = readFileSync(originalPath);
    const offset = uiResources(original)[118].offset;
    assert.equal(original.readUInt16LE(offset + 8 + 13 * 2), 0x7bde);
    assert.equal(original.readUInt16LE(offset + 8 + 14 * 2), 0x09b6);
    assert.equal(original.readUInt16LE(offset + 8 + 15 * 2), 0x379b);
    assert.equal(original.readUInt16LE(offset + 8 + 29 * 2), 0x03ff);
    const { modified } = patchScoring(original);
    assert.deepEqual(modified.subarray(offset, uiResources(original)[119].offset),
      original.subarray(offset, uiResources(original)[119].offset));
  });

test('isolated scoring changes preserve all numbers, fu, layouts, resource headers and scoring code byte-for-byte',
  { skip: !existsSync(originalPath) }, () => {
    const original = readFileSync(originalPath);
    const { modified, ranges } = patchScoring(original);
    assert.equal(ranges.length, 44);
    const resources = uiResources(original);
    const restored = Buffer.from(modified);
    let previousEnd = 0;
    for (const { resourceId, start, end } of ranges) {
      assert.ok(start >= previousEnd);
      assert.equal(start, resources[resourceId].offset + 8);
      assert.equal(end - start, resourceId === 162 ? 128 : 704);
      original.copy(restored, start, start, end);
      previousEnd = end;
    }
    assert.deepEqual(restored, original);
    for (let screenId = 171; screenId <= 181; screenId++) {
      assert.deepEqual(scoringScreen(modified, 170, screenId), scoringScreen(original, 170, screenId));
    }
    for (let screenId = 183; screenId <= 192; screenId++) {
      assert.deepEqual(scoringScreen(modified, 182, screenId), scoringScreen(original, 182, screenId));
    }
  });

test('production UI builder includes the exact fixed bytes for every yaku asset and the han unit',
  { skip: !existsSync(originalPath) }, () => {
    const original = readFileSync(originalPath);
    const { modified } = patchScoring(original);
    const result = buildUi(original);
    for (const asset of scoringAssets) {
      const matches = result.patches.filter(patch => patch.packageId === 0 && patch.resourceId === asset.resourceId);
      assert.equal(matches.length, 1);
      const patch = matches[0];
      assert.deepEqual(patch.after, modified.subarray(patch.offset, patch.offset + patch.after.length));
    }
  });