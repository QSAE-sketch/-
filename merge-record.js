const fs = require('fs');

const usbRec = fs.readFileSync('E:/资料/资料总记录.txt', 'utf8'); // 带 BOM
// 我们 Git 上已有的 APK 项目条目（历史主档里没有）
const apkBlock = [
  '',
  '────────────────────────────────────────',
  '2026-11-14  APK下载站（云端下载站，主库已迁移至本 Git 仓库）',
  '────────────────────────────────────────',
  '· 事件：资料/事件/2026-11-14_事件_APK下载站云端备份.txt',
  '· 资源：资料/资源/2026-11-14_发现1_静态站bin强制下载.txt',
  '· 资源：资料/资源/2026-11-14_发现2_公开仓库与Git凭据.txt',
  '· 源码：资料/源码/APK下载站/（gen-page.js / pack-manual.js / manager/ / site/）',
  '· 线上：https://apk-download-site.app.workbuddy.host/?sharecode=QQKVVQEL2D',
  '· 仓库：https://github.com/QSAE-sketch/-（公开，大佬确认私有仓库 AI 侧用不了）',
  '· 注：自本日起，资料主库改为本 Git 仓库；U 盘仅作离线副本，不再作为主存。',
  '',
].join('\n');

fs.writeFileSync('D:/apk-download-site/资料/资料总记录.txt', usbRec + apkBlock, 'utf8');
const out = fs.readFileSync('D:/apk-download-site/资料/资料总记录.txt', 'utf8');
console.log('BOM 校验:', Buffer.from(out, 'utf8').slice(0,3).toString('hex'));
console.log('总行数:', out.split('\n').length);
console.log('含 APK 条目:', out.includes('APK下载站（云端下载站'));
