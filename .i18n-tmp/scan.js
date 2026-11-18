// Reports how much Chinese remains in each in-scope source file.
const fs = require('fs');
const path = require('path');

const re = /[\u4e00-\u9fff]/;
const exts = new Set(['.js', '.mjs', '.html', '.css', '.ps1', '.md', '.yml', '.yaml', '.nsi', '.nsh']);
const skipDirs = new Set(['node_modules', '.git', 'dist', 'assets', 'images', 'store-assets', 'store-shots', 'promo']);

const rows = [];
(function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!exts.has(path.extname(entry.name))) continue;
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch (e) {
      continue;
    }
    const count = text.split('\n').filter((l) => re.test(l)).length;
    if (count) rows.push([count, full.split(path.sep).join('/')]);
  }
})('.');

rows.sort((a, b) => b[0] - a[0]);
for (const row of rows) console.log(String(row[0]).padStart(5), row[1]);
console.log('TOTAL FILES:', rows.length, 'TOTAL LINES:', rows.reduce((sum, r) => sum + r[0], 0));
