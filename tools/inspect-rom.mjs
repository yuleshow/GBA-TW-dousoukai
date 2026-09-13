import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ROM_SHA256 = '1402fab850ff3cc0b8b25aef1b9673d1e9dc08149ee3be914959ecd1c761e0d5';
export const SCRIPT_START = 0x205458;
export const SCRIPT_TABLE = 0x218b74;
const commandLengths = new Map([
  [0x00, 1], [0x01, 1], [0x02, 1], [0x03, 3], [0x04, 1],
  [0x05, 1], [0x06, 4], [0x07, 1], [0x08, 2], [0x09, 1],
  [0x12, 1], [0x20, 2], [0x21, 1], [0x30, 3], [0x31, 1],
  [0x40, 1], [0x41, 1], [0x42, 2], [0x43, 1], [0x50, 1],
  [0x51, 1], [0x60, 1], [0xf0, 3],
]);

function isDoubleByte(lead, trail) {
  return (lead >= 0x81 && lead <= 0x9f || lead >= 0xe0 && lead <= 0xef)
    && (trail >= 0x40 && trail <= 0x7e || trail >= 0x80 && trail <= 0xfc);
}

export function parseScript(rom, start, end) {
  const decoder = new TextDecoder('shift_jis', { fatal: true });
  const tokens = [];
  let offset = start;
  while (offset < end) {
    const tokenStart = offset;
    const commandLength = commandLengths.get(rom[offset]);
    if (commandLength !== undefined) {
      if (offset + commandLength > end) throw new Error(`Truncated command at 0x${offset.toString(16)}`);
      offset += commandLength;
      tokens.push({ type: 'command', offset: tokenStart, hex: rom.subarray(tokenStart, offset).toString('hex') });
      continue;
    }
    let source = '';
    const customCodes = [];
    while (offset + 1 < end && isDoubleByte(rom[offset], rom[offset + 1])) {
      const pair = rom.subarray(offset, offset + 2);
      try {
        source += decoder.decode(pair);
      } catch {
        const code = pair.toString('hex');
        customCodes.push(code);
        source += `<SJIS:${code}>`;
      }
      offset += 2;
    }
    if (offset === tokenStart) throw new Error(`Unknown script byte 0x${rom[offset].toString(16)} at 0x${offset.toString(16)}`);
    tokens.push({
      type: 'text', offset: tokenStart, hex: rom.subarray(tokenStart, offset).toString('hex'),
      source, target: null, customCodes,
    });
  }
  return tokens;
}

export function extractScripts(rom) {
  if (createHash('sha256').update(rom).digest('hex') !== ROM_SHA256) {
    throw new Error('Script extraction requires the verified BDMJ revision 0 ROM.');
  }
  const starts = [];
  for (let offset = SCRIPT_TABLE; offset + 4 <= rom.length; offset += 4) {
    const target = rom.readUInt32LE(offset) - 0x08000000;
    if (target < SCRIPT_START || target >= SCRIPT_TABLE) break;
    starts.push({ offset: target, pointerOffset: offset });
  }
  if (starts[0]?.offset !== SCRIPT_START) throw new Error('Unexpected script table start.');
  return starts.map((entry, index) => {
    const end = starts[index + 1]?.offset ?? SCRIPT_TABLE;
    if (end <= entry.offset) throw new Error('Script pointers are not strictly increasing.');
    return { ...entry, end, tokens: parseScript(rom, entry.offset, end) };
  });
}

export function loadRom(path) {
  if (!path.endsWith('.zip')) return readFileSync(path);
  const entries = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' })
    .trim().split('\n').filter(entry => entry.toLowerCase().endsWith('.gba'));
  if (entries.length !== 1) throw new Error('Expected exactly one GBA ROM in the ZIP.');
  return execFileSync('unzip', ['-p', path, entries[0]], { maxBuffer: 64 * 1024 * 1024 });
}

export function scanText(rom) {
  const decoder = new TextDecoder('shift_jis', { fatal: true });
  const candidates = [];
  let offset = 0;
  while (offset < rom.length) {
    const start = offset;
    while (offset < rom.length) {
      const lead = rom[offset];
      const trail = rom[offset + 1];
        if (isDoubleByte(lead, trail)) {
        offset += 2;
      } else if (lead >= 0x20 && lead <= 0x7e || lead === 0x0a || lead === 0x0d) {
        offset++;
      } else {
        break;
      }
    }
    if (offset - start >= 12) {
      try {
        const source = decoder.decode(rom.subarray(start, offset));
        const kana = source.match(/[\u3041-\u3096\u30a1-\u30fa]/g) ?? [];
        const japanese = source.match(/[\u3000-\u30ff\u3400-\u9fff\uff01-\uff60]/g) ?? [];
        if (kana.length >= 2 && japanese.length >= source.length * 0.6) {
          candidates.push({
            offset: start,
            byteLength: offset - start,
            source,
            followingByte: rom[offset] ?? null,
            references: [],
          });
        }
      } catch {}
    }
    offset++;
  }
  const byOffset = new Map(candidates.map(candidate => [candidate.offset, candidate]));
  for (let pointerOffset = 0; pointerOffset + 4 <= rom.length; pointerOffset += 4) {
    const target = rom.readUInt32LE(pointerOffset) - 0x08000000;
    byOffset.get(target)?.references.push(pointerOffset);
  }
  return candidates;
}

export function inspectRom(rom) {
  if (rom.length < 0xc0 || rom[0xb2] !== 0x96) throw new Error('Invalid GBA header.');
  const sha256 = createHash('sha256').update(rom).digest('hex');
  return {
    title: rom.toString('ascii', 0xa0, 0xac),
    gameCode: rom.toString('ascii', 0xac, 0xb0),
    revision: rom[0xbc],
    size: rom.length,
    sha256,
    encodingHypothesis: 'Shift-JIS; candidates require manual verification',
    candidates: scanText(rom),
    scripts: sha256 === ROM_SHA256 ? extractScripts(rom) : null,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = process.argv[2] ?? 'assets/Super Real Mahjong Dousoukai (Japan).zip';
  const report = inspectRom(loadRom(input));
  const output = JSON.stringify(report, null, 2) + '\n';
  if (process.argv[3]) writeFileSync(process.argv[3], output, { flag: 'wx' });
  else process.stdout.write(output);
}