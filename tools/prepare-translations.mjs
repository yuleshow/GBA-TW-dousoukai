import { mkdirSync, writeFileSync } from 'node:fs';
import { extractScripts, loadRom } from './inspect-rom.mjs';

const scripts = extractScripts(loadRom('assets/Super Real Mahjong Dousoukai (Japan).zip'));
mkdirSync('work', { recursive: true });
mkdirSync('translations', { recursive: true });
for (let part = 0; part < 4; part++) {
  const start = part * 66;
  const source = scripts.slice(start, start + 66).map((script, index) => ({
    script: start + index,
    entries: script.tokens.filter(token => token.type === 'text').map(token => [
      token.offset.toString(16), token.hex.length / 4, token.source,
    ]),
  }));
  writeFileSync(`work/source-${part + 1}.json`, JSON.stringify(source) + '\n', { flag: 'wx' });
  const required = source.flatMap(script => script.entries).filter(entry => !/^[\p{P}\p{S}\p{Z}\p{N}]*$/u.test(entry[2]));
  console.log(`Part ${part + 1}: ${source.length} scripts; ${required.length} entries require translation.`);
}