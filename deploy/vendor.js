'use strict';
// 将 three.js / socket.io 客户端库复制到 public/js，保证游戏完全自包含（不依赖外网 CDN）
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const copies = [
  ['node_modules/three/build/three.module.min.js', 'public/js/three.module.min.js'],
  ['node_modules/socket.io/client-dist/socket.io.min.js', 'public/js/socket.io.min.js'],
];

for (const [src, dst] of copies) {
  const s = path.join(root, src);
  const d = path.join(root, dst);
  if (!fs.existsSync(s)) {
    console.error('MISSING ' + s + ' — 请先运行 npm install');
    process.exit(1);
  }
  fs.copyFileSync(s, d);
  console.log('vendored -> ' + dst + ' (' + (fs.statSync(d).size / 1024).toFixed(0) + ' KB)');
}
console.log('done');
