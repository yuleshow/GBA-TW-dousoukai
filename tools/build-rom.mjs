import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractScripts, loadRom, parseScript, ROM_SHA256 } from './inspect-rom.mjs';
import { extractExtraScripts } from './extra-scripts.mjs';
import { applyUi, buildUi } from './localize-ui.mjs';
import {
  EXPANDED_FONT, FIRST_NEW_INDEX, FONT_POINTER, GLYPH_BYTES, LAST_NEW_INDEX,
  ORIGINAL_FONT, RESOURCE_BASE, originalGlyphCount, parseBdf, rasterizeGlyph, sjisCode, sjisIndex,
} from './font.mjs';

export const BDF_SHA256 = 'd8a4109d11a8d7649ad70ce51247e2aa6b21b246b1b40f422617b8c52a1cb90c';
export const FONT_ARCHIVE_SHA256 = '5b1cac9253fa9e20b9fea5fd582eeed985819a3ce4b7f7fb108f8d6e599ad211';
const MAX_ROM_SIZE = 0x1000000;
const IPS_EOF_OFFSET = 0x454f46;
const protectedSymbols = ['\u3012', '\u2200', '\u266d', '\u266f', '\u266a'];
const hex = value => `0x${value.toString(16)}`;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const needsTranslation = source => !/^[\p{P}\p{S}\p{Z}\p{N}]*$/u.test(source);
const characters = text => text.match(/<SJIS:[0-9a-f]{4}>|[^]/gu) ?? [];

export function createIps(original, modified) {
  if (modified.length < original.length || modified.length > MAX_ROM_SIZE) {
    throw new Error('IPS build requires a nonshrinking ROM of at most 16 MiB');
  }
  const chunks = [Buffer.from('PATCH')];
  let cursor = 0;
  while (cursor < modified.length) {
    if (cursor < original.length && original[cursor] === modified[cursor]) {
      cursor++;
      continue;
    }
    let start = cursor;
    if (start === IPS_EOF_OFFSET) start--;
    cursor++;
    while (cursor < modified.length && cursor - start < 0xffff
      && (cursor >= original.length || original[cursor] !== modified[cursor])) cursor++;
    const header = Buffer.alloc(5);
    header.writeUIntBE(start, 0, 3);
    header.writeUInt16BE(cursor - start, 3);
    chunks.push(header, modified.subarray(start, cursor));
  }
  chunks.push(Buffer.from('EOF'));
  return Buffer.concat(chunks);
}

export function applyIps(original, patch) {
  if (patch.subarray(0, 5).toString('ascii') !== 'PATCH' || original.length > MAX_ROM_SIZE) {
    throw new Error('Invalid IPS header or original size');
  }
  let cursor = 5;
  let outputLength = original.length;
  const records = [];
  function requireBytes(count) {
    if (cursor + count > patch.length) throw new Error('Truncated IPS patch');
  }
  while (true) {
    requireBytes(3);
    const offset = patch.readUIntBE(cursor, 3);
    cursor += 3;
    if (offset === IPS_EOF_OFFSET) break;
    requireBytes(2);
    let length = patch.readUInt16BE(cursor);
    cursor += 2;
    let data;
    if (length === 0) {
      requireBytes(3);
      length = patch.readUInt16BE(cursor);
      if (length === 0) throw new Error('Empty IPS RLE record');
      data = Buffer.alloc(length, patch[cursor + 2]);
      cursor += 3;
    } else {
      requireBytes(length);
      data = patch.subarray(cursor, cursor + length);
      cursor += length;
    }
    if (offset + length > MAX_ROM_SIZE) throw new Error('IPS record exceeds 16 MiB');
    records.push({ offset, data });
    outputLength = Math.max(outputLength, offset + length);
  }
  let truncateTo;
  if (cursor + 3 === patch.length) {
    truncateTo = patch.readUIntBE(cursor, 3);
    cursor += 3;
  }
  if (cursor !== patch.length) throw new Error('Unexpected trailing IPS data');
  const result = Buffer.alloc(Math.max(outputLength, truncateTo ?? 0));
  original.copy(result);
  for (const { offset, data } of records) data.copy(result, offset);
  return truncateTo === undefined ? result : result.subarray(0, truncateTo);
}

export function collectTranslations(parts, texts) {
  const required = new Map(texts.filter(token => needsTranslation(token.source)).map(token => [token.offset, token]));
  const translations = new Map();
  for (const part of parts) {
    if (!part || Array.isArray(part) || typeof part !== 'object') throw new Error('Translation part must be an object');
    for (const [key, target] of Object.entries(part)) {
      if (!/^[0-9a-f]+$/i.test(key)) throw new Error(`Invalid translation offset: ${key}`);
      const offset = Number.parseInt(key, 16);
      if (translations.has(offset)) throw new Error(`Duplicate translation: ${key}`);
      const token = required.get(offset);
      if (!token) throw new Error(`Unexpected translation offset: ${key}`);
      if (typeof target !== 'string' || target.length === 0) throw new Error(`Empty/invalid translation: ${key}`);
      if (characters(target).some(char => !char.startsWith('<SJIS:') && /[\u0000-\u007f\u3040-\u30fa\u30fc-\u30ff\uff65-\uff9f]/u.test(char))) {
        throw new Error(`ASCII/kana target is not allowed: ${key}`);
      }
      if (characters(target).length * 2 > token.hex.length / 2) throw new Error(`Translation exceeds token limit: ${key}`);
      for (const symbol of [...protectedSymbols, ...token.customCodes.map(code => `<SJIS:${code}>`)]) {
        if (characters(token.source).filter(char => char === symbol).length
          !== characters(target).filter(char => char === symbol).length) {
          throw new Error(`Protected symbol ${symbol} changed at ${key}`);
        }
      }
      translations.set(offset, target);
    }
  }
  for (const offset of required.keys()) {
    if (!translations.has(offset)) throw new Error(`Missing translation: ${hex(offset)}`);
  }
  return translations;
}

export function originalCharacterMap(rom, count, sourceCodes = []) {
  const decoder = new TextDecoder('shift_jis', { fatal: true });
  const inverse = new Map();
  const byCode = new Map();
  for (let index = 0; index < count; index++) {
    const code = sjisCode(index);
    const pair = rom.subarray(ORIGINAL_FONT + index * GLYPH_BYTES, ORIGINAL_FONT + index * GLYPH_BYTES + 2);
    let char;
    try {
      char = decoder.decode(pair);
    } catch {
      char = `<SJIS:${code.toString(16)}>`;
    }
    if (!inverse.has(char)) inverse.set(char, code);
    byCode.set(code, char);
  }
  for (const code of sourceCodes) {
    if (code !== 0x9ec8) throw new Error(`Unverified exceptional source glyph ${hex(code)}`);
    if (!byCode.has(code)) {
      const pair = Buffer.alloc(2);
      pair.writeUInt16BE(code);
      const char = decoder.decode(pair);
      assert.equal(char, '\u69d3', 'Exceptional source character mismatch');
      byCode.set(code, char);
    }
  }
  return { inverse, byCode, count };
}

export function encodeText(target, token, characterMap, originalMap, compact = false) {
  const localCodes = new Map();
  const originalBytes = Buffer.from(token.hex, 'hex');
  for (let cursor = 0; cursor < originalBytes.length; cursor += 2) {
    const code = originalBytes.readUInt16BE(cursor);
    const char = originalMap.byCode.get(code);
    if (char === undefined) throw new Error(`Source uses unavailable glyph ${hex(code)}`);
    if (!localCodes.has(char)) localCodes.set(char, code);
  }
  const units = characters(target);
  const result = Buffer.alloc(compact ? units.length * 2 : originalBytes.length);
  if (result.length > originalBytes.length) throw new Error(`Translation exceeds token limit: ${hex(token.offset)}`);
  if (units.length * 2 > result.length) throw new Error(`Translation exceeds token limit: ${hex(token.offset)}`);
  for (let index = 0; index < result.length / 2; index++) {
    const char = units[index];
    let code = 0x8140;
    if (char !== undefined) {
      if (/\p{Script=Han}/u.test(char)) code = characterMap.get(char);
      else code = localCodes.get(char) ?? originalMap.inverse.get(char);
      if (code === undefined) throw new Error(`Unencodable character ${JSON.stringify(char)} at ${hex(token.offset)}`);
      if (char.startsWith('<SJIS:') && !localCodes.has(char)) throw new Error(`Introduced custom code at ${hex(token.offset)}`);
    }
    const glyphIndex = sjisIndex(code);
    if (sjisCode(glyphIndex) !== code || !(glyphIndex < originalMap.count || glyphIndex >= FIRST_NEW_INDEX && glyphIndex <= LAST_NEW_INDEX
      && characterMap.get(char) === code)) throw new Error(`Unavailable output glyph ${hex(code)}`);
    result.writeUInt16BE(code, index * 2);
  }
  return { bytes: result, paddingGlyphs: result.length / 2 - units.length };
}

export function auditScriptReferences(original, scripts) {
  const sorted = [...scripts].sort((left, right) => left.offset - right.offset);
  for (let index = 0; index < sorted.length; index++) {
    const script = sorted[index];
    assert.ok(script.offset >= 0 && script.end <= original.length && script.end > script.offset, 'Invalid script allocation');
    assert.ok(index === 0 || sorted[index - 1].end <= script.offset, 'Overlapping script allocations');
  }
  const known = new Set(scripts.flatMap(script => script.pointerOffset === undefined ? [] : [script.pointerOffset]));
  const references = [];
  const blockedScripts = new Set();
  for (let offset = 0; offset + 4 <= original.length; offset += 4) {
    const target = original.readUInt32LE(offset) - 0x08000000;
    if (!sorted.length || target < sorted[0].offset || target >= sorted.at(-1).end) continue;
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sorted[middle].offset <= target) low = middle + 1;
      else high = middle;
    }
    const script = sorted[low - 1];
    if (target >= script.end) continue;
    const verified = known.has(offset);
    references.push({ offset, target, scriptOffset: script.offset, verified });
    if (!verified) blockedScripts.add(script.offset);
  }
  return { references, blockedScripts };
}

export function relocateScriptAddress(tokens, rebuilt, target, translatedOffsets) {
  const index = tokens.findIndex(token => target >= token.offset && target < token.offset + token.hex.length / 2);
  if (index < 0) throw new Error(`Pointer outside script tokens: ${hex(target)}`);
  const token = tokens[index];
  const delta = target - token.offset;
  if (delta && token.type === 'text' && translatedOffsets.has(token.offset)) {
    throw new Error(`Pointer into translated source character/interior: ${hex(target)}`);
  }
  return rebuilt[index].offset + delta;
}

export function verifyPreservedBytes(original, modified, scripts, translatedOffsets, uiPatches = []) {
  const allowed = Buffer.alloc(original.length);
  allowed.fill(1, FONT_POINTER, FONT_POINTER + 4);
  const audit = auditScriptReferences(original, scripts);
  const rebuiltScripts = new Map();
  let commandCount = 0;
  let preservedSpans = 0;
  for (const script of scripts) {
    if (script.pointerOffset !== undefined) {
      assert.equal(modified.readUInt32LE(script.pointerOffset), original.readUInt32LE(script.pointerOffset), 'Script pointer changed');
    }
    const allTokens = parseScript(modified, script.offset, script.end);
    const parsed = allTokens.slice(0, script.tokens.length);
    assert.ok(allTokens.slice(script.tokens.length).every(token => token.hex === '00'), 'Nonzero trailing script padding');
    assert.equal(parsed.length, script.tokens.length, 'Script token count changed');
    rebuiltScripts.set(script.offset, parsed);
    for (let index = 0; index < script.tokens.length; index++) {
      const token = script.tokens[index];
      const rebuilt = parsed[index];
      assert.equal(rebuilt.type, token.type, 'Script token type changed');
      if (audit.blockedScripts.has(script.offset)) {
        assert.equal(rebuilt.offset, token.offset, 'Unverified reference requires fixed token offsets');
        assert.equal(rebuilt.hex.length, token.hex.length, 'Unverified reference requires fixed token sizes');
      }
      if (token.type === 'text' && translatedOffsets.has(token.offset)) {
        assert.ok(rebuilt.hex.length > 0 && rebuilt.hex.length <= token.hex.length, 'Translation exceeds token limit');
      } else {
        assert.equal(rebuilt.hex, token.hex, 'Preserved token changed');
        if (token.type === 'command') commandCount++;
        else preservedSpans++;
      }
    }
    assert.equal(script.tokens.at(-1).hex, '00', 'Unterminated original allocation');
    allowed.fill(1, script.offset, script.end);
  }
  for (const reference of audit.references) {
    if (!reference.verified) {
      assert.equal(modified.readUInt32LE(reference.offset), original.readUInt32LE(reference.offset), 'Unverified address-like data changed');
      continue;
    }
    const script = scripts.find(entry => entry.offset === reference.scriptOffset);
    const target = relocateScriptAddress(script.tokens, rebuiltScripts.get(script.offset), reference.target, translatedOffsets);
    assert.equal(modified.readUInt32LE(reference.offset), target + 0x08000000, 'Relocated pointer changed');
  }
  for (const { offset, before, after } of uiPatches) {
    assert.ok(Number.isSafeInteger(offset) && offset >= 0 && Buffer.isBuffer(before) && Buffer.isBuffer(after)
      && before.length > 0 && before.length === after.length && offset + before.length <= original.length, 'Invalid UI patch range');
    const end = offset + before.length;
    assert.deepEqual(original.subarray(offset, end), before, 'UI before bytes mismatch');
    assert.deepEqual(modified.subarray(offset, end), after, 'UI after bytes mismatch');
    assert.ok(!allowed.subarray(offset, end).some(Boolean)
      && scripts.every(script => end <= script.offset || offset >= script.end), 'UI patch overlaps protected script/font ranges');
    assert.ok(scripts.every(script => script.pointerOffset === undefined
      || end <= script.pointerOffset || offset >= script.pointerOffset + 4), 'UI patch overlaps script pointer');
    allowed.fill(1, offset, end);
  }
  if (uiPatches.length > 0) {
    const patchBytes = patches => patches.map(({ offset, before, after }) => ({ offset, before, after }));
    assert.deepEqual(patchBytes(uiPatches), patchBytes(buildUi(original).patches), 'Unverified UI patch whitelist');
  }
  let changedOriginalBytes = 0;
  for (let offset = 0; offset < original.length; offset++) {
    if (original[offset] !== modified[offset]) {
      if (!allowed[offset]) throw new Error(`Unauthorized ROM change at ${hex(offset)}`);
      changedOriginalBytes++;
    }
  }
  assert.equal(modified.readUInt32LE(FONT_POINTER), EXPANDED_FONT - RESOURCE_BASE, 'Incorrect relocated font pointer');
  return { commandCount, preservedSpans, changedOriginalBytes };
}

export function buildRom({ original, translationParts, bdfBytes }) {
  if (sha256(original) !== ROM_SHA256 || original.length !== EXPANDED_FONT) throw new Error('Requires verified 8 MiB source ROM');
  if (sha256(bdfBytes) !== BDF_SHA256) throw new Error('BDF SHA-256 mismatch');
  const scripts = [...extractScripts(original), ...extractExtraScripts(original)];
  const texts = scripts.flatMap(script => script.tokens.filter(token => token.type === 'text'));
  assert.equal(scripts.length, 314);
  assert.equal(texts.length, 5078);
  if (translationParts.length !== 5) throw new Error('Expected four translation parts plus extra');
  const translations = collectTranslations(translationParts, texts);
  const count = originalGlyphCount(original);
  assert.equal(count, 4375);
  const originalMap = originalCharacterMap(original, count, [0x9ec8]);
  for (const token of texts) {
    const bytes = Buffer.from(token.hex, 'hex');
    for (let cursor = 0; cursor < bytes.length; cursor += 2) {
      const code = bytes.readUInt16BE(cursor);
      if (sjisIndex(code) >= count && !(code === 0x9ec8 && translations.has(token.offset))) {
        throw new Error(`Original text references a nonoriginal slot at ${hex(token.offset)}`);
      }
    }
  }
  const han = [...new Set([...translations.values()].flatMap(target => characters(target).filter(char => /\p{Script=Han}/u.test(char))))]
    .sort((left, right) => left.codePointAt(0) - right.codePointAt(0));
  if (han.length === 0 || FIRST_NEW_INDEX + han.length - 1 > LAST_NEW_INDEX) throw new Error('New SJIS slot capacity exceeded or empty');
  const glyphs = parseBdf(bdfBytes.toString('utf8'));
  const font = Buffer.alloc((FIRST_NEW_INDEX + han.length) * GLYPH_BYTES);
  for (let index = 0; index < font.length / GLYPH_BYTES; index++) font.writeUInt16BE(sjisCode(index), index * GLYPH_BYTES);
  original.copy(font, 0, ORIGINAL_FONT, ORIGINAL_FONT + count * GLYPH_BYTES);
  const characterMap = new Map();
  const mapping = han.map((char, position) => {
    const index = FIRST_NEW_INDEX + position;
    const code = sjisCode(index);
    let bitmap;
    try {
      bitmap = rasterizeGlyph(glyphs.get(char.codePointAt(0)));
    } catch (error) {
      throw new Error(`Cannot render ${JSON.stringify(char)} U+${char.codePointAt(0).toString(16)}: ${error.message}`);
    }
    bitmap.copy(font, index * GLYPH_BYTES + 2);
    characterMap.set(char, code);
    return {
      character: char, unicode: `U+${char.codePointAt(0).toString(16).toUpperCase()}`,
      sjis: hex(code), index, recordOffset: hex(EXPANDED_FONT + index * GLYPH_BYTES),
      bitmapOffset: hex(EXPANDED_FONT + index * GLYPH_BYTES + 2), bitmapHex: bitmap.toString('hex'),
    };
  });
  const modified = Buffer.concat([original, font]);
  modified.writeUInt32LE(EXPANDED_FONT - RESOURCE_BASE, FONT_POINTER);
  const audit = auditScriptReferences(original, scripts);
  const compactOffsets = new Set(scripts.filter(script => !audit.blockedScripts.has(script.offset))
    .flatMap(script => script.tokens.map(token => token.offset)));
  const encodedTexts = new Map();
  const spans = [];
  const symbolChanges = [];
  const usedOriginalCodes = new Set();
  for (const token of texts) {
    const target = translations.get(token.offset);
    if (target === undefined) continue;
    const encoded = encodeText(target, token, characterMap, originalMap, compactOffsets.has(token.offset));
    encodedTexts.set(token.offset, encoded.bytes);
    const decoded = [];
    for (let cursor = 0; cursor < encoded.bytes.length; cursor += 2) {
      const code = encoded.bytes.readUInt16BE(cursor);
      const index = sjisIndex(code);
      if (index < count) usedOriginalCodes.add(code);
      else assert.ok(index >= FIRST_NEW_INDEX && index < FIRST_NEW_INDEX + han.length, 'Unallocated slot used');
      assert.equal(font.readUInt16BE(index * GLYPH_BYTES), code, 'Glyph header mismatch');
      decoded.push(index >= FIRST_NEW_INDEX ? han[index - FIRST_NEW_INDEX] : originalMap.byCode.get(code));
    }
    const targetLength = decoded.length - encoded.paddingGlyphs;
    assert.equal(decoded.slice(0, targetLength).join(''), target, 'Encoded text failed round-trip');
    assert.ok(decoded.slice(targetLength).every(char => char === '\u3000'), 'Nonspace padding');
    spans.push({ offset: hex(token.offset), source: token.source, target, byteLength: encoded.bytes.length,
      paddingGlyphs: encoded.paddingGlyphs, encodedHex: encoded.bytes.toString('hex') });
    const sourceSymbols = characters(token.source).filter(char => /\p{S}/u.test(char));
    const targetSymbols = characters(target).filter(char => /\p{S}/u.test(char));
    if (sourceSymbols.join('') !== targetSymbols.join('')) {
      symbolChanges.push({ offset: hex(token.offset), sourceSymbols: sourceSymbols.join(''), targetSymbols: targetSymbols.join('') });
    }
  }
  const relocatedOffsets = new Map();
  const layouts = [];
  for (const script of scripts) {
    let cursor = script.offset;
    modified.fill(0, script.offset, script.end);
    for (const token of script.tokens) {
      const bytes = encodedTexts.get(token.offset) ?? Buffer.from(token.hex, 'hex');
      relocatedOffsets.set(token.offset, cursor);
      bytes.copy(modified, cursor);
      cursor += bytes.length;
    }
    assert.ok(cursor <= script.end, 'Compacted script exceeds allocation');
    layouts.push({ offset: hex(script.offset), end: hex(script.end), contentEnd: hex(cursor),
      reclaimedBytes: script.end - cursor, compact: !audit.blockedScripts.has(script.offset) });
  }
  for (const span of spans) span.relocatedOffset = hex(relocatedOffsets.get(Number.parseInt(span.offset, 16)));
  const ui = applyUi(original, modified);
  const preservation = verifyPreservedBytes(original, modified, scripts, translations, ui.patches);
  assert.deepEqual(modified.subarray(EXPANDED_FONT, EXPANDED_FONT + count * GLYPH_BYTES),
    original.subarray(ORIGINAL_FONT, ORIGINAL_FONT + count * GLYPH_BYTES), 'Original font copy changed');
  for (const entry of mapping) {
    const bitmap = modified.subarray(EXPANDED_FONT + entry.index * GLYPH_BYTES + 2, EXPANDED_FONT + (entry.index + 1) * GLYPH_BYTES);
    assert.ok(bitmap.some(Boolean), `Blank new glyph ${entry.unicode}`);
    for (let row = 0; row < 12; row++) assert.equal(bitmap.readUInt16BE(row * 2) & 15, 0, 'Glyph exceeds nominal width');
  }
  const patch = createIps(original, modified);
  assert.deepEqual(applyIps(original, patch), modified, 'IPS round-trip failed');
  assert.equal(sha256(original), ROM_SHA256, 'Original ROM mutated');
  const report = {
    formatVersion: 2,
    outputs: { rom: 'build/dousoukai-zh-Hant.gba', ips: 'build/dousoukai-zh-Hant.ips',
      report: 'build/report.json', characters: 'build/character-map.json', scripts: 'build/script-map.json' },
    source: { sha256: ROM_SHA256, bytes: original.length },
    localized: { sha256: sha256(modified), bytes: modified.length },
    ips: { sha256: sha256(patch), bytes: patch.length, roundTripVerified: true },
    ui: ui.report,
    scripts: { count: scripts.length, textSpans: texts.length, translatedSpans: spans.length,
      ...preservation, paddingCode: '0x00 after terminator; 0x8140 only in conservatively pinned allocations',
      totalPaddingGlyphs: spans.reduce((sum, span) => sum + span.paddingGlyphs, 0),
      compactedAllocations: layouts.filter(layout => layout.compact).length,
      reclaimedBytes: layouts.reduce((sum, layout) => sum + layout.reclaimedBytes, 0), layouts,
      referenceAudit: audit.references.map(reference => ({ ...reference, offset: hex(reference.offset),
        target: hex(reference.target), scriptOffset: hex(reference.scriptOffset) })),
      pinnedAllocations: [...audit.blockedScripts].map(hex),
      relocatedPointers: 0,
      protectedSymbols, symbolChanges },
    font: { name: 'Fusion Pixel Font 12px monospaced zh_hant', release: '2026.09.01',
      bdfSha256: BDF_SHA256, archiveSha256: FONT_ARCHIVE_SHA256, originalOffset: hex(ORIGINAL_FONT),
      originalGlyphCount: count, copiedOriginalBytes: count * GLYPH_BYTES, newGlyphCount: han.length,
      unusedGapGlyphs: FIRST_NEW_INDEX - count, expandedOffset: hex(EXPANDED_FONT), bytes: font.length,
      resourcePointerOffset: hex(FONT_POINTER), resourceRelativePointer: hex(EXPANDED_FONT - RESOURCE_BASE),
      gbaAddress: hex(0x08000000 + EXPANDED_FONT), firstNewCode: mapping[0].sjis, lastNewCode: mapping.at(-1).sjis,
      firstNewIndex: FIRST_NEW_INDEX, lastNewIndex: FIRST_NEW_INDEX + han.length - 1,
      remainingSlots: LAST_NEW_INDEX + 1 - FIRST_NEW_INDEX - han.length,
      layout: '26 bytes: 2-byte BE SJIS header, 12 BE uint16 rows, MSB-left, nominal width 12',
      placement: { ascent: 10, descent: 2, topRow: '10 - BBX.yOffset - BBX.height', leftColumn: 'BBX.xOffset' } },
    originalCodesUsed: [...usedOriginalCodes].sort((left, right) => left - right).map(code => ({ sjis: hex(code), character: originalMap.byCode.get(code) })),
    checks: { coverage: true, tokenLimits: true, protectedSymbols: true, encodedTextRoundTrip: true,
      controlsAndPointers: true, unchangedBytesOutsideTranslationsFontPointerAndUi: true, uiPatchBytes: true,
      exactOriginalFontCopy: true, allNewGlyphsNonblank: true, ipsRoundTrip: true, sourceUnchanged: true },
    emulatorSamples: spans.slice(0, 12).map(({ offset, target, encodedHex }) => ({ offset, target, encodedHex })),
    limitations: [
      'Emulator validation is pending; no emulator was run by this pipeline.',
      'Allocations with unverified address-like references retain fixed-size padding; all others compact text and zero-fill after the terminator.',
      'Shorter text reaches original waits and line breaks sooner; command bytes and their order are unchanged.',
      'The 264 main scripts and 50 extra scripts are localized; UI localization is incomplete, with outstanding items listed in ui.untranslated.',
      'Original punctuation and custom-symbol bitmaps are retained; Han characters always use zh_hant glyphs.',
      'Translation symbol differences other than protected custom symbols are listed, not rewritten.',
      'ROM ends after the expanded font rather than being padded to 16 MiB; emulator/cartridge size compatibility needs testing.',
    ],
  };
  return { rom: modified, patch, report, mapping, spans };
}

export function main(input = undefined) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const inputPath = input === undefined ? resolve(root, 'assets/Super Real Mahjong Dousoukai (Japan).zip') : resolve(input);
  const original = loadRom(inputPath);
  const translationPaths = [...[1, 2, 3, 4].map(part => `translations/part-${part}.json`), 'translations/extra.json'];
  const translationBytes = translationPaths.map(path => readFileSync(resolve(root, path)));
  const result = buildRom({ original, translationParts: translationBytes.map(bytes => JSON.parse(bytes.toString('utf8'))),
    bdfBytes: readFileSync(resolve(root, 'assets/fonts/fusion-pixel-12px-monospaced-zh_hant.bdf')) });
  result.report.translations = translationBytes.map((bytes, index) => ({ path: translationPaths[index], sha256: sha256(bytes) }));
  mkdirSync(resolve(root, 'build'), { recursive: true });
  writeFileSync(resolve(root, result.report.outputs.rom), result.rom);
  writeFileSync(resolve(root, result.report.outputs.ips), result.patch);
  writeFileSync(resolve(root, result.report.outputs.characters), JSON.stringify(result.mapping, null, 2) + '\n');
  writeFileSync(resolve(root, result.report.outputs.scripts), JSON.stringify(result.spans, null, 2) + '\n');
  assert.equal(sha256(loadRom(inputPath)), ROM_SHA256, 'Source file changed');
  assert.equal(sha256(readFileSync(resolve(root, result.report.outputs.rom))), result.report.localized.sha256, 'Written ROM differs');
  assert.deepEqual(applyIps(original, readFileSync(resolve(root, result.report.outputs.ips))), result.rom, 'Written IPS differs');
  writeFileSync(resolve(root, result.report.outputs.report), JSON.stringify(result.report, null, 2) + '\n');
  console.log(JSON.stringify({ outputs: result.report.outputs, romBytes: result.rom.length, patchBytes: result.patch.length,
    scripts: result.report.scripts.count, textSpans: result.report.scripts.textSpans,
    translatedSpans: result.spans.length, newGlyphs: result.mapping.length, ui: result.report.ui,
    checks: result.report.checks }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2]);