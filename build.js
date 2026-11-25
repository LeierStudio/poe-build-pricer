'use strict';
// 打包成單一 exe：node build.js → dist/PoE裝備查價/（exe + 使用說明）與 dist/PoE裝備查價.zip
// 使用者不需安裝 Node.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname;
const dist = path.join(root, 'dist');
const APP = 'PoE裝備查價';
const outDir = path.join(dist, APP); // 發給別人的資料夾：exe + 使用說明
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// 簡易打包：把本地模組包進一個檔案，用自訂 require 解析 ./lib/*
const modules = {
  './lib/pob': 'lib/pob.js',
  './lib/trade': 'lib/trade.js',
  './pob': 'lib/pob.js',
};
const files = [...new Set(Object.values(modules))];
let out = "'use strict';\nconst __mods = {};\nconst __cache = {};\n";
out += `const __map = ${JSON.stringify(modules)};\n`;
out += 'function __req(name) {\n  const f = __map[name];\n  if (!f) return require(name);\n  if (__cache[f]) return __cache[f].exports;\n  const module = { exports: {} };\n  __cache[f] = module;\n  __mods[f](module, module.exports, __req);\n  return module.exports;\n}\n';
for (const f of files) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  out += `__mods[${JSON.stringify(f)}] = function (module, exports, require) {\n${src}\n};\n`;
}
out += `(function (require) {\n${fs.readFileSync(path.join(root, 'server.js'), 'utf8')}\n})(__req);\n`;
fs.writeFileSync(path.join(dist, 'bundle.js'), out);

const config = {
  main: path.join(dist, 'bundle.js'),
  output: path.join(outDir, APP + '.exe'),
  disableExperimentalSEAWarning: true,
  assets: { 'index.html': path.join(root, 'public', 'index.html') },
};
fs.writeFileSync(path.join(dist, 'sea-config.json'), JSON.stringify(config, null, 2));
execFileSync(process.execPath, ['--build-sea', path.join(dist, 'sea-config.json')], { stdio: 'inherit' });
fs.unlinkSync(path.join(dist, 'bundle.js'));
fs.unlinkSync(path.join(dist, 'sea-config.json'));

// 使用說明：轉成 CRLF + BOM，舊版記事本也能正常顯示
const txt = fs.readFileSync(path.join(root, '使用說明.txt'), 'utf8').replace(/\r?\n/g, '\r\n');
fs.writeFileSync(path.join(outDir, '使用說明.txt'), '﻿' + txt);

// 壓成 zip 方便傳給別人
const zip = path.join(dist, APP + '.zip');
// 路徑含中文：用 -EncodedCommand（UTF-16LE base64）傳給 PowerShell，避免編碼問題
const ps = `Compress-Archive -Path '${outDir}' -DestinationPath '${zip}' -Force`;
let zipped = false;
try {
  execFileSync('powershell', ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { stdio: 'inherit' });
  zipped = true;
} catch (e) {
  console.warn('自動壓縮失敗（' + e.message + '），請手動把資料夾壓成 zip。');
}
console.log('完成：');
console.log('  資料夾：' + outDir);
if (zipped) console.log('  壓縮檔：' + zip + '（直接傳給別人）');
