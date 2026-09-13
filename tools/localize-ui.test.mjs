import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { parseBdf, rasterizeGlyph } from './font.mjs';
import { applyUi, buildUi, decodeEcd, decodeTiles4bpp, encodeEcd, encodeTiles4bpp, loadUiManifest, renderUiLabel, uiResources, UI_MANIFEST_FILES } from './localize-ui.mjs';

test('8px BDF uses its native baseline and retains strict 12px defaults', () => {
  const bdf = ['STARTFONT 2.1', 'FONTBOUNDINGBOX 8 8 0 -1', 'FONT_ASCENT 7', 'FONT_DESCENT 1',
    'CHARS 1', 'STARTCHAR test', 'ENCODING 20013', 'SWIDTH 1000 0', 'DWIDTH 8 0',
    'BBX 3 2 1 -1', 'BITMAP', 'A0', 'E0', 'ENDCHAR', 'ENDFONT'].join('\n');
  const glyph = parseBdf(bdf, 8).get(20013);
  const bitmap = rasterizeGlyph(glyph, 8);
  assert.equal(bitmap.length, 16);
  assert.deepEqual(bitmap.subarray(0, 12), Buffer.alloc(12));
  assert.equal(bitmap.readUInt16BE(12), 0x5000);
  assert.equal(bitmap.readUInt16BE(14), 0x7000);
  assert.throws(() => parseBdf(bdf), /12px/);
  assert.throws(() => parseBdf(bdf.replace('FONT_ASCENT 7', 'FONT_ASCENT 8'), 8), /ascent 7/);
  assert.throws(() => parseBdf(bdf, 9), /Expected/);
  assert.throws(() => rasterizeGlyph(glyph), /12x12/);
  assert.throws(() => rasterizeGlyph({ ...glyph, yOffset: -2 }, 8), /fit/);
  assert.throws(() => rasterizeGlyph({ ...glyph, xOffset: 6 }, 8), /fit/);
  assert.throws(() => rasterizeGlyph({ ...glyph, rows: [0, 0] }, 8), /Blank/);
});

test('composite labels scatter complete glyphs across atlas rows without touching neighboring pixels', () => {
  const glyphs = new Map([[65, { width: 12, height: 12, xOffset: 0, yOffset: -2,
    advance: 12, rowBits: 16, rows: Array(12).fill(0xaaa0) }]]);
  const bitmap = Buffer.alloc(32 * 16);
  renderUiLabel(bitmap, 32, 16, { target: 'AA', rect: [0, 0, 32, 16] }, glyphs);
  const pixels = Buffer.alloc(64 * 32, 7);
  const label = { target: 'AA', size: [32, 16], slices: [
    { rect: [48, 0, 16, 16], at: [0, 0] }, { rect: [0, 16, 16, 16], at: [16, 0] },
  ] };
  renderUiLabel(pixels, 64, 32, label, glyphs);
  for (let row = 0; row < 32; row++) {
    for (let column = 0; column < 64; column++) {
      const expected = row < 16 && column >= 48 ? bitmap[row * 32 + column - 48]
        : row >= 16 && column < 16 ? bitmap[(row - 16) * 32 + column + 16] : 7;
      assert.equal(pixels[row * 64 + column], expected);
    }
  }
  const snapshot = Buffer.from(pixels);
  assert.throws(() => renderUiLabel(pixels, 64, 32, { ...label, slices: label.slices.slice(0, 1) }, glyphs), /Incomplete/);
  assert.throws(() => renderUiLabel(pixels, 64, 32, { ...label, slices: [...label.slices, label.slices[0]] }, glyphs), /Overlapping/);
  assert.throws(() => renderUiLabel(pixels, 64, 32, { ...label, size: [16, 16] }, glyphs), /Invalid UI label slice/);
  assert.throws(() => renderUiLabel(pixels, 64, 32, label, new Map()), /Missing BDF glyph/);
  assert.deepEqual(pixels, snapshot);
});

test('native 8px labels fit borderless direct and sliced sprites without downscaling', () => {
  const glyphs = parseBdf(readFileSync(new URL('../assets/fonts/fusion-pixel-8px-monospaced-zh_hant.bdf', import.meta.url), 'utf8'), 8);
  const style = { fontSize: 8, fill: 15, outline: 0, background: 0 };
  const bitmap = Buffer.alloc(64);
  const label = { target: '晶', rect: [0, 0, 8, 8] };
  renderUiLabel(bitmap, 8, 8, label, glyphs, style);
  const glyph = rasterizeGlyph(glyphs.get('晶'.codePointAt(0)), 8);
  assert.ok(bitmap.includes(15));
  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 8; column++) {
      assert.equal(bitmap[row * 8 + column], glyph.readUInt16BE(row * 2) & 0x8000 >>> column ? 15 : 0);
    }
  }
  const atlas = Buffer.alloc(16 * 8, 7);
  renderUiLabel(atlas, 16, 8, { target: '晶', size: [8, 8], slices: [
    { rect: [8, 0, 8, 8], at: [0, 0] },
  ] }, glyphs, style);
  for (let row = 0; row < 8; row++) {
    assert.deepEqual(atlas.subarray(row * 16, row * 16 + 8), Buffer.alloc(8, 7));
    assert.deepEqual(atlas.subarray(row * 16 + 8, row * 16 + 16), bitmap.subarray(row * 8, row * 8 + 8));
  }
  assert.throws(() => renderUiLabel(bitmap, 8, 8, label, glyphs, { ...style, outline: 1 }), /does not fit/);
  assert.throws(() => renderUiLabel(bitmap, 8, 8, label, glyphs, { ...style, fontSize: 12 }), /does not fit/);
  assert.throws(() => renderUiLabel(bitmap, 8, 8, label, glyphs, { ...style, fontSize: 9 }), /does not fit/);
});

test('UI manifest loader merges required base, name and costume fragments', () => {
  for (const required of ['ui.json', 'names-ui.json', 'costume-ui.json']) assert.ok(UI_MANIFEST_FILES.includes(required));
  const fragments = UI_MANIFEST_FILES.map(file =>
    JSON.parse(readFileSync(new URL(`../translations/${file}`, import.meta.url), 'utf8')));
  const manifest = loadUiManifest();
  assert.deepEqual(manifest.assets, fragments.flatMap(fragment => fragment.assets));
  assert.deepEqual(manifest.patternEdits, fragments.flatMap(fragment => fragment.patternEdits ?? []));
  assert.deepEqual(manifest.untranslated, fragments.flatMap(fragment => fragment.untranslated ?? []));
  const owners = manifest.assets.map(asset => `${asset.packageId}:${asset.resourceId}`);
  assert.equal(new Set(owners).size, owners.length);
});

test('ECD encoder round-trips literals, zero runs, overlap and dictionary wrap', () => {
  const payloads = [Buffer.alloc(0), Buffer.alloc(4096), Buffer.from('ABC'.repeat(1500)),
    Buffer.from(Array.from({ length: 6000 }, (_, index) => (index * 71 + (index >>> 8)) & 255))];
  for (const payload of payloads) {
    for (const prefix of [0, Math.min(8, payload.length)]) {
      assert.deepEqual(decodeEcd(encodeEcd(payload, prefix)), payload);
    }
  }
});

test('SCR glyph tiles use a 32-tile stride and reconstruct without clipping', () => {
  const glyphs = new Map([[65, { width: 12, height: 12, xOffset: 0, yOffset: -2,
    advance: 12, rowBits: 16, rows: Array(12).fill(0xfff0) }]]);
  const expected = Buffer.alloc(32 * 16);
  renderUiLabel(expected, 32, 16, { target: 'AA', rect: [0, 0, 32, 16] }, glyphs);
  const pixels = Buffer.alloc(64 * 32, 7);
  const tiles = [0, 1, 6, 7, 96, 97, 98, 99];
  renderUiLabel(pixels, 64, 32, { target: 'AA', size: [32, 16], tiles }, glyphs);
  for (const [index, tile] of tiles.entries()) {
    for (let row = 0; row < 8; row++) {
      for (let column = 0; column < 8; column++) {
        assert.equal(pixels[(Math.floor(tile / 32) * 8 + row) * 64 + tile % 32 * 8 + column],
          expected[(Math.floor(index / 4) * 8 + row) * 32 + index % 4 * 8 + column]);
      }
    }
  }
  assert.throws(() => renderUiLabel(pixels, 64, 32, { target: 'AA', size: [32, 16], tiles: [0] }, glyphs), /Invalid UI label tiles/);
  assert.throws(() => renderUiLabel(pixels, 64, 32, { target: 'AA', size: [32, 16], tiles: Array(8).fill(0) }, glyphs), /Overlapping/);
});

test('large call labels use integer pixel scaling and reject undersized rectangles', () => {
  const glyphs = new Map([[65, { width: 1, height: 1, xOffset: 0, yOffset: 9,
    advance: 12, rowBits: 8, rows: [128] }]]);
  const pixels = Buffer.alloc(32 * 32);
  const label = { target: 'A', rect: [0, 0, 32, 32] };
  renderUiLabel(pixels, 32, 32, label, glyphs, { scale: 2, background: 8, fill: 15 });
  assert.equal(pixels[0], 8);
  for (const row of [4, 5]) for (const column of [4, 5]) assert.equal(pixels[row * 32 + column], 15);
  assert.equal(pixels[4 * 32 + 6], 1);
  assert.throws(() => renderUiLabel(pixels, 32, 32, label, glyphs, { scale: 3 }), /does not fit/);
  assert.throws(() => renderUiLabel(pixels, 32, 32, label, glyphs, { scale: 1.5 }), /does not fit/);
});

test('shared points label clears old pixels while retaining complete glyphs in the reused right-hand slice', () => {
  const glyphs = new Map([[65, { width: 12, height: 12, xOffset: 0, yOffset: -2,
    advance: 12, rowBits: 16, rows: Array(12).fill(0xfff0) }]]);
  const expected = Buffer.alloc(24 * 16);
  renderUiLabel(expected, 24, 16, { target: 'AA', rect: [0, 0, 24, 16] }, glyphs, { outline: 0 });
  const actual = Buffer.alloc(32 * 16, 7);
  renderUiLabel(actual, 32, 16, { target: 'AA', rect: [0, 0, 32, 16], align: 'right' }, glyphs, { outline: 0 });
  for (let row = 0; row < 16; row++) {
    assert.deepEqual(actual.subarray(row * 32, row * 32 + 8), Buffer.alloc(8));
    assert.deepEqual(actual.subarray(row * 32 + 8, row * 32 + 32), expected.subarray(row * 24, row * 24 + 24));
  }
});

const originalPath = new URL('../work/Super Real Mahjong Dousoukai (Japan).gba', import.meta.url);

test('continue heading fully reconstructs Chinese glyphs with no Japanese residue or changes to countdown geometry', { skip: !existsSync(originalPath) }, () => {
  const original = readFileSync(originalPath);
  const modified = Buffer.from(original);
  const { patches, report } = applyUi(original, modified);
  const heading = report.assets.find(asset => asset.packageId === 1 && asset.resourceId === 354);
  assert.deepEqual([heading.width, heading.height], [216, 32]);
  assert.deepEqual(heading.style, { fontSize: 8, scale: 2, outline: 0, background: 0 });
  assert.equal(heading.labels.length, 1);
  assert.equal(heading.labels[0].target, '要繼續嗎？');
  const coverage = Buffer.alloc(216 * 32);
  for (const { rect: [left, top, across, down] } of heading.labels[0].slices) {
    for (let row = top; row < top + down; row++) {
      for (let column = left; column < left + across; column++) coverage[row * 216 + column]++;
    }
  }
  assert.ok(coverage.every(count => count === 1), 'All 108 atlas tiles must be cleared exactly once');
  const patch = patches.find(entry => entry.packageId === 1 && entry.resourceId === 354);
  assert.equal(patch.after.length, patch.before.length);
  const resources = uiResources(original, 1);
  const expected = Buffer.alloc(256 * 32);
  const glyphs = parseBdf(readFileSync(new URL('../assets/fonts/fusion-pixel-8px-monospaced-zh_hant.bdf', import.meta.url), 'utf8'), 8);
  for (const [index, character] of [...'要繼續嗎？'].entries()) {
    const glyph = rasterizeGlyph(glyphs.get(character.codePointAt(0)), 8);
    for (let row = 0; row < 8; row++) {
      for (let column = 0; column < 8; column++) {
        if (!(glyph.readUInt16BE(row * 2) & 0x8000 >>> column)) continue;
        for (let offsetY = 0; offsetY < 2; offsetY++) {
          for (let offsetX = 0; offsetX < 2; offsetX++) {
            expected[(8 + row * 2 + offsetY) * 256 + 84 + index * 16 + column * 2 + offsetX] = 15 - Math.floor(row / 3);
          }
        }
      }
    }
  }
  assert.ok(expected.some(value => value !== 0));
  const candidates = [{ name: 'patched original', rom: modified }];
  if (process.env.CONTINUE_ROM) candidates.push({ name: 'final ROM', rom: readFileSync(process.env.CONTINUE_ROM) });
  for (const { name, rom } of candidates) {
    const actualResources = uiResources(rom, 1);
    const image = decodeEcd(rom.subarray(actualResources[354].offset));
    assert.deepEqual(image.subarray(0, 8), decodeEcd(original.subarray(resources[354].offset)).subarray(0, 8));
    const atlas = decodeTiles4bpp(image.subarray(8), 216, 32);
    const screen = rom.subarray(actualResources[356].offset, actualResources[357].offset);
    assert.deepEqual([screen[5] * 8, screen[6] * 8], [256, 32]);
    const actual = Buffer.alloc(expected.length);
    for (let row = 0; row < 32; row++) {
      for (let column = 0; column < 256; column++) {
        const entry = screen.readUInt16LE(8 + (Math.floor(row / 8) * 32 + Math.floor(column / 8)) * 2);
        const tile = entry & 1023;
        if (tile === 1023) continue;
        const sourceX = tile % 32 * 8 + (entry & 1024 ? 7 - column % 8 : column % 8);
        const sourceY = Math.floor(tile / 32) * 8 + (entry & 2048 ? 7 - row % 8 : row % 8);
        assert.ok(sourceX < 216 && sourceY < 32);
        actual[row * 256 + column] = atlas[sourceY * 216 + sourceX];
      }
    }
    assert.deepEqual(actual, expected, `${name}: every SCR pixel must match, including transparent margins and shared/flipped tiles`);
    for (const resourceId of [355, 356, 365, 366, 367, 368, 369, 370, 371, 372, 373, 374, 375, 377, 378, 379]) {
      const before = original.subarray(resources[resourceId].offset, resources[resourceId + 1].offset);
      assert.deepEqual(rom.subarray(actualResources[resourceId].offset, actualResources[resourceId].offset + before.length), before,
        `${name}: protected palette, SCR, PAT, TIM, border or countdown art ${resourceId}`);
    }
    for (const [resourceId, target, width] of [[364, '按開始鍵續關', 160], [376, '剩餘', 32]]) {
      const asset = report.assets.find(entry => entry.packageId === 1 && entry.resourceId === resourceId);
      assert.deepEqual(asset.labels, [{ source: resourceId === 364 ? 'スタートボタンでコンティニュー' : 'のこり', target, rect: [0, 0, width, 16] }]);
      const expectedCaption = decodeEcd(modified.subarray(resources[resourceId].offset));
      assert.deepEqual(decodeEcd(rom.subarray(actualResources[resourceId].offset)), expectedCaption, `${name}: existing caption ${resourceId}`);
    }
  }
});

test('UI patches are in place, bounded, non-overlapping, and preserve other bytes and atlas pixels', { skip: !existsSync(originalPath) }, () => {
  const original = readFileSync(originalPath);
  const snapshot = Buffer.from(original);
  const modified = Buffer.from(original);
  const { patches, report } = applyUi(original, modified);
  const manifest = loadUiManifest();
  assert.equal(report.labels, manifest.assets.reduce((count, asset) => count + asset.labels.length, 0));
  assert.equal(report.assets[0].labels.find(label => label.source === 'アルバム').target, '相簿');
  assert.equal(report.complete, false);
  assert.equal(modified.length, original.length);
  assert.deepEqual(original, snapshot);
  assert.equal(patches[0].offset, 0x408004);
  const patterns = uiResources(original, 1)[446].offset;
  const patchedPatterns = modified.subarray(patterns);
  assert.deepEqual(modified.subarray(patterns + 52, patterns + 70), original.subarray(patterns + 52, patterns + 70));
  assert.equal(patchedPatterns.readUInt16LE(106), 1);
  assert.equal(patchedPatterns.readUInt16LE(114), 0x55);
  assert.equal(patchedPatterns.readUInt16LE(248), 1);
  assert.equal(patchedPatterns.readUInt16LE(256), 0x59);
  const options = report.assets.find(asset => asset.packageId === 1 && asset.resourceId === 445);
  assert.deepEqual(options.labels.find(label => label.target === '困難').rect, [168, 16, 32, 16]);
  assert.deepEqual(options.labels.find(label => label.target === '瞬間').rect, [200, 16, 32, 16]);
  const patchedRanges = patches.map(patch => [patch.offset, patch.offset + patch.after.length]).sort((first, second) => first[0] - second[0]);
  for (let index = 1; index < patchedRanges.length; index++) assert.ok(patchedRanges[index][0] >= patchedRanges[index - 1][1]);
  const fonts = new Map([8, 12].map(size => [size, parseBdf(readFileSync(
    new URL(`../assets/fonts/fusion-pixel-${size}px-monospaced-zh_hant.bdf`, import.meta.url), 'utf8'), size)]));
  for (const asset of report.assets) {
    const resource = uiResources(original, asset.packageId)[asset.resourceId];
    const before = resource.type === 'ECD' ? decodeEcd(original.subarray(resource.offset)) : original.subarray(resource.offset);
    const after = resource.type === 'ECD' ? decodeEcd(modified.subarray(resource.offset)) : modified.subarray(resource.offset);
    const beforePixels = decodeTiles4bpp(before.subarray(8), asset.width, asset.height);
    const afterPixels = decodeTiles4bpp(after.subarray(8), asset.width, asset.height);
    const coverage = Buffer.alloc(beforePixels.length);
    for (const label of asset.labels) {
      const expected = Buffer.from(beforePixels);
      renderUiLabel(expected, asset.width, asset.height, label, fonts.get(asset.style?.fontSize ?? 12), asset.style);
      const rectangles = label.tiles ? label.tiles.map(tile => [tile % 32 * 8, Math.floor(tile / 32) * 8, 8, 8])
        : label.slices ? label.slices.map(slice => slice.rect) : [label.rect];
      for (const [left, top, across, down] of rectangles) {
        for (let row = top; row < top + down; row++) {
          for (let column = left; column < left + across; column++) {
            const index = row * asset.width + column;
            assert.equal(afterPixels[index], expected[index], `Conflicting label pixels in ${asset.packageId}:${asset.resourceId}`);
            coverage[index] = 1;
          }
        }
      }
    }
    for (let index = 0; index < coverage.length; index++) {
      if (!coverage[index]) assert.equal(afterPixels[index], beforePixels[index], `Unlabeled pixel changed in ${asset.packageId}:${asset.resourceId}`);
    }
  }
  for (const patch of patches) {
    assert.equal(patch.before.length, patch.after.length);
    assert.notDeepEqual(patch.before, patch.after);
    assert.deepEqual(modified.subarray(patch.offset, patch.offset + patch.after.length), patch.after);
    patch.before.copy(modified, patch.offset);
  }
  assert.deepEqual(modified, original);
  modified[patches[0].offset] ^= 1;
  const conflicting = Buffer.from(modified);
  assert.throws(() => applyUi(original, modified), /conflicts/);
  assert.deepEqual(modified, conflicting);
  assert.throws(() => buildUi(Buffer.alloc(original.length)), /verified original/);
});

test('ECD literals and overlapping dictionary references', () => {
  const data = Buffer.from('4543440100000000000000060000000907414243bec3', 'hex');
  assert.equal(decodeEcd(data).toString(), 'ABCABCABC');
  assert.throws(() => decodeEcd(data.subarray(0, -1)));
});

test('4bpp tile ordering and low-nibble-first pixels', () => {
  const data = Buffer.alloc(128);
  data[0] = 0x21;
  data[32] = 0x43;
  data[64] = 0x65;
  const pixels = decodeTiles4bpp(data, 16, 16);
  assert.deepEqual([...pixels.subarray(0, 2)], [1, 2]);
  assert.deepEqual([...pixels.subarray(8, 10)], [3, 4]);
  assert.deepEqual([...pixels.subarray(128, 130)], [5, 6]);
  assert.deepEqual(encodeTiles4bpp(pixels, 16, 16), data);
  assert.throws(() => decodeTiles4bpp(data, 7, 8));
  assert.throws(() => encodeTiles4bpp(Buffer.alloc(64, 16), 8, 8));
});