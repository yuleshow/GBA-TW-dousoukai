import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { parseBdf } from './font.mjs';
import { ROM_SHA256 } from './inspect-rom.mjs';
import { decodeEcd, decodeTiles4bpp, encodeEcd, encodeTiles4bpp, renderUiLabel, uiResources } from './localize-ui.mjs';

const originalPath = new URL('../work/Super Real Mahjong Dousoukai (Japan).gba', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('../translations/costume-ui.json', import.meta.url), 'utf8'));

test('costume fragment is additive to the shared manifest and covers the requested labels', () => {
  const shared = JSON.parse(readFileSync(new URL('../translations/ui.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(manifest), ['assets']);
  assert.deepEqual(manifest.assets.map(asset => [asset.packageId, asset.resourceId]), [[1, 36], [1, 419], [1, 437], [1, 439]]);
  for (const asset of manifest.assets) {
    assert.ok(!shared.assets.some(other => other.packageId === asset.packageId && other.resourceId === asset.resourceId), 'Do not overwrite a shared manifest asset');
  }
  const targets = new Map(manifest.assets.flatMap(asset => asset.labels).map(label => [label.source, label.target]));
  assert.equal(targets.size, 54);
  for (const [source, target] of [['コスプレ連打', '換裝連打'], ['コスプレルーレット', '換裝輪盤'],
    ['ウェディング', '婚紗'], ['ウェイトレス', '女服務生'], ['キュロット', '裙褲'], ['Yシャツ', '襯衫'],
    ['茶屋娘', '茶屋娘'], ['星南女子制服', '星南女子制服'], ['月浪学園制服', '月浪學園制服'],
    ['SHOT', '發射'], ['STOP', '停止']]) assert.equal(targets.get(source), target);
  assert.equal(shared.assets.find(asset => asset.packageId === 1 && asset.resourceId === 376)
    ?.labels.find(label => label.source === 'のこり')?.target, '剩餘');
});

function patternPieces(rom, resource, frame) {
  const pattern = rom.subarray(resource.offset);
  assert.equal(resource.type, 'PAT');
  assert.ok(frame < pattern.readUInt32LE(4));
  let cursor = pattern.readUInt32LE(8 + frame * 4);
  const count = pattern.readUInt16LE(cursor);
  cursor += 2;
  const sizes = [[[8, 8], [16, 16], [32, 32], [64, 64]],
    [[16, 8], [32, 8], [32, 16], [64, 32]], [[8, 16], [8, 32], [16, 32], [32, 64]]];
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
    assert.equal(flags & 0x600, 0, 'Translated PAT pieces must not be flipped');
    const tile = pattern.readUInt16LE(cursor);
    cursor += 2;
    pieces.push({ rect: [tile % 32 * 8, Math.floor(tile / 32) * 8, ...sizes[flags >> 6 & 3][flags >> 4 & 3]], at: [left, top] });
  }
  return pieces;
}

function screenPixels(rom, resource, atlas, atlasWidth) {
  assert.equal(resource.type, 'SCR');
  const data = rom.subarray(resource.offset);
  const width = data[5] * 8;
  const height = data[6] * 8;
  const pixels = Buffer.alloc(width * height);
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const entry = data.readUInt16LE(8 + (Math.floor(row / 8) * width / 8 + Math.floor(column / 8)) * 2);
    const tile = entry & 1023;
    const sourceX = tile % 32 * 8 + (entry & 1024 ? 7 - column % 8 : column % 8);
    const sourceY = Math.floor(tile / 32) * 8 + (entry & 2048 ? 7 - row % 8 : row % 8);
    pixels[row * width + column] = atlas[sourceY * atlasWidth + sourceX];
  }
  return { pixels, width, height };
}

test('costume fragment renders every visible PAT label, preserves hidden tiles, and fits original allocations', { skip: !existsSync(originalPath) }, () => {
  const original = readFileSync(originalPath);
  assert.equal(createHash('sha256').update(original).digest('hex'), ROM_SHA256);
  const modified = Buffer.from(original);
  const glyphs = parseBdf(readFileSync(new URL('../assets/fonts/fusion-pixel-12px-monospaced-zh_hant.bdf', import.meta.url), 'utf8'));
  const costume = manifest.assets.find(asset => asset.packageId === 1 && asset.resourceId === 36);
  assert.deepEqual(costume.labels.map(label => label.patternFrame), Array.from({ length: 51 }, (_, index) => index).filter(index => index !== 45));
  const proof = [];
  const ranges = [];
  for (const asset of manifest.assets) {
    const resources = uiResources(original, asset.packageId);
    const resource = resources[asset.resourceId];
    const data = resource.type === 'ECD' ? decodeEcd(original.subarray(resource.offset)) : original.subarray(resource.offset);
    assert.equal(data.toString('ascii', 0, 3), 'IMG');
    assert.equal(data[4], 0);
    const width = data[5] * 8;
    const height = data[6] * 8;
    const before = decodeTiles4bpp(data.subarray(8), width, height);
    const pixels = Buffer.from(before);
    const coverage = Buffer.alloc(before.length);
    const expectedLabels = [];
    for (const label of asset.labels) {
      if (label.patternFrame !== undefined) {
        const pieces = patternPieces(original, resources[asset.patternResourceId], label.patternFrame);
        if (label.patternOrigin) for (const piece of pieces) {
          piece.at[0] -= label.patternOrigin[0];
          piece.at[1] -= label.patternOrigin[1];
        }
        assert.deepEqual(label.slices, pieces, `${label.source}: slices must match PAT exactly`);
      }
      const previous = Buffer.from(pixels);
      renderUiLabel(pixels, width, height, label, glyphs, asset.style);
      const slices = label.tiles ? label.tiles.map((tile, index) => ({
        rect: [tile % 32 * 8, Math.floor(tile / 32) * 8, 8, 8],
        at: [index % (label.size[0] / 8) * 8, Math.floor(index / (label.size[0] / 8)) * 8],
      })) : label.slices ?? [{ rect: label.rect, at: [0, 0] }];
      const size = label.size ?? label.rect.slice(2);
      const expected = Buffer.alloc(size[0] * size[1]);
      renderUiLabel(expected, ...size, { target: label.target, rect: [0, 0, ...size] }, glyphs, asset.style);
      expectedLabels.push({ label, slices, size, expected });
      for (const { rect: [left, top, across, down] } of slices) {
        for (let row = top; row < top + down; row++) for (let column = left; column < left + across; column++) {
          const index = row * width + column;
          if (coverage[index]) assert.equal(pixels[index], previous[index], 'Shared suffix writes must be identical');
          coverage[index] = 1;
        }
      }
    }
    for (const { label, slices, size, expected } of expectedLabels) {
      const reconstructed = Buffer.alloc(expected.length);
      for (const { rect: [left, top, across, down], at: [sourceX, sourceY] } of slices) {
        for (let row = 0; row < down; row++) pixels.copy(reconstructed, (sourceY + row) * size[0] + sourceX,
          (top + row) * width + left, (top + row) * width + left + across);
      }
      assert.deepEqual(reconstructed, expected, `${label.target}: reassembled glyphs must be complete`);
    }
    for (let index = 0; index < pixels.length; index++) {
      if (!coverage[index]) assert.equal(pixels[index], before[index], 'Unlabeled pixels must be unchanged');
    }
    if (asset.resourceId === 36) {
      for (let row = 112; row < 128; row++) assert.deepEqual(pixels.subarray(row * width + 128, row * width + 144), before.subarray(row * width + 128, row * width + 144));
    }
    if (asset.screenResourceId !== undefined) {
      const screen = resources[asset.screenResourceId];
      const expected = screenPixels(original, screen, before, width);
      const actual = screenPixels(original, screen, pixels, width);
      const [left, top, across, down] = asset.screenClearRect;
      for (let row = top; row < top + down; row++) expected.pixels.fill(asset.style.background,
        row * expected.width + left, row * expected.width + left + across);
      renderUiLabel(expected.pixels, expected.width, expected.height,
        { target: asset.labels[0].target, rect: asset.screenTextRect }, glyphs, asset.style);
      assert.deepEqual(actual.pixels, expected.pixels, 'SCR must preserve the full border and contain no original text overhang');
    }
    const tiles = encodeTiles4bpp(pixels, width, height);
    assert.deepEqual(decodeTiles4bpp(tiles, width, height), pixels);
    const payload = Buffer.concat([data.subarray(0, 8), tiles]);
    const encoded = resource.type === 'ECD' ? encodeEcd(payload) : tiles;
    if (resource.type === 'ECD') assert.deepEqual(decodeEcd(encoded), payload);
    const offset = resource.offset + (resource.type === 'ECD' ? 0 : 8);
    const allocation = resource.type === 'ECD' ? resources[asset.resourceId + 1].offset - offset : tiles.length;
    assert.ok(encoded.length <= allocation, `${asset.resourceId}: ${encoded.length} > ${allocation}`);
    modified.fill(0, offset, offset + allocation);
    encoded.copy(modified, offset);
    ranges.push([offset, offset + allocation]);
    proof.push({ packageId: asset.packageId, resourceId: asset.resourceId, offset: `0x${offset.toString(16)}`,
      width, height, labels: asset.labels.length, encoded: encoded.length, allocation });
  }
  const restored = Buffer.from(modified);
  for (const [start, end] of ranges) original.copy(restored, start, start, end);
  assert.deepEqual(restored, original, 'All other ROM bytes, including PAT, SCR and character images, must remain unchanged');
  if (process.env.COSTUME_UI_WRITE === '1') {
    mkdirSync(new URL('../work/costume-ui/', import.meta.url), { recursive: true });
    writeFileSync(new URL('../work/costume-ui/verified.gba', import.meta.url), modified);
    writeFileSync(new URL('../work/costume-ui/proof.json', import.meta.url), `${JSON.stringify(proof, null, 2)}\n`);
  }
});