'use strict';
/**
 * bug-fixer 交互抓错器：真实点击「皮肤星标 / 字体切换」按钮，
 * 走完整闭环（点击→写盘→刷新→UI生效），抓运行时异常 + 验证行为。
 * 用法：node tools/bug-hunt-interact.js
 */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3412;
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
        c.events.push({ type: 'JS异常', text: d.text, desc: d.exception && d.exception.description });
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        c.events.push({ type: 'console.error', text: (m.params.args || []).map((a) => a.value || a.description || '').join(' ') });
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
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: path.join(ROOT, 'data-bughunt2'), STORAGE_BACKEND: 'local'
    }), stdio: 'ignore'
  });
  let chrome = null;
  const cleanup = () => { try { if (chrome) chrome.kill(); } catch (e) {} try { srv.kill(); } catch (e) {} };
  process.on('exit', cleanup);

  let ready = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/version'); if (r.ok) { ready = true; break; } } catch (e) {} await sleep(300); }
  if (!ready) throw new Error('服务未就绪');

  const suffix = String(Date.now()).slice(-8);
  const A = 'bhi' + suffix;
  const ra = await api('POST', '/api/register', { username: A, password: 'pass123', nickname: '交互甲' });
  const token = ra.json && ra.json.token;
  if (!token) throw new Error('注册失败: ' + JSON.stringify(ra.json));

  const port = 9422;
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', '--remote-debugging-port=' + port,
    '--window-size=430,1000', '--force-device-scale-factor=2',
    '--user-data-dir=' + path.join(ROOT, 'data', 'chrome-bughunt2'), 'about:blank'
  ], { stdio: 'ignore' });
  let cdp = null;
  for (let i = 0; i < 60; i++) { try { cdp = await CDP.connect(port); break; } catch (e) { await sleep(300); } }
  if (!cdp) throw new Error('Chrome / CDP 未就绪');
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

  let pass = 0, fail = 0;
  const check = (name, ok, detail) => { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (detail === undefined ? '' : ' → ' + JSON.stringify(detail))); } };

  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(1500);
  await cdp.eval(`localStorage.setItem('ll_token', ${JSON.stringify(token)});`);
  await cdp.send('Page.reload');
  await sleep(2500);

  console.log('=== 皮肤中心：真实点击星标 ===');
  // 点击主页的皮肤入口
  await cdp.eval(`(function(){ var e=document.querySelector('[data-skin-open]'); if(e) e.click(); })()`);
  await sleep(2000);
  const skinCount = await cdp.eval(`document.querySelectorAll('.skin-card').length`);
  check('皮肤列表渲染出卡片', skinCount > 5, { skinCount });

  // 找一张非第一张的卡片，点它的星标
  const before = await cdp.eval(`(function(){
    var cards=document.querySelectorAll('.skin-card');
    var target=cards[3];
    return { title: target && target.querySelector('.r-title') && target.querySelector('.r-title').textContent.trim().slice(0,20),
      starText: target && target.querySelector('[data-skin-star]') && target.querySelector('[data-skin-star]').textContent.trim() };
  })()`);
  console.log('  目标卡片:', JSON.stringify(before));

  // 点第 4 张卡的星标（索引3）
  await cdp.eval(`(function(){
    var cards=document.querySelectorAll('.skin-card'); var target=cards[3];
    var s=target&&target.querySelector('[data-skin-star]'); if(s) s.click();
  })()`);
  await sleep(800);
  const afterClick = await cdp.eval(`(function(){
    var stars=JSON.parse(localStorage.getItem('ll_skin_stars')||'[]');
    var firstCard=document.querySelector('.skin-card .r-title');
    return { stars: stars, firstCard: firstCard&&firstCard.textContent.trim().slice(0,20) };
  })()`);
  console.log('  点星标后:', JSON.stringify(afterClick));
  check('星标写入 localStorage', afterClick.stars && afterClick.stars.length >= 1, afterClick);

  // 刷新 + 重新打开皮肤中心，验证置顶
  await cdp.send('Page.reload');
  await sleep(2500);
  await cdp.eval(`(function(){ var e=document.querySelector('[data-skin-open]'); if(e) e.click(); })()`);
  await sleep(2000);
  const afterReload = await cdp.eval(`(function(){
    var cards=document.querySelectorAll('.skin-card');
    var out=[];
    for(var i=0;i<Math.min(cards.length,5);i++){ var t=cards[i].querySelector('.r-title'); out.push(t&&t.textContent.trim().slice(0,20)); }
    // 跳过第 0 张「默认外观」固定卡，看第一张真实皮肤卡是否 starred
    var firstReal = cards[1];
    return { top5: out, starredFirst: firstReal&&firstReal.classList.contains('starred'),
      firstRealTitle: firstReal&&firstReal.querySelector('.r-title')&&firstReal.querySelector('.r-title').textContent.trim().slice(0,20) };
  })()`);
  console.log('  刷新后 top5:', JSON.stringify(afterReload));
  check('刷新后星标皮肤置顶（首张皮肤卡 starred）', afterReload.starredFirst === true, afterReload);

  console.log('\n=== 设置页：真实点击字体 ===');
  // 关皮肤弹层 → 切到「我的」视图 → 点「设置」入口
  await cdp.eval(`(function(){
    var btns=document.querySelectorAll('[data-close],[data-act-close],.modal-close,.close');
    for(var i=0;i<btns.length;i++){ try{btns[i].click();}catch(e){} }
    var me=document.querySelector('[data-view="me"]'); if(me) me.click();
  })()`);
  await sleep(1200);
  await cdp.eval(`(function(){ var e=document.querySelector('[data-go="settings"]'); if(e) e.click(); })()`);
  await sleep(1800);
  const fontOpts = await cdp.eval(`document.querySelectorAll('.font-opt').length`);
  check('设置页渲染出字体按钮', fontOpts >= 5, { fontOpts });

  if (fontOpts >= 5) {
    // 点第 3 个字体（楷体）
    await cdp.eval(`(function(){ var o=document.querySelectorAll('.font-opt'); if(o[2]) o[2].click(); })()`);
    await sleep(600);
    const fontState = await cdp.eval(`(function(){
      return { key: localStorage.getItem('ll_font'), attr: document.documentElement.getAttribute('data-font'),
        inline: document.documentElement.style.getPropertyValue('--font-ui') };
    })()`);
    console.log('  点字体后:', JSON.stringify(fontState));
    check('字体点击后写盘', !!fontState.key, fontState);
    check('字体点击后属性生效', fontState.attr === fontState.key && !!fontState.inline, fontState);
  }

  console.log('\n=== 运行时错误 (' + cdp.events.length + ') ===');
  cdp.events.slice(0, 20).forEach((e, i) => console.log('  [' + (i+1) + '] ' + e.type + ': ' + (e.text||'') + (e.desc?' | '+e.desc.split('\n')[0]:'')));
  check('无运行时异常', cdp.events.length === 0, cdp.events.slice(0,3));

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  cdp.close(); cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
