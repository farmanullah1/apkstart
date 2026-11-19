'use strict';
/**
 * Resolve leftover merge conflicts by keeping the "ours" (HEAD / local) side.
 * Usage: node resolve-ours.js <file...>
 * Removes <<<<<<< ... (ours) ======= ... (theirs) >>>>>>> blocks, keeping ours.
 */
const fs = require('fs');

function resolve(text) {
  const lines = text.split('\n');
  const out = [];
  let state = 'normal';
  let changed = 0;
  for (const line of lines) {
    if (state === 'normal' && /^<<<<<<< /.test(line)) { state = 'ours'; changed += 1; continue; }
    if (state === 'ours' && /^\|\|\|\|\|\|\| /.test(line)) { state = 'base'; continue; }
    if (state === 'ours' && /^=======$/.test(line)) { state = 'theirs'; continue; }
    if (state === 'base' && /^=======$/.test(line)) { state = 'theirs'; continue; }
    if (state === 'theirs' && /^>>>>>>> /.test(line)) { state = 'normal'; continue; }
    if (state === 'normal' || state === 'ours') out.push(line);
  }
  return { text: out.join('\n'), changed };
}

let total = 0;
for (const file of process.argv.slice(2)) {
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.includes('<<<<<<<')) continue;
  const { text, changed } = resolve(raw);
  fs.writeFileSync(file, text, 'utf8');
  total += changed;
  console.log(`${file}: resolved ${changed} conflict(s)`);
}
console.log(`total conflicts resolved: ${total}`);
