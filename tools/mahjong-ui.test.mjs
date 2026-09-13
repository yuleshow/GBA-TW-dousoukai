import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { parseBdf } from './font.mjs';
import { ROM_SHA256 } from './inspect-rom.mjs';
import { decodeTiles4bpp, encodeTiles4bpp, renderUiLabel, uiResources } from './localize-ui.mjs';

const originalPath = new URL('../work/Super Real Mahjong Dousoukai (Japan).gba', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('../translations/mahjong-ui.json', import.meta.url), 'utf8'));
const sha256 = data => createHash('sha256').update(data).digest('hex');

test('Mahjong fragment covers all seven action frames without names or tile art', () => {
  assert.deepEqual(Object.keys(manifest), ['assets']);
  assert.deepEqual(manifest.assets.map(asset => [asset.packageId, asset.resourceId]), [[0, 91]]);
  const asset = manifest.assets[0];
  assert.deepEqual(asset.labels.map(label => [label.source, label.target]), [
    ['ロン', '榮和'], ['チー', '吃'], ['ポン', '碰'], ['カン', '槓'],
    ['やめる', '取消'], ['リーチ', '立直'], ['ツモ', '自摸'],
  ]);
  assert.deepEqual(asset.style, { fontSize: 8, fill: 15, outline: 0, background: 0 });
  assert.deepEqual(asset.labels.map(label => label.patternFrame), [0, 1, 2, 3, 4, 5, 6]);
});

test('Mahjong slices match original PAT and shared enabled/disabled palette preimages', { skip: !existsSync(originalPath) }, () => {
  const original = readFileSync(originalPath);
  assert.equal(sha256(original), ROM_SHA256);
  const resources = uiResources(original, 0);
  const expected = [
    [91, 0x27f314, '2cb15b63cc2669c6fecb926abffe272e2499d393bcfbf2a1485279e8da3a7788'],
    [92, 0x27f5a4, 'a7307437a052a7556e682fcd26573e8b121ec06a7b3c290d03958b1d9c291f9c'],
    [93, 0x27f604, '821f8450fcebba0ba6d1f60656766cf459e173911a80ef6e55a67e1a5fc91050'],
  ];
  for (const [resourceId, offset, digest] of expected) {
    assert.equal(resources[resourceId].offset, offset);
    assert.equal(sha256(original.subarray(offset, resources[resourceId + 1].offset)), digest);
  }
  const asset = manifest.assets[0];
  assert.equal(asset.patternResourceId, 93);
  assert.equal(asset.paletteResourceId, 92);
  const pattern = original.subarray(resources[93].offset);
  assert.equal(pattern.readUInt32LE(4), asset.labels.length);
  for (const label of asset.labels) {
    const start = pattern.readUInt32LE(8 + label.patternFrame * 4);
    assert.equal(pattern.readUInt16LE(start), 1);
    const flags = pattern.readUInt16LE(start + 2);
    assert.ok(flags === 0x41 || flags === 0x52);
    const tile = pattern.readUInt16LE(start + 4);
    const size = flags === 0x41 ? [16, 8] : [32, 8];
    assert.deepEqual(label.size, size);
    assert.deepEqual(label.slices, [{ rect: [tile % 32 * 8, Math.floor(tile / 32) * 8, ...size], at: [0, 0] }]);
    assert.ok([...label.target].length * asset.style.fontSize <= size[0]);
  }
  const palette = original.subarray(resources[92].offset);
  assert.equal(palette.subarray(16, 20).toString('ascii'), 'PLT\0');
  assert.equal(palette.readUInt32LE(20), 32);
  assert.equal(palette.readUInt16LE(24 + 15 * 2), 0x7fff);
  assert.equal(palette.readUInt16LE(24 + 31 * 2), 0x5ef7);
});

test('Mahjong rendering changes only label pixels and preserves all other ROM bytes', { skip: !existsSync(originalPath) }, () => {
  const original = readFileSync(originalPath);
  assert.equal(sha256(original), ROM_SHA256);
  const modified = Buffer.from(original);
  const glyphs = parseBdf(readFileSync(new URL('../assets/fonts/fusion-pixel-8px-monospaced-zh_hant.bdf', import.meta.url), 'utf8'), 8);
  const ranges = [];
  const proof = [];
  for (const asset of manifest.assets) {
    const resource = uiResources(original, asset.packageId)[asset.resourceId];
    assert.equal(resource.type, 'IMG');
    const image = original.subarray(resource.offset);
    assert.equal(image[4], 0);
    const width = image[5] * 8;
    const height = image[6] * 8;
    const before = decodeTiles4bpp(image.subarray(8), width, height);
    const pixels = Buffer.from(before);
    const coverage = Buffer.alloc(pixels.length);
    for (const label of asset.labels) {
      renderUiLabel(pixels, width, height, label, glyphs, asset.style);
      const expected = Buffer.alloc(label.size[0] * label.size[1]);
      renderUiLabel(expected, ...label.size, { target: label.target, rect: [0, 0, ...label.size] }, glyphs, asset.style);
      assert.ok(expected.includes(asset.style.fill));
      assert.ok(expected.every(value => value === 0 || value === 15));
      const actual = Buffer.alloc(expected.length);
      for (const { rect: [left, top, across, down], at: [sourceX, sourceY] } of label.slices) {
        for (let row = 0; row < down; row++) for (let column = 0; column < across; column++) {
          const index = (top + row) * width + left + column;
          assert.equal(coverage[index], 0, 'Labels must not overlap');
          coverage[index] = 1;
          actual[(sourceY + row) * label.size[0] + sourceX + column] = pixels[index];
        }
      }
      assert.deepEqual(actual, expected, `${label.target}: PAT must reassemble the entire label`);
    }
    for (let index = 0; index < pixels.length; index++) {
      if (!coverage[index]) assert.equal(pixels[index], before[index], 'Adjacent atlas pixels must remain unchanged');
    }
    const tiles = encodeTiles4bpp(pixels, width, height);
    assert.deepEqual(decodeTiles4bpp(tiles, width, height), pixels);
    const offset = resource.offset + 8;
    tiles.copy(modified, offset);
    ranges.push([offset, offset + tiles.length]);
    proof.push({ packageId: asset.packageId, resourceId: asset.resourceId,
      patternResourceId: asset.patternResourceId, offset: `0x${offset.toString(16)}`,
      width, height, labels: asset.labels.length, before: sha256(image.subarray(8, 8 + tiles.length)), after: sha256(tiles),
      changedPixels: pixels.reduce((count, value, index) => count + Number(value !== before[index]), 0),
      preservedPixels: coverage.filter(value => value === 0).length });
  }
  const restored = Buffer.from(modified);
  for (const [start, end] of ranges) original.copy(restored, start, start, end);
  assert.deepEqual(restored, original, 'Names, tile art, HUD, palettes, PAT, resource tables and code must be byte-identical');
  if (process.env.MAHJONG_UI_WRITE === '1') {
    const directory = new URL('../work/mahjong-ui/', import.meta.url);
    mkdirSync(directory, { recursive: true });
    writeFileSync(new URL('verified.gba', directory), modified);
    writeFileSync(new URL('proof.json', directory), `${JSON.stringify(proof, null, 2)}\n`);
  }
});