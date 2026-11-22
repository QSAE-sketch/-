'use strict';
/**
 * 12 套新皮肤视觉终检：起本地服务 → 依次套用每套皮肤 → 读浅色/深色的实际计算配色。
 * 断言：每套浅深底色不同、主色不同，且没有大块纯黑标题条。
 * 用法：node tools/shot-skins-all.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3318;
const BASE = 'http://127.0.0.1:' + PORT;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SKINS = ['inkscroll','sky','plain','vermilion','parchment','mint',
  'nightgold','oldpaper','pine','deepsea','cloud','grey'];
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
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: path.join(ROOT, 'data-shot-skins'),
      STORAGE_BACKEND: 'local'
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
  const port = 9369;
  const userDir = path.join(ROOT, 'data', 'chrome-skins-all');
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', '--remote-debugging-port=' + port,
    '--window-size=420,900', '--force-device-scale-factor=1',
    '--user-data-dir=' + userDir, 'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  for (let i = 0; i < 60; i++) { try { cdp = await CDP.connect(port); break; } catch (e) { await sleep(300); } }
  if (!cdp) throw new Error('Chrome / CDP 未就绪');
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: BASE + '/?sharecode=T7ELJZOC5A' });
  await sleep(2500);

  // 不依赖登录：直接建一个干净的测试页，注入基础样式 + 皮肤样式
  await cdp.eval(`(function(){
    document.documentElement.innerHTML = '<head><meta charset="utf-8"><link id="baseCss" rel="stylesheet" href="/style.css"><link id="skinCss" rel="stylesheet"></head><body><div class="topbar"><div class="tb-title">皮肤测试</div></div><div class="card"><div class="card-h">标题栏</div><div class="row">一行内容</div><div class="act">操作</div></div><div class="tabbar"><div class="tb-btn active">主页</div></div></body>';
    return true;
  })()`);
  await sleep(600);

  const read = () => cdp.eval(`(function(){
    var b=document.body,c=document.querySelector('.card'),h=document.querySelector('.card-h');
    return {body:getComputedStyle(b).backgroundColor, fg:getComputedStyle(b).color,
      card:c?getComputedStyle(c).backgroundColor:'', head:h?getComputedStyle(h).backgroundColor:'',
      headFg:h?getComputedStyle(h).color:'', radius:c?getComputedStyle(c).borderRadius:''};
  })()`);

  let pass = 0;
  for (const id of SKINS) {
    const res = {};
    for (const mode of ['light','dark']) {
      await cdp.eval(`(function(){
        document.documentElement.setAttribute('data-skin','${id}');
        if ('${mode}'==='dark') document.documentElement.setAttribute('data-theme','dark');
        else document.documentElement.removeAttribute('data-theme');
        var l=document.getElementById('skinCss');
        l.href='/skins/${id}/skin.css';
        return new Promise(function(r){ if(l.sheet&&l.sheet.cssRules){setTimeout(function(){r(true)},350);} else {l.onload=function(){setTimeout(function(){r(true)},350);};} });
      })()`);
      await sleep(500);
      res[mode] = await read();
    }
    const distinct = res.light.body !== res.dark.body && res.light.head !== res.dark.head;
    const noBlackBar = !/rgb\(17,\s*17,\s*15\)|rgb\(0,\s*0,\s*0\)/.test(res.light.head);
    const ok = distinct && noBlackBar;
    if (ok) pass++;
    console.log((ok?'✓':'✗')+' '+id.padEnd(11)+
      ' 浅['+res.light.body+' / 头 '+res.light.head+']'+
      ' 深['+res.dark.body+' / 头 '+res.dark.head+']'+
      ' 圆角'+res.light.radius);
  }
  console.log('\n通过 '+pass+'/'+SKINS.length+' 套（浅深不同 + 标题栏非纯黑）');
  cdp.close();
  cleanup();
  process.exit(pass === SKINS.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
