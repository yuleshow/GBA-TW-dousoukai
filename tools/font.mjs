export const RESOURCE_TABLE = 0x205204;
export const RESOURCE_BASE = 0x228664;
export const FONT_POINTER = RESOURCE_BASE + 44 * 4;
export const ORIGINAL_FONT = 0x2596f4;
export const NEXT_RESOURCE = 0x275354;
export const EXPANDED_FONT = 0x800000;
export const GLYPH_BYTES = 26;
export const FIRST_NEW_INDEX = 5264;
export const LAST_NEW_INDEX = 8271;

export function sjisIndex(code) {
  let lead = code >>> 8;
  const trail = code & 255;
  if (!((lead >= 0x81 && lead <= 0x9f) || (lead >= 0xe0 && lead <= 0xef))
    || !((trail >= 0x40 && trail <= 0x7e) || (trail >= 0x80 && trail <= 0xfc))) {
    throw new Error(`Invalid double-byte SJIS code: ${code.toString(16)}`);
  }
  if (lead > 0xdf) lead -= 0x43;
  return (lead - 0x81) * 188 + trail - (trail >= 0x80 ? 1 : 0) - 0x40;
}

export function sjisCode(index) {
  if (!Number.isInteger(index) || index < 0 || index > LAST_NEW_INDEX) {
    throw new Error(`Invalid SJIS index: ${index}`);
  }
  let lead = 0x81 + Math.floor(index / 188);
  if (lead >= 0x9d) lead += 0x43;
  let trail = 0x40 + index % 188;
  if (trail >= 0x7f) trail++;
  return lead * 256 + trail;
}

export function originalGlyphCount(rom) {
  if (rom.readUInt32LE(RESOURCE_TABLE) !== 0x08000000 + RESOURCE_BASE
    || rom.readUInt32LE(FONT_POINTER) !== ORIGINAL_FONT - RESOURCE_BASE) {
    throw new Error('Unexpected resource table or original font pointer');
  }
  let count = 0;
  while (ORIGINAL_FONT + (count + 1) * GLYPH_BYTES <= NEXT_RESOURCE
    && rom.readUInt16BE(ORIGINAL_FONT + count * GLYPH_BYTES) === sjisCode(count)) count++;
  if (count < 4300 || count >= FIRST_NEW_INDEX) {
    throw new Error(`Unexpected original glyph count: ${count}`);
  }
  return count;
}

export function parseBdf(text, fontSize = 12) {
  const lines = text.replace(/\r\n/g, '\n').trimEnd().split('\n');
  const descent = fontSize === 8 ? 1 : 2;
  const ascent = fontSize - descent;
  if (![8, 12].includes(fontSize) || lines[0] !== 'STARTFONT 2.1'
    || !lines.includes(`FONTBOUNDINGBOX ${fontSize} ${fontSize} 0 -${descent}`)
    || !lines.includes(`FONT_ASCENT ${ascent}`) || !lines.includes(`FONT_DESCENT ${descent}`)) {
    throw new Error(`Expected a ${fontSize}px BDF with ascent ${ascent} and descent ${descent}`);
  }
  let cursor = lines.findIndex(line => /^CHARS \d+$/.test(line));
  if (cursor < 0) throw new Error('Missing BDF CHARS');
  const expectedCount = Number(lines[cursor++].slice(6));
  const glyphs = new Map();
  function fields(pattern, label) {
    const match = pattern.exec(lines[cursor++] ?? '');
    if (!match) throw new Error(`Invalid BDF ${label} at line ${cursor}`);
    return match.slice(1).map(Number);
  }
  for (let entry = 0; entry < expectedCount; entry++) {
    fields(/^STARTCHAR \S+$/, 'STARTCHAR');
    const [encoding] = fields(/^ENCODING (-?\d+)$/, 'ENCODING');
    fields(/^SWIDTH \d+ 0$/, 'SWIDTH');
    const [advance] = fields(/^DWIDTH (\d+) 0$/, 'DWIDTH');
    const [width, height, xOffset, yOffset] = fields(/^BBX (\d+) (\d+) (-?\d+) (-?\d+)$/, 'BBX');
    if (encoding < -1 || encoding > 0x10ffff || (encoding >= 0xd800 && encoding <= 0xdfff)
      || glyphs.has(encoding) || width > 32 || height > 32 || advance > 32) {
      throw new Error(`Invalid BDF glyph metadata: ${encoding}`);
    }
    fields(/^BITMAP$/, 'BITMAP');
    const rowBits = Math.ceil(width / 8) * 8;
    const rowPattern = new RegExp(`^[0-9A-Fa-f]{${rowBits / 4}}$`);
    const rows = [];
    for (let row = 0; row < height; row++) {
      const bitmap = lines[cursor++];
      if (!rowPattern.test(bitmap ?? '')) throw new Error(`Invalid BDF bitmap: ${encoding}`);
      const value = Number.parseInt(bitmap, 16) || 0;
      if (value % 2 ** (rowBits - width) !== 0) throw new Error(`Nonzero BDF padding: ${encoding}`);
      rows.push(value);
    }
    fields(/^ENDCHAR$/, 'ENDCHAR');
    glyphs.set(encoding, { width, height, xOffset, yOffset, advance, rowBits, rows, fontSize, ascent });
  }
  if (lines[cursor++] !== 'ENDFONT' || cursor !== lines.length) throw new Error('Invalid BDF ending/count');
  return glyphs;
}

export function rasterizeGlyph(glyph, fontSize = 12) {
  if (!glyph) throw new Error('Missing BDF glyph');
  const { width, height, xOffset, yOffset, advance, rowBits, rows } = glyph;
  const top = (glyph.ascent ?? (fontSize === 8 ? 7 : 10)) - yOffset - height;
  if (![8, 12].includes(fontSize) || (glyph.fontSize !== undefined && glyph.fontSize !== fontSize)
    || advance !== fontSize || width > fontSize || height > fontSize || xOffset < 0 || xOffset + width > fontSize
    || top < 0 || top + height > fontSize) throw new Error(`BDF glyph does not fit the ${fontSize}x${fontSize} renderer cell`);
  const bitmap = Buffer.alloc(fontSize * 2);
  for (let row = 0; row < height; row++) {
    let value = 0;
    for (let column = 0; column < width; column++) {
      if (Math.floor(rows[row] / 2 ** (rowBits - column - 1)) % 2) value |= 0x8000 >>> (xOffset + column);
    }
    bitmap.writeUInt16BE(value, (top + row) * 2);
  }
  if (!bitmap.some(value => value !== 0)) throw new Error('Blank new glyph');
  return bitmap;
}