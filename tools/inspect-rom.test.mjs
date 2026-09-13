import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRom, parseScript, scanText, extractScripts, SCRIPT_START, SCRIPT_TABLE } from './inspect-rom.mjs';

test('scanner finds text ending in a control code and aligned pointers', () => {
  const text = Buffer.from('82b182f182c982bf82cd814282c582b78142', 'hex');
  for (const ending of [0, 1, 2, 5]) {
    const sample = Buffer.concat([Buffer.from('20000008', 'hex'), Buffer.alloc(28), text, Buffer.from([ending])]);
    const candidates = scanText(sample);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].byteLength, text.length);
    assert.equal(candidates[0].followingByte, ending);
    assert.deepEqual(candidates[0].references, [0]);
  }
});

test('parser separates script commands from double-byte text', () => {
  const sample = Buffer.from('6040f0000043f0000031030001835a815b837582b582dc82b782a981480509814082cd814050000000', 'hex');
  const tokens = parseScript(sample, 0, sample.length);
  assert.equal(tokens.filter(token => token.type === 'text').length, 2);
  assert.ok(tokens.some(token => token.type === 'command' && token.hex === '50'));
  assert.deepEqual(Buffer.concat(tokens.map(token => Buffer.from(token.hex, 'hex'))), sample);
});

test('parser preserves custom glyph codes and rejects unknown or truncated input', () => {
  const sample = Buffer.from('854000', 'hex');
  const tokens = parseScript(sample, 0, sample.length);
  assert.deepEqual(tokens[0].customCodes, ['8540']);
  assert.throws(() => parseScript(Buffer.from([0x10]), 0, 1), /Unknown script byte/);
  assert.throws(() => parseScript(Buffer.from([0xf0, 0]), 0, 2), /Truncated command/);
  assert.throws(() => parseScript(Buffer.from([0x82]), 0, 1), /Unknown script byte/);
});

test('verified ROM scripts round-trip without changing any bytes', () => {
  const rom = loadRom('assets/Super Real Mahjong Dousoukai (Japan).zip');
  const scripts = extractScripts(rom);
  const reconstructed = Buffer.concat(scripts.flatMap(script => script.tokens.map(token => Buffer.from(token.hex, 'hex'))));
  assert.deepEqual(reconstructed, rom.subarray(SCRIPT_START, SCRIPT_TABLE));
  assert.ok(scripts.length > 10);
  const texts = scripts.flatMap(script => script.tokens.filter(token => token.type === 'text'));
  assert.ok(texts.length > 2000);
  console.log(`Extracted ${scripts.length} scripts and ${texts.length} text spans.`);
  const modified = Buffer.from(rom);
  modified[0] ^= 1;
  assert.throws(() => extractScripts(modified), /verified BDMJ/);
});