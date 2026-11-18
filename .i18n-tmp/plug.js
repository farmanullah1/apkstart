// Order-preserving translation plug-in.
// node .i18n-tmp/plug.js <target file> <english lines file>
// Each English line replaces the next Chinese line of the target, keeping indentation.
const fs = require('fs');

const [target, enFile] = process.argv.slice(2);
if (!target || !enFile) {
  console.error('usage: node .i18n-tmp/plug.js <targetFile> <englishFile>');
  process.exit(1);
}

const re = /[\u4e00-\u9fff]/;
const rawTarget = fs.readFileSync(target, 'utf8');
const hasCRLF = rawTarget.includes('\r\n');
const eol = hasCRLF ? '\r\n' : '\n';
const hadBOM = rawTarget.charCodeAt(0) === 0xfeff;
const lines = (hadBOM ? rawTarget.slice(1) : rawTarget).split(eol);

let rawEn = fs.readFileSync(enFile, 'utf8');
if (rawEn.charCodeAt(0) === 0xfeff) rawEn = rawEn.slice(1);
const en = rawEn.split(/\r?\n/);
while (en.length && en[en.length - 1].trim() === '') en.pop();

const zhIndexes = [];
lines.forEach((line, i) => {
  if (re.test(line)) zhIndexes.push(i);
});

if (zhIndexes.length !== en.length) {
  console.error('COUNT MISMATCH: chinese lines = ' + zhIndexes.length + ', english lines = ' + en.length);
  process.exit(2);
}

zhIndexes.forEach((lineIdx, k) => {
  const original = lines[lineIdx];
  const indent = original.slice(0, original.length - original.trimStart().length);
  lines[lineIdx] = indent + en[k].trim();
});

fs.writeFileSync(target, (hadBOM ? '\ufeff' : '') + lines.join(eol), 'utf8');
console.log('plugged ' + en.length + ' lines into ' + target);
