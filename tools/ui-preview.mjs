import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { decodeEcd, decodeTiles4bpp, uiResources } from './localize-ui.mjs';

const [romPath, packageNumber, imageNumber, outputPath, screenNumber] = process.argv.slice(2);
const rom = readFileSync(romPath);
const resources = uiResources(rom, Number(packageNumber));
const resource = resources[Number(imageNumber)];
const image = resource.type === 'ECD' ? decodeEcd(rom.subarray(resource.offset)) : rom.subarray(resource.offset);
let width = image[5] * 8;
let height = image[6] * 8;
let pixels = decodeTiles4bpp(image.subarray(8), width, height);
if (screenNumber !== undefined) {
  const screen = rom.subarray(resources[Number(screenNumber)].offset);
  if (screen.toString('ascii', 0, 3) !== 'SCR') throw new Error('Expected SCR resource');
  const atlas = pixels;
  const atlasWidth = width;
  width = screen[5] * 8;
  height = screen[6] * 8;
  pixels = Buffer.alloc(width * height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const entry = screen.readUInt16LE(8 + (Math.floor(row / 8) * width / 8 + Math.floor(column / 8)) * 2);
      const tile = entry & 1023;
      const sourceX = tile % 32 * 8 + (entry & 1024 ? 7 - column % 8 : column % 8);
      const sourceY = Math.floor(tile / 32) * 8 + (entry & 2048 ? 7 - row % 8 : row % 8);
      pixels[row * width + column] = atlas[sourceY * atlasWidth + sourceX];
    }
  }
}
const grayscale = Buffer.alloc(pixels.length);
for (let index = 0; index < pixels.length; index++) grayscale[index] = pixels[index] * 17;
const result = spawnSync('magick', ['pgm:-', '-filter', 'point', '-resize', '400%', outputPath], {
  input: Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), grayscale]),
});
if (result.status !== 0) throw new Error(result.stderr.toString());