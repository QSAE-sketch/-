'use strict';
/**
 * bug-fixer 运行时抓错器：真实无头浏览器走一遍全部视图，
 * 捕获 Runtime.exceptionThrown / console.error / 失败的网络请求，
 * 找出静态断言测不到的前端运行时 BUG。
 * 用法：node tools/bug-hunt-runtime.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3411;
const BASE = 'http://127.0.0.1:' + PORT;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); this.events = []; }
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
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        c.events.push({ type: 'JS异常', text: d.text, url: d.url, line: d.lineNumber,
          desc: d.exception && d.exception.description });
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        c.events.push({ type: 'console.error',
          text: (m.params.args || []).map((a) => a.value || a.description || '').join(' ') });
      }
    };
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waits.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.waits.has(id)) { this.waits.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面脚本异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) { } }
}

function api(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (data) headers['Content-Type'] = 'application/json';
    if (token) headers['X-Token'] = token;
    const u = new URL(p, BASE);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: path.join(ROOT, 'data-bughunt'), STORAGE_BACKEND: 'local'
    }),
    stdio: 'ignore'
  });
  let chrome = null;
  const cleanup = () => { try { if (chrome) chrome.kill(); } catch (e) {} try { srv.kill(); } catch (e) {} };
  process.on('exit', cleanup);

  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/version'); if (r.ok) { ready = true; break; } } catch (e) {}
    await sleep(300);
  }
  if (!ready) throw new Error('服务未就绪');

  // 注册两个测试账号并建好友，制造有数据的界面
  const suffix = String(Date.now()).slice(-8);
  const A = 'bha' + suffix;
  const B = 'bhb' + suffix;
  let ra = await api('POST', '/api/register', { username: A, password: 'pass123', nickname: '抓错甲' });
  let rb = await api('POST', '/api/register', { username: B, password: 'pass123', nickname: '抓错乙' });
  const tokenA = ra.json && ra.json.token;
  if (!tokenA) throw new Error('注册失败: ' + JSON.stringify(ra.json));
  // 发一条消息，让消息列表有内容
  await api('POST', '/api/message', { roomId: 'r_public', text: '运行时抓错测试' }, tokenA).catch(() => {});

  const port = 9421;
  const userDir = path.join(ROOT, 'data', 'chrome-bughunt');
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

  // 注入 token 走已登录路径
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(1500);
  await cdp.eval(`localStorage.setItem('ll_token', ${JSON.stringify(tokenA)});`);
  await cdp.send('Page.reload');
  await sleep(2500);

  console.log('=== 逐视图运行时抓错 ===');
  // 通过点击底部导航切换视图，每个视图停留采集
  const views = [
    ['主页', `document.querySelector('[data-view="home"],[data-nav="home"],[data-tab="home"]')`],
    ['房间', `document.querySelector('[data-view="room"],[data-nav="room"],[data-tab="room"]')`],
    ['好友', `document.querySelector('[data-view="friend"],[data-nav="friend"],[data-tab="friend"]')`],
    ['网盘', `document.querySelector('[data-view="drive"],[data-nav="drive"],[data-tab="drive"]')`],
    ['我的', `document.querySelector('[data-view="me"],[data-nav="me"],[data-tab="me"]')`]
  ];

  // 先看看页面有哪些可点的导航元素
  const navs = await cdp.eval(`(function(){
    var out=[]; var els=document.querySelectorAll('[data-view],[data-nav],[data-tab],.tabbar *,nav *');
    for(var i=0;i<Math.min(els.length,40);i++){
      var e=els[i]; out.push({tag:e.tagName, txt:(e.textContent||'').trim().slice(0,10),
        dv:e.getAttribute('data-view'),dn:e.getAttribute('data-nav'),dt:e.getAttribute('data-tab'),oc:!!e.onclick});
    }
    return out;
  })()`);
  console.log('页面导航元素样本:', JSON.stringify(navs.slice(0, 15)));

  // 暴力点击所有带 data-view/data-nav/data-tab 的元素，触发各视图渲染
  const clicked = await cdp.eval(`(function(){
    var els=document.querySelectorAll('[data-view],[data-nav],[data-tab]'); var n=0;
    for(var i=0;i<els.length;i++){ try{ els[i].click(); n++; }catch(e){} }
    return n;
  })()`);
  console.log('已点击导航元素数:', clicked);
  await sleep(2000);

  // 再检查弹层：设置、皮肤、主题、字体
  await cdp.eval(`(function(){
    var kw=['设置','皮肤','主题','字体','外观'];
    var els=document.querySelectorAll('a,button,span,div,[onclick]');
    for(var i=0;i<els.length;i++){
      var t=(els[i].textContent||'').trim();
      for(var k=0;k<kw.length;k++){ if(t===kw[k]||t.indexOf(kw[k])>=0&&t.length<=8){ try{els[i].click();}catch(e){} break; } }
    }
  })()`);
  await sleep(2000);

  // 汇总抓到的错误
  const evs = cdp.events;
  console.log('\n=== 抓到的运行时错误 (' + evs.length + ') ===');
  if (!evs.length) console.log('  （无）');
  evs.slice(0, 30).forEach((e, i) => {
    console.log('  [' + (i + 1) + '] ' + e.type + ': ' + (e.text || '') + (e.url ? ' @ ' + e.url + ':' + e.line : ''));
    if (e.desc) console.log('      ' + e.desc.split('\n').slice(0, 3).join(' | '));
  });

  // 检查页面关键区域是否渲染
  const dom = await cdp.eval(`(function(){
    return { bodyLen: document.body.innerHTML.length,
      msgCount: document.querySelectorAll('.msg').length,
      cardCount: document.querySelectorAll('.card').length,
      skinCards: document.querySelectorAll('.skin-card').length,
      fontOpts: document.querySelectorAll('.font-opt').length,
      hasError: /undefined|NaN|\\[object Object\\]/.test(document.body.textContent) };
  })()`);
  console.log('\nDOM 状态:', JSON.stringify(dom));

  cdp.close();
  cleanup();
  process.exit(evs.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
