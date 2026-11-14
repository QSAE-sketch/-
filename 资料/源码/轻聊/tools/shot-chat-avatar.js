'use strict';
/**
 * 线上视觉终检（headless Chrome + CDP 直连）：
 *   1. 登录真实线上站点（注入 token）
 *   2. 进入公共聊天室
 *   3. 点消息头像 → 断言资料页可见、聊天页已隐藏
 *   4. 返回 → 断言回到聊天页
 *   5. 截图聊天页 / 资料页
 *
 * 用法：node tools/shot-chat-avatar.js
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
const OUT = path.join(ROOT, 'public');
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

/* ---------------- CDP 客户端 ---------------- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); this.events = []; }
  static async connect(port) {
    const list = await new Promise((res, rej) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/list' }, (r) => {
        let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
      });
      req.on('error', rej);
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
      } else if (m.method) c.events.push(m);
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
  const stamp = Date.now().toString(36).slice(-6);
  const A = 'sa' + stamp, B = 'sb' + stamp;
  let r = await req('POST', '/api/register', { username: A, password: 'pass123', nickname: '林小满' });
  if (!r.json || !r.json.token) { console.error('注册 A 失败', JSON.stringify(r.json)); process.exit(1); }
  const ta = r.json.token;
  r = await req('POST', '/api/register', { username: B, password: 'pass123', nickname: '陈知远' });
  if (!r.json || !r.json.token) { console.error('注册 B 失败', JSON.stringify(r.json)); process.exit(1); }
  const tb = r.json.token;

  const rooms = await req('GET', '/api/rooms', null, tb);
  const pub = rooms.json.rooms.find((x) => x.kind === 'public');
  const msg = '在公共聊天室看到你的消息，加个好友吧';
  await req('POST', '/api/rooms/' + pub.id + '/messages', { kind: 'text', content: msg }, tb);
  console.log('准备就绪：A=' + A + ' B=' + B + '（公共聊天室已有一条对方消息）');

  // 启动 Chrome（带远程调试端口）
  const port = 9333;
  const userDir = path.join(ROOT, 'data', 'chrome-shot-' + stamp);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', '--remote-debugging-port=' + port,
    '--window-size=400,800', '--force-device-scale-factor=1',
    '--user-data-dir=' + userDir,
    'about:blank'
  ], { stdio: 'ignore' });

  const cleanup = () => { try { chrome.kill(); } catch (e) { /* ignore */ } };
  process.on('exit', cleanup);

  // 等 CDP 端口就绪
  let cdp = null;
  for (let i = 0; i < 60; i++) {
    try { cdp = await CDP.connect(port); break; } catch (e) { await sleep(300); }
  }
  if (!cdp) { console.error('Chrome / CDP 未就绪'); cleanup(); process.exit(1); }

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 注入 token 并进入站点
  await cdp.send('Page.navigate', { url: BASE + '/?sharecode=' + SHARE_CODE });
  await sleep(3000);
  await cdp.eval('localStorage.setItem("ll_token",' + JSON.stringify(ta) + '); location.reload();');
  await sleep(4000);

  const state = await cdp.eval('(function(){return {hasView:!!document.getElementById("view"),' +
    'user:(document.getElementById("tbUser")||{}).textContent||""};})()');
  console.log('登录状态：' + JSON.stringify(state));

  // 进入公共聊天室
  await cdp.eval('(function(){var r=document.querySelector("[data-open]");if(r)r.click();return !!r;})()');
  await sleep(2500);

  // 找到对方那条消息的头像（发送者不是自己）
  const avInfo = await cdp.eval('(function(){' +
    'var msgs=document.getElementById("msgs");if(!msgs)return null;' +
    'var nodes=msgs.querySelectorAll(".msg");' +
    'for(var i=0;i<nodes.length;i++){' +
    '  var t=nodes[i].textContent||"";' +
    '  if(t.indexOf(' + JSON.stringify(msg) + ')<0)continue;' +
    '  var av=nodes[i].querySelector(".av");' +
    '  if(!av)continue;' +
    '  var r=av.getBoundingClientRect();' +
    '  return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),text:t.slice(0,60)};' +
    '}' +
    'return null;})()');
  console.log('对方消息头像位置：' + JSON.stringify(avInfo));
  if (!avInfo) { console.error('✗ 没找到对方消息的头像'); cdp.close(); cleanup(); process.exit(1); }

  await cdp.shot(path.join(OUT, '_shot-chat-page.png'));
  console.log('✓ 截图：public/_shot-chat-page.png');

  // 点头像
  await cdp.eval('(function(){var msgs=document.getElementById("msgs");var nodes=msgs.querySelectorAll(".msg");' +
    'for(var i=0;i<nodes.length;i++){var t=nodes[i].textContent||"";' +
    'if(t.indexOf(' + JSON.stringify(msg) + ')<0)continue;var av=nodes[i].querySelector(".av");if(av){av.click();return true;}}' +
    'return false;})()');
  await sleep(2000);

  const after = await cdp.eval('(function(){' +
    'var fa=document.getElementById("friendAdd"),ch=document.getElementById("chat"),mn=document.getElementById("main");' +
    'return {profileShown:!!(fa&&fa.className.indexOf("hide")<0),' +
    'chatHidden:!!(ch&&ch.className.indexOf("hide")>=0),' +
    'mainHidden:!!(mn&&mn.className.indexOf("hide")>=0),' +
    'profileText:fa?fa.textContent.replace(/\\s+/g," ").slice(0,160):""};})()');
  console.log('点头像后：' + JSON.stringify(after));
  if (!after.profileShown) { console.error('✗ 资料页没有打开'); cdp.close(); cleanup(); process.exit(1); }
  if (!after.chatHidden) { console.error('✗ 聊天页没有被隐藏（历史 bug：资料页会被挤出屏幕）'); cdp.close(); cleanup(); process.exit(1); }
  console.log('✓ 聊天页点头像 → 资料页正常打开，聊天页同步隐藏');

  await cdp.shot(path.join(OUT, '_shot-profile-page.png'));
  console.log('✓ 截图：public/_shot-profile-page.png');

  // 返回 → 应回到聊天页
  await cdp.eval('(function(){var b=document.getElementById("faBackBtn");if(b)b.click();return !!b;})()');
  await sleep(1500);
  const back = await cdp.eval('(function(){var fa=document.getElementById("friendAdd"),ch=document.getElementById("chat");' +
    'return {profileHidden:!!(fa&&fa.className.indexOf("hide")>=0),' +
    'chatShown:!!(ch&&ch.className.indexOf("hide")<0)};})()');
  console.log('返回后：' + JSON.stringify(back));
  if (!back.profileHidden || !back.chatShown) {
    console.error('✗ 返回没有回到聊天页');
    cdp.close(); cleanup(); process.exit(1);
  }
  console.log('✓ 返回按钮正确回到原聊天页');

  // 好友页
  await cdp.eval('(function(){var n=document.querySelector("[data-view=\\"friends\\"]");if(n)n.click();return !!n;})()');
  await sleep(1500);
  await cdp.shot(path.join(OUT, '_shot-friends-page.png'));
  console.log('✓ 截图：public/_shot-friends-page.png');

  const fr = await cdp.eval('(function(){var v=document.getElementById("view");return v?v.textContent.replace(/\\s+/g," ").slice(0,200):"";})()');
  console.log('好友页内容：' + fr);

  cdp.close();
  cleanup();
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log('\n线上视觉终检全部通过');
  process.exit(0);
})().catch((e) => { console.error('验证异常:', e && e.message); process.exit(1); });
