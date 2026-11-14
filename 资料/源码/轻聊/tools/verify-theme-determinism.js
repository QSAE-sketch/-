'use strict';
/**
 * 验证 theme.js 在各种「极端时刻」下都稳定通过（不再随机失败）。
 * 做法：把 test/theme.js 里的固定时钟替换成不同时刻，跑一遍看是否全绿。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'test', 'theme.js'), 'utf8');

const variants = [
  ['整点前 1 分钟', 'new Date(2026, 0, 15, 10, 59, 0, 0)'],
  ['整点前 59 秒', 'new Date(2026, 0, 15, 10, 59, 59, 0)'],
  ['23:59:59', 'new Date(2026, 0, 15, 23, 59, 59, 0)'],
  ['00:00:00', 'new Date(2026, 0, 15, 0, 0, 0, 0)'],
  ['默认 10:30', 'new Date(2026, 0, 15, 10, 30, 0, 0)']
];

let bad = 0;
for (const [label, expr] of variants) {
  const variant = src.replace(/const FIXED_NOW = new Date\([^)]*\);/, 'const FIXED_NOW = ' + expr + ';');
  const tmp = path.join(ROOT, 'test', '.theme-variant.tmp.js');
  fs.writeFileSync(tmp, variant, 'utf8');
  let stat = 'N/A';
  let fails = [];
  try {
    const out = execFileSync(process.execPath, [tmp], {
      cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { PORT: '3399' })
    });
    const lines = out.trim().split('\n');
    stat = (lines.filter((l) => l.indexOf('通过:') >= 0).pop() || 'N/A');
    fails = lines.filter((l) => l.indexOf('✗') >= 0);
  } catch (e) {
    stat = '异常退出';
    const s = (e.stdout || '') + (e.stderr || '');
    fails = s.trim().split('\n').slice(-6);
  }
  try { fs.unlinkSync(path.join(ROOT, 'test', '.theme-variant.tmp.js')); } catch (e) { /* ignore */ }
  if (fails.length) bad++;
  console.log('  ' + label.padEnd(12) + ' → ' + stat + (fails.length ? '  ★失败: ' + fails.join(' | ') : '  ✓'));
}
console.log(bad ? ('\n有 ' + bad + ' 个时刻仍失败') : '\n所有时刻都稳定通过');
process.exit(bad ? 1 : 0);
