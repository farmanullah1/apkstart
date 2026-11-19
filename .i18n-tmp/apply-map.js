'use strict';
/**
 * Apply a line->text translation map to a source file.
 * Usage: node apply-map.js <file> <mapFile.json>
 * The map is { "lineNumber": "new full line content" }.
 * Each target line must currently contain Han characters; otherwise abort.
 */
const fs = require('fs');

const [file, mapFile] = process.argv.slice(2);
const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
const raw = fs.readFileSync(file, 'utf8');
const crlf = raw.includes('\r\n');
const lines = raw.split(/\r?\n/);

let applied = 0;
for (const [k, value] of Object.entries(map)) {
  const i = Number(k) - 1;
  const old = lines[i];
  if (old === undefined) throw new Error(`${file}: line ${k} does not exist`);
  if (!/[\u4e00-\u9fff]/.test(old)) {
    throw new Error(`${file}:${k} has no Han characters, refusing to overwrite:\n${old}`);
  }
  lines[i] = value;
  applied += 1;
}

fs.writeFileSync(file, lines.join(crlf ? '\r\n' : '\n'), 'utf8');
console.log(`applied ${applied} lines to ${file}`);
