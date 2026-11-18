const fs = require('fs');

let download = fs.readFileSync('src/core/download.js', 'utf8');

const pairs = [
  ["finish(new Error('连接停滞（长时间无数据）'))", "finish(new Error('Connection stalled (no data received)'))"],
  ["throw new Error('服务器返回了不匹配的分块范围');", "throw new Error('Server returned mismatched chunk range');"],
  ["return finish(new Error('分块响应超出请求范围'));", "return finish(new Error('Chunk response exceeded requested range'));"],
  ["res.on('close', () => finish(new Error('连接被中断')));", "res.on('close', () => finish(new Error('Connection interrupted')));"],
  ["throw new Error('分块未完整返回');", "throw new Error('Chunk response incomplete');"],
  ["throw new Error(`下载不完整：${size}/${total} 字节`);", "throw new Error(`Download incomplete: ${size}/${total} bytes`);"],
  ["throw new Error(`所有下载源均失败：\\n${errors.join('\\n')}`);", "throw new Error(`All download sources failed:\\n${errors.join('\\n')}`);"],
];

for (const [f, r] of pairs) {
  download = download.split(f).join(r);
}

fs.writeFileSync('src/core/download.js', download, 'utf8');
console.log('download.js completely clean');
