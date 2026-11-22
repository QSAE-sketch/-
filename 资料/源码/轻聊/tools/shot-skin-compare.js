'use strict';
/**
 * 皮肤视觉终检：起本地服务 → 应用 openwire 皮肤 → 分别截浅色/深色 → 断言两套配色不同。
 * 用法：node tools/shot-skin-compare.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3317;
const BASE = 'http://127.0.0.1:' + PORT;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); }
  static async connect(port) {
    const list = await new Promise((res, rej) => {
      const q = http.get({ host: '127.0.0.1', port, path: '/json/list' }, (r) => {
        let b = ''; r.on('data', (c) => { b += c; });
        r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
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
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: path.join(ROOT, 'data-shot-skin'),
      STORAGE_BACKEND: 'local'
    }),
    stdio: 'ignore'
  });
  let chrome = null;
  const cleanup = () => {
    try { if (chrome) chrome.kill(); } catch (e) { /* ignore */ }
    try { srv.kill(); } catch (e) { /* ignore */ }
  };
  process.on('exit', cleanup);

  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/version'); if (r.ok) break; } catch (e) { /* wait */ }
    await sleep(300);
  }
  const un = 'snap' + Date.now().toString(36).slice(-6);
  const reg = await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: un, password: 'pass123', nickname: '截图检查' })
  }).then((r) => r.json());
  if (!reg.token) throw new Error('注册失败: ' + JSON.stringify(reg));

  const port = 9366;
  const userDir = path.join(ROOT, 'data', 'chrome-skin-' + un);
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', '--remote-debugging-port=' + port,
    '--window-size=420,900', '--force-device-scale-factor=1',
    '--user-data-dir=' + userDir, 'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  for (let i = 0; i < 60; i++) {
    try { cdp = await CDP.connect(port); break; } catch (e) { await sleep(300); }
  }
  if (!cdp) throw new Error('Chrome / CDP 未就绪');
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: BASE + '/?sharecode=T7ELJZOC5A' });
  await sleep(2500);

  const inject = (pref) =>
    'localStorage.setItem("ll_token",' + JSON.stringify(reg.token) + ');' +
    'localStorage.setItem("ll_skin","openwire");' +
    'localStorage.setItem("ll_theme_mode","manual");' +
    'localStorage.setItem("ll_theme_pref","' + pref + '");location.reload();';

  async function capture(pref, out) {
    await cdp.eval(inject(pref));
    await sleep(3500);
    await cdp.eval('(function(){var n=document.querySelector("[data-view=\\"public\\"]");if(n)n.click();})()');
    await sleep(1000);
    const info = await cdp.eval('(function(){' +
      'var b=document.body, c=document.querySelector(".card"), h=document.querySelector(".card-h");' +
      'return {body:getComputedStyle(b).backgroundColor,' +
      'card:c?getComputedStyle(c).backgroundColor:"",' +
      'head:h?getComputedStyle(h).backgroundColor:"",' +
      'headFg:h?getComputedStyle(h).color:""};})()');
    await cdp.shot(out);
    return info;
  }

  const light = await capture('light', 'D:/ql-skin-light.png');
  const dark = await capture('dark', 'D:/ql-skin-dark.png');
  console.log('浅色:', JSON.stringify(light));
  console.log('深色:', JSON.stringify(dark));
  const ok = light.body !== dark.body && light.head !== dark.head && light.headFg !== dark.headFg;
  console.log(ok ? '✓ 浅色/深色是两套不同配色' : '✗ 浅色/深色看起来一样');
  cdp.close();
  cleanup();
  // 清理测试账号
  try {
    await fetch(BASE + '/api/account/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': reg.token },
      body: JSON.stringify({ confirm: true })
    });
  } catch (e) { /* ignore */ }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
