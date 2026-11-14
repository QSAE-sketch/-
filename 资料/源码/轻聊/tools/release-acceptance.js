/**
 * 红米Note2适配方案.md 已有机型分析；本脚本负责「每次发布」可自动化的验收部分。
 * 见 docs/红米Note2发布验收清单.md —— 真机项必须由人在设备上确认，本脚本不代替。
 */
'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE = 'https://qingliao-chat-33476.app.workbuddy.host';
const SHARE_CODE = process.env.SHARE_CODE || 'T7ELJZOC5A';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const COOKIES = {};
const REPORT = { pass: 0, fail: 0, items: [] };

function req(method, p, body, token, host) {
  return new Promise((resolve, reject) => {
    const target = host || BASE;
    const data = (body === undefined || body === null) ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { 'accept-encoding': 'identity' };
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Type'] = 'application/json; charset=utf-8';
    const ck = Object.keys(COOKIES).map((k) => k + '=' + COOKIES[k]).join('; ');
    if (ck) headers['Cookie'] = ck;
    const u = new URL(p, target);
    const mod = u.protocol === 'http:' ? http : https;
    const t0 = Date.now();
    const r = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method, headers }, (res) => {
      for (const line of (res.headers['set-cookie'] || [])) {
        const kv = line.split(';')[0]; const i = kv.indexOf('=');
        if (i > 0) COOKIES[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      }
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(cs).toString('utf8');
        let j = null; try { j = JSON.parse(raw); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: raw, json: j, ms: Date.now() - t0 });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) {
  REPORT.items.push({ name, ok, detail });
  if (ok) { REPORT.pass++; console.log('  ✓ ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { REPORT.fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

/* ---------------- CDP：低端环境性能模拟 ---------------- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); }
  static async connect(port) {
    const list = await new Promise((res, rej) => {
      const q = http.get({ host: '127.0.0.1', port, path: '/json/list' }, (r) => {
        let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
      });
      q.on('error', rej);
    });
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('找不到 page target');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.waits.has(m.id)) {
        const { res, rej } = c.waits.get(m.id);
        c.waits.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
      }
    };
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waits.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.waits.has(id)) { this.waits.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 45000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面脚本异常: ' + JSON.stringify(r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

/** 用 4x CPU 降速 + 3G 弱网模拟红米 Note 2 一类的低端设备，量首屏 */
async function perfCheck() {
  const port = 9351;
  const userDir = path.join(ROOT, 'data', 'chrome-acceptance');
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', '--remote-debugging-port=' + port,
    '--window-size=360,640', '--force-device-scale-factor=2',
    '--user-data-dir=' + userDir, 'about:blank'
  ], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill(); } catch (e) { /* ignore */ } };
  let cdp = null;
  for (let i = 0; i < 60; i++) {
    try { cdp = await CDP.connect(port); break; } catch (e) { await sleep(300); }
  }
  if (!cdp) { cleanup(); throw new Error('Chrome / CDP 未就绪'); }

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  // 红米 Note 2 是 2015 年的 MT6795 / 2GB：按 4x CPU 降速 + Regular 3G 估算
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 100,
    downloadThroughput: 750 * 1024 / 8, uploadThroughput: 250 * 1024 / 8
  });

  await cdp.send('Page.navigate', { url: BASE + '/?sharecode=' + SHARE_CODE });
  // 等 load 完成（含弱网等待）
  let ready = false;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    try { ready = await cdp.eval('document.readyState === "complete"'); } catch (e) {}
    if (ready) break;
  }
  const timing = await cdp.eval(`(function(){
    var t = performance.timing || {};
    var nav = (performance.getEntriesByType('navigation')[0] || {});
    return {
      dcl: t.domContentLoadedEventEnd ? t.domContentLoadedEventEnd - t.navigationStart : (nav.domContentLoadedEventEnd||0),
      load: t.loadEventEnd ? t.loadEventEnd - t.navigationStart : (nav.loadEventEnd||0),
      fcp: (performance.getEntriesByName('first-contentful-paint')[0]||{}).startTime || 0,
      resources: performance.getEntriesByType('resource').length
    };
  })()`);

  // 首屏可交互：登录表单渲染出来（auth 区块可见且按钮已绑定）
  const interactive = await cdp.eval(`(function(){
    var ab = document.getElementById('ab');
    return !!(ab && ab.onclick);
  })()`);

  // 接口响应：低端模拟下连测 5 次 /api/version，取 P50 / 最大值
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const ms = await cdp.eval(`(async function(){
      var t0 = performance.now();
      await fetch('/api/version', {cache:'no-store'});
      return Math.round(performance.now() - t0);
    })()`);
    samples.push(ms);
  }
  samples.sort((a, b) => a - b);

  cdp.close();
  cleanup();
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  return { timing, interactive, samples };
}

(async () => {
  console.log('\n======== 轻聊 · 发布验收（自动化部分） ========');
  console.log('目标机型基准：红米 Note 2 / MT6795 / 2GB / Android 5.x WebView');
  console.log('模拟条件：CPU 4x 降速 + Regular 3G（750kbps / 100ms）\n');

  /* ---- 1. 产物命名：不带版本号 ---- */
  console.log('【产物命名】');
  const rootFiles = fs.readdirSync(ROOT);
  const apks = rootFiles.filter((n) => n.endsWith('.apk'));
  check('APK 产物名为「轻聊.apk」，无版本号后缀',
    apks.length === 1 && apks[0] === '轻聊.apk', apks.join(', '));
  const desktopDir = path.join(ROOT, 'desktop');
  const exes = fs.readdirSync(desktopDir).filter((n) => n.endsWith('.exe'));
  check('电脑端产物名为「轻聊.exe」，无版本号后缀',
    exes.length === 1 && exes[0] === '轻聊.exe', exes.join(', '));
  const strings = fs.readFileSync(path.join(ROOT, 'android/app/src/main/res/values/strings.xml'), 'utf8');
  check('应用名不带版本号', /<string name="app_name">轻聊<\/string>/.test(strings));
  const vjson = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
  check('版本号只在 version.json 中定义（供设置页「关于」实时下发）', !!vjson.name && !vjson.legacy);

  /* ---- 2. 线上资源与版本接口 ---- */
  console.log('\n【线上资源】');
  const hs = await req('GET', '/?sharecode=' + SHARE_CODE);
  check('网关握手成功', hs.status === 200, 'status=' + hs.status);
  check('入口页 no-store（重开必回源）', /no-store/.test(String(hs.headers['cache-control'])));
  const m = hs.body.match(/\/app\.js\?v=([0-9a-f]+)/);
  check('前端资源带内容指纹（部署即生效）', !!m, m && m[0]);
  const ver = await req('GET', '/api/version');
  check('/api/version 返回线上版本', ver.status === 200 && !!ver.json.version,
    ver.json && ver.json.version && ver.json.version.name);
  check('版本接口 no-store', /no-store/.test(String(ver.headers['cache-control'])));

  /* ---- 3. 低端模拟性能 ---- */
  console.log('\n【低端模拟性能（4x CPU + 3G）】');
  let perf = null;
  try { perf = await perfCheck(); }
  catch (e) { check('性能模拟执行成功', false, e.message); }
  if (perf) {
    const { timing, interactive, samples } = perf;
    console.log('    首屏 FCP=' + Math.round(timing.fcp) + 'ms  DCL=' + Math.round(timing.dcl) +
      'ms  load=' + Math.round(timing.load) + 'ms  资源数=' + timing.resources);
    check('首屏可交互（登录按钮已绑定事件）', interactive);
    // 4x CPU + 3G 下的宽松阈值：只拦明显劣化，不追求桌面级数字
    check('首屏内容绘制 < 3000ms（低端模拟）', timing.fcp > 0 && timing.fcp < 3000,
      Math.round(timing.fcp) + 'ms');
    check('页面加载完成 < 8000ms（低端模拟）', timing.load > 0 && timing.load < 8000,
      Math.round(timing.load) + 'ms');
    const p50 = samples[Math.floor(samples.length / 2)];
    console.log('    接口响应样本(ms)=' + samples.join(', '));
    check('接口 P50 < 1500ms（低端模拟）', p50 < 1500, p50 + 'ms');
  }

  /* ---- 4. 信息同步 ---- */
  console.log('\n【信息同步】');
  const stamp = 'ra' + Date.now().toString(36).slice(-6);
  const A = await req('POST', '/api/register', { username: stamp + 'a', password: 'pass123', nickname: '验收甲' });
  const B = await req('POST', '/api/register', { username: stamp + 'b', password: 'pass123', nickname: '验收乙' });
  check('两个验收账号注册成功', !!(A.json.token && B.json.token));
  if (A.json.token && B.json.token) {
    const rooms = await req('GET', '/api/rooms', null, B.json.token);
    const pub = rooms.json.rooms.find((r) => r.kind === 'public');
    const marker = 'sync-' + Date.now();
    const t0 = Date.now();
    const sent = await req('POST', '/api/rooms/' + pub.id + '/messages', { kind: 'text', content: marker }, A.json.token);
    const got = await req('GET', '/api/rooms/' + pub.id + '/messages?since=0&limit=80', null, B.json.token);
    const syncMs = Date.now() - t0;
    const seen = !!(got.json && got.json.messages.some((x) => x.content === marker));
    check('A 发消息 → B 立即能看到（跨账号同步）', seen && !!sent.json.ok, syncMs + 'ms');
    check('同步往返 < 3000ms', syncMs < 3000, syncMs + 'ms');
    const me = await req('GET', '/api/me', null, B.json.token);
    const rq = await req('POST', '/api/friends/request', { userId: me.json.user.id, message: '验收申请' }, A.json.token);
    const fr = await req('GET', '/api/friends', null, B.json.token);
    check('好友申请实时到达对方', !!(rq.json.request && fr.json.incoming.length > 0));
  }

  /* ---- 5. 真机项（不可由脚本代跑，明确列出） ---- */
  console.log('\n【红米 Note 2 真机验收 · 需人工在设备上确认】');
  const manual = [
    '冷启动：划掉后台后重开，首屏出现 < 3 秒，不白屏、不卡在启动画面',
    '运行流畅：消息列表上下滑动无掉帧、无卡顿，切换「公共/房间/好友/我的」响应即时',
    '响应较快：点头像进资料页、发消息、同意好友申请，点击到界面变化无迟滞感',
    '信息同步：手机发消息 → 电脑端/另一台设备立刻收到；好友申请实时出现',
    '深浅主题：跟随系统 / 按时间 / 手动三种模式切换后界面即时变化、无闪白',
    '长时间挂后台再回前台：消息补齐、不掉登录、不重复渲染'
  ];
  manual.forEach((t, i) => console.log('  ' + (i + 1) + '. [真机] ' + t));
  console.log('\n  ⚠ 以上 6 项必须在红米 Note 2 设备上由人确认；脚本只能验证可自动化的部分。');

  /* ---- 报告 ---- */
  console.log('\n================ 验收结果 ================');
  console.log('  自动化项：通过 ' + REPORT.pass + '，失败 ' + REPORT.fail);
  console.log('  真机项：  ' + manual.length + ' 项待人工确认');
  const out = path.join(ROOT, 'docs', 'last-release-acceptance.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    generatedAt: new Date().toISOString(),
    targetDevice: '红米 Note 2',
    simulated: 'CPU 4x + Regular 3G',
    version: vjson.name,
    build: ver.json && ver.json.build,
    automated: REPORT,
    manual: manual
  }, null, 2) + '\n', 'utf8');
  console.log('  报告：docs/last-release-acceptance.json');
  console.log('\n  说明：暂不实现恢复旧版本功能（本次与近期均不做）。');
  process.exit(REPORT.fail ? 1 : 0);
})().catch((e) => { console.error('验收异常:', e && e.message); process.exit(1); });
