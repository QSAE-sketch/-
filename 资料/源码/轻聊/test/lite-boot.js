'use strict';
/**
 * 低配版「启动级」模拟测试 —— 直接复现红米 Note 2 老 WebView 的致命环境。
 *
 * 老设备上标准版为什么按钮全失效：容器没开 DOM Storage，顶层 localStorage
 * 访问抛 SecurityError → 整个 IIFE 中断 → 所有 onclick 都没绑上。
 * 这里用 vm + 极小 DOM mock 跑 app-lite.js，验证：
 *   1) localStorage 抛异常时脚本仍能完整 boot（cookie 兜底）
 *   2) 所有关键按钮都真的绑上了事件（登录 / 发送 / 上传 / 成员 / 导航…）
 *   3) 点击登录确实会发出 XHR 请求
 *   4) 无 Promise / flex / CSS 变量等老内核不支持的特性（由 room-features.js 静态校验）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'public/app-lite.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public/index-lite.html'), 'utf8');
const basicCode = fs.readFileSync(path.join(ROOT, 'public/app-basic.js'), 'utf8');
const basicHtml = fs.readFileSync(path.join(ROOT, 'public/index-basic.html'), 'utf8');
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + String(extra).slice(0, 240) : '')); }
}

function El(id, tag) {
  this.id = id || '';
  this.tagName = String(tag || 'div').toUpperCase();
  this.style = {};
  this.children = [];
  this.attributes = {};
  this.value = '';
  this.textContent = '';
  this.innerHTML = '';
  this.className = '';
  this.onclick = null;
  this.onchange = null;
  this.onkeydown = null;
  this.disabled = false;
  this.files = null;
  this.parentNode = null;
}
El.prototype.appendChild = function (c) { c.parentNode = this; this.children.push(c); return c; };
El.prototype.removeChild = function (c) { return c; };
El.prototype.insertBefore = function (c) { c.parentNode = this; this.children.unshift(c); return c; };
El.prototype.setAttribute = function (k, v) { this.attributes[k] = v; if (k === 'id') this.id = v; };
El.prototype.getAttribute = function (k) { return this.attributes[k] !== undefined ? this.attributes[k] : null; };
El.prototype.getElementsByTagName = function () {
  const out = [];
  const walk = (n) => {
    for (let i = 0; i < n.children.length; i++) { out.push(n.children[i]); walk(n.children[i]); }
  };
  walk(this);
  return out;
};

/** 用指定页面里出现的所有 id 预建 DOM */
function makeEnv(localStorageBroken, htmlSrc, responder) {
  const src = htmlSrc || html;
  const els = {};
  const ids = [];
  src.replace(/id="([^"]+)"/g, (m, id) => { ids.push(id); return m; });
  ids.forEach((id) => { els[id] = new El(id); });

  const sent = [];
  function XHR() { sent.push(this); this.headers = {}; this.readyState = 0; }
  XHR.prototype.open = function (m, p) { this.method = m; this.path = p; };
  XHR.prototype.setRequestHeader = function (k, v) { this.headers[k] = v; };
  XHR.prototype.abort = function () { };
  /* 传入 responder 时同步返回应答，用于覆盖「登录后进主界面」这类完整链路。
     不传就只记录请求，保持原来的「只验证发出去」的语义。 */
  XHR.prototype.send = function (b) {
    this.body = b;
    this.sentBody = b;
    if (typeof responder !== 'function') return;
    var r = null;
    try { r = responder(this.method, this.path, b); } catch (e) { r = null; }
    if (!r) return;
    this.readyState = 4;
    this.status = r.status;
    this.responseText = (typeof r.body === 'string') ? r.body : JSON.stringify(r.body);
    if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
  };
  XHR.prototype.abort = function () { };

  const broken = {
    getItem() { throw new Error('SecurityError: DOM Storage disabled'); },
    setItem() { throw new Error('SecurityError: DOM Storage disabled'); },
    removeItem() { throw new Error('SecurityError: DOM Storage disabled'); }
  };
  const good = {
    _d: {},
    getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
  };

  const doc = {
    cookie: '',
    body: new El('', 'body'),
    documentElement: new El('', 'html'),
    getElementById(id) { return els[id] || null; },
    createElement(tag) { return new El('', tag); },
    getElementsByTagName() { return []; }
  };
  const win = {
    prompt() { return null; },
    confirm() { return false; },
    alert() { },
    scrollTo() { },
    Promise: null,           // 故意不提供：老内核没有 Promise
    CSS: null,               // 故意不提供：老内核没有 CSS.supports
    JSON: JSON,
    location: { search: '', pathname: '/' },
    /* 守门脚本由 HTML 内联提供；测试里手动预置，模拟已执行过 */
    __LL: { err: [], ready: 0, t0: (new Date()).getTime() },
    __LL_LITE: { err: [], ready: 0, t0: (new Date()).getTime() }
  };
  const sandbox = {
    document: doc,
    window: win,
    location: win.location,
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 5.1; Redmi Note 2) Chrome/39.0.0.0' },
    localStorage: localStorageBroken ? broken : good,
    XMLHttpRequest: XHR,
    FileReader: undefined,   // 故意不提供：验证基础版不依赖它
    Uint8Array: Uint8Array,
    JSON: JSON, Math: Math, Date: Date, RegExp: RegExp, Error: Error,
    String: String, Number: Number, Array: Array, Object: Object,
    encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
    parseInt: parseInt, isNaN: isNaN,
    setTimeout() { return 1; }, clearTimeout() { },
    setInterval() { return 1; }, clearInterval() { },
    console: console
  };
  sandbox.globalThis = sandbox;
  return { sandbox, els, sent, XHR, win, doc };
}

/** 在指定环境里执行低配版脚本，返回是否完整跑完 */
function boot(env) {
  let error = null;
  try {
    vm.createContext(env.sandbox);
    vm.runInContext(code, env.sandbox, { timeout: 5000 });
  } catch (e) { error = e; }
  return error;
}

(async () => {
  console.log('\n【低配启动】模拟红米 Note 2 老 WebView');

  // 场景 1：DOM Storage 被禁用（标准版正是死在这里）
  const env = makeEnv(true);
  let err = boot(env);
  check('localStorage 抛 SecurityError 时脚本仍完整执行（无未捕获异常）', !err,
    err && err.stack);
  check('启动后 auth 屏可见', env.els.auth.style.display === 'block',
    env.els.auth.style.display);

  const essential = ['ab', 'acode', 'awb', 'authTabLogin', 'authTabReg',
    'modePassword', 'modeEmail', 'modeOtp', 'modeWb',
    'navPublic', 'navRooms', 'navFriends', 'navMe', 'themeBtn',
    'backBtn', 'memberBtn', 'joinBtn', 'sendBtn',
    'modalCancel', 'modalOk'];
  const missing = essential.filter((id) => typeof env.els[id].onclick !== 'function');
  check('全部关键按钮都已绑定 onclick（' + essential.length + ' 个）',
    missing.length === 0, '未绑定: ' + missing.join(','));
  check('msgInput 回车发送已绑定', typeof env.els.msgInput.onkeydown === 'function');
  check('fileInput 上传已绑定 onchange', typeof env.els.fileInput.onchange === 'function');

  // 场景 2：点击登录 → 真的发出 XHR（不是静态骨架）
  env.els.au.value = 'testuser';
  env.els.ap.value = 'pass123';
  env.els.ab.onclick();
  const loginReq = env.sent.filter((x) => x.method === 'POST' && x.path.indexOf('/api/login') === 0)[0];
  check('点击「登录」实际发出 POST /api/login', !!loginReq,
    env.sent.map((x) => x.method + ' ' + x.path));
  check('登录请求带账号密码且用 UTF-8 字节发送', !!loginReq &&
    loginReq.sentBody && loginReq.sentBody.length > 0 &&
    Buffer.from(loginReq.sentBody).toString().indexOf('testuser') >= 0);

  // 场景 3：localStorage 正常时也能 boot，且 token 走 cookie 兜底
  const env2 = makeEnv(false);
  env2.sandbox.document.cookie = 'll_token=abc123';
  err = boot(env2);
  check('DOM Storage 正常时同样能启动', !err, err && err.stack);
  const meReq = env2.sent.filter((x) => x.path.indexOf('/api/me') >= 0)[0];
  check('cookie 中的 token 能恢复登录态并发 /api/me', !!meReq,
    env2.sent.map((x) => x.path));
  check('/api/me 带上 X-Token 请求头', !!meReq && meReq.headers['X-Token'] === 'abc123',
    meReq && meReq.headers);

  // 场景 4：标准版在同样环境下会崩 —— 反证低配版的必要性
  const stdCode = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const stdEnv = makeEnv(true);
  let stdErr = null;
  try {
    vm.createContext(stdEnv.sandbox);
    vm.runInContext(stdCode, stdEnv.sandbox, { timeout: 5000 });
  } catch (e) { stdErr = e; }
  check('对照：标准版在 DOM Storage 禁用环境确实会初始化中断', !!stdErr,
    stdErr ? stdErr.message : '未中断');
  check('对照：标准版中断后按钮没有 onclick（复现「全部点不动」）',
    typeof stdEnv.els.ab.onclick !== 'function', typeof stdEnv.els.ab.onclick);

  /* ---------------- 场景 5：基础版（第三档兜底） ---------------- */
  console.log('\n【基础版启动】连低配版都跑不动的内核');

  // 同样的恶劣环境：DOM Storage 禁用、没有 FileReader、没有 Promise
  const bEnv = makeEnv(true, basicHtml);
  let bErr = null;
  try {
    vm.createContext(bEnv.sandbox);
    vm.runInContext(basicCode, bEnv.sandbox, { timeout: 5000 });
  } catch (e) { bErr = e; }
  check('基础版在 DOM Storage 禁用 + 无 FileReader 环境仍完整执行', !bErr,
    bErr && bErr.stack);
  check('基础版把初始化标记置为完成（守门脚本据此决定是否降级）',
    bEnv.win.__LL && bEnv.win.__LL.ready === 1, JSON.stringify(bEnv.win.__LL));
  check('基础版无 token 时展示登录屏', bEnv.els.scrAuth.style.display === 'block',
    bEnv.els.scrAuth.style.display);
  check('基础版启动过程没有记录到脚本错误',
    bEnv.win.__LL.err.length === 0, JSON.stringify(bEnv.win.__LL.err).slice(0, 300));

  // HTML 里每一个内联 onclick 引用的方法都必须真的存在（否则就是「点了没反应」）
  const LL = bEnv.win.LL;
  const used = [];
  /* 先抹掉 __LL / __LL_LITE（守门脚本用的全局名），否则会把 LL. 误当成业务方法 */
  const htmlForScan = basicHtml.replace(/__LL_LITE/g, '').replace(/__LL/g, '');
  htmlForScan.replace(/LL\.([A-Za-z_$][\w$]*)/g, (m, n) => {
    if (used.indexOf(n) < 0) used.push(n);
    return m;
  });
  const notFn = used.filter((n) => !LL || typeof LL[n] !== 'function');
  check('HTML 内联 onclick 引用的方法全部存在（' + used.length + ' 个）',
    notFn.length === 0, '缺失: ' + notFn.join(','));
  check('基础版暴露了登录 / 导航 / 发送 / 自检等核心方法',
    typeof LL.doAuth === 'function' && typeof LL.go === 'function' &&
    typeof LL.send === 'function' && typeof LL.showDiag === 'function');

  // 模拟真实点击登录：应发出 POST /api/login
  bEnv.els.inUser.value = 'basicuser';
  bEnv.els.inPass.value = 'pass123';
  LL.doAuth();
  const bLogin = bEnv.sent.filter((x) => x.method === 'POST' && x.path.indexOf('/api/login') === 0)[0];
  check('基础版点「登录」实际发出 POST /api/login', !!bLogin,
    bEnv.sent.map((x) => x.method + ' ' + x.path));
  check('基础版登录请求体是 UTF-8 JSON 且含账号',
    !!bLogin && typeof bLogin.sentBody === 'string' &&
    bLogin.sentBody.indexOf('basicuser') >= 0,
    bLogin && String(bLogin.sentBody).slice(0, 80));

  // 切到注册：昵称输入行应显示
  LL.setMode('reg');
  check('基础版切到注册会显示昵称输入行', bEnv.els.rowNick.style.display === 'block',
    bEnv.els.rowNick.style.display);

  // 自检面板：老内核上点「设备自检」不能抛异常（这是用户唯一能反馈问题的入口）
  let diagErr = null;
  try { LL.showDiag(); } catch (e) { diagErr = e; }
  check('基础版「设备自检」可正常渲染（不抛异常）', !diagErr,
    diagErr && diagErr.message);
  check('自检面板写入了 UA 与初始化状态',
    String(bEnv.els.diag.innerHTML).indexOf('User-Agent') >= 0 &&
    String(bEnv.els.diag.innerHTML).indexOf('初始化完成') >= 0);

  /* ---------------- 场景 6：基础版完整链路（带服务器应答） ---------------- */
  console.log('\n【基础版链路】登录态 → 房间 → 消息渲染');

  const bEnv2 = makeEnv(true, basicHtml, function (m, p) {
    if (/\/api\/me$/.test(p)) {
      return {
        status: 200, body: {
          ok: true, user: {
            id: 'u1', username: 'basicuser', nickname: '红米用户',
            founder: false, master: false, masterUntil: 0, masterRemainMs: 0
          }
        }
      };
    }
    if (/\/api\/version/.test(p)) {
      return { status: 200, body: { ok: true, version: { name: '9.9.9' }, build: 'testbuild' } };
    }
    if (/^\/api\/rooms\/[^/]+\/messages/.test(p)) {
      return {
        status: 200, body: {
          ok: true, lastSeq: 2, canPost: true, muted: false, joined: true, dissolved: false,
          messages: [
            { id: 'm1', kind: 'text', content: '第一条：基础版能看到消息', senderId: 'u2', senderName: '甲', createdAt: 1700000000000, mine: false },
            { id: 'm2', kind: 'text', content: '第二条：列表渲染正常', senderId: 'u2', senderName: '甲', createdAt: 1700000001000, mine: false },
            { id: 'm3', kind: 'system', content: '本群已由甲解散，现仅可查看历史消息', createdAt: 1700000002000 }
          ]
        }
      };
    }
    if (/^\/api\/rooms\/[^/]+$/.test(p)) {
      return {
        status: 200, body: {
          ok: true, room: { id: 'r1', name: '公共聊天室', kind: 'public', joined: true, canPost: true, memberCount: 3 }
        }
      };
    }
    if (/^\/api\/rooms$/.test(p)) {
      return {
        status: 200, body: {
          ok: true,
          rooms: [
            { id: 'r1', name: '公共聊天室', kind: 'public', memberCount: 3, joined: true },
            { id: 'r2', name: '基础版验证群', kind: 'group', memberCount: 2, joined: true }
          ],
          publicRoomId: 'r1'
        }
      };
    }
    return null;
  });
  /* 预置 token，模拟已登录用户直接打开页面 */
  bEnv2.sandbox.document.cookie = 'll_token=tok_basic_123';

  let bErr2 = null;
  try {
    vm.createContext(bEnv2.sandbox);
    vm.runInContext(basicCode, bEnv2.sandbox, { timeout: 5000 });
  } catch (e) { bErr2 = e; }

  check('已登录用户打开基础版无异常', !bErr2, bErr2 && bErr2.stack);
  check('基础版自动切到聊天屏（不再停在「正在加载」）',
    bEnv2.els.scrChat.style.display === 'block' &&
    bEnv2.els.scrMain.style.display === 'none',
    'chat=' + bEnv2.els.scrChat.style.display + ' main=' + bEnv2.els.scrMain.style.display);
  check('顶栏标题变成真实房间名（说明 go/openRoom 链路走通）',
    bEnv2.els.chTitle.textContent === '公共聊天室', bEnv2.els.chTitle.textContent);
  check('消息区渲染出了 2 条普通消息',
    String(bEnv2.els.chMsgs.innerHTML).indexOf('第一条：基础版能看到消息') >= 0 &&
    String(bEnv2.els.chMsgs.innerHTML).indexOf('第二条：列表渲染正常') >= 0,
    String(bEnv2.els.chMsgs.innerHTML).slice(0, 120));
  check('系统通知以独立样式渲染（不是普通气泡）',
    String(bEnv2.els.chMsgs.innerHTML).indexOf('msys') >= 0 &&
    String(bEnv2.els.chMsgs.innerHTML).indexOf('本群已由甲解散') >= 0);
  check('输入框在可发言状态下未被禁用', bEnv2.els.inMsg.disabled === false,
    bEnv2.els.inMsg.disabled);
  check('链路过程没有记录脚本错误（ReferenceError 会让页面卡住）',
    bEnv2.win.__LL.err.length === 0, JSON.stringify(bEnv2.win.__LL.err).slice(0, 300));

  // 发消息：应发出 POST，并把输入框清空
  bEnv2.els.inMsg.value = '基础版发出去的消息';
  let sendErr = null;
  try { bEnv2.win.LL.send(); } catch (e) { sendErr = e; }
  const postMsg = bEnv2.sent.filter((x) => x.method === 'POST' && /\/messages$/.test(x.path))[0];
  check('基础版点「发送」实际发出 POST 消息请求', !sendErr && !!postMsg,
    sendErr ? sendErr.message : bEnv2.sent.map((x) => x.method + ' ' + x.path));
  check('发送后输入框被清空', bEnv2.els.inMsg.value === '', bEnv2.els.inMsg.value);

  console.log('\n【基础版路由】不调用服务端不存在的接口');

  /* 路由来源：server.js + src/*.js（网盘路由注册在 src/drive.js 里） */
  const routeDefs = [];
  {
    const routeFiles = [path.join(ROOT, 'server.js')];
    const srcDir = path.join(ROOT, 'src');
    let files = [];
    try { files = fs.readdirSync(srcDir); } catch (e) { files = []; }
    files.forEach((f) => { if (/\.js$/.test(f)) routeFiles.push(path.join(srcDir, f)); });

    routeFiles.forEach((file) => {
      let s = '';
      try { s = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
      const re = /route\('([A-Z]+)',\s*'([^']+)'/g;
      let m;
      while ((m = re.exec(s))) routeDefs.push({ method: m[1], path: m[2] });
    });
  }

  /** 按 URL 段比较：字面量段必须相等，变量段（:id 或 *）互相通配 */
  function segOf(p) { return String(p).split('/'); }
  function isVarSeg(s) { return s.charAt(0) === ':' || s === '*'; }
  function shapeMatch(a, b) {
    const A = segOf(a), B = segOf(b);
    if (A.length !== B.length) return false;
    for (let i = 0; i < A.length; i++) {
      if (isVarSeg(A[i]) || isVarSeg(B[i])) continue;
      if (A[i] !== B[i]) return false;
    }
    return true;
  }

  const badCalls = [];
  {
    /* 抓取 api('METHOD', <表达式>, ...) 里的字面量片段；
       拼接处用 * 占位，纯变量的调用无法静态判断，跳过 */
    const re = /api\('([A-Z]+)',\s*([^,\n]+),/g;
    let m;
    while ((m = re.exec(basicCode))) {
      const method = m[1];
      const expr = m[2];
      if (expr.indexOf('withShare') >= 0) continue;
      const lits = [];
      const litRe = /'([^']*)'/g;
      let l;
      while ((l = litRe.exec(expr))) lits.push(l[1]);
      if (!lits.length) continue;

      let pattern = lits.join('*');
      if (expr.indexOf('+') >= 0 && pattern.charAt(pattern.length - 1) === '/') pattern += '*';

      /* 三元表达式（如 reg ? '/api/register' : '/api/login'）：
         每个分支都是完整路径，任一支能对上就通过 */
      let hit;
      if (expr.indexOf('?') >= 0) {
        hit = lits.some((one) => routeDefs.some((r) => r.method === method && shapeMatch(r.path, one)));
      } else {
        hit = routeDefs.some((r) => r.method === method && shapeMatch(r.path, pattern));
      }
      if (!hit) badCalls.push(method + ' ' + pattern);
    }
  }
  check('基础版调用的接口在服务端全部真实存在（不是 404）',
    badCalls.length === 0, '不存在的调用: ' + badCalls.join(' | '));

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
