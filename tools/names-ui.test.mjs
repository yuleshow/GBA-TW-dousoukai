import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { applyUi, buildUi, decodeTiles4bpp, encodeTiles4bpp, uiResources } from './localize-ui.mjs';
import { parseBdf, rasterizeGlyph } from './font.mjs';
import { ROM_SHA256 } from './inspect-rom.mjs';
import { namePattern, composeName } from './match-order-preview.mjs';

const manifest = JSON.parse(readFileSync(new URL('../translations/names-ui.json', import.meta.url), 'utf8'));
const originalPath = new URL('../work/Super Real Mahjong Dousoukai (Japan).gba', import.meta.url);
const fontBytes = readFileSync(new URL('../assets/fonts/fusion-pixel-8px-monospaced-zh_hant.bdf', import.meta.url));
const glyphs = parseBdf(fontBytes.toString('utf8'), 8);

function labelSlices(label) {
  return label.slices ?? [{ rect: label.rect, at: [0, 0] }];
}

function patternSlices(original, resources, label) {
  if (label.patternResourceId === 31) return namePattern(original, 31, label.patternFrame).slices;
  const resource = resources[label.patternResourceId];
  assert.equal(resource.type, 'PAT');
  const data = original.subarray(resource.offset, resources[label.patternResourceId + 1].offset);
  assert.ok(label.patternFrame < data.readUInt32LE(4));
  let cursor = data.readUInt32LE(8 + label.patternFrame * 4);
  const count = data.readUInt16LE(cursor);
  cursor += 2;
  const sprites = [];
  for (let index = 0; index < count; index++) {
    const attributes = data.readUInt16LE(cursor);
    cursor += 2;
    let left = 0;
    let top = 0;
    if (attributes & 0x2000) {
      left = data.readInt16LE(cursor);
      top = data.readInt16LE(cursor + 2);
      cursor += 4;
    }
    assert.ok([0, 0x52].includes(attributes & ~0x2000), 'Unexpected name sprite shape or flags');
    const width = (attributes & 0xff) === 0x52 ? 32 : 8;
    const tile = data.readUInt16LE(cursor);
    cursor += 2;
    sprites.push({ rect: [tile % 32 * 8, Math.floor(tile / 32) * 8, width, 8], at: [left, top] });
  }
  const originX = Math.min(...sprites.map(sprite => sprite.at[0]));
  const originY = Math.min(...sprites.map(sprite => sprite.at[1]));
  return sprites.map(sprite => ({ ...sprite, at: [sprite.at[0] - originX, sprite.at[1] - originY] }));
}

function sourceInkBounds(pixels, width, label) {
  const [left, top, across, down] = label.rect;
  let minimumX = across;
  let minimumY = down;
  let maximumX = -1;
  let maximumY = -1;
  for (let row = 0; row < down; row++) {
    for (let column = 0; column < across; column++) {
      if (pixels[(top + row) * width + left + column]) {
        minimumX = Math.min(minimumX, column);
        minimumY = Math.min(minimumY, row);
        maximumX = Math.max(maximumX, column);
        maximumY = Math.max(maximumY, row);
      }
    }
  }
  assert.ok(maximumX >= 0 && maximumY >= 0, `Blank source: ${label.source}`);
  return [minimumX, minimumY, maximumX - minimumX + 1, maximumY - minimumY + 1];
}

test('verified native 8px font rasterizes every translated name glyph without clipping or blank cells', () => {
  assert.equal(createHash('sha256').update(fontBytes).digest('hex'),
    'be85f01e270198b9e8d5863f1f552debd6689be82a3a3ca3620c16859ccd9ce4');
  const characters = new Set(manifest.assets.flatMap(asset => asset.labels.flatMap(label => [...label.target])));
  for (const character of characters) {
    const glyph = glyphs.get(character.codePointAt(0));
    assert.ok(glyph, `Missing native glyph: ${character}`);
    assert.equal(glyph.advance, 8);
    assert.equal(glyph.ascent, 7);
    const bitmap = rasterizeGlyph(glyph, 8);
    assert.equal(bitmap.length, 16);
    assert.ok(bitmap.some(Boolean), `Blank native glyph: ${character}`);
    for (let row = 0; row < 8; row++) assert.equal(bitmap.readUInt16BE(row * 2) & 0xff, 0);
  }
});

test('integrated name patches reconstruct 22 dialogue, 19 HUD and 18 match-order names as native 8px glyphs',
  { skip: !existsSync(originalPath) }, () => {
    const original = readFileSync(originalPath);
    const modified = Buffer.from(original);
    const { report } = applyUi(original, modified);
    let dialogueFrames = 0;
    let hudFrames = 0;
    let matchOrderFrames = 0;
    for (const asset of manifest.assets) {
      assert.ok(report.assets.some(entry => entry.packageId === asset.packageId && entry.resourceId === asset.resourceId));
      const resources = uiResources(modified, asset.packageId);
      const image = modified.subarray(resources[asset.resourceId].offset);
      const width = image[5] * 8;
      const atlas = decodeTiles4bpp(image.subarray(8), width, image[6] * 8);
      for (const label of asset.labels) {
        const [labelWidth, labelHeight] = label.size ?? label.rect.slice(2);
        assert.equal(labelHeight, label.patternResourceId === 31 ? 16 : 8);
        const actual = Buffer.alloc(labelWidth * labelHeight);
        for (const { rect: [left, top, across, down], at: [offsetX, offsetY] } of patternSlices(modified, resources, label)) {
          for (let row = 0; row < down; row++) {
            for (let column = 0; column < across; column++) {
              actual[(offsetY + row) * labelWidth + offsetX + column] = atlas[(top + row) * width + left + column];
            }
          }
        }
        const expected = Buffer.alloc(labelWidth * labelHeight);
        const characters = [...label.target];
        const originX = Math.floor((labelWidth - characters.length * 8) / 2);
        const originY = Math.floor((labelHeight - 8) / 2);
        for (const [index, character] of characters.entries()) {
          const glyph = rasterizeGlyph(glyphs.get(character.codePointAt(0)), 8);
          for (let row = 0; row < 8; row++) {
            for (let column = 0; column < 8; column++) {
              if (glyph.readUInt16BE(row * 2) & 0x8000 >>> column) expected[(originY + row) * labelWidth + originX + index * 8 + column] = 15;
            }
          }
        }
        assert.ok(actual.includes(15), `Blank reconstructed name: ${label.target}`);
        assert.ok(actual.every(value => value === 0 || value === 15));
        assert.deepEqual(actual, expected, `PAT reconstruction differs: ${label.target}`);
        const start = resources[label.patternResourceId].offset;
        const end = resources[label.patternResourceId + 1].offset;
        assert.deepEqual(modified.subarray(start, end), original.subarray(start, end));
        if (label.patternResourceId === 31) matchOrderFrames++;
        else if (asset.packageId === 1) dialogueFrames++;
        else hudFrames++;
      }
    }
    assert.equal(dialogueFrames, 22);
    assert.equal(hudFrames, 19);
    assert.equal(matchOrderFrames, 18);
  });

test('manifest covers every dialogue frame and matching HUD name using established translations', () => {
  const dialogue = manifest.assets.find(asset => asset.packageId === 1 && asset.resourceId === 22);
  const translations = Object.assign({}, ...[1, 2, 3, 4].map(part =>
    JSON.parse(readFileSync(new URL(`../translations/part-${part}.json`, import.meta.url), 'utf8'))));
  assert.equal(manifest.assets.length, 21);
  assert.equal(manifest.assets.reduce((count, asset) => count + asset.labels.length, 0), 59);
  const matchOrder = manifest.assets.find(asset => asset.packageId === 1 && asset.resourceId === 28);
  assert.deepEqual(matchOrder.labels.map(label => label.patternFrame), Array.from({ length: 18 }, (_, index) => index));
  assert.deepEqual(matchOrder.labels.map(label => label.target), dialogue.labels.slice(0, 18).map(label => label.target));
  assert.deepEqual(dialogue.labels.map(label => label.patternFrame), Array.from({ length: 22 }, (_, index) => index));
  for (const label of dialogue.labels) {
    if (label.patternFrame <= 18) assert.ok(translations[label.translationAddress]?.includes(label.target), label.target);
    if (label.patternFrame < 18) {
      const hud = manifest.assets.find(asset => asset.packageId === 0 && asset.resourceId === 70 + label.patternFrame);
      assert.equal(hud.labels[0].source, label.source);
      assert.equal(hud.labels[0].target, label.target);
    }
  }
  assert.equal(dialogue.labels[8].target, '晶');
  assert.equal(dialogue.labels[9].target, '珠美');
  assert.equal(dialogue.labels[11].target, '真理');
  assert.equal(manifest.assets.find(asset => asset.packageId === 0 && asset.resourceId === 68).labels[0].target, '玩家');
  const shared = JSON.parse(readFileSync(new URL('../translations/ui.json', import.meta.url), 'utf8'));
  const owned = new Set(manifest.assets.map(asset => `${asset.packageId}:${asset.resourceId}`));
  assert.equal(owned.size, manifest.assets.length);
  for (const asset of shared.assets) assert.ok(!owned.has(`${asset.packageId}:${asset.resourceId}`), 'Shared manifest already owns name image');
});

test('name labels fit native 8px sprites without enlarging the image allocation', { skip: !existsSync(originalPath) }, () => {
  const original = readFileSync(originalPath);
  assert.equal(createHash('sha256').update(original).digest('hex'), ROM_SHA256);
  for (const asset of manifest.assets) {
    const resources = uiResources(original, asset.packageId);
    const resource = resources[asset.resourceId];
    assert.equal(resource.type, 'IMG');
    const image = original.subarray(resource.offset);
    assert.equal(image[4], 0);
    const width = image[5] * 8;
    const height = image[6] * 8;
    const pixels = decodeTiles4bpp(image.subarray(8), width, height);
    const coverage = Buffer.alloc(pixels.length);
    assert.equal(asset.style.fontSize, 8);
    assert.equal(asset.style.fill, 15);
    assert.equal(asset.style.outline, 0);
    assert.equal(asset.style.background, 0);
    for (const label of asset.labels) {
      const [labelWidth, labelHeight] = label.size ?? label.rect.slice(2);
      assert.equal(labelHeight, label.patternResourceId === 31 ? 16 : 8);
      assert.ok([...label.target].length * asset.style.fontSize <= labelWidth);
      const slices = labelSlices(label);
      assert.deepEqual(slices, patternSlices(original, resources, label), `${asset.packageId}:${asset.resourceId} ${label.source}`);
      const labelCoverage = Buffer.alloc(labelWidth * labelHeight);
      for (const { rect: [left, top, across, down], at: [offsetX, offsetY] } of slices) {
        assert.ok(left >= 0 && top >= 0 && left + across <= width && top + down <= height);
        assert.ok(offsetX >= 0 && offsetY >= 0 && offsetX + across <= labelWidth && offsetY + down <= labelHeight);
        for (let row = 0; row < down; row++) {
          for (let column = 0; column < across; column++) {
            const destination = (top + row) * width + left + column;
            const source = (offsetY + row) * labelWidth + offsetX + column;
            assert.equal(coverage[destination]++, 0, 'Overlapping atlas labels');
            assert.equal(labelCoverage[source]++, 0, 'Overlapping label slices');
          }
        }
      }
      assert.ok(!labelCoverage.includes(0), 'Missing label pixels');
      if (label.sourceInkBounds) assert.deepEqual(sourceInkBounds(pixels, width, label), label.sourceInkBounds, label.source);
    }
    for (let index = 0; index < pixels.length; index++) {
      if (!coverage[index] && asset.resourceId !== 28) assert.equal(pixels[index], 0, 'Uncovered original name ink');
    }
  }
});

test('PAT scatter/gather preserves full-height probe cells and all unrelated pixels and ROM bytes', { skip: !existsSync(originalPath) }, () => {
  const original = readFileSync(originalPath);
  const modified = Buffer.from(original);
  const touched = Buffer.alloc(original.length);
  for (const asset of manifest.assets) {
    const resources = uiResources(original, asset.packageId);
    const resource = resources[asset.resourceId];
    const image = original.subarray(resource.offset);
    const width = image[5] * 8;
    const height = image[6] * 8;
    const before = decodeTiles4bpp(image.subarray(8), width, height);
    const after = Buffer.from(before);
    for (const label of asset.labels) {
      const [labelWidth, labelHeight] = label.size ?? label.rect.slice(2);
      const probe = Buffer.from(Array.from({ length: labelWidth * labelHeight }, (_, index) => index % 15 + 1));
      const mask = Buffer.alloc(after.length);
      const snapshot = Buffer.from(after);
      for (const { rect: [left, top, across, down], at: [offsetX, offsetY] } of labelSlices(label)) {
        for (let row = 0; row < down; row++) {
          for (let column = 0; column < across; column++) {
            const destination = (top + row) * width + left + column;
            after[destination] = probe[(offsetY + row) * labelWidth + offsetX + column];
            mask[destination] = 1;
          }
        }
      }
      const reconstructed = Buffer.alloc(probe.length);
      for (const { rect: [left, top, across, down], at: [offsetX, offsetY] } of patternSlices(original, resources, label)) {
        for (let row = 0; row < down; row++) {
          for (let column = 0; column < across; column++) {
            reconstructed[(offsetY + row) * labelWidth + offsetX + column] = after[(top + row) * width + left + column];
          }
        }
      }
      assert.deepEqual(reconstructed, probe, `Clipped sprite: ${label.source}`);
      for (let index = 0; index < after.length; index++) {
        if (!mask[index]) assert.equal(after[index], snapshot[index], `Neighbor changed: ${label.source}`);
      }
    }
    const encoded = encodeTiles4bpp(after, width, height);
    assert.deepEqual(decodeTiles4bpp(encoded, width, height), after);
    const start = resource.offset + 8;
    const end = start + encoded.length;
    assert.ok(end <= resources[asset.resourceId + 1].offset);
    assert.ok(!touched.subarray(start, end).includes(1));
    touched.fill(1, start, end);
    encoded.copy(modified, start);
  }
  for (let index = 0; index < original.length; index++) {
    if (!touched[index]) assert.equal(modified[index], original[index], 'Unrelated ROM byte changed');
  }
});

test('match-order loader binds IMG 28 and PAT 31 alongside roles 235 and heading 262 with exact preimages',
  { skip: !existsSync(originalPath) }, () => {
    const original = readFileSync(originalPath);
    const asset = manifest.assets.find(entry => entry.packageId === 1 && entry.resourceId === 28);
    const resources = uiResources(original, 1);
    for (const [resourceId, expected] of [[28, asset.sourceSha256], ...Object.entries(asset.patternSha256)]) {
      const start = resources[Number(resourceId)].offset;
      const end = resources[Number(resourceId) + 1].offset;
      assert.equal(createHash('sha256').update(original.subarray(start, end)).digest('hex'), expected);
    }
    const descriptors = Array.from({ length: 6 }, (_, index) =>
      Array.from({ length: 5 }, (_, field) => original.readInt32LE(0x21fc8c + index * 20 + field * 4)));
    assert.deepEqual(descriptors, [
      [2, 0, 0, 1, 262], [3, 0, -1, 1, 259],
      [2, 0, 4, 1, 28], [3, 1, -1, 1, 24],
      [2, 0, 12, 1, 235], [3, 2, -1, 1, 236],
    ]);
    assert.equal(original.readInt32LE(0x21fd04), -1);
    assert.equal(original.readUInt32LE(0x1ee54), 0x0821fc8c);
    assert.equal(original.subarray(0x1eeae, 0x1eeb6).toString('hex'), '01211f22fff7f3fe');
    assert.equal(original.readUInt32LE(0x1eec8), 0x020386a0);
    assert.equal(original.readUInt32LE(resources[31].offset + 4), asset.labels.length);
  });

test('actual match-order patch preserves surnames, unknown frame, all unrelated pixels and exact ROM preimages',
  { skip: !existsSync(originalPath) }, () => {
    const original = readFileSync(originalPath);
    const resources = uiResources(original, 1);
    const asset = manifest.assets.find(entry => entry.packageId === 1 && entry.resourceId === 28);
    const { patches } = buildUi(original);
    const owned = patches.filter(patch => patch.packageId === 1 && patch.resourceId === 28);
    assert.equal(owned.length, 1);
    const [patch] = owned;
    assert.equal(patch.offset, resources[28].offset + 8);
    assert.equal(patch.after.length, patch.before.length);
    assert.deepEqual(patch.before, original.subarray(patch.offset, resources[29].offset));
    for (const other of patches.filter(entry => entry !== patch)) {
      assert.ok(other.offset + other.after.length <= patch.offset || other.offset >= patch.offset + patch.after.length,
        'Another fragment overlaps match-order image');
    }
    const before = decodeTiles4bpp(patch.before, 256, 64);
    const after = decodeTiles4bpp(patch.after, 256, 64);
    const mask = Buffer.alloc(before.length);
    for (const label of asset.labels) {
      for (const { rect: [left, top, across, down] } of labelSlices(label)) {
        for (let row = 0; row < down; row++) for (let column = 0; column < across; column++) {
          assert.equal(mask[(top + row) * 256 + left + column]++, 0, 'Conflicting short-name tiles');
        }
      }
      const shortPattern = namePattern(original, 31, label.patternFrame);
      const fullPattern = namePattern(original, 29, label.patternFrame);
      const anchors = shortPattern.slices.map(slice => {
        const shared = fullPattern.slices.filter(piece => piece.rect.every((value, index) => value === slice.rect[index]));
        assert.equal(shared.length, 1, 'Full name must use each short-name piece exactly once');
        return shared[0].at.map((value, axis) => value - slice.at[axis]);
      });
      for (const anchor of anchors) assert.deepEqual(anchor, anchors[0], 'Shared short-name pieces must stay contiguous');
      const expected = composeName(before, 256, fullPattern);
      const translated = composeName(after, 256, shortPattern);
      for (let row = 0; row < shortPattern.size[1]; row++) {
        translated.copy(expected, (anchors[0][1] + row) * fullPattern.size[0] + anchors[0][0],
          row * shortPattern.size[0], (row + 1) * shortPattern.size[0]);
      }
      assert.deepEqual(composeName(after, 256, fullPattern), expected, `Shared full-name damage: ${label.target}`);
    }
    assert.deepEqual(composeName(after, 256, namePattern(original, 29, 18)),
      composeName(before, 256, namePattern(original, 29, 18)), 'Unknown-name frame changed');
    let changed = 0;
    for (let index = 0; index < before.length; index++) {
      if (!mask[index]) assert.equal(after[index], before[index], 'Unrelated atlas pixel changed');
      if (after[index] !== before[index]) changed++;
    }
    assert.ok(changed > 0);
    const modified = Buffer.from(original);
    patch.after.copy(modified, patch.offset);
    assert.deepEqual(modified.subarray(0, patch.offset), original.subarray(0, patch.offset));
    assert.deepEqual(modified.subarray(patch.offset + patch.after.length), original.subarray(patch.offset + patch.after.length));
    const conflict = Buffer.from(original);
    conflict[patch.offset] ^= 1;
    const snapshot = Buffer.from(conflict);
    assert.throws(() => applyUi(original, conflict), /UI patch conflicts/);
    assert.deepEqual(conflict, snapshot, 'A preimage conflict must not partially apply patches');
  });