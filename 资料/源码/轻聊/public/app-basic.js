/* 轻聊 · 基础版前端（第三档，最保守实现）
 *
 * 目标设备：红米 Note 2 一类 Android 5.x + Chromium 37/39 的老 WebView，
 *           以及任何连低配版都跑不起来的更老内核。
 *
 * 与低配版（app-lite.js）的区别 —— 这里放弃了所有「可能有坑」的能力：
 *   ✗ 不用 position: fixed（老 WebView 的重绘 bug 会让固定层错位/点不到）
 *   ✗ 不用 xhr.timeout（老内核上赋值可能抛异常，改用 setTimeout 手动超时）
 *   ✗ 不用 FileReader / Blob 切片（上传直接 xhr.send(File)，单请求发完）
 *   ✗ 不用 Array.prototype.forEach/map/filter/indexOf（全部手写 for 循环）
 *   ✗ 不用 String.prototype.trim / Date.now / Object.keys / classList
 *   ✗ 不用弹层遮罩（改用 window.confirm / prompt 与内联面板）
 *   ✗ 不用 localStorage 作为唯一凭证（cookie 双写，谁可用用谁）
 *
 * 仍然完整的核心功能：
 *   登录 / 注册（含权限密钥）、房间列表、进出房间、消息收发与轮询、
 *   文件上传与下载、全局昵称、群内昵称、成员管理、设继承人、转让、解散、
 *   系统通知、云网盘（列表 / 搜索 / 下载 / 删除 / 回收站）、配额展示、注销账号。
 * 调用的 /api/* 与标准版完全一致，数据天然互通。
 */
(function () {
  'use strict';

  var LL = {};
  window.LL = LL;

  /* 诊断日志：只有 ?debug=1 时才记录。
     真机上排查「卡在哪一步」非常有用 —— 打开 ?debug=1 再点「设备自检」，
     就能看到执行到哪一步停下。默认零开销、零输出。 */
  var DEBUG = false;
  try { DEBUG = String(location.search || '').indexOf('debug=1') >= 0; } catch (e) { }
  function log(s) {
    if (!DEBUG) return;
    try {
      if (window.__LL) {
        if (!window.__LL.log) window.__LL.log = [];
        if (window.__LL.log.length < 120) window.__LL.log.push(String(s));
      }
      if (window.console && console.log) console.log('[LL] ' + s);
    } catch (e2) { }
  }

  /* ================================================================
   * 一、最基础的工具（全部 ES3）
   * ================================================================ */

  function $(id) { return document.getElementById(id); }

  function show(el, on) {
    if (!el) return;
    el.style.display = on ? 'block' : 'none';
  }
  function showId(id, on) { show($(id), on); }

  function setText(el, s) {
    if (!el) return;
    var v = (s === undefined || s === null) ? '' : String(s);
    try { el.textContent = v; } catch (e) { el.innerHTML = esc(v); }
  }

  /* 手写 trim：不用 String.prototype.trim（ES5，老内核偶有缺失） */
  function trim(s) {
    s = (s === undefined || s === null) ? '' : String(s);
    return s.replace(/^[\s\u00a0\u3000]+|[\s\u00a0\u3000]+$/g, '');
  }

  function esc(s) {
    s = (s === undefined || s === null) ? '' : String(s);
    s = s.replace(/&/g, '&amp;');
    s = s.replace(/</g, '&lt;');
    s = s.replace(/>/g, '&gt;');
    s = s.replace(/"/g, '&quot;');
    s = s.replace(/'/g, '&#39;');
    return s;
  }

  function num(v) {
    var n = parseInt(v, 10);
    return isNaN(n) ? 0 : n;
  }

  function fmtSize(b) {
    b = num(b);
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }

  function fmtTime(ts) {
    var d = new Date(num(ts));
    var mo = d.getMonth() + 1;
    var dd = d.getDate();
    var hh = d.getHours();
    var mi = d.getMinutes();
    return (mo < 10 ? '0' + mo : '' + mo) + '-' + (dd < 10 ? '0' + dd : '' + dd) +
      ' ' + (hh < 10 ? '0' + hh : '' + hh) + ':' + (mi < 10 ? '0' + mi : '' + mi);
  }

  /* 与其它两版同一套算法：由 id 算出稳定色相，保证同一个人颜色一致 */
  function hueOf(s) {
    s = String(s || '');
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffff;
    return h % 360;
  }
  function avatarStyle(id) {
    return 'background:hsl(' + hueOf(id) + ',48%,48%)';
  }
  function initialOf(s) {
    s = String(s || '?');
    return s.charAt(0).toUpperCase();
  }

  function toast(msg) {
    var el = $('upHint');
    if (el) {
      setText(el, msg);
      try { clearTimeout(el._t); } catch (e) { }
      el._t = setTimeout(function () { setText(el, ''); }, 3200);
    } else {
      try { alert(msg); } catch (e2) { }
    }
  }

  /* ================================================================
   * 二、Token 存储：localStorage 优先，cookie 兜底
   *     老容器常把 DOM Storage 关掉，只信 localStorage 会直接失联。
   * ================================================================ */

  var TK = 'll_token';

  function cookieGet(n) {
    try {
      var s = '; ' + String(document.cookie || '');
      var i = s.indexOf('; ' + n + '=');
      if (i < 0) return '';
      var v = s.substring(i + n.length + 3);
      var j = v.indexOf(';');
      if (j >= 0) v = v.substring(0, j);
      try { return decodeURIComponent(v); } catch (e) { return v; }
    } catch (e2) { return ''; }
  }
  function cookieSet(n, v) {
    try {
      document.cookie = n + '=' + encodeURIComponent(v) + '; path=/; max-age=2592000';
    } catch (e) { }
  }
  function cookieDel(n) {
    try { document.cookie = n + '=; path=/; max-age=0'; } catch (e) { }
  }

  function readToken() {
    var v = '';
    try { v = window.localStorage.getItem(TK) || ''; } catch (e) { }
    if (!v) v = cookieGet(TK);
    return v;
  }
  function saveToken(v) {
    try { window.localStorage.setItem(TK, v); } catch (e) { }
    cookieSet(TK, v);
  }
  function clearToken() {
    try { window.localStorage.removeItem(TK); } catch (e) { }
    cookieDel(TK);
  }

  /* ================================================================
   * 三、HTTP：只走 XHR + onreadystatechange
   * ================================================================ */

  /* 线上发布平台首次导航会校验 sharecode，同源请求也显式带上更稳 */
  function withShare(path) {
    try {
      var m = String(location.search || '').match(/[?&](sharecode=[^&]+)/);
      if (!m || String(path).indexOf('/api/') !== 0) return path;
      return path + (path.indexOf('?') >= 0 ? '&' : '?') + m[1];
    } catch (e) { return path; }
  }

  function timeoutOf(method) {
    return (method === 'PUT' || method === 'POST') ? 120000 : 45000;
  }

  function api(method, path, body, cb) {
    var xhr = null;
    try { xhr = new XMLHttpRequest(); } catch (e) { xhr = null; }
    if (!xhr) { cb(new Error('此浏览器不支持 XMLHttpRequest')); return; }

    var full = withShare(path);
    try { xhr.open(method, full, true); }
    catch (e2) { cb(new Error('请求被拒绝：' + (e2 && e2.message))); return; }

    try { if (S.token) xhr.setRequestHeader('X-Token', S.token); } catch (e3) { }

    var payload = null;
    if (body !== null && body !== undefined) {
      try { xhr.setRequestHeader('Content-Type', 'application/json'); } catch (e4) { }
      try { payload = JSON.stringify(body); }
      catch (e5) { cb(new Error('数据序列化失败')); return; }
    }

    var settled = 0;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = 1;
      try { xhr.abort(); } catch (e6) { }
      cb(new Error('请求超时（网络很慢或已断开）'));
    }, timeoutOf(method));

    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (settled) return;
      settled = 1;
      try { clearTimeout(timer); } catch (e7) { }

      var raw = '';
      try { raw = xhr.responseText || ''; } catch (e8) { raw = ''; }
      var data = null;
      try { data = JSON.parse(raw); } catch (e9) { data = null; }

      if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) {
        cb(null, data);
        return;
      }
      var msg;
      if (data && data.error) msg = data.error;
      else if (raw) msg = '请求失败(' + xhr.status + ')：' + raw.substring(0, 60);
      else msg = '请求失败(' + xhr.status + ')';
      cb(new Error(msg), data);
    };

    try { xhr.send(payload); }
    catch (e10) {
      if (!settled) { settled = 1; cb(new Error('发送失败：' + (e10 && e10.message))); }
    }
  }

  /* ================================================================
   * 四、状态
   * ================================================================ */

  function startView() {
    try {
      var m = String(location.search || '').match(/[?&]view=(public|rooms|friends|me|drive)/);
      if (m) return m[1];
    } catch (e) { }
    return 'rooms';
  }

  var S = {
    token: readToken(),
    user: null,
    view: startView(),
    rooms: [],
    publicRoomId: '',
    room: null,          /* 当前房间（含 canPost / dissolved） */
    lastSeq: 0,
    msgs: [],            /* 当前房间已渲染的消息（用于增量追加） */
    authMode: 'login',   /* login | reg */
    storage: null,
    driveTab: 'files',
    driveKeyword: '',
    drivePage: 1,
    driveFolder: null,      /* null=全部目录；''=根目录 */
    driveUpBusy: false,
    pollTimer: null,
    version: null
  };
  LL.S = S;

  /* ================================================================
   * 五、切屏
   * ================================================================ */

  function screen(name) {
    showId('scrAuth', name === 'auth');
    showId('scrMain', name === 'main');
    showId('scrChat', name === 'chat');
    try { window.scrollTo(0, 0); } catch (e) { }
  }

  function toastEl(msg, kind) {
    var box = $('chTip');
    if (!box) return;
    var cls = kind === 'ok' ? 'okbar' : 'tipbar';
    box.innerHTML = msg ? '<div class="' + cls + '">' + msg + '</div>' : '';
  }

  /* ================================================================
   * 六、登录 / 注册
   * ================================================================ */

  LL.setMode = function (mode) {
    S.authMode = (mode === 'reg') ? 'reg' : 'login';
    $('tabLogin').className = S.authMode === 'login' ? 'on' : '';
    $('tabReg').className = S.authMode === 'reg' ? 'on' : '';
    showId('rowNick', S.authMode === 'reg');
    setText($('btnAuth'), S.authMode === 'login' ? '登 录' : '注 册');
    setText($('authErr'), '');
  };

  LL.doAuth = function () {
    var u = trim($('inUser').value);
    var p = String($('inPass').value || '');
    var nk = trim($('inNick').value);
    var key = trim($('inKey').value);
    setText($('authErr'), '');

    if (!u || !p) { setText($('authErr'), '请填写账号和密码'); return; }
    if (u.length < 2 || u.length > 20) { setText($('authErr'), '账号需 2-20 位'); return; }
    if (p.length < 6) { setText($('authErr'), '密码至少 6 位'); return; }

    var body = { username: u, password: p };
    if (S.authMode === 'reg') body.nickname = nk;
    if (key) body.permKey = key;

    var btn = $('btnAuth');
    btn.disabled = true;
    setText($('authErr'), '正在连接…');

    api('POST', S.authMode === 'reg' ? '/api/register' : '/api/login', body, function (err, d) {
      btn.disabled = false;
      if (err) {
        setText($('authErr'), err.message || '登录失败');
        return;
      }
      setText($('authErr'), '');
      onAuth(d);
    });
  };

  function onAuth(d) {
    S.token = d.token;
    saveToken(S.token);
    S.user = d.user;
    setText($('hdUser'), S.user.nickname || S.user.username);
    if (d.user && d.user.master) {
      try { alert('最高权限已激活（30 分钟）'); } catch (e) { }
    }
    screen('main');
    loadRooms(function () {
      LL.go(S.view);
    });
    startPoll();
  }

  /* ================================================================
   * 七、导航
   * ================================================================ */

  var NAVS = {
    public: 'nvPublic', rooms: 'nvRooms', friends: 'nvFriends',
    drive: 'nvDrive', me: 'nvMe'
  };
  var TITLES = {
    public: '公共聊天室', rooms: '我的房间', friends: '好友',
    drive: '云网盘', me: '我的'
  };

  function markNav(v) {
    for (var k in NAVS) {
      if (!NAVS.hasOwnProperty(k)) continue;
      var el = $(NAVS[k]);
      if (el) el.className = 'nv' + (k === v ? ' on' : '');
    }
  }

  LL.go = function (v) {
    log('go(' + v + ')');
    S.view = v;
    markNav(v);
    screen('main');
    setText($('hdTitle'), TITLES[v] || '轻聊');

    if (v === 'public') {
      if (!S.publicRoomId) {
        loadRooms(function () { LL.openRoom(S.publicRoomId); });
      } else {
        LL.openRoom(S.publicRoomId);
      }
      return;
    }
    if (v === 'rooms') { loadRooms(renderRooms); return; }
    if (v === 'friends') { loadFriends(); return; }
    if (v === 'drive') { loadDrive(); return; }
    renderMe();
  };

  LL.back = function () {
    if (S.room) closeRoom();
    LL.go('rooms');
  };

  LL.toBottom = function () {
    try { window.scrollTo(0, document.body.scrollHeight || 999999); } catch (e) { }
  };

  /* ================================================================
   * 八、房间列表
   * ================================================================ */

  function loadRooms(cb) {
    api('GET', '/api/rooms', null, function (err, d) {
      if (err) {
        if (cb) cb(err);
        return;
      }
      S.rooms = d.rooms || [];
      S.publicRoomId = d.publicRoomId || '';
      if (cb) cb(null);
    });
  }

  function renderRooms() {
    var h = '<div class="card"><div class="ch">全部房间（' + S.rooms.length + '）</div><div class="cb">';
    if (!S.rooms.length) {
      h += '<div class="empty">还没有房间</div>';
    } else {
      for (var i = 0; i < S.rooms.length; i++) {
        var r = S.rooms[i];
        var kindTxt = r.kind === 'public' ? '公共' : (r.kind === 'group' ? '群聊' : '私聊');
        h += '<div class="line' + (i === S.rooms.length - 1 ? ' last' : '') + '">' +
          '<div class="lm"><div class="lt">' + esc(r.name) + '</div>' +
          '<div class="ls">' + kindTxt + ' · ' + num(r.memberCount) + ' 人' +
          (r.dissolved ? ' · 已解散' : '') + (r.joined ? '' : ' · 未加入') + '</div></div>' +
          '<div class="lr"><button class="bt sm bg" onclick="LL.openRoom(\'' + esc(r.id) + '\')">进入</button></div>' +
          '</div>';
      }
    }
    h += '</div></div>';
    h += '<div class="card"><div class="cb">' +
      '<button class="bt bp full" onclick="LL.newRoom()">＋ 新建群聊</button></div></div>';
    $('view').innerHTML = h;
  }

  LL.newRoom = function () {
    var name = window.prompt('新群聊名称（最多 40 字）：', '');
    if (name === null) return;
    name = trim(name);
    if (!name) return;
    api('POST', '/api/rooms', { name: name }, function (err, d) {
      if (err) { alert('创建失败：' + err.message); return; }
      alert('已创建：' + d.room.name);
      loadRooms(renderRooms);
    });
  };

  /* ================================================================
   * 九、聊天
   * ================================================================ */

  /* 进房间：直接复用 /api/rooms 列表里已有的房间信息。
     服务端**没有** GET /api/rooms/:id 这个路由（只有列表、成员、消息三个），
     之前误调它拿到 404，还会弹 alert 把页面卡住 —— 这里不再发无效请求。
     房间的实时状态（canPost / muted / dissolved）由 messages 接口随消息下发。 */
  LL.openRoom = function (id, nameHint) {
    if (!id) return;
    var room = null;
    for (var i = 0; i < S.rooms.length; i++) {
      if (S.rooms[i].id === id) { room = S.rooms[i]; break; }
    }
    if (!room) {
      room = { id: id, name: nameHint || '房间', kind: 'group', joined: true, memberCount: 0 };
    }
    log('openRoom ' + id + ' kind=' + room.kind + ' joined=' + room.joined);

    S.room = room;
    S.lastSeq = 0;
    S.msgs = [];
    setText($('chTitle'), room.name || '房间');
    screen('chat');
    updateComposer();

    /* 未加入的群先自动加入（公共大厅不需要） */
    if (!room.joined && room.kind !== 'public') {
      api('POST', '/api/rooms/' + encodeURIComponent(id) + '/join', {}, function (err) {
        if (err) { alert('加入房间失败：' + err.message); return; }
        pull(true);
      });
    } else {
      pull(true);
    }
    startPoll();
  };

  function closeRoom() {
    S.room = null;
    S.msgs = [];
    S.lastSeq = 0;
    setText($('chMsgs'), '');
  }

  function msgHtml(m) {
    if (m.kind === 'system') {
      return '<div class="msys">' + esc(m.content) + '</div>';
    }
    var nam = m.senderName || m.senderUsername || '某人';
    var h = '<div class="mrow">' +
      '<div class="mav" style="' + avatarStyle(m.senderId) + '">' + esc(initialOf(nam)) + '</div>' +
      '<div class="mbody">' +
      '<div class="mwho">' + esc(nam) + (m.mine ? '（我）' : '') + '</div>';

    if (m.recalled) {
      h += '<div class="mtxt" style="color:#8c949f">该消息已撤回</div>';
    } else if (m.kind === 'file' && m.file) {
      h += '<div class="mtxt">' + esc(m.content || '') + '</div>' +
        '<a class="mfile" href="' + esc(m.file.dlUrl) + '">📎 ' + esc(m.file.name) +
        '（' + fmtSize(m.file.size) + '）点击下载</a>';
    } else {
      h += '<div class="mtxt">' + esc(m.content) + '</div>';
    }

    h += '<div class="mmeta">' + fmtTime(m.createdAt);
    if (m.mine && !m.recalled) {
      h += ' · <a href="javascript:LL.msgAct(\'' + esc(m.id) + '\')">操作</a>';
    }
    h += '</div></div></div>';
    return h;
  }

  /* 拉取消息；full=true 表示重头拉（重新进入房间） */
  function pull(full) {
    if (!S.room) return;
    var since = full === true ? 0 : S.lastSeq;
    var url = '/api/rooms/' + encodeURIComponent(S.room.id) + '/messages?since=' + num(since) + '&limit=120';

    log('pull since=' + since);
    api('GET', url, null, function (err, d) {
      log('messages 返回 ' + (err ? 'err ' + err.message : 'ok ' + ((d.messages || []).length) + ' 条'));
      if (err) {
        if (full === true) setText($('chMsgs'), '加载失败：' + err.message);
        return;
      }
      if (full === true) S.msgs = [];

      var arr = d.messages || [];
      var html = '';
      for (var i = 0; i < arr.length; i++) {
        S.msgs.push(arr[i]);
        html += msgHtml(arr[i]);
      }
      if (full === true) {
        $('chMsgs').innerHTML = html || '<div class="empty">还没有消息，说一句试试</div>';
      } else if (html) {
        $('chMsgs').innerHTML += html;
      }

      S.lastSeq = num(d.lastSeq) || S.lastSeq;

      /* 房间状态（是否可发、是否已解散）随消息一起下发 */
      if (S.room) {
        S.room.canPost = d.canPost;
        S.room.dissolved = !!d.dissolved;
        S.room.joined = !!d.joined;
        S.room.role = d.role;
      }
      updateComposer();
      if (full === true) LL.toBottom();
    });
  }

  function updateComposer() {
    var inp = $('inMsg');
    if (!inp || !S.room) return;
    if (S.room.dissolved) {
      inp.disabled = true;
      inp.value = '';
      try { inp.setAttribute('placeholder', '该群已解散，仅可查看历史消息'); } catch (e) { }
      toastEl('该群聊已解散，当前只能查看历史消息与解散通知', 'tip');
    } else if (S.room.canPost === false) {
      inp.disabled = true;
      try { inp.setAttribute('placeholder', '当前不可发言（可能被禁言或未加入）'); } catch (e2) { }
      toastEl('你当前不能在本房间发言', 'tip');
    } else {
      inp.disabled = false;
      try { inp.setAttribute('placeholder', '说点什么…'); } catch (e3) { }
      toastEl('', 'tip');
    }
  }

  LL.send = function () {
    if (!S.room) return;
    var inp = $('inMsg');
    var txt = trim(inp.value);
    if (!txt) return;
    inp.disabled = true;
    api('POST', '/api/rooms/' + encodeURIComponent(S.room.id) + '/messages',
      { kind: 'text', content: txt }, function (err) {
        inp.disabled = false;
        if (err) { alert('发送失败：' + err.message); return; }
        inp.value = '';
        pull(false);
        setTimeout(function () { LL.toBottom(); }, 120);
      });
  };

  LL.msgAct = function (id) {
    var act = window.prompt('输入数字选择操作：\n1 = 撤回（2 分钟内）\n2 = 仅自己删除\n3 = 彻底删除（所有人可见范围消失）', '1');
    if (act === null) return;
    act = trim(act);
    var path = '';
    if (act === '1') path = '/recall';
    else if (act === '2') path = '/delete';
    else if (act === '3') {
      if (!window.confirm('彻底删除后所有设备都会消失，且不可恢复。确定吗？')) return;
      path = '/purge';
    } else return;

    api('POST', '/api/messages/' + encodeURIComponent(id) + path, {}, function (err) {
      if (err) { alert('操作失败：' + err.message); return; }
      pull(true);
    });
  };

  /* 键回车发送 */
  function bindKeys() {
    var inp = $('inMsg');
    if (inp) {
      inp.onkeydown = function (e) {
        var k = e ? (e.keyCode || e.which) : 0;
        if (k === 13) { LL.send(); if (e && e.preventDefault) e.preventDefault(); return false; }
        return true;
      };
    }
  }

  /* ================================================================
   * 十、文件上传（单片直传，不用 FileReader / Blob 切片）
   * ================================================================ */

  function bindFile() {
    var fi = $('inFile');
    if (!fi) return;
    fi.onchange = function () {
      var f = (this.files && this.files[0]) ? this.files[0] : null;
      if (!f) return;
      doUpload(f);
      try { this.value = ''; } catch (e) { }
    };
  }

  var CHUNK_GUESS = 4 * 1024 * 1024;   /* 与服务端 CHUNK_SIZE 一致 */

  function doUpload(file) {
    if (!S.room) { alert('请先进入一个房间'); return; }
    if (num(file.size) > CHUNK_GUESS) {
      alert('单次上传上限 ' + fmtSize(CHUNK_GUESS) + '（这个文件 ' + fmtSize(file.size) + '），文件过大，请换小一点的文件。');
      return;
    }
    setText($('upHint'), '正在上传：' + file.name + ' …');

    api('POST', '/api/files/init', {
      name: file.name,
      size: num(file.size),
      mime: file.type || 'application/octet-stream',
      roomId: S.room.id
    }, function (err, d) {
      if (err) {
        setText($('upHint'), '');
        alert('上传失败：' + err.message);
        return;
      }
      if (num(d.totalChunks) > 1) {
        setText($('upHint'), '');
        alert('该文件过大，当前版本不支持分片上传，请换小一点的文件');
        return;
      }
      putSingleChunk(d.fileId, file);
    });
  }

  /* 单片：直接 xhr.send(File)，交给浏览器原生流式处理。
     老内核若不允许发 File，退回 FileReader 读成 ArrayBuffer 再发。 */
  function putSingleChunk(fileId, file) {
    var url = withShare('/api/files/' + encodeURIComponent(fileId) + '/chunk?i=0');

    function finish(okFlag, why) {
      if (!okFlag) {
        setText($('upHint'), '');
        alert('上传失败：' + why);
        return;
      }
      api('POST', '/api/files/' + encodeURIComponent(fileId) + '/complete', {}, function (e2, d2) {
        if (e2) {
          setText($('upHint'), '');
          alert('上传收尾失败：' + e2.message);
          return;
        }
        setText($('upHint'), '');
        /* 上传完成后把文件作为消息发出去 */
        api('POST', '/api/rooms/' + encodeURIComponent(S.room.id) + '/messages',
          { kind: 'file', fileId: fileId, content: file.name }, function (e3) {
            if (e3) { alert('文件已上传，但消息发送失败：' + e3.message); return; }
            pull(false);
            setTimeout(function () { LL.toBottom(); }, 120);
          });
      });
    }

    function sendWith(payload, isFileObj) {
      var xhr = null;
      try { xhr = new XMLHttpRequest(); } catch (e) { xhr = null; }
      if (!xhr) { finish(false, '不支持上传'); return; }
      try { xhr.open('PUT', url, true); }
      catch (e2) { finish(false, '无法发起上传'); return; }
      try {
        xhr.setRequestHeader('X-Token', S.token);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      } catch (e3) { }

      var done = 0;
      var timer = setTimeout(function () {
        if (done) return;
        done = 1;
        try { xhr.abort(); } catch (e4) { }
        finish(false, '上传超时');
      }, 120000);

      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (done) return;
        done = 1;
        try { clearTimeout(timer); } catch (e5) { }
        if (xhr.status === 200) finish(true);
        else finish(false, 'HTTP ' + xhr.status);
      };

      try { xhr.send(payload); }
      catch (e6) {
        if (done) return;
        done = 1;
        try { clearTimeout(timer); } catch (e7) { }
        if (isFileObj) {
          /* File 直发失败 → 用 FileReader 读成二进制再发 */
          readAsBuffer(file, function (buf) {
            if (!buf) { finish(false, '无法读取本地文件'); return; }
            sendWith(buf, false);
          });
        } else {
          finish(false, (e6 && e6.message) || '发送失败');
        }
      }
    }

    sendWith(file, true);
  }

  function readAsBuffer(file, cb) {
    try {
      if (typeof FileReader === 'undefined') { cb(null); return; }
      var fr = new FileReader();
      fr.onload = function () { cb(fr.result); };
      fr.onerror = function () { cb(null); };
      fr.onabort = function () { cb(null); };
      fr.readAsArrayBuffer(file);
    } catch (e) { cb(null); }
  }

  /* ================================================================
   * 十一、我的
   * ================================================================ */

  function loadStorage(cb) {
    api('GET', '/api/drive/storage', null, function (err, d) {
      if (!err && d) S.storage = d;
      if (cb) cb(err);
    });
  }

  function quotaHtml() {
    var st = S.storage;
    if (!st) return '<div class="ls">配额加载中…</div>';
    var pct = num(st.percent);
    if (pct > 100) pct = 100;
    var barColor = pct >= 90 ? '#c9252d' : '#1a5fd0';
    return '<div class="ls" style="margin-bottom:4px">已用 ' + fmtSize(st.used) + ' / ' + fmtSize(st.quota) +
      '（' + pct + '%），剩余 ' + fmtSize(st.remain) + '</div>' +
      '<div style="height:8px;background:#e3e8ee;border:1px solid #d5dbe3">' +
      '<div style="height:8px;width:' + pct + '%;background:' + barColor + '"></div></div>';
  }

  function renderMe() {
    if (!S.user) return;
    var u = S.user;
    var masterTxt = u.founder
      ? '永久最高权限'
      : (u.master ? '最高权限已激活（剩余约 ' + Math.max(0, Math.round(num(u.masterRemainMs) / 60000)) + ' 分钟）' : '未激活');

    var h = '';
    h += '<div class="card"><div class="ch">账号信息</div><div class="cb">' +
      '<div class="lt">' + esc(u.nickname || u.username) + '</div>' +
      '<div class="ls">账号：' + esc(u.username) + '（不可修改）</div>' +
      '<div style="margin-top:7px">' +
      '<button class="bt sm bg" onclick="LL.editNick()">修改昵称</button> ' +
      '<button class="bt sm bg" onclick="LL.showDiag()">设备自检</button>' +
      '</div></div></div>';

    h += '<div class="card"><div class="ch">存储空间</div><div class="cb">' + quotaHtml() + '</div></div>';

    h += '<div class="card"><div class="ch">最高权限</div><div class="cb">' +
      '<div class="ls" style="margin-bottom:6px">' + esc(masterTxt) + '</div>' +
      '<input id="inPerm" class="ti" type="text" placeholder="输入权限密钥后点激活">' +
      '<button class="bt bp" onclick="LL.activatePerm()">激活 / 续期 30 分钟</button>' +
      '</div></div>';

    h += '<div class="card"><div class="ch">关于</div><div class="cb">' +
      '<div class="ls">版本：' + esc(S.version && S.version.version ? S.version.version.name : '—') +
      '（基础版 · 兼容模式）</div>' +
      '<div style="margin-top:8px"><button class="bt sm bg" onclick="LL.showChangelog()">历史更新记录</button></div>' +
      '<div class="ls" style="margin-top:9px;line-height:1.6">反馈问题请发邮件给开发者：<br>' +
      '<a href="mailto:' + esc(S.contact || (S.version && S.version.contact) || 'ngkz5993@agent.qq.com') + '">' +
      esc(S.contact || (S.version && S.version.contact) || 'ngkz5993@agent.qq.com') + '</a></div>' +
      '<div style="margin-top:9px">' +
      '<button class="bt sm bg" onclick="LL.logout()">退出登录</button> ' +
      '<button class="bt sm bd2" onclick="LL.deleteAccount()">注销账号</button>' +
      '</div></div></div>';

    $('view').innerHTML = h;
    if (!S.storage) loadStorage(function () { if (S.view === 'me') renderMe(); });
  }

  /** 历史更新记录：内联视图展示（基础版不用遮罩），数据来自 /api/version，只存一份默认不显示 */
  LL.showChangelog = function () {
    var v = S.version || {};
    var list = (v.changelog && v.changelog.releases) || [];
    if (!list.length) { alert('暂无更新记录'); return; }
    var h = '<div class="card"><div class="ch">历史更新记录</div><div class="cb">';
    h += '<div class="ls" style="margin-bottom:8px">当前版本：v' +
      esc(v.version ? v.version.name : '—') + '（code ' + (v.version ? v.version.code : '—') + '）</div>';
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      h += '<div style="padding:8px 0;border-bottom:1px solid #edf0f4">';
      h += '<div class="lt" style="color:#1a5fd0">v' + esc(r.version) +
        ' <span class="ls">' + esc(r.date || '') + (r.code ? ' · code ' + esc(r.code) : '') + '</span></div>';
      var ch = r.changes || [];
      for (var j = 0; j < ch.length; j++) {
        h += '<div class="ls" style="margin-top:3px;line-height:1.5">· ' + esc(ch[j]) + '</div>';
      }
      h += '</div>';
    }
    h += '<div style="margin-top:10px"><button class="bt bg" onclick="LL.go(\'me\')">返回</button></div>';
    h += '</div></div>';
    $('view').innerHTML = h;
    try { window.scrollTo(0, 0); } catch (e) { }
  };

  LL.editNick = function () {
    var v = window.prompt('修改昵称（2-20 位中英文 / 数字 / 下划线）：', S.user ? (S.user.nickname || '') : '');
    if (v === null) return;
    v = trim(v);
    if (!v) return;
    api('POST', '/api/me/nickname', { nickname: v }, function (err, d) {
      if (err) { alert('修改失败：' + err.message); return; }
      S.user = d.user;
      setText($('hdUser'), S.user.nickname || S.user.username);
      renderMe();
      alert('昵称已更新');
    });
  };

  LL.activatePerm = function () {
    var el = $('inPerm');
    var key = el ? trim(el.value) : '';
    if (!key) { alert('请输入权限密钥'); return; }
    api('POST', '/api/auth/perm', { key: key }, function (err, d) {
      if (err) { alert('激活失败：' + err.message); return; }
      S.user = d.user;
      renderMe();
      alert('最高权限已激活，30 分钟内有效');
    });
  };

  LL.logout = function () {
    api('POST', '/api/logout', {}, function () {
      clearToken();
      S.token = '';
      S.user = null;
      stopPoll();
      screen('auth');
    });
  };

  LL.deleteAccount = function () {
    if (!S.user) return;
    var typed = window.prompt('注销后所有房间、消息、文件都会被彻底删除且不可恢复。\n请输入账号名「' + S.user.username + '」确认：', '');
    if (typed === null) return;
    if (trim(typed) !== S.user.username) { alert('账号名不符，已取消'); return; }
    api('POST', '/api/account/delete', { confirm: true }, function (err) {
      if (err) { alert('注销失败：' + err.message); return; }
      clearToken();
      S.token = '';
      S.user = null;
      stopPoll();
      alert('账号已注销');
      screen('auth');
    });
  };

  /* ================================================================
   * 十二、好友
   * ================================================================ */

  function loadFriends() {
    api('GET', '/api/friends', null, function (err, d) {
      if (err) { $('view').innerHTML = '<div class="empty">加载失败：' + esc(err.message) + '</div>'; return; }
      var fs = d.friends || [];
      var h = '<div class="card"><div class="ch">好友（' + fs.length + '）</div><div class="cb">';
      if (!fs.length) h += '<div class="empty">还没有好友</div>';
      else {
        for (var i = 0; i < fs.length; i++) {
          var f = fs[i];
          h += '<div class="line' + (i === fs.length - 1 ? ' last' : '') + '">' +
            '<div class="lm"><div class="lt">' + esc(f.nickname || f.username) + '</div>' +
            '<div class="ls">@' + esc(f.username) + '</div></div>' +
            '<div class="lr"><button class="bt sm bg" onclick="LL.dm(\'' + esc(f.id) + '\')">发消息</button></div>' +
            '</div>';
        }
      }
      h += '</div></div>';
      $('view').innerHTML = h;
    });
  }

  /* 私聊：GET /api/dm/:userId 会建/取 DM 房间，拿到 id 再进 */
  LL.dm = function (userId) {
    api('GET', '/api/dm/' + encodeURIComponent(userId), null, function (err, d) {
      if (err) { alert('发起私聊失败：' + err.message); return; }
      LL.openRoom(d.room.id, d.room.name);
    });
  };

  /* ================================================================
   * 十三、云网盘
   * ================================================================ */

  function loadDrive() {
    var q = '/api/drive/files?page=' + num(S.drivePage) + '&size=30';
    if (S.driveKeyword) q += '&keyword=' + encodeURIComponent(S.driveKeyword);
    if (S.driveFolder !== null && S.driveTab !== 'trash') q += '&folder=' + encodeURIComponent(S.driveFolder);
    if (S.driveTab === 'trash') q = '/api/drive/trash?page=1&size=30';

    api('GET', q, null, function (err, d) {
      if (err) { $('view').innerHTML = '<div class="empty">网盘加载失败：' + esc(err.message) + '</div>'; return; }
      S.driveData = d;
      loadStorage(function () { renderDrive(); });
    });
  }

  function renderDrive() {
    var d = S.driveData || { items: [] };
    var items = d.items || [];
    var h = '';

    h += '<div class="card"><div class="ch">存储空间</div><div class="cb">' + quotaHtml() + '</div></div>';

    /* 上传入口（基础版：单片直传，上限 4MB） */
    h += '<div class="card"><div class="cb">' +
      '<div class="tipbar">可上传文件到网盘（单个不超过 4MB）。上传到当前所选目录。</div>' +
      '<input id="inDriveFile" class="ti" type="file" multiple style="display:none">' +
      '<button class="bt bp full" onclick="LL.drivePick()">＋ 上传文件到网盘</button>' +
      '<div id="driveUpHint" class="ls" style="margin-top:6px"></div>' +
      '</div></div>';

    h += '<div class="card"><div class="cb">' +
      '<table class="srow"><tr>' +
      '<td style="width:60%"><input id="inKw" class="ti" type="text" placeholder="搜索文件名" value="' + esc(S.driveKeyword) + '"></td>' +
      '<td style="width:20%;text-align:center"><button class="bt sm bg" onclick="LL.driveSearch()">搜索</button></td>' +
      '<td style="width:20%;text-align:right"><button class="bt sm bg" onclick="LL.driveSwitch()">' +
      (S.driveTab === 'trash' ? '我的文件' : '回收站') + '</button></td>' +
      '</tr></table></div></div>';

    /* 目录切换栏（全部 / 根目录 / 各目录） */
    if (S.driveTab !== 'trash') {
      var folders = d.folders || [];
      if (folders.length) {
        h += '<div class="card"><div class="cb"><div class="chips">';
        h += '<button class="chip' + (S.driveFolder === null ? ' on' : '') + '" onclick="LL.driveFolderGo(\'__all__\')">全部目录</button>' +
             '<button class="chip' + (S.driveFolder === '' ? ' on' : '') + '" onclick="LL.driveFolderGo(\'__root__\')">根目录</button>';
        for (var k = 0; k < folders.length; k++) {
          h += '<button class="chip' + (S.driveFolder === folders[k] ? ' on' : '') + '" onclick="LL.driveFolderGo(' + esc(JSON.stringify(folders[k])) + ')">' +
            '[目录] ' + esc(folders[k]) + '</button>';
        }
        h += '</div></div></div>';
      }
    }

    h += '<div class="card"><div class="ch">' +
      (S.driveTab === 'trash' ? '回收站（' + num(d.total) + '）' : '我的文件（' + num(d.total) + '）') +
      '</div><div class="cb">';

    if (!items.length) {
      h += '<div class="empty">' + (S.driveTab === 'trash' ? '回收站是空的' : '还没有文件') + '</div>';
    } else {
      for (var i = 0; i < items.length; i++) {
        var f = items[i];
        h += '<div class="line' + (i === items.length - 1 ? ' last' : '') + '">' +
          '<div class="lm"><div class="lt">' + esc(f.name) + '</div>' +
          '<div class="ls">' + fmtSize(f.size) + ' · ' + esc(f.typeLabel || '') +
          (f.folder ? ' · [目录] ' + esc(f.folder) : '') +
          (f.fromChat ? ' · 来自' + esc(f.roomName || '聊天') : '') + '</div></div>' +
          '<div class="lr">';
        if (S.driveTab === 'trash') {
          h += '<button class="bt sm bg" onclick="LL.driveRestore(\'' + esc(f.fileId) + '\')">恢复</button>' +
            '<button class="bt sm bd2" style="margin-left:4px" onclick="LL.drivePurge(\'' + esc(f.fileId) + '\')">彻底删</button>';
        } else {
          h += '<a class="bt sm bg" href="' + esc(f.downloadUrl) + '">下载</a>' +
            '<button class="bt sm bg" style="margin-left:4px" onclick="LL.driveMove(\'' + esc(f.fileId) + '\',\'' + esc(f.folder || '') + '\')">移动</button>' +
            '<button class="bt sm bd2" style="margin-left:4px" onclick="LL.driveDel(\'' + esc(f.fileId) + '\')">删除</button>';
        }
        h += '</div></div>';
      }
    }
    h += '</div>';

    /* 分页 */
    var pages = num(d.pages) || 1;
    if (pages > 1 && S.driveTab !== 'trash') {
      h += '<div class="cb" style="text-align:center;border-top:1px solid #edf0f4">' +
        '<button class="bt sm bg" onclick="LL.drivePageGo(-1)">上一页</button> ' +
        '<span class="ls">' + num(d.page) + ' / ' + pages + '</span> ' +
        '<button class="bt sm bg" onclick="LL.drivePageGo(1)">下一页</button></div>';
    }
    h += '</div>';

    $('view').innerHTML = h;
    var fi = $('inDriveFile');
    if (fi) fi.onchange = function () {
      var list = [];
      if (fi.files) for (var j = 0; j < fi.files.length; j++) list.push(fi.files[j]);
      driveUploadQueue(list);
      fi.value = '';
    };
  }

  /* 目录切换：全部 / 根目录 / 指定目录 */
  function driveFolderGo(v) {
    if (v === '__all__') S.driveFolder = null;
    else if (v === '__root__') S.driveFolder = '';
    else S.driveFolder = v;
    S.drivePage = 1;
    loadDrive();
  }

  /* 移动到目录：prompt 输入目录名（老内核可靠），留空=根目录 */
  function driveMove(fileId, cur) {
    var to = window.prompt('移动到哪个目录？（留空 = 移到根目录）', cur || '');
    if (to === null) return;
    api('PATCH', '/api/drive/files/' + encodeURIComponent(fileId), { folder: String(to) }, function (err) {
      if (err) { alert('移动失败：' + err.message); return; }
      loadDrive();
    });
  }

  /* 网盘上传队列（基础版：单片直传，逐个来） */
  function driveUploadQueue(list) {
    if (!list.length || S.driveUpBusy) return;
    var sum = 0;
    for (var i = 0; i < list.length; i++) sum += num(list[i].size);
    if (S.storage && num(S.storage.remain) < sum) {
      alert('存储空间不足：剩余 ' + (S.storage.remainText || fmtSize(S.storage.remain)) + '，本次共 ' + fmtSize(sum));
      return;
    }
    S.driveUpBusy = true;
    var idx = 0;
    function next() {
      if (idx >= list.length) {
        S.driveUpBusy = false;
        setText($('driveUpHint'), '上传完成');
        loadDrive();
        return;
      }
      var f = list[idx++];
      setText($('driveUpHint'), '正在上传 ' + f.name + '（' + num(idx) + '/' + list.length + '）…');
      driveUploadOne(f, function (ok) {
        if (!ok) { S.driveUpBusy = false; return; }
        next();
      });
    }
    next();
  }

  /* 单个文件上传：init(roomId 空=网盘) → 单片 PUT → complete；随后打上目录标签 */
  function driveUploadOne(file, cb) {
    if (num(file.size) > 4 * 1024 * 1024) {
      alert('网盘单个文件上限 4MB（这个文件 ' + fmtSize(file.size) + '），请换小一点的文件');
      cb(false); return;
    }
    api('POST', '/api/files/init', {
      name: file.name,
      size: num(file.size),
      mime: file.type || 'application/octet-stream',
      roomId: ''
    }, function (err, info) {
      if (err) { alert('上传失败：' + err.message); cb(false); return; }
      var fileId = info.fileId;
      var url = withShare('/api/files/' + encodeURIComponent(fileId) + '/chunk?i=0');
      var xhr = null;
      try { xhr = new XMLHttpRequest(); } catch (e) { alert('不支持上传'); cb(false); return; }
      var done = 0;
      function fin(okFlag, why) {
        if (done) return; done = 1;
        if (!okFlag) { alert('上传失败：' + why); cb(false); return; }
        api('POST', '/api/files/' + encodeURIComponent(fileId) + '/complete', {}, function (e2, d2) {
          if (e2) { alert('上传收尾失败：' + e2.message); cb(false); return; }
          if (d2 && d2.storage) S.storage = d2.storage;
          /* 传到当前所选目录；根目录/全部目录时放根目录 */
          var folder = (S.driveFolder === null || S.driveFolder === undefined) ? '' : S.driveFolder;
          if (folder) {
            api('PATCH', '/api/drive/files/' + encodeURIComponent(fileId), { folder: folder }, function () { cb(true); });
          } else cb(true);
        });
      }
      try {
        xhr.open('PUT', url, true);
        xhr.setRequestHeader('X-Token', S.token);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      } catch (e3) { fin(false, '无法发起上传'); return; }
      var timer = setTimeout(function () { try { xhr.abort(); } catch (e4) {} fin(false, '上传超时'); }, 120000);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4 || done) return;
        clearTimeout(timer);
        if (xhr.status === 200) fin(true); else fin(false, 'HTTP ' + xhr.status);
      };
      try { xhr.send(file); } catch (e5) { fin(false, '发送失败：' + e5.message); }
    });
  }

  LL.drivePick = function () { var fi = $('inDriveFile'); if (fi) fi.click(); };
  LL.driveFolderGo = driveFolderGo;
  LL.driveMove = driveMove;

  LL.driveSearch = function () {
    var el = $('inKw');
    S.driveKeyword = el ? trim(el.value) : '';
    S.drivePage = 1;
    loadDrive();
  };
  LL.driveSwitch = function () {
    S.driveTab = (S.driveTab === 'trash') ? 'files' : 'trash';
    S.drivePage = 1;
    loadDrive();
  };
  LL.drivePageGo = function (delta) {
    var p = num(S.drivePage) + num(delta);
    if (p < 1) p = 1;
    S.drivePage = p;
    loadDrive();
  };
  LL.driveDel = function (id) {
    if (!window.confirm('移入回收站？30 天内可恢复。')) return;
    api('DELETE', '/api/drive/files/' + encodeURIComponent(id), null, function (err) {
      if (err) { alert('删除失败：' + err.message); return; }
      loadDrive();
    });
  };
  LL.driveRestore = function (id) {
    api('POST', '/api/drive/trash/' + encodeURIComponent(id) + '/restore', {}, function (err) {
      if (err) { alert('恢复失败：' + err.message); return; }
      loadDrive();
    });
  };
  LL.drivePurge = function (id) {
    if (!window.confirm('彻底删除后无法恢复，且立即释放空间。确定吗？')) return;
    api('DELETE', '/api/drive/trash/' + encodeURIComponent(id), null, function (err) {
      if (err) { alert('删除失败：' + err.message); return; }
      loadDrive();
    });
  };

  /* ================================================================
   * 十四、成员管理 / 继承人 / 转让 / 解散 / 群内昵称
   * ================================================================ */

  LL.members = function () {
    if (!S.room) return;
    var rid = S.room.id;
    api('GET', '/api/rooms/' + encodeURIComponent(rid) + '/members', null, function (err, d) {
      if (err) { alert('读取成员失败：' + err.message); return; }

      var arr = d.members || [];
      var myRole = d.myRole;
      var lines = [];
      for (var i = 0; i < arr.length; i++) {
        var m = arr[i];
        var tag = m.userId === d.heirId ? '（继承人）' : '';
        lines.push((i + 1) + '. ' + (m.roomNickname || m.nickname) + ' [' + m.roleName + ']' + tag);
      }

      var txt = '成员（' + arr.length + ' 人）：\n' + lines.join('\n') +
        '\n\n输入序号后选择操作：\n' +
        '· 输入 s 序号 = 设为遗产继承人\n' +
        '· 输入 t 序号 = 转让群主\n' +
        '· 输入 n = 修改我在本群的昵称\n' +
        (myRole === 'owner' ? '· 输入 d = 解散本群聊\n' : '');
      var v = window.prompt(txt, '');
      if (v === null) return;
      v = trim(v);
      if (!v) return;

      if (v === 'n') { roomNick(rid, d.myRoomNickname || ''); return; }
      if (v === 'd') { dissolve(rid); return; }

      var op = v.charAt(0);
      var idx = num(v.substring(1)) - 1;
      if (idx < 0 || idx >= arr.length) return;
      var target = arr[idx];

      if (op === 's') {
        var cur = d.heirId === target.userId;
        if (!window.confirm((cur ? '取消 ' : '设置 ') + (target.roomNickname || target.nickname) + ' 为遗产继承人？')) return;
        api('POST', '/api/rooms/' + encodeURIComponent(rid) + '/heir', { heirId: cur ? '' : target.userId }, function (e2) {
          if (e2) { alert('设置失败：' + e2.message); return; }
          alert('已更新继承人');
        });
        return;
      }
      if (op === 't') {
        if (!window.confirm('把群主转让给 ' + (target.roomNickname || target.nickname) + '？转让后你将变为普通成员，且不可撤销。')) return;
        api('POST', '/api/rooms/' + encodeURIComponent(rid) + '/transfer', { userId: target.userId, confirm: true }, function (e3) {
          if (e3) { alert('转让失败：' + e3.message); return; }
          alert('群主已转让');
          pull(true);
        });
        return;
      }
      alert('未识别的操作：' + v);
    });
  };

  function roomNick(rid, cur) {
    var v = window.prompt('我在本群的昵称（留空则用全局昵称）：', cur || '');
    if (v === null) return;
    api('POST', '/api/rooms/' + encodeURIComponent(rid) + '/nickname', { nickname: trim(v) }, function (err) {
      if (err) { alert('设置失败：' + err.message); return; }
      alert('已更新本群昵称');
      pull(true);
    });
  }

  function dissolve(rid) {
    var name = S.room ? S.room.name : '';
    if (!window.confirm('解散「' + name + '」后群内将停用，仅保留历史消息与解散通知，5 天后自动彻底删除。\n\n确定解散吗？')) return;
    var typed = window.prompt('请输入房间名「' + name + '」确认解散：', '');
    if (typed === null) return;
    if (trim(typed) !== name) { alert('房间名不符，已取消'); return; }
    api('POST', '/api/rooms/' + encodeURIComponent(rid) + '/dissolve', { confirm: true }, function (err) {
      if (err) { alert('解散失败：' + err.message); return; }
      alert('已解散');
      pull(true);
      updateComposer();
    });
  }

  /* ================================================================
   * 十五、轮询
   * ================================================================ */

  function startPoll() {
    stopPoll();
    try {
      /* ?nopoll=1：省电/省流量模式，也用于自动化截图（定时器会让无头浏览器一直等） */
      if (String(location.search || '').indexOf('nopoll=1') >= 0) return;
      S.pollTimer = setInterval(function () {
        try {
          if ($('scrChat') && $('scrChat').style.display !== 'none' && S.room) pull(false);
        } catch (e) { }
      }, 5000);
    } catch (e2) { }
  }
  function stopPoll() {
    try { if (S.pollTimer) clearInterval(S.pollTimer); } catch (e) { }
    S.pollTimer = null;
  }

  /* ================================================================
   * 十六、设备自检（用于反馈「这台机器到底缺什么」）
   * ================================================================ */

  function cssOk(prop, val) {
    try {
      var d = document.createElement('div');
      if (!d.style || !d.style.setProperty) return false;
      d.style.setProperty(prop, val);
      return String(d.style.getPropertyValue(prop) || '') !== '';
    } catch (e) { return false; }
  }

  function lsOk() {
    try {
      window.localStorage.setItem('__ll_probe', '1');
      window.localStorage.removeItem('__ll_probe');
      return true;
    } catch (e) { return false; }
  }

  function cookieOk() {
    try {
      document.cookie = '__ll_probe=1; path=/';
      var has = String(document.cookie || '').indexOf('__ll_probe=1') >= 0;
      document.cookie = '__ll_probe=; path=/; max-age=0';
      return has;
    } catch (e) { return false; }
  }

  LL.showDiag = function () {
    var rows = [];
    function add(k, v, ok) {
      var cls = (ok === true) ? 'good' : (ok === false ? 'bad' : '');
      rows.push('<tr><td class="k">' + esc(k) + '</td><td class="v ' + cls + '">' + esc(v) + '</td></tr>');
    }

    var ua = '';
    try { ua = navigator.userAgent || ''; } catch (e) { }

    var hasXhr = false;
    try { hasXhr = typeof XMLHttpRequest !== 'undefined'; } catch (e2) { }

    var hasJson = false;
    try { hasJson = typeof JSON !== 'undefined' && typeof JSON.parse === 'function'; } catch (e3) { }

    var hasFr = false;
    try { hasFr = typeof FileReader !== 'undefined'; } catch (e4) { }

    add('当前档位', 'basic（基础版）', null);
    add('XMLHttpRequest', hasXhr ? '支持' : '不支持', hasXhr);
    add('JSON.parse', hasJson ? '支持' : '不支持', hasJson);
    add('FileReader', hasFr ? '支持' : '不支持', hasFr);
    add('localStorage', lsOk() ? '可读写' : '不可用（已自动改用 cookie）', lsOk());
    add('Cookie', cookieOk() ? '可读写' : '不可用', cookieOk());
    add('CSS 变量 var()', cssOk('--probe', '1') ? '支持' : '不支持', cssOk('--probe', '1'));
    add('CSS flexbox', cssOk('display', 'flex') ? '支持' : '不支持', cssOk('display', 'flex'));
    add('CSS Grid', cssOk('display', 'grid') ? '支持' : '不支持', null);
    add('visibilityState', (typeof document.visibilityState !== 'undefined') ? String(document.visibilityState) : '无', null);

    var w = 0, hh = 0, dpr = 1;
    try { w = window.innerWidth; hh = window.innerHeight; } catch (e5) { }
    try { dpr = window.devicePixelRatio || 1; } catch (e6) { }
    add('视口', w + ' × ' + hh + '（dpr ' + dpr + '）', null);

    var conn = '未知';
    try {
      if (navigator.connection) {
        conn = (navigator.connection.effectiveType || '') + ' ' +
          (navigator.connection.downlink || '') + 'Mbps';
      }
    } catch (e7) { }
    add('网络类型', conn, null);

    var t0 = (window.__LL && window.__LL.t0) ? window.__LL.t0 : 0;
    if (t0) add('脚本耗时', ((new Date()).getTime() - t0) + ' ms', null);
    add('初始化完成', (window.__LL && window.__LL.ready) ? '是' : '否', !!(window.__LL && window.__LL.ready));

    add('User-Agent', ua, null);

    var h = '<div id="diag" style="margin:0">' +
      '<div class="dh">设备自检 · 截图或长按复制后发给开发者</div>' +
      '<div class="db"><table>' + rows.join('') + '</table>';

    var errs = (window.__LL && window.__LL.err) ? window.__LL.err : [];
    if (errs.length) {
      h += '<div style="margin-top:8px;font-weight:bold;color:#c9252d">捕获到 ' + errs.length + ' 个脚本错误：</div><pre>';
      for (var i = 0; i < errs.length; i++) {
        h += esc(errs[i].m) + '  @L' + esc(errs[i].l) + '\n';
      }
      h += '</pre>';
    } else {
      h += '<div class="okbar" style="margin-top:8px">未捕获到脚本错误</div>';
    }

    h += '<div style="margin-top:9px">' +
      '<button class="bt bw full" onclick="LL.diagCopy()">显示纯文本（可长按复制）</button>' +
      '<button class="bt bg full" style="margin-top:6px" onclick="LL.diagClose()">关闭</button>' +
      '</div></div></div>';

    var box = $('diag');
    if (!box) {
      /* 主界面/登录页都可能调用，统一挂到 body 末尾 */
      box = document.createElement('div');
      box.id = 'diag';
      document.body.appendChild(box);
    }
    box.innerHTML = h;
    box.style.display = 'block';
    box.className = '';
    try { box.scrollIntoView(); } catch (e8) { }
  };

  LL.diagClose = function () {
    var box = $('diag');
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  };

  LL.diagCopy = function () {
    var lines = [];
    lines.push('轻聊 基础版 自检');
    lines.push('UA: ' + (navigator.userAgent || ''));
    lines.push('viewport: ' + window.innerWidth + 'x' + window.innerHeight +
      ' dpr=' + (window.devicePixelRatio || 1));
    lines.push('xhr=' + (typeof XMLHttpRequest !== 'undefined') +
      ' json=' + (typeof JSON !== 'undefined') +
      ' fr=' + (typeof FileReader !== 'undefined') +
      ' ls=' + lsOk() + ' cookie=' + cookieOk());
    lines.push('cssVar=' + cssOk('--probe', '1') + ' flex=' + cssOk('display', 'flex'));
    lines.push('ready=' + !!(window.__LL && window.__LL.ready));
    var errs = (window.__LL && window.__LL.err) ? window.__LL.err : [];
    for (var i = 0; i < errs.length; i++) {
      lines.push('ERR: ' + errs[i].m + ' @L' + errs[i].l + ' ' + errs[i].u);
    }
    var txt = lines.join('\n');
    /* 老内核没有剪贴板 API，用 prompt 让用户长按复制 */
    try { window.prompt('长按下面文字全选复制：', txt); }
    catch (e) { alert(txt); }
  };

  /* ================================================================
   * 十七、启动
   * ================================================================ */

  /* 每一步都单独 try/catch：老内核里任何一步抛异常都不能拖垮后面的绑定。
     这正是标准版在红米上「按钮全点不动」的根因（顶层一行报错，后续全没绑上）。 */
  function step(name, fn) {
    try { fn(); }
    catch (e) {
      try {
        if (window.__LL) window.__LL.err.push({ m: '[' + name + '] ' + (e && e.message), l: '-', u: '' });
      } catch (e2) { }
    }
  }

  function bindStatic() {
    step('bindKeys', bindKeys);
    step('bindFile', bindFile);
    step('setMode', function () { LL.setMode('login'); });
  }

  function boot() {
    log('boot 开始');
    /* ① 从地址栏接管 token（OAuth 回调与自动化测试都用这个） */
    step('tokenFromUrl', function () {
      var m = String(location.search || '').match(/[?&]wl_token=([^&]+)/);
      if (!m) return;
      var t = m[1];
      try { t = decodeURIComponent(t); } catch (e) { }
      if (t) { S.token = t; saveToken(t); }
    });
    log('token=' + (S.token ? '有' : '无'));

    /* ② 静态绑定（必须在任何网络请求之前，保证按钮先能点） */
    step('bindStatic', bindStatic);

    /* ②-b 立刻标记初始化完成。
       basic 版的按钮是内联 onclick，只要 LL 方法齐全就已经能点，
       不需要等任何网络请求。早标记有两个好处：
         · 守门脚本不会因为「网络慢」把用户误降级/误刷新；
         · 自检面板里的「初始化完成」能如实显示为「是」。 */
    step('markReady', function () {
      if (window.__LL) window.__LL.ready = 1;
      /* 登录页也给一个自检入口，方便反馈「连登录页都点不动」 */
      var box = $('authDiagBox');
      if (box) {
        box.innerHTML = '<button class="bt bg full" onclick="LL.showDiag()">设备自检 / 反馈</button>';
      }
    });
    log('bindStatic 完成，ready=1');

    /* ③ 版本信息（公开接口，失败也无所谓） */
    step('version', function () {
      api('GET', '/api/version', null, function (err, d) {
        if (!err && d) S.version = d;
      });
    });

    /* ④ 没有 token 就停在登录页 */
    if (!S.token) {
      step('screenAuth', function () { screen('auth'); });
      step('autoDiag', maybeAutoDiag);
      return;
    }

    /* ④ 先给一个明确的加载态而不是白屏。
       必须排在「发请求」之前：否则请求先回来渲染了界面，这一步又把界面盖回
       「正在加载…」，用户就会看到一次没必要的回跳。 */
    step('showLoading', function () {
      screen('main');
      setText($('hdTitle'), '正在加载…');
      $('view').innerHTML = '<div class="empty">正在读取账号信息…</div>';
    });

    /* ⑤ 有 token 就校验一次；没有就停在登录页 */
    step('me', function () {
      api('GET', '/api/me', null, function (err, d) {
        log('/api/me 返回 ' + (err ? 'ERr ' + err.message : 'ok'));
        if (err) {
          clearToken();
          S.token = '';
          screen('auth');
          return;
        }
        S.user = d.user;
        setText($('hdUser'), S.user.nickname || S.user.username);
        screen('main');
        loadRooms(function (e0) {
          log('rooms 返回 ' + (e0 ? 'err ' + e0.message : 'ok, 公共=' + S.publicRoomId));
          step('firstView', function () { LL.go(S.view); });
        });
        startPoll();
      });
    });

    step('autoDiag', maybeAutoDiag);
  }

  /* ?diag=1：直接展开自检面板，真机上不用先登录就能反馈环境信息 */
  function maybeAutoDiag() {
    try {
      if (String(location.search || '').indexOf('diag=1') >= 0) LL.showDiag();
    } catch (e) { }
  }

  try { boot(); }
  catch (e) {
    try {
      if (window.__LL) window.__LL.err.push({ m: 'boot 失败: ' + (e && e.message), l: '-', u: '' });
    } catch (e2) { }
    try { alert('页面初始化失败，请点「设备自检」反馈。\n' + (e && e.message)); } catch (e3) { }
  }

  /* 供测试与调试 */
  LL._internal = { api: api, pull: pull, loadRooms: loadRooms };
})();
