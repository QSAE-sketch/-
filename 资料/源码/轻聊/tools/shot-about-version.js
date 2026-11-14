'use strict';
/**
 * 线上「设置 → 关于」版本信息视觉终检（headless Chrome + CDP）。
 * 注册账号 → 注入 token → 进入「我的」→ 设置 → 断言版本卡片内容 → 截图。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const BASE = 'https://qingliao-chat-33476.app.workbuddy.host';
const SHARE_CODE = process.env.SHARE_CODE || 'T7ELJZOC5A';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = path.join(__dirname, '..');
const COOKIES = {};

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = (body === undefined || body === null) ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Type'] = 'application/json; charset=utf-8';
    const ck = Object.keys(COOKIES).map((k) => k + '=' + COOKIES[k]).join('; ');
    if (ck) headers['Cookie'] = ck;
    const u = new URL(p, BASE);
    const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers }, (res) => {
      for (const line of (res.headers['set-cookie'] || [])) {
        const kv = line.split(';')[0];
        const i = kv.indexOf('=');
        if (i > 0) COOKIES[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      }
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(cs).toString('utf8')); } catch (e) {}
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

(async () => {
  await req('GET', '/?sharecode=' + SHARE_CODE);
  const un = 'ver' + Date.now().toString(36).slice(-6);
  const reg = await req('POST', '/api/register', { username: un, password: 'pass123', nickname: '版本检查' });
  if (!reg.json || !reg.json.token) { console.error('注册失败', JSON.stringify(reg.json)); process.exit(1); }
  const token = reg.json.token;

  const port = 9334;
  const userDir = path.join(ROOT, 'data', 'chrome-ver-' + un);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', '--remote-debugging-port=' + port,
    '--window-size=400,900', '--force-device-scale-factor=1',
    '--user-data-dir=' + userDir, 'about:blank'
  ], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill(); } catch (e) { /* ignore */ } };
  process.on('exit', cleanup);

  let cdp = null;
  for (let i = 0; i < 60; i++) {
    try { cdp = await CDP.connect(port); break; } catch (e) { await sleep(300); }
  }
  if (!cdp) { console.error('Chrome / CDP 未就绪'); cleanup(); process.exit(1); }
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: BASE + '/?sharecode=' + SHARE_CODE });
  await sleep(3000);
  await cdp.eval('localStorage.setItem("ll_token",' + JSON.stringify(token) + '); location.reload();');
  await sleep(4000);

  // 我的 → 设置
  await cdp.eval('(function(){var n=document.querySelector("[data-view=\\"me\\"]");if(n)n.click();return !!n;})()');
  await sleep(600);
  await cdp.eval('(function(){var n=document.querySelector("[data-go=\\"settings\\"]");if(n)n.click();return !!n;})()');
  await sleep(2500);

  const info = await cdp.eval('(function(){var b=document.getElementById("verBox");' +
    'return b?{text:b.textContent.replace(/\\s+/g," ").trim(),html:b.innerHTML.slice(0,300)}:null;})()');
  console.log('版本卡片内容：', JSON.stringify(info && info.text));
  if (!info || !info.text) { console.error('✗ 版本卡片没有渲染'); cdp.close(); cleanup(); process.exit(1); }
  const t = info.text;
  const checks = [
    ['显示语义版本号 v1.4.3', t.indexOf('v1.4.3') >= 0],
    ['显示「当前线上版本」徽章', t.indexOf('当前线上版本') >= 0],
    ['显示构建号', t.indexOf('构建号 #') >= 0],
    ['显示版本代号', t.indexOf('版本代号 8') >= 0],
    ['显示发布日期', t.indexOf('发布日期') >= 0],
    ['显示本次更新', t.indexOf('本次更新') >= 0],
    ['显示「无需更换安装包」提示', t.indexOf('无需更换安装包') >= 0]
  ];
  let bad = 0;
  for (const [n, ok] of checks) { console.log((ok ? '  ✓ ' : '  ✗ ') + n); if (!ok) bad++; }

  await cdp.shot(path.join(ROOT, 'public', '_shot-about-version.png'));
  console.log('✓ 截图：public/_shot-about-version.png');

  // 「关于」在设置页最底部，滚下去再单独拍一张，便于检查版本卡片排版
  await cdp.eval('(function(){var b=document.getElementById("verBox");' +
    'if(b&&b.scrollIntoView)b.scrollIntoView({block:"start"});' +
    'var v=document.getElementById("setView");if(v)v.scrollTop=v.scrollHeight;' +
    'return true;})()');
  await sleep(600);
  await cdp.shot(path.join(ROOT, 'public', '_shot-about-version-bottom.png'));
  console.log('✓ 截图：public/_shot-about-version-bottom.png');

  cdp.close();
  cleanup();
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  if (bad) process.exit(1);
  console.log('\n设置页「关于」版本信息全部正常');
  process.exit(0);
})().catch((e) => { console.error('验证异常:', e && e.message); process.exit(1); });
