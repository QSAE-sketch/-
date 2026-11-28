'use strict';
/**
 * 皮肤视觉验证：起本地服务 → 无头 Chrome 实际渲染 → 输出图片。
 * 用法： node tools/shot-skin-verify.js [皮肤id...] [light|dark]
 * 产物： data/skin-shot/<skin>-<mode>.png
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3402;
const BASE = 'http://127.0.0.1:' + PORT;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(ROOT, 'data', 'skin-shot');
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
    if (r.exceptionDetails) throw new Error('页面脚本异常: ' + r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link id="baseCss" rel="stylesheet" href="/style.css"><link id="skinCss" rel="stylesheet">
</head><body>
<div class="topbar"><div class="tb-title">轻聊</div><div class="tb-right"><span class="tb-user">阿明</span></div></div>
<div class="view">
  <div class="card"><div class="card-h">💡 提示</div>
    <div class="row"><div class="r-main"><div class="r-title">公共聊天室</div><div class="r-sub">3 人在线</div></div><span class="badge">在线</span></div>
    <div class="row"><div class="r-main"><div class="r-title">我的好友</div><div class="r-sub">12 位联系人</div></div></div>
    <div class="act">进入房间 →</div></div>
  <div class="card"><div class="card-h">🎨 皮肤</div>
    <div class="row"><div class="r-main"><div class="r-title">竹青 Bamboo</div><div class="r-sub">当前使用</div></div></div>
    <div class="row"><div class="r-main"><div class="r-title">墨绿 Forest</div><div class="r-sub">终端 · 栅格硬边</div></div></div></div>
  <div class="card"><div class="card-h">🚪 其他入口</div>
    <div class="row"><div class="r-main"><div class="r-title">网盘</div><div class="r-sub">我的存储空间</div></div></div></div>
  <div class="msg"><div class="av" style="background:#6a8">明</div><div class="bub"><div class="who">阿明</div><div class="txt">这条消息看看气泡配色和文字对比。</div><div class="meta">14:20</div></div></div>
  <div class="msg mine"><div class="av" style="background:#8a6">我</div><div class="bub"><div class="txt">我这条是自己的气泡。</div></div></div>
</div>
<div class="tabbar"><div class="tb-btn active">主页</div><div class="tb-btn">房间</div><div class="tb-btn">好友</div><div class="tb-btn">网盘</div><div class="tb-btn">我的</div></div>
</body></html>`;

(async () => {
  const args = process.argv.slice(2);
  const modeArg = args.find((a) => a === 'light' || a === 'dark');
  const skins = args.filter((a) => a !== 'light' && a !== 'dark');
  const modes = modeArg ? [modeArg] : ['light', 'dark'];
  const list = skins.length ? skins : ['scallion-2', 'bamboo', 'forest', 'crow', 'fei', 'azurite', 'jade-not-exist'];

  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: path.join(ROOT, 'data-shot-skins'), STORAGE_BACKEND: 'local'
    }),
    stdio: 'ignore'
  });
  let chrome = null;
  const cleanup = () => { try { if (chrome) chrome.kill(); } catch (e) {} try { srv.kill(); } catch (e) {} };
  process.on('exit', cleanup);

  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/version'); if (r.ok) break; } catch (e) {}
    await sleep(300);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const port = 9371;
  const userDir = path.join(ROOT, 'data', 'chrome-skin-verify');
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', '--remote-debugging-port=' + port,
    '--window-size=430,1000', '--force-device-scale-factor=2',
    '--user-data-dir=' + userDir, 'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  for (let i = 0; i < 60; i++) { try { cdp = await CDP.connect(port); break; } catch (e) { await sleep(300); } }
  if (!cdp) throw new Error('Chrome / CDP 未就绪');
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: BASE + '/style.css' });
  await sleep(1500);

  for (const id of list) {
    for (const mode of modes) {
      await cdp.eval(`(function(){
        document.documentElement.setAttribute('data-skin','${id}');
        if ('${mode}'==='dark') document.documentElement.setAttribute('data-theme','dark');
        else document.documentElement.removeAttribute('data-theme');
        document.body.innerHTML = ${JSON.stringify(PAGE)};
        var l=document.getElementById('skinCss');
        l.href='/skins/${id}/skin.css';
        return new Promise(function(r){ if(l.sheet&&l.sheet.cssRules){setTimeout(function(){r(true)},400);} else {l.onload=function(){setTimeout(function(){r(true)},400);};} });
      })()`);
      await sleep(700);
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, id + '-' + mode + '.png');
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      console.log('saved ' + file);
    }
  }
  cdp.close();
  cleanup();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
