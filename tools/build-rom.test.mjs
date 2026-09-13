import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { extractScripts, loadRom, parseScript, ROM_SHA256 } from './inspect-rom.mjs';
import { extractExtraScripts } from './extra-scripts.mjs';
import { buildUi } from './localize-ui.mjs';
import {
  EXPANDED_FONT, FIRST_NEW_INDEX, FONT_POINTER, GLYPH_BYTES, ORIGINAL_FONT, RESOURCE_BASE,
  originalGlyphCount, parseBdf, rasterizeGlyph, sjisCode, sjisIndex,
} from './font.mjs';
import {
  applyIps, auditScriptReferences, buildRom, collectTranslations, createIps, encodeText, needsTranslation,
  relocateScriptAddress,
  originalCharacterMap, sha256, verifyPreservedBytes,
} from './build-rom.mjs';

test('SJIS slots match the renderer index and round-trip across lead/trail boundaries', () => {
  assert.equal(sjisIndex(0xe040), 5264);
  assert.equal(sjisIndex(0xeffc), 8271);
  assert.equal(sjisCode(5264), 0xe040);
  assert.equal(sjisCode(8271), 0xeffc);
  for (let index = 0; index <= 8271; index++) assert.equal(sjisIndex(sjisCode(index)), index);
  for (const code of [0x817f, 0x8040, 0xf040, 0x81fd]) assert.throws(() => sjisIndex(code));
  assert.throws(() => sjisCode(8272));
});

test('verified ROM font headers establish the contiguous original glyph count', () => {
  const rom = loadRom('work/Super Real Mahjong Dousoukai (Japan).gba');
  const count = originalGlyphCount(rom);
  assert.ok(count >= 4300 && count < 4400);
  console.log(`Original font: ${count} sequential SJIS glyphs.`);
});

const sampleBdf = `STARTFONT 2.1
FONTBOUNDINGBOX 12 12 0 -2
FONT_ASCENT 10
FONT_DESCENT 2
CHARS 1
STARTCHAR sample
ENCODING 20013
SWIDTH 1000 0
DWIDTH 12 0
BBX 3 2 2 -1
BITMAP
A0
E0
ENDCHAR
ENDFONT
`;

test('BDF rasterization respects baseline, x offset, BE rows and MSB-left pixels', () => {
  const glyph = parseBdf(sampleBdf).get(20013);
  const bitmap = rasterizeGlyph(glyph);
  assert.equal(bitmap.length, 24);
  assert.equal(bitmap.readUInt16BE(18), 0x2800);
  assert.equal(bitmap.readUInt16BE(20), 0x3800);
  assert.equal(bitmap.readUInt16BE(22), 0);
  assert.equal(bitmap.subarray(0, 18).some(value => value !== 0), false);
  assert.throws(() => parseBdf(sampleBdf.replace('A0', 'A1')), /padding/);
  assert.throws(() => parseBdf(sampleBdf.replace('E0\n', '')), /bitmap/);
  assert.throws(() => parseBdf(sampleBdf.replace('CHARS 1', 'CHARS 2')), /STARTCHAR/);
  assert.throws(() => rasterizeGlyph({ ...glyph, xOffset: 10 }), /fit/);
  assert.throws(() => rasterizeGlyph({ ...glyph, yOffset: 10 }), /fit/);
  assert.throws(() => rasterizeGlyph({ ...glyph, rows: [0, 0] }), /Blank/);
});

test('verified zh_hant BDF parses completely and provides nonblank Han glyphs', () => {
  const glyphs = parseBdf(readFileSync('assets/fonts/fusion-pixel-12px-monospaced-zh_hant.bdf', 'utf8'));
  assert.equal(glyphs.size, 36540);
  for (const codePoint of [0x4e2d, 0x570b, 0x9ad4]) assert.ok(rasterizeGlyph(glyphs.get(codePoint)).some(Boolean));
});

test('coverage predicate and translation validation reject missing, duplicate, extra and oversized entries', () => {
  const token = { offset: 0x1234, source: '\u65e5', hex: '93fa', customCodes: [] };
  assert.equal(needsTranslation('\u3000\uff01\u3012123'), false);
  assert.equal(needsTranslation('A'), true);
  assert.equal(needsTranslation('\u65e5'), true);
  assert.equal(collectTranslations([{ 1234: '\u4e2d' }], [token]).size, 1);
  assert.throws(() => collectTranslations([{}], [token]), /Missing/);
  assert.throws(() => collectTranslations([{ 1234: '\u4e2d' }, { 1234: '\u4e2d' }], [token]), /Duplicate/);
  assert.throws(() => collectTranslations([{ 1235: '\u4e2d' }], [token]), /Unexpected/);
  assert.throws(() => collectTranslations([{ 1234: '\u4e2d\u570b' }], [token]), /limit/);
  assert.throws(() => collectTranslations([{ 1234: '' }], [token]), /invalid/);
  assert.throws(() => collectTranslations([{ '1234zz': '\u4e2d' }], [token]), /Invalid/);
  assert.throws(() => collectTranslations([[]], [token]), /object/);
  for (const target of ['A', '1', ' ', '\u3042', '\u30a2', '\uff71']) {
    assert.throws(() => collectTranslations([{ 1234: target }], [token]), /ASCII\/kana/);
  }
  assert.equal(collectTranslations([{ 1234: '\u30fb' }], [token]).size, 1);
  const protectedToken = { ...token, source: '\u65e5\u3012', hex: '93fa81a7' };
  assert.throws(() => collectTranslations([{ 1234: '\u4e2d' }], [protectedToken]), /Protected symbol/);
});

test('encoder uses new Han slots even for SJIS Han and retains original symbols and fullwidth padding', () => {
  const rom = loadRom('work/Super Real Mahjong Dousoukai (Japan).gba');
  const originalMap = originalCharacterMap(rom, originalGlyphCount(rom));
  const source = '\u65e5\u3012\u2200\u266d\u266f';
  const sourceBytes = Buffer.alloc(source.length * 2);
  [...source].forEach((char, index) => sourceBytes.writeUInt16BE(originalMap.inverse.get(char), index * 2));
  const token = { offset: 0, hex: sourceBytes.toString('hex'), source, customCodes: [] };
  const mapping = new Map([['\u65e5', 0xe040]]);
  const encoded = encodeText(source, token, mapping, originalMap);
  assert.equal(encoded.paddingGlyphs, 0);
  assert.equal(encoded.bytes.readUInt16BE(0), 0xe040);
  assert.deepEqual(encoded.bytes.subarray(2), sourceBytes.subarray(2));
  const padded = encodeText('\u65e5', token, mapping, originalMap);
  assert.equal(padded.paddingGlyphs, 4);
  assert.equal(padded.bytes.subarray(2).toString('hex'), '8140814081408140');
  const compact = encodeText('\u65e5', token, mapping, originalMap, true);
  assert.equal(compact.paddingGlyphs, 0);
  assert.equal(compact.bytes.toString('hex'), 'e040');
  assert.throws(() => encodeText(source + source, token, mapping, originalMap, true), /limit/);
  assert.throws(() => encodeText('A', token, mapping, originalMap), /Unencodable/);
  assert.throws(() => encodeText('\u4e2d', token, mapping, originalMap), /Unencodable/);
  const custom = [...originalMap.byCode].find(([, char]) => char.startsWith('<SJIS:'));
  assert.ok(custom);
  const customToken = { offset: 0, hex: custom[0].toString(16), source: custom[1], customCodes: [custom[0].toString(16)] };
  assert.equal(encodeText(custom[1], customToken, mapping, originalMap).bytes.toString('hex'), customToken.hex);
  assert.throws(() => encodeText(custom[1], token, mapping, originalMap), /Introduced custom/);
});

test('only the verified exceptional source Han can be decoded, and it cannot be emitted out of range', () => {
  const rom = loadRom('assets/Super Real Mahjong Dousoukai (Japan).zip');
  const count = originalGlyphCount(rom);
  const originalMap = originalCharacterMap(rom, count, [0x9ec8]);
  assert.ok(sjisIndex(0x9ec8) >= count);
  assert.equal(originalMap.byCode.get(0x9ec8), '\u69d3');
  assert.equal(originalMap.inverse.has('\u69d3'), false);
  assert.throws(() => originalCharacterMap(rom, count, [0x9ec9]), /Unverified exceptional/);
  const token = { offset: 0, hex: '9ec8', source: '\u69d3', customCodes: [] };
  assert.equal(encodeText('\u69d3', token, new Map([['\u69d3', 0xe040]]), originalMap).bytes.toString('hex'), 'e040');
  assert.throws(() => encodeText('\u69d3', token, new Map([['\u69d3', 0x9ec8]]), originalMap), /output glyph/);
  assert.throws(() => encodeText('\u69d3', token, new Map([['\u69d3', sjisCode(count)]]), originalMap), /output glyph/);
  assert.throws(() => encodeText('\u69d3', { ...token, hex: '9ec9' }, new Map([['\u69d3', 0xe040]]), originalMap), /unavailable glyph/);
});

test('IPS matches standard raw and RLE fixtures, including optional final-size extension', () => {
  const original = Buffer.from('abc');
  const modified = Buffer.from('aZc');
  const knownPatch = Buffer.from('504154434800000100015a454f46', 'hex');
  assert.deepEqual(createIps(original, modified), knownPatch);
  assert.deepEqual(applyIps(original, knownPatch), modified);
  const rlePatch = Buffer.from('50415443480000010000000358454f46', 'hex');
  assert.equal(applyIps(original, rlePatch).toString(), 'aXXX');
  assert.equal(applyIps(original, Buffer.concat([rlePatch, Buffer.from([0, 0, 2])])).toString(), 'aX');
  assert.equal(applyIps(original, Buffer.concat([rlePatch, Buffer.from([0, 0, 6])])).toString('hex'), '615858580000');
  assert.deepEqual(applyIps(original, createIps(original, original)), original);
});

test('IPS handles EOF sentinel offsets, 65535-byte records and zero-filled extension to 16 MiB', () => {
  const original = Buffer.alloc(0x454f48);
  const modified = Buffer.from(original);
  modified[0x454f46] = 1;
  const sentinelPatch = createIps(original, modified);
  assert.equal(sentinelPatch.readUIntBE(5, 3), 0x454f45);
  assert.deepEqual(applyIps(original, sentinelPatch), modified);
  const longTarget = Buffer.alloc(0x10001, 0xa5);
  const longPatch = createIps(Buffer.alloc(0), longTarget);
  assert.equal(longPatch.readUInt16BE(8), 0xffff);
  assert.deepEqual(applyIps(Buffer.alloc(0), longPatch), longTarget);
  const maximum = Buffer.alloc(0x1000000);
  const smaller = maximum.subarray(0, maximum.length - 1);
  const extension = createIps(smaller, maximum);
  assert.equal(extension.readUIntBE(5, 3), 0xffffff);
  assert.deepEqual(applyIps(smaller, extension), maximum);
  assert.throws(() => createIps(Buffer.alloc(2), Buffer.alloc(1)), /nonshrinking/);
  assert.throws(() => createIps(Buffer.alloc(0), Buffer.alloc(0x1000001)), /16 MiB/);
});

test('IPS parser rejects truncated, malformed and out-of-range records', () => {
  const original = Buffer.alloc(0);
  const fixture = Buffer.from('504154434800000100015a454f46', 'hex');
  for (let length = 0; length < fixture.length; length++) assert.throws(() => applyIps(original, fixture.subarray(0, length)));
  assert.throws(() => applyIps(original, Buffer.concat([fixture, Buffer.from([0])])), /trailing/);
  assert.throws(() => applyIps(original, Buffer.from('50415443480000000000000000454f46', 'hex')), /Empty/);
  assert.throws(() => applyIps(original, Buffer.from('5041544348ffffff00020102454f46', 'hex')), /16 MiB/);
});

test('reference audit pins unknown aligned literals and rejects translated interiors', () => {
  const original = Buffer.alloc(64);
  original.writeUInt32LE(0x08000020, 0);
  original.writeUInt32LE(0x08000024, 4);
  const tokens = [{ type: 'text', offset: 32, hex: '93fa93fa' },
    { type: 'command', offset: 36, hex: '030014' }, { type: 'command', offset: 39, hex: '00' }];
  const scripts = [{ offset: 32, end: 40, pointerOffset: 0, tokens }];
  const audit = auditScriptReferences(original, scripts);
  assert.equal(audit.references.length, 2);
  assert.deepEqual([...audit.blockedScripts], [32]);
  assert.equal(audit.references[0].verified, true);
  assert.equal(audit.references[1].verified, false);
  const rebuilt = [{ ...tokens[0], hex: 'e040' }, { ...tokens[1], offset: 34 }, { ...tokens[2], offset: 37 }];
  assert.equal(relocateScriptAddress(tokens, rebuilt, 32, new Set([32])), 32);
  assert.equal(relocateScriptAddress(tokens, rebuilt, 36, new Set([32])), 34);
  assert.equal(relocateScriptAddress(tokens, rebuilt, 37, new Set([32])), 35);
  for (const target of [33, 34, 35]) {
    assert.throws(() => relocateScriptAddress(tokens, rebuilt, target, new Set([32])), /translated source character\/interior/);
  }
  assert.throws(() => relocateScriptAddress(tokens, rebuilt, 40, new Set([32])), /outside/);
});

function applyRawIpsIndependently(original, patch, targetLength) {
  assert.equal(patch.subarray(0, 5).toString(), 'PATCH');
  assert.equal(patch.subarray(-3).toString(), 'EOF');
  const target = Buffer.alloc(targetLength);
  target.set(original);
  let position = 5;
  while (position < patch.length - 3) {
    const offset = patch[position] * 65536 + patch[position + 1] * 256 + patch[position + 2];
    const length = patch[position + 3] * 256 + patch[position + 4];
    assert.notEqual(offset, 0x454f46);
    assert.ok(length > 0);
    assert.ok(position + 5 + length <= patch.length - 3);
    target.set(patch.subarray(position + 5, position + 5 + length), offset);
    position += 5 + length;
  }
  assert.equal(position, patch.length - 3);
  return target;
}

test('full build is deterministic, lossless outside allowed bytes and independently IPS-reconstructible', () => {
  const original = loadRom('assets/Super Real Mahjong Dousoukai (Japan).zip');
  const translationParts = [1, 2, 3, 4].map(part => JSON.parse(readFileSync(`translations/part-${part}.json`, 'utf8')));
  translationParts.push(JSON.parse(readFileSync('translations/extra.json', 'utf8')));
  const bdfBytes = readFileSync('assets/fonts/fusion-pixel-12px-monospaced-zh_hant.bdf');
  const input = { original, translationParts, bdfBytes };
  const result = buildRom(input);
  const repeat = buildRom(input);
  assert.deepEqual(result.rom, repeat.rom);
  assert.deepEqual(result.patch, repeat.patch);
  assert.deepEqual(result.report, repeat.report);
  assert.equal(sha256(original), ROM_SHA256);
  assert.equal(result.report.scripts.count, 314);
  assert.equal(result.report.scripts.textSpans, 5078);
  assert.equal(result.report.scripts.translatedSpans, 3774);
  assert.equal(result.report.scripts.preservedSpans, 1304);
  const expectedHan = new Set(translationParts.flatMap(part => Object.values(part)).join('').match(/\p{Script=Han}/gu));
  assert.equal(result.mapping.length, expectedHan.size);
  assert.equal(result.mapping[0].sjis, '0xe040');
  assert.equal(result.rom.readUInt32LE(FONT_POINTER), EXPANDED_FONT - RESOURCE_BASE);
  assert.deepEqual(result.rom.subarray(EXPANDED_FONT, EXPANDED_FONT + 4375 * GLYPH_BYTES),
    original.subarray(ORIGINAL_FONT, ORIGINAL_FONT + 4375 * GLYPH_BYTES));
  for (const entry of result.mapping) {
    assert.ok(entry.index >= FIRST_NEW_INDEX);
    const code = Number.parseInt(entry.sjis, 16);
    assert.equal(result.rom.readUInt16BE(EXPANDED_FONT + entry.index * GLYPH_BYTES), code);
    assert.ok(code >= 0xe040 && code <= 0xeffc);
    assert.ok(Buffer.from(entry.bitmapHex, 'hex').some(Boolean));
  }
  assert.deepEqual(applyRawIpsIndependently(original, result.patch, result.rom.length), result.rom);
  const extraScripts = extractExtraScripts(original);
  assert.equal(extraScripts.length, 50);
  const extraTexts = extraScripts.flatMap(script => script.tokens.filter(token => token.type === 'text'));
  assert.equal(extraTexts.length, 127);
  assert.equal(result.spans.filter(span => extraTexts.some(token => token.offset === Number.parseInt(span.offset, 16))).length, 111);
  const scripts = [...extractScripts(original), ...extraScripts];
  const texts = scripts.flatMap(script => script.tokens.filter(token => token.type === 'text'));
  assert.ok(result.report.scripts.compactedAllocations > 280);
  assert.ok(result.report.scripts.reclaimedBytes > 11000);
  assert.ok(result.report.scripts.totalPaddingGlyphs < 1000);
  const audit = auditScriptReferences(original, scripts);
  assert.equal(result.report.scripts.pinnedAllocations.length, audit.blockedScripts.size);
  for (const reference of audit.references) {
    assert.equal(result.rom.readUInt32LE(reference.offset), original.readUInt32LE(reference.offset));
    if (reference.verified) assert.equal(reference.target, reference.scriptOffset);
  }
  for (const layout of result.report.scripts.layouts) {
    const offset = Number.parseInt(layout.offset, 16);
    const end = Number.parseInt(layout.end, 16);
    const contentEnd = Number.parseInt(layout.contentEnd, 16);
    const source = scripts.find(script => script.offset === offset);
    assert.equal(end, source.end);
    assert.equal(layout.reclaimedBytes, end - contentEnd);
    assert.equal(result.rom.subarray(contentEnd, end).some(Boolean), false);
    const rebuilt = parseScript(result.rom, offset, contentEnd);
    assert.equal(rebuilt.length, source.tokens.length);
    assert.deepEqual(rebuilt.filter(token => token.type === 'command').map(token => token.hex),
      source.tokens.filter(token => token.type === 'command').map(token => token.hex));
    assert.equal(rebuilt.at(-1).hex, '00');
  }
  for (const span of result.spans) {
    const offset = Number.parseInt(span.relocatedOffset, 16);
    assert.equal(result.rom.subarray(offset, offset + span.byteLength).toString('hex'), span.encodedHex);
  }
  assert.deepEqual(texts.filter(token => (token.hex.match(/.{4}/g) ?? []).includes('9ec8'))
    .map(token => token.offset), [0x48698, 0x486a0]);
  const translatedOffsets = new Set(result.spans.map(span => Number.parseInt(span.offset, 16)));
  const ui = buildUi(original);
  assert.deepEqual(result.report.ui, ui.report);
  assert.equal(result.report.ui.complete, false);
  assert.ok(result.report.ui.untranslated.length > 0);
  assert.ok(ui.patches.length > 0 && result.report.ui.labels > 0);
  for (const { offset, before, after } of ui.patches) {
    assert.deepEqual(original.subarray(offset, offset + before.length), before);
    assert.deepEqual(result.rom.subarray(offset, offset + after.length), after);
  }
  verifyPreservedBytes(original, result.rom, scripts, translatedOffsets, ui.patches);
  const opening = result.report.scripts.layouts.find(layout => layout.offset === '0x21e564');
  assert.equal(opening.compact, true);
  assert.ok(opening.reclaimedBytes > 0);
  const tailCorrupted = Buffer.from(result.rom);
  tailCorrupted[Number.parseInt(opening.end, 16) - 1] = 5;
  assert.throws(() => verifyPreservedBytes(original, tailCorrupted, scripts, translatedOffsets, ui.patches), /trailing script padding/);
  const breakCorrupted = Buffer.from(result.rom);
  const lineBreak = parseScript(result.rom, 0x21e564, Number.parseInt(opening.contentEnd, 16)).find(token => token.hex === '05');
  assert.ok(lineBreak);
  breakCorrupted[lineBreak.offset] = 4;
  assert.throws(() => verifyPreservedBytes(original, breakCorrupted, scripts, translatedOffsets, ui.patches), /Preserved token changed/);
  assert.throws(() => verifyPreservedBytes(original, result.rom, scripts, translatedOffsets), /Unauthorized/);
  const uiCorrupted = Buffer.from(result.rom);
  uiCorrupted[ui.patches[0].offset] ^= 1;
  assert.throws(() => verifyPreservedBytes(original, uiCorrupted, scripts, translatedOffsets, ui.patches), /UI after/);
  const wrongBefore = Buffer.from(ui.patches[0].before);
  wrongBefore[0] ^= 1;
  assert.throws(() => verifyPreservedBytes(original, result.rom, scripts, translatedOffsets,
    [{ ...ui.patches[0], before: wrongBefore }]), /UI before/);
  for (const invalid of [
    { ...ui.patches[0], offset: -1 },
    { ...ui.patches[0], offset: original.length },
    { ...ui.patches[0], after: Buffer.alloc(0) },
  ]) assert.throws(() => verifyPreservedBytes(original, result.rom, scripts, translatedOffsets, [invalid]), /Invalid UI patch range/);
  assert.throws(() => verifyPreservedBytes(original, result.rom, scripts, translatedOffsets,
    [ui.patches[0], ui.patches[0]]), /overlaps/);
  const forgedUi = Buffer.from(result.rom);
  forgedUi[0] ^= 1;
  assert.throws(() => verifyPreservedBytes(original, forgedUi, scripts, translatedOffsets,
    [...ui.patches, { offset: 0, before: original.subarray(0, 1), after: forgedUi.subarray(0, 1) }]), /Unverified UI patch whitelist/);
  const forgedAfter = Buffer.from(ui.patches[0].after);
  forgedAfter[0] ^= 1;
  assert.throws(() => verifyPreservedBytes(original, uiCorrupted, scripts, translatedOffsets,
    [{ ...ui.patches[0], after: forgedAfter }, ...ui.patches.slice(1)]), /Unverified UI patch whitelist/);
  const terminatorCorrupted = Buffer.from(result.rom);
  const staticScript = extraScripts.find(script => script.offset === 0x48698);
  assert.equal(staticScript.tokens.at(-1).hex, '00');
  terminatorCorrupted[staticScript.end - 1] = 1;
  assert.throws(() => verifyPreservedBytes(original, terminatorCorrupted, scripts, translatedOffsets, ui.patches), /Preserved token changed/);
  const corrupted = Buffer.from(result.rom);
  corrupted[0] ^= 1;
  assert.throws(() => verifyPreservedBytes(original, corrupted, scripts, translatedOffsets, ui.patches), /Unauthorized/);
  corrupted[0] ^= 1;
  corrupted[scripts[0].pointerOffset] ^= 1;
  assert.throws(() => verifyPreservedBytes(original, corrupted, scripts, translatedOffsets), /pointer changed/);
  const wrongSource = Buffer.from(original);
  wrongSource[0] ^= 1;
  assert.throws(() => buildRom({ ...input, original: wrongSource }), /verified/);
  assert.throws(() => buildRom({ ...input, bdfBytes: Buffer.alloc(0) }), /SHA-256/);
  assert.throws(() => buildRom({ ...input, translationParts: translationParts.slice(0, 4) }), /plus extra/);
  assert.throws(() => buildRom({ ...input, translationParts: [...translationParts, {}] }), /plus extra/);
  const missingParts = translationParts.map(part => ({ ...part }));
  delete missingParts[0][Object.keys(missingParts[0])[0]];
  assert.throws(() => buildRom({ ...input, translationParts: missingParts }), /Missing/);
});