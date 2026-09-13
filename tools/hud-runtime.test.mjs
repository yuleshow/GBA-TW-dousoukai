import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { decodeTiles4bpp, uiResources } from './localize-ui.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = 'work/mahjong-ui/';
const originalPath = 'work/Super Real Mahjong Dousoukai (Japan).gba';
const translatedPath = 'build/dousoukai-zh-Hant.gba';
const digest = data => createHash('sha256').update(data).digest('hex');
const read = path => readFileSync(new URL(`../${path}`, import.meta.url));
const write = (path, data) => writeFileSync(new URL(`../${directory}${path}`, import.meta.url), data);
const execute = (command, args) => execFileSync(command, args, { cwd: root, timeout: 120000 });

test('mGBA executes the real HUD loader and distinguishes stale Japanese VRAM from translated ROM data',
  { skip: process.env.MGBA_HUD_VERIFY !== '1' }, () => {
    const original = read(originalPath);
    const translated = read(translatedPath);
    const inputState = read(`${directory}hud-current.state`);
    for (const [start, end] of [[0x1617c, 0x162a0], [0x1856c, 0x18610], [0x3d38, 0x3e7c]]) {
      assert.deepEqual(translated.subarray(start, end), original.subarray(start, end), 'HUD code must be unmodified');
    }
    const descriptors = [];
    for (let offset = 0x21b2b8; original.readInt32LE(offset) !== -1; offset += 20) {
      assert.ok(offset < 0x21b500, 'Missing table terminator');
      descriptors.push({ offset, values: Array.from({ length: 5 }, (_, index) => original.readUInt32LE(offset + index * 4)) });
    }
    const player = descriptors.find(entry => entry.values[3] === 0 && entry.values[4] === 68);
    assert.ok(player);
    assert.equal(player.values[0], 2);
    assert.equal(0x10000 + (player.values[1] + player.values[2] * 32) * 32, 0x13a80);
    assert.deepEqual(translated.subarray(0x21b2b8, player.offset + 20), original.subarray(0x21b2b8, player.offset + 20));
    execute('/usr/bin/clang', ['-Wall', '-Wextra', '-Werror', '-isysroot',
      '/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk', '-I/opt/homebrew/opt/mgba/include',
      `${directory}hud-probe.c`, '-L/opt/homebrew/opt/mgba/lib', '-lmgba', '-o', `${directory}hud-probe`]);
    const disassembly = [[0x1617c, 0x162a0], [0x1856c, 0x18610], [0x3d38, 0x3e7c]].map(([start, end]) =>
      execute('/opt/devkitpro/devkitARM/bin/arm-none-eabi-objdump', ['-D', '-b', 'binary', '-m', 'arm', '-M', 'force-thumb',
        `--start-address=${start}`, `--stop-address=${end}`, originalPath]).toString()).join('\n');
    write('hud-loader-disassembly.txt', disassembly);
    const cases = [
      { name: 'yuu-reloaded-ja', rom: originalPath, state: 'hud-current', reload: true, expected: original },
      { name: 'yuu-reloaded-zh', rom: translatedPath, state: 'hud-current', reload: true, expected: translated },
      { name: 'yuu-stale-state-zh', rom: translatedPath, state: 'yuu-reloaded-ja', reload: false, expected: original },
      { name: 'yuu-recovered-zh', rom: translatedPath, state: 'yuu-reloaded-ja', reload: true, expected: translated },
    ];
    const results = [];
    for (const scenario of cases) {
      const prefix = `${directory}${scenario.name}`;
      const log = execute(`${directory}hud-probe`, [scenario.rom, prefix, `resume=${directory}${scenario.state}.state`,
        ...(scenario.reload ? ['reload-hud-test-only=4'] : []), '3:0']).toString();
      write(`${scenario.name}.log`, log);
      if (scenario.reload) {
        assert.match(log, /IMG pc=08003d38 lr=0801620b dst=00013a80 package=0 resource=68 mode=1/);
        assert.match(log, /IMG pc=08003d38 lr=0801628d dst=00013b40 package=0 resource=74 mode=1/);
        assert.match(log, /IMG resolved ROM=0827e614/);
        assert.match(log, /IMG resolved ROM=0827e924/);
        assert.match(log, /return instructions=\d+ nameLoads=2/);
      }
      const memory = read(`${prefix}.memory`);
      const resources = uiResources(scenario.expected, 0);
      const rgb = execute('magick', [`${prefix}.png`, '-depth', '8', 'rgb:-']);
      assert.equal(rgb.length, 240 * 160 * 3);
      const labels = [];
      for (const [resourceId, destination, left, top, tileBase] of [[68, 0x13a80, 4, 89, 468], [74, 0x13b40, 4, 71, 474]]) {
        const offset = resources[resourceId].offset;
        const width = scenario.expected[offset + 5] * 8;
        const length = width * 4;
        const expected = scenario.expected.subarray(offset + 8, offset + 8 + length);
        const actual = memory.subarray(0x48800 + destination, 0x48800 + destination + length);
        assert.deepEqual(actual, expected, `${scenario.name}: ROM resource ${resourceId} must equal VRAM`);
        const other = scenario.expected === original ? translated : original;
        assert.notDeepEqual(actual, other.subarray(offset + 8, offset + 8 + length));
        const sprites = [];
        for (let index = 0; index < 128; index++) {
          const entry = 0x60800 + index * 8;
          const attr0 = memory.readUInt16LE(entry);
          const attr1 = memory.readUInt16LE(entry + 2);
          const attr2 = memory.readUInt16LE(entry + 4);
          if ((attr2 & 1023) !== tileBase) continue;
          assert.equal(attr0 & 255, top);
          assert.equal(attr1 & 511, left);
          assert.equal(attr0 & 0xe300, 0x4000, 'Visible non-affine 4bpp horizontal OBJ');
          assert.equal(attr1 & 0xf000, 0x4000, '32x8 OBJ, no flips');
          assert.equal(attr2 >>> 12, 3);
          sprites.push(index);
        }
        assert.equal(sprites.length, 1, 'Expected exactly one visible name OBJ');
        const paletteColor = memory.readUInt16LE(0x48400 + 0x200 + 3 * 32 + 15 * 2);
        const inkRgb = [paletteColor & 31, paletteColor >>> 5 & 31, paletteColor >>> 10 & 31].map(value => value << 3 | value >>> 2);
        const pixels = decodeTiles4bpp(expected, width, 8);
        let inkPixels = 0;
        for (let row = 0; row < 8; row++) for (let column = 0; column < width; column++) {
          const pixel = (top + row) * 240 + left + column;
          const screen = [...rgb.subarray(pixel * 3, pixel * 3 + 3)];
          if (pixels[row * width + column] === 15) {
            assert.deepEqual(screen, inkRgb, `${scenario.name}: resource ${resourceId} screen pixel ${column},${row}`);
            inkPixels++;
          } else assert.notDeepEqual(screen, inkRgb, 'No extra name ink may remain');
        }
        assert.ok(inkPixels > 0);
        labels.push({ resourceId, romAddress: `0x${(0x08000000 + offset).toString(16)}`,
          vramAddress: `0x${(0x06000000 + destination).toString(16)}`, bytes: length,
          sha256: digest(actual), inkPixels, verifiedScreenPixels: width * 8, oamEntries: sprites });
      }
      execute('magick', [`${prefix}.png`, '-crop', '64x48+0+64', '+repage', '-filter', 'point', '-resize', '600%', `${prefix}-hud.png`]);
      results.push({ name: scenario.name, romSha256: digest(read(scenario.rom)), testOnlyReload: scenario.reload,
        expectedLanguage: scenario.expected === original ? 'Japanese' : 'Traditional Chinese', screenshot: `${scenario.name}.png`, labels });
    }
    assert.deepEqual(read(originalPath), original);
    assert.deepEqual(read(translatedPath), translated);
    assert.deepEqual(read(`${directory}hud-current.state`), inputState);
    write('hud-runtime-proof.json', `${JSON.stringify({
      method: 'TEST-ONLY character index 4 + CPU call to unmodified ROM function 0x0801623c; no ROM or VRAM pixel injection',
      limitation: 'Existing Miki match state, not a naturally reached Yuu match; full-scene background/portrait mismatch is outside this HUD-only assertion.',
      inputStateSha256: digest(inputState), playerDescriptor: player,
      characterAddress: '0x0203968c', characterIndex: 4, resourceFormula: '70 + characterIndex',
      classification: 'Current build has no missing 68/74 HUD load path. Stale savestate reproduces Japanese HUD; historical user screenshot cannot identify ROM/state without their hashes.',
      results,
    }, null, 2)}\n`);
  });