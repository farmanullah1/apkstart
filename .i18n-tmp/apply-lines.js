#!/usr/bin/env node
'use strict';
// Apply {relativeFile: {"<1-based line>": "<new text>"}} maps, verifying each
// target line still contains Han characters before replacing it.
const fs = require('fs');

const mapPath = process.argv[2];
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const HAN = /[\u4e00-\u9fff]/;
let changed = 0;
const errors = [];

for (const file of Object.keys(map)) {
  const raw = fs.readFileSync(file, 'utf8');
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);
  for (const key of Object.keys(map[file])) {
    const idx = Number(key) - 1;
    const next = map[file][key];
    if (idx < 0 || idx >= lines.length) { errors.push(`${file}:${key} out of range`); continue; }
    if (!HAN.test(lines[idx])) { errors.push(`${file}:${key} has no Han characters (already translated?)`); continue; }
    lines[idx] = next;
    changed++;
  }
  fs.writeFileSync(file, (bom ? '\ufeff' : '') + lines.join(eol), 'utf8');
}

if (errors.length) {
  console.error('ERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('lines replaced:', changed);
