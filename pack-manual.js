const fs = require('fs');
const path = require('path');

const SRC = 'D:/.workbuddy/2026-11-10-21-12-56/apk-manager';
const DIST = path.join(SRC, 'node_modules/electron/dist');
const OUT = 'C:/Users/Administrator/Desktop/APK下载站管理';

if (fs.existsSync(OUT)) {
  console.error('OUTPUT_DIR_EXISTS: 目标已存在，为安全起见不覆盖');
  process.exit(1);
}

function copyDir(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip && skip(e.name)) continue;
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d, skip);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

fs.mkdirSync(path.join(OUT, 'resources', 'app'), { recursive: true });
copyDir(DIST, OUT);

['main.js', 'ui.html', 'package.json'].forEach(function (f) {
  fs.copyFileSync(path.join(SRC, f), path.join(OUT, 'resources', 'app', f));
});

copyDir(path.join(SRC, 'node_modules'), path.join(OUT, 'resources', 'app', 'node_modules'), function (name) {
  return name === 'electron' || name === 'electron-packager' || name === '.bin' || name === '.cache';
});

const oldExe = path.join(OUT, 'electron.exe');
const newExe = path.join(OUT, 'APK下载站管理.exe');
fs.renameSync(oldExe, newExe);

let total = 0;
(function walk(p) {
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    if (e.isDirectory()) walk(f);
    else total += fs.statSync(f).size;
  }
})(OUT);

console.log('EXE=' + newExe);
console.log('EXISTS=' + fs.existsSync(newExe));
console.log('SIZE_MB=' + (total / 1048576).toFixed(1));
console.log('SDK_PRESENT=' + fs.existsSync(path.join(OUT, 'resources/app/node_modules/@tencent-ai/workbuddy-cloud-sdk/package.json')));
