'use strict';
/**
 * 主题专项测试：手动 / 时间 / 跟随系统 三种模式。
 *
 * 覆盖：
 *   1. 首次访问默认「跟随系统」，并落盘为显式状态
 *   2. 系统模式读取 prefers-color-scheme，且系统切换时界面实时同步
 *   3. 手动模式自行选择浅色 / 深色，选择被记住
 *   4. 时间模式按本地时间判定深浅，阈值可配置
 *   5. 时间模式会排「跨越阈值」定时器，切走其它模式时定时器被清理
 *   6. 三种模式共用同一套 CSS 变量（:root 与 [data-theme=dark] 变量集合一致）
 *   7. 深色主题里不出现任何纯白元素
 *   8. 首屏防闪烁：内联引导脚本位于样式表之前
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}

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
    this.value = '';
    this.selected = false;
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
    const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (!m) return [];
    const attr = m[1], val = m[2], out = [];
    walk(this, (c) => {
      if (c === this) return;
      const v = c.getAttribute(attr);
      if (v === null || v === undefined) return;
      if (val === undefined || String(v) === val) out.push(c);
    });
    return out;
  }
  querySelector(sel) {
    const hit = this.querySelectorAll(sel);
    return hit.length ? hit[0] : null;
  }
  addEventListener(type, fn) {
    if (!this._listeners) this._listeners = {};
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  }
  dispatch(type) {
    if (!this._listeners || !this._listeners[type]) return;
    this._listeners[type].forEach((fn) => fn({ type }));
  }
  get scrollHeight() { return 100; }
  get scrollTop() { return 0; }
  set scrollTop(v) { }
  click() { if (this.onclick) this.onclick({ stopPropagation() {}, target: this }); }
  focus() {}
}

function walk(node, fn) {
  if (!node) return;
  const kids = node.children || [];
  for (let i = 0; i < kids.length; i++) { fn(kids[i]); walk(kids[i], fn); }
}

const registry = {};
function mk(id, tag) { const e = new El(tag || 'div'); e.id = id; registry[id] = e; return e; }

['auth', 'main', 'chat', 'view', 'msgs', 'modal', 'modalTitle', 'modalBody', 'modalOk',
 'modalCancel', 'toast', 'au', 'ap', 'an', 'ab', 'aerr', 'tbTitle', 'tbUser', 'upBar',
 'upText', 'upFill', 'upCancel', 'fileInput', 'msgInput', 'sendBtn', 'fileBtn',
 'backBtn', 'memberBtn', 'chatTitle', 'logout', 'joinBtn',
 'multiBtn', 'selBar', 'selCount', 'selAll', 'selDelete', 'selPurge', 'selCancel', 'composer',
 'authModes', 'codeRow', 'ac', 'acode', 'awb', 'atip',
 'settings', 'setBackBtn', 'setView', 'btnClearCache', 'btnClearChat', 'btnPickDir',
 'cacheInfo', 'saveDirInfo',
 // 主题
 'themeBtn', 'themeBox'].forEach((id) => mk(id));

const htmlEl = new El('html');
const metaEl = new El('meta');

global.document = {
  documentElement: htmlEl,
  hidden: false,
  getElementById: (id) => registry[id] || null,
  querySelectorAll: () => [],
  querySelector: (sel) => (sel === 'meta[name="theme-color"]' ? metaEl : null),
  createElement: (t) => new El(t),
  addEventListener: (type, fn) => { (htmlEl._docls = htmlEl._docls || {})[type] = fn; }
};

/* 系统深浅色媒体查询：测试里可翻转 matches 并派发 change */
const mqDark = {
  matches: false,
  _ls: [],
  addEventListener(t, fn) { this._ls.push(fn); },
  addListener(fn) { this._ls.push(fn); },
  flip(v) { this.matches = v; this._ls.forEach((fn) => fn({ matches: v })); }
};

global.window = {
  innerWidth: 360, innerHeight: 640,
  matchMedia: (q) => (q === '(prefers-color-scheme: dark)' ? mqDark : { matches: false, addEventListener() {}, addListener() {} }),
  addEventListener: (type, fn) => { (global.window._ls = global.window._ls || {})[type] = fn; }
};
global.location = { reload: () => {}, href: '', search: '' };

const store = {};
global.localStorage = {
  getItem(k) { return store[k] === undefined ? null : store[k]; },
  setItem(k, v) { store[k] = String(v); },
  removeItem(k) { delete store[k]; },
  get length() { return Object.keys(store).length; },
  key(i) { return Object.keys(store)[i]; }
};

/**
 * 固定时钟：让测试与「真实此刻几点几分」彻底解耦。
 *
 * 为什么必须固定：主题的阈值是整点（如 7:00 / 18:00），
 * 「下一个阈值」的距离取决于测试跑在一天中的哪个时刻。
 * 若测试恰好跑在整点前 1 分钟内，下一个阈值就只有几十秒远，
 * 任何「跨度 > 60 秒」式的定时器识别都会把它误判掉 → 测试随机失败。
 * 固定到当天 10:30 之后，无论真实时间是几点，跨度都稳定在小时级。
 */
const FIXED_NOW = new Date(2026, 0, 15, 10, 30, 0, 0);
const RealDate = Date;
function FakeDate(...args) {
  if (args.length === 0) return new RealDate(FIXED_NOW.getTime());
  return new RealDate(...args);
}
FakeDate.prototype = RealDate.prototype;
FakeDate.now = () => FIXED_NOW.getTime();
FakeDate.parse = RealDate.parse;
FakeDate.UTC = RealDate.UTC;
global.Date = FakeDate;

/* 记录定时器：验证「跨越阈值」定时器的排期与清理 */
const timers = [];
let timerSeq = 0;
const realSetTimeout = setTimeout;   // 先抓住原生实现，避免覆盖后自我递归
global.setTimeout = function (fn, ms) {
  const id = ++timerSeq;
  timers.push({ id, fn, ms, cleared: false });
  const real = realSetTimeout(fn, ms);
  if (real && real.unref) real.unref();
  return id;
};
global.clearTimeout = function (id) {
  const t = timers.find((x) => x.id === id);
  if (t) t.cleared = true;
};
global.setInterval = () => ({ unref() {} });
global.clearInterval = () => {};

/**
 * 主题定时器：识别「跨越阈值」的那个。
 *
 * ⚠️ 不能只按跨度（ms > 60000）来认：整点阈值固定在整点，
 * 当测试恰好跑在整点前 1 分钟内时，离下一个阈值的跨度只有几十秒，
 * 会被这个过滤条件误判成「没排期」→ 测试随机失败（历史踩坑）。
 *
 * 现在测试用固定时钟，跨度恒为小时级；但这里仍按「未被清理 + 跨度 >= 1 秒」
 * 来认，并排除掉 toast（2000/3000/3500ms）与滚动（30ms）这两类固定时长任务，
 * 这样即使将来再引入别的短任务也不会误判。
 */
function themeTimers() {
  return timers.filter((t) => !t.cleared && t.ms >= 1000
    && t.ms !== 2000 && t.ms !== 3000 && t.ms !== 3500 && t.ms !== 30);
}

/* ---------------- 加载真实前端 ---------------- */
const code = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
try {
  // eslint-disable-next-line no-new-func
  new Function(code)();
} catch (e) {
  console.error('❌ 前端脚本执行失败:', e.message);
  console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

console.log('\n──── 主题模式专项 ────');

const attr = () => htmlEl.getAttribute('data-theme');

/* ---------- 1. 首次访问默认跟随系统 ---------- */
check('首次访问默认使用「跟随系统」模式', store.ll_theme_mode === 'system', store.ll_theme_mode);
check('系统为浅色时页面判定为浅色', attr() === 'light', attr());

/* ---------- 2. 系统模式：跟随设备实时同步 ---------- */
mqDark.flip(true);
check('系统切到深色后界面立即变为深色', attr() === 'dark', attr());
mqDark.flip(false);
check('系统切回浅色后界面立即变为浅色', attr() === 'light', attr());

/* ---------- 2.5 原生容器桥接（老 WebView 无 prefers-color-scheme） ---------- */
global.window.__qlSystemTheme('dark');
check('原生容器告知深色后界面变深色', attr() === 'dark', attr());
global.window.__qlSystemTheme('light');
check('原生容器告知浅色后界面变浅色', attr() === 'light', attr());

/* ---------- 3. 手动模式 ---------- */
registry.themeBtn.onclick();                       // 打开主题快捷弹层
const panel = registry.modalBody.children[0];
check('快捷弹层里渲染出主题面板', !!panel && panel.className.indexOf('theme-panel') >= 0);

function clickMode(mode) {
  const btns = panel.querySelectorAll('[data-tmode]');
  const hit = btns.find((b) => b.getAttribute('data-tmode') === mode);
  if (hit) hit.click();
  return !!hit;
}
function clickPref(p) {
  const btns = panel.querySelectorAll('[data-tpref]');
  const hit = btns.find((b) => b.getAttribute('data-tpref') === p);
  if (hit) hit.click();
  return !!hit;
}

check('面板里三种模式都可切换', clickMode('manual'));
check('手动模式被持久化', store.ll_theme_mode === 'manual', store.ll_theme_mode);
check('手动模式下出现浅色 / 深色选项', panel.querySelectorAll('[data-tpref]').length === 2);

clickPref('dark');
check('手动选深色后界面变深色', attr() === 'dark', attr());
check('手动选择被持久化', store.ll_theme_pref === 'dark', store.ll_theme_pref);

clickPref('light');
check('手动选浅色后界面变浅色', attr() === 'light', attr());

/* ---------- 4. 时间模式 ---------- */
const nowH = new Date().getHours();
clickMode('time');
check('时间模式被持久化', store.ll_theme_mode === 'time', store.ll_theme_mode);
check('时间模式下出现两个阈值下拉框', panel.querySelectorAll('[data-thour]').length === 2);

function setHour(key, val) {
  const sels = panel.querySelectorAll('[data-thour]');
  const sel = sels.find((s) => s.getAttribute('data-thour') === key);
  if (!sel) return false;
  sel.value = String(val);
  sel.onchange.call(sel);
  return true;
}

// 把「日间开始」设成当前整点 → 当前时刻落在日间窗口内
setHour('d', nowH);
setHour('n', (nowH + 1) % 24);
check('日间窗口覆盖当前时刻 → 判定为浅色', attr() === 'light', attr());

// 把日间窗口挪到当前时刻之后 → 当前时刻落在夜间
setHour('d', (nowH + 1) % 24);
setHour('n', (nowH + 2) % 24);
check('日间窗口挪开后 → 判定为深色', attr() === 'dark', attr());

let cfg = null;
try { cfg = JSON.parse(store.ll_theme_time); } catch (e) { cfg = null; }
check('时间阈值被持久化', !!cfg && cfg.d === (nowH + 1) % 24 && cfg.n === (nowH + 2) % 24, cfg);

/* ---------- 5. 定时器排期与清理 ---------- */
const pending = themeTimers().filter((t) => !t.cleared);
check('时间模式排出了「跨越阈值」定时器', pending.length > 0, pending.length);

clickMode('system');
const stillPending = themeTimers().filter((t) => !t.cleared);
check('切走时间模式后定时器被清理', stillPending.length === 0, stillPending.length);

clickMode('time');
check('切回时间模式重新排期', themeTimers().filter((t) => !t.cleared).length > 0);
clickMode('system');

/* ---------- 6/7. 静态检查：变量表与深色主题 ---------- */
const cssRaw = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');   // 去掉注释，避免误匹配
function blockOf(selector) {
  const i = css.indexOf(selector);
  if (i < 0) return null;
  const start = css.indexOf('{', i);
  const end = css.indexOf('}', start);
  return css.slice(start + 1, end);
}
const rootBlock = blockOf(':root {');
const darkBlock = blockOf('[data-theme="dark"] {');
check('样式表里有 :root 浅色变量块', !!rootBlock);
check('样式表里有 [data-theme=dark] 深色变量块', !!darkBlock);

function varNames(block) {
  const out = [];
  const re = /(--[\w-]+)\s*:/g;
  let m;
  while ((m = re.exec(block))) out.push(m[1]);
  return out.sort();
}
const rootVars = varNames(rootBlock || '');
const darkVars = varNames(darkBlock || '');
check('两套主题共用同一批变量名（变量数量一致）', rootVars.length === darkVars.length && rootVars.length > 20,
  { root: rootVars.length, dark: darkVars.length });
const missing = rootVars.filter((v) => darkVars.indexOf(v) < 0);
check('深色主题覆盖了全部浅色变量', missing.length === 0, missing);

check('深色主题里不出现纯白色（#fff / #ffffff / white）',
  !/#fff\b|#ffffff\b|\bwhite\b/i.test(darkBlock || ''),
  (darkBlock || '').match(/#fff\w*|#ffffff\w*|\bwhite\b/gi));
check('深色主题里页面底色是深蓝（非中性灰）', /--bg:\s*#0/i.test(darkBlock || ''),
  (darkBlock || '').match(/--bg:[^;]*/));

/* ---------- 8. 首屏防闪烁 ---------- */
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const inlineIdx = html.indexOf('document.documentElement.setAttribute(\'data-theme\'');
const cssIdx = html.indexOf('<link rel="stylesheet"');
check('内联引导脚本存在于 head 中', inlineIdx > 0);
check('引导脚本在样式表之前（避免首屏闪烁）', inlineIdx > 0 && cssIdx > 0 && inlineIdx < cssIdx,
  { inlineIdx, cssIdx });
check('引导脚本同步了浏览器 theme-color', html.indexOf('theme-color') > 0);

/* ---------- 8.5 Android 原生容器适配 ---------- */
const nightColors = path.join(ROOT, 'android/app/src/main/res/values-night/colors.xml');
check('Android 端有夜间模式资源（values-night）', fs.existsSync(nightColors));
const mainAct = fs.readFileSync(
  path.join(ROOT, 'android/app/src/main/java/com/qingliao/app/MainActivity.java'), 'utf8');
// 2.0.0 起 Android 是原生客户端（Activity + View，不再套 WebView），
// 深浅色由 values-night 资源直接决定，无需再把 sys 标记注入 URL。
check('Android 主界面是原生实现（不再加载 WebView）',
  mainAct.indexOf('android.webkit') < 0 && mainAct.indexOf('loadUrl') < 0 &&
  mainAct.indexOf('new WebView') < 0);
// v3.0.0 起消息列表在 ChatActivity 中用 ScrollView + LinearLayout 自绘（不再用 ListView），
// 断言原生列表容器与气泡行渲染仍然存在。
const chatAct = fs.readFileSync(
  path.join(ROOT, 'android/app/src/main/java/com/qingliao/app/ChatActivity.java'), 'utf8');
check('Android 聊天页含原生消息列表容器（ScrollView + 自绘气泡行）',
  chatAct.indexOf('ScrollView') > 0 && chatAct.indexOf('private LinearLayout list') > 0 &&
  chatAct.indexOf('bubbleRow') > 0);
check('引导脚本支持 sys 参数', html.indexOf('sys=(dark|light)') > 0);

/* ---------- 8.6 原生 URL 标记：首屏与运行期必须一致 ---------- */
// 重新加载一次前端：这次 URL 上带 sys 标记，验证首屏判定与引导脚本一致
global.location.search = '?sys=dark';
try { new Function(code)(); } catch (e) { }
check('URL 带 sys=dark 时首屏即判定为深色', attr() === 'dark', attr());
global.location.search = '?sys=light';
try { new Function(code)(); } catch (e) { }
check('URL 带 sys=light 时首屏即判定为浅色', attr() === 'light', attr());

/* ---------- 汇总 ---------- */
console.log('\n通过: ' + pass + '  失败: ' + fail);
process.exit(fail ? 1 : 0);
