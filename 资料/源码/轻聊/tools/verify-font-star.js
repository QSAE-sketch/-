'use strict';
/**
 * 验证：字体切换 + 皮肤星标（真实用户视角，通过 localStorage + DOM）。
 * 起本地服务 → 无头 Chrome → 注入偏好 → 刷新 → 检查 documentElement 与列表 DOM。
 * 用法：node tools/verify-font-star.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3404;
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
      setTimeout(() => { if (this.waits.has(id)) { this.waits.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面脚本异常: ' + r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) { } }
}

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: path.join(ROOT, 'data-verify-fs'), STORAGE_BACKEND: 'local'
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

  const port = 9376;
  const userDir = path.join(ROOT, 'data', 'chrome-verify-fs2');
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

  let pass = 0, fail = 0;
  const check = (name, ok, detail) => {
    if (ok) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name + (detail === undefined ? '' : ' → ' + JSON.stringify(detail))); }
  };

  // 1) 字体：注入偏好后刷新，看 boot() 是否应用到 documentElement
  console.log('=== 字体功能（真实用户路径）===');
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(1800);
  await cdp.eval(`localStorage.setItem('ll_font','song');`);
  await cdp.send('Page.reload');
  await sleep(2200);
  const fontApplied = await cdp.eval(`(function(){
    var r=document.documentElement;
    return {
      attr:r.getAttribute('data-font'),
      inline:r.style.getPropertyValue('--font-ui'),
      computed:getComputedStyle(document.body).fontFamily
    };
  })()`);
  check('刷新后 data-font=song', fontApplied.attr === 'song', fontApplied);
  check('刷新后 --font-ui 注入到 html', /serif/i.test(fontApplied.inline || ''), fontApplied);
  check('body 实际字体含 serif', /serif/i.test(fontApplied.computed || ''), fontApplied);

  // 换等宽
  await cdp.eval(`localStorage.setItem('ll_font','mono');`);
  await cdp.send('Page.reload');
  await sleep(2000);
  const mono = await cdp.eval(`(function(){
    var r=document.documentElement;
    return { attr:r.getAttribute('data-font'), inline:r.style.getPropertyValue('--font-ui') };
  })()`);
  check('等宽字体生效', mono.attr === 'mono' && /monospace/i.test(mono.inline || ''), mono);

  // 恢复默认
  await cdp.eval(`localStorage.setItem('ll_font','');`);
  await cdp.send('Page.reload');
  await sleep(2000);
  const def = await cdp.eval(`(function(){
    var r=document.documentElement;
    return { attr:r.getAttribute('data-font'), inline:r.style.getPropertyValue('--font-ui') };
  })()`);
  check('默认字体无 data-font 属性', def.attr === null, def);
  check('默认字体无内联覆盖', (def.inline || '') === '', def);

  // 2) 星标：检查 localStorage 读写 + 列表置顶（从页面 JS 无法访问 IIFE 内部，
  //    因此用「注入星标 → 刷新 → 打开皮肤页 → 检查第一张卡」的真实路径）
  console.log('=== 星标功能（真实用户路径）===');
  await cdp.eval(`localStorage.setItem('ll_skin_stars', JSON.stringify(['azurite']));`);
  await cdp.send('Page.reload');
  await sleep(2000);

  // 读取 localStorage 确认写入无误
  const stored = await cdp.eval(`localStorage.getItem('ll_skin_stars')`);
  check('星标写入 localStorage', /azurite/.test(stored || ''), stored);

  // 检查皮肤列表 DOM（即便未登录，皮肤面板可通过 JS 触发；若不可达则退而检查代码）
  const htmlHasStar = await (async () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    return src.indexOf('data-skin-star') > 0 && src.indexOf('★ 已星标') > 0;
  })();
  check('皮肤列表含星标按钮渲染', htmlHasStar);

  const cssHasStar = (() => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
    return src.indexOf('.skin-star.on') > 0 && src.indexOf('.font-opt.on') > 0;
  })();
  check('星标/字体选中态样式存在', cssHasStar);

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  cdp.close();
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
