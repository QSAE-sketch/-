/* 轻聊 前端 —— 兼容老内核浏览器（ES5 语法 + XMLHttpRequest，无 fetch/async-await） */
(function () {
  'use strict';

  /* ---------------- 本机存储键 ---------------- */

  var HIDDEN_REV_KEY = 'll_hidden_rev';   // 本机隐藏水位（消息 rev <= 该值的不再显示）
  var SEEN_REV_KEY = 'll_seen_rev';       // 本机见过的最大 rev
  var SETTINGS_KEY = 'll_settings';
  var THEME_MODE_KEY = 'll_theme_mode';   // 主题模式：system | time | manual
  var THEME_PREF_KEY = 'll_theme_pref';   // 手动模式下的选择：light | dark
  var THEME_TIME_KEY = 'll_theme_time';   // 时间模式的阈值 {"d":7,"n":18}
  var SKIN_KEY = 'll_skin';               // 当前皮肤 id（'' = 默认原版）
  var SKINSTAR_KEY = 'll_skin_stars';     // 星标皮肤 id 列表（JSON 数组），打开皮肤列表时置顶
  var FONT_KEY = 'll_font';               // 界面字体 id（'' = 系统默认）
  var GOLDFX_KEY = 'll_goldfx';           // 金色流光特效开关：'off' = 关闭动画
  // 可选字体：id / 显示名 / 字体栈（中文优先，英文 fallback）
  var FONTS = [
    { id: '', name: '系统默认', stack: '' },
    { id: 'hei', name: '黑体 · 现代', stack: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif' },
    { id: 'song', name: '宋体 · 书卷', stack: '"Songti SC", "SimSun", "Noto Serif CJK SC", serif' },
    { id: 'kai', name: '楷体 · 手写', stack: '"Kaiti SC", "KaiTi", "STKaiti", serif' },
    { id: 'yuan', name: '圆体 · 圆润', stack: '"Yuanti SC", "YouYuan", "Microsoft YaHei", sans-serif' },
    { id: 'mono', name: '等宽 · 极客', stack: '"SF Mono", "Consolas", "Courier New", monospace' }
  ];
  var KEEP_LOCAL_KEYS = ['ll_token', HIDDEN_REV_KEY, SEEN_REV_KEY, SETTINGS_KEY,
    THEME_MODE_KEY, THEME_PREF_KEY, THEME_TIME_KEY, SKIN_KEY, SKINSTAR_KEY, FONT_KEY, GOLDFX_KEY];

  /** 任意值转非负整数（数字展示用；与基础版 num 同义） */
  function num(v) {
    var n = parseInt(v, 10);
    return isNaN(n) ? 0 : n;
  }
  function readNum(key) {
    var v = parseInt(localStorage.getItem(key) || '0', 10);
    return isNaN(v) ? 0 : v;
  }
  function writeNum(key, v) { localStorage.setItem(key, String(v)); }

  /** 好友申请红点已读水位（本地）：收到申请看过的最大时间、已同意看过的最大时间 */
  function readFriendSeen(key) { return readNum('ll_friend_seen_' + key); }
  function writeFriendSeen(key, v) {
    try { localStorage.setItem('ll_friend_seen_' + key, String(v)); } catch (e) { }
  }

  function readHiddenRev() { return readNum(HIDDEN_REV_KEY); }
  function bumpSeenRev(rev) {
    if (rev && rev > readNum(SEEN_REV_KEY)) writeNum(SEEN_REV_KEY, rev);
  }

  var S = {
    token: localStorage.getItem('ll_token') || '',
    user: null,
    view: 'public',
    rooms: [],
    publicRoomId: '',
    room: null,          // 当前聊天房间
    msgs: {},            // msgId -> element
    lastRev: 0,
    timer: null,
    pollBusy: false,
    friends: [],
    incoming: [],
    outgoing: [],
    recentAccepted: [],           // 最近被同意的我发出的请求（红点用）
    profile: null,                // 当前查看的用户资料（申请加好友页）
    profileFrom: '',              // 资料页的来源：'main'（主界面）| 'chat'（聊天页）
    friendTimer: null,            // 好友视图的实时刷新定时器
    friendSig: '',                // 好友数据指纹，用来判断列表是否真的变了
    onlineCount: 0,               // 公共聊天室同时在线人数（仅标准版）
    onlineTimer: null,            // 在线人数刷新定时器（30秒）
    pulseTimer: null,             // 心跳定时器（15秒）
    dmCache: {},
    uploading: null,
    hiddenRev: readHiddenRev(),  // 本机已隐藏的聊天记录水位
    selMode: false,              // 是否处于多选模式
    selIds: {},                  // 多选模式下选中的消息 id 集合
    picked: {},                  // msgId -> 元素，用于勾选态同步
    storage: null,               // 我的存储配额（/api/me/storage）
    netdiskUrl: '',              // 兼容字段：独立网盘已改为本站内置，恒为空
    version: null,               // /api/version 的返回（含 drive.enabled 等能力标记）
    drive: null,                 // 网盘界面状态（首次进入网盘页时初始化）
    skins: [],                   // 皮肤列表（标准版）
    skin: localStorage.getItem(SKIN_KEY) || '',  // 当前应用的皮肤 id
    skinStars: loadSkinStars(),  // 星标皮肤 id 集合（对象），打开列表时置顶
    font: localStorage.getItem(FONT_KEY) || ''   // 界面字体 id
  };

  var $ = function (id) { return document.getElementById(id); };

  // 支持 ?view=drive 之类直接进入指定页（收藏、分享链接用）
  try {
    var viewParam = String(location.search || '').match(/[?&]view=(public|rooms|friends|me|drive)/);
    if (viewParam) S.view = viewParam[1];
    // ?room=<id>：登录后直达该房间（分享链接 / 测试截图用）
    var roomParam = String(location.search || '').match(/[?&]room=([^&]+)/);
    S.deepRoom = roomParam ? decodeURIComponent(roomParam[1]) : '';
    // ?rq=关键词：直达房间页并自动搜索（分享搜索结果用）
    var rqParam = String(location.search || '').match(/[?&]rq=([^&]+)/);
    S.deepRoomQ = rqParam ? decodeURIComponent(rqParam[1]) : '';
  } catch (e) { /* 老内核取不到 location 就按默认页 */ }
  /** 安全绑定：元素不存在时跳过（老内核 / 部分渲染场景下不炸） */
  function bind(id, fn) {
    var el = $(id);
    if (el) el.onclick = fn;
    return el;
  }
  var authMode = 'login';

  /* ---------------- 工具 ---------------- */

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast';
    clearTimeout(t._tid);
    t._tid = setTimeout(function () { t.className = 'toast hide'; }, ms || 2000);
  }

  function fmtSize(b) {
    if (!b && b !== 0) return '';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    var now = new Date();
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
      return p(d.getHours()) + ':' + p(d.getMinutes());
    }
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function colorOf(id) {
    var h = 0, i;
    for (i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffffff;
    return 'hsl(' + (h % 360) + ',52%,52%)';
  }

  /**
   * 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 具体日期。
   * 好友申请列表用它显示「申请时间」。
   */
  function fmtAgo(ts) {
    if (!ts) return '';
    var t = new Date(ts).getTime();
    if (isNaN(t)) return '';
    var diff = new Date().getTime() - t;
    if (diff < 0) diff = 0;
    var m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    var d = Math.floor(h / 24);
    if (d < 30) return d + ' 天前';
    return fmtTime(ts);
  }

  /* ---------------- 主题：手动 / 时间 / 跟随系统 ---------------- */

  /**
   * 三种模式共用同一套 CSS 变量（style.css 的 :root / [data-theme=dark]），
   * 这里只负责决定「当前该用哪一套」，因此切换模式不会重复实现样式。
   *
   *   system  跟随设备：读 prefers-color-scheme，系统改了就实时跟着变
   *   time    按时间：本地时间落在 [日间开始, 夜间开始) 用浅色，否则深色
   *   manual  手动：用户自己选浅色 / 深色，选择会被记住
   *
   * 持久化键：ll_theme_mode（模式）/ ll_theme_pref（手动选择）/ ll_theme_time（时间阈值）
   * 首次访问没有 ll_theme_mode 时默认走 system。
   */
  var THEME_MODE_NAMES = { system: '跟随系统', time: '按时间', manual: '手动' };

  var Theme = {
    mode: 'system',     // system | time | manual
    pref: 'light',      // 手动模式下用户选的主题
    dayStart: 7,        // 时间模式：日间起始小时
    nightStart: 18,     // 时间模式：夜间起始小时
    current: 'light',   // 当前实际生效的主题
    timer: null,        // 时间模式的「跨越阈值」定时器
    mq: null,           // prefers-color-scheme 媒体查询对象
    systemDark: null    // 原生容器告知的系统深浅色（null = 以媒体查询为准）
  };

  var themeSettingsPanel = null;   // 设置页里的主题面板
  var themeModalPanel = null;     // 快捷弹层里的主题面板
  var themeModalOpen = false;

  function themeModeName(m) { return THEME_MODE_NAMES[m] || THEME_MODE_NAMES.system; }
  function themeLabel() {
    return (Theme.current === 'dark' ? '深色' : '浅色') + '（' + themeModeName(Theme.mode) + '）';
  }

  /** 小时 h 是否落在日间窗口内（支持夜间起始早于日间起始的环绕写法） */
  function themeIsDay(h, d, n) {
    if (d === n) return false;
    if (d < n) return h >= d && h < n;
    return h >= d || h < n;
  }

  function themeLoad() {
    var m = localStorage.getItem(THEME_MODE_KEY) || '';
    Theme.mode = (m === 'time' || m === 'manual') ? m : 'system';
    var p = localStorage.getItem(THEME_PREF_KEY);
    Theme.pref = (p === 'dark') ? 'dark' : 'light';
    var raw = localStorage.getItem(THEME_TIME_KEY);
    if (raw) {
      try {
        var o = JSON.parse(raw);
        if (o && typeof o.d === 'number' && o.d >= 0 && o.d <= 23) Theme.dayStart = o.d;
        if (o && typeof o.n === 'number' && o.n >= 0 && o.n <= 23) Theme.nightStart = o.n;
      } catch (e) { }
    }
    if (Theme.dayStart === Theme.nightStart) { Theme.dayStart = 7; Theme.nightStart = 18; }
  }

  function themeSave() {
    try {
      localStorage.setItem(THEME_MODE_KEY, Theme.mode);
      localStorage.setItem(THEME_PREF_KEY, Theme.pref);
      localStorage.setItem(THEME_TIME_KEY, JSON.stringify({ d: Theme.dayStart, n: Theme.nightStart }));
    } catch (e) { }
  }

  function themeSystemDark() {
    // 原生容器（Android）会把系统深浅色直接告知，优先采用
    if (Theme.systemDark !== null && Theme.systemDark !== undefined) return Theme.systemDark;
    if (!Theme.mq) return false;
    try { return !!Theme.mq.matches; } catch (e) { return false; }
  }

  /** 当前模式解析出的实际主题 */
  function themeResolve() {
    if (Theme.mode === 'manual') return Theme.pref;
    if (Theme.mode === 'time') {
      return themeIsDay(new Date().getHours(), Theme.dayStart, Theme.nightStart) ? 'light' : 'dark';
    }
    return themeSystemDark() ? 'dark' : 'light';
  }

  /** 把主题落到根元素 + 同步浏览器 UI 颜色 */
  function themeApply(t) {
    Theme.current = (t === 'dark') ? 'dark' : 'light';
    try {
      if (document.documentElement && document.documentElement.setAttribute) {
        document.documentElement.setAttribute('data-theme', Theme.current);
      }
    } catch (e) { }
    try {
      var m = document.querySelector ? document.querySelector('meta[name="theme-color"]') : null;
      if (m) m.setAttribute('content', Theme.current === 'dark' ? '#131d30' : '#1f6feb');
    } catch (e2) { }
    themeSyncUI();
  }

  /** 重新解析并应用，同时重排定时器 */
  function themeRefresh() {
    themeApply(themeResolve());
    themeSchedule();
  }

  /** 清掉时间模式的定时器（切模式 / 页面卸载时用，避免悬挂任务） */
  function themeClearTimer() {
    if (Theme.timer) { clearTimeout(Theme.timer); Theme.timer = null; }
  }

  /**
   * 排下一次「跨越阈值」的定时器：
   * 主题只会在 日间开始 / 夜间开始 两个整点发生变化，
   * 取今天与明天这四个时刻里最近的一个还没到的，定时器到点后重新解析并再排一次。
   */
  function themeSchedule() {
    themeClearTimer();
    if (Theme.mode !== 'time') return;   // 其它模式不需要定时器
    var now = new Date();
    var best = null;
    for (var i = 0; i <= 1; i++) {
      var cands = [
        new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, Theme.dayStart, 0, 0, 0),
        new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, Theme.nightStart, 0, 0, 0)
      ];
      for (var j = 0; j < cands.length; j++) {
        var t = cands[j].getTime();
        if (t > now.getTime() && (best === null || t < best.getTime())) best = cands[j];
      }
    }
    if (!best) return;
    var ms = best.getTime() - now.getTime();
    if (ms < 1000) ms = 1000;
    Theme.timer = setTimeout(function () {
      Theme.timer = null;
      themeRefresh();     // 跨越阈值 → 立刻切换，并排下一次
    }, ms + 500);
  }

  /** 订阅系统深浅色变化（只订阅一次） */
  function themeWatchSystem() {
    if (Theme.mq) return;
    try {
      Theme.mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    } catch (e) { Theme.mq = null; }
    if (!Theme.mq) return;
    var fn = function () { if (Theme.mode === 'system') themeRefresh(); };
    if (Theme.mq.addEventListener) Theme.mq.addEventListener('change', fn);
    else if (Theme.mq.addListener) Theme.mq.addListener(fn);   // 老内核
  }

  function themeSetMode(m) {
    if (m !== 'system' && m !== 'time' && m !== 'manual') return;
    Theme.mode = m;
    themeSave();
    themeRefresh();
  }

  function themeSetPref(p) {
    Theme.pref = (p === 'dark') ? 'dark' : 'light';
    themeSave();
    if (Theme.mode === 'manual') themeRefresh();
    else themeSyncUI();
  }

  function themeSetHour(key, v) {
    var h = parseInt(v, 10);
    if (isNaN(h) || h < 0 || h > 23) return;
    if (key === 'd') Theme.dayStart = h; else Theme.nightStart = h;
    if (Theme.dayStart === Theme.nightStart) { themeSyncUI(); return; }  // 非法组合，不落盘
    themeSave();
    themeRefresh();
  }

  /* ================================================================
     皮肤系统（标准版专属）
     ----------------------------------------------------------------
     皮肤 = 一份 CSS，通过 <link id="skinLink"> 覆盖变量 / 加结构样式。
     应用时同步给 <html data-skin="id">，样式里的 [data-skin] 作用域生效。
     选择存本机 localStorage，刷新后自动恢复；列表从 /api/skins 拉。
     ================================================================ */

  /** 读取星标皮肤集合（坏数据容忍：任何异常都退回空对象） */
  function loadSkinStars() {
    var out = {};
    try {
      var raw = localStorage.getItem(SKINSTAR_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      if (Object.prototype.toString.call(arr) === '[object Array]') {
        for (var i = 0; i < arr.length; i++) if (arr[i]) out[String(arr[i])] = true;
      }
    } catch (e) { }
    return out;
  }

  /** 落盘星标集合（存成数组，便于人工查看 / 跨版本兼容） */
  function saveSkinStars() {
    var arr = [];
    for (var k in S.skinStars) if (S.skinStars[k]) arr.push(k);
    try { localStorage.setItem(SKINSTAR_KEY, JSON.stringify(arr)); } catch (e) { }
  }

  /** 切换某套皮肤的星标；返回切换后的状态 */
  function skinStarToggle(id) {
    if (!id) return false;
    if (S.skinStars[id]) { delete S.skinStars[id]; }
    else { S.skinStars[id] = true; }
    saveSkinStars();
    return !!S.skinStars[id];
  }

  /* ---------------- 字体 ---------------- */
  function fontFind(id) {
    for (var i = 0; i < FONTS.length; i++) if (FONTS[i].id === id) return FONTS[i];
    return FONTS[0];
  }

  /** 应用界面字体：写 data-font 属性 + 注入字体栈变量 */
  function fontApply(id) {
    S.font = id || '';
    try { localStorage.setItem(FONT_KEY, S.font); } catch (e) { }
    var root = document.documentElement;
    var f = fontFind(S.font);
    try {
      if (S.font) {
        root.setAttribute('data-font', S.font);
        root.style.setProperty('--font-ui', f.stack || '');
      } else {
        root.removeAttribute('data-font');
        root.style.removeProperty('--font-ui');  // 回到 CSS 里的系统默认字体栈
      }
    } catch (e) { }
  }

  /**
   * 「消息金色流光」开关（本机偏好）。
   * 最高权限账号发的消息默认带金色流动动画，长时间看很晃眼；
   * 关掉后颜色照旧是金色，只是不再有流光扫过 —— 只影响本机显示。
   */
  function goldFxOn() {
    try { return localStorage.getItem(GOLDFX_KEY) !== 'off'; } catch (e) { return true; }
  }
  function applyGoldFx() {
    try {
      document.documentElement.setAttribute('data-goldfx', goldFxOn() ? 'on' : 'off');
    } catch (e) { }
  }

  /** 应用皮肤；传空串恢复默认原版 */
  function skinApply(id) {
    S.skin = id || '';
    try { localStorage.setItem(SKIN_KEY, S.skin); } catch (e) { }
    var root = document.documentElement;
    var link = $('skinLink');
    if (S.skin) {
      try { root.setAttribute('data-skin', S.skin); } catch (e) { }
      if (!link) {
        link = document.createElement('link');
        link.id = 'skinLink';
        link.rel = 'stylesheet';
        var head = document.getElementsByTagName('head')[0];
        if (head) head.appendChild(link);
      }
      var item = null;
      for (var i = 0; i < S.skins.length; i++) {
        if (S.skins[i].id === S.skin) { item = S.skins[i]; break; }
      }
      link.href = item ? item.url : '';
    } else {
      try { root.removeAttribute('data-skin'); } catch (e2) { }
      if (link && link.parentNode) link.parentNode.removeChild(link);
    }
    refreshSkinEntry();
  }

  /** 皮肤切换后同步主页入口文案（避免显示上一个皮肤名） */
  function refreshSkinEntry() {
    var sel = document.querySelector || function () { return null; };
    var el = sel.call(document, '[data-skin-open]');
    if (!el) return;
    var name = S.skin ? ((skinFind(S.skin) || {}).name || S.skin) : '';
    el.textContent = '皮肤中心' + (S.skin ? ' · 当前「' + name + '」' : ' · 当前原版');
  }

  /** 从服务器拉皮肤列表；静默失败（皮肤是增强功能，不该拖垮主流程） */
  function skinLoad(cb) {
    api('GET', '/api/skins', null, function (err, data) {
      if (!err && data && data.skins) S.skins = data.skins;
      // 若当前皮肤已被删除，自动退回默认
      if (S.skin) {
        var found = false;
        for (var i = 0; i < S.skins.length; i++) {
          if (S.skins[i].id === S.skin) { found = true; break; }
        }
        if (!found) skinApply('');
      } else {
        skinApply(S.skin);
      }
      if (typeof cb === 'function') cb();
    });
  }

  function skinFind(id) {
    for (var i = 0; i < S.skins.length; i++) if (S.skins[i].id === id) return S.skins[i];
    return null;
  }

  /** 皮肤面板：预览图 + 应用 + 上传 + 公开/删除 */
  function openSkins() {
    var h = '<div class="skin-intro">给界面换一套外观。点「预览」看效果，点「使用」立即切换；' +
      '做自己的皮肤只要一份 CSS 文件，上传即可（也支持 ZIP 完整包）。</div>' +
      '<div class="skin-search"><input type="text" id="skinSearch" class="inp" ' +
      'placeholder="🔍 搜索皮肤名 / 风格 / 关键词" autocomplete="off"></div>' +
      '<div class="r-sub" id="skinCount" style="padding:6px 2px"></div>' +
      '<div class="skin-list" id="skinList">加载中…</div>' +
      '<div class="skin-tools">' +
      '<label class="mini-btn" for="skinUpload">📦 上传皮肤（CSS / ZIP）</label>' +
      '<input type="file" id="skinUpload" accept=".css,.zip,text/css,application/zip" style="display:none">' +
      '<div class="mini-btn" id="skinHelp">📖 制作规范</div></div>' +
      '<div class="r-sub" id="skinUploadTip" style="padding:8px 2px 0"></div>';
    openModal('皮肤中心', h, null, '关闭');
    renderSkinList();
    $('skinSearch').oninput = function () { renderSkinList(); };
    $('skinUpload').onchange = function () {
      var f = this.files && this.files[0];
      if (!f) return;
      skinUpload(f);
      this.value = '';
    };
    $('skinHelp').onclick = showSkinHelp;
  }

  /** 皮肤关键词匹配：中文名 / 英文名 / 描述 / 风格 / id */
  function skinMatch(s, q) {
    if (!q) return true;
    q = q.toLowerCase();
    var hay = [s.name, s.id, s.description, s.author, s.style, s.tone].join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  function renderSkinList() {
    var box = $('skinList');
    if (!box) return;
    var qEl = $('skinSearch');
    var q = qEl ? String(qEl.value || '').trim() : '';
    var list = [];
    for (var k = 0; k < S.skins.length; k++) if (skinMatch(S.skins[k], q)) list.push(S.skins[k]);
    // 星标置顶：星标皮肤按原顺序排前面，其余跟在后面（搜索时也置顶，方便快速找到）
    list.sort(function (a, b) {
      var sa = S.skinStars[a.id] ? 1 : 0;
      var sb = S.skinStars[b.id] ? 1 : 0;
      return sb - sa;
    });
    var cnt = $('skinCount');
    if (cnt) cnt.textContent = q
      ? ('找到 ' + list.length + ' 套皮肤（共 ' + S.skins.length + ' 套）')
      : ('共 ' + S.skins.length + ' 套皮肤 · 默认外观 + 内置风格 + 你上传的');
    var h = '';
    if (!q) {
      h += '<div class="skin-card' + (S.skin ? '' : ' on') + '">' +
        '<div class="skin-pv"><span class="skin-pv-ph">默</span></div>' +
        '<div class="skin-meta">' +
        '<div class="r-title">默认外观' + (S.skin ? '' : '<span class="badge">使用中</span>') + '</div>' +
        '<div class="r-sub">轻聊原始样式 · 不套用任何皮肤</div>' +
        '<div class="skin-acts">' +
        (S.skin ? '<span class="mini-btn" data-skin-use="">恢复默认</span>' : '') +
        '</div></div></div>';
    }
    if (!list.length) {
      h += '<div class="empty">没有匹配的皮肤，换个关键词试试</div>';
    }
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var active = S.skin === s.id;
      h += '<div class="skin-card' + (active ? ' on' : '') + (S.skinStars[s.id] ? ' starred' : '') + '">' +
        '<div class="skin-pv">' +
        (s.preview
          ? '<img src="' + esc(s.preview) + '" alt="预览">'
          : '<span class="skin-pv-ph">' + esc(s.name.slice(0, 1)) + '</span>') +
        '</div>' +
        '<div class="skin-meta">' +
        '<div class="r-title">' + esc(s.name) + (active ? '<span class="badge">使用中</span>' : '') + '</div>' +
        '<div class="r-sub">' + esc(s.description || s.author || '') +
        ' · v' + esc(s.version) + (s.builtin ? ' · 内置' : (s.isPublic ? ' · 公开' : ' · 私密')) + '</div>' +
        '<div class="skin-acts">' +
        '<span class="mini-btn skin-star' + (S.skinStars[s.id] ? ' on' : '') + '" data-skin-star="' + esc(s.id) + '" ' +
        'title="' + (S.skinStars[s.id] ? '取消星标' : '加星标，下次置顶') + '">' +
        (S.skinStars[s.id] ? '★ 已星标' : '☆ 星标') + '</span>' +
        (active ? '' : '<span class="mini-btn" data-skin-use="' + esc(s.id) + '">使用</span>') +
        '<span class="mini-btn" data-skin-preview="' + esc(s.id) + '">预览</span>' +
        (s.mine && !s.builtin
          ? '<span class="mini-btn" data-skin-public="' + esc(s.id) + '">' + (s.isPublic ? '转私密' : '设公开') + '</span>' +
            '<span class="mini-btn danger" data-skin-del="' + esc(s.id) + '">删除</span>'
          : '') +
        '</div></div></div>';
    }
    box.innerHTML = h;
    var stars = box.querySelectorAll('[data-skin-star]');
    for (var st = 0; st < stars.length; st++) {
      stars[st].onclick = function () {
        var id = this.getAttribute('data-skin-star');
        var on = skinStarToggle(id);
        toast(on ? '已加星标，下次打开置顶' : '已取消星标');
        renderSkinList();
      };
    }
    var uses = box.querySelectorAll('[data-skin-use]');
    for (var u = 0; u < uses.length; u++) {
      uses[u].onclick = function () {
        var id = this.getAttribute('data-skin-use') || '';
        skinApply(id);
        toast(id ? ('已切换到「' + ((skinFind(id) || {}).name || id) + '」') : '已恢复默认外观');
        renderSkinList();
      };
    }
    var pvs = box.querySelectorAll('[data-skin-preview]');
    for (var p = 0; p < pvs.length; p++) {
      pvs[p].onclick = function () { showSkinPreview(this.getAttribute('data-skin-preview')); };
    }
    var pubs = box.querySelectorAll('[data-skin-public]');
    for (var g = 0; g < pubs.length; g++) {
      pubs[g].onclick = function () {
        var el = this, id = el.getAttribute('data-skin-public');
        var sk = skinFind(id);
        if (!sk) return;
        var body = { isPublic: !sk.isPublic };
        apiPostBinary('/api/skins/' + encodeURIComponent(id) + '/public', body, function (err) {
          if (err) { toast(err.message); return; }
          skinLoad(function () { renderSkinList(); });
        });
      };
    }
    var dels = box.querySelectorAll('[data-skin-del]');
    for (var d = 0; d < dels.length; d++) {
      dels[d].onclick = function () {
        var id = this.getAttribute('data-skin-del');
        var sk = skinFind(id);
        openModal('删除皮肤', '确定删除「' + esc(sk ? sk.name : id) + '」吗？已应用此皮肤的设备会自动恢复默认。', function () {
          api('DELETE', '/api/skins/' + encodeURIComponent(id), null, function (err) {
            if (err) { toast(err.message); return; }
            skinLoad(function () { renderSkinList(); });
            toast('已删除');
          });
        }, '删除');
      };
    }
  }

  /** 以二进制体发 JSON（后端 public 切换接口用 readBinary 读） */
  function apiPostBinary(path, obj, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', path, true);
    xhr.timeout = 30000;
    if (S.token) xhr.setRequestHeader('X-Token', S.token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { }
      if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) cb(null, data);
      else cb(new Error((data && data.error) || ('请求失败(' + xhr.status + ')')));
    };
    xhr.send(utf8Bytes(JSON.stringify(obj)));
  }

  /** 预览：弹层里放一张放大预览图 + 说明，应用后整站即变此风格 */
  function showSkinPreview(id) {
    var sk = skinFind(id);
    if (!sk) return;
    var h = '<div class="skin-preview-box">';
    if (sk.preview) h += '<img class="skin-preview-img" src="' + esc(sk.preview) + '" alt="皮肤预览">';
    else h += '<div class="empty">这个皮肤没有预览图</div>';
    h += '<div class="r-sub" style="padding:10px 2px 0;line-height:1.7">' +
      esc(sk.name) + ' · v' + esc(sk.version) + '<br>' + esc(sk.description || '') +
      '<br>点「使用」后整个界面立即切换成这套风格。</div></div>';
    openModal('皮肤预览', h, function () {
      skinApply(id);
      toast('已应用「' + sk.name + '」');
      renderSkinList();
    }, '使用这个皮肤');
  }

  /** 上传皮肤：一份 CSS 就行，也可上传 ZIP 完整包 */
  function skinUpload(file) {
    if (!/\.(css|zip)$/i.test(file.name)) { toast('请选择 .css 或 .zip 皮肤文件'); return; }
    if (file.size > 3 * 1024 * 1024) { toast('皮肤文件不能超过 3MB'); return; }
    var tip = $('skinUploadTip');
    if (tip) tip.textContent = '上传中…';
    var name = String(file.name || '').replace(/\.(css|zip)$/i, '');
    apiFile('POST', '/api/skins', file, function (loaded, total) {
      if (tip && total) tip.textContent = '上传中 ' + Math.round(loaded * 100 / total) + '%';
    }, function (err, data) {
      if (err) {
        if (tip) tip.textContent = '';
        toast(err.message);
        return;
      }
      if (tip) tip.textContent = '上传成功：' + (data.skin ? data.skin.name : '');
      skinLoad(function () { renderSkinList(); });
    }, { 'X-Skin-Name': encodeURIComponent(name), 'X-File-Name': encodeURIComponent(String(file.name || '')) });
  }

  /** 制作规范：最简只要一份 CSS，深浅色各写一套 */
  function showSkinHelp() {
    var h = '<div class="skin-help">' +
      '<p><b>最简单的做法：只写一份 CSS 文件，上传就行。</b>' +
      '名字、编号、预览图都会自动生成，不用再准备 manifest 或图片。</p>' +
      '<p><b>CSS 这样写（浅色 + 深色各一套，是真的两套颜色）：</b></p>' +
      '<pre>/* 浅色 */\n' +
      ':root{\n' +
      '  --bg:#fff7e9; --surface:#fffdf8;\n' +
      '  --fg:#2b2a24; --border:#ded2b8;\n' +
      '  --accent:#a87600; --topbar-bg:#ffd43b;\n' +
      '}\n' +
      '/* 深色：换一整套色，不是调亮度 */\n' +
      ':root[data-theme="dark"]{\n' +
      '  --bg:#1c1c18; --surface:#26261f;\n' +
      '  --fg:#f2ecd9; --border:#46463a;\n' +
      '  --accent:#ffd43b; --topbar-bg:#2c2c24;\n' +
      '}</pre>' +
      '<p>浅色用 <code>:root</code>，深色用 <code>:root[data-theme="dark"]</code>，' +
      '这样切换「外观 · 主题」时皮肤会真的跟着变深浅。只写浅色的话，深色模式会一直显示浅色。</p>' +
      '<p><b>想改细节</b>：直接写普通选择器，例如 <code>.card-h{background:#fff2bf}</code>；' +
      'CSS 只在你选用这套皮肤时生效，不用担心影响别人。</p>' +
      '<p><b>要打包图片/字体</b> 才需要 ZIP：根目录放 <code>skin.css</code>，' +
      '可选 <code>manifest.json</code>（不写会自动生成）、预览图和 images/ 目录。ZIP ≤ 3MB。</p>' +
      '<p class="dim">上传后默认只有自己能用，可以在皮肤列表里点「设公开」分享给大家，也能随时删除。</p>' +
      '<p><a class="btn small" href="/skins/example-skin.css" download="示例皮肤.css">⬇ 下载最简单的 CSS 示例</a>' +
      '　<a class="btn small" href="/skins/example-skin.zip" download="示例皮肤包.zip">下载完整 ZIP 示例</a></p>' +
      '</div>';
    openModal('皮肤制作规范', h, null, '知道了');
  }

  function themeStart() {
    themeLoad();
    // 首次访问：把默认的「跟随系统」显式落盘，状态一目了然
    if (!localStorage.getItem(THEME_MODE_KEY)) themeSave();
    // 原生容器（Android）把系统深浅色放在 URL 上（老 WebView 不支持 prefers-color-scheme），
    // 这里读进来，和首屏引导脚本保持一致，避免「首屏是深色、随后被改回浅色」
    try {
      var q = String((typeof location !== 'undefined' && location.search) ? location.search : '');
      var m = q.match(/[?&]sys=(dark|light)/);
      if (m) Theme.systemDark = (m[1] === 'dark');
    } catch (e) { }
    themeWatchSystem();
    themeApply(themeResolve());
    themeSchedule();

    // 页面从后台切回前台：定时器在后台可能被浏览器节流，回来后重新核对一次
    if (document.addEventListener) {
      document.addEventListener('visibilitychange', function () {
        var hidden = document.hidden;
        if (!hidden) themeRefresh();
      });
    }
    // 页面卸载 / 被切走：清掉定时器
    if (window.addEventListener) {
      window.addEventListener('pagehide', themeClearTimer);
      window.addEventListener('beforeunload', themeClearTimer);
      window.addEventListener('pageshow', function () { themeRefresh(); });
    }
  }

  /* ---- 主题选择界面（设置页与快捷弹层共用同一套面板） ---- */

  function themeEl(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined && html !== null) e.innerHTML = html;
    return e;
  }

  function themeHourRow(label, key, val) {
    var row = themeEl('div', 'theme-hour');
    row.appendChild(themeEl('span', null, label));
    var sel = document.createElement('select');
    sel.setAttribute('data-thour', key);
    for (var i = 0; i < 24; i++) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = (i < 10 ? '0' : '') + i + ':00';
      if (i === val) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = function () { themeSetHour(key, this.value); };
    row.appendChild(sel);
    return row;
  }

  /** 渲染主题面板内容（三处复用：设置页 / 弹层 / 顶栏按钮的说明） */
  function themeRenderPanel(panel) {
    if (!panel) return;
    panel.innerHTML = '';

    var modes = themeEl('div', 'theme-modes');
    var list = [['system', '跟随系统'], ['time', '按时间'], ['manual', '手动']];
    for (var i = 0; i < list.length; i++) {
      (function (mode, label) {
        var b = themeEl('button', 'theme-mode' + (Theme.mode === mode ? ' active' : ''), label);
        b.setAttribute('data-tmode', mode);
        b.onclick = function () { themeSetMode(mode); };
        modes.appendChild(b);
      })(list[i][0], list[i][1]);
    }
    panel.appendChild(modes);

    var state = themeEl('div', 'theme-state');
    state.appendChild(themeEl('span', 'ts-dot' + (Theme.current === 'dark' ? ' dark' : '')));
    state.appendChild(themeEl('span', null,
      '当前生效：<b>' + (Theme.current === 'dark' ? '深色' : '浅色') + '</b> · 模式：<b>' + themeModeName(Theme.mode) + '</b>'));
    panel.appendChild(state);

    if (Theme.mode === 'manual') {
      var sub = themeEl('div', 'theme-sub');
      var opts = themeEl('div', 'theme-opts');
      var plist = [['light', '浅色'], ['dark', '深色']];
      for (var j = 0; j < plist.length; j++) {
        (function (p, label) {
          var b = themeEl('button', 'theme-opt' + (Theme.pref === p ? ' active' : ''), label);
          b.setAttribute('data-tpref', p);
          b.onclick = function () { themeSetPref(p); };
          opts.appendChild(b);
        })(plist[j][0], plist[j][1]);
      }
      sub.appendChild(opts);
      panel.appendChild(sub);
    } else if (Theme.mode === 'time') {
      var sub2 = themeEl('div', 'theme-sub');
      sub2.appendChild(themeHourRow('日间开始', 'd', Theme.dayStart));
      sub2.appendChild(themeHourRow('夜间开始', 'n', Theme.nightStart));
      panel.appendChild(sub2);
    }
  }

  /** 主题变化后刷新所有可见的主题面板 */
  function themeSyncUI() {
    var btn = $('themeBtn');
    if (btn) {
      btn.textContent = (Theme.current === 'dark') ? '🌙' : '☀️';
      btn.title = '主题：' + themeLabel();
    }
    if (themeSettingsPanel) themeRenderPanel(themeSettingsPanel);
    if (themeModalPanel) themeRenderPanel(themeModalPanel);
  }

  /** 顶栏快捷入口：弹层里直接选三种模式 */
  function openThemeModal() {
    openModal('外观 · 主题', '', function () { }, '完成');
    var body = $('modalBody');
    if (body) {
      body.innerHTML = '';
      themeModalPanel = themeEl('div', 'theme-panel');
      themeRenderPanel(themeModalPanel);
      body.appendChild(themeModalPanel);
    }
    var cancel = $('modalCancel');
    if (cancel) cancel.className = 'btn ghost hide';
    themeModalOpen = true;
  }

  /**
   * 原生容器（Android）调用：把系统当前的深浅色告诉站点。
   * 老版本 WebView 不支持 prefers-color-scheme，只能靠这条通道。
   */
  window.__qlSystemTheme = function (t) {
    Theme.systemDark = (t === 'dark');
    if (Theme.mode === 'system') themeRefresh();
  };

  themeStart();
  bind('themeBtn', openThemeModal);
  bind('faBackBtn', closeProfile);
  // 离开页面时停掉好友轮询，别让后台空转（老内核 / 测试环境可能没有 addEventListener）
  if (typeof window !== 'undefined' && window && window.addEventListener) {
    window.addEventListener('pagehide', stopFriendPoll);
    window.addEventListener('beforeunload', stopFriendPoll);
  }

  /* ---------------- 网络 ---------------- */

  /**
   * 手动把字符串编码成 UTF-8 字节。
   *
   * 为什么要自己编码：XMLHttpRequest.send(字符串) 在部分老内核（红米 Note 2 的
   * Android 5.0 WebView 等）里不保证按 UTF-8 发出，中文昵称会被按本地编码
   * （如 GBK）发出，服务端解出来就是乱码。这里统一自己编成字节再发，
   * 任何环境下传的都是同一串 UTF-8 字节。
   */
  function utf8Bytes(str) {
    var s = String(str === undefined || str === null ? '' : str);
    var out = [];
    var i, c, c2, cp;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length &&
                 s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) {
        c2 = s.charCodeAt(i + 1);
        cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return new Uint8Array(out);
  }

  function api(method, path, body, cb) {
    // 回调可选：心跳等「发完即走」的请求不传回调，统一在这里兜成空函数
    var done = typeof cb === 'function' ? cb : function () { };
    var xhr = new XMLHttpRequest();
    xhr.open(method, path, true);
    xhr.timeout = 60000;
    if (S.token) xhr.setRequestHeader('X-Token', S.token);
    if (body !== undefined && body !== null) xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
      if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) {
        done(null, data);
      } else {
        done(new Error((data && data.error) || ('请求失败(' + xhr.status + ')')), data);
      }
    };
    xhr.onerror = function () { done(new Error('网络错误')); };
    xhr.ontimeout = function () { done(new Error('网络超时')); };
    // 显式发 UTF-8 字节，避免老内核用本地编码发中文
    xhr.send(body !== undefined && body !== null ? utf8Bytes(JSON.stringify(body)) : null);
  }

  function apiFile(method, path, blob, onProgress, cb, headers) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, path, true);
    xhr.timeout = 0;
    if (S.token) xhr.setRequestHeader('X-Token', S.token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (headers) {
      for (var hk in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, hk)) xhr.setRequestHeader(hk, headers[hk]);
      }
    }
    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = function (e) { onProgress(e.loaded, e.total); };
    }
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
      if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) cb(null, data);
      else cb(new Error((data && data.error) || ('上传失败(' + xhr.status + ')')), data);
    };
    xhr.onerror = function () { cb(new Error('网络中断')); };
    xhr.send(blob);
  }

  /* ---------------- 弹层 ---------------- */

  var modalCb = null;
  function openModal(title, html, onOk, okText) {
    $('modalTitle').textContent = title;
    var body = $('modalBody');
    // html 可以是字符串，也可以是已构建好的 DOM 节点（成员面板用后者，方便绑事件）
    if (html && typeof html.appendChild === 'function') {
      body.innerHTML = '';
      body.appendChild(html);
    } else {
      body.innerHTML = html;
    }
    $('modalOk').textContent = okText || '确定';
    $('modal').className = 'modal';
    modalCb = onOk;
  }
  function closeModal() {
    $('modal').className = 'modal hide';
    modalCb = null;
    var cancel = $('modalCancel');
    if (cancel) cancel.className = 'btn ghost';
    themeModalPanel = null;
    themeModalOpen = false;
  }

  /* ---------------- 应用内确认 / 输入弹层 ----------------
   * 手机 WebView 与部分浏览器会屏蔽 window.confirm/prompt，
   * 点了直接没反应。所有需要确认、输入的地方统一走这里。
   * 回调返回 false 可保持弹层不关闭（用于校验失败）。
   */
  var askSeq = 0;
  function askConfirm(title, text, onOk, okText) {
    openModal(title, '<div class="ask-text">' + text + '</div>', onOk, okText || '确定');
  }
  function askInput(title, text, value, onOk, okText) {
    var id = 'askInput_' + (++askSeq);
    var h = '<div class="ask-text">' + text + '</div>' +
      '<input class="ask-field" id="' + id + '" type="text" value="' + esc(value || '') + '">';
    openModal(title, h, function () {
      var f = $(id);
      return onOk(f ? f.value : '');
    }, okText || '确定');
    setTimeout(function () {
      var f = $(id);
      if (f && f.focus) { f.focus(); if (f.select) f.select(); }
    }, 30);
  }
  $('modalCancel').onclick = closeModal;
  $('modalOk').onclick = function () {
    if (modalCb) {
      var keep = modalCb();
      if (keep === false) return;
    }
    closeModal();
  };

  /* ---------------- 原生桥（Android 客户端） ---------------- */

  /**
   * Android 容器通过 addJavascriptInterface 注入 window.QLNative。
   * 所有方法都是异步的：调用时带一个回调 id，原生侧完成后再回灌结果，
   * 避免在 JavaBridge 线程上做 UI 操作导致卡顿。
   * 浏览器里没有这个对象 —— 此时全部走 Web 降级路径。
   */
  var NATIVE = (typeof window.QLNative !== 'undefined' && window.QLNative) ? window.QLNative : null;
  var nativeSeq = 0;
  var nativePending = {};

  function nativeCall(method, args, cb) {
    if (!NATIVE || typeof NATIVE[method] !== 'function') {
      cb(new Error('当前环境不支持该操作'));
      return;
    }
    var id = 'q' + (++nativeSeq);
    nativePending[id] = cb;
    try {
      NATIVE[method](id, JSON.stringify(args || {}));
    } catch (e) {
      delete nativePending[id];
      cb(new Error('原生调用失败：' + (e && e.message ? e.message : e)));
    }
  }

  window.__qlNative = function (id, payload) {
    var cb = nativePending[id];
    if (!cb) return;
    delete nativePending[id];
    var data = null;
    try { data = JSON.parse(payload); } catch (e) { data = null; }
    if (!data || data.error) cb(new Error((data && data.error) || '原生调用失败'));
    else cb(null, data);
  };

  /* ---------------- 登录 / 注册 ---------------- */

  /**
   * 四种可选择的登录 / 注册方式：
   *   password   账号 + 密码（默认，轻聊自有体系）
   *   email      邮箱（登录走邮箱密码，注册走邮箱验证码）
   *   otp        验证码（邮箱验证码或短信验证码）
   *   workbuddy  WorkBuddy 账号（跳官方授权页）
   */
  var authTabs = document.querySelectorAll('[data-auth-tab]');
  var authModeBtns = document.querySelectorAll('[data-auth-mode]');
  var authMode = 'login';        // login | reg
  var authMethod = 'password';   // password | email | otp | workbuddy
  var otpInfo = { verificationId: '', isExistingUser: false };

  /** 按当前「方式 × 模式」刷新表单可见性与文案 */
  function syncAuthForm() {
    var reg = (authMode === 'reg');
    var m = authMethod;
    var isWb = (m === 'workbuddy');

    for (var i = 0; i < authModeBtns.length; i++) {
      authModeBtns[i].className =
        (authModeBtns[i].getAttribute('data-auth-mode') === m) ? 'mode active' : 'mode';
    }

    $('au').className = isWb ? 'inp hide' : 'inp';
    $('ap').className = (isWb || m === 'otp') ? 'inp hide' : 'inp';
    $('an').className = (!reg || isWb) ? 'inp hide' : 'inp';

    // 验证码行：验证码方式必用；邮箱注册也要用（上游要求先验码再注册）
    var needCode = (m === 'otp') || (m === 'email' && reg);
    $('codeRow').className = needCode ? 'row-code' : 'row-code hide';

    $('ab').className = isWb ? 'btn primary full hide' : 'btn primary full';
    $('awb').className = isWb ? 'btn full' : 'btn full hide';

    if (m === 'password') {
      $('au').placeholder = '账号（2-20位中英文数字）';
      $('ap').placeholder = '密码（至少6位）';
      $('atip').textContent = '账号唯一不可重复，密码加盐哈希存储';
    } else if (m === 'email') {
      $('au').placeholder = '邮箱地址';
      $('ap').placeholder = reg ? '设置密码（至少6位）' : '密码（至少6位）';
      $('atip').textContent = reg
        ? '邮箱注册需要先获取验证码，验证邮箱归属后再设置密码'
        : '邮箱 + 密码登录，密码由云服务校验';
    } else if (m === 'otp') {
      $('au').placeholder = '邮箱或手机号';
      $('ac').placeholder = '邮箱 / 短信验证码';
      $('atip').textContent = '验证码由云服务发送，邮箱与手机号均可';
    } else {
      $('atip').textContent = '将跳转 WorkBuddy 官方账号授权页完成登录';
    }

    $('ab').textContent = reg ? '注 册' : '登 录';
    $('aerr').textContent = '';
  }

  for (var i = 0; i < authTabs.length; i++) {
    authTabs[i].onclick = function () {
      authMode = this.getAttribute('data-auth-tab');
      for (var j = 0; j < authTabs.length; j++) authTabs[j].className = 'tab';
      this.className = 'tab active';
      syncAuthForm();
    };
  }
  for (var k = 0; k < authModeBtns.length; k++) {
    authModeBtns[k].onclick = function () {
      authMethod = this.getAttribute('data-auth-mode');
      otpInfo = { verificationId: '', isExistingUser: false };
      syncAuthForm();
    };
  }
  syncAuthForm();

  /** 发送验证码（邮箱或手机号，由输入内容自动判断渠道） */
  $('acode').onclick = function () {
    var target = $('au').value.trim();
    if (!target) { $('aerr').textContent = '请先填写邮箱或手机号'; return; }
    $('acode').disabled = true;
    api('POST', '/api/auth/otp/send', { target: target }, function (err, data) {
      $('acode').disabled = false;
      if (err) { $('aerr').textContent = err.message; return; }
      otpInfo.verificationId = data.verificationId;
      otpInfo.isExistingUser = !!data.isExistingUser;
      $('aerr').textContent = '';
      toast(data.message || '验证码已发送', 3000);
    });
  };

  /** 跳转 WorkBuddy 官方授权页 */
  function startWorkBuddyLogin() {
    $('aerr').textContent = '';
    api('GET', '/api/auth/wb/start', null, function (err, data) {
      if (err) { $('aerr').textContent = err.message; return; }
      location.href = data.url;
    });
  }
  $('awb').onclick = startWorkBuddyLogin;

  $('ab').onclick = function () {
    if (authMethod === 'workbuddy') { startWorkBuddyLogin(); return; }
    var target = $('au').value.trim();
    var pwd = $('ap').value;
    var code = $('ac').value.trim();
    var nick = $('an').value.trim();
    var reg = (authMode === 'reg');
    var path, body;

    if (authMethod === 'password') {
      if (!target || !pwd) { $('aerr').textContent = '请填写账号和密码'; return; }
      path = reg ? '/api/register' : '/api/login';
      body = reg ? { username: target, password: pwd, nickname: nick }
                 : { username: target, password: pwd };
    } else if (authMethod === 'email') {
      if (!target) { $('aerr').textContent = '请填写邮箱地址'; return; }
      if (!pwd) { $('aerr').textContent = '请填写密码'; return; }
      path = '/api/auth/email';
      body = { mode: reg ? 'reg' : 'login', email: target, password: pwd, nickname: nick };
      if (reg) {
        if (!otpInfo.verificationId) { $('aerr').textContent = '请先点「获取验证码」验证邮箱'; return; }
        body.verificationId = otpInfo.verificationId;
        body.token = code;
        body.isExistingUser = otpInfo.isExistingUser;
      }
    } else {  // otp
      if (!target) { $('aerr').textContent = '请填写邮箱或手机号'; return; }
      if (!code) { $('aerr').textContent = '请填写验证码'; return; }
      if (!otpInfo.verificationId) { $('aerr').textContent = '请先点「获取验证码」'; return; }
      path = '/api/auth/otp/verify';
      body = {
        mode: reg ? 'reg' : 'login',
        target: target,
        token: code,
        verificationId: otpInfo.verificationId,
        isExistingUser: otpInfo.isExistingUser,
        nickname: nick
      };
      if (reg && pwd) body.password = pwd;
    }

    $('ab').disabled = true;
    var permKey = $('ak') ? $('ak').value.trim() : '';
    if (permKey) body.permKey = permKey;
    api('POST', path, body, function (err, data) {
      $('ab').disabled = false;
      if (err) { $('aerr').textContent = err.message; return; }
      // 密钥正确但没有权限？统一在进主界面后飘一条提示，不打断登录
      if (data.perm && !data.perm.granted && data.perm.error) {
        setTimeout(function () { toast(data.perm.error + '（不影响登录）', 4000); }, 600);
      }
      if (data.perm && data.perm.granted) {
        setTimeout(function () { toast('最高权限已激活，30 分钟内有效', 4000); }, 600);
      }
      afterLogin(data);
    });
  };

  $('ap').onkeydown = function (e) { if (e.keyCode === 13) $('ab').click(); };
  $('au').onkeydown = function (e) { if (e.keyCode === 13) $('ap').focus(); };
  $('ac').onkeydown = function (e) { if (e.keyCode === 13) $('ab').click(); };

  function afterLogin(data) {
    S.token = data.token;
    S.user = data.user;
    localStorage.setItem('ll_token', data.token);
    enterApp();
  }

  function enterApp() {
    $('auth').className = 'screen hide';
    $('main').className = 'screen';
    $('tbUser').textContent = S.user ? (S.user.nickname || S.user.username) : '';
    // 版本与能力标记是公开信息，顺手拿一次；「我的」页据此决定是否显示网盘入口
    api('GET', '/api/version', null, function (err, d) {
      if (err || !d) return;
      var had = !!S.version;
      S.version = d;
      if (!had && S.view === 'me') renderMe();
      if (S.view === 'public' && S.rooms.length) renderPublic();  // 公告到位后刷新公共入口页
      // 【标准版专属】心跳 + 同时在线人数（基础版无此逻辑）
      if (!S.pulseTimer) {
        api('POST', '/api/pulse', {}, null);
        S.pulseTimer = setInterval(function () { api('POST', '/api/pulse', {}, null); }, 15000);
      }
      if (!S.onlineTimer) {
        refreshOnlineCount();
        S.onlineTimer = setInterval(refreshOnlineCount, 30000);
      }
    });
    loadStorage();
    loadRooms();
    loadDMList();  // 私聊不属于房间；单独枚举以便「清除本机记录」能覆盖到
    skinLoad(function () {
      // 恢复本机保存的皮肤（列表到位后才能拿到 CSS 地址）
      skinApply(S.skin);
      if (S.view === 'public') renderPublic();
    });
    applyGoldFx();
    switchView(S.view);
    // 深链进房：房间列表加载后自动打开
    if (S.deepRoom) {
      var rid = S.deepRoom;
      S.deepRoom = '';
      loadRooms(function () { openRoom(rid); });
    }
    // 深链搜索：切到房间页并自动搜
    if (S.deepRoomQ) {
      S.view = 'rooms';
      switchView('rooms');
      if ($('roomQ')) $('roomQ').value = S.deepRoomQ;
      doSearchRooms();
      S.deepRoomQ = '';
    }
  }

  /** 顶栏用户名随昵称/头像变化刷新（改昵称、换头像后调用） */
  function refreshUserBar() {
    var t = $('tbUser');
    if (t && S.user) t.textContent = S.user.nickname || S.user.username;
  }

  /* ---------------- 底部导航 ---------------- */

  var navBtns = document.querySelectorAll('.tb-btn');
  for (var k = 0; k < navBtns.length; k++) {
    navBtns[k].onclick = function () { switchView(this.getAttribute('data-view')); };
  }

  var VIEW_TITLE = {
    public: '主页',
    rooms: '我的房间',
    friends: '好友',
    me: '我的',
    drive: '我的网盘'
  };

  function switchView(v) {
    S.view = v;
    for (var i = 0; i < navBtns.length; i++) {
      navBtns[i].className = (navBtns[i].getAttribute('data-view') === v) ? 'tb-btn active' : 'tb-btn';
    }
    $('tbTitle').textContent = VIEW_TITLE[v] || '我的';
    renderView();
    // 好友页：切进来就拉一次最新数据，并开实时刷新；其它页面关掉轮询，避免空转
    if (v === 'friends') { startFriendPoll(); loadFriends(); }
    else stopFriendPoll();
    // 网盘页：先渲染缓存再拉最新，避免白屏
    if (v === 'drive') { renderDrive(); loadDriveStorage(function () { renderDrive(); }); loadDrive(); }
  }

  function renderView() {
    if (S.view === 'public') renderPublic();
    else if (S.view === 'rooms') renderRooms();
    else if (S.view === 'friends') renderFriends();
    else if (S.view === 'drive') renderDrive();
    else renderMe();
  }

  function loadRooms(cb) {
    api('GET', '/api/rooms', null, function (err, data) {
      if (err) { toast(err.message); return; }
      S.rooms = data.rooms;
      S.publicRoomId = data.publicRoomId;
      renderView();
      if (cb) cb();
    });
  }

  /** 拉取我的私聊列表（不是房间），只填 dmCache 供清除本机记录使用，不在任何界面列出 */
  function loadDMList() {
    api('GET', '/api/dm/list', null, function (err, data) {
      if (err || !data) return;
      for (var i = 0; i < data.items.length; i++) {
        var it = data.items[i];
        if (it.userId && it.id) S.dmCache[it.userId] = it.id;
      }
    });
  }

  /* ---------------- 视图：公共聊天室 ---------------- */

  /** 官方公告卡片：有内容才显示，空则完全不出现（数据来自 /api/version.announcement） */
  function announcementHtml() {
    var a = (S.version && S.version.announcement) || {};
    if (!a.enabled || !(a.content || a.title)) return '';
    var h = '<div class="card"><div class="card-h">📢 ' +
      (a.title ? esc(a.title) : '官方公告') + '</div>' +
      '<div style="padding:11px 13px;font-size:13px;color:var(--fg-2);line-height:1.7;white-space:pre-wrap">' +
      esc(a.content) + '</div></div>';
    return h;
  }

  function renderPublic() {
    var h = '';
    var pub = null;
    for (var i = 0; i < S.rooms.length; i++) {
      if (S.rooms[i].kind === 'public') { pub = S.rooms[i]; break; }
    }
    if (!pub) { h = '<div class="empty">加载中…</div>'; }
    else {
      h += '<div class="card">' +
        '<div class="row" data-open="' + pub.id + '">' +
        '<div class="r-main"><div class="r-title">🌍 ' + esc(pub.name) +
        '<span class="badge">全员可发言</span>' +
        '<span class="badge">' + num(S.onlineCount) + ' 人同时在线</span></div>' +
        '<div class="r-sub">' + pub.memberCount + ' 人已加入 · 所有登录用户均可发送文字/图片/视频/文件</div></div>' +
        '<span style="color:var(--fg-3)">›</span></div></div>';
      h += announcementHtml();
      h += '<div class="card"><div class="card-h">💡 提示</div>' +
        '<div style="padding:11px 13px;font-size:13px;color:var(--fg-2);line-height:1.7">' +
        '公共聊天室对所有登录用户开放，无需加入即可发言。<br>' +
        '单文件上限 200MB，支持分片上传与断点续传。<br>' +
        '消息发送后 2 分钟内可撤回；删除仅对自己隐藏；直接删除可随时彻底清除。</div></div>';
    }
    /* 皮肤中心：标准版专属，换整站外观 */
    h += '<div class="card"><div class="card-h">🎨 皮肤</div>' +
      '<div class="act" data-skin-open>' +
      '皮肤中心' + (S.skin ? ' · 当前「' + esc((skinFind(S.skin) || {}).name || S.skin) + '」' : ' · 当前原版') +
      '</div></div>';

    h += '<div class="card"><div class="card-h">🚪 其他入口</div>' +
      '<div class="act" data-go="rooms">进入「我的房间」→ 创建或加入自定义房间</div>' +
      '<div class="act" data-go="friends">进入「好友」→ 添加好友并发起私聊</div></div>';
    $('view').innerHTML = h;
    bindView();
    var skinEntry = $('view').querySelector('[data-skin-open]');
    if (skinEntry) skinEntry.onclick = openSkins;
  }

  /* ---------------- 视图：房间 ---------------- */

  function renderRooms() {
    var h = '<div class="card"><div class="card-h">操作</div>' +
      '<div class="act" id="createRoom">➕ 创建自定义房间（上限 5 个）</div></div>';
    // 搜索房间（按名称）：结果卡片结尾带「进去看看 / 加入该房间」
    h += '<div class="card"><div class="card-h">搜索房间</div>' +
      '<div class="srch-bar">' +
      '<input id="roomQ" class="inp grow" type="text" placeholder="输入房间名关键词…" maxlength="40">' +
      '<button class="btn small primary" id="roomSearchGo">搜索</button></div>' +
      '<div id="roomSearchOut"></div></div>';
    var mine = [], others = [];
    for (var i = 0; i < S.rooms.length; i++) {
      var r = S.rooms[i];
      if (r.kind === 'public') continue;
      if (r.kind === 'dm') continue;  // 私聊不是房间，不进房间列表
      if (r.joined || r.ownerId === (S.user && S.user.id)) mine.push(r); else others.push(r);
    }
    h += '<div class="card"><div class="card-h">我已加入 / 我创建的 (' + mine.length + ')</div>';
    if (!mine.length) h += '<div class="empty">还没有房间，创建一个吧</div>';
    else {
      for (var j = 0; j < mine.length; j++) {
        var r = mine[j];
        h += '<div class="row" data-open="' + r.id + '"><div class="r-main">' +
          '<div class="r-title">' + esc(r.name) +
          (r.name === 'Bug 反馈' ? '<span class="badge ok">官方</span>' : '') +
          (r.hasPassword ? '<span class="badge warn">密码</span>' : '<span class="badge gray">免密</span>') +
          (r.role ? '<span class="badge">' + esc(r.roleName) + '</span>' : '') +
          (r.dissolved ? '<span class="badge warn">已解散</span>' : '') + '</div>' +
          '<div class="r-sub">' + r.memberCount + ' 人' + (r.joined ? '' : ' · 未加入') +
          (r.dissolved ? ' · 仅可查看历史' : '') + '</div></div>' +
          '<span style="color:var(--fg-3)">›</span></div>';
      }
    }
    h += '</div>';
    h += '<div class="card"><div class="card-h">其他房间 (' + others.length + ')</div>';
    if (!others.length) h += '<div class="empty">暂无其他房间</div>';
    else {
      for (var m = 0; m < others.length; m++) {
        var o = others[m];
        h += '<div class="row"><div class="r-main"><div class="r-title">' + esc(o.name) +
          (o.name === 'Bug 反馈' ? '<span class="badge ok">官方</span>' : '') +
          (o.hasPassword ? '<span class="badge warn">密码</span>' : '<span class="badge gray">免密</span>') + '</div>' +
          '<div class="r-sub">' + o.memberCount + ' 人</div></div>' +
          '<button class="btn small primary" data-join="' + o.id + '">加入</button></div>';
      }
    }
    h += '</div>';
    $('view').innerHTML = h;
    bindView();
    // 搜索房间交互（标准版专属，低配/基础版不带）
    if ($('roomSearchGo')) $('roomSearchGo').onclick = doSearchRooms;
    if ($('roomQ')) {
      $('roomQ').onkeydown = function (e) {
        if (e.key === 'Enter' || e.keyCode === 13) doSearchRooms();
      };
    }
    renderRoomSearchResults();
  }

  /* ---------------- 搜索房间 ---------------- */

  /** 按房间名搜索；结果暂存 S.roomSearch，切换视图后回来还在 */
  function doSearchRooms() {
    var q = ($('roomQ') && $('roomQ').value || '').trim();
    if (!q) { toast('请输入搜索关键词'); return; }
    api('GET', '/api/rooms/search?q=' + encodeURIComponent(q), null, function (err, data) {
      if (err) { toast(err.message); return; }
      S.roomSearch = { kw: q, results: data.results || [] };
      renderRoomSearchResults();
    });
  }

  /** 房间名里的关键词高亮（只对命中片段着色） */
  function hlKeyword(name, kw) {
    name = String(name || '');
    kw = String(kw || '');
    var i = name.toLowerCase().indexOf(kw.toLowerCase());
    if (i < 0 || !kw) return esc(name);
    return esc(name.slice(0, i)) + '<mark class="kw">' + esc(name.substr(i, kw.length)) +
      '</mark>' + esc(name.slice(i + kw.length));
  }

  function renderRoomSearchResults() {
    var box = $('roomSearchOut');
    if (!box) return;
    var d = S.roomSearch;
    if (!d) { box.innerHTML = ''; return; }
    if (!d.results.length) {
      box.innerHTML = '<div class="empty">没有找到名称含「' + esc(d.kw) + '」的房间</div>';
      return;
    }
    var h = '';
    for (var i = 0; i < d.results.length; i++) {
      var r = d.results[i];
      h += '<div class="srch-item">' +
        '<div class="r-main">' +
        '<div class="r-title">🏠 ' + hlKeyword(r.name, d.kw) +
        (r.hasPassword ? '<span class="badge warn">密码</span>' : '<span class="badge gray">免密</span>') +
        (r.joined ? '<span class="badge">已加入</span>' : '') + '</div>' +
        '<div class="r-sub">' + r.memberCount + ' 人' +
        (r.ownerName ? ' · 房主：' + esc(r.ownerName) : '') + '</div>' +
        '</div>' +
        '<button class="btn small" data-peek="' + r.id + '">进去看看</button>' +
        '<button class="btn small primary" data-sjoin="' + r.id + '">加入该房间</button>' +
        '</div>';
    }
    box.innerHTML = h;
    var peeks = box.querySelectorAll('[data-peek]');
    for (var p = 0; p < peeks.length; p++) {
      peeks[p].onclick = function () { peekRoom(this.getAttribute('data-peek')); };
    }
    var joins = box.querySelectorAll('[data-sjoin]');
    for (var j = 0; j < joins.length; j++) {
      joins[j].onclick = function () { searchJoinRoom(this.getAttribute('data-sjoin')); };
    }
  }

  function searchItem(id) {
    var d = (S.roomSearch && S.roomSearch.results) || [];
    for (var i = 0; i < d.length; i++) if (d[i].id === id) return d[i];
    return null;
  }

  /** 进去看看：免密房间直接看（不加入、只读）；密码房先验证密码 */
  function peekRoom(id) {
    var item = searchItem(id);
    if (item && item.hasPassword) {
      openModal('输入房间密码',
        '<input id="jp" type="password" placeholder="房间密码">',
        function () {
          var p = $('jp').value;
          api('POST', '/api/rooms/' + id + '/verify', { password: p }, function (err) {
            if (err) { toast(err.message); return; }
            openRoom(id, item.name);
          });
          return true;
        }, '进去看看');
    } else {
      openRoom(id, item ? item.name : null);
    }
  }

  /** 加入该房间：密码房先输密码，加入成功后自动进入 */
  function searchJoinRoom(id) {
    var item = searchItem(id);
    if (item && item.hasPassword) {
      openModal('输入房间密码',
        '<input id="jp" type="password" placeholder="房间密码">',
        function () {
          doJoin(id, $('jp').value);
          return true;
        }, '加入');
    } else {
      doJoin(id, '');
    }
  }

  /* ---------------- 视图：好友 ---------------- */

  /**
   * 建元素的糖：el('div', 'card-h', '标题')
   * 好友视图用真实 DOM 构建（而不是 innerHTML 字符串），
   * 这样头像、同意/拒绝这些交互点都能直接绑事件、也能被测试驱动。
   */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  /**
   * 头像：有自定义头像就铺图，没有则回落到「色块 + 首字」。
   * 色值优先取服务端下发，缺失时用本地算法补。
   */
  function avatarEl(userId, initial, color, cls, avatarUrl) {
    var a = el('div', cls || 'row-av', avatarUrl ? '' : (initial || '?'));
    a.style.background = color || colorOf(userId || '');
    if (avatarUrl) {
      a.style.backgroundImage = 'url("' + avatarUrl + '")';
      a.style.backgroundSize = 'cover';
      a.style.backgroundPosition = 'center';
    }
    a.setAttribute('data-profile', userId || '');
    a.title = '查看资料';
    a.onclick = function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      openProfile(userId);
    };
    return a;
  }

  /** 收到的好友申请：横条点开的弹窗（同意/拒绝直接在这里操作） */
  function showIncoming() {
    var box = el('div');
    box.style.maxHeight = '52vh';
    box.style.overflow = 'auto';
    if (!S.incoming.length) {
      box.appendChild(el('div', 'empty', '暂无收到的好友申请'));
    } else {
      for (var i = 0; i < S.incoming.length; i++) {
        (function (r) {
          var row = el('div', 'req-row');
          row.appendChild(avatarEl(r.fromId || r.id, r.initial, r.avatarColor, null, r.avatar));
          var main = el('div', 'r-main');
          var title = el('div', 'r-title');
          title.appendChild(el('span', 'nm', r.nickname));
          title.appendChild(el('span', 'badge gray', r.username));
          main.appendChild(title);
          main.appendChild(el('div', 'req-msg' + (r.message ? '' : ' dim'), r.message || '（未填写附言）'));
          main.appendChild(el('div', 'r-sub', '申请时间 ' + fmtAgo(r.createdAt)));
          row.appendChild(main);
          var acts = el('div', 'req-acts');
          var okBtn = el('button', 'btn small primary', '同意');
          okBtn.onclick = function () { acceptFriend(r.id); closeModal(); };
          var noBtn = el('button', 'btn small ghost', '拒绝');
          noBtn.onclick = function () { rejectFriend(r.id); closeModal(); };
          acts.appendChild(okBtn); acts.appendChild(noBtn);
          row.appendChild(acts);
          box.appendChild(row);
        })(S.incoming[i]);
      }
    }
    openModal('收到的好友申请（' + S.incoming.length + '）', box, null, '关闭');
    // 看过就消红点：把当前最大申请时间记为已读水位
    var maxIn = 0;
    for (var j = 0; j < S.incoming.length; j++) maxIn = Math.max(maxIn, num(S.incoming[j].createdAt));
    if (maxIn > (readFriendSeen('in') || 0)) writeFriendSeen('in', maxIn);
    updateFriendEntries();
  }
  /** 我发出的请求 + 最近被同意：横条点开的弹窗 */
  function showOutgoing() {
    var box = el('div');
    box.style.maxHeight = '52vh';
    box.style.overflow = 'auto';
    if (S.recentAccepted.length) {
      box.appendChild(el('div', 'card-h', '对方已同意'));
      for (var i = 0; i < S.recentAccepted.length; i++) {
        var a = S.recentAccepted[i];
        box.appendChild(el('div', 'r-sub', '✓ ' + (a.nickname || a.username) + ' 已同意你的请求 · ' + fmtAgo(a.acceptedAt)));
      }
    }
    box.appendChild(el('div', 'card-h', '等待对方同意（' + S.outgoing.length + '）'));
    if (!S.outgoing.length) {
      box.appendChild(el('div', 'empty', '暂无发出的好友请求'));
    } else {
      for (var j = 0; j < S.outgoing.length; j++) {
        var o = S.outgoing[j];
        var line = el('div', 'req-row');
        var m = el('div', 'r-main');
        m.appendChild(el('div', 'r-title', o.nickname + '  ' + o.username));
        m.appendChild(el('div', 'r-sub', '等待对方同意 · ' + fmtAgo(o.createdAt)));
        line.appendChild(m);
        box.appendChild(line);
      }
    }
    openModal('我发出的请求（' + S.outgoing.length + '）', box, null, '关闭');
    var maxAcc = 0;
    for (var k = 0; k < S.recentAccepted.length; k++) maxAcc = Math.max(maxAcc, num(S.recentAccepted[k].acceptedAt));
    if (maxAcc > (readFriendSeen('acc') || 0)) writeFriendSeen('acc', maxAcc);
    updateFriendEntries();
  }

  /** 只更新两个横条入口的红点/数量，不整页重绘 */
  function updateFriendEntries() {
    var seenIn = readFriendSeen('in') || 0, seenAcc = readFriendSeen('acc') || 0;
    var newIn = 0, newAcc = 0, i;
    for (i = 0; i < S.incoming.length; i++) if (num(S.incoming[i].createdAt) > seenIn) newIn++;
    for (i = 0; i < S.recentAccepted.length; i++) if (num(S.recentAccepted[i].acceptedAt) > seenAcc) newAcc++;
    var inRow = $('openIncoming'), outRow = $('openOutgoing');
    if (inRow) {
      inRow.innerHTML = '<span class="req-dot' + (newIn ? ' on' : '') + '"></span>' +
        '📥 收到的好友申请 <span class="num">' + S.incoming.length + '</span>' +
        (newIn ? '<span class="badge warn">新 ' + newIn + '</span>' : '');
    }
    if (outRow) {
      outRow.innerHTML = '<span class="req-dot' + (newAcc ? ' on' : '') + '"></span>' +
        '📤 我发出的请求 <span class="num">' + S.outgoing.length + '</span>' +
        (newAcc ? '<span class="badge warn">新 ' + newAcc + '</span>' : '');
    }
  }

  function renderFriends() {
    var v = $('view');
    v.innerHTML = '';

    // ---- 操作 ----
    var c0 = el('div', 'card');
    c0.appendChild(el('div', 'card-h', '操作'));
    var act = el('div', 'act', '🔍 搜索用户并添加好友');
    act.id = 'searchUser';
    act.onclick = searchUser;
    c0.appendChild(act);
    v.appendChild(c0);

    // ---- 收到的申请 / 发出的请求：两个横条入口，点开弹窗查看 ----
    // 红点口径：收到申请的时间 > 本地已看水位；被同意的时间 > 本地已看水位
    var seenIn = readFriendSeen('in') || 0;
    var seenAcc = readFriendSeen('acc') || 0;
    var newIn = 0, newAcc = 0;
    for (var q = 0; q < S.incoming.length; q++) {
      if (num(S.incoming[q].createdAt) > seenIn) newIn++;
    }
    for (var q2 = 0; q2 < S.recentAccepted.length; q2++) {
      if (num(S.recentAccepted[q2].acceptedAt) > seenAcc) newAcc++;
    }

    var c1 = el('div', 'card');
    var inRow = el('div', 'act req-entry');
    inRow.id = 'openIncoming';
    inRow.innerHTML = '<span class="req-dot' + (newIn ? ' on' : '') + '"></span>' +
      '📥 收到的好友申请 <span class="num">' + S.incoming.length + '</span>' +
      (newIn ? '<span class="badge warn">新 ' + newIn + '</span>' : '');
    inRow.onclick = showIncoming;
    c1.appendChild(inRow);

    var outRow = el('div', 'act req-entry');
    outRow.id = 'openOutgoing';
    outRow.innerHTML = '<span class="req-dot' + (newAcc ? ' on' : '') + '"></span>' +
      '📤 我发出的请求 <span class="num">' + S.outgoing.length + '</span>' +
      (newAcc ? '<span class="badge warn">新 ' + newAcc + '</span>' : '');
    outRow.onclick = showOutgoing;
    c1.appendChild(outRow);
    v.appendChild(c1);

    // ---- 我的好友 ----
    var c3 = el('div', 'card');
    c3.appendChild(el('div', 'card-h', '我的好友 (' + S.friends.length + ')'));
    if (!S.friends.length) {
      c3.appendChild(el('div', 'empty', '还没有好友，搜索添加一个吧'));
    } else {
      for (var k = 0; k < S.friends.length; k++) {
        var f = S.friends[k];
        var frow = el('div', 'row');
        frow.setAttribute('data-dm', f.id);
        frow.onclick = (function (id) {
          return function () { openDM(id); };
        })(f.id);
        frow.appendChild(avatarEl(f.id, f.initial, f.avatarColor, null, f.avatar));
        var fmain = el('div', 'r-main');
        var ftitle = el('div', 'r-title');
        ftitle.appendChild(el('span', 'nm', f.nickname));
        ftitle.appendChild(el('span', 'badge gray', f.username));
        fmain.appendChild(ftitle);
        fmain.appendChild(el('div', 'r-sub', '点击开始私聊'));
        frow.appendChild(fmain);
        frow.appendChild(el('span', 'row-arrow', '›'));
        c3.appendChild(frow);
      }
    }
    v.appendChild(c3);
  }

  /* ---------------- 视图：我的 ---------------- */

  /** 拉取当前账号的存储配额（「我的」页显示 + 上传前预检都用它） */
  function loadStorage(cb) {
    api('GET', '/api/me/storage', null, function (err, d) {
      if (!err && d) S.storage = d;
      if (typeof cb === 'function') cb();
    });
  }

  /** 历史更新记录：读取服务端 /api/version 里的 changelog（只存一份、默认不显示），点开才渲染 */
  function showChangelog() {
    var v = S.version || {};
    var cl = v.changelog || {};
    var list = cl.releases || [];
    if (!list.length) { toast('暂无更新记录'); return; }
    var h = '<div style="max-height:52vh;overflow:auto;font-size:13px;line-height:1.7">';
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      h += '<div style="padding:9px 0;border-bottom:1px solid var(--border-2)">' +
        '<div style="font-weight:600;color:var(--accent)">v' + esc(r.version) +
        ' <span style="font-weight:400;color:var(--fg-3)">· ' + esc(r.date || '') +
        (r.code ? ' · code ' + esc(r.code) : '') + '</span></div>';
      var ch = r.changes || [];
      for (var j = 0; j < ch.length; j++) {
        h += '<div style="color:var(--fg-2);padding-left:12px;margin-top:3px">· ' + esc(ch[j]) + '</div>';
      }
      h += '</div>';
    }
    h += '</div>';
    openModal('历史更新记录', h, null, '关闭');
  }

  function renderMe() {
    // 未登录 / 登录态刚失效时兜底，避免直接读 S.user 崩掉整页
    if (!S.user) {
      var box0 = $('view');
      if (box0) box0.innerHTML = '<div class="empty">登录状态已失效，请重新登录。</div>';
      return;
    }
    var h = '<div class="card"><div class="card-h">账号信息</div>' +
      '<div class="row me-av-row"><div class="me-av" id="myAvatar"></div>' +
      '<div class="r-main"><div class="r-title">' + esc(S.user.nickname) + '</div>' +
      '<div class="r-sub">账号：' + esc(S.user.username) + '（不可修改）</div></div>' +
      '<div class="r-right"><div class="mini-btn" id="editNick">修改昵称</div>' +
      '<div class="mini-btn" id="changeAvatar" style="margin-top:6px">更换头像</div></div></div></div>';

    /* 最高权限：永久权限账号只展示状态；其他人可在此输入密钥激活 / 续期 30 分钟窗口 */
    h += '<div class="card"><div class="card-h">最高权限</div>';
    if (S.user.founder) {
      h += '<div class="row"><div class="r-main">' +
        '<div class="r-title perm-gold">✦ 永久最高权限</div>' +
        '<div class="r-sub">可解散公共大厅、删除任意内容、注销指定用户</div>' +
        '</div></div>';
    } else {
      h += '<div class="perm-box">' +
        '<div class="r-sub">' + (S.user.master
          ? '已激活 · 剩余 ' + permRemainText() + '（重新输入可续期）'
          : '输入权限密钥后开启 30 分钟最高权限') + '</div>' +
        '<input id="permKeyInput" class="inp" type="text" placeholder="权限密钥" autocomplete="off">' +
        '<div class="mini-btn" id="permActivate">激活 / 续期</div>' +
        '</div>';
    }
    h += '</div>';

    /* 存储配额：每人 2GB，超出后禁止上传 */
    var st = S.storage;
    var pct = st ? st.percent : 0;
    h += '<div class="card"><div class="card-h">我的存储空间</div>' +
      '<div class="quota-box">' +
      '<div class="quota-top"><span class="quota-used">' +
      (st ? st.usedText + ' / ' + st.quotaText : '统计中…') + '</span>' +
      '<span class="quota-remain">剩余 ' + (st ? st.remainText : '…') + '</span></div>' +
      '<div class="quota-track"><div class="quota-fill' + (pct >= 90 ? ' warn' : '') +
      '" style="width:' + pct + '%"></div></div>' +
      '<div class="r-sub">每个账号 2GB 配额，超出后无法上传新文件；删除文件即可释放空间</div>' +
      '</div></div>';

    h += '<div class="card"><div class="card-h">功能说明</div>' +
      '<div style="padding:11px 13px;font-size:13px;color:var(--fg-2);line-height:1.8">' +
      '· 数据全部存储在服务端，设备关机后其它设备仍可正常收发<br>' +
      '· 多端同步：同一账号在任意设备登录，历史消息与文件一致<br>' +
      '· 公共聊天室 / 自定义房间 / 私聊 均可发送文字与文件<br>' +
      '· 单文件上限 200MB，分片上传 + 断点续传<br>' +
      '· 删除 = 仅对自己隐藏；撤回 = 发送者 2 分钟内，彻底移除<br>' +
      '· 直接删除 = 无时间限制，服务器端彻底清除，所有设备同步消失</div></div>';
    h += '<div class="card"><div class="act" id="viewChangelog">📜 历史更新记录 · 查看每个版本新增与修复</div></div>';
    h += '<div class="card"><div class="card-h">开发者联系方式</div>' +
      '<div class="r-sub" style="padding:11px 13px;white-space:normal">' +
      '反馈问题或建议请发邮件给开发者：<br>' +
      '<a href="mailto:' + esc(S.contact || (S.version && S.version.contact) || 'ngkz5993@agent.qq.com') + '">' +
      esc(S.contact || (S.version && S.version.contact) || 'ngkz5993@agent.qq.com') + '</a></div></div>';
    h += '<div class="card"><div class="act" data-go="settings">⚙️ 设置 · 缓存 / 聊天记录 / 下载路径</div></div>';
    h += '<div class="card"><div class="act" id="openAppearance">🎨 外观 · 当前主题：' + themeLabel() + '</div></div>';
    h += '<div class="card"><div class="act danger" id="logout">退出登录</div></div>';
    h += '<div class="card"><div class="act danger" id="deleteAccount">注销账号（不可恢复）</div></div>';
    $('view').innerHTML = h;
    // 用 querySelectorAll：以前只绑了第一个 data-go=settings，「外观」行是死链
    var setEntries = $('view').querySelectorAll('[data-go="settings"]');
    for (var se = 0; se < setEntries.length; se++) {
      setEntries[se].onclick = function () { openSettings(); };
    }
    bind('openAppearance', openThemeModal);
    var clEntry = $('viewChangelog');
    if (clEntry) clEntry.onclick = showChangelog;
    bind('editNick', doChangeNickname);
    bind('changeAvatar', doChangeAvatar);
    renderMyAvatar();
    bind('permActivate', doActivatePerm);
    bind('openNetdisk', function () { switchView('drive'); });
    // 首次进来还没有配额数据：拉一次再重绘（用 loading 标记防止渲染循环）
    if (!S.storage && !S.storageLoading) {
      S.storageLoading = true;
      loadStorage(function () {
        S.storageLoading = false;
        if (S.view === 'me') renderMe();
      });
    }
    bind('logout', function () {
      api('POST', '/api/logout', {}, function () {
        localStorage.removeItem('ll_token');
        location.reload();
      });
    });
    bind('deleteAccount', doDeleteAccount);
  }

  /** 最高权限剩余时间文案（分钟 + 秒） */
  function permRemainText() {
    var ms = Number(S.user && S.user.masterRemainMs) || 0;
    if (S.user && S.user.founder) return '永久';
    if (ms <= 0) return '0 秒';
    var total = Math.floor(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m > 0 ? m + ' 分 ' : '') + s + ' 秒';
  }

  /** 在「我的」页输入权限密钥：激活或续期 30 分钟最高权限 */
  function doActivatePerm() {
    var inp = $('permKeyInput');
    var key = inp ? String(inp.value || '').trim() : '';
    if (!key) { toast('请输入权限密钥'); return; }
    api('POST', '/api/auth/perm', { key: key }, function (err, d) {
      if (err) { toast(err.message, 4000); return; }
      S.user = d.user;
      renderMe();
      refreshUserBar();
      toast('最高权限已激活，30 分钟内有效', 3500);
    });
  }

  /* ---- 自定义头像：选图 → canvas 压到 256px → 上传 ---- */

  function renderMyAvatar() {
    var box = $('myAvatar');
    if (!box || !S.user) return;
    box.innerHTML = '';
    var a = avatarEl(S.user.id, S.user.initial, S.user.avatarColor, 'me-av-in', S.user.avatar);
    a.onclick = null;      // 「我的」页点头像不打开资料
    box.appendChild(a);
    if (S.user.avatar) {
      var reset = el('div', 'me-av-reset', '恢复默认头像');
      reset.onclick = function () {
        askConfirm('恢复默认头像', '恢复为默认的色块头像吗？', function () {
          api('DELETE', '/api/me/avatar', null, function (err, d) {
          if (err) { toast(err.message); return; }
          S.user = d.user;
            renderMe();
            refreshUserBar();
            toast('已恢复默认头像');
          });
        }, '恢复');
      };
      box.appendChild(reset);
    }
  }

  function doChangeAvatar() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/png,image/jpeg,image/gif,image/webp';
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) { toast('图片过大，请换一张（8MB 以内）'); return; }
      compressAvatar(f, function (dataUrl) {
        if (!dataUrl) { toast('图片读取失败'); return; }
        toast('头像上传中…');
        api('POST', '/api/me/avatar', { dataUrl: dataUrl }, function (err, d) {
          if (err) { toast(err.message, 4000); return; }
          S.user = d.user;
          renderMe();
          refreshUserBar();
          toast('头像已更新');
        });
      });
    };
    inp.click();
  }

  /** 用 canvas 把任意图片压成 256×256 JPEG（dataURL 一般 10-30KB） */
  function compressAvatar(file, cb) {
    var url = window.URL && window.URL.createObjectURL
      ? window.URL.createObjectURL(file) : null;
    if (!url) { cb(null); return; }
    var img = new Image();
    img.onload = function () {
      try {
        var size = 256;
        var cv = document.createElement('canvas');
        cv.width = size;
        cv.height = size;
        var g = cv.getContext('2d');
        // 居中裁方，避免头像被拉扁
        var side = Math.min(img.width, img.height);
        var sx = (img.width - side) / 2;
        var sy = (img.height - side) / 2;
        g.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        var dataUrl = cv.toDataURL('image/jpeg', 0.86);
        window.URL.revokeObjectURL(url);
        cb(dataUrl);
      } catch (e) {
        window.URL.revokeObjectURL(url);
        cb(null);
      }
    };
    img.onerror = function () {
      window.URL.revokeObjectURL(url);
      cb(null);
    };
    img.src = url;
  }

  function doChangeNickname() {
    if (!S.user) return;
    askInput('修改昵称', '2-20 位中英文 / 数字 / 下划线', S.user.nickname || '', function (v) {
      v = String(v).trim();
      if (!v) { toast('昵称不能为空'); return false; }
      api('POST', '/api/me/nickname', { nickname: v }, function (err, d) {
        if (err) { toast('修改失败：' + (err.message || err)); return; }
        S.user = d.user;
        renderMe();
        refreshUserBar();
        toast('昵称已更新');
      });
    }, '保存');
  }

  function doDeleteAccount() {
    if (!S.user) return;
    var expect = S.user.username;
    askInput('注销账号',
      '注销后你的账号、创建的群、发布的消息和文件将被永久删除，且不可恢复。<br>请输入账号名「' +
      esc(expect) + '」以确认注销：', '', function (v) {
        if (String(v).trim() !== expect) { toast('账号名不符，已取消注销'); return false; }
        api('POST', '/api/account/delete', { confirm: true }, function (err) {
          if (err) { toast('注销失败：' + (err.message || err)); return; }
          localStorage.removeItem('ll_token');
          S.user = null;
          toast('账号已注销');
          location.reload();
        });
      }, '确认注销');
  }

  /* ---------------- 视图：设置 ---------------- */

  function openSettings() {
    $('main').className = 'screen hide';
    $('chat').className = 'screen hide chat-screen';
    var s = $('settings');
    if (s) s.className = 'screen';
    renderSettings();
  }

  function closeSettings() {
    var s = $('settings');
    if (s) s.className = 'screen hide';
    $('main').className = 'screen';
    renderView();
  }

  bind('setBackBtn', closeSettings);
  function renderSettings() {
    var h = '';
    h += '<div class="card"><div class="card-h">外观 · 主题</div>' +
      '<div id="themeBox"></div>' +
      '<div class="set-note">「跟随系统」读取设备的深色 / 浅色设置，系统改动会实时同步；' +
      '「按时间」按本机时间在日间与夜间之间自动切换，可自行设定切换时刻；' +
      '「手动」由你自己指定浅色或深色。选择会保存在本机，浏览器与 App 共用同一份偏好。</div></div>';

    // 字体：一排小按钮，点选即应用；视觉上用低饱和描边，不做荧光高亮
    var fontBtns = '';
    for (var fi = 0; fi < FONTS.length; fi++) {
      var fo = FONTS[fi];
      fontBtns += '<span class="mini-btn font-opt' + (S.font === fo.id ? ' on' : '') +
        '" data-font="' + esc(fo.id) + '">' + esc(fo.name) + '</span>';
    }
    h += '<div class="card"><div class="card-h">外观 · 字体</div>' +
      '<div class="font-opts">' + fontBtns + '</div>' +
      '<div class="set-note">选择后全站立即生效并保存在本机。系统字体跟随设备；' +
      '若系统未安装所选字体，会自动退回同类字体显示。</div></div>';

    h += '<div class="card"><div class="card-h">外观 · 特效</div>' +
      '<div class="row"><div class="r-main"><div class="r-title">最高权限账号金色特效</div>' +
      '<div class="r-sub">关闭后彻底去掉全部金色装饰，名字与气泡恢复普通样式</div></div>' +
      '<button class="btn small ' + (goldFxOn() ? 'primary' : 'ghost') + '" id="btnGoldFx">' +
      (goldFxOn() ? '已开启' : '已关闭') + '</button></div>' +
      '<div class="set-note">只影响本机显示，不改变任何人发出的消息内容；看久了晃眼可以随时关掉。</div></div>';

    h += '<div class="card"><div class="card-h">存储</div>' +
      '<div class="row"><div class="r-main"><div class="r-title">清除缓存</div>' +
      '<div class="r-sub" id="cacheInfo">正在统计缓存占用…</div></div>' +
      '<button class="btn small primary" id="btnClearCache">清除</button></div>' +
      '<div class="row"><div class="r-main"><div class="r-title">清除聊天记录</div>' +
      '<div class="r-sub">仅清除本机缓存与显示，服务器端数据保留不变</div></div>' +
      '<button class="btn small danger" id="btnClearChat">清除</button></div>' +
      '<div class="set-note">「清除聊天记录」只作用于本机：清掉本机缓存的聊天数据，并让这些记录在本机不再显示。' +
      '服务器端数据不会被删除，其它设备 / 其它用户仍能看到这些记录。</div></div>';

    h += '<div class="card"><div class="card-h">下载</div>' +
      '<div class="row"><div class="r-main"><div class="r-title">下载保存位置</div>' +
      '<div class="r-sub set-path" id="saveDirInfo">读取中…</div></div>' +
      '<button class="btn small primary" id="btnPickDir">更改</button></div>' +
      '<div class="set-note">默认保存到系统「下载」文件夹。若所选目录因系统版本或权限限制无法写入，' +
      '会自动降级保存到应用私有目录，并在提示中说明实际保存位置。</div></div>';

    var isAdmin = S.user && (S.user.founder || S.user.master);
    h += '<div class="card"><div class="act" id="openFeedback">' +
      (isAdmin ? '📮 官方反馈中心 · 处理待审反馈与举报' : '📮 反馈与举报 · 提交问题 / 建议 / 举报') +
      '</div></div>';

    h += '<div class="card"><div class="card-h">关于</div>' +
      '<div id="verBox" class="ver-box"><div class="ver-loading">正在读取线上版本…</div></div>' +
      '<div class="set-note">轻聊 · 聊天与文件传输<br>' +
      '运行环境：' + (NATIVE ? 'Android 客户端' : '浏览器（网页版）') + '<br>' +
      '本机已隐藏的聊天记录：' + (S.hiddenRev > 0 ? ('截至 rev ' + S.hiddenRev) : '无') + '</div></div>';

    var sv = $('setView');
    if (sv) sv.innerHTML = h;
    // 主题面板用真实 DOM 构建（三种模式共用同一份渲染逻辑）
    themeSettingsPanel = null;
    var box = $('themeBox');
    if (box) {
      box.innerHTML = '';
      var panel = themeEl('div', 'theme-panel');
      themeRenderPanel(panel);
      box.appendChild(panel);
      themeSettingsPanel = panel;
    }
    var fontOpts = document.querySelectorAll('.font-opt[data-font]');
    for (var fo2 = 0; fo2 < fontOpts.length; fo2++) {
      fontOpts[fo2].onclick = function () {
        var id = this.getAttribute('data-font') || '';
        fontApply(id);
        toast('已切换字体：' + fontFind(id).name);
        renderSettings();
      };
    }
    bind('btnClearCache', doClearCache);
    bind('btnClearChat', doClearChatAsk);
    bind('btnPickDir', doPickSaveDir);
    bind('btnGoldFx', function () {
      try { localStorage.setItem(GOLDFX_KEY, goldFxOn() ? 'off' : 'on'); } catch (e) { }
      applyGoldFx();
      toast(goldFxOn() ? '金色特效已开启' : '金色特效已全部关闭');
      renderSettings();
    });
    bind('openFeedback', openFeedbackBox);
    refreshCacheInfo();
    refreshSaveDirInfo();
    loadVersionInfo();
  }

  /**
   * 从线上拉取版本信息并渲染到「关于」。
   *
   * 版本号不由 APK 决定，而是每次打开设置页都实时向服务端取：
   * 线上部署了新代码 → 这里立刻显示新版本与新构建号，
   * 不会出现「安装包版本看着很旧、实际跑的已是最新代码」。
   */
  function loadVersionInfo() {
    var box = $('verBox');
    if (!box) return;
    api('GET', '/api/version', null, function (err, data) {
      var b = $('verBox');
      if (!b) return;
      if (err || !data || !data.version) {
        b.innerHTML = '';
        b.appendChild(el('div', 'ver-err', '版本信息读取失败：' + (err ? err.message : '无数据')));
        return;
      }
      var v = data.version;
      b.innerHTML = '';

      var top = el('div', 'ver-top');
      top.appendChild(el('span', 'ver-name', 'v' + v.name));
      var badge = el('span', 'ver-badge', '当前线上版本');
      top.appendChild(badge);
      b.appendChild(top);

      var meta = el('div', 'ver-meta');
      meta.appendChild(el('div', 'ver-line', '构建号 #' + (data.build || '—')));
      meta.appendChild(el('div', 'ver-line', '版本代号 ' + (v.code || 0)));
      if (v.releasedAt) meta.appendChild(el('div', 'ver-line', '发布日期 ' + v.releasedAt));
      b.appendChild(meta);

      if (v.notes && v.notes.length) {
        var nh = el('div', 'ver-notes-h', '本次更新');
        b.appendChild(nh);
        var ul = el('ul', 'ver-notes');
        for (var i = 0; i < v.notes.length; i++) {
          ul.appendChild(el('li', null, v.notes[i]));
        }
        b.appendChild(ul);
      }

      b.appendChild(el('div', 'ver-tip',
        '版本信息实时来自线上服务，划掉后台重新打开即可看到最新版本，无需更换安装包。'));
    });
  }

  /* ---- 清除缓存：只释放本机缓存占用的空间，不动聊天数据 ---- */

  function refreshCacheInfo() {
    var el = $('cacheInfo');
    if (!el) return;
    if (NATIVE) {
      nativeCall('getCacheInfo', {}, function (err, d) {
        if (err) { el.textContent = '无法读取缓存信息：' + err.message; return; }
        el.textContent = '当前占用约 ' + fmtSize(d.cacheSize || 0);
      });
    } else {
      el.textContent = '当前占用约 ' + fmtSize(browserCacheSize());
    }
  }

  function doClearCache() {
    openModal('清除缓存',
      '<div>将释放本机缓存占用的存储空间（网页缓存、图片与文件副本等）。</div>' +
      '<div style="margin-top:6px;color:var(--fg-2);font-size:13px">不会删除聊天记录，也不会影响服务器端数据。</div>',
      function () {
        if (NATIVE) {
          nativeCall('clearCache', {}, function (err, d) {
            if (err) { toast('清除失败：' + err.message); return; }
            toast('已清除缓存，释放约 ' + fmtSize(d.freed || 0));
            refreshCacheInfo();
          });
        } else {
          clearBrowserCaches(function (freed) {
            toast('已清除缓存，释放约 ' + fmtSize(freed));
            refreshCacheInfo();
          });
        }
      }, '清除');
  }

  /** 浏览器降级：统计并清理可清掉的本地缓存 */
  function browserCacheSize() {
    var bytes = 0, i, k, v;
    for (i = 0; i < localStorage.length; i++) {
      k = localStorage.key(i);
      if (!k) continue;
      v = localStorage.getItem(k) || '';
      bytes += (k.length + v.length) * 2;
    }
    return bytes;
  }

  function clearBrowserCaches(cb) {
    var freed = browserCacheSize();
    var jobs = [];
    if (window.caches && typeof window.caches.keys === 'function') {
      try {
        jobs.push(window.caches.keys().then(function (keys) {
          return Promise.all(keys.map(function (k) { return window.caches.delete(k); }));
        }));
      } catch (e) { /* 老内核没有 Cache API，忽略 */ }
    }
    // 清掉上传断点等一次性本地键
    var kill = [], i;
    for (i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf('ll_upload_') === 0) kill.push(k);
    }
    for (i = 0; i < kill.length; i++) localStorage.removeItem(kill[i]);
    Promise.all(jobs).then(function () { cb(freed); }, function () { cb(freed); });
  }

  /* ---- 清除聊天记录：二次确认，仅影响本地数据 ---- */

  function doClearChatAsk() {
    openModal('清除本机聊天记录',
      '<div class="set-warn">⚠️ 此操作仅影响本地数据</div>' +
      '<div style="margin-top:8px">将清除<b>本机</b>缓存的聊天记录，并让这些记录<b>在本机不再显示</b>。</div>' +
      '<div style="margin-top:6px;color:var(--fg-2);font-size:13px">' +
      '服务器端数据<b>不会被删除</b> —— 其它设备、其它用户仍能看到这些记录。</div>',
      function () {
        doClearChatConfirm();
        return false;   // 保持弹层打开，进入第二层确认
      }, '继续');
  }

  function doClearChatConfirm() {
    openModal('再次确认',
      '<div>确认清除<b>本机</b>已缓存的全部聊天记录？</div>' +
      '<div style="margin-top:6px;color:var(--warn);font-size:13px">仅影响本地数据；服务器端记录保留不变。</div>',
      function () { performClearChat(); }, '确认清除');
  }

  /** 汇总本机能触及的房间，取全局 rev 水位 */
  function collectRoomIds() {
    var ids = [], i, r, u;
    if (S.publicRoomId) ids.push(S.publicRoomId);
    if (S.room && S.room.id) ids.push(S.room.id);
    for (i = 0; i < S.rooms.length; i++) {
      r = S.rooms[i];
      if (r.kind === 'public') continue;
      if (r.joined || r.ownerId === (S.user && S.user.id)) ids.push(r.id);
    }
    for (u in S.dmCache) {
      if (S.dmCache.hasOwnProperty(u) && S.dmCache[u]) ids.push(S.dmCache[u]);
    }
    var out = [], seen = {};
    for (i = 0; i < ids.length; i++) {
      if (ids[i] && !seen[ids[i]]) { seen[ids[i]] = 1; out.push(ids[i]); }
    }
    return out;
  }

  function performClearChat() {
    var known = 0, k;
    for (k in S.msgs) if (S.msgs.hasOwnProperty(k)) known++;
    var ids = collectRoomIds();
    var maxRev = Math.max(readNum(SEEN_REV_KEY), S.lastRev || 0);
    if (!ids.length) { finishClearChat(maxRev, known); return; }
    var pending = ids.length;
    for (var i = 0; i < ids.length; i++) {
      (function (rid) {
        api('GET', '/api/rooms/' + rid + '/messages?since=0&limit=1', null, function (err, data) {
          if (!err && data && data.lastSeq > maxRev) maxRev = data.lastSeq;
          pending--;
          if (pending <= 0) finishClearChat(maxRev, known);
        });
      })(ids[i]);
    }
  }

  function finishClearChat(maxRev, known) {
    // 1) 本机隐藏水位：rev <= 水位的消息在本机不再显示（服务端数据不动）
    S.hiddenRev = maxRev > 0 ? maxRev : readHiddenRev();
    writeNum(HIDDEN_REV_KEY, S.hiddenRev);
    // 2) 清掉本机其它聊天相关的本地数据（保留登录态、隐藏水位、设置项）
    clearLocalChatKeys();
    // 3) 清内存态
    S.msgs = {}; S.dmCache = {}; S.lastRev = 0;
    S.incoming = []; S.outgoing = [];
    $('msgs').innerHTML = '';
    // 4) 释放本机缓存里的接口响应副本
    var done = function () {
      toast('已清除本机聊天记录（服务器端数据保留不变）');
      renderSettings();
    };
    if (NATIVE) {
      nativeCall('clearCache', {}, function () { done(); });
    } else {
      clearBrowserCaches(function () { done(); });
    }
  }

  function clearLocalChatKeys() {
    var keep = {}, i, k;
    for (i = 0; i < KEEP_LOCAL_KEYS.length; i++) keep[KEEP_LOCAL_KEYS[i]] = 1;
    var kill = [];
    for (i = 0; i < localStorage.length; i++) {
      k = localStorage.key(i);
      if (!k || keep[k]) continue;
      if (k.indexOf('ll_') === 0) kill.push(k);
    }
    for (i = 0; i < kill.length; i++) localStorage.removeItem(kill[i]);
  }

  /* ---- 自定义下载路径 ---- */

  function refreshSaveDirInfo() {
    var el = $('saveDirInfo');
    if (!el) return;
    if (NATIVE) {
      nativeCall('getCacheInfo', {}, function (err, d) {
        if (err) { el.textContent = '读取失败：' + err.message; return; }
        el.textContent = d.saveLabel || '系统下载文件夹 (Downloads)';
      });
    } else {
      el.textContent = '浏览器默认下载位置（系统「下载」文件夹）';
    }
  }

  function doPickSaveDir() {
    if (!NATIVE) {
      openModal('自定义下载路径',
        '<div>网页版的下载位置由浏览器 / 系统决定，通常是「下载」文件夹，无法在页面里改。</div>' +
        '<div style="margin-top:6px;color:var(--fg-2);font-size:13px">' +
        '在 Android 客户端里打开「设置 → 下载保存位置」即可自选目录（如手机任意文件夹）。</div>',
        function () { }, '知道了');
      return;
    }
    nativeCall('pickSaveDir', {}, function (err, d) {
      if (err) { toast('未更改下载位置'); return; }
      toast('下载位置已改为：' + (d.label || '自定义目录'));
      refreshSaveDirInfo();
    });
  }

  /* ---- 文件下载 ---- */

  /** 相对地址转绝对地址（原生侧要用 HttpURLConnection 打开，必须是完整 URL） */
  function absUrl(u) {
    if (!u) return '';
    if (u.indexOf('http://') === 0 || u.indexOf('https://') === 0) return u;
    var m = String(window.location.href).match(/^(https?:\/\/[^\/?#]+)/);
    return m ? (m[1] + u) : u;
  }

  function downloadFile(f) {
    if (NATIVE) {
      nativeCall('saveFile', { url: absUrl(f.url), name: f.name, mime: f.mime }, function (err, d) {
        if (err) { toast('下载失败：' + err.message, 3500); return; }
        if (d.degraded && d.message) toast(d.message, 4000);
        else toast('已保存到 ' + (d.path || '下载目录'), 3000);
      });
      return;
    }
    // 浏览器：走 attachment 响应，由浏览器存进默认下载目录
    var a = document.createElement('a');
    a.href = f.dlUrl || f.url;
    a.download = f.name || '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /* ---------------- 视图事件绑定 ---------------- */

  function bindView() {
    var v = $('view');
    var rows = v.querySelectorAll('[data-open]');
    for (var i = 0; i < rows.length; i++) {
      rows[i].onclick = function () { openRoom(this.getAttribute('data-open')); };
    }
    var joins = v.querySelectorAll('[data-join]');
    for (var j = 0; j < joins.length; j++) {
      joins[j].onclick = function (e) {
        e.stopPropagation();
        joinRoom(this.getAttribute('data-join'));
      };
    }
    var acts = v.querySelectorAll('[data-go]');
    for (var a = 0; a < acts.length; a++) {
      acts[a].onclick = function () {
        var to = this.getAttribute('data-go');
        if (to === 'settings') { openSettings(); return; }
        switchView(to);
      };
    }
    var dms = v.querySelectorAll('[data-dm]');
    for (var d = 0; d < dms.length; d++) {
      dms[d].onclick = function () { openDM(this.getAttribute('data-dm')); };
    }
    var acc = v.querySelectorAll('[data-accept]');
    for (var e2 = 0; e2 < acc.length; e2++) {
      acc[e2].onclick = function () {
        var id = this.getAttribute('data-accept');
        api('POST', '/api/friends/' + id + '/accept', {}, function (err) {
          if (err) { toast(err.message); return; }
          toast('已添加为好友');
          loadFriends();
        });
      };
    }
    var rej = v.querySelectorAll('[data-reject]');
    for (var e3 = 0; e3 < rej.length; e3++) {
      rej[e3].onclick = function () {
        rejectFriend(this.getAttribute('data-reject'));
      };
    }
    if ($('createRoom')) $('createRoom').onclick = createRoom;
    if ($('searchUser')) $('searchUser').onclick = searchUser;
  }

  /* ---------------- 房间操作 ---------------- */

  function createRoom() {
    openModal('创建房间',
      '<input id="rn" type="text" placeholder="房间名称（最多40字）" maxlength="40">' +
      '<input id="rp" type="text" placeholder="房间密码（留空=免密，至少4位）">' +
      '<div style="font-size:12px;color:var(--fg-3);margin-top:8px">免密房间可直接进入，加入后才能发言；<br>有密码房间需输入正确密码才能进入并加入。</div>',
      function () {
        var name = $('rn').value.trim();
        var pwd = $('rp').value;
        if (!name) { toast('请输入房间名称'); return false; }
        api('POST', '/api/rooms', { name: name, password: pwd }, function (err, data) {
          if (err) { toast(err.message); return; }
          toast('房间已创建');
          loadRooms(function () { openRoom(data.room.id); });
        });
        return true;
      }, '创建');
  }

  function joinRoom(id) {
    api('GET', '/api/rooms', null, function (err, data) {
      if (err) { toast(err.message); return; }
      var target = null;
      for (var i = 0; i < data.rooms.length; i++) {
        if (data.rooms[i].id === id) { target = data.rooms[i]; break; }
      }
      if (!target) {
        // 不在列表里，需要凭密码直接进入
        doJoin(id, '');
        return;
      }
      if (target.hasPassword) {
        openModal('输入房间密码',
          '<input id="jp" type="password" placeholder="房间密码">',
          function () {
            var p = $('jp').value;
            doJoin(id, p);
            return true;
          }, '进入');
      } else {
        doJoin(id, '');
      }
    });
  }

  function doJoin(id, pwd) {
    api('POST', '/api/rooms/' + id + '/join', { password: pwd }, function (err) {
      if (err) { toast(err.message); return; }
      toast('已加入房间');
      // 若当前就在该房间，直接刷新状态；否则进入房间
      if (S.room && S.room.id === id) {
        api('GET', '/api/rooms/' + id + '/messages?since=0&limit=60', null, function (e2, data) {
          if (e2) { toast(e2.message); return; }
          S.room = data;
          S.room.id = id;
          S.lastRev = data.lastSeq;
          S.msgs = {};
          S.picked = {};
          S.selIds = {};
          $('msgs').innerHTML = '';
          for (var i = 0; i < data.messages.length; i++) appendMsg(data.messages[i], true);
          scrollBottom();
          updateComposerState();
          updateJoinBtn();
        });
        loadRooms();
      } else {
        loadRooms(function () { openRoom(id); });
      }
    });
  }

  /** 聊天页标题：公共聊天室在名字旁显示「N 人同时在线」（标准版专属） */
  function updateChatTitle() {
    if (!S.room) return;
    var name = (S.roomTitle || roomNameById(S.room.id)) + (S.room.dissolved ? '（已解散）' : '');
    if (S.room.id === S.publicRoomId || S.room.kind === 'public') {
      name += '（' + num(S.onlineCount) + ' 人同时在线）';
    }
    $('chatTitle').textContent = name;
  }

  /** 拉取公共聊天室同时在线人数（标准版每 30 秒） */
  function refreshOnlineCount() {
    api('GET', '/api/online-count', null, function (err, d) {
      if (err || !d) return;
      S.onlineCount = num(d.online);
      if (S.room && $('chat').className.indexOf('hide') < 0) updateChatTitle();
      // 公共入口页卡片也带上在线数
      if (S.view === 'public' && S.rooms.length) renderPublic();
    });
  }

  function openRoom(id, titleOverride) {
    api('GET', '/api/rooms/' + id + '/messages?since=0&limit=60', null, function (err, data) {
      if (err) {
        if (err.message.indexOf('密码') >= 0) { joinRoom(id); return; }
        toast(err.message);
        return;
      }
      S.room = data;
      S.room.id = id;
      // 私聊不是房间、不在 S.rooms 里，标题用发起私聊时传入的对方昵称
      S.roomTitle = titleOverride || '';
      S.lastRev = data.lastSeq;
      S.msgs = {};
      S.picked = {};
      S.selIds = {};
      $('msgs').innerHTML = '';
      updateChatTitle();  // 标题含公共聊天室同时在线人数
      $('main').className = 'screen hide';
      $('chat').className = 'screen chat-screen';
      for (var i = 0; i < data.messages.length; i++) appendMsg(data.messages[i], true);
      scrollBottom();
      updateComposerState();
      updateJoinBtn();
      startPolling();
    });
  }

  /** 未加入房间时，顶部显示「加入房间」按钮 */
  function updateJoinBtn() {
    var btn = $('joinBtn');
    if (!btn) return;
    if (S.room && !S.room.joined && S.room.kind !== 'public') {
      btn.className = 'icon-btn';
      btn.style.display = '';
    } else {
      btn.style.display = 'none';
    }
  }

  function roomNameById(id) {
    for (var i = 0; i < S.rooms.length; i++) if (S.rooms[i].id === id) return S.rooms[i].name;
    return '房间';
  }

  function openDM(userId) {
    api('GET', '/api/dm/' + userId, null, function (err, data) {
      if (err) { toast(err.message); return; }
      S.dmCache[userId] = data.room.id;
      openRoom(data.room.id, data.room.name);
    });
  }

  $('backBtn').onclick = function () {
    stopPolling();
    // 离开房间前退出多选，避免下次进房还残留多选态
    if (S.selMode) setSelMode(false);
    $('chat').className = 'screen hide';
    $('main').className = 'screen';
    loadRooms();
  };

  $('joinBtn').onclick = function () {
    if (!S.room) return;
    joinRoom(S.room.id);
  };

  /* ---------------- 消息渲染 ---------------- */

  /** 收起其它消息已展开的操作区（同一时间只展开一条） */
  function closeOtherTools(self) {
    for (var id in S.picked) {
      if (!S.picked.hasOwnProperty(id)) continue;
      var w = S.picked[id];
      if (!w || w === self) continue;
      var bub = w.querySelector ? w.querySelector('.bub') : null;
      if (bub && bub.className.indexOf('open') >= 0) bub.className = 'bub';
    }
  }

  function appendMsg(m, replaceAll) {
    var rev = m.rev || m.seq || 0;
    bumpSeenRev(rev);
    // 本机已隐藏的聊天记录（清除聊天记录后）：不再渲染，但服务端数据完全不动
    if (rev && rev <= S.hiddenRev) return null;
    var old = S.msgs[m.id];
    if (old) { S.msgs[m.id].parentNode.removeChild(S.msgs[m.id]); delete S.msgs[m.id]; }
    delete S.picked[m.id];

    // 服务端已彻底删除（只含空壳、不含任何正文）：本机副本在上一步已移除，直接跳过渲染
    if (m.purged) return null;

    /* 系统通知（群主转让 / 继位 / 解散）：只在对应房间内出现。
       居中提示条，没有头像、发送者、操作区，也不参与多选。 */
    if (m.kind === 'system') {
      var sys = document.createElement('div');
      sys.className = 'sys-notice';
      sys.setAttribute('data-system', '1');
      sys.textContent = m.content;
      $('msgs').appendChild(sys);
      S.msgs[m.id] = sys;
      S.picked[m.id] = sys;
      return sys;
    }

    var wrap = document.createElement('div');
    // founder：永久权限账号的消息，标准版加金色烫金名字框 + 精致头像框（低配版不含该样式）
    wrap.className = 'msg' + (m.mine ? ' mine' : '') + (m.senderFounder ? ' founder' : '');

    // 多选模式的勾选框（仅多选时显示）
    var pick = document.createElement('span');
    pick.className = 'pick';
    pick.onclick = function (e) {
      e.stopPropagation();
      togglePick(m.id);
    };
    wrap.appendChild(pick);

    var av = document.createElement('div');
    av.className = 'av';
    av.style.background = colorOf(m.senderId);
    if (m.senderAvatar) {
      av.style.backgroundImage = 'url("' + m.senderAvatar + '")';
      av.style.backgroundSize = 'cover';
      av.style.backgroundPosition = 'center';
    } else {
      av.textContent = (m.senderName || '?').charAt(0);
      if (m.senderFounder) {
        // 刘子墨：头像本体也走金色烫金渐变（有自定义头像则保留图片）
        av.className = 'av gold-fill';
        av.style.backgroundImage = 'linear-gradient(135deg, #f2d888, #d4af37, #fff0c0, #c19a2e)';
        av.style.backgroundSize = '260% 100%';
      }
    }
    av.title = '查看资料';
    // 点头像 → 打开对方资料页（可发起好友申请）
    av.onclick = function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      if (S.selMode) return;
      openProfile(m.senderId);
    };
    wrap.appendChild(av);

    var bub = document.createElement('div');
    bub.className = 'bub';

    var who = document.createElement('div');
    who.className = 'who' + (m.senderFounder ? ' founder-who' : '');
    who.textContent = m.senderName + (m.mine ? ' (我)' : '');
    bub.appendChild(who);

    if (m.recalled) {
      var rec = document.createElement('div');
      rec.className = 'recalled';
      rec.textContent = '该消息已被撤回';
      bub.appendChild(rec);
    } else if (m.kind === 'file' && m.file) {
      bub.appendChild(fileNode(m.file));
    } else {
      var txt = document.createElement('div');
      txt.className = 'txt';
      txt.textContent = m.content;
      bub.appendChild(txt);
    }

    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = fmtTime(m.createdAt);
    bub.appendChild(meta);

    /* 操作入口改为「点消息 → 底部浮出操作面板」，不再在气泡里内联一排小按钮，
       也不再占用顶栏常驻「多选」入口 —— 界面更接近微信 / QQ 的简洁观感。 */
    bub.onclick = function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      if (S.selMode) { togglePick(m.id); return; }
      openActSheet(m);
    };

    wrap.appendChild(bub);
    $('msgs').appendChild(wrap);
    S.msgs[m.id] = wrap;
    S.picked[m.id] = wrap;
    // 多选模式：恢复已选中消息的勾选态
    if (S.selMode && S.selIds[m.id]) wrap.className += ' picked';
    // 长按气泡 → 进入多选并选中该条
    bindLongPress(bub, m.id);
    return wrap;
  }

  /* ---------------- 消息操作面板（底部弹出） ---------------- */

  /** 从界面上移除一条消息节点（同时清掉多选引用） */
  function removeMsgNode(id) {
    var n = S.msgs[id];
    if (n && n.parentNode) n.parentNode.removeChild(n);
    delete S.msgs[id];
    delete S.picked[id];
    delete S.selIds[id];
  }

  /** 直接删除（不可恢复）：沿用原来的二次确认弹窗 */
  function confirmPurge(m) {
    var isFile = m.kind === 'file';
    openModal('直接删除这条消息',
      '<div class="set-warn">⚠️ 此操作不可恢复</div>' +
      '<div style="margin-top:8px">将从服务器端<b>彻底删除</b>这条消息，' +
      '<b>所有设备、所有用户</b>的界面上都会立即消失。</div>' +
      (isFile
        ? '<div style="margin-top:6px;color:var(--fg-2);font-size:13px">' +
          '消息携带的文件会一并删除，云端占用的存储空间同时释放。</div>'
        : '') +
      '<div style="margin-top:6px;color:var(--fg-2);font-size:13px">' +
      '若只想让<b>自己</b>看不到，请改用「删除」。</div>',
      function () {
        api('POST', '/api/messages/' + m.id + '/purge', {}, function (err) {
          if (err) { toast(err.message, 3500); return; }
          toast('已彻底删除，所有设备同步清除', 3500);
          removeMsgNode(m.id);
          pullNow(true);
        });
      }, '彻底删除');
  }

  /**
   * 点任意消息/文件 → 底部浮出操作面板。
   *
   * 为什么改成弹层：原来每个气泡里塞一排「撤回 / 删除 / 直接删除」小字，
   * 公共大厅刷屏时整屏都是按钮，很吵；顶栏还常驻一个「多选」入口，容易误触。
   * 现在操作收进底部面板，列表只剩内容本身，多选从面板里的「多选」进入。
   */
  function openActSheet(m) {
    var sheet = $('actSheet');
    var box = $('actBox');
    if (!sheet || !box) return;
    box.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'act-head';
    head.textContent = (m.senderName || '') + ' · ' + fmtTime(m.createdAt);
    box.appendChild(head);

    var list = document.createElement('div');
    list.className = 'act-list';

    function add(label, cls, fn) {
      var b = document.createElement('button');
      b.className = 'act-item' + (cls ? ' ' + cls : '');
      b.textContent = label;
      b.setAttribute('data-act', label);
      b.onclick = function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        fn();
      };
      list.appendChild(b);
      return b;
    }

    // 多选：从这一条开始进入多选并勾上
    add('多选', '', function () {
      closeActSheet();
      setSelMode(true);
      togglePick(m.id);
    });

    if (m.mine && !m.recalled) {
      add(m.canRecall ? '撤回' : '撤回（已超窗）', '', function () {
        closeActSheet();
        if (!m.canRecall) {
          toast('已超过 2 分钟撤回窗口。如需彻底清除，请用「直接删除」', 3500);
          return;
        }
        api('POST', '/api/messages/' + m.id + '/recall', {}, function (err) {
          if (err) { toast(err.message, 3500); return; }
          toast('已撤回');
          pullNow(true);
        });
      });
    }

    add('删除（仅自己不可见）', '', function () {
      closeActSheet();
      api('POST', '/api/messages/' + m.id + '/delete', {}, function (err) {
        if (err) { toast(err.message); return; }
        toast('已删除（仅自己可见）');
        removeMsgNode(m.id);
      });
    });

    if (m.canPurge) {
      add('直接删除（所有人消失）', 'danger', function () {
        closeActSheet();
        confirmPurge(m);
      });
    }

    // 举报（任何人均可举报任意消息）
    add('举报', 'danger', function () {
      closeActSheet();
      openReportForm(m);
    });

    box.appendChild(list);

    var cancel = document.createElement('button');
    cancel.className = 'act-cancel';
    cancel.textContent = '取消';
    cancel.onclick = closeActSheet;
    box.appendChild(cancel);

    sheet.className = 'actsheet';
  }

  function closeActSheet() {
    var sheet = $('actSheet');
    if (sheet) sheet.className = 'actsheet hide';
  }

  /** 举报消息：打开反馈弹层，预填被举报消息引用 */
  function openReportForm(m) {
    var id = 'reportInput_' + (++askSeq);
    var body = document.createElement('div');
    var hint = document.createElement('div');
    hint.className = 'ask-text';
    hint.textContent = '举报「' + (m.senderName || '某用户') + '」的消息，请说明理由：';
    body.appendChild(hint);
    var ta = document.createElement('textarea');
    ta.className = 'ask-field';
    ta.id = id;
    ta.rows = 4;
    ta.placeholder = '例如：发布违规内容、骚扰、广告等';
    ta.style.width = '100%';
    ta.style.boxSizing = 'border-box';
    body.appendChild(ta);
    openModal('举报消息', body, function () {
      var reason = String(ta.value || '').trim();
      if (!reason) { toast('请填写举报理由'); return false; }
      api('POST', '/api/feedback', {
        type: 'complaint',
        title: '举报消息',
        content: reason,
        refId: m.id,
        refKind: 'message'
      }, function (err) {
        if (err) { toast(err.message || '举报失败', 3000); return; }
        toast('举报已提交，官方将在 12 小时内处理');
      });
    }, '提交举报');
    setTimeout(function () { if (ta.focus) ta.focus(); }, 30);
  }

  /* ---------------- 多选模式 ---------------- */

  /**
   * 多选模式（微信 / QQ 式）：
   *   - 顶栏「多选」按钮进入，或长按任意消息进入
   *   - 每条消息左侧出现勾选框，点击切换选中
   *   - 底部操作栏取代输入框：删除（仅本机隐藏）/ 直接删除（全端清除）/ 取消
   *   - 多选期间不提供「撤回」——撤回只能单条进行；退出多选后单条撤回照常可用
   */
  function setSelMode(on) {
    S.selMode = !!on;
    if (!on) S.selIds = {};

    var box = $('msgs');
    var bar = $('selBar');
    var comp = $('composer');
    var mbtn = $('multiBtn');
    var cc = $('memberBtn');

    if (box) {
      if (on) box.className = 'msgs selmode';
      else box.className = 'msgs';
    }
    if (bar) bar.className = on ? 'selbar' : 'selbar hide';
    if (comp) comp.className = on ? 'composer hide' : 'composer';
    if (mbtn) mbtn.textContent = on ? '取消' : '多选';
    if (cc) cc.style.display = on ? 'none' : '';

    // 已有消息的勾选态同步
    for (var id in S.selIds) {
      if (!S.selIds.hasOwnProperty(id)) continue;
      var w = S.msgs[id];
      if (w) w.className = w.className.replace(/\s*picked/g, '') + ' picked';
    }
    if (!on) {
      for (var id2 in S.picked) {
        if (!S.picked.hasOwnProperty(id2)) continue;
        var w2 = S.picked[id2];
        if (w2) w2.className = w2.className.replace(/\s*picked/g, '');
      }
    }
    updateSelBar();
  }

  function togglePick(id) {
    if (S.selIds[id]) delete S.selIds[id];
    else S.selIds[id] = true;
    var w = S.msgs[id];
    if (w) {
      if (S.selIds[id]) {
        if (w.className.indexOf('picked') < 0) w.className += ' picked';
      } else {
        w.className = w.className.replace(/\s*picked/g, '');
      }
    }
    updateSelBar();
  }

  function selIds() {
    var out = [];
    for (var id in S.selIds) {
      if (S.selIds.hasOwnProperty(id)) out.push(id);
    }
    return out;
  }

  function updateSelBar() {
    var n = selIds().length;
    var c = $('selCount');
    if (c) c.textContent = '已选 ' + n + ' 条';
    var d = $('selDelete');
    var p = $('selPurge');
    if (d) d.disabled = n === 0;
    if (p) p.disabled = n === 0;
  }

  /** 全选 / 取消全选（当前已加载的所有消息） */
  function toggleSelAll() {
    var ids = selIds();
    if (ids.length > 0) {
      for (var i = 0; i < ids.length; i++) togglePick(ids[i]);
      return;
    }
    for (var id in S.msgs) {
      if (!S.msgs.hasOwnProperty(id)) continue;
      if (!S.selIds[id]) togglePick(id);
    }
  }

  /** 批量「删除」：仅对本机隐藏，服务器端数据保留 */
  function batchDelete() {
    var ids = selIds();
    if (!ids.length) { toast('请先选择消息'); return; }
    api('POST', '/api/messages/batch-delete', { ids: ids }, function (err, data) {
      if (err) { toast(err.message, 3500); return; }
      var n = (data && data.hidden && data.hidden.length) || 0;
      var bad = (data && data.failed && data.failed.length) || 0;
      for (var i = 0; i < ids.length; i++) {
        var el = S.msgs[ids[i]];
        if (el && el.parentNode) { el.parentNode.removeChild(el); delete S.msgs[ids[i]]; }
        delete S.picked[ids[i]];
      }
      setSelMode(false);
      toast('已删除 ' + n + ' 条（仅自己可见）' + (bad ? '，' + bad + ' 条失败' : ''), 3000);
      pullNow(true);
    });
  }

  /** 批量「直接删除」：服务器端彻底清除，所有设备同步消失 */
  function batchPurge() {
    var ids = selIds();
    if (!ids.length) { toast('请先选择消息'); return; }
    openModal('直接删除选中的消息',
      '<div class="set-warn">⚠️ 此操作不可恢复</div>' +
      '<div style="margin-top:8px">将从服务器端<b>彻底删除</b>选中的 <b>' + ids.length +
      '</b> 条消息，<b>所有设备、所有用户</b>的界面上都会立即消失。</div>' +
      '<div style="margin-top:6px;color:var(--fg-2);font-size:13px">' +
      '消息携带的文件会一并删除，云端占用的存储空间同时释放。</div>' +
      '<div style="margin-top:6px;color:var(--fg-2);font-size:13px">' +
      '只有<b>自己发送</b>的消息能被彻底删除；他人的消息会被跳过。' +
      '若只想让<b>自己</b>看不到，请改用「删除」。</div>',
      function () {
        api('POST', '/api/messages/batch-purge', { ids: ids }, function (err, data) {
          if (err) { toast(err.message, 3500); return; }
          var n = (data && data.purged && data.purged.length) || 0;
          var bad = (data && data.failed && data.failed.length) || 0;
          var msg = '已彻底删除 ' + n + ' 条，所有设备同步清除';
          if (bad) msg += '；' + bad + ' 条被跳过（仅能删除自己发送的消息）';
          toast(msg, 4000);
          for (var i = 0; i < ids.length; i++) {
            var el = S.msgs[ids[i]];
            if (el && el.parentNode) { el.parentNode.removeChild(el); delete S.msgs[ids[i]]; }
            delete S.picked[ids[i]];
          }
          setSelMode(false);
          pullNow(true);
        });
      }, '彻底删除');
  }

  /* 长按消息进入多选（微信 / QQ 式） */
  var longPressTimer = null;
  var longPressFired = false;
  function bindLongPress(el, msgId) {
    function start(e) {
      longPressFired = false;
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = setTimeout(function () {
        longPressFired = true;
        longPressTimer = null;
        if (!S.selMode) setSelMode(true);
        if (!S.selIds[msgId]) togglePick(msgId);
      }, 480);
    }
    function cancel() {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    }
    el.addEventListener('touchstart', start, false);
    el.addEventListener('touchend', cancel, false);
    el.addEventListener('touchmove', cancel, false);
    el.addEventListener('mousedown', start, false);
    el.addEventListener('mouseup', cancel, false);
    // 长按后紧跟的 click 会误触发「展开操作区」，这里挡掉
    el.addEventListener('click', function (e) {
      if (longPressFired) { longPressFired = false; e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  function fileNode(f) {
    var box = document.createElement('div');
    if (f.isImage) {
      var iw = document.createElement('div');
      iw.className = 'imgwrap';
      var im = document.createElement('img');
      im.src = f.url;
      im.alt = f.name;
      im.loading = 'lazy';
      im.onerror = function () { iw.innerHTML = ''; iw.appendChild(plainFile(f)); };
      iw.appendChild(im);
      box.appendChild(iw);
      var cap = document.createElement('div');
      cap.className = 'filecard';
      cap.appendChild(plainFile(f));
      box.appendChild(cap);
      return box;
    }
    if (f.isVideo) {
      var v = document.createElement('video');
      v.src = f.url;
      v.controls = true;
      v.preload = 'none';
      v.style.maxWidth = '100%';
      v.style.borderRadius = '6px';
      v.style.display = 'block';
      box.appendChild(v);
      var vc = document.createElement('div');
      vc.className = 'filecard';
      vc.appendChild(plainFile(f));
      box.appendChild(vc);
      return box;
    }
    box.className = 'filecard';
    box.appendChild(plainFile(f));
    return box;
  }

  function plainFile(f) {
    var fc = document.createElement('div');
    fc.className = 'filecard';
    var ic = document.createElement('span');
    ic.className = 'fi';
    ic.textContent = '📄';
    fc.appendChild(ic);
    var info = document.createElement('div');
    var a = document.createElement('a');
    a.href = f.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'fn';
    a.textContent = f.name;
    info.appendChild(a);
    var s = document.createElement('div');
    s.className = 'fs';
    s.textContent = fmtSize(f.size);
    info.appendChild(s);
    fc.appendChild(info);
    if (f.state === 'ready') {
      var dl = document.createElement('button');
      dl.className = 'btn small primary';
      dl.textContent = '下载';
      dl.onclick = function (e) {
        if (e && e.preventDefault) e.preventDefault();
        if (e && e.stopPropagation) e.stopPropagation();
        downloadFile(f);
      };
      fc.appendChild(dl);
    }
    return fc;
  }

  function scrollBottom() {
    setTimeout(function () { $('msgs').scrollTop = $('msgs').scrollHeight; }, 30);
  }

  /* ---------------- 轮询同步 ---------------- */

  function startPolling() {
    stopPolling();
    S.timer = setInterval(pullNow, 2500);
    pullNow();
  }
  function stopPolling() {
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
    S.pollBusy = false;
  }

  /**
   * Android 容器在退到后台 / 回到前台时调用。
   * 后台停掉轮询：既省电省 CPU，也让系统能顺利回收本进程
   * （数据都在服务端，被杀掉回来重拉即可，不会丢）。
   */
  window.__qlSetActive = function (on) {
    if (!on) { stopPolling(); return; }
    if (S.room) startPolling();
  };

  function pullNow(force) {
    if (!S.room || S.pollBusy) return;
    S.pollBusy = true;
    var since = force ? 0 : S.lastRev;
    api('GET', '/api/rooms/' + S.room.id + '/messages?since=' + since + '&limit=80', null, function (err, data) {
      S.pollBusy = false;
      if (err) return;
      var changed = false;
    for (var i = 0; i < data.messages.length; i++) {
      var m = data.messages[i];
      if (S.msgs[m.id] && m.recalled) {
        if (appendMsg(m)) changed = true;
        continue;
      }
      if (S.msgs[m.id]) continue;
      if (appendMsg(m)) changed = true;
    }
      // 服务端告知：这些消息已被「直接删除」彻底清除 → 本机副本一并移除
      if (data.purgedIds && data.purgedIds.length) {
        for (var j = 0; j < data.purgedIds.length; j++) {
          var pid = data.purgedIds[j];
          if (S.msgs[pid]) {
            S.msgs[pid].parentNode.removeChild(S.msgs[pid]);
            delete S.msgs[pid];
            changed = true;
          }
        }
      }
      S.lastRev = Math.max(S.lastRev, data.lastSeq);
      if (S.room) {
        S.room.canPost = data.canPost;
        S.room.muted = data.muted;
        S.room.joined = data.joined;
        S.room.role = data.role;
        S.room.dissolved = !!data.dissolved;
      }
      if (changed) scrollBottom();
      updateComposerState();
      updateJoinBtn();
    });
  }

  function updateComposerState() {
    var inp = $('msgInput');
    if (!S.room) return;
    var blocked = false;
    if (S.room.dissolved) {
      inp.disabled = true;
      inp.placeholder = '该群已解散，仅可查看历史消息';
      blocked = true;
    } else if (S.room.muted) {
      inp.disabled = true;
      inp.placeholder = '你已被禁言';
      blocked = true;
    } else if (!S.room.joined && S.room.kind !== 'public') {
      inp.disabled = true;
      inp.placeholder = '加入房间后才能发送消息';
      blocked = true;
    } else {
      inp.disabled = false;
      inp.placeholder = '说点什么…';
    }
    var send = $('sendBtn');
    var file = $('fileBtn');
    if (send) send.disabled = blocked;
    if (file) file.disabled = blocked;
  }
  /* ---------------- 发送消息 ---------------- */

  $('sendBtn').onclick = sendText;
  $('msgInput').onkeydown = function (e) { if (e.keyCode === 13) { e.preventDefault(); sendText(); } };

  function sendText() {
    var v = $('msgInput').value;
    if (!v.trim()) return;
    if (!S.room) return;
    $('msgInput').value = '';
    api('POST', '/api/rooms/' + S.room.id + '/messages', { kind: 'text', content: v }, function (err) {
      if (err) { toast(err.message); $('msgInput').value = v; return; }
      pullNow(true);
    });
  }

  /* ---------------- 分片上传 ---------------- */

  $('fileBtn').onclick = function () { $('fileInput').click(); };
  $('fileInput').onchange = function () {
    if (this.files && this.files[0]) startUpload(this.files[0]);
    this.value = '';
  };
  $('upCancel').onclick = function () {
    if (S.uploading && S.uploading.xhr) { try { S.uploading.xhr.abort(); } catch (e) {} }
    S.uploading = null;
    $('upBar').className = 'upbar hide';
  };

  function startUpload(file) {
    if (!S.room) return;
    if (file.size > 200 * 1024 * 1024) { toast('文件超过 200MB 上限'); return; }
    // 配额预检：本地先拦一道，避免传完几十分钟才在服务端被拒
    if (S.storage && file.size > S.storage.remain) {
      toast('存储空间不足：剩余 ' + S.storage.remainText + '，本文件 ' + fmtSize(file.size), 4500);
      return;
    }
    $('upBar').className = 'upbar';
    $('upFill').style.width = '0%';
    $('upText').textContent = '准备中…';

    var resumeKey = 'll_up_' + file.name + '_' + file.size;
    var resumeId = localStorage.getItem(resumeKey);

    api('POST', '/api/files/init', {
      name: file.name, size: file.size, mime: file.type || 'application/octet-stream',
      roomId: S.room.id, resumeId: resumeId || undefined
    }, function (err, data) {
      if (err) { $('upBar').className = 'upbar hide'; toast(err.message); return; }
      localStorage.setItem(resumeKey, data.fileId);
      uploadChunks(file, data, resumeKey);
    });
  }

  function uploadChunks(file, info, resumeKey) {
    var chunkSize = info.chunkSize || 4194304;
    var total = info.totalChunks;
    var received = {};
    var i;
    for (i = 0; i < info.received.length; i++) received[info.received[i]] = 1;

    var state = { idx: 0 };

    function loop() {
      while (state.idx < total && received[state.idx]) state.idx++;
      if (state.idx >= total) return finish();

      var cur = state.idx;
      var start = cur * chunkSize;
      var end = Math.min(file.size, start + chunkSize);
      var blob = file.slice(start, end);
      $('upText').style.color = '';
      $('upText').onclick = null;
      $('upText').textContent = '上传中 ' + (cur + 1) + '/' + total + ' 片 · ' + fmtSize(file.size);

      apiFile('PUT', '/api/files/' + info.fileId + '/chunk?i=' + cur, blob,
        function (loaded) {
          var pct = Math.min(100, Math.round(((cur * chunkSize) + loaded) / file.size * 100));
          $('upFill').style.width = pct + '%';
        },
        function (err, data) {
          if (err) {
            if (err.message.indexOf('中断') >= 0 || err.message.indexOf('超时') >= 0) {
              $('upText').textContent = '网络中断，点此续传';
              showRetry(file, resumeKey);
              return;
            }
            $('upBar').className = 'upbar hide';
            toast(err.message);
            return;
          }
          // 成功 → 推进到下一片（串行）
          state.idx = cur + 1;
          loop();
        });
    }

    function finish() {
      $('upText').textContent = '合并文件中…';
      api('POST', '/api/files/' + info.fileId + '/complete', {}, function (err, done) {
        if (err) {
          $('upBar').className = 'upbar hide';
          toast(err.message, 4500);
          return;
        }
        // 服务端回传最新配额，顺手更新本地缓存（「我的」页与下次预检都用它）
        if (done && done.storage) S.storage = done.storage;
        localStorage.removeItem(resumeKey);
        $('upBar').className = 'upbar hide';
        api('POST', '/api/rooms/' + S.room.id + '/messages',
          { kind: 'file', fileId: info.fileId }, function (err2) {
            if (err2) { toast(err2.message); return; }
            toast('文件已发送');
            pullNow(true);
          });
      });
    }

    loop();
  }

  function showRetry(file, resumeKey) {
    $('upText').textContent = '网络中断，点此重试';
    $('upText').style.color = '#d1242f';
    $('upText').onclick = function () {
      $('upText').style.color = '';
      $('upText').onclick = null;
      startUpload(file);
    };
  }

  /* ---------------- 群管理：成员面板 ---------------- */

  $('memberBtn').onclick = openMembers;
  $('feedbackBtn').onclick = openFeedbackBox;

  /* ---------------- 多选模式：底部操作栏 ---------------- */

  // 顶栏不再有常驻「多选」按钮：从「点消息 → 多选」或长按进入
  bind('selCancel', function () { setSelMode(false); });
  bind('selAll', toggleSelAll);
  bind('selDelete', batchDelete);
  bind('selPurge', batchPurge);
  // 操作面板：点遮罩关闭
  bind('actMask', closeActSheet);

  function openMembers() {
    if (!S.room) return;
    api('GET', '/api/rooms/' + S.room.id + '/members', null, function (err, data) {
      if (err) { toast(err.message); return; }
      var myRole = data.myRole;
      var myRank = { owner: 4, admin: 3, subadmin: 2, junior: 1, member: 0 }[myRole] || 0;

      // 真实 DOM 构建（不是 innerHTML 字符串）：头像需要绑事件、也便于自动化测试驱动
      var list = document.createElement('div');
      list.className = 'mlist';
      for (var i = 0; i < data.members.length; i++) {
        var m = data.members[i];
        var rk = { owner: 4, admin: 3, subadmin: 2, junior: 1, member: 0 }[m.role] || 0;

        var row = document.createElement('div');
        row.className = 'mrow';

        // 头像可点 → 打开对方资料页并可发起好友申请
        var av = document.createElement('span');
        av.className = 'm-av';
        av.style.background = m.avatarColor || colorOf(m.userId);
        if (m.avatar) {
          av.style.backgroundImage = 'url("' + m.avatar + '")';
          av.style.backgroundSize = 'cover';
          av.style.backgroundPosition = 'center';
        } else {
          av.textContent = m.initial || (m.nickname || '?').charAt(0);
        }
        av.title = '查看资料';
        av.setAttribute('data-mav', m.userId);
        av.onclick = (function (uid) {
          return function (e) {
            if (e && e.stopPropagation) e.stopPropagation();
            closeModal();          // 先关弹层，避免盖住资料页
            openProfile(uid);
          };
        })(m.userId);
        row.appendChild(av);

        var nm = document.createElement('span');
        nm.className = 'm-name';
        var nameTxt = document.createElement('span');
        // 显示「该房间内的专属昵称」，未设置时服务端已回退为全局昵称
        nameTxt.textContent = m.displayName || m.nickname;
        nm.appendChild(nameTxt);
        var roleTag = document.createElement('span');
        roleTag.className = 'role r' + rk;
        roleTag.textContent = m.roleName;
        nm.appendChild(roleTag);
        if (m.mutedUntil > Date.now()) {
          var muteTag = document.createElement('span');
          muteTag.className = 'badge warn';
          muteTag.textContent = '禁言中';
          nm.appendChild(muteTag);
        }
        row.appendChild(nm);

        if (rk < myRank) {
          row.appendChild(memberAct('mute', m, '禁言'));
          row.appendChild(memberAct('kick', m, '踢出'));
        }
        // 任命/调整职级：自己职级高于对方，且对方不是群主
        if (rk <= myRank && rk < 4 && myRole !== 'member' && myRole !== 'junior') {
          row.appendChild(memberAct('appoint', m, '任命'));
        }
        // 遗产继承人：仅群主可设，且不能指定自己
        if (myRole === 'owner' && m.userId !== S.user.id && !data.dissolved) {
          row.appendChild(memberAct('heir', m, (m.userId === data.heirId ? '已设继承人' : '设为继承人')));
          row.appendChild(memberAct('transfer', m, '转让群主'));
        }
        list.appendChild(row);
      }

      /* 我在本房间的专属昵称：与全局昵称独立、互不同步 */
      var selfCard = document.createElement('div');
      selfCard.className = 'card';
      var selfHead = document.createElement('div');
      selfHead.className = 'card-h';
      selfHead.textContent = '我在本房间的专属昵称';
      selfCard.appendChild(selfHead);
      var selfRow = document.createElement('div');
      selfRow.className = 'row';
      var selfMain = document.createElement('div');
      selfMain.className = 'r-main';
      var selfTitle = document.createElement('div');
      selfTitle.className = 'r-title';
      selfTitle.textContent = data.myRoomNickname || '（未设置，显示全局昵称）';
      var selfSub = document.createElement('div');
      selfSub.className = 'r-sub';
      selfSub.textContent = '只在本房间生效，不影响其它房间与全局显示';
      selfMain.appendChild(selfTitle);
      selfMain.appendChild(selfSub);
      selfRow.appendChild(selfMain);
      if (!data.dissolved) {
        var selfRight = document.createElement('div');
        selfRight.className = 'r-right';
        var selfBtn = document.createElement('div');
        selfBtn.className = 'mini-btn';
        selfBtn.id = 'editRoomNick';
        selfBtn.textContent = '修改';
        selfBtn.onclick = doChangeRoomNickname;
        selfRight.appendChild(selfBtn);
        selfRow.appendChild(selfRight);
      }
      selfCard.appendChild(selfRow);
      // 真实浏览器插到最前；精简 DOM 环境（自动化测试）没有 insertBefore 时降级为追加
      if (list.insertBefore) list.insertBefore(selfCard, list.firstChild);
      else list.appendChild(selfCard);

      /* 解散：群主可解散自己的群；最高权限可解散任意群与公共大厅（公共大厅默认封死） */
      if (data.canDissolve) {
        var dis = document.createElement('div');
        dis.className = 'act danger';
        dis.id = 'dissolveRoom';
        dis.textContent = data.publicHall
          ? '解散公共大厅（仅最高权限，不可恢复）'
          : '解散本群聊（不可恢复）';
        dis.onclick = doDissolveRoom;
        list.appendChild(dis);
      }

      /* 最高权限：一键清空本房间全部消息（房间保留，系统通知一并清掉） */
      if (data.master && !data.dissolved) {
        var clr = document.createElement('div');
        clr.className = 'act danger';
        clr.id = 'clearRoomMsgs';
        clr.textContent = '清空本房间全部消息（最高权限）';
        clr.onclick = doClearRoomMessages;
        list.appendChild(clr);
      }
      if (data.dissolved) {
        var dtip = document.createElement('div');
        dtip.className = 'dissolved-tip';
        dtip.textContent = '该群已解散，仅可查看历史消息与解散通知';
        if (list.insertBefore) list.insertBefore(dtip, list.firstChild);
        else list.appendChild(dtip);
      }
      openModal('成员管理（' + data.members.length + '人）', list, function () { return true; }, '关闭');
    });
  }

  /** 成员面板里的操作按钮（禁言 / 踢出 / 任命） */
  function memberAct(act, m, label) {
    var b = document.createElement('button');
    b.className = 'm-act';
    b.textContent = label;
    b.setAttribute('data-act', act);
    b.setAttribute('data-uid', m.userId);
    b.setAttribute('data-name', m.displayName || m.nickname);
    if (act === 'appoint') b.setAttribute('data-role', m.role);
    b.onclick = function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      var nm = m.displayName || m.nickname;
      if (act === 'mute') doMute(m.userId, nm);
      else if (act === 'kick') doKick(m.userId, nm);
      else if (act === 'heir') doSetHeir(m.userId, nm);
      else if (act === 'transfer') doTransferOwner(m.userId, nm);
      else doAppoint(m.userId, nm, m.role);
    };
    return b;
  }

  function doMute(uid, name) {
    closeModal();
    openModal('禁言 ' + name,
      '<select id="mdur">' +
      '<option value="5">5 分钟</option>' +
      '<option value="30" selected>30 分钟</option>' +
      '<option value="60">1 小时</option>' +
      '<option value="180">3 小时</option>' +
      '<option value="1440">1 天</option>' +
      '<option value="10080">7 天</option></select>',
      function () {
        var mins = parseInt($('mdur').value, 10);
        api('POST', '/api/rooms/' + S.room.id + '/mute', { userId: uid, minutes: mins }, function (err) {
          if (err) { toast(err.message); return; }
          toast('已禁言 ' + mins + ' 分钟');
        });
        return true;
      }, '确定');
  }

  function doKick(uid, name) {
    closeModal();
    openModal('踢出 ' + name, '<div style="font-size:13px;color:var(--fg-2)">确认将该成员移出房间？</div>',
      function () {
        api('POST', '/api/rooms/' + S.room.id + '/kick', { userId: uid }, function (err) {
          if (err) { toast(err.message); return; }
          toast('已踢出');
        });
        return true;
      }, '踢出');
  }

  function doAppoint(uid, name, curRole) {
    closeModal();
    var myRole = S.room.role;
    var myRank = { owner: 4, admin: 3, subadmin: 2, junior: 1, member: 0 }[myRole] || 0;
    var curRank = { owner: 4, admin: 3, subadmin: 2, junior: 1, member: 0 }[curRole] || 0;
    var NAMES = { owner: '群主', admin: '丞相', subadmin: '县令', junior: '乡长', member: '百姓' };
    var DESC = { admin: '管理员', subadmin: '小管理员', junior: '末级管理员' };
    var options = '';
    var i;
    // 可任命的职级：比自己低，且在自己的任命权限内
    var appointable = { owner: ['admin', 'subadmin', 'junior'], admin: ['subadmin'], subadmin: ['junior'] };
    var list = appointable[myRole] || [];
    for (i = 0; i < list.length; i++) {
      var rk = { admin: 3, subadmin: 2, junior: 1 }[list[i]];
      if (rk >= myRank) continue;
      // 降级调整：目标当前职级高于新职级时，同样可选
      options += '<option value="' + list[i] + '"' +
        (curRank <= rk && curRank > 0 ? ' selected' : '') + '>' +
        NAMES[list[i]] + '（' + (DESC[list[i]] || '') + '）</option>';
    }
    if (!options) { toast('你没有可任命的职级'); return; }
    openModal('任命 ' + name,
      '<select id="arole">' + options + '</select>' +
      '<div style="font-size:12px;color:var(--fg-3);margin-top:8px">' +
      '当前职级：' + NAMES[curRole] + '　可调整为更低的职级<br>' +
      '官职权限逐级递减：群主 &gt; 丞相 &gt; 县令 &gt; 乡长 &gt; 百姓</div>',
      function () {
        var role = $('arole').value;
        api('POST', '/api/rooms/' + S.room.id + '/appoint', { userId: uid, role: role }, function (err) {
          if (err) { toast(err.message); return; }
          toast('任命成功');
          openMembers();
        });
        return true;
      }, '任命');
  }

  function doSetHeir(uid, name) {
    closeModal();
    var roomId = S.room.id;
    if (!roomId) return;
    askConfirm('遗产继承人', '将「' + name + '」设为该群的遗产继承人？<br>你注销账号时，群主自动转交给 TA（不影响当前管理）。<br>若 TA 已是继承人，再次点击则取消。', function () {
    api('GET', '/api/rooms/' + roomId + '/members', {}, function (err, d) {
      if (err) { alert('获取成员失败：' + (err.message || err)); return; }
      var cur = (d && d.heirId) || null;
      var newHeir = (cur === uid) ? '' : uid;
      api('POST', '/api/rooms/' + roomId + '/heir', { heirId: newHeir }, function (err2, d2) {
        if (err2) { alert('设置失败：' + (err2.message || err2)); return; }
        toast(d2.heirId ? ('已将「' + name + '」设为遗产继承人') : '已取消遗产继承人');
        openMembers();
      });
    });
    }, '确定');
  }

  /* ---------------- 房间专属昵称 / 转让 / 解散 ---------------- */

  /** 修改我在本房间的专属昵称（留空 = 清除并回退显示全局昵称） */
  function doChangeRoomNickname() {
    if (!S.room) return;
    closeModal();
    var roomId = S.room.id;
    askInput('本房间昵称', '2-20 位中英文/数字/下划线；留空恢复全局昵称', '', function (v) {
      api('POST', '/api/rooms/' + roomId + '/nickname', { nickname: String(v).trim() }, function (err, d) {
        if (err) { toast('修改失败：' + (err.message || err)); return; }
        toast('本房间昵称已更新为「' + d.displayName + '」');
        openMembers();
      });
    }, '保存');
  }

  /** 主动转让群主：二次确认，服务端会在该房间发布系统通知 */
  function doTransferOwner(uid, name) {
    if (!S.room) return;
    closeModal();
    askConfirm('转让群主', '确定把群主权限转让给「' + name + '」吗？<br>转让后你将变为普通成员，并会在本群发布一条系统通知。', function () {
      var roomId = S.room.id;
      api('POST', '/api/rooms/' + roomId + '/transfer', { userId: uid, confirm: true }, function (err) {
        if (err) { toast('转让失败：' + (err.message || err)); return; }
        toast('群主权限已转让');
        refreshRoomAfterChange();
      });
    }, '转让');
  }

  /** 解散群聊：仅群主可见，两步确认；停用后成员仍能读到解散系统通知 */
  function doDissolveRoom() {
    if (!S.room) return;
    var roomId = S.room.id;
    var name = roomNameById(roomId);
    var isPublic = S.room.kind === 'public' || S.room.publicHall;
    closeModal();
    var tip = (isPublic
      ? '这是公共大厅，解散后全体成员都将只能查看历史消息，且不可恢复。'
      : '解散后「' + name + '」将停用，仅保留历史消息与解散通知，且不可恢复。');
    askInput('解散群聊', tip + '<br>请输入房间名「' + esc(name) + '」以确认解散：', '', function (typed) {
      if (String(typed).trim() !== name) { toast('房间名不符，已取消解散'); return false; }
      api('POST', '/api/rooms/' + roomId + '/dissolve', { confirm: true }, function (err) {
        if (err) { toast('解散失败：' + (err.message || err)); return; }
        toast('已解散。成员仍可进入查看历史消息与解散通知');
        refreshRoomAfterChange();
      });
    }, '解散');
  }

  /** 最高权限：清空本房间全部消息（房间本身保留，不产生解散通知） */
  function doClearRoomMessages() {
    if (!S.room) return;
    var roomId = S.room.id;
    var name = roomNameById(roomId);
    closeModal();
    askInput('清空消息', '将彻底清空「' + esc(name) + '」的全部消息（含文件字节），房间本身保留。<br>此操作不可恢复。请输入「' + esc(name) + '」确认：', '', function (typed) {
      if (String(typed).trim() !== name) { toast('房间名不符，已取消'); return false; }
      api('POST', '/api/admin/rooms/' + roomId + '/clear', { confirm: true }, function (err, d) {
        if (err) { toast('清空失败：' + (err.message || err)); return; }
        toast('已清空 ' + (d && d.cleared ? d.cleared : 0) + ' 条消息');
        pullNow(true);
        refreshRoomAfterChange();
      });
    }, '清空');
  }

  /** 房间状态变化后重新拉一遍：拿到系统通知，并同步只读状态 */
  function refreshRoomAfterChange() {
    var roomId = S.room && S.room.id;
    if (!roomId) return;
    loadRooms(function () { openRoom(roomId); });
  }

  /* ---------------- 好友 ---------------- */

  function loadFriends() {
    api('GET', '/api/friends', null, function (err, data) {
      if (err) { toast(err.message); return; }
      var sig = friendSig(data.friends, data.incoming, data.outgoing) + '|' +
        (data.recentAccepted || []).map(function (a) { return a.id + ':' + a.acceptedAt; }).join(',');
      var changed = (sig !== S.friendSig);
      S.friends = data.friends;
      S.incoming = data.incoming;
      S.outgoing = data.outgoing;
      S.recentAccepted = data.recentAccepted || [];
      S.friendSig = sig;
      // 数据没变化就不重绘，避免切页面时闪一下
      if (changed) renderView();
    });
  }

  /** 好友数据的指纹：只有列表真正变了才重绘，避免轮询导致界面闪动 */
  function friendSig(friends, incoming, outgoing) {
    function ids(a, key) {
      var r = [];
      for (var i = 0; i < a.length; i++) r.push(a[i][key] || a[i].id);
      return r.join(',');
    }
    return ids(friends || [], 'id') + '|' + ids(incoming || [], 'id') + '|' + ids(outgoing || [], 'id');
  }

  /**
   * 好友页实时刷新：对方发来申请 / 别人处理了申请时，本页自动更新。
   * 只在好友视图下轮询，离开页面立即清理定时器。
   */
  function startFriendPoll() {
    stopFriendPoll();
    S.friendTimer = setInterval(function () {
      if (S.view !== 'friends') return;
      api('GET', '/api/friends', null, function (err, data) {
        if (err) return;
        var sig = friendSig(data.friends, data.incoming, data.outgoing) + '|' +
        (data.recentAccepted || []).map(function (a) { return a.id + ':' + a.acceptedAt; }).join(',');
        if (sig === S.friendSig) return;   // 没变化就不重绘
        S.friendSig = sig;
        S.friends = data.friends;
        S.incoming = data.incoming;
        S.outgoing = data.outgoing;
        renderView();
      });
    }, 5000);
    // Node 环境（自动化测试）下不让定时器挂住进程
    if (S.friendTimer && S.friendTimer.unref) S.friendTimer.unref();
  }

  function stopFriendPoll() {
    if (S.friendTimer) { clearInterval(S.friendTimer); S.friendTimer = null; }
  }

  /**
   * 同意好友申请：服务端把双方加进好友索引（双向），
   * 随后重新拉取好友列表 —— 申请列表消失、好友列表出现，两边同步更新。
   */
  function acceptFriend(reqId) {
    api('POST', '/api/friends/' + encodeURIComponent(reqId) + '/accept', {}, function (err) {
      if (err) { toast(err.message); return; }
      toast('已添加为好友');
      loadFriends();
    });
  }

  /** 拒绝好友申请：标记为 rejected，列表实时移除该条 */
  function rejectFriend(reqId) {
    api('POST', '/api/friends/' + encodeURIComponent(reqId) + '/reject', {}, function (err) {
      if (err) { toast(err.message); return; }
      toast('已拒绝该申请');
      loadFriends();
    });
  }

  /* ---------------- 用户资料 / 申请加好友 ---------------- */

  /**
   * 打开某个用户的资料页（申请加好友）。
   * 入口：聊天消息里的头像、房间成员面板里的头像、好友列表的头像、搜索结果的头像。
   */
  function openProfile(userId) {
    if (!userId) return;
    closeModal();  // 从好友申请弹窗里点头像看资料时，先收起弹窗避免遮挡
    api('GET', '/api/users/' + encodeURIComponent(userId), null, function (err, data) {
      if (err) { toast(err.message); return; }
      S.profile = data;
      // 记住来源：从聊天页（公共聊天室 / 自定义房间 / 私聊）进来，返回时回到聊天页，
      // 而不是莫名其妙跳回主界面。
      var chat = $('chat');
      var fromChat = !!(chat && chat.className.indexOf('hide') < 0);
      S.profileFrom = fromChat ? 'chat' : 'main';
      $('faTitle').textContent = data.self ? '我的资料' : '用户资料';
      $('main').className = 'screen hide';
      // ⚠️ 必须同时隐藏聊天页：main / chat / friendAdd 是文档流里上下排布的 .screen，
      // 只藏 main 的话资料页会被顶到屏幕外看不见 —— 表现为「点了头像没反应」。
      if (chat) chat.className = 'screen hide chat-screen';
      $('friendAdd').className = 'screen';
      renderProfile();
    });
  }

  /** 从资料页返回原场景（聊天页 or 主界面） */
  function closeProfile() {
    $('friendAdd').className = 'screen hide';
    S.profile = null;
    var from = S.profileFrom;
    S.profileFrom = '';
    if (from === 'chat') {
      // 回到刚才的聊天页（消息仍在，轮询未停，回来就是最新的）
      $('main').className = 'screen hide';
      $('chat').className = 'screen chat-screen';
      return;
    }
    $('main').className = 'screen';
    renderView();
  }

  /** 从资料页跳到好友页（处理对方发来的申请）—— 无论从哪进来都回到主界面 */
  function gotoFriendsFromProfile() {
    S.profileFrom = '';
    closeProfile();
    $('main').className = 'screen';
    switchView('friends');
    loadFriends();
  }

  /** 最高权限：注销指定用户（两步确认，账号名需手动输入以防误点） */
  function doAdminDeleteUser(u) {
    if (!u) return;
    var name = u.nickname || u.username;
    askInput('注销用户', '确定注销用户「' + esc(name) + '」吗？<br>' +
      '其创建的房间、发布的全部消息与上传的文件都会被彻底清除，不可恢复。<br>' +
      '请输入该用户的账号名「' + esc(u.username) + '」以确认：', '', function (typed) {
        if (String(typed).trim() !== u.username) { toast('账号名不符，已取消'); return false; }
        api('POST', '/api/admin/users/' + encodeURIComponent(u.id) + '/delete', { confirm: true }, function (err, d) {
          if (err) { toast('注销失败：' + (err.message || err)); return; }
          var st = (d && d.stats) || {};
          toast('已注销。清理：房间 ' + (st.rooms || 0) + ' 个 / 消息 ' + (st.messages || 0) +
            ' 条 / 文件 ' + (st.files || 0) + ' 个');
          closeProfile();
          loadRooms();
        });
      }, '注销');
  }

  function renderProfile() {
    var d = S.profile;
    var v = $('faView');
    if (!d) return;
    v.innerHTML = '';

    /* ---- 资料卡 ---- */
    var card = el('div', 'card');
    var head = el('div', 'prof-head');
    head.appendChild(avatarEl(d.user.id, d.user.initial, d.user.avatarColor, 'p-av', d.user.avatar));

    var info = el('div', 'prof-info');
    info.appendChild(el('div', 'prof-name', d.user.nickname));
    info.appendChild(el('div', 'prof-sub', '账号：' + d.user.username));
    info.appendChild(el('div', 'prof-sub', '注册于 ' + fmtTime(d.user.createdAt)));
    head.appendChild(info);
    card.appendChild(head);
    v.appendChild(card);

    /* ---- 操作卡 ---- */
    var act = el('div', 'card');

    if (d.self) {
      act.appendChild(el('div', 'card-h', '这是你自己'));
      act.appendChild(el('div', 'req-hint', '这是你的个人资料页，其他人可以点这里查看你的信息并向你发起好友申请。'));
      v.appendChild(act);
      return;
    }

    /* 最高权限：注销指定用户（标准版专属入口，低配版无此界面） */
    if (S.user && S.user.master) {
      var adminCard = el('div', 'card');
      adminCard.appendChild(el('div', 'card-h', '最高权限操作'));
      adminCard.appendChild(el('div', 'req-hint',
        '可直接注销该用户：其创建的房间、发布的全部消息、上传的文件与好友关系会一并彻底清除，不可恢复。'));
      var admDel = el('button', 'btn danger full', '注销该用户');
      admDel.id = 'adminDeleteUser';
      admDel.onclick = function () { doAdminDeleteUser(d.user); };
      adminCard.appendChild(admDel);
      v.appendChild(adminCard);
    }

    if (d.friend) {
      act.appendChild(el('div', 'card-h', '你们已经是好友'));
      var dm = el('button', 'btn primary full', '发消息');
      dm.onclick = function () {
        closeProfile();
        openDM(d.user.id);
      };
      act.appendChild(dm);
      v.appendChild(act);
      return;
    }

    if (d.received) {
      act.appendChild(el('div', 'card-h', '对方已申请添加你'));
      act.appendChild(el('div', 'req-hint', '「' + d.user.nickname + '」已经向你发送了好友申请，去好友页面同意或拒绝。'));
      var goBtn = el('button', 'btn primary full', '去处理好友申请');
      goBtn.onclick = gotoFriendsFromProfile;
      act.appendChild(goBtn);
      v.appendChild(act);
      return;
    }

    if (d.requested) {
      act.appendChild(el('div', 'card-h', '申请已发送'));
      act.appendChild(el('div', 'req-hint', '你已向「' + d.user.nickname + '」发送好友申请，等待对方同意。'));
      v.appendChild(act);
      return;
    }

    /* ---- 还没申请：填写附言并发送 ---- */
    act.appendChild(el('div', 'card-h', '申请加好友'));
    act.appendChild(el('div', 'req-hint', '填写一句附言，让对方知道你是谁：'));

    var ta = document.createElement('textarea');
    ta.className = 'inp msg-box';
    ta.id = 'faMsg';
    ta.rows = 3;
    ta.maxLength = 200;
    ta.value = '你好，我想加你为好友';
    ta.setAttribute('placeholder', '说点什么（选填）');
    act.appendChild(ta);

    var send = el('button', 'btn primary full', '发送好友申请');
    send.id = 'faSend';
    send.onclick = function () {
      var msg = '';
      try { msg = String(ta.value || '').slice(0, 200); } catch (e) { msg = ''; }
      api('POST', '/api/friends/request', { userId: d.user.id, message: msg }, function (err) {
        if (err) { toast(err.message); return; }
        toast('好友申请已发送');
        d.requested = true;
        renderProfile();
      });
    };
    act.appendChild(send);
    v.appendChild(act);
  }

  function searchUser() {
    openModal('搜索用户',
      '<input id="uq" type="text" placeholder="输入账号或昵称">',
      function () {
        var q = $('uq').value.trim();
        if (!q) { toast('请输入关键词'); return false; }
        api('GET', '/api/users?q=' + encodeURIComponent(q), null, function (err, data) {
          if (err) { toast(err.message); return; }
          closeModal();
          if (!data.users.length) { toast('未找到用户'); return; }
          var box = el('div', 'mlist');
          for (var i = 0; i < data.users.length; i++) {
            var u = data.users[i];
            var mrow = el('div', 'mrow');
            // 头像可点击 → 进入对方资料页（可带附言申请加好友）
            var av = el('div', 'row-av', u.initial || (u.nickname || '?').charAt(0));
            av.style.background = u.avatarColor || colorOf(u.id);
            av.setAttribute('data-profile', u.id);
            av.title = '查看资料';
            av.onclick = function () {
              closeModal();
              openProfile(this.getAttribute('data-profile'));
            };
            mrow.appendChild(av);
            var nm = el('span', 'm-name');
            nm.appendChild(el('span', 'nm', u.nickname));
            nm.appendChild(el('span', 'badge gray', u.username));
            mrow.appendChild(nm);
            if (u.friend) {
              var dm2 = el('button', 'm-act', '私聊');
              dm2.setAttribute('data-dm2', u.id);
              dm2.onclick = function () {
                closeModal();
                openDM(this.getAttribute('data-dm2'));
              };
              mrow.appendChild(dm2);
            } else {
              var add = el('button', 'm-act', '加好友');
              add.setAttribute('data-add', u.id);
              add.onclick = function () {
                closeModal();
                openProfile(this.getAttribute('data-add'));
              };
              mrow.appendChild(add);
            }
            box.appendChild(mrow);
          }
          openModal('搜索结果', '', function () { return true; }, '关闭');
          $('modalBody').appendChild(box);
        });
        return true;
      }, '搜索');
  }

  /* ================= 云网盘 ================= */

  /**
   * 网盘与聊天共用同一份文件数据：聊天里发出的文件天然就在网盘里，
   * 网盘上传的文件也能直接发到任意房间。这里只做界面。
   */

  var DRIVE_TYPES = [
    { key: '', label: '全部' },
    { key: 'image', label: '图片' },
    { key: 'video', label: '视频' },
    { key: 'audio', label: '音频' },
    { key: 'doc', label: '文档' },
    { key: 'archive', label: '压缩包' },
    { key: 'other', label: '其他' }
  ];

  var DRIVE_ICON = {
    image: '🖼', video: '🎬', audio: '🎵',
    doc: '📄', archive: '🗜', other: '📦'
  };

  function D() {
    if (!S.drive) {
      S.drive = {
        tab: 'files',        // files | trash | shares
        keyword: '', type: '', sort: 'time',
        page: 1, size: 30,
        folder: null,        // null=全部；''=根目录
        items: [], folders: [],
        total: 0, pages: 1, loading: false,
        uploadPct: -1, uploadText: ''
      };
    }
    return S.drive;
  }

  function fmtTimeShort(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 复制到剪贴板：现代接口优先，老内核退回到临时 textarea */
  function copyText(txt) {
    var done = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt);
        done = true;
      }
    } catch (e) { done = false; }
    if (!done) {
      try {
        var ta = document.createElement('textarea');
        ta.value = txt;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done = true;
      } catch (e2) { done = false; }
    }
    toast(done ? '已复制' : '复制失败，请手动选中复制');
  }

  /* ---------------- 数据加载 ---------------- */

  function loadDrive(cb) {
    var d = D();
    d.loading = true;
    if (d.tab === 'trash') return loadDriveTrash(cb);
    if (d.tab === 'shares') return loadDriveShares(cb);

    var qs = '?page=' + d.page + '&size=' + d.size + '&sort=' + encodeURIComponent(d.sort);
    if (d.keyword) qs += '&keyword=' + encodeURIComponent(d.keyword);
    if (d.type) qs += '&type=' + encodeURIComponent(d.type);
    if (d.folder !== null) qs += '&folder=' + encodeURIComponent(d.folder);

    api('GET', '/api/drive/files' + qs, null, function (err, data) {
      d.loading = false;
      if (err) { toast(err.message); return; }
      d.items = data.items || [];
      d.folders = data.folders || [];
      d.total = data.total || 0;
      d.pages = data.pages || 1;
      if (cb) cb();
      else renderDrive();
    });
  }

  function loadDriveTrash(cb) {
    var d = D();
    api('GET', '/api/drive/trash?page=' + d.page + '&size=' + d.size, null, function (err, data) {
      d.loading = false;
      if (err) { toast(err.message); return; }
      d.items = data.items || [];
      d.total = data.total || 0;
      d.pages = data.pages || 1;
      if (cb) cb();
      else renderDrive();
    });
  }

  function loadDriveShares(cb) {
    var d = D();
    api('GET', '/api/drive/shares', null, function (err, data) {
      d.loading = false;
      if (err) { toast(err.message); return; }
      d.items = (data.items || []).map(function (s) {
        return {
          fileId: s.shareId, shareId: s.shareId, name: s.fileName,
          size: s.fileSize, sizeText: s.fileSizeText, type: s.fileType,
          encrypted: s.encrypted, code: s.code, expireAt: s.expireAt,
          downloads: s.downloads, revoked: s.revoked, expired: s.expired,
          isShareRow: true
        };
      });
      d.total = d.items.length;
      d.pages = 1;
      if (cb) cb();
      else renderDrive();
    });
  }

  function loadDriveStorage(cb) {
    api('GET', '/api/drive/storage', null, function (err, data) {
      if (err) { if (cb) cb(); return; }
      S.storage = data;
      if (cb) cb();
    });
  }

  /* ---------------- 视图 ---------------- */

  function renderDrive() {
    var d = D();
    var box = $('view');
    var h = '';

    // 配额
    var st = S.storage;
    if (st) {
      var pct = Math.max(0, Math.min(100, st.percent || 0));
      h += '<div class="card quota-box">' +
        '<div class="card-h">存储空间</div>' +
        '<div class="quota-row"><span>' + esc(st.usedText) + ' / ' + esc(st.quotaText) + '</span>' +
        '<span class="quota-rest">剩余 ' + esc(st.remainText) + '</span></div>' +
        '<div class="quota-track"><div class="quota-fill' + (pct >= 90 ? ' warn' : '') + '" style="width:' + pct + '%"></div></div>' +
        '<div class="r-sub quota-sub">每人 2GB 总额度，聊天与网盘共用；回收站内的文件在清除前仍占用额度</div>' +
        '</div>';
    }

    // 上传进度（只在传输时出现）
    if (d.uploadPct >= 0) {
      h += '<div class="drive-up"><div class="up-text" id="driveUpText">' + esc(d.uploadText) + '</div>' +
        '<div class="up-track"><div class="up-fill" id="driveUpFill" style="width:' + d.uploadPct + '%"></div></div></div>';
    }

    // 分段：文件 / 回收站 / 分享
    h += '<div class="drive-tabs">' +
      '<button class="dtab' + (d.tab === 'files' ? ' on' : '') + '" data-dtab="files">我的文件</button>' +
      '<button class="dtab' + (d.tab === 'trash' ? ' on' : '') + '" data-dtab="trash">回收站</button>' +
      '<button class="dtab' + (d.tab === 'shares' ? ' on' : '') + '" data-dtab="shares">我的分享</button>' +
      '</div>';

    if (d.tab === 'files') {
      // 工具条
      h += '<div class="drive-tools">' +
        '<input id="driveSearch" class="inp grow" type="text" placeholder="搜索文件名…" value="' + esc(d.keyword) + '">' +
        '<button id="driveUploadBtn" class="btn primary small">上传</button>' +
        '</div>';
      h += '<div class="drive-chips">';
      for (var i = 0; i < DRIVE_TYPES.length; i++) {
        var t = DRIVE_TYPES[i];
        h += '<button class="chip' + (d.type === t.key ? ' on' : '') + '" data-dtype="' + t.key + '">' + t.label + '</button>';
      }
      h += '</div>';

      // 目录：工具条常驻（空网盘也能先建目录），当前目录可删（仅空目录允许删）
      h += '<div class="drive-chips drive-folders">';
      h += '<button class="chip' + (d.folder === null ? ' on' : '') + '" data-dfolder="__all__">全部目录</button>';
      h += '<button class="chip' + (d.folder === '' ? ' on' : '') + '" data-dfolder="__root__">根目录</button>';
      for (var j = 0; j < (d.folders || []).length; j++) {
        h += '<button class="chip' + (d.folder === d.folders[j] ? ' on' : '') + '" data-dfolder="' + esc(d.folders[j]) + '">📁 ' + esc(d.folders[j]) + '</button>';
      }
      h += '<button class="chip d-newfolder" id="dNewFolder">＋ 新建目录</button>';
      if (d.folder) h += '<button class="chip d-delfolder" id="dDelFolder">删除「' + esc(d.folder) + '」</button>';
      h += '</div>';

      h += '<div class="drive-meta">共 ' + d.total + ' 个文件 · <span id="driveSort" class="link">' +
        (d.sort === 'size' ? '按大小' : (d.sort === 'name' ? '按名称' : '按时间')) + '</span></div>';

      if (!d.items.length) {
        h += '<div class="empty">还没有文件。点右上「上传」，或在聊天里发一个文件——它也会出现在这里。</div>';
      } else {
        h += '<div class="dlist">';
        for (var k = 0; k < d.items.length; k++) {
          h += driveRowHtml(d.items[k], 'files');
        }
        h += '</div>';
        h += drivePagerHtml(d);
      }
    } else if (d.tab === 'trash') {
      h += '<div class="drive-meta">回收站保留 30 天，到期自动彻底删除</div>';
      if (!d.items.length) h += '<div class="empty">回收站是空的</div>';
      else {
        h += '<div class="dlist">';
        for (var m = 0; m < d.items.length; m++) h += driveRowHtml(d.items[m], 'trash');
        h += '</div>';
        h += drivePagerHtml(d);
      }
    } else {
      h += '<div class="drive-meta">分享链接可发给站外的人，过期或取消后立即失效</div>';
      if (!d.items.length) h += '<div class="empty">还没有创建过分享</div>';
      else {
        h += '<div class="dlist">';
        for (var n = 0; n < d.items.length; n++) h += driveRowHtml(d.items[n], 'shares');
        h += '</div>';
      }
    }

    box.innerHTML = h;
    bindDriveEvents();
  }

  function driveRowHtml(it, mode) {
    var icon = DRIVE_ICON[it.type] || '📦';
    var sub = [];
    if (mode === 'trash') {
      sub.push('剩余 ' + (it.remainDays || 0) + ' 天');
      sub.push(it.sizeText || '');
    } else if (mode === 'shares') {
      sub.push(it.sizeText || '');
      sub.push(it.encrypted ? ('提取码 ' + (it.code || '')) : '公开');
      sub.push('下载 ' + (it.downloads || 0) + ' 次');
      sub.push(it.expired ? '已过期' : ('有效至 ' + fmtTimeShort(it.expireAt)));
    } else {
      sub.push(it.sizeText || '');
      sub.push(it.typeLabel || '');
      if (it.fromChat && it.roomName) sub.push('来自 ' + it.roomName);
      if (it.folder) sub.push('📁 ' + it.folder);
      sub.push(fmtTimeShort(it.createdAt));
    }
    var right = '';
    if (mode === 'trash') right = '<button class="mini-btn" data-dquick="trash">恢复</button>';
    else if (mode === 'shares') {
      right = '<button class="mini-btn" data-dquick="shares">复制</button>' +
        '<button class="mini-btn danger" data-dquick="off">下线</button>';
    }
    return '<div class="drow" data-fid="' + esc(it.fileId || it.shareId) + '" data-mode="' + mode + '">' +
      '<div class="dicon t-' + esc(it.type || 'other') + '">' + icon + '</div>' +
      '<div class="dmain"><div class="dname">' + esc(it.name || '(未命名)') + '</div>' +
      '<div class="dsub">' + esc(sub.filter(Boolean).join(' · ')) + '</div></div>' +
      right +
      '</div>';
  }

  function drivePagerHtml(d) {
    if (d.pages <= 1) return '';
    return '<div class="drive-pager">' +
      '<button class="mini-btn" data-dpage="prev"' + (d.page <= 1 ? ' disabled' : '') + '>上一页</button>' +
      '<span>' + d.page + ' / ' + d.pages + '</span>' +
      '<button class="mini-btn" data-dpage="next"' + (d.page >= d.pages ? ' disabled' : '') + '>下一页</button>' +
      '</div>';
  }

  function bindDriveEvents() {
    var d = D();

    // 分段切换
    var tabs = document.querySelectorAll('#view .dtab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].onclick = function () {
        d.tab = this.getAttribute('data-dtab');
        d.page = 1;
        d.items = [];
        renderDrive();
        if (d.tab === 'shares') return loadDriveShares();
        loadDrive();
      };
    }

    var search = $('driveSearch');
    if (search) {
      search.onkeydown = function (e) {
        if (e && e.keyCode === 13) {
          d.keyword = String(search.value || '').trim();
          d.page = 1;
          loadDrive();
        }
      };
    }

    if ($('driveUploadBtn')) $('driveUploadBtn').onclick = pickDriveUpload;

    var chips = document.querySelectorAll('#view .chip');
    for (var j = 0; j < chips.length; j++) {
      chips[j].onclick = function () {
        var t = this.getAttribute('data-dtype');
        var f = this.getAttribute('data-dfolder');
        // 目录工具按钮（新建/删除）不是筛选 chip，跳过，由下面单独绑定
        if (this.id === 'dNewFolder' || this.id === 'dDelFolder') return;
        if (t !== null && t !== undefined) { d.type = t; }
        if (f !== null && f !== undefined) {
          if (f === '__all__') d.folder = null;
          else if (f === '__root__') d.folder = '';
          else d.folder = f;
        }
        d.page = 1;
        renderDrive();
        loadDrive();
      };
    }

    if ($('dNewFolder')) $('dNewFolder').onclick = function () { doDriveNewFolder(); };
    if ($('dDelFolder')) $('dDelFolder').onclick = function () { doDriveDeleteFolder(d.folder); };

    if ($('driveSort')) {
      $('driveSort').onclick = function () {
        d.sort = d.sort === 'time' ? 'size' : (d.sort === 'size' ? 'name' : 'time');
        d.page = 1;
        renderDrive();
        loadDrive();
      };
    }

    var pager = document.querySelectorAll('#view [data-dpage]');
    for (var p = 0; p < pager.length; p++) {
      pager[p].onclick = function () {
        var dir = this.getAttribute('data-dpage');
        if (dir === 'prev' && d.page > 1) d.page--;
        if (dir === 'next' && d.page < d.pages) d.page++;
        renderDrive();
        loadDrive();
      };
    }

    var rows = document.querySelectorAll('#view .drow');
    for (var r = 0; r < rows.length; r++) {
      rows[r].onclick = function (ev) {
        var quick = ev && ev.target && ev.target.getAttribute && ev.target.getAttribute('data-dquick');
        var id = this.getAttribute('data-fid');
        var mode = this.getAttribute('data-mode');
        if (quick) {
          if (quick === 'trash') doDriveRestore(id);
          else if (quick === 'shares') doDriveCopyShare(id);
          else if (quick === 'off') doDriveOfflineShare(id);
          return;
        }
        if (mode === 'shares') return doDriveCopyShare(id);
        openDriveItem(id, mode);
      };
    }
  }

  /* ---------------- 文件详情与操作 ---------------- */

  function findDriveItem(id) {
    var d = D();
    for (var i = 0; i < d.items.length; i++) {
      if ((d.items[i].fileId || d.items[i].shareId) === id) return d.items[i];
    }
    return null;
  }

  function openDriveItem(id, mode) {
    var it = findDriveItem(id);
    if (!it) return;

    if (mode === 'trash') {
      var html = '<div class="d-detail">' +
        '<div class="d-detail-name">' + esc(it.name) + '</div>' +
        '<div class="d-detail-sub">' + esc(it.sizeText || '') + ' · 剩余 ' + (it.remainDays || 0) + ' 天后彻底删除</div>' +
        '<div class="set-warn">彻底删除后不可恢复，且无法再找回。</div>' +
        '</div>';
      openModal('回收站文件', html, function () {
        doDrivePurge(id);
      }, '彻底删除');
      return;
    }

    var body = '<div class="d-detail">';
    if (it.type === 'image') {
      body += '<img class="d-preview" src="' + esc(it.rawUrl) + '" alt="">';
    } else if (it.type === 'video') {
      body += '<video class="d-preview" src="' + esc(it.rawUrl) + '" controls></video>';
    } else if (it.type === 'audio') {
      body += '<audio style="width:100%" src="' + esc(it.rawUrl) + '" controls></audio>';
    } else {
      body += '<div class="d-detail-icon ' + 't-' + esc(it.type) + '">' + (DRIVE_ICON[it.type] || '📦') + '</div>';
    }
    body += '<div class="d-detail-name">' + esc(it.name) + '</div>';
    body += '<div class="d-detail-sub">' + esc(it.sizeText) + ' · ' + esc(it.typeLabel) +
      (it.fromChat && it.roomName ? ' · 来自 ' + esc(it.roomName) : '') +
      (it.folder ? ' · 📁 ' + esc(it.folder) : '') + '</div>';
    if (it.md5) body += '<div class="d-detail-md5">MD5：' + esc(it.md5) + '</div>';
    if (it.share) {
      body += '<div class="d-detail-share">已分享：' + (it.share.encrypted ? '提取码 ' + esc(it.share.code) : '公开') +
        ' · 下载 ' + (it.share.downloads || 0) + ' 次</div>';
    }
    body += '</div>';

    body += '<div class="d-acts">' +
      '<button class="btn ghost" id="dDownload">下载</button>' +
      '<button class="btn ghost" id="dRename">重命名</button>' +
      '<button class="btn ghost" id="dMove">移动</button>' +
      '<button class="btn ghost" id="dShare">分享</button>' +
      '<button class="btn danger" id="dDelete">删除</button>' +
      '</div>';

    openModal('文件', body, null, '关闭');

    $('dDownload').onclick = function () {
      closeModal();
      window.location.href = it.downloadUrl;
    };
    $('dRename').onclick = function () { closeModal(); doDriveRename(it); };
    $('dMove').onclick = function () { closeModal(); doDriveMove(it); };
    $('dShare').onclick = function () { closeModal(); doDriveShare(it); };
    $('dDelete').onclick = function () { closeModal(); doDriveDelete(it); };
  }

  function doDriveRename(it) {
    askInput('重命名', '新的文件名：', it.name || '', function (name) {
      name = String(name).trim();
      if (!name) { toast('文件名不能为空'); return false; }
      api('PATCH', '/api/drive/files/' + it.fileId, { name: name }, function (err) {
        if (err) { toast(err.message); return; }
        toast('已重命名');
        loadDrive();
      });
    }, '保存');
  }

  /** 新建目录：建完自动跳到该目录，方便立刻往里传/移文件 */
  function doDriveNewFolder() {
    askInput('新建目录', '目录名：', '', function (name) {
      name = String(name || '').trim();
      if (!name) { toast('目录名不能为空'); return false; }
      api('POST', '/api/drive/folders', { name: name }, function (err) {
        if (err) { toast(err.message); return; }
        toast('已创建目录');
        var d = D();
        d.folder = name;
        d.page = 1;
        renderDrive();
        loadDrive();
      });
    }, '创建');
  }

  function doDriveDeleteFolder(name) {
    if (!name) return;
    askConfirm('删除目录', '删除空目录「' + esc(name) + '」？<br>目录里还有文件时会提示先移走。', function () {
      api('DELETE', '/api/drive/folders/' + encodeURIComponent(name), null, function (err) {
        if (err) { toast(err.message); return; }
        toast('目录已删除');
        var d = D();
        if (d.folder === name) d.folder = null;
        renderDrive();
        loadDrive();
      });
    }, '删除');
  }

  /**
   * 移动文件：目录列表直接点选，比手打目录名可靠（旧版是输入框，容易打错建出重复目录）。
   * 需要新目录时在底部填名字，会先建目录再移动。
   */
  function doDriveMove(it) {
    var d = D();
    var folders = d.folders || [];
    var h = '<div class="d-form">' +
      '<label class="d-label">选择目录</label><div class="d-move-list">' +
      '<button class="d-move-item' + (!it.folder ? ' on' : '') + '" data-mv="">🏠 根目录</button>';
    for (var i = 0; i < folders.length; i++) {
      h += '<button class="d-move-item' + (it.folder === folders[i] ? ' on' : '') + '" data-mv="' + esc(folders[i]) + '">📁 ' + esc(folders[i]) + '</button>';
    }
    h += '</div>' +
      '<label class="d-label">或新建目录并移入</label>' +
      '<input id="dmNew" class="inp" type="text" placeholder="新目录名">' +
      '</div>';

    function moveTo(folder) {
      api('PATCH', '/api/drive/files/' + it.fileId, { folder: String(folder || '') }, function (err) {
        if (err) { toast(err.message); return; }
        toast(folder ? ('已移动到「' + folder + '」') : '已移到根目录');
        closeModal();
        loadDrive();
      });
    }

    openModal('移动文件', h, function () {
      var name = String($('dmNew').value || '').trim();
      if (!name) { toast('请选择目录，或填一个新目录名'); return false; }
      api('POST', '/api/drive/folders', { name: name }, function (err) {
        // 目录已存在不算失败，直接移进去
        if (err && !/已存在/.test(err.message || '')) { toast(err.message); return; }
        moveTo(name);
      });
    }, '移动');

    var items = document.querySelectorAll('#modalBody .d-move-item');
    for (var k = 0; k < items.length; k++) {
      items[k].onclick = function () { moveTo(this.getAttribute('data-mv') || ''); };
    }
  }

  function doDriveDelete(it) {
    askConfirm('移入回收站', '将「' + esc(it.name || '') + '」移入回收站？<br>30 天内可以恢复，之后自动彻底删除。', function () {
      api('DELETE', '/api/drive/files/' + it.fileId, null, function (err) {
        if (err) { toast(err.message); return; }
        toast('已移入回收站');
        loadDrive();
        loadDriveStorage();
      });
    }, '删除');
  }

  function doDriveRestore(id) {
    api('POST', '/api/drive/trash/' + id + '/restore', {}, function (err) {
      if (err) { toast(err.message); return; }
      toast('已恢复');
      loadDrive();
      loadDriveStorage();
    });
  }

  function doDrivePurge(id) {
    askConfirm('彻底删除', '彻底删除后不可恢复，确定吗？', function () {
      api('DELETE', '/api/drive/trash/' + id, null, function (err) {
        if (err) { toast(err.message); return; }
        toast('已彻底删除，空间已释放');
        loadDrive();
        loadDriveStorage();
      });
    }, '彻底删除');
  }

  /* ---------------- 分享 ---------------- */

  /** 分享文案：链接 + 提取码（有加密时） */
  function shareText(s) {
    var url = location.origin + (s.url || ('/s/' + s.shareId));
    return url + (s.encrypted ? ('\n提取码：' + s.code) : '');
  }

  /**
   * 已存在分享时的面板：直接给链接，不再让人重复「创建」。
   * 老版本的问题：点分享永远弹创建表单，明明已经分享过也看不出现有链接。
   */
  function showSharePanel(it, s) {
    var txt = shareText(s);
    var body = '<div class="d-share-out">' +
      '<div class="d-detail-name">' + esc(it.name) + '</div>' +
      '<div class="d-detail-sub">' + (s.encrypted ? '提取码 ' + esc(s.code) : '公开链接') +
      ' · 有效至 ' + fmtTimeShort(s.expireAt) + ' · 下载 ' + (s.downloads || 0) + ' 次</div>' +
      '<textarea class="inp d-share-url" readonly rows="3">' + esc(txt) + '</textarea>' +
      '<div class="d-detail-sub">链接已经在生效中，直接复制发出去即可；不想再被下载可随时「下线」。</div>' +
      '</div>' +
      '<div class="d-acts">' +
      '<button class="btn ghost" id="dsCopy">复制链接</button>' +
      '<button class="btn danger" id="dsOff">下线分享</button>' +
      '</div>';
    openModal('分享链接', body, null, '关闭');

    $('dsCopy').onclick = function () { copyText(txt); };
    $('dsOff').onclick = function () {
      askConfirm('下线分享', '下线后这个链接立刻失效，别人再打开会提示「已取消」。<br>确定现在就不再让别人下载吗？', function () {
        api('DELETE', '/api/drive/shares/' + s.shareId, null, function (err) {
          if (err) { toast(err.message); return; }
          toast('分享已下线');
          closeModal();
          loadDrive();
          if (D().tab === 'shares') loadDriveShares();
        });
      }, '下线');
    };
  }

  function doDriveShare(it) {
    // 已分享且未过期 → 直接显示现有链接（含提取码/下载次数/有效期），不重复创建
    if (it.share && it.share.shareId && !it.share.expired) {
      return showSharePanel(it, {
        shareId: it.share.shareId,
        url: '/s/' + it.share.shareId,
        code: it.share.code,
        encrypted: it.share.encrypted,
        expireAt: it.share.expireAt,
        downloads: it.share.downloads
      });
    }

    var body = '<div class="d-form">' +
      (it.share && it.share.expired ? '<div class="set-warn">上一次分享已过期，可重新创建。</div>' : '') +
      '<label class="d-label">有效期（天）</label>' +
      '<input id="dsDays" class="inp" type="number" min="1" max="365" value="7">' +
      '<label class="d-label"><input id="dsEnc" type="checkbox"> 需要提取码</label>' +
      '<input id="dsCode" class="inp" type="text" placeholder="提取码（留空自动生成）" maxlength="12">' +
      '</div>';
    openModal('创建分享', body, function () {
      var days = parseInt($('dsDays').value, 10) || 7;
      var enc = !!$('dsEnc').checked;
      var code = String($('dsCode').value || '').trim();
      api('POST', '/api/drive/files/' + it.fileId + '/share',
        { days: days, encrypted: enc, code: code }, function (err, data) {
          if (err) { toast(err.message); return; }
          showSharePanel(it, data);
          loadDrive();
        });
    }, '创建');
  }

  /** 下线分享（分享列表里的快捷操作） */
  function doDriveOfflineShare(shareId) {
    askConfirm('下线分享', '下线后链接立刻失效，确定吗？', function () {
      api('DELETE', '/api/drive/shares/' + shareId, null, function (err) {
        if (err) { toast(err.message); return; }
        toast('分享已下线');
        loadDriveShares();
      });
    }, '下线');
  }

  function doDriveCopyShare(shareId) {
    api('GET', '/api/drive/shares', null, function (err, data) {
      if (err) { toast(err.message); return; }
      var list = data.items || [];
      var s = null;
      for (var i = 0; i < list.length; i++) if (list[i].shareId === shareId) s = list[i];
      if (!s) { toast('分享不存在'); return; }
      var url = location.origin + s.url;
      copyText(url + (s.encrypted ? ('\n提取码：' + s.code) : ''));
    });
  }

  /* ---------------- 上传 ---------------- */

  function pickDriveUpload() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.onchange = function () {
      var files = inp.files;
      if (!files || !files.length) return;
      var arr = [];
      for (var i = 0; i < files.length; i++) arr.push(files[i]);
      driveUploadQueue(arr);
    };
    inp.click();
  }

  function driveUploadQueue(list) {
    var d = D();
    if (!list.length) return;
    // 配额预检：先拦一道，避免白传
    if (S.storage) {
      var sum = 0;
      for (var i = 0; i < list.length; i++) sum += list[i].size;
      if (sum > S.storage.remain) {
        toast('存储空间不足：剩余 ' + S.storage.remainText + '，本次共 ' + fmtSize(sum), 4500);
        return;
      }
    }
    var idx = 0;
    function next() {
      if (idx >= list.length) {
        d.uploadPct = -1;
        renderDrive();
        toast('上传完成');
        loadDrive();
        loadDriveStorage();
        return;
      }
      var f = list[idx++];
      driveUploadOne(f, function (ok) {
        if (!ok) { d.uploadPct = -1; renderDrive(); return; }
        next();
      });
    }
    next();
  }

  function driveUploadOne(file, cb) {
    var d = D();
    if (file.size > 200 * 1024 * 1024) { toast('「' + file.name + '」超过 200MB 上限'); cb(false); return; }
    d.uploadPct = 0;
    d.uploadText = '准备上传 ' + file.name;
    renderDrive();

    var resumeKey = 'll_drive_up_' + file.name + '_' + file.size;
    var resumeId = null;
    try { resumeId = localStorage.getItem(resumeKey); } catch (e) {}

    api('POST', '/api/files/init', {
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      roomId: '',                    // 不带房间 = 网盘文件
      resumeId: resumeId || undefined
    }, function (err, info) {
      if (err) { toast(err.message, 4500); cb(false); return; }
      try { localStorage.setItem(resumeKey, info.fileId); } catch (e) {}

      var chunkSize = info.chunkSize || 4194304;
      var total = info.totalChunks;
      var received = {};
      for (var i = 0; i < info.received.length; i++) received[info.received[i]] = 1;
      var cur = 0;

      function loop() {
        while (cur < total && received[cur]) cur++;
        if (cur >= total) return finish();

        var c = cur;
        var blob = file.slice(c * chunkSize, Math.min(file.size, (c + 1) * chunkSize));
        d.uploadText = '上传 ' + file.name + ' ' + (c + 1) + '/' + total + ' 片';
        d.uploadPct = Math.round(c / total * 100);
        var el = $('driveUpText');
        var fill = $('driveUpFill');
        if (el) el.textContent = d.uploadText;
        if (fill) fill.style.width = d.uploadPct + '%';

        apiFile('PUT', '/api/files/' + info.fileId + '/chunk?i=' + c, blob,
          function (loaded) {
            var pct = Math.min(99, Math.round(((c * chunkSize) + loaded) / file.size * 100));
            d.uploadPct = pct;
            var f2 = $('driveUpFill');
            if (f2) f2.style.width = pct + '%';
          },
          function (err2) {
            if (err2) { toast(err2.message, 4500); cb(false); return; }
            cur = c + 1;
            loop();
          });
      }

      function finish() {
        d.uploadText = '合并中…';
        d.uploadPct = 99;
        var el = $('driveUpText');
        if (el) el.textContent = d.uploadText;
        api('POST', '/api/files/' + info.fileId + '/complete', {}, function (err3, done) {
          if (err3) { toast(err3.message, 4500); cb(false); return; }
          if (done && done.storage) S.storage = done.storage;
          try { localStorage.removeItem(resumeKey); } catch (e) {}
          d.uploadPct = 100;
          cb(true);
        });
      }
      loop();
    });
  }

  /* ---------------- 启动 ---------------- */
  /**
   * WorkBuddy OAuth 回调：服务端把本地会话令牌放在地址栏的 wl_token 上。
   * 这里先把它收进本地存储并抹掉地址栏（避免令牌留在历史记录里），
   * 随后的 boot() 会走正常流程拉用户信息并进主界面。
   */
  function pickCallbackToken() {
    var search = '';
    try {
      search = (typeof location !== 'undefined' && location.search) ? String(location.search) : '';
    } catch (e) { search = ''; }
    var m = search.match(/[?&]wl_token=([^&]+)/);
    if (!m) return;
    var t = '';
    try { t = decodeURIComponent(m[1]); } catch (e2) { t = m[1]; }
    if (!t) return;
    S.token = t;
    localStorage.setItem('ll_token', t);
    try {
      if (typeof history !== 'undefined' && history.replaceState) {
        history.replaceState(null, '', (location.pathname || '/'));
      }
    } catch (e3) { /* 老内核不支持就算了 */ }
  }

  /** 反馈箱：普通用户看自己的反馈列表；官方账号看待处理审查与全部反馈 */
  function openFeedbackBox() {
    var isAdmin = S.user && (S.user.founder || S.user.master);
    if (isAdmin) {
      openAdminFeedbackBox();
      return;
    }
    var box = document.createElement('div');
    box.style.maxHeight = '56vh';
    box.style.overflow = 'auto';

    var loading = document.createElement('div');
    loading.className = 'empty';
    loading.textContent = '加载中…';
    box.appendChild(loading);

    api('GET', '/api/feedback/mine', null, function (err, d) {
      box.innerHTML = '';
      var list = (d && d.feedback) || [];

      // 提交新反馈按钮
      var top = document.createElement('div');
      top.style.marginBottom = '10px';
      var newBtn = document.createElement('button');
      newBtn.className = 'btn primary';
      newBtn.textContent = '＋ 提交新反馈';
      newBtn.onclick = function () { openFeedbackForm(box); };
      top.appendChild(newBtn);
      box.appendChild(top);

      if (!list.length) {
        var emp = document.createElement('div');
        emp.className = 'empty';
        emp.textContent = '你还没有提交过反馈。遇到问题或有好主意？点上方按钮提交。';
        box.appendChild(emp);
        return;
      }

      for (var i = 0; i < list.length; i++) {
        var f = list[i];
        var card = document.createElement('div');
        card.style.cssText = 'padding:10px 0;border-bottom:1px solid var(--border-2);';

        var head = document.createElement('div');
        head.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;';
        var badge = document.createElement('span');
        badge.className = 'badge ' + (f.type === 'idea' ? 'ok' : f.type === 'complaint' ? 'warn' : 'gray');
        badge.textContent = f.type === 'idea' ? '建议' : f.type === 'complaint' ? '举报' : '问题';
        head.appendChild(badge);
        var st = document.createElement('span');
        st.className = 'badge ' + (f.status === 'replied' ? 'ok' : 'gray');
        st.textContent = f.status === 'replied' ? '已回复' : '处理中';
        head.appendChild(st);
        if (f.status === 'replied' && !f.seenAt) {
          var dot = document.createElement('span');
          dot.className = 'req-dot on';
          head.appendChild(dot);
        }
        card.appendChild(head);

        var t = document.createElement('div');
        t.style.cssText = 'font-weight:600;font-size:13.5px;margin-bottom:3px;';
        t.textContent = f.title || '无标题';
        card.appendChild(t);

        var c = document.createElement('div');
        c.style.cssText = 'font-size:12.5px;color:var(--fg-2);line-height:1.6;margin-bottom:4px;';
        c.textContent = f.content || '';
        card.appendChild(c);

        if (f.reply) {
          var r = document.createElement('div');
          r.style.cssText = 'background:var(--bg-2);padding:8px 10px;border-radius:6px;font-size:12.5px;color:var(--fg-2);line-height:1.6;';
          r.innerHTML = '<b>官方回复：</b>' + esc(f.reply);
          card.appendChild(r);
          if (!f.seenAt) {
            api('POST', '/api/feedback/' + f.id + '/seen', {}, function () {});
          }
        }

        box.appendChild(card);
      }
    });

    openModal('反馈箱', box, null, '关闭');
  }

  /** 官方反馈中心：待处理审查 + 全部反馈 */
  function openAdminFeedbackBox() {
    var box = document.createElement('div');
    box.style.maxHeight = '56vh';
    box.style.overflow = 'auto';
    var loading = document.createElement('div');
    loading.className = 'empty';
    loading.textContent = '加载中…';
    box.appendChild(loading);

    // 同时拉 reviews 和 feedback
    var reviewsData = null, feedbackData = null;
    function tryRender() {
      if (!reviewsData || !feedbackData) return;
      box.innerHTML = '';

      var pending = (reviewsData.list || []).filter(function (r) { return r.status === 'pending'; });
      var openFb = (feedbackData.feedback || []).filter(function (f) { return f.status === 'open'; });

      // 顶部统计
      var stat = document.createElement('div');
      stat.style.cssText = 'display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;';
      stat.innerHTML = '<span class="badge warn">待处理审查 ' + pending.length + '</span>' +
        '<span class="badge gray">待回复反馈 ' + openFb.length + '</span>';
      box.appendChild(stat);

      // 审查列表
      if (pending.length) {
        var rh = document.createElement('div');
        rh.style.cssText = 'font-weight:600;font-size:14px;margin:8px 0 4px;color:var(--accent);';
        rh.textContent = '待处理审查';
        box.appendChild(rh);
        for (var i = 0; i < pending.length; i++) {
          var r = pending[i];
          var rc = document.createElement('div');
          rc.style.cssText = 'padding:10px 0;border-bottom:1px solid var(--border-2);';
          var rt = document.createElement('div');
          rt.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:3px;';
          rt.textContent = (r.kind === 'image' ? '【图片审核】' : '【举报】') +
            (r.targetType === 'message' ? '消息' : r.targetType === 'file' ? '文件' : '内容');
          rc.appendChild(rt);
          var rd = document.createElement('div');
          rd.style.cssText = 'font-size:12px;color:var(--fg-2);line-height:1.6;margin-bottom:6px;';
          rd.textContent = '理由：' + (r.reason || '系统自动标记') +
            ' | 剩余 ' + Math.ceil((r.remainMs || 0) / 60000) + ' 分钟';
          rc.appendChild(rd);
          var rb = document.createElement('div');
          rb.style.cssText = 'display:flex;gap:8px;';
          var delBtn = document.createElement('button');
          delBtn.className = 'btn small danger';
          delBtn.textContent = '确认违规 · 删除';
          delBtn.onclick = (function (id) {
            return function () {
              api('POST', '/api/reviews/' + id + '/confirm', {}, function (err) {
                if (err) { toast(err.message || '操作失败'); return; }
                toast('已确认违规并删除');
                openAdminFeedbackBox();
              });
            };
          })(r.id);
          rb.appendChild(delBtn);
          var keepBtn = document.createElement('button');
          keepBtn.className = 'btn small ghost';
          keepBtn.textContent = '确认无害 · 保留';
          keepBtn.onclick = (function (id) {
            return function () {
              api('POST', '/api/reviews/' + id + '/clear', {}, function (err) {
                if (err) { toast(err.message || '操作失败'); return; }
                toast('已确认无害');
                openAdminFeedbackBox();
              });
            };
          })(r.id);
          rb.appendChild(keepBtn);
          rc.appendChild(rb);
          box.appendChild(rc);
        }
      }

      // 反馈列表
      if (openFb.length) {
        var fh = document.createElement('div');
        fh.style.cssText = 'font-weight:600;font-size:14px;margin:8px 0 4px;color:var(--accent);';
        fh.textContent = '待回复反馈';
        box.appendChild(fh);
        for (var j = 0; j < openFb.length; j++) {
          var f = openFb[j];
          var fc = document.createElement('div');
          fc.style.cssText = 'padding:10px 0;border-bottom:1px solid var(--border-2);';
          var ft = document.createElement('div');
          ft.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:3px;';
          ft.textContent = (f.title || '无标题') + ' · ' + (f.type === 'idea' ? '建议' : f.type === 'complaint' ? '举报' : '问题');
          fc.appendChild(ft);
          var fc2 = document.createElement('div');
          fc2.style.cssText = 'font-size:12px;color:var(--fg-2);line-height:1.6;margin-bottom:6px;';
          fc2.textContent = f.content || '';
          fc.appendChild(fc2);
          var fb = document.createElement('div');
          fb.style.cssText = 'display:flex;gap:8px;';
          var replyBtn = document.createElement('button');
          replyBtn.className = 'btn small primary';
          replyBtn.textContent = '回复';
          replyBtn.onclick = (function (fid) {
            return function () {
              askInput('回复反馈', '回复内容', '', function (text) {
                if (!text.trim()) { toast('回复不能为空'); return false; }
                api('POST', '/api/feedback/' + fid + '/reply', { reply: text.trim() }, function (err) {
                  if (err) { toast(err.message || '回复失败'); return; }
                  toast('已回复');
                  openAdminFeedbackBox();
                });
              }, '发送');
            };
          })(f.id);
          fb.appendChild(replyBtn);
          fc.appendChild(fb);
          box.appendChild(fc);
        }
      }

      if (!pending.length && !openFb.length) {
        var emp = document.createElement('div');
        emp.className = 'empty';
        emp.textContent = '暂无待处理事项。';
        box.appendChild(emp);
      }
    }

    api('GET', '/api/reviews', null, function (err, d) {
      reviewsData = d || { list: [] };
      tryRender();
    });
    api('GET', '/api/feedback', null, function (err, d) {
      feedbackData = d || { feedback: [] };
      tryRender();
    });

    openModal('官方反馈中心', box, null, '关闭');
  }

  /** 反馈箱内：提交新反馈的表单 */
  function openFeedbackForm(container) {
    var idT = 'fbTitle_' + (++askSeq);
    var idC = 'fbBody_' + (++askSeq);
    var idType = 'fbType_' + (++askSeq);
    var body = document.createElement('div');

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;margin-bottom:10px;';
    var types = [
      { v: 'bug', l: '问题反馈' },
      { v: 'idea', l: '功能建议' }
    ];
    for (var i = 0; i < types.length; i++) {
      (function (tp) {
        var b = document.createElement('button');
        b.className = 'btn ghost';
        b.textContent = tp.l;
        b.onclick = function () {
          var hid = document.getElementById(idType);
          if (hid) hid.value = tp.v;
          var all = row.querySelectorAll('button');
          for (var j = 0; j < all.length; j++) {
            all[j].className = all[j].className.replace(/primary/g, 'ghost');
          }
          b.className = 'btn primary';
        };
        row.appendChild(b);
      })(types[i]);
    }
    body.appendChild(row);

    var hid = document.createElement('input');
    hid.type = 'hidden';
    hid.id = idType;
    hid.value = 'bug';
    body.appendChild(hid);

    var ti = document.createElement('input');
    ti.className = 'ask-field';
    ti.id = idT;
    ti.type = 'text';
    ti.placeholder = '标题（简短描述问题）';
    ti.style.marginBottom = '8px';
    body.appendChild(ti);

    var ta = document.createElement('textarea');
    ta.className = 'ask-field';
    ta.id = idC;
    ta.rows = 4;
    ta.placeholder = '详细描述你遇到的问题或建议…';
    body.appendChild(ta);

    openModal('提交反馈', body, function () {
      var title = String(ti.value || '').trim();
      var content = String(ta.value || '').trim();
      var type = String(hid.value || 'bug');
      if (!title) { toast('请填写标题'); return false; }
      if (!content) { toast('请填写内容'); return false; }
      api('POST', '/api/feedback', { type: type, title: title, content: content }, function (err) {
        if (err) { toast(err.message || '提交失败', 3000); return; }
        toast('反馈已提交');
        openFeedbackBox(); // 刷新列表
      });
    }, '提交');
    setTimeout(function () { if (ti.focus) ti.focus(); }, 30);
  }

  function boot() {
    // 字体属于纯本机外观偏好，登录页也要生效，因此不放在 enterApp() 里
    fontApply(S.font);
    pickCallbackToken();
    if (!S.token) return;
    api('GET', '/api/me', null, function (err, data) {
      if (err) {
        localStorage.removeItem('ll_token');
        S.token = '';
        return;
      }
      S.user = data.user;
      enterApp();
      loadFriends();
    });
  }
  boot();
})();
