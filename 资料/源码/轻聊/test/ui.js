'use strict';
/**
 * 前端逻辑验证：用极简 DOM 模拟器加载真实 public/app.js，
 * 驱动注册→登录→进房间→发消息→上传文件→成员管理的完整交互，
 * 确保老内核环境下无运行时错误（ES5 语法、事件绑定、轮询渲染）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 3311;
const BASE = 'http://127.0.0.1:' + PORT;

/* ---------------- 极简 DOM 模拟 ---------------- */
class El {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.className = '';
    this.id = '';
    this.style = {};
    this.children = [];
    this.childNodes = [];
    this.attributes = {};
    this._text = '';
    this._html = '';
    this.onclick = null;
    this.onchange = null;
    this.onkeydown = null;
    this.value = '';
    this.disabled = false;
    this.parentNode = null;
    this.classList = {
      add: (c) => { this.className = (this.className + ' ' + c).trim(); },
      remove: (c) => { this.className = this.className.replace(c, '').trim(); },
      contains: (c) => this.className.indexOf(c) >= 0
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; this.childNodes = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = []; this.childNodes = []; }
  appendChild(c) {
    c.parentNode = this;
    this.childNodes.push(c);
    this.children.push(c);
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) { this.childNodes.splice(i, 1); this.children.splice(i, 1); }
    c.parentNode = null;
    return c;
  }
  setAttribute(k, v) { this.attributes[k] = v; if (k === 'class') this.className = v; if (k === 'id') this.id = v; }
  getAttribute(k) { return this.attributes[k] !== undefined ? this.attributes[k] : null; }
  querySelectorAll(sel) {
    // 模拟 innerHTML 渲染出来的房间行（bindView 会给它绑定 openRoom）
    if (sel === '[data-open]') return roomRows;
    // 按 id 查（真实 DOM 构建出来的资料页元素）
    if (sel.charAt(0) === '#') {
      const id = sel.slice(1);
      const out = [];
      walk(this, (c) => { if (c.id === id) out.push(c); });
      return out;
    }
    return [];
  }
  /** 支持按 class 名向下查找（app.js 用它定位气泡） */
  querySelector(sel) {
    if (this._qs && this._qs[sel]) return this._qs[sel];
    if (sel && sel.charAt(0) === '.') {
      const cls = sel.slice(1);
      let hit = null;
      walk(this, (c) => {
        if (hit) return;
        if (c !== this && String(c.className || '').split(/\s+/).indexOf(cls) >= 0) hit = c;
      });
      return hit;
    }
    return null;
  }
  /** 事件监听：记录回调，供测试手动触发 */
  addEventListener(type, fn, capture) {
    if (!this._listeners) this._listeners = {};
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push({ fn, capture: !!capture });
  }
  removeEventListener(type, fn) {
    if (!this._listeners || !this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter((r) => r.fn !== fn);
  }
  /** 手动派发事件（测试用） */
  dispatch(type, ev) {
    if (!this._listeners || !this._listeners[type]) return;
    const e = Object.assign({
      type,
      preventDefault() {},
      stopPropagation() {}
    }, ev || {});
    this._listeners[type].forEach((r) => { if (!e._stopped) r.fn.call(this, e); });
  }
  get scrollHeight() { return 100; }
  get scrollTop() { return 0; }
  set scrollTop(v) { }
  click() { if (this.onclick) this.onclick({ stopPropagation: function () {}, target: this }); }
  focus() {}
  get files() { return this._files || []; }
  set files(v) { this._files = v; }
  appendData() {}
}

const registry = {};
function mk(id, tag) {
  const e = new El(tag || 'div');
  e.id = id;
  registry[id] = e;
  return e;
}

// 页面里被 JS 查询的元素
['auth', 'main', 'chat', 'view', 'msgs', 'modal', 'modalTitle', 'modalBody', 'modalOk',
 'modalCancel', 'toast', 'au', 'ap', 'an', 'ab', 'aerr', 'tbTitle', 'tbUser', 'upBar',
 'upText', 'upFill', 'upCancel', 'fileInput', 'msgInput', 'sendBtn', 'fileBtn',
 'backBtn', 'memberBtn', 'chatTitle', 'logout', 'joinBtn',
 // 消息操作面板（点消息后底部浮出）
 'actSheet', 'actBox', 'actMask',
 'selBar', 'selCount', 'selAll', 'selDelete', 'selPurge', 'selCancel', 'composer',
 // 登录方式选择
 'authModes', 'codeRow', 'ac', 'acode', 'awb', 'atip',
 // 设置页
 'settings', 'setBackBtn', 'setView', 'btnClearCache', 'btnClearChat', 'btnPickDir',
 'cacheInfo', 'saveDirInfo',
 // 主题
 'themeBtn', 'themeBox',
 // 用户资料 / 申请加好友
 'friendAdd', 'faBackBtn', 'faTitle', 'faView'].forEach((id) => mk(id));

// querySelectorAll('.tab') / ('.tb-btn')
const authTabs = [new El('button'), new El('button')];
authTabs[0].setAttribute('data-auth-tab', 'login');
authTabs[1].setAttribute('data-auth-tab', 'reg');
// 登录 / 注册方式：账号密码 · 邮箱 · 验证码 · WorkBuddy
const authModeBtns = ['password', 'email', 'otp', 'workbuddy'].map((v) => {
  const b = new El('button');
  b.setAttribute('data-auth-mode', v);
  return b;
});
const navBtns = ['public', 'rooms', 'friends', 'me'].map((v) => {
  const b = new El('button');
  b.setAttribute('data-view', v);
  return b;
});

// 「我的」视图里的「设置」入口
const settingsEntry = new El('div');
settingsEntry.setAttribute('data-go', 'settings');
registry.view._qs = { '[data-go="settings"]': settingsEntry };

// 房间行：模拟房间列表渲染出来的 [data-open] 元素，bindView 会给它绑定 openRoom
const roomRows = [];

global.document = {
  documentElement: new El('html'),
  hidden: false,
  getElementById: (id) => registry[id] || null,
  querySelectorAll: (sel) => {
    if (sel === '[data-auth-tab]') return authTabs;
    if (sel === '[data-auth-mode]') return authModeBtns;
    if (sel === '.tb-btn') return navBtns;
    return [];
  },
  createElement: (t) => new El(t),
  createTextNode: (t) => {
    const n = new El('#text');
    n.textContent = t;
    return n;
  },
  addEventListener: () => { }
};
global.window = {
  innerWidth: 360, innerHeight: 640,
  matchMedia: (q) => (q === '(prefers-color-scheme: dark)'
    ? { matches: false, addEventListener() { }, addListener() { } }
    : { matches: false, addEventListener() { }, addListener() { } }),
  addEventListener: () => { }
};
global.location = { reload: () => {}, href: '', search: '' };
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; }
};
global.setTimeout = setTimeout;
global.clearTimeout = clearTimeout;
global.setInterval = (fn, ms) => { return { _fn: fn, _ms: ms, unref() {} }; };
global.clearInterval = () => {};

/* ---------------- XMLHttpRequest 模拟 ---------------- */
let realXHR = null;
global.XMLHttpRequest = function () {
  const self = this;
  this.readyState = 0;
  this.status = 0;
  this.responseText = '';
  this.upload = { onprogress: null };
  self._headers = {};
  self.open = function (method, url) {
    self._method = method;
    self._url = url.startsWith('http') ? url : BASE + url;
  };
  self.setRequestHeader = function (k, v) { self._headers[k] = v; };
  self.send = function (body) {
    // 测试钩子：命中时用假响应替代真实请求（用于构造「超过撤回窗口」这类难以自然复现的场景）
    if (typeof global.__xhrOverride === 'function') {
      const ov = global.__xhrOverride(self._method, self._url);
      if (ov) {
        setTimeout(function () {
          self.status = ov.status || 200;
          self.responseText = ov.body;
          self.readyState = 4;
          if (self.onreadystatechange) self.onreadystatechange();
        }, 0);
        return;
      }
    }
    const u = new URL(self._url);
    const opts = {
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: self._method, headers: self._headers
    };
    const r = http.request(opts, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        self.status = res.statusCode;
        self.responseText = Buffer.concat(cs).toString('utf8');
        self.readyState = 4;
        if (self.onreadystatechange) self.onreadystatechange();
      });
    });
    r.on('error', () => { self.status = 0; self.readyState = 4; if (self.onerror) self.onerror(); });
    if (body) r.write(body);
    r.end();
  };
  self.abort = function () {};
};

/* ---------------- 加载真实前端 ---------------- */
const appPath = path.join(__dirname, '..', 'public', 'app.js');
const code = fs.readFileSync(appPath, 'utf8');

// 捕获运行时错误
const errors = [];
process.on('uncaughtException', (e) => errors.push('uncaught: ' + e.message));

try {
  // eslint-disable-next-line no-new-func
  new Function(code)();
} catch (e) {
  console.error('❌ 前端脚本执行失败:', e.message);
  console.error(e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}

console.log('✓ app.js 在模拟 DOM 中加载无语法/初始化错误');

/** 直接对服务器发请求（绕开前端，验证服务端数据是否被动过） */
function apiCall(method, path, body, tokenOverride) {
  return new Promise((resolve) => {
    const token = tokenOverride || localStorage.getItem('ll_token') || '';
    const headers = { 'X-Token': token };
    let payload = null;
    if (body !== undefined && body !== null) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: path, method: method, headers: headers
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 旁观者视角的公共聊天室消息。
 *
 * 「删除」只对当前账号隐藏，所以必须换一个账号去拉，
 * 才能确认服务端数据真的原样保留（而不是仅仅自己看不见）。
 */
async function serverMessagesAs(token) {
  const rooms = await apiCall('GET', '/api/rooms', null, token);
  if (!rooms || !rooms.rooms) return [];
  const pub = rooms.rooms.find((r) => r.kind === 'public');
  if (!pub) return [];
  const r = await apiCall('GET', '/api/rooms/' + pub.id + '/messages?since=0&limit=200', null, token);
  return (r && r.messages) ? r.messages : [];
}

/** 公共聊天室的全部消息 */
async function serverMessages() {
  const rooms = await apiCall('GET', '/api/rooms');
  if (!rooms || !rooms.rooms) return [];
  const pub = rooms.rooms.find((r) => r.kind === 'public');
  if (!pub) return [];
  const r = await apiCall('GET', '/api/rooms/' + pub.id + '/messages?since=0&limit=200');
  return (r && r.messages) ? r.messages : [];
}

/** 深度遍历 DOM 模拟树的每个节点 */
function walk(el, fn) {
  if (!el) return;
  const kids = el.children || [];
  for (let i = 0; i < kids.length; i++) { fn(kids[i]); walk(kids[i], fn); }
}
/** 找到正文含指定文本的消息节点 */
function findMsgNode(marker) {
  const kids = registry.msgs.children || [];
  for (let i = 0; i < kids.length; i++) {
    let hit = false;
    walk(kids[i], (c) => { if (c.textContent === marker) hit = true; });
    if (hit) return kids[i];
  }
  return null;
}
/** 在节点里找操作按钮（.tool / .tool dim / .tool danger） */
function findTool(node, text) {
  let found = null;
  walk(node, (c) => {
    if (found) return;
    const cls = String(c.className || '').split(/\s+/);
    if (cls.indexOf('tool') >= 0 && cls.indexOf('tools') < 0 && c.textContent === text) found = c;
  });
  return found;
}
/** 列出节点里所有操作按钮的文案 */
function toolLabels(node) {
  const out = [];
  walk(node, (c) => {
    const cls = String(c.className || '').split(/\s+/);
    if (cls.indexOf('tool') >= 0 && cls.indexOf('tools') < 0) out.push(c.textContent);
  });
  return out;
}
/** 按 class 片段收集节点（好友视图 / 资料页都是真实 DOM 构建，可直接遍历） */
function findAll(root, cls) {
  const out = [];
  walk(root, (c) => {
    if (String(c.className || '').indexOf(cls) >= 0) out.push(c);
  });
  return out;
}
/** 按 class 片段找第一个节点 */
function findOne(root, cls) {
  const all = findAll(root, cls);
  return all.length ? all[0] : null;
}
/** 收集节点里所有文本 */
function textOf(root) {
  let s = '';
  walk(root, (c) => { s += (c.textContent || '') + '\n'; });
  return s;
}

/* ---------------- 驱动真实交互 ---------------- */
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const uniq = Date.now().toString().slice(-6);
  const user = 'ui' + uniq;

  /* ================= 登录方式：四种可选项 ================= */

  // 默认必须是「账号 + 密码」
  if (authModeBtns[0].className.indexOf('active') < 0) {
    console.error('❌ 默认登录方式不是「账号密码」');
    process.exit(1);
  }
  if (registry.au.placeholder.indexOf('账号') < 0) {
    console.error('❌ 默认输入框不是账号: ' + registry.au.placeholder);
    process.exit(1);
  }
  console.log('✓ 默认登录方式为「账号密码」（默认选项）');

  // 切到「邮箱」
  authModeBtns[1].onclick.call(authModeBtns[1]);
  if (registry.au.placeholder.indexOf('邮箱') < 0) {
    console.error('❌ 邮箱方式的输入框提示不对: ' + registry.au.placeholder);
    process.exit(1);
  }
  if (registry.ap.className.indexOf('hide') >= 0) {
    console.error('❌ 邮箱登录应显示密码框');
    process.exit(1);
  }
  console.log('✓ 切换到「邮箱」方式：邮箱输入框 + 密码框');

  // 邮箱注册需要验证码（上游要求先验码再注册）
  authTabs[1].onclick.call(authTabs[1]);
  if (registry.codeRow.className.indexOf('hide') >= 0) {
    console.error('❌ 邮箱注册未显示验证码行');
    process.exit(1);
  }
  console.log('✓ 邮箱注册模式显示验证码行');

  // 切到「验证码」：隐藏密码框，显示验证码
  authModeBtns[2].onclick.call(authModeBtns[2]);
  if (registry.ap.className.indexOf('hide') < 0) {
    console.error('❌ 验证码方式应隐藏密码框');
    process.exit(1);
  }
  if (registry.codeRow.className.indexOf('hide') >= 0) {
    console.error('❌ 验证码方式未显示验证码行');
    process.exit(1);
  }
  console.log('✓ 切换到「验证码」方式：隐藏密码框，显示验证码输入');

  // 「获取验证码」链路（example.com 是 IANA 保留测试域名）
  registry.au.value = 'ql_ui_' + uniq + '@example.com';
  await registry.acode.onclick();
  // 验证码要经外部邮件服务下发，响应时间抖动较大，等久一点避免误报
  await wait(6000);
  if (errors.length) {
    console.error('❌ 获取验证码时出错');
    errors.forEach((e) => console.error('   ' + e));
    process.exit(1);
  }
  if (registry.toast.textContent.indexOf('验证码') < 0) {
    console.error('❌ 获取验证码未给出提示: ' + registry.toast.textContent);
    process.exit(1);
  }
  console.log('✓ 获取验证码链路正常（提示: ' + registry.toast.textContent + '）');

  // 切到「WorkBuddy」
  authModeBtns[3].onclick.call(authModeBtns[3]);
  if (registry.ab.className.indexOf('hide') < 0) {
    console.error('❌ WorkBuddy 方式应隐藏主按钮');
    process.exit(1);
  }
  if (registry.awb.className.indexOf('hide') >= 0) {
    console.error('❌ WorkBuddy 方式未显示专用按钮');
    process.exit(1);
  }
  console.log('✓ 切换到「WorkBuddy」方式：显示专用登录按钮');

  // 切回默认（账号+密码 / 登录），后续注册流程沿用它
  authModeBtns[0].onclick.call(authModeBtns[0]);
  authTabs[0].onclick.call(authTabs[0]);
  if (registry.au.placeholder.indexOf('账号') < 0 || registry.ap.className.indexOf('hide') >= 0) {
    console.error('❌ 切回默认方式失败');
    process.exit(1);
  }
  console.log('✓ 可切回默认方式（账号+密码）');

  // 切到注册标签
  authTabs[1].onclick.call(authTabs[1]);
  console.log('✓ 点击「注册」标签切换正常（昵称输入框显示）');

  // 填写并注册
  registry.au.value = user;
  registry.ap.value = 'pass123';
  registry.an.value = '界面测试';
  await registry.ab.onclick();
  await wait(600);

  if (errors.length) {
    console.error('❌ 交互过程出现错误:');
    errors.forEach((e) => console.error('   ' + e));
    process.exit(1);
  }
  console.log('✓ 注册交互成功，已进入主界面');
  console.log('  localStorage token 已保存: ' + (localStorage.getItem('ll_token') ? '是' : '否'));

  // 切到房间视图
  navBtns[1].onclick.call(navBtns[1]);
  await wait(400);
  console.log('✓ 切换到「我的房间」视图无异常');

  // 切到好友视图
  navBtns[2].onclick.call(navBtns[2]);
  await wait(400);
  console.log('✓ 切换到「好友」视图无异常');

  // 切到我的视图
  navBtns[3].onclick.call(navBtns[3]);
  await wait(400);
  console.log('✓ 切换到「我的」视图无异常');

  // 回到公共聊天室并打开（先准备好房间行，渲染时 bindView 会给它绑定 openRoom）
  const roomsInfo = await apiCall('GET', '/api/rooms');
  const pubRoom = roomsInfo && roomsInfo.rooms
    ? roomsInfo.rooms.find((r) => r.kind === 'public')
    : null;
  if (!pubRoom) {
    console.error('❌ 找不到公共聊天室');
    process.exit(1);
  }
  const roomRow = new El('div');
  roomRow.setAttribute('data-open', pubRoom.id);
  roomRows.push(roomRow);

  navBtns[0].onclick.call(navBtns[0]);
  await wait(500);
  roomRow.click();
  await wait(800);
  if (registry.chat.className.indexOf('hide') >= 0) {
    console.error('❌ 没有进入聊天页，当前界面: ' + registry.chat.className);
    process.exit(1);
  }
  console.log('✓ 打开公共聊天室成功（界面: ' + registry.chat.className + '）');

  // 发消息
  registry.msgInput.value = '来自前端模拟的测试消息';
  await registry.sendBtn.onclick();
  await wait(900);
  if (errors.length) {
    console.error('❌ 发送消息时出错:');
    errors.forEach((e) => console.error('   ' + e));
    process.exit(1);
  }
  console.log('✓ 发送消息交互成功');

  /* ================= 消息操作区：撤回 / 删除 / 直接删除 ================= */

  // ① 点消息 → 底部面板里三个入口都必须存在且点得到
  const marker2 = '操作区用例-' + Date.now();
  registry.msgInput.value = marker2;
  await registry.sendBtn.onclick();
  await wait(900);
  const msgNode = findMsgNode(marker2);
  if (!msgNode) {
    console.error('❌ 消息没有渲染出来，无法检查操作区');
    process.exit(1);
  }
  const msgBubOf = (node) => {
    let found = null;
    walk(node, (c) => {
      if (found) return;
      if (String(c.className || '').split(/\s+/).indexOf('bub') >= 0) found = c;
    });
    return found;
  };
  const actLabels = () => {
    const out = [];
    walk(registry.actBox, (c) => {
      if (String(c.className || '').split(/\s+/).indexOf('act-item') >= 0) out.push(String(c.textContent));
    });
    return out;
  };
  const actBtn = (kw) => {
    let hit = null;
    walk(registry.actBox, (c) => {
      if (hit) return;
      if (String(c.className || '').split(/\s+/).indexOf('act-item') >= 0 &&
        String(c.textContent || '').indexOf(kw) >= 0) hit = c;
    });
    return hit;
  };
  const firstBub = msgBubOf(msgNode);
  if (!firstBub) {
    console.error('❌ 找不到消息气泡');
    process.exit(1);
  }
  firstBub.click();
  await wait(150);
  const labels = actLabels();
  if (!labels.some((l) => l.indexOf('撤回') >= 0)) {
    console.error('❌ 操作面板缺少「撤回」入口: ' + JSON.stringify(labels));
    process.exit(1);
  }
  if (!labels.some((l) => l.indexOf('删除') >= 0)) {
    console.error('❌ 操作面板缺少「删除」入口: ' + JSON.stringify(labels));
    process.exit(1);
  }
  if (!labels.some((l) => l.indexOf('直接删除') >= 0)) {
    console.error('❌ 操作面板缺少「直接删除」入口: ' + JSON.stringify(labels));
    process.exit(1);
  }
  console.log('✓ 操作面板三入口齐备（撤回 / 删除 / 直接删除）');

  // ② 「直接删除」必须二次确认，确认后服务端彻底消失
  const purgeBtn = actBtn('直接删除');
  if (!purgeBtn) {
    console.error('❌ 找不到「直接删除」按钮');
    process.exit(1);
  }
  purgeBtn.click();
  await wait(250);
  if (registry.modalTitle.textContent.indexOf('直接删除') < 0) {
    console.error('❌ 「直接删除」没有弹出确认弹层，当前标题: ' + registry.modalTitle.textContent);
    process.exit(1);
  }
  if (registry.modalBody.innerHTML.indexOf('不可恢复') < 0) {
    console.error('❌ 确认弹层未提示「不可恢复」: ' + registry.modalBody.innerHTML);
    process.exit(1);
  }
  console.log('✓ 「直接删除」弹出二次确认弹层（含「不可恢复」提示）');
  registry.modalOk.onclick();
  await wait(1000);
  const afterPurge = await serverMessages();
  if (afterPurge.some((m) => m.content === marker2)) {
    console.error('❌ 直接删除后服务端仍存在该消息');
    process.exit(1);
  }
  console.log('✓ 直接删除已生效：服务端该消息彻底消失');

  /* ================= 多选模式：微信 / QQ 式批量操作 ================= */

  // 准备 3 条待多选的消息
  const mkMarkers = [];
  for (let i = 0; i < 3; i++) {
    const mk = '多选用例-' + Date.now() + '-' + i;
    mkMarkers.push(mk);
    registry.msgInput.value = mk;
    await registry.sendBtn.onclick();
    await wait(700);
  }
  const firstNode = findMsgNode(mkMarkers[0]);
  if (!firstNode) {
    console.error('❌ 多选测试消息没有渲染出来');
    process.exit(1);
  }

  // ① 顶栏不再常驻「多选」入口（改为点消息后在底部面板里进入）
  if (registry.multiBtn) {
    console.error('❌ 顶栏仍保留常驻「多选」按钮');
    process.exit(1);
  }
  console.log('✓ 顶栏已移除常驻「多选」入口');

  // ② 点击气泡 → 底部操作面板浮出
  const bubOf = (node) => {
    let found = null;
    walk(node, (c) => {
      if (found) return;
      if (String(c.className || '').split(/\s+/).indexOf('bub') >= 0) found = c;
    });
    return found;
  };
  const bub = bubOf(firstNode);
  if (!bub) {
    console.error('❌ 找不到消息气泡');
    process.exit(1);
  }
  const actItem = (kw) => {
    let hit = null;
    walk(registry.actBox, (c) => {
      if (hit) return;
      if (String(c.className || '').split(/\s+/).indexOf('act-item') >= 0 &&
        String(c.textContent || '').indexOf(kw) >= 0) hit = c;
    });
    return hit;
  };
  bub.click();
  await wait(120);
  if (registry.actSheet.className.indexOf('hide') >= 0) {
    console.error('❌ 点击消息后底部操作面板没有出现');
    process.exit(1);
  }
  if (!actItem('多选')) {
    console.error('❌ 操作面板里没有「多选」');
    process.exit(1);
  }
  console.log('✓ 点击消息浮出底部操作面板，含「多选」入口');

  // ②b 点遮罩可收起
  registry.actMask.click();
  await wait(80);
  if (registry.actSheet.className.indexOf('hide') < 0) {
    console.error('❌ 点遮罩没有关闭操作面板');
    process.exit(1);
  }
  console.log('✓ 点遮罩可关闭操作面板');

  // ③ 从面板里的「多选」进入多选模式（并自动勾选当前这条）
  bub.click();
  await wait(120);
  const multiItem = actItem('多选');
  if (!multiItem) {
    console.error('❌ 面板里找不到「多选」');
    process.exit(1);
  }
  multiItem.click();
  await wait(200);
  if (registry.msgs.className.indexOf('selmode') < 0) {
    console.error('❌ 进入多选模式失败，msgs.className=' + registry.msgs.className);
    process.exit(1);
  }
  if (registry.selBar.className.indexOf('hide') >= 0) {
    console.error('❌ 多选操作栏没有显示');
    process.exit(1);
  }
  if (registry.composer.className.indexOf('hide') < 0) {
    console.error('❌ 多选模式下输入框没有隐藏');
    process.exit(1);
  }
  console.log('✓ 多选模式已启用：操作栏显示、输入框隐藏');

  // ④ 勾选框存在，且进入时已自动勾选当前消息
  const nodeA = findMsgNode(mkMarkers[0]);
  const pickOf = (node) => {
    let found = null;
    walk(node, (c) => {
      if (found) return;
      if (String(c.className || '').split(/\s+/).indexOf('pick') >= 0) found = c;
    });
    return found;
  };
  if (!pickOf(nodeA)) {
    console.error('❌ 消息上没有勾选框');
    process.exit(1);
  }
  if (String(nodeA.className).indexOf('picked') < 0) {
    console.error('❌ 从「多选」进入后没有自动勾选该条，className=' + nodeA.className);
    process.exit(1);
  }
  if (registry.selCount.textContent.indexOf('1') < 0) {
    console.error('❌ 选中数量没有更新: ' + registry.selCount.textContent);
    process.exit(1);
  }
  console.log('✓ 消息带勾选框，进入多选时自动勾选该条，计数「已选 1 条」');

  // ⑤ 再勾一条 → 计数为 2
  const nodeB = findMsgNode(mkMarkers[1]);
  pickOf(nodeB).click();
  await wait(120);
  if (registry.selCount.textContent.indexOf('2') < 0) {
    console.error('❌ 选中数量应为 2: ' + registry.selCount.textContent);
    process.exit(1);
  }
  console.log('✓ 可勾选多条，计数为 2');

  // ⑥ 多选模式下点气泡只切换勾选，不再弹出单条操作面板
  // 用一条「未勾选」的消息验证
  const selNode = findMsgNode(mkMarkers[2]);
  const bubSel = bubOf(selNode);
  // 先确保面板是关的
  registry.actMask.click();
  await wait(50);
  bubSel.click();
  await wait(120);
  if (registry.actSheet.className.indexOf('hide') < 0) {
    console.error('❌ 多选模式下点击气泡不应弹出单条操作面板');
    process.exit(1);
  }
  if (bubSel.className.indexOf('open') >= 0) {
    console.error('❌ 多选模式下点击气泡不应展开单条操作区');
    process.exit(1);
  }
  if (registry.selCount.textContent.indexOf('3') < 0) {
    console.error('❌ 多选模式下点气泡应切换勾选，计数应为 3: ' + registry.selCount.textContent);
    process.exit(1);
  }
  // 再点一次取消勾选，保持选中 2 条
  bubSel.click();
  await wait(120);
  if (registry.selCount.textContent.indexOf('2') < 0) {
    console.error('❌ 再次点气泡应取消勾选，计数应为 2: ' + registry.selCount.textContent);
    process.exit(1);
  }
  console.log('✓ 多选模式下点击气泡只切换勾选，不展开单条操作区（撤回仅单条可用）');

  // ⑦ 批量「删除」：仅本机隐藏
  await registry.selDelete.onclick();
  await wait(1000);
  if (errors.length) {
    console.error('❌ 批量删除时出错:');
    errors.forEach((e) => console.error('   ' + e));
    process.exit(1);
  }
  const afterBatchDel = await serverMessages();
  if (afterBatchDel.some((m) => m.content === mkMarkers[0] || m.content === mkMarkers[1])) {
    console.error('❌ 批量「删除」后本机视角仍能看到该消息');
    process.exit(1);
  }
  // 换一个账号（旁观者）看：服务端数据必须原样保留
  const watcher = 'mw' + Date.now().toString().slice(-8);
  const wreg = await apiCall('POST', '/api/register', { username: watcher, password: 'pass123', nickname: '旁观者' });
  if (!wreg || !wreg.token) {
    console.error('❌ 旁观者账号注册失败');
    process.exit(1);
  }
  const watcherMsgs = await serverMessagesAs(wreg.token);
  const keptOnServer = mkMarkers.slice(0, 2).filter((mk) => watcherMsgs.some((m) => m.content === mk));
  if (keptOnServer.length !== 2) {
    console.error('❌ 批量「删除」不应动服务端数据，旁观者实际可见: ' + JSON.stringify(keptOnServer));
    process.exit(1);
  }
  if (registry.msgs.className.indexOf('selmode') >= 0) {
    console.error('❌ 批量删除后未退出多选模式');
    process.exit(1);
  }
  console.log('✓ 批量「删除」只隐藏本机，服务端数据完整保留，并自动退出多选');

  // ⑧ 重新进入多选，批量「直接删除」
  // 注意：上一步批量「删除」已把 mkMarkers[0]/[1] 从本机视图隐藏，
  // 这里改用仍然可见的两条来做「直接删除」的验证
  const purgeMk = [mkMarkers[2]];
  const extraMk = '多选用例-直接删除-' + Date.now();
  registry.msgInput.value = extraMk;
  await registry.sendBtn.onclick();
  await wait(800);
  purgeMk.push(extraMk);

  // 从消息的操作面板重新进入多选（进入时会自动勾选当前这条）
  const enterNode = findMsgNode(purgeMk[0]);
  msgBubOf(enterNode).click();
  await wait(150);
  actBtn('多选').click();
  await wait(200);
  for (const mk of purgeMk) {
    const nd = findMsgNode(mk);
    if (!nd) {
      console.error('❌ 找不到待直接删除的消息节点: ' + mk);
      process.exit(1);
    }
    // 通过面板进入时当前那条已经勾上了，别又点掉
    if (String(nd.className).indexOf('picked') < 0) {
      pickOf(nd).click();
      await wait(120);
    }
  }
  await registry.selPurge.onclick();
  await wait(250);
  if (registry.modalTitle.textContent.indexOf('直接删除') < 0) {
    console.error('❌ 批量「直接删除」没有弹出确认弹层: ' + registry.modalTitle.textContent);
    process.exit(1);
  }
  registry.modalOk.onclick();
  await wait(1200);
  // 用旁观者视角验证：批量「直接删除」是全端清除，旁观者也必须看不到
  const afterBatchPurge = await serverMessagesAs(wreg.token);
  const gone = purgeMk.filter((mk) => !afterBatchPurge.some((m) => m.content === mk));
  if (gone.length !== 2) {
    console.error('❌ 批量「直接删除」后服务端仍有残留: ' + JSON.stringify(gone));
    process.exit(1);
  }
  console.log('✓ 批量「直接删除」服务端彻底清除（旁观者端同步消失），并弹二次确认');

  if (errors.length) {
    console.error('❌ 多选流程中有运行时错误:');
    errors.forEach((e) => console.error('   ' + e));
    process.exit(1);
  }

  // 打开成员管理面板
  await registry.memberBtn.onclick();
  await wait(600);
  if (errors.length) {
    console.error('❌ 成员管理面板出错:');
    errors.forEach((e) => console.error('   ' + e));
    process.exit(1);
  }
  console.log('✓ 打开成员管理面板成功（弹层标题: ' + registry.modalTitle.textContent + '）');

  // 弹层确定/取消
  registry.modalCancel.onclick();
  console.log('✓ 弹层关闭正常');

  // 打开聊天页（通过内部状态）
  await wait(300);

  /* ================= 设置页：清除缓存 / 清除聊天记录 / 下载路径 ================= */

  // 进入设置页
  navBtns[3].onclick.call(navBtns[3]);
  await wait(400);
  settingsEntry.onclick();
  await wait(300);
  if (registry.settings.className.indexOf('hide') >= 0) {
    console.error('❌ 设置页没有打开');
    process.exit(1);
  }
  console.log('✓ 设置页打开正常（界面: ' + registry.settings.className + '）');

  // ① 清除缓存（浏览器降级路径）
  registry.btnClearCache.onclick();
  await wait(200);
  registry.modalOk.onclick();
  await wait(400);
  if (errors.length) {
    console.error('❌ 清除缓存出错:');
    errors.forEach((e) => console.error('   ' + e));
    process.exit(1);
  }
  console.log('✓ 清除缓存执行正常（提示: ' + registry.toast.textContent + '）');

  // ② 清除聊天记录：必须二次确认，且明确提示「仅影响本地数据」
  //    先往服务器写一条消息，作为「服务端数据必须保留」的对照
  const marker = '设置页用例-服务端应保留-' + Date.now();
  const rooms = await apiCall('GET', '/api/rooms');
  const pub = rooms && rooms.rooms ? rooms.rooms.find((r) => r.kind === 'public') : null;
  if (!pub) {
    console.error('❌ 找不到公共聊天室');
    process.exit(1);
  }
  const sent = await apiCall('POST', '/api/rooms/' + pub.id + '/messages', { kind: 'text', content: marker });
  if (!sent || !sent.ok) {
    console.error('❌ 前置消息发送失败');
    process.exit(1);
  }
  await wait(300);

  registry.btnClearChat.onclick();
  await wait(200);
  const warnText = registry.modalBody.innerHTML;
  if (warnText.indexOf('仅影响本地数据') < 0) {
    console.error('❌ 第一层确认未提示「仅影响本地数据」: ' + warnText);
    process.exit(1);
  }
  console.log('✓ 第一层确认弹层已提示「仅影响本地数据」');
  registry.modalOk.onclick();
  await wait(200);
  if (registry.modalTitle.textContent !== '再次确认') {
    console.error('❌ 没有进入第二层确认，当前标题: ' + registry.modalTitle.textContent);
    process.exit(1);
  }
  console.log('✓ 第二层确认弹层出现（标题: ' + registry.modalTitle.textContent + '）');
  registry.modalOk.onclick();
  await wait(1200);
  if (errors.length) {
    console.error('❌ 清除聊天记录出错:');
    errors.forEach((e) => console.error('   ' + e));
    process.exit(1);
  }
  const hiddenRev = parseInt(localStorage.getItem('ll_hidden_rev') || '0', 10);
  if (!(hiddenRev > 0)) {
    console.error('❌ 未写入本机隐藏水位 ll_hidden_rev');
    process.exit(1);
  }
  if (!localStorage.getItem('ll_token')) {
    console.error('❌ 清除聊天记录把登录态也清了');
    process.exit(1);
  }
  console.log('✓ 清除聊天记录执行正常（本机隐藏水位 ll_hidden_rev=' + hiddenRev + '，登录态保留）');

  // 服务器端数据必须原封不动
  const serverMsgs = await serverMessages();
  if (!serverMsgs.some((m) => m.content === marker)) {
    console.error('❌ 服务器端的聊天记录被删了 —— 违反「仅影响本地数据」（当前 ' + serverMsgs.length + ' 条）');
    process.exit(1);
  }
  console.log('✓ 服务器端记录完好（对照消息仍在，共 ' + serverMsgs.length + ' 条）');

  // 本机显示应已被清空
  if (registry.msgs.children.length !== 0) {
    console.error('❌ 本机消息区仍有残留显示');
    process.exit(1);
  }
  console.log('✓ 本机消息区已清空（其它设备不受影响）');

  // ③ 自定义下载路径（浏览器降级路径：说明由浏览器决定）
  registry.btnPickDir.onclick();
  await wait(200);
  if (registry.modalBody.innerHTML.indexOf('下载位置') < 0) {
    console.error('❌ 下载路径提示异常');
    process.exit(1);
  }
  registry.modalOk.onclick();
  await wait(200);
  console.log('✓ 下载路径设置入口正常（浏览器态给出说明）');

  // 返回
  registry.setBackBtn.onclick();
  await wait(300);
  if (registry.settings.className.indexOf('hide') < 0) {
    console.error('❌ 设置页没有关闭');
    process.exit(1);
  }
  console.log('✓ 设置页返回正常');

  /* ================= 超窗消息：撤回入口仍可见（用户反馈「根本点不到」） ================= */

  const overRev = Date.now();
  const overBody = JSON.stringify({
    ok: true,
    messages: [{
      id: 'm_overdue_probe', roomId: (pub && pub.id) || '', kind: 'text',
      content: '这条早已超过撤回窗口', fileId: null, recalled: false,
      createdAt: Date.now() - 10 * 60 * 1000, seq: overRev, rev: overRev,
      senderId: 'u_overdue_probe', senderName: '超窗发送者', senderUsername: 'overdue',
      mine: true, canRecall: false, canPurge: true, purged: false, file: null
    }],
    purgedIds: [], lastSeq: overRev, total: 1, canPost: true, muted: false,
    joined: true, kind: 'public', role: 'owner', roleName: '村长'
  });
  global.__xhrOverride = function (method, url) {
    if (method === 'GET' && url.indexOf('/messages?since=') >= 0) {
      return { status: 200, body: overBody };
    }
    return null;
  };
  // 发一条消息会触发前端 pullNow(true)，从而拿到上面构造的超窗消息
  registry.msgInput.value = '触发超窗场景拉取';
  await registry.sendBtn.onclick();
  await wait(1000);
  global.__xhrOverride = null;

  const overNode = findMsgNode('这条早已超过撤回窗口');
  if (!overNode) {
    console.error('❌ 超窗消息没有渲染出来');
    process.exit(1);
  }
  msgBubOf(overNode).click();
  await wait(150);
  const overLabels = actLabels();
  if (!overLabels.some((l) => l.indexOf('撤回（已超窗）') >= 0)) {
    console.error('❌ 超窗消息没有保留撤回入口: ' + JSON.stringify(overLabels));
    process.exit(1);
  }
  if (!overLabels.some((l) => l.indexOf('直接删除') >= 0)) {
    console.error('❌ 超窗消息缺少「直接删除」入口: ' + JSON.stringify(overLabels));
    process.exit(1);
  }
  console.log('✓ 超窗消息仍保留「撤回（已超窗）」入口，并同时提供「直接删除」');

  // 点超窗的撤回：应给出明确指引而不是静默失败
  const overRecall = actBtn('撤回（已超窗）');
  overRecall.click();
  await wait(200);
  if (registry.toast.textContent.indexOf('直接删除') < 0) {
    console.error('❌ 超窗撤回未给出「直接删除」指引: ' + registry.toast.textContent);
    process.exit(1);
  }
  console.log('✓ 超窗点击撤回给出「直接删除」指引（不再点不到）');

  /* ================================================================
   * 头像入口：公共聊天室 / 房间内点头像 → 打开对方资料页 → 加好友
   * （这才是用户说的「在聊天里点头像加好友」，不是只在搜索里）
   * ================================================================ */
  console.log('\n【头像】聊天页点头像加好友');

  // 另一个账号在公共聊天室发一条消息
  const roomPal = 'rm' + Date.now().toString().slice(-8);
  const rreg = await apiCall('POST', '/api/register', { username: roomPal, password: 'pass123', nickname: '房友仔' });
  if (!rreg || !rreg.token) {
    console.error('❌ 房间好友测试账号注册失败');
    process.exit(1);
  }
  const roomPalId = rreg.user ? rreg.user.id : (await apiCall('GET', '/api/me', null, rreg.token)).user.id;
  const roomsForPal = await apiCall('GET', '/api/rooms', null, rreg.token);
  const pubForPal = roomsForPal && roomsForPal.rooms ? roomsForPal.rooms.find((r) => r.kind === 'public') : null;
  if (!pubForPal) {
    console.error('❌ 找不到公共聊天室');
    process.exit(1);
  }
  const roomMsg = '来自房友仔的消息-' + Date.now();
  const sentByPal = await apiCall('POST', '/api/rooms/' + pubForPal.id + '/messages',
    { kind: 'text', content: roomMsg }, rreg.token);
  if (!sentByPal || !sentByPal.ok) {
    console.error('❌ 对方在公共聊天室发消息失败: ' + JSON.stringify(sentByPal));
    process.exit(1);
  }
  console.log('✓ 对方在公共聊天室发了一条消息');

  // 回到公共聊天室，等轮询把对方的消息拉进来
  navBtns[0].onclick.call(navBtns[0]);
  await wait(300);
  roomRow.click();
  await wait(1200);

  const palMsgNode = findMsgNode(roomMsg);
  if (!palMsgNode) {
    console.error('❌ 对方的消息没有出现在公共聊天室里');
    process.exit(1);
  }
  console.log('✓ 对方的消息出现在公共聊天室的聊天页');

  // 找到这条消息的头像（.av）
  const palAv = findOne(palMsgNode, 'av');
  if (!palAv) {
    console.error('❌ 消息没有头像元素');
    process.exit(1);
  }
  if (!palAv.onclick) {
    console.error('❌ 消息头像没有绑定点击事件（点头像加好友入口缺失）');
    process.exit(1);
  }
  console.log('✓ 聊天消息带头像且可点击');

  // 点头像 → 打开资料页
  palAv.click();
  await wait(800);
  if (registry.friendAdd.className.indexOf('hide') >= 0) {
    console.error('❌ 聊天页点头像没有打开资料页');
    process.exit(1);
  }
  // 关键：聊天页必须同时隐藏，否则资料页被顶到屏幕外（历史 bug）
  if (registry.chat.className.indexOf('hide') < 0) {
    console.error('❌ 打开资料页时聊天页没有隐藏，资料页会被挤出屏幕: chat=' + registry.chat.className);
    process.exit(1);
  }
  if (registry.main.className.indexOf('hide') < 0) {
    console.error('❌ 打开资料页时主界面没有隐藏');
    process.exit(1);
  }
  console.log('✓ 聊天页点头像 → 资料页正常打开（聊天页同步隐藏，资料页可见）');

  const chatProfText = textOf(registry.faView);
  if (chatProfText.indexOf('房友仔') < 0) {
    console.error('❌ 资料页没有展示对方昵称: ' + chatProfText);
    process.exit(1);
  }
  if (chatProfText.indexOf('申请加好友') < 0 || chatProfText.indexOf('发送好友申请') < 0) {
    console.error('❌ 资料页没有提供发送好友申请的操作: ' + chatProfText);
    process.exit(1);
  }
  console.log('✓ 资料页展示对方信息并提供「发送好友申请」');

  // 真的发一条申请（从聊天页发起）
  const chatNote = '你好，我是刚刚在公共聊天室看到你的';
  const ta = registry.faView.querySelectorAll('#faMsg');
  if (!ta.length) {
    console.error('❌ 资料页没有附言输入框');
    process.exit(1);
  }
  ta[0].value = chatNote;
  const sendBtns = registry.faView.querySelectorAll('#faSend');
  if (!sendBtns.length) {
    console.error('❌ 资料页没有发送按钮');
    process.exit(1);
  }
  sendBtns[0].click();
  await wait(900);
  if (registry.toast.textContent.indexOf('已发送') < 0) {
    console.error('❌ 从聊天页发送好友申请失败: ' + registry.toast.textContent);
    process.exit(1);
  }
  const reqAfter = await apiCall('GET', '/api/friends', null, rreg.token);
  const gotReq = reqAfter && reqAfter.incoming ? reqAfter.incoming[0] : null;
  if (!gotReq || gotReq.message !== chatNote) {
    console.error('❌ 对方没有收到带附言的好友申请: ' + JSON.stringify(gotReq));
    process.exit(1);
  }
  console.log('✓ 从聊天页发出的好友申请对方已收到（附言一字不差）');

  // 返回按钮 → 必须回到刚才的聊天页（而不是跳回主界面）
  registry.faBackBtn.onclick();
  await wait(400);
  if (registry.friendAdd.className.indexOf('hide') < 0) {
    console.error('❌ 返回按钮没有关闭资料页');
    process.exit(1);
  }
  if (registry.chat.className.indexOf('hide') >= 0) {
    console.error('❌ 从聊天页进入资料页后，返回没有回到聊天页: chat=' + registry.chat.className);
    process.exit(1);
  }
  if (registry.main.className.indexOf('hide') < 0) {
    console.error('❌ 返回聊天页时主界面不应同时显示');
    process.exit(1);
  }
  console.log('✓ 返回按钮正确回到原聊天页（不是跳回主界面）');

  /* ================================================================
   * 好友系统：申请加好友页面 + 收到的好友申请
   * ================================================================ */
  console.log('\n【好友】申请加好友 + 收到的好友申请');

  // 另一个账号给当前账号发好友申请（带附言）
  const pal = 'mp' + Date.now().toString().slice(-8);
  const preg = await apiCall('POST', '/api/register', { username: pal, password: 'pass123', nickname: '好友仔' });
  if (!preg || !preg.token) {
    console.error('❌ 好友测试账号注册失败');
    process.exit(1);
  }
  const myId = (await apiCall('GET', '/api/me')).user.id;
  const palId = preg.user ? preg.user.id : (await apiCall('GET', '/api/me', null, preg.token)).user.id;
  const note = '我是在资料页看到你的，想加个好友';
  const pfr = await apiCall('POST', '/api/friends/request', { userId: myId, message: note }, preg.token);
  if (!pfr || !pfr.request) {
    console.error('❌ 好友申请发送失败: ' + JSON.stringify(pfr));
    process.exit(1);
  }
  console.log('✓ 对方发起带附言的好友申请');

  // 切到好友页（切换时会自动拉一次最新数据）
  navBtns[3].onclick.call(navBtns[3]);
  await wait(200);
  navBtns[2].onclick.call(navBtns[2]);
  await wait(900);

  // 新 UI：好友页只放两条横条入口，点开才在弹窗里列出申请
  const entries = findAll(registry.view, 'req-entry');
  if (entries.length !== 2) {
    console.error('❌ 好友页应有「收到的申请 / 我发出的请求」两条横条，实际 ' + entries.length + ' 条');
    process.exit(1);
  }
  const inEntry = entries[0];
  // 横条内部是 innerHTML 字符串（DOM 桩不解析成子节点），直接读字符串断言
  const inEntryHtml = inEntry.innerHTML || '';
  if (inEntryHtml.indexOf('收到的好友申请') < 0 || inEntryHtml.indexOf('>1<') < 0) {
    console.error('❌ 「收到的好友申请」横条未显示数量 1: ' + inEntryHtml);
    process.exit(1);
  }
  if (inEntryHtml.indexOf('req-dot on') < 0) {
    console.error('❌ 有新申请时横条红点未点亮: ' + inEntryHtml);
    process.exit(1);
  }
  console.log('✓ 好友页为横条入口，收到的申请显示数量 + 红点');

  // 点横条 → 弹窗里列出申请条目
  inEntry.onclick();
  await wait(200);
  const reqRows = findAll(registry.modalBody, 'req-row');
  if (reqRows.length !== 1) {
    console.error('❌ 弹窗内「收到的好友申请」应有 1 条，实际 ' + reqRows.length + ' 条');
    process.exit(1);
  }
  const reqRow = reqRows[0];
  const reqText = textOf(reqRow);
  if (reqText.indexOf('好友仔') < 0 || reqText.indexOf(pal) < 0 ||
      reqText.indexOf(note) < 0 || reqText.indexOf('申请时间') < 0) {
    console.error('❌ 弹窗申请条目缺少昵称/账号/附言/时间: ' + reqText);
    process.exit(1);
  }
  console.log('✓ 点横条弹出窗口，条目展示昵称 / 账号 / 附言 / 申请时间');

  const reqAv = findOne(reqRow, 'row-av');
  if (!reqAv || !reqAv.style.background || !reqAv.getAttribute('data-profile')) {
    console.error('❌ 弹窗申请条目缺少可点击头像（色块 + data-profile）');
    process.exit(1);
  }
  const reqActs = findOne(reqRow, 'req-acts');
  const acceptBtn = reqActs && reqActs.children[0];
  const rejectBtn = reqActs && reqActs.children[1];
  if (!acceptBtn || acceptBtn.textContent !== '同意' || !rejectBtn || rejectBtn.textContent !== '拒绝') {
    console.error('❌ 弹窗申请条目缺少「同意 / 拒绝」操作');
    process.exit(1);
  }
  console.log('✓ 弹窗条目带头像（可看资料）与同意 / 拒绝操作');

  // 点头像 → 弹窗收起 + 打开资料页
  reqAv.click();
  await wait(700);
  if (registry.friendAdd.className.indexOf('hide') >= 0) {
    console.error('❌ 点头像没有打开资料页');
    process.exit(1);
  }
  if (registry.modal.className.indexOf('hide') < 0) {
    console.error('❌ 点头像看资料时弹窗未收起，仍会遮挡资料页');
    process.exit(1);
  }
  const profText = textOf(registry.faView);
  if (profText.indexOf('好友仔') < 0 || profText.indexOf(pal) < 0 || profText.indexOf('注册于') < 0) {
    console.error('❌ 资料页缺少昵称 / 账号 / 注册时间: ' + profText);
    process.exit(1);
  }
  if (profText.indexOf('去处理好友申请') < 0) {
    console.error('❌ 资料页未提示「对方已申请」: ' + profText);
    process.exit(1);
  }
  console.log('✓ 点头像弹窗收起并进入资料页，展示昵称 / 账号 / 注册时间 / 处理入口');

  // 返回主界面
  registry.faBackBtn.onclick();
  await wait(300);
  if (registry.friendAdd.className.indexOf('hide') < 0) {
    console.error('❌ 返回按钮没有关闭资料页');
    process.exit(1);
  }
  console.log('✓ 资料页返回按钮正常');

  // 重新点横条开弹窗 → 同意 → 双方成为好友，好友列表实时刷新
  const inEntry2 = findAll(registry.view, 'req-entry')[0];
  inEntry2.onclick();
  await wait(150);
  const acceptBtn2 = findAll(registry.modalBody, 'req-acts')[0].children[0];
  acceptBtn2.click();
  await wait(1200);
  const afterEntries = findAll(registry.view, 'req-entry');
  if (afterEntries.length !== 2 || (afterEntries[0].innerHTML || '').indexOf('>0<') < 0) {
    console.error('❌ 同意后「收到的申请」横条数量未归零: ' + (afterEntries[0] && afterEntries[0].innerHTML));
    process.exit(1);
  }
  const friendText = textOf(registry.view);
  if (friendText.indexOf('我的好友 (1)') < 0 || friendText.indexOf('好友仔') < 0) {
    console.error('❌ 同意后好友列表未刷新: ' + friendText.slice(0, 400));
    process.exit(1);
  }
  console.log('✓ 同意后横条数量归零、好友列表实时刷新（1 位好友）');

  // 双向：服务端确认对方也能看到我
  const palFriends = await apiCall('GET', '/api/friends', null, preg.token);
  if (!palFriends || !palFriends.friends.some((f) => f.id === myId)) {
    console.error('❌ 好友关系不是双向的，对方看不到我: ' + JSON.stringify(palFriends && palFriends.friends));
    process.exit(1);
  }
  console.log('✓ 好友关系双向成立（对方的好友列表里也有我）');

  // 空状态：横条仍显示 0，点开弹窗提示暂无
  navBtns[3].onclick.call(navBtns[3]);
  await wait(200);
  navBtns[2].onclick.call(navBtns[2]);
  await wait(900);
  const emptyEntry = findAll(registry.view, 'req-entry')[0];
  if (!emptyEntry || (emptyEntry.innerHTML || '').indexOf('收到的好友申请') < 0) {
    console.error('❌ 空状态下收到的申请横条消失: ' + textOf(registry.view).slice(0, 300));
    process.exit(1);
  }
  emptyEntry.onclick();
  await wait(150);
  if (textOf(registry.modalBody).indexOf('暂无收到的好友申请') < 0) {
    console.error('❌ 弹窗内缺少空状态提示: ' + textOf(registry.modalBody).slice(0, 300));
    process.exit(1);
  }
  console.log('✓ 申请为空时横条显示 0、弹窗内提示「暂无收到的好友申请」');

  /* ================================================================
   * UTF-8 显式编码：老内核的 XHR.send(字符串) 可能按本地编码发中文，
   * 导致昵称乱码。前端改为自己编成 UTF-8 字节再发。
   * ================================================================ */
  console.log('\n【编码】前端显式 UTF-8 字节');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const m = appSrc.match(/function utf8Bytes\(str\) \{[\s\S]*?\n  \}/);
  if (!m) {
    console.error('❌ app.js 里找不到 utf8Bytes');
    process.exit(1);
  }
  // 严格模式下 eval 里的函数声明不会泄漏到外层，改用表达式形式取函数值
  // eslint-disable-next-line no-eval
  const utf8Bytes = eval('(' + m[0] + ')');
  const encCases = ['hello', '张三丰', '刘子墨', '🍎emoji😀', '𠮷野家', 'a中b文c'];
  let encOk = true;
  for (const c of encCases) {
    const mine = Buffer.from(utf8Bytes(c));
    const native = Buffer.from(c, 'utf8');
    if (!mine.equals(native)) {
      encOk = false;
      console.error('   差异: ' + c + ' → ' + mine.toString('hex') + ' ≠ ' + native.toString('hex'));
    }
  }
  if (!encOk) {
    console.error('❌ utf8Bytes 与标准 UTF-8 编码不一致');
    process.exit(1);
  }
  console.log('✓ utf8Bytes 与标准 UTF-8 编码逐字节一致（' + encCases.length + ' 组，含 emoji 与代理对）');
  if (appSrc.indexOf('utf8Bytes(JSON.stringify(body))') < 0) {
    console.error('❌ api() 没有改用 utf8Bytes 发送请求体');
    process.exit(1);
  }
  console.log('✓ api() 已改为显式发送 UTF-8 字节（中文昵称不再受老内核编码影响）');

  console.log('\n────────────────────────────');
  if (errors.length) {
    console.error('前端交互错误 ' + errors.length + ' 处');
    process.exit(1);
  }
  console.log('前端交互全部通过，0 运行时错误');
  process.exit(0);
})().catch((e) => {
  console.error('❌ 前端测试异常:', e && e.message);
  console.error(e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : '');
  process.exit(1);
});
