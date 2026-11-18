// Applies trimmed-line translation maps to source files, preserving indentation,
// line endings and encoding.
//
// Usage: node .i18n-tmp/apply.js <mapFile.js>
// Map file exports: [{ file: 'path', pairs: [['zh line (trimmed)', 'en line (trimmed)'], ...] }]
const fs = require('fs');

const mapPath = process.argv[2];
if (!mapPath) {
  console.error('usage: node .i18n-tmp/apply.js <mapFile.js>');
  process.exit(1);
}

const groups = require(require('path').resolve(mapPath));

let totalApplied = 0;
const misses = [];

for (const group of groups) {
  const raw = fs.readFileSync(group.file, 'utf8');
  const hasCRLF = raw.includes('\r\n');
  const eol = hasCRLF ? '\r\n' : '\n';
  const hadBOM = raw.charCodeAt(0) === 0xfeff;
  const body = hadBOM ? raw.slice(1) : raw;

  const lookup = new Map();
  for (const [zh, en] of group.pairs) lookup.set(zh.trim(), en.trim());

  const used = new Set();
  const lines = body.split(eol).map((line) => {
    const trimmed = line.trim();
    if (!lookup.has(trimmed)) return line;
    const indent = line.slice(0, line.length - line.trimStart().length);
    used.add(trimmed);
    return indent + lookup.get(trimmed);
  });

  for (const [zh] of group.pairs) if (!used.has(zh.trim())) misses.push(group.file + ' :: ' + zh.trim());

  const out = (hadBOM ? '\ufeff' : '') + lines.join(eol);
  fs.writeFileSync(group.file, out, 'utf8');
  totalApplied += used.size;
  console.log('patched ' + group.file + ' (' + used.size + '/' + group.pairs.length + ' keys)');
}

console.log('total keys applied: ' + totalApplied);
if (misses.length) {
  console.log('--- unmatched keys (' + misses.length + ') ---');
  for (const m of misses) console.log(m);
}
