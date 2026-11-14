'use strict';
/**
 * 线上版本信息专项：
 *   1) /api/version 无需登录，返回语义版本 / 版本代号 / 发布日期 / 更新说明
 *   2) 构建指纹由 version.json + app.js + style.css 内容算出，任一改动都会变
 *   3) 版本号与 Android build.gradle 用的是同一份 version.json（不写死两处）
 *   4) 前端设置页「关于」会去拉这个接口并渲染
 *   5) 接口响应 no-store（版本号必须实时，不能被缓存成旧值）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'http://127.0.0.1:' + (process.env.PORT || 3311);
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = (body === undefined || body === null) ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Type'] = 'application/json';
    const u = new URL(p, BASE);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(cs).toString('utf8')); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, json: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 250) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const disk = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));

/** 本地复算构建指纹，用于和接口返回值比对 */
function expectedBuild() {
  const h = crypto.createHash('sha1');
  // 与 server.js buildId() 保持完全一致：三档网页（标准 / 低配 / 基础）都纳入指纹
  const files = ['version.json', 'public/app.js', 'public/style.css',
    'public/app-lite.js', 'public/style-lite.css',
    'public/app-basic.js', 'public/style-basic.css'];
  for (const f of files) {
    try { h.update(f); h.update(fs.readFileSync(path.join(ROOT, f))); }
    catch (e) { h.update(f); }
  }
  return h.digest('hex').slice(0, 10);
}

(async () => {
  console.log('\n──── 线上版本信息 ────');

  const r = await req('GET', '/api/version');
  check('GET /api/version 返回 200', r.status === 200, r.status);
  check('接口无需登录（auth=false）', !!(r.json && r.json.ok), r.json);
  check('响应 Cache-Control 为 no-store（版本不被缓存）',
    String(r.headers['cache-control']).indexOf('no-store') >= 0, r.headers['cache-control']);

  const v = r.json && r.json.version;
  check('返回 version 对象', !!v, v);
  check('语义版本与 version.json 一致', !!(v && v.name === disk.name), v && v.name);
  check('版本代号与 version.json 一致', !!(v && v.code === disk.code), v && v.code);
  check('发布日期与 version.json 一致', !!(v && v.releasedAt === disk.releasedAt), v && v.releasedAt);
  check('更新说明是非空数组', !!(v && Array.isArray(v.notes) && v.notes.length > 0), v && v.notes);
  check('返回构建指纹', !!(r.json && /^[0-9a-f]{10}$/.test(String(r.json.build))), r.json && r.json.build);
  check('构建指纹与本地复算一致', !!(r.json && r.json.build === expectedBuild()),
    { api: r.json && r.json.build, local: expectedBuild() });
  check('返回服务端时间戳', !!(r.json && typeof r.json.serverTime === 'number' && r.json.serverTime > 0),
    r.json && r.json.serverTime);

  // 内容一变，构建指纹必须跟着变（模拟一次线上部署）
  const vf = path.join(ROOT, 'version.json');
  const orig = fs.readFileSync(vf);
  let changed = r.json && r.json.build;
  try {
    const bumped = Object.assign({}, disk, { code: disk.code + 999 });
    fs.writeFileSync(vf, JSON.stringify(bumped, null, 2) + '\n', 'utf8');
    await sleep(120);
    const r2 = await req('GET', '/api/version');
    changed = r2.json && r2.json.build;
    check('version.json 一改，构建指纹立即变化（部署即变）',
      !!(changed && changed !== r.json.build), { before: r.json.build, after: changed });
    check('接口同时返回新的版本代号', !!(r2.json && r2.json.version.code === disk.code + 999),
      r2.json && r2.json.version);
  } finally {
    fs.writeFileSync(vf, orig);
  }
  const r3 = await req('GET', '/api/version');
  check('还原 version.json 后构建指纹恢复', !!(r3.json && r3.json.build === r.json.build),
    { before: r.json.build, after: r3.json && r3.json.build });

  // 单一数据源：build.gradle 不得再写死版本号
  const gradle = fs.readFileSync(path.join(ROOT, 'android', 'app', 'build.gradle'), 'utf8');
  check('build.gradle 从 ../version.json 读取版本号', gradle.indexOf("file('../version.json')") >= 0);
  check('build.gradle 不再写死 versionCode', !/versionCode\s+\d+/.test(gradle));
  check('build.gradle 不再写死 versionName 字符串', !/versionName\s+"/.test(gradle));

  // 前端：设置页确实拉接口并渲染版本信息
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  check('前端调用 /api/version', app.indexOf("'/api/version'") >= 0);
  check('前端渲染版本号 v + version.name', app.indexOf("'v' + v.name") >= 0);
  check('前端渲染构建号', app.indexOf("'构建号 #'") >= 0);
  check('前端说明「无需更换安装包」', app.indexOf('无需更换安装包') >= 0);
  check('设置页容器 verBox 存在', app.indexOf('verBox') >= 0);

  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  check('样式表含 .ver-name / .ver-badge', css.indexOf('.ver-name') >= 0 && css.indexOf('.ver-badge') >= 0);

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('❌ 版本信息测试异常:', e && e.message);
  process.exit(1);
});
