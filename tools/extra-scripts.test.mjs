import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadRom, parseScript } from './inspect-rom.mjs';
import { collectTranslations, encodeText, needsTranslation, originalCharacterMap } from './build-rom.mjs';
import { FIRST_NEW_INDEX, originalGlyphCount, sjisCode } from './font.mjs';
import { extractExtraScripts, YAKU_TABLE_START, YAKU_TABLE_END } from './extra-scripts.mjs';

const rom = loadRom('work/Super Real Mahjong Dousoukai (Japan).gba');

test('additional scripts round-trip and include the runtime opening', () => {
  const scripts = extractExtraScripts(rom);
  assert.equal(scripts.length, 50);
  for (const script of scripts) {
    assert.deepEqual(Buffer.concat(script.tokens.map(token => Buffer.from(token.hex, 'hex'))),
      rom.subarray(script.offset, script.end));
    assert.equal(script.tokens.at(-1).hex, '00');
    assert.equal(script.tokens.filter(token => token.hex === '00').length, 1);
    if (script.pointerOffset !== undefined) {
      assert.equal(rom.readUInt32LE(script.pointerOffset), 0x08000000 + script.offset);
    }
  }
  assert.ok(scripts.flatMap(script => script.tokens).some(token =>
    token.offset <= 0x21e56d && token.offset + token.hex.length / 2 > 0x21e56d
      && token.source === '「リアル麻雀に出演した女の子達の'));
});

test('yaku pointer table is complete despite descending string addresses', () => {
  const yaku = extractExtraScripts(rom).filter(script =>
    script.pointerOffset >= YAKU_TABLE_START && script.pointerOffset < YAKU_TABLE_END);
  assert.equal(yaku.length, 39);
  assert.deepEqual(yaku.map(script => script.pointerOffset).sort((left, right) => left - right),
    Array.from({ length: 39 }, (_, index) => YAKU_TABLE_START + index * 4));
  assert.equal(yaku[0].tokens[0].source, '流し満貫');
  assert.equal(yaku.at(-1).tokens[0].source, 'なし');
});

test('extraction excludes pointer data, alignment padding and inactive opening drafts', () => {
  const scripts = extractExtraScripts(rom);
  for (let index = 1; index < scripts.length; index++) {
    assert.ok(scripts[index - 1].end <= scripts[index].offset);
  }
  for (const [start, end] of [[0x21927b, 0x21e564], [0x21e753, 0x21e8e4], [0x21e9be, 0x21ea8c]]) {
    assert.ok(scripts.every(script => script.end <= start || script.offset >= end));
  }
});

test('every required span has a bounded Traditional Chinese translation', () => {
  const texts = extractExtraScripts(rom).flatMap(script => script.tokens.filter(token => token.type === 'text'));
  const translations = JSON.parse(readFileSync(new URL('../translations/extra.json', import.meta.url), 'utf8'));
  assert.equal(texts.length, 127);
  assert.equal(texts.filter(token => needsTranslation(token.source)).length, 111);
  assert.equal(collectTranslations([translations], texts).size, 111);
  for (const token of texts.filter(token => needsTranslation(token.source))) {
    const target = translations[token.offset.toString(16)];
    assert.ok(target.length > 0 && target.length <= token.hex.length / 4, token.offset.toString(16));
    assert.doesNotMatch(target, /[\u0000-\u007f\u3040-\u30ff\uff65-\uff9f]/u);
    for (const symbol of ['〒', '∀', '♭', '♯', '♪']) {
      assert.equal([...target].filter(char => char === symbol).length,
        [...token.source].filter(char => char === symbol).length);
    }
  }
});

test('translated scripts round-trip with the missing static-source Han mapping supplied', () => {
  const scripts = extractExtraScripts(rom);
  const translations = JSON.parse(readFileSync(new URL('../translations/extra.json', import.meta.url), 'utf8'));
  const originalMap = originalCharacterMap(rom, originalGlyphCount(rom));
  const han = [...new Set(Object.values(translations).join('').match(/\p{Script=Han}/gu))];
  const mapping = new Map(han.map((char, index) => [char, sjisCode(FIRST_NEW_INDEX + index)]));
  const decodedMapping = new Map([...mapping].map(([char, code]) => [code, char]));
  const missingCodes = new Set();
  for (const token of scripts.flatMap(script => script.tokens).filter(token => token.type === 'text')) {
    const bytes = Buffer.from(token.hex, 'hex');
    for (let index = 0; index < bytes.length; index += 2) {
      const code = bytes.readUInt16BE(index);
      if (!originalMap.byCode.has(code)) missingCodes.add(code);
    }
  }
  assert.deepEqual([...missingCodes], [0x9ec8]);
  const staticToken = scripts.find(script => script.offset === 0x48698).tokens[0];
  assert.throws(() => encodeText(translations['48698'], staticToken, mapping, originalMap), /unavailable glyph 0x9ec8/);
  const missingHan = new TextDecoder('shift_jis', { fatal: true }).decode(Buffer.from('9ec8', 'hex'));
  assert.equal(missingHan, '槓');
  originalMap.byCode.set(0x9ec8, missingHan);
  const modified = Buffer.from(rom);
  for (const script of scripts) {
    for (const token of script.tokens) {
      const target = translations[token.offset.toString(16)];
      if (target === undefined) continue;
      const { bytes, paddingGlyphs } = encodeText(target, token, mapping, originalMap);
      const decoded = Array.from({ length: bytes.length / 2 }, (_, index) => {
        const code = bytes.readUInt16BE(index * 2);
        return decodedMapping.get(code) ?? originalMap.byCode.get(code);
      }).join('');
      assert.equal(decoded, target + '　'.repeat(paddingGlyphs));
      bytes.copy(modified, token.offset);
    }
    if (script.pointerOffset !== undefined) {
      assert.equal(modified.readUInt32LE(script.pointerOffset), rom.readUInt32LE(script.pointerOffset));
    }
    const rebuilt = parseScript(modified, script.offset, script.end);
    assert.equal(rebuilt.length, script.tokens.length);
    for (const [index, token] of script.tokens.entries()) {
      assert.equal(rebuilt[index].type, token.type);
      assert.equal(rebuilt[index].offset, token.offset);
      assert.equal(rebuilt[index].hex.length, token.hex.length);
      if (token.type === 'command' || !needsTranslation(token.source)) {
        assert.equal(rebuilt[index].hex, token.hex);
      }
    }
  }
});

test('extra extraction rejects an unverified or truncated ROM', () => {
  const modified = Buffer.from(rom);
  modified[0] ^= 1;
  assert.throws(() => extractExtraScripts(modified), /verified BDMJ/);
  assert.throws(() => extractExtraScripts(rom.subarray(0, 0x21e564)), /verified BDMJ/);
});