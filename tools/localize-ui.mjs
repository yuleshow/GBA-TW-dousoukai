import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RESOURCE_BASE, RESOURCE_TABLE, parseBdf, rasterizeGlyph } from './font.mjs';
import { ROM_SHA256 } from './inspect-rom.mjs';

export const UI_MANIFEST_FILES = ['ui.json', 'names-ui.json', 'costume-ui.json', 'mahjong-ui.json', 'scoring-ui.json'];

export function loadUiManifest() {
  const fragments = UI_MANIFEST_FILES.map(file =>
    JSON.parse(readFileSync(new URL(`../translations/${file}`, import.meta.url), 'utf8')));
  return {
    ...fragments[0],
    assets: fragments.flatMap(fragment => fragment.assets),
    patternEdits: fragments.flatMap(fragment => fragment.patternEdits ?? []),
    untranslated: fragments.flatMap(fragment => fragment.untranslated ?? []),
  };
}

export function renderUiLabel(pixels, width, height, label, glyphs, style = {}) {
  const fontSize = style.fontSize ?? 12;
  const scale = style.scale ?? 1;
  const cellSize = fontSize * scale;
  const minimumHeight = cellSize + (style.outline === 0 ? 0 : 2);
  if (![8, 12].includes(fontSize) || !Number.isInteger(scale) || scale < 1 || scale > 4) {
    throw new Error(`UI label does not fit: ${label.target}`);
  }
  if (label.tiles) {
    const columns = label.size[0] / 8;
    if (!Number.isInteger(columns) || label.size[1] % 8 || label.tiles.length !== columns * label.size[1] / 8
      || label.tiles.some(tile => !Number.isInteger(tile) || tile < 0)) throw new Error('Invalid UI label tiles');
    label = { ...label, slices: label.tiles.map((tile, index) => ({
      rect: [tile % 32 * 8, Math.floor(tile / 32) * 8, 8, 8],
      at: [index % columns * 8, Math.floor(index / columns) * 8],
    })) };
  }
  if (label.slices) {
    const [labelWidth, labelHeight] = label.size;
    if (![labelWidth, labelHeight].every(Number.isInteger) || labelWidth < 1
      || labelHeight < minimumHeight || labelWidth * labelHeight > 0x100000) throw new Error('Invalid UI label size');
    const bitmap = Buffer.alloc(labelWidth * labelHeight);
    const coverage = Buffer.alloc(bitmap.length);
    const destinations = new Set();
    for (const { rect: [left, top, across, down], at: [sourceX, sourceY] } of label.slices) {
      if (![left, top, across, down, sourceX, sourceY].every(Number.isInteger)
        || Math.min(left, top, sourceX, sourceY) < 0 || across < 1 || down < 1
        || left + across > width || top + down > height
        || sourceX + across > labelWidth || sourceY + down > labelHeight) throw new Error('Invalid UI label slice');
      for (let row = 0; row < down; row++) {
        for (let column = 0; column < across; column++) {
          const source = (sourceY + row) * labelWidth + sourceX + column;
          const destination = (top + row) * width + left + column;
          if (coverage[source] || destinations.has(destination)) throw new Error('Overlapping UI label slices');
          coverage[source] = 1;
          destinations.add(destination);
        }
      }
    }
    if (coverage.includes(0)) throw new Error('Incomplete UI label slices');
    renderUiLabel(bitmap, labelWidth, labelHeight,
      { target: label.target, rect: [0, 0, labelWidth, labelHeight] }, glyphs, style);
    for (const { rect: [left, top, across, down], at: [sourceX, sourceY] } of label.slices) {
      for (let row = 0; row < down; row++) {
        bitmap.copy(pixels, (top + row) * width + left,
          (sourceY + row) * labelWidth + sourceX, (sourceY + row) * labelWidth + sourceX + across);
      }
    }
    return;
  }
  const [left, top, across, down] = label.rect;
  const characters = [...label.target];
  if (![left, top, across, down].every(Number.isInteger) || left < 0 || top < 0
    || across < 1 || down < minimumHeight || left + across > width || top + down > height
    || characters.length === 0 || characters.length * cellSize > across) {
    throw new Error(`UI label does not fit: ${label.target}`);
  }
  for (let row = top; row < top + down; row++) pixels.fill(style.background ?? 0, row * width + left, row * width + left + across);
  const originX = left + (label.align === 'right' ? across - characters.length * cellSize
    : Math.floor((across - characters.length * cellSize) / 2));
  const originY = top + Math.floor((down - cellSize) / 2);
  const ink = [];
  for (const [index, character] of characters.entries()) {
    const glyph = rasterizeGlyph(glyphs.get(character.codePointAt(0)), fontSize);
    for (let row = 0; row < fontSize; row++) {
      const bits = glyph.readUInt16BE(row * 2);
      for (let column = 0; column < fontSize; column++) {
        if (bits & 0x8000 >>> column) {
          for (let offsetY = 0; offsetY < scale; offsetY++) {
            for (let offsetX = 0; offsetX < scale; offsetX++) {
              ink.push([originX + index * cellSize + column * scale + offsetX, originY + row * scale + offsetY]);
            }
          }
        }
      }
    }
  }
  for (const [column, row] of ink) {
    for (let deltaY = -1; deltaY <= 1; deltaY++) {
      for (let deltaX = -1; deltaX <= 1; deltaX++) {
        if (column + deltaX >= left && column + deltaX < left + across
          && row + deltaY >= top && row + deltaY < top + down) {
          pixels[(row + deltaY) * width + column + deltaX] = style.outline ?? 1;
        }
      }
    }
  }
  for (const [column, row] of ink) pixels[row * width + column] = style.fill ?? 15 - Math.floor((row - originY) / (3 * scale));
}

export function buildUi(original) {
  if (createHash('sha256').update(original).digest('hex') !== ROM_SHA256) {
    throw new Error('UI localization requires the verified original BDMJ revision 0 ROM');
  }
  const manifest = loadUiManifest();
  const fonts = new Map([8, 12].map(fontSize => [fontSize, parseBdf(readFileSync(
    new URL(`../assets/fonts/fusion-pixel-${fontSize}px-monospaced-zh_hant.bdf`, import.meta.url), 'utf8'), fontSize)]));
  const patches = [];
  const covered = [];
  for (const asset of manifest.assets) {
    const resources = uiResources(original, asset.packageId);
    const resource = resources[asset.resourceId];
    if (!resource || !['IMG', 'ECD'].includes(resource.type)) throw new Error('Expected UI image resource');
    const compressed = resource.type === 'ECD';
    const data = compressed ? decodeEcd(original.subarray(resource.offset)) : original.subarray(resource.offset);
    if (data.toString('ascii', 0, 3) !== 'IMG' || data[4] !== 0) throw new Error('Expected 4bpp UI image');
    const width = data[5] * 8;
    const height = data[6] * 8;
    const pixels = decodeTiles4bpp(data.subarray(8), width, height);
    const glyphs = fonts.get(asset.style?.fontSize ?? 12);
    for (const label of asset.labels) renderUiLabel(pixels, width, height, label, glyphs, asset.style);
    const tiles = encodeTiles4bpp(pixels, width, height);
    const offset = resource.offset + (compressed ? 0 : 8);
    const end = compressed ? resources[asset.resourceId + 1]?.offset : offset + tiles.length;
    if (!end || end <= offset) throw new Error('Missing resource boundary');
    const before = Buffer.from(original.subarray(offset, end));
    let after = tiles;
    if (compressed) {
      const payload = Buffer.concat([data.subarray(0, 8), tiles]);
      const encoded = encodeEcd(payload);
      if (!decodeEcd(encoded).equals(payload)) throw new Error('ECD round-trip mismatch');
      if (encoded.length > before.length) throw new Error(`UI resource ${asset.resourceId} exceeds original allocation`);
      after = Buffer.alloc(before.length);
      encoded.copy(after);
    }
    patches.push({ offset, before, after, packageId: asset.packageId, resourceId: asset.resourceId });
    covered.push({ ...asset, offset, width, height, encoding: compressed ? 'ECD LZSS 4bpp tiles' : 'raw 4bpp tiles' });
  }
  for (const edit of manifest.patternEdits ?? []) {
    const resources = uiResources(original, edit.packageId);
    const resource = resources[edit.resourceId];
    if (resource?.type !== 'PAT') throw new Error('Expected UI pattern resource');
    const offset = resource.offset;
    const before = Buffer.from(original.subarray(offset, resources[edit.resourceId + 1].offset));
    const after = Buffer.from(before);
    for (const frame of edit.frames) {
      if (!Number.isInteger(frame.index) || frame.index < 0 || frame.index >= before.readUInt32LE(4)) throw new Error('Invalid UI pattern frame');
      const start = before.readUInt32LE(8 + frame.index * 4);
      const expected = Buffer.from(frame.before, 'hex');
      const replacement = Buffer.from(frame.after, 'hex');
      if (expected.length !== 2 + before.readUInt16LE(start) * 8
        || replacement.length !== 2 + replacement.readUInt16LE(0) * 8
        || replacement.length > expected.length
        || !before.subarray(start, start + expected.length).equals(expected)) throw new Error('UI pattern preimage mismatch');
      replacement.copy(after, start);
    }
    patches.push({ offset, before, after, packageId: edit.packageId, resourceId: edit.resourceId });
  }
  return {
    patches,
    report: { assets: covered, labels: covered.reduce((count, asset) => count + asset.labels.length, 0),
      patternEdits: manifest.patternEdits ?? [], complete: false, untranslated: manifest.untranslated },
  };
}

export function applyUi(original, modified) {
  const result = buildUi(original);
  for (const patch of result.patches) {
    if (!modified.subarray(patch.offset, patch.offset + patch.before.length).equals(patch.before)) {
      throw new Error(`UI patch conflicts at 0x${patch.offset.toString(16)}`);
    }
  }
  for (const patch of result.patches) patch.after.copy(modified, patch.offset);
  return result;
}

export function decodeEcd(data) {
  if (data.length < 16 || data.toString('ascii', 0, 3) !== 'ECD' || data[3] !== 1) {
    throw new Error('Invalid ECD header');
  }
  const prefix = data.readUInt32BE(4);
  const packedLength = data.readUInt32BE(8);
  const outputLength = data.readUInt32BE(12);
  if (prefix > packedLength || prefix > outputLength || packedLength + 16 > data.length
    || outputLength > 0x100000) throw new Error('Invalid ECD sizes');
  const output = Buffer.alloc(outputLength);
  data.copy(output, 0, 16, 16 + prefix);
  const dictionary = Buffer.alloc(1024);
  let dictionaryCursor = 958;
  let cursor = 16 + prefix;
  let outputCursor = prefix;
  function emit(value) {
    if (outputCursor >= outputLength) throw new Error('ECD output overflow');
    output[outputCursor++] = value;
    dictionary[dictionaryCursor] = value;
    dictionaryCursor = (dictionaryCursor + 1) & 1023;
  }
  const end = 16 + packedLength;
  while (cursor < end && outputCursor < outputLength) {
    const flags = data[cursor++];
    for (let bit = 0; bit < 8 && cursor < end && outputCursor < outputLength; bit++) {
      if (flags & 1 << bit) emit(data[cursor++]);
      else {
        if (cursor + 2 > end) throw new Error('Truncated ECD reference');
        const lower = data[cursor++];
        const upper = data[cursor++];
        const source = lower | (upper & 192) << 2;
        const length = (upper & 63) + 3;
        for (let index = 0; index < length; index++) emit(dictionary[(source + index) & 1023]);
      }
    }
  }
  if (outputCursor !== outputLength) throw new Error('ECD output size mismatch');
  return output;
}

export function encodeEcd(data, prefix = 8) {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > data.length || data.length > 0x100000) {
    throw new Error('Invalid ECD input');
  }
  const dictionary = Buffer.alloc(1024);
  const stream = [];
  let dictionaryCursor = 958;
  let cursor = prefix;
  while (cursor < data.length) {
    const flagIndex = stream.length;
    stream.push(0);
    for (let bit = 0; bit < 8 && cursor < data.length; bit++) {
      let bestLength = 0;
      let bestSource = 0;
      const maximum = Math.min(66, data.length - cursor);
      for (let source = 0; source < 1024; source++) {
        let length = 0;
        while (length < maximum) {
          const relative = (source + length - dictionaryCursor + 1024) & 1023;
          const value = relative < length ? data[cursor + relative] : dictionary[(source + length) & 1023];
          if (value !== data[cursor + length]) break;
          length++;
        }
        if (length > bestLength) {
          bestLength = length;
          bestSource = source;
          if (length === maximum) break;
        }
      }
      const length = bestLength >= 3 ? bestLength : 1;
      if (bestLength >= 3) stream.push(bestSource & 255, (bestSource >>> 8) << 6 | length - 3);
      else {
        stream[flagIndex] |= 1 << bit;
        stream.push(data[cursor]);
      }
      for (let index = 0; index < length; index++) {
        dictionary[dictionaryCursor] = data[cursor++];
        dictionaryCursor = (dictionaryCursor + 1) & 1023;
      }
    }
  }
  const header = Buffer.alloc(16);
  header.write('ECD');
  header[3] = 1;
  header.writeUInt32BE(prefix, 4);
  header.writeUInt32BE(prefix + stream.length, 8);
  header.writeUInt32BE(data.length, 12);
  return Buffer.concat([header, data.subarray(0, prefix), Buffer.from(stream)]);
}

export function uiResources(rom, packageId = 0) {
  if (rom.readUInt32LE(RESOURCE_TABLE) !== 0x08000000 + RESOURCE_BASE) {
    throw new Error('Unexpected resource package');
  }
  if (!Number.isInteger(packageId) || packageId < 0 || packageId > 2) throw new Error('Invalid package ID');
  const base = rom.readUInt32LE(RESOURCE_TABLE + packageId * 4) - 0x08000000;
  let count = rom.readUInt32LE(base) / 4;
  if (!Number.isInteger(count) || count < 1 || count > 4096) throw new Error('Invalid resource count');
  const tableEnd = base + count * 4;
  while (count && rom.readUInt32LE(base + (count - 1) * 4) === 0) count--;
  return Array.from({ length: count }, (_, id) => {
    const offset = base + rom.readUInt32LE(base + id * 4);
    if (offset < tableEnd || offset + 8 > rom.length) throw new Error('Invalid resource offset');
    return { packageId, id, offset, type: rom.toString('ascii', offset, offset + 3) };
  });
}

export function decodeTiles4bpp(data, width, height) {
  if (width % 8 || height % 8 || width <= 0 || height <= 0 || data.length < width * height / 2) {
    throw new Error('Invalid 4bpp tile dimensions');
  }
  const pixels = Buffer.alloc(width * height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const tile = Math.floor(row / 8) * (width / 8) + Math.floor(column / 8);
      const packed = data[tile * 32 + row % 8 * 4 + Math.floor(column % 8 / 2)];
      pixels[row * width + column] = packed >>> (column % 2 * 4) & 15;
    }
  }
  return pixels;
}

export function encodeTiles4bpp(pixels, width, height) {
  if (pixels.length !== width * height || width % 8 || height % 8 || width <= 0 || height <= 0
    || pixels.some(value => value > 15)) throw new Error('Invalid indexed pixels');
  const data = Buffer.alloc(width * height / 2);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const tile = Math.floor(row / 8) * (width / 8) + Math.floor(column / 8);
      data[tile * 32 + row % 8 * 4 + Math.floor(column % 8 / 2)] |= pixels[row * width + column] << (column % 2 * 4);
    }
  }
  return data;
}