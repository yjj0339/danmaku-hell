const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .replace('<link rel="stylesheet" href="style.css">', `<style>${fs.readFileSync(path.join(root, 'style.css'), 'utf8')}</style>`)
  .replace('<link rel="stylesheet" href="responsive.css">', `<style>${fs.readFileSync(path.join(root, 'responsive.css'), 'utf8')}</style>`)
  .replace('<script src="game.js"></script>', `<script>${fs.readFileSync(path.join(root, 'game.js'), 'utf8')}</script>`);
fs.writeFileSync(path.join(root, '弹幕地狱.html'), html);
console.log('已生成离线单文件：弹幕地狱.html');
