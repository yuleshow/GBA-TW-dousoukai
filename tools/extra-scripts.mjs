import { createHash } from 'node:crypto';
import { ROM_SHA256, parseScript } from './inspect-rom.mjs';

export const EXTRA_SCRIPT_START = 0x218f94;
export const EXTRA_SCRIPT_END = 0x21ea8c;
export const YAKU_TABLE_START = 0x21b02c;
export const YAKU_TABLE_END = 0x21b0c8;
export const EXTRA_SCRIPT_REGIONS = [
  { offset: 0x48610, end: 0x4861d, pointerOffset: 0x1226c, kind: 'dummy' },
  { offset: 0x218f94, end: 0x219110, kind: 'sample' },
  { offset: 0x219114, end: 0x21927b, kind: 'sample' },
  { offset: 0x21e564, end: 0x21e753, pointerOffset: 0x1c2f0, kind: 'opening' },
  { offset: 0x21e8e4, end: 0x21e9be, pointerOffset: 0x1c1dc, kind: 'opening' },
  { offset: 0x2206c8, end: 0x2206ef, pointerOffset: 0x21a90, kind: 'engine-test' },
  { offset: 0x2206f0, end: 0x220715, pointerOffset: 0x21d08, kind: 'engine-test' },
  { offset: 0x220718, end: 0x22078c, pointerOffset: 0x21b34, kind: 'engine-test' },
  { offset: 0x222f3c, end: 0x222f63, pointerOffset: 0x2f318, kind: 'engine-test' },
  { offset: 0x222f64, end: 0x222f89, pointerOffset: 0x2f594, kind: 'engine-test' },
  { offset: 0x222f8c, end: 0x223000, pointerOffset: 0x2f3cc, kind: 'engine-test' },
];

export function extractExtraScripts(rom) {
  if (createHash('sha256').update(rom).digest('hex') !== ROM_SHA256) {
    throw new Error('Extra script extraction requires the verified BDMJ revision 0 ROM.');
  }
  const regions = [...EXTRA_SCRIPT_REGIONS];
  for (let pointerOffset = YAKU_TABLE_START; pointerOffset < YAKU_TABLE_END; pointerOffset += 4) {
    const offset = rom.readUInt32LE(pointerOffset) - 0x08000000;
    if (offset < 0x48638 || offset >= 0x487ad) throw new Error('Unexpected yaku text pointer.');
    const end = rom.indexOf(0, offset) + 1;
    if (end <= offset || end > 0x487ad) throw new Error('Unterminated yaku text.');
    regions.push({ offset, end, pointerOffset, kind: 'yaku' });
  }

  return regions.sort((left, right) => left.offset - right.offset).map(({ offset, end, pointerOffset }) => {
    if (pointerOffset !== undefined && rom.readUInt32LE(pointerOffset) !== offset + 0x08000000) {
      throw new Error(`Unexpected extra script pointer at 0x${pointerOffset.toString(16)}.`);
    }
    return { offset, end, pointerOffset, tokens: parseScript(rom, offset, end) };
  });
}