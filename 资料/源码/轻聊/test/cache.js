'use strict';
/**
 * 静态资源缓存专项：确保「线上更新 → 用户划掉后台重开」立刻拿到新代码。
 *
 * 覆盖：
 *   1. 入口页 no-store（冷启动必定回源）
 *   2. 入口页里 app.js / style.css 带内容指纹 ?v=
 *   3. 带指纹的 JS/CSS 可长缓存，不带指纹的 no-store（兼容旧客户端）
 *   4. 文件内容一变，指纹就变（旧缓存 URL 不再被引用）
 *   5. 带 ?v= 的资源内容与原文件一致（不影响功能）
 *   6. API 响应仍是 no-store（不被静态策略误伤）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.PORT || 3311);
const BASE = 'http://127.0.0.1:' + PORT;
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}
function get(p, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      hostname: '127.0.0.1', port: PORT, path: p, method: 'GET',
      headers: Object.assign({ 'accept-encoding': 'identity' }, headers || {})
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(cs) }));
    });
    r.on('error', reject);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n──── 静态资源缓存（部署即生效） ────');

  const idx = await get('/');
  check('GET / 返回 200', idx.status === 200, idx.status);
  check('入口页 Cache-Control = no-store（冷启动必回源）',
    String(idx.headers['cache-control']).indexOf('no-store') >= 0, idx.headers['cache-control']);

  const html = idx.body.toString('utf8');
  const jsMatch = html.match(/\/app\.js\?v=([0-9a-f]+)/);
  const cssMatch = html.match(/\/style\.css\?v=([0-9a-f]+)/);
  check('入口页里 app.js 带内容指纹 ?v=', !!jsMatch, html.match(/<script[^>]*>/g));
  check('入口页里 style.css 带内容指纹 ?v=', !!cssMatch, html.match(/<link[^>]*>/g));
  check('两个指纹一致（同一次构建）', !!(jsMatch && cssMatch && jsMatch[1] === cssMatch[1]));

  if (!jsMatch) {
    console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(1);
  }
  const v = jsMatch[1];

  const js = await get('/app.js?v=' + v);
  const css = await get('/style.css?v=' + v);
  check('GET /app.js?v=… 返回 200', js.status === 200, js.status);
  check('GET /style.css?v=… 返回 200', css.status === 200, css.status);
  check('带指纹的 app.js 可长缓存',
    /max-age=31536000/.test(String(js.headers['cache-control'])), js.headers['cache-control']);
  check('带指纹的 style.css 可长缓存',
    /max-age=31536000/.test(String(css.headers['cache-control'])), css.headers['cache-control']);

  const diskJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'));
  const diskCss = fs.readFileSync(path.join(ROOT, 'public', 'style.css'));
  check('带 ?v= 的 app.js 内容与原文件一致', js.body.equals(diskJs));
  check('带 ?v= 的 style.css 内容与原文件一致', css.body.equals(diskCss));

  const oldJs = await get('/app.js');
  check('不带版本号的 /app.js 是 no-store（不残留旧缓存）',
    String(oldJs.headers['cache-control']).indexOf('no-store') >= 0, oldJs.headers['cache-control']);
  const idx2 = await get('/index.html');
  check('GET /index.html 也是 no-store',
    String(idx2.headers['cache-control']).indexOf('no-store') >= 0, idx2.headers['cache-control']);

  // 内容变化 → 指纹变化（临时追加一行注释，随后还原）
  const p = path.join(ROOT, 'public', 'app.js');
  const orig = fs.readFileSync(p);
  let after = v;
  try {
    fs.appendFileSync(p, '\n/* cache-test-probe */\n', 'utf8');
    await sleep(150);
    const html2 = (await get('/')).body.toString('utf8');
    const m2 = html2.match(/\/app\.js\?v=([0-9a-f]+)/);
    after = m2 ? m2[1] : v;
  } finally {
    fs.writeFileSync(p, orig);
  }
  check('app.js 内容一变，指纹立即变化（旧缓存 URL 失效）', after !== v, { before: v, after });
  const restored = (await get('/')).body.toString('utf8').match(/\/app\.js\?v=([0-9a-f]+)/);
  check('还原文件后指纹恢复', !!(restored && restored[1] === v), restored && restored[1]);

  // API 不受影响
  const api = await get('/api/rooms');
  check('API 响应仍是 no-store', String(api.headers['cache-control']).indexOf('no-store') >= 0,
    api.headers['cache-control']);

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('❌ 静态缓存测试异常:', e && e.message);
  process.exit(1);
});
