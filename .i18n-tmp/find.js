const fs = require('fs');
const file = process.argv[2];
const content = fs.readFileSync(file, 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (/[\u4e00-\u9fff]/.test(line)) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
