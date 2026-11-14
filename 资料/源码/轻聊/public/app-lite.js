/* 轻聊 · 低配兼容版前端
 *
 * 给 Android 5.x / Chromium 37-39 的老 WebView（红米 Note 2 等）用。
 * 铁律：
 *   - 纯 ES5：无箭头函数 / 模板字符串 / let / const / Promise / fetch / classList / dataset
 *   - 只用 on* 事件与 getElementById / getElementsByTagName，不依赖 querySelector
 *   - 所有 localStorage 访问都包 try/catch 并用 document.cookie 兜底
 *     （老容器没开 DOM Storage 时，标准版正是死在顶层那一行）
 *   - 中文请求体显式转 UTF-8 字节发送，避免老内核用本地编码
 *   - 调用的是与标准版完全相同的 /api/* 接口，账号/房间/消息/文件/昵称/
 *     转让/解散/通知数据天然共用、两端互通
 */
(function () {
  'use strict';

  /* ================= 基础工具 ================= */

  function $(id) { return document.getElementById(id); }
  function show(id, on) { var e = $(id); if (e) e.style.display = on ? 'block' : 'none'; }
  function bind(id, fn) { var e = $(id); if (e) e.onclick = fn; return e; }
  function trim(s) { return String(s === undefined || s === null ? '' : s).replace(/^\s+|\s+$/g, ''); }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function eachAttr(root, attr, fn) {
    if (!root) return;
    var list = root.getElementsByTagName('*');
    for (var i = 0; i < list.length; i++) {
      var v = list[i].getAttribute(attr);
      if (v) fn(list[i], v);
    }
  }
  function nowMs() { return new Date().getTime(); }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    show('toast', true);
    try { clearTimeout(t._tid); } catch (e) { }
    t._tid = setTimeout(function () { show('toast', false); }, 2600);
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
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function colorOf(id) {
    var s = String(id || ''), h = 0, i;
    for (i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffff;
    return 'hsl(' + (h % 360) + ',52%,52%)';
  }
  /** 与标准版同一套手写 UTF-8 编码，显式发字节 */
  function utf8Bytes(str) {
    var s = String(str === undefined || str === null ? '' : str);
    var out = [], i, c, c2, cp;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length &&
               s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) {
        c2 = s.charCodeAt(i + 1);
        cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(out);
  }

  /* ================= 会话令牌：三层兜底 ================= */

  function readToken() {
    try { var t = localStorage.getItem('ll_token'); if (t) return t; } catch (e) { }
    try {
      var m = document.cookie.match(/(?:^|;\s*)ll_token=([^;]+)/);
      if (m) return decodeURIComponent(m[1]);
    } catch (e2) { }
    try {
      var q = String(location.search || '').match(/[?&]wl_token=([^&]+)/);
      if (q) return decodeURIComponent(q[1]);
    } catch (e3) { }
    return '';
  }
  function saveToken(t) {
    try { localStorage.setItem('ll_token', t); } catch (e) { }
    try { document.cookie = 'll_token=' + encodeURIComponent(t) + '; path=/; max-age=2592000'; } catch (e2) { }
  }
  function clearToken() {
    try { localStorage.removeItem('ll_token'); } catch (e) { }
    try { document.cookie = 'll_token=; path=/; max-age=0'; } catch (e2) { }
  }

  /* ================= HTTP ================= */

  /* 线上发布平台会在首次导航时校验 sharecode；同源 XHR 默认带 cookie 通常没问题，
     但把 sharecode 显式带到每个 /api/ 请求上更稳，老设备也不会被判「链接不完整」。 */
  function withShare(path) {
    try {
      var m = String(location.search || '').match(/[?&](sharecode=[^&]+)/);
      if (!m || path.indexOf('/api/') !== 0) return path;
      return path + (path.indexOf('?') >= 0 ? '&' : '?') + m[1];
    } catch (e) { return path; }
  }

  function parseApi(xhr, cb) {
    var data = null;
    try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
    if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) cb(null, data);
    else cb(new Error((data && data.error) || ('请求失败(' + xhr.status + ')')), data);
  }
  function api(method, path, body, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, withShare(path), true);
    xhr.timeout = 60000;
    if (S.token) xhr.setRequestHeader('X-Token', S.token);
    if (body !== null && body !== undefined) xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onreadystatechange = function () { if (xhr.readyState === 4) parseApi(xhr, cb); };
    xhr.onerror = function () { cb(new Error('网络错误')); };
    xhr.ontimeout = function () { cb(new Error('网络超时')); };
    xhr.send(body !== null && body !== undefined ? utf8Bytes(JSON.stringify(body)) : null);
  }
  function apiBinary(method, path, payload, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, withShare(path), true);
    xhr.timeout = 0;
    if (S.token) xhr.setRequestHeader('X-Token', S.token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.onreadystatechange = function () { if (xhr.readyState === 4) parseApi(xhr, cb); };
    xhr.onerror = function () { cb(new Error('上传中断')); };
    xhr.send(payload);
  }

  /* ================= 状态 ================= */

  // 支持 ?view=drive 直接进入指定页
  var liteStartView = 'public';
  try {
    var vm = String(location.search || '').match(/[?&]view=(public|rooms|friends|me|drive)/);
    if (vm) liteStartView = vm[1];
  } catch (e) { }

  var S = {
    token: [已隐去](),
    user: null,
    view: liteStartView,
    rooms: [],
    publicRoomId: '',
    room: null,
    lastRev: 0,
    authMode: 'login',      // login | reg
    authKind: 'password',   // password | email | otp | wb
    vid: '',                // 验证码会话 id
    existing: false,
    version: null,          // /api/version 返回（含 drive.enabled 能力标记）
    storage: null,          // 存储配额（/api/drive/storage）
    drive: null             // 网盘界面状态
  };
  var modalCb = null;

  function screen(name) {
    show('auth', name === 'auth');
    show('main', name === 'main');
    show('chat', name === 'chat');
  }

  /* ================= 弹层 ================= */

  function openModal(title, html, onOk, okText) {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = html;
    $('modalOk').textContent = okText || '确定';
    show('modal', true);
    modalCb = onOk || null;
  }
  function closeModal() { show('modal', false); modalCb = null; }
  function confirmModal(title, text, onYes) {
    openModal(title, '<div style="padding:8px 2px">' + esc(text) + '</div>', function () {
      onYes();
      return true;
    }, '确定');
  }

  /* ================= 登录 / 注册 ================= */

  function renderAuth() {
    var k = S.authKind;
    show('rowUser', k === 'password');
    show('rowPass', k === 'password');
    show('rowTarget', k === 'email' || k === 'otp');
    show('rowCode', k === 'email' || k === 'otp');
    show('rowNick', k !== 'wb' && S.authMode === 'reg');
    show('ab', k !== 'wb');
    show('awb', k === 'wb');
    $('ab').textContent = S.authMode === 'login' ? '登 录' : '注 册';
    try { $('at').setAttribute('placeholder', k === 'email' ? '邮箱地址' : '手机号'); } catch (e) { }
    $('aerr').textContent = '';
    $('authTabLogin').className = 'tab' + (S.authMode === 'login' ? ' on' : '');
    $('authTabReg').className = 'tab' + (S.authMode === 'reg' ? ' on' : '');
    var ks = ['Password', 'Email', 'Otp', 'Wb'];
    for (var i = 0; i < ks.length; i++) {
      $('mode' + ks[i]).className = 'mode' + (k === ks[i].toLowerCase() ||
        (ks[i] === 'Wb' && k === 'wb') ? ' on' : '');
    }
  }
  function authOk(d) {
    S.token = d.token;
    saveToken(S.token);
    S.user = d.user;
    $('tbUser').textContent = S.user.nickname || S.user.username;
    // 权限密钥：正确就提示已激活；错误只提示、不阻断登录
    if (d.perm && d.perm.granted) toast('最高权限已激活，30 分钟内有效');
    else if (d.perm && d.perm.error) toast(d.perm.error);
    screen('main');
    loadRooms(function () { switchView('public'); });
  }
  function doAuth() {
    var errBox = $('aerr');
    errBox.textContent = '';
    var kind = S.authKind, mode = S.authMode;
    // 权限密钥（选填）：低配版同样支持，只是不展示金色标识
    var pkey = $('ak') ? trim($('ak').value) : '';
    if (kind === 'password') {
      var u = trim($('au').value), p = $('ap').value;
      if (!u || !p) { errBox.textContent = '请填写账号和密码'; return; }
      var body = { username: u, password: p };
      if (mode === 'reg') body.nickname = trim($('an').value);
      if (pkey) body.permKey = pkey;
      api('POST', mode === 'reg' ? '/api/register' : '/api/login', body, function (err, d) {
        if (err) { errBox.textContent = err.message; return; }
        authOk(d);
      });
      return;
    }
    if (kind === 'email' || kind === 'otp') {
      var target = trim($('at').value), code = trim($('ac').value);
      if (!target || !code) { errBox.textContent = '请填写邮箱/手机号和验证码'; return; }
      api('POST', '/api/auth/otp/verify', {
        mode: mode, target: target, token: code,
        verificationId: S.vid, isExistingUser: S.existing,
        password: mode === 'reg' ? $('ap').value : '',
        nickname: trim($('an').value),
        permKey: pkey
      }, function (err2, d2) {
        if (err2) { errBox.textContent = err2.message; return; }
        authOk(d2);
      });
      return;
    }
  }
  function sendCode() {
    var target = trim($('at').value);
    if (!target) { $('aerr').textContent = '请先填写邮箱或手机号'; return; }
    api('POST', '/api/auth/otp/send', { target: target }, function (err, d) {
      if (err) { $('aerr').textContent = err.message; return; }
      S.vid = d.verificationId;
      S.existing = !!d.isExistingUser;
      toast(d.message || '验证码已发送');
    });
  }
  function doWorkBuddy() {
    api('GET', '/api/auth/wb/start', null, function (err, d) {
      if (err) { $('aerr').textContent = err.message; return; }
      try { document.cookie = 'll_cap=lite; path=/; max-age=2592000'; } catch (e) { }
      location.href = d.url;
    });
  }

  /* ================= 房间列表 ================= */

  function loadRooms(cb) {
    api('GET', '/api/rooms', null, function (err, d) {
      if (err) { toast(err.message); return; }
      S.rooms = d.rooms || [];
      S.publicRoomId = d.publicRoomId || '';
      if (cb) cb();
    });
  }
  function roomName(id) {
    for (var i = 0; i < S.rooms.length; i++) {
      if (S.rooms[i].id === id) return S.rooms[i].name;
    }
    return '房间';
  }
  function renderRooms() {
    var h = '<div class="card"><div class="card-h">操作</div>' +
      '<div class="act" id="createRoom">创建自定义房间（最多 5 个）</div>' +
      '<div class="row"><input id="joinId" class="inp" type="text" placeholder="输入房间号加入" style="width:64%;display:inline-block;margin:0">' +
      '<span id="joinById" class="mini" style="height:40px;line-height:28px;vertical-align:top">加入</span></div></div>';
    h += '<div class="card"><div class="card-h">我加入 / 我创建的房间</div>';
    var n = 0;
    for (var i = 0; i < S.rooms.length; i++) {
      var r = S.rooms[i];
      if (r.kind === 'public') continue;
      n++;
      h += '<div class="row"><div class="r-main"><div class="r-title">' + esc(r.name) +
        (r.dissolved ? '<span class="badge red">已解散</span>' : '') +
        (r.roleName ? '<span class="badge">' + esc(r.roleName) + '</span>' : '') + '</div>' +
        '<div class="r-sub">' + r.memberCount + ' 人' +
        (r.joined ? '' : ' · 未加入') + '</div></div>' +
        '<div class="r-right"><span class="mini" data-open="' + esc(r.id) + '">打开</span></div></div>';
    }
    if (!n) h += '<div class="empty">还没有房间，创建一个吧</div>';
    h += '</div>';
    $('view').innerHTML = h;
    bind('createRoom', function () {
      var name = window.prompt('房间名（最多 40 字）：', '');
      if (name === null) return;
      name = trim(name);
      if (!name) return;
      api('POST', '/api/rooms', { name: name }, function (err) {
        if (err) { toast(err.message); return; }
        toast('已创建');
        loadRooms(renderRooms);
      });
    });
    bind('joinById', function () {
      var id = trim($('joinId').value);
      if (!id) { toast('请填写房间号'); return; }
      joinRoom(id, function () { loadRooms(renderRooms); });
    });
    eachAttr($('view'), 'data-open', function (el, id) {
      el.onclick = function () { openRoom(id); };
    });
  }
  function joinRoom(id, cb) {
    api('POST', '/api/rooms/' + encodeURIComponent(id) + '/join', {}, function (err) {
      if (err) { toast(err.message); return; }
      toast('已加入');
      if (cb) cb();
    });
  }

  /* ================= 聊天 / 消息 ================= */

  function openRoom(id) {
    if (!id) return;
    api('GET', '/api/rooms/' + encodeURIComponent(id) + '/messages?since=0&limit=100', null, function (err, d) {
      if (err) { toast(err.message); return; }
      S.room = { id: id, kind: d.kind, joined: d.joined, dissolved: !!d.dissolved };
      S.lastRev = d.lastSeq || 0;
      $('chatTitle').textContent = roomName(id) + (d.dissolved ? '（已解散）' : '');
      $('msgs').innerHTML = '';
      renderMsgs(d.messages || []);
      show('composer', !!d.canPost);
      show('joinBtn', !d.joined && d.kind !== 'public' && !d.dissolved);
      $('msgInput').value = '';
      screen('chat');
      scrollBottom();
    });
  }
  function scrollBottom() {
    try { window.scrollTo(0, document.body.scrollHeight); } catch (e) { }
  }
  function renderMsgs(list) {
    var box = $('msgs'), h = '', i, m;
    for (i = 0; i < list.length; i++) {
      m = list[i];
      if (m.purged) continue;
      /* 系统通知：只在对应房间出现，居中提示条，不带操作 */
      if (m.kind === 'system') {
        h += '<div class="sys">' + esc(m.content) + '</div>';
        continue;
      }
      h += '<div class="msg' + (m.mine ? ' mine' : '') + '">' +
        '<span class="av" style="background:' + colorOf(m.senderId) + '">' +
        esc(String(m.senderName || '?').charAt(0)) + '</span>' +
        '<div class="bub"><div class="who">' + esc(m.senderName) + (m.mine ? ' (我)' : '') + '</div>';
      if (m.recalled) h += '<div class="recalled">该消息已被撤回</div>';
      else if (m.kind === 'file' && m.file) {
        h += '<div class="txt"><a href="' + esc(withShare(m.file.dlUrl)) + '">下载文件：' + esc(m.file.name) +
          '</a> <span class="meta">' + fmtSize(m.file.size) + '</span></div>';
      } else h += '<div class="txt">' + esc(m.content) + '</div>';
      h += '<div class="meta">' + fmtTime(m.createdAt) + '</div><div class="tools">' +
        '<span class="mini" data-del="' + esc(m.id) + '">删除</span>';
      if (m.canPurge) h += '<span class="mini red" data-purge="' + esc(m.id) + '">直接删除</span>';
      h += '</div></div></div>';
    }
    if (!h) return;
    box.innerHTML = box.innerHTML + h;
    eachAttr(box, 'data-del', function (el, id) {
      el.onclick = function () {
        api('POST', '/api/messages/' + encodeURIComponent(id) + '/delete', {}, function (err) {
          if (err) { toast(err.message); return; }
          el.parentNode.parentNode.parentNode.style.display = 'none';
          toast('已删除（仅自己可见）');
        });
      };
    });
    eachAttr(box, 'data-purge', function (el, id) {
      el.onclick = function () {
        confirmModal('直接删除', '将从服务器彻底删除这条消息，所有设备上都会消失。', function () {
          api('POST', '/api/messages/' + encodeURIComponent(id) + '/purge', {}, function (err2) {
            if (err2) { toast(err2.message); return; }
            el.parentNode.parentNode.parentNode.style.display = 'none';
            toast('已彻底删除');
          });
        });
      };
    });
    scrollBottom();
  }
  function pull() {
    if (!S.room) return;
    var chat = $('chat');
    if (!chat || chat.style.display === 'none') return;
    api('GET', '/api/rooms/' + encodeURIComponent(S.room.id) +
      '/messages?since=' + S.lastRev + '&limit=100', null, function (err, d) {
      if (err || !d) return;
      var old = $('msgs').innerHTML.length;
      renderMsgs(d.messages || []);
      if ($('msgs').innerHTML.length !== old) scrollBottom();
      if ((d.lastSeq || 0) > S.lastRev) S.lastRev = d.lastSeq;
      if (typeof d.canPost === 'boolean') show('composer', d.canPost);
      if (d.dissolved) {
        show('composer', false);
        show('joinBtn', false);
        $('chatTitle').textContent = roomName(S.room.id) + '（已解散）';
      }
    });
  }
  function sendMsg() {
    if (!S.room) return;
    var v = trim($('msgInput').value);
    if (!v) return;
    api('POST', '/api/rooms/' + encodeURIComponent(S.room.id) + '/messages',
      { kind: 'text', content: v }, function (err, d) {
        if (err) { toast(err.message); return; }
        $('msgInput').value = '';
        renderMsgs([d.message]);
        pull();
      });
  }

  /* ================= 文件上传（分片 + 老内核兜底） ================= */

  function sliceBlob(file, a, b) {
    try { if (file.slice) return file.slice(a, b); } catch (e) { }
    try { if (file.webkitSlice) return file.webkitSlice(a, b); } catch (e2) { }
    try { if (file.mozSlice) return file.mozSlice(a, b); } catch (e3) { }
    return file;
  }
  function readBlob(blob, cb) {
    try {
      var fr = new FileReader();
      fr.onload = function (ev) { cb(ev.target.result); };
      fr.onerror = function () { cb(blob); };
      fr.readAsArrayBuffer(blob);
      return;
    } catch (e) { cb(blob); }
  }
  function doUpload(file) {
    if (!file || !S.room) return;
    var size = file.size || 0;
    if (size <= 0) { toast('文件为空'); return; }
    show('upBar', true);
    $('upBar').textContent = '正在上传 ' + (file.name || '文件') + '…';
    api('POST', '/api/files/init', {
      name: file.name || 'file', size: size,
      mime: file.type || 'application/octet-stream', roomId: S.room.id
    }, function (err, d) {
      if (err) { show('upBar', false); toast(err.message); return; }
      var fid = d.fileId, cs = d.chunkSize, total = Math.ceil(size / cs);
      if (!total) total = 1;
      next(0);
      function next(i) {
        if (i >= total) return finish();
        $('upBar').textContent = '上传中 ' + (i + 1) + '/' + total + ' …';
        readBlob(sliceBlob(file, i * cs, Math.min(size, (i + 1) * cs)), function (payload) {
          apiBinary('PUT', '/api/files/' + encodeURIComponent(fid) + '/chunk?i=' + i,
            payload, function (err2) {
              if (err2) { show('upBar', false); toast(err2.message); return; }
              next(i + 1);
            });
        });
      }
      function finish() {
        api('POST', '/api/files/' + encodeURIComponent(fid) + '/complete', {}, function (err3) {
          if (err3) { show('upBar', false); toast(err3.message); return; }
          api('POST', '/api/rooms/' + encodeURIComponent(S.room.id) + '/messages',
            { kind: 'file', fileId: fid }, function (err4, d4) {
              show('upBar', false);
              if (err4) { toast(err4.message); return; }
              renderMsgs([d4.message]);
              toast('文件已发送');
            });
        });
      }
    });
  }

  /* ================= 群 / 房间管理 ================= */

  function openMembers() {
    if (!S.room) return;
    api('GET', '/api/rooms/' + encodeURIComponent(S.room.id) + '/members', null, function (err, d) {
      if (err) { toast(err.message); return; }
      var h = '<div class="card"><div class="card-h">我在本房间的专属昵称</div><div class="row">' +
        '<div class="r-main"><div class="r-title">' +
        esc(d.myRoomNickname || '（未设置，显示全局昵称）') + '</div>' +
        '<div class="r-sub">只在本房间生效，不影响其它房间与全局昵称</div></div>' +
        '<div class="r-right">' + (d.dissolved ? '' : '<span class="mini" id="editRoomNick">修改</span>') +
        '</div></div></div>';
      h += '<div class="card"><div class="card-h">成员（' + d.members.length + ' 人）</div>';
      for (var i = 0; i < d.members.length; i++) {
        var m = d.members[i];
        h += '<div class="mrow"><span class="m-av" style="background:' +
          (m.avatarColor || colorOf(m.userId)) + '">' + esc(m.initial || '?') + '</span>' +
          '<span class="m-name">' + esc(m.displayName) +
          ' <span class="badge">' + esc(m.roleName) + '</span></span>';
        if (d.myRole === 'owner' && m.userId !== S.user.id && !d.dissolved) {
          h += '<span class="m-act" data-transfer="' + esc(m.userId) + '">转让群主</span>';
          h += '<span class="m-act" data-heir="' + esc(m.userId) + '">' +
            (m.userId === d.heirId ? '已设继承人' : '设为继承人') + '</span>';
        }
        h += '</div>';
      }
      h += '</div>';
      if (d.myRole === 'owner' && !d.dissolved) {
        h += '<div class="card"><div class="act danger" id="dissolveRoom">解散本群（不可恢复）</div></div>';
      }
      if (d.dissolved) h += '<div class="tip">该群已解散，仅可查看历史消息与解散通知</div>';
      openModal('成员管理', h, function () { return true; }, '关闭');
      bind('editRoomNick', changeRoomNick);
      bind('dissolveRoom', doDissolve);
      eachAttr($('modalBody'), 'data-heir', function (el, uid) {
        el.onclick = function () { doSetHeir(uid); };
      });
      eachAttr($('modalBody'), 'data-transfer', function (el, uid) {
        el.onclick = function () { doTransfer(uid); };
      });
    });
  }
  function changeRoomNick() {
    if (!S.room) return;
    var v = window.prompt('本房间昵称（2-20 位中英文/数字/下划线；留空恢复全局昵称）：', '');
    if (v === null) return;
    api('POST', '/api/rooms/' + encodeURIComponent(S.room.id) + '/nickname',
      { nickname: trim(v) }, function (err) {
        if (err) { toast(err.message); return; }
        toast('房间昵称已更新');
        openMembers();
      });
  }
  function doSetHeir(uid) {
    api('GET', '/api/rooms/' + encodeURIComponent(S.room.id) + '/members', null, function (err, d) {
      if (err) { toast(err.message); return; }
      var next = d.heirId === uid ? '' : uid;
      api('POST', '/api/rooms/' + encodeURIComponent(S.room.id) + '/heir',
        { heirId: next }, function (err2) {
          if (err2) { toast(err2.message); return; }
          toast(next ? '已设为遗产继承人' : '已取消遗产继承人');
          openMembers();
        });
    });
  }
  function doTransfer(uid) {
    if (!window.confirm('确定把群主权限转让给这位成员吗？转让后你将变为普通成员。')) return;
    api('POST', '/api/rooms/' + encodeURIComponent(S.room.id) + '/transfer',
      { userId: uid, confirm: true }, function (err) {
        if (err) { toast(err.message); return; }
        toast('群主权限已转让');
        closeModal();
        loadRooms(function () { openRoom(S.room.id); });
      });
  }
  function doDissolve() {
    var name = roomName(S.room.id);
    if (!window.confirm('解散后本群将停用，仅保留历史消息与解散通知，且不可恢复。\n\n确定解散吗？')) return;
    var typed = window.prompt('请输入房间名「' + name + '」以确认：');
    if (typed === null) return;
    if (trim(typed) !== name) { toast('房间名不符，已取消'); return; }
    api('POST', '/api/rooms/' + encodeURIComponent(S.room.id) + '/dissolve',
      { confirm: true }, function (err) {
        if (err) { toast(err.message); return; }
        toast('已解散');
        closeModal();
        loadRooms(function () { openRoom(S.room.id); });
      });
  }

  /* ================= 好友 / 私聊 ================= */

  function renderFriends() {
    api('GET', '/api/friends', null, function (err, d) {
      if (err) { toast(err.message); return; }
      var h = '<div class="card"><div class="card-h">找人</div><div class="row">' +
        '<input id="fq" class="inp" type="text" placeholder="输入账号或昵称搜索" style="width:64%;display:inline-block;margin:0">' +
        '<span id="fsearch" class="mini" style="height:40px;line-height:28px;vertical-align:top">搜索</span></div>' +
        '<div id="fresult"></div></div>';
      h += '<div class="card"><div class="card-h">收到的申请 (' + (d.incoming || []).length + ')</div>';
      var i;
      for (i = 0; i < (d.incoming || []).length; i++) {
        var q = d.incoming[i];
        h += '<div class="row"><div class="r-main"><div class="r-title">' + esc(q.nickname) + '</div>' +
          '<div class="r-sub">' + esc(q.username) + '</div></div><div class="r-right">' +
          '<span class="mini" data-accept="' + esc(q.id) + '">同意</span> ' +
          '<span class="mini red" data-reject="' + esc(q.id) + '">拒绝</span></div></div>';
      }
      if (!(d.incoming || []).length) h += '<div class="empty">暂无申请</div>';
      h += '</div>';
      h += '<div class="card"><div class="card-h">好友 (' + (d.friends || []).length + ')</div>';
      for (i = 0; i < (d.friends || []).length; i++) {
        var f = d.friends[i];
        h += '<div class="row"><div class="r-main"><div class="r-title">' + esc(f.nickname) + '</div>' +
          '<div class="r-sub">' + esc(f.username) + '</div></div><div class="r-right">' +
          '<span class="mini" data-dm="' + esc(f.id) + '">私聊</span></div></div>';
      }
      if (!(d.friends || []).length) h += '<div class="empty">还没有好友</div>';
      h += '</div>';
      $('view').innerHTML = h;
      bind('fsearch', function () {
        var q = trim($('fq').value);
        if (!q) return;
        api('GET', '/api/users?q=' + encodeURIComponent(q), null, function (err2, d2) {
          if (err2) { toast(err2.message); return; }
          var r = '<div class="card"><div class="card-h">搜索结果</div>';
          for (var j = 0; j < (d2.users || []).length; j++) {
            var u = d2.users[j];
            r += '<div class="row"><div class="r-main"><div class="r-title">' + esc(u.nickname) + '</div>' +
              '<div class="r-sub">' + esc(u.username) + '</div></div><div class="r-right">' +
              (u.friend ? '<span class="badge">已是好友</span>' :
                '<span class="mini" data-add="' + esc(u.id) + '">加好友</span>') +
              '</div></div>';
          }
          if (!(d2.users || []).length) r += '<div class="empty">没找到</div>';
          r += '</div>';
          $('fresult').innerHTML = r;
          eachAttr($('fresult'), 'data-add', function (el, uid) {
            el.onclick = function () {
              api('POST', '/api/friends/request', { userId: uid }, function (e3) {
                if (e3) { toast(e3.message); return; }
                toast('已发送好友申请');
              });
            };
          });
        });
      });
      eachAttr($('view'), 'data-accept', function (el, id) {
        el.onclick = function () {
          api('POST', '/api/friends/' + encodeURIComponent(id) + '/accept', {}, function () {
            toast('已同意'); renderFriends();
          });
        };
      });
      eachAttr($('view'), 'data-reject', function (el, id) {
        el.onclick = function () {
          api('POST', '/api/friends/' + encodeURIComponent(id) + '/reject', {}, function () {
            toast('已拒绝'); renderFriends();
          });
        };
      });
      eachAttr($('view'), 'data-dm', function (el, uid) {
        el.onclick = function () {
          api('GET', '/api/dm/' + encodeURIComponent(uid), null, function (e4, d4) {
            if (e4) { toast(e4.message); return; }
            openRoom(d4.room.id);
          });
        };
      });
    });
  }

  /* ================= 我的 / 账号 ================= */

  function renderMe() {
    var h = '<div class="card"><div class="card-h">账号信息</div><div class="row">' +
      '<div class="r-main"><div class="r-title">' + esc(S.user.nickname) + '</div>' +
      '<div class="r-sub">账号：' + esc(S.user.username) + '（不可修改）</div></div>' +
      '<div class="r-right"><span class="mini" id="editGlobalNick">改昵称</span></div></div></div>';
    h += '<div class="card"><div class="card-h">说明</div><div class="row"><div class="r-sub">' +
      '· 低配兼容版与标准版共用同一套账号、房间、消息、文件、昵称、转让、解散与通知数据<br>' +
      '· 全局昵称：所有地方显示；房间专属昵称：只在当前房间生效<br>' +
      '· 群主转让 / 解散会在对应房间发布系统通知</div></div></div>';
    h += '<div class="card"><div id="verInfo" class="act">查看线上版本</div></div>';
    // 网盘已内置在本站：只要版本接口没明确关闭就显示入口
    h += '<div class="card"><div class="act" id="dvEntry">我的网盘</div>' +
      '<div class="row"><div class="r-sub">聊天里发出的文件天然就在网盘里；支持上传、下载与回收站</div></div></div>';
    h += '<div class="card"><div class="act danger" id="logoutBtn">退出登录</div></div>';
    h += '<div class="card"><div class="act danger" id="deleteAccount">注销账号（不可恢复）</div></div>';
    $('view').innerHTML = h;
    bind('editGlobalNick', function () {
      var v = window.prompt('修改全局昵称（2-20 位中英文/数字/下划线）：', S.user.nickname || '');
      if (v === null) return;
      api('POST', '/api/me/nickname', { nickname: trim(v) }, function (err, d) {
        if (err) { toast(err.message); return; }
        S.user = d.user;
        $('tbUser').textContent = S.user.nickname;
        renderMe();
        toast('昵称已更新');
      });
    });
    bind('dvEntry', function () { switchView('drive'); });
    bind('verInfo', function () {
      api('GET', '/api/version', null, function (err, d) {
        if (err) { toast(err.message); return; }
        var notes = '';
        for (var i = 0; i < (d.version.notes || []).length; i++) {
          notes += '<div class="r-sub">· ' + esc(d.version.notes[i]) + '</div>';
        }
        openModal('线上版本', '<div class="row"><div class="r-title">v' + esc(d.version.name) +
          ' · 构建 ' + esc(d.build) + '</div>' + notes + '</div>', function () { return true; }, '关闭');
      });
    });
    bind('logoutBtn', function () {
      api('POST', '/api/logout', {}, function () {
        clearToken(); S.token = ''; S.user = null; S.room = null;
        screen('auth'); renderAuth();
      });
    });
    bind('deleteAccount', function () {
      if (!window.confirm('注销后账号、创建的群、发布的消息和文件将被永久删除，不可恢复。\n\n确定注销吗？')) return;
      var typed = window.prompt('请输入账号名「' + S.user.username + '」以确认：');
      if (typed === null) return;
      if (trim(typed) !== S.user.username) { toast('账号名不符，已取消'); return; }
      api('POST', '/api/account/delete', { confirm: true }, function (err) {
        if (err) { toast(err.message); return; }
        clearToken(); S.token = ''; S.user = null; S.room = null;
        toast('账号已注销');
        screen('auth'); renderAuth();
      });
    });
  }

  /* ================= 视图切换 ================= */

  /** 从聊天页返回时，主界面要重新渲染当前标签的内容，否则是一片空白 */
  function renderPublicHome() {
    $('view').innerHTML = '<div class="card"><div class="card-h">公共聊天室</div>' +
      '<div class="act" id="enterPub">进入公共聊天室</div></div>' +
      '<div class="card"><div class="row"><div class="r-sub">' +
      '底部导航可切换到房间 / 好友 / 我的；本页与标准版数据完全互通</div></div></div>';
    bind('enterPub', function () { openRoom(S.publicRoomId); });
  }
  function backToMain() {
    S.room = null;
    screen('main');
    if (S.view === 'rooms') loadRooms(renderRooms);
    else if (S.view === 'friends') renderFriends();
    else if (S.view === 'me') renderMe();
    else renderPublicHome();
  }

  function switchView(v) {
    S.view = v;
    var titles = { public: '公共聊天室', rooms: '房间', friends: '好友', drive: '我的网盘', me: '我的' };
    $('tbTitle').textContent = titles[v] || '轻聊';
    var navs = { public: 'navPublic', rooms: 'navRooms', friends: 'navFriends', drive: 'navDrive', me: 'navMe' };
    for (var k in navs) {
      if (navs.hasOwnProperty(k)) $(navs[k]).className = 'tb' + (k === v ? ' on' : '');
    }
    screen('main');
    if (v === 'public') openRoom(S.publicRoomId);
    else if (v === 'rooms') loadRooms(renderRooms);
    else if (v === 'friends') renderFriends();
    else if (v === 'drive') { renderDrive(); loadDriveFiles(); }
    else renderMe();
  }

  /* ================= 云网盘（低配版） ================= */

  /**
   * 与标准版共用同一批 /api/drive/* 接口与同一份文件数据，
   * 这里只做最保守的实现：无 emoji 图标、无动画、无弹层，全部行内按钮。
   */

  var DV_ICON = { image: '图', video: '视', audio: '音', doc: '文', archive: '压', other: '包' };

  function driveState() {
    if (!S.drive) {
      S.drive = { tab: 'files', keyword: '', page: 1, items: [], total: 0, pages: 1, upText: '' };
    }
    return S.drive;
  }

  function driveQuotaHtml() {
    var st = S.storage;
    if (!st) return '';
    var pct = Math.round(st.percent || 0);
    if (pct > 100) pct = 100;
    if (pct < 0) pct = 0;
    var color = pct >= 90 ? '#d1242f' : '#2f6fed';
    return '<div class="card"><div class="card-h">存储空间</div>' +
      '<div class="row"><div class="r-sub">' + esc(st.usedText) + ' / ' + esc(st.quotaText) +
      ' · 剩余 ' + esc(st.remainText) + '</div></div>' +
      '<div style="margin:0 12px 12px;height:8px;background:#e3e6ea;border-radius:4px;overflow:hidden">' +
      '<div style="height:8px;width:' + pct + '%;background:' + color + '"></div></div>' +
      '<div class="row"><div class="r-sub">聊天与网盘共用这 2GB</div></div></div>';
  }

  function driveRowHtml(it, mode) {
    var sub = '';
    if (mode === 'trash') {
      sub = '剩余 ' + (it.remainDays || 0) + ' 天 · ' + it.sizeText;
    } else {
      sub = it.sizeText + ' · ' + (it.typeLabel || '');
      if (it.fromChat && it.roomName) sub += ' · 来自 ' + it.roomName;
    }
    var right = mode === 'trash'
      ? '<span class="mini" id="dvrs_' + it.fileId + '">恢复</span> <span class="mini" id="dvpg_' + it.fileId + '">彻底删</span>'
      : '<span class="mini" id="dvdl_' + it.fileId + '">下载</span> <span class="mini" id="dvdel_' + it.fileId + '">删除</span>';
    return '<div class="card"><div class="row">' +
      '<div class="r-main"><div class="r-title">' + esc(it.name) + '</div>' +
      '<div class="r-sub">' + esc(sub) + '</div></div>' +
      '<div class="r-right">' + right + '</div>' +
      '</div></div>';
  }

  function drivePagerHtml() {
    var s = driveState();
    if (s.pages <= 1) return '';
    return '<div class="card"><div class="row">' +
      '<div class="r-main"><span class="mini" id="dvPrev">上一页</span></div>' +
      '<div class="r-right"><span class="r-sub">' + s.page + ' / ' + s.pages + '</span> ' +
      '<span class="mini" id="dvNext">下一页</span></div></div></div>';
  }

  function renderDrive() {
    var s = driveState();
    var h = driveQuotaHtml();

    if (s.tab === 'trash') {
      h += '<div class="card"><div class="row">' +
        '<div class="r-main"><div class="r-sub">回收站保留 30 天，到期自动彻底删除</div></div>' +
        '<div class="r-right"><span class="mini" id="dvBack">返回文件</span></div></div></div>';
      if (!s.items.length) h += '<div class="card"><div class="row"><div class="r-sub">回收站是空的</div></div></div>';
      for (var i = 0; i < s.items.length; i++) h += driveRowHtml(s.items[i], 'trash');
      h += drivePagerHtml();
      $('view').innerHTML = h;
      bindDriveTrashEvents();
      return;
    }

    h += '<div class="card"><div class="row">' +
      '<div class="r-main"><input id="dvSearch" class="inp" type="text" placeholder="搜索文件名" value="' + esc(s.keyword) + '"></div>' +
      '<div class="r-right"><span class="mini" id="dvGo">搜索</span></div></div>' +
      '<div class="row">' +
      '<div class="r-main"><span class="mini" id="dvUpBtn">上传文件</span> <span class="mini" id="dvTrashBtn">回收站</span></div>' +
      '<div class="r-right"><span class="r-sub" id="dvTotal">共 ' + s.total + ' 个</span></div></div>' +
      '<div id="dvUp" class="row hide"><div class="r-sub" id="dvUpText"></div></div>' +
      '<input id="dvFile" type="file" style="display:none">' +
      '</div>';

    if (!s.items.length) {
      h += '<div class="card"><div class="row"><div class="r-sub">还没有文件。点「上传文件」，或在聊天里发一个文件——它也会出现在这里。</div></div></div>';
    }
    for (var j = 0; j < s.items.length; j++) h += driveRowHtml(s.items[j], 'files');
    h += drivePagerHtml();

    $('view').innerHTML = h;
    bindDriveEvents();
  }

  function bindDriveEvents() {
    var s = driveState();
    if ($('dvGo')) {
      $('dvGo').onclick = function () {
        s.keyword = trim($('dvSearch').value);
        s.page = 1;
        loadDriveFiles();
      };
    }
    if ($('dvSearch')) {
      $('dvSearch').onkeydown = function (e) {
        if (e && e.keyCode === 13) { s.keyword = trim($('dvSearch').value); s.page = 1; loadDriveFiles(); }
      };
    }
    if ($('dvTrashBtn')) {
      $('dvTrashBtn').onclick = function () { s.tab = 'trash'; s.page = 1; loadDriveTrash(); };
    }
    if ($('dvUpBtn')) $('dvUpBtn').onclick = function () { $('dvFile').click(); };
    if ($('dvFile')) {
      $('dvFile').onchange = function () {
        var f = this.files && this.files[0];
        if (f) driveUpload(f);
      };
    }
    if ($('dvPrev')) {
      $('dvPrev').onclick = function () { if (s.page > 1) { s.page--; loadDriveFiles(); } };
    }
    if ($('dvNext')) {
      $('dvNext').onclick = function () { if (s.page < s.pages) { s.page++; loadDriveFiles(); } };
    }

    for (var i = 0; i < s.items.length; i++) {
      bindDriveRowActs(s.items[i], 'files');
    }
  }

  function bindDriveTrashEvents() {
    var s = driveState();
    if ($('dvBack')) $('dvBack').onclick = function () { s.tab = 'files'; s.page = 1; loadDriveFiles(); };
    if ($('dvPrev')) {
      $('dvPrev').onclick = function () { if (s.page > 1) { s.page--; loadDriveTrash(); } };
    }
    if ($('dvNext')) {
      $('dvNext').onclick = function () { if (s.page < s.pages) { s.page++; loadDriveTrash(); } };
    }
    for (var i = 0; i < s.items.length; i++) {
      bindDriveRowActs(s.items[i], 'trash');
    }
  }

  function bindDriveRowActs(it, mode) {
    if (mode === 'trash') {
      if ($('dvrs_' + it.fileId)) {
        $('dvrs_' + it.fileId).onclick = function () {
          api('POST', '/api/drive/trash/' + it.fileId + '/restore', {}, function (err) {
            if (err) { toast(err.message); return; }
            toast('已恢复');
            loadDriveTrash();
          });
        };
      }
      if ($('dvpg_' + it.fileId)) {
        $('dvpg_' + it.fileId).onclick = function () {
          if (!window.confirm('彻底删除后不可恢复，确定吗？')) return;
          api('DELETE', '/api/drive/trash/' + it.fileId, null, function (err) {
            if (err) { toast(err.message); return; }
            toast('已彻底删除');
            loadDriveTrash();
          });
        };
      }
      return;
    }
    if ($('dvdl_' + it.fileId)) {
      $('dvdl_' + it.fileId).onclick = function () {
        window.location.href = withShare(it.downloadUrl);
      };
    }
    if ($('dvdel_' + it.fileId)) {
      $('dvdel_' + it.fileId).onclick = function () {
        if (!window.confirm('将「' + it.name + '」移入回收站？\n\n30 天内可恢复。')) return;
        api('DELETE', '/api/drive/files/' + it.fileId, null, function (err) {
          if (err) { toast(err.message); return; }
          toast('已移入回收站');
          loadDriveFiles();
        });
      };
    }
  }

  function loadDriveFiles() {
    var s = driveState();
    s.tab = 'files';
    var qs = '?page=' + s.page + '&size=30';
    if (s.keyword) qs += '&keyword=' + encodeURIComponent(s.keyword);
    api('GET', '/api/drive/files' + qs, null, function (err, d) {
      if (err) { toast(err.message); return; }
      s.items = d.items || [];
      s.total = d.total || 0;
      s.pages = d.pages || 1;
      // 顺手刷新配额（服务端是权威值）
      api('GET', '/api/drive/storage', null, function (e2, st) {
        if (!e2 && st) S.storage = st;
        renderDrive();
      });
    });
  }

  function loadDriveTrash() {
    var s = driveState();
    s.tab = 'trash';
    api('GET', '/api/drive/trash?page=' + s.page + '&size=30', null, function (err, d) {
      if (err) { toast(err.message); return; }
      s.items = d.items || [];
      s.total = d.total || 0;
      s.pages = d.pages || 1;
      renderDrive();
    });
  }

  function driveShowUp(txt) {
    var box = $('dvUp');
    var el = $('dvUpText');
    if (!box || !el) return;
    if (!txt) { box.className = 'row hide'; el.textContent = ''; return; }
    box.className = 'row';
    el.textContent = txt;
  }

  function driveUpload(file) {
    var s = driveState();
    if (file.size > 200 * 1024 * 1024) { toast('文件超过 200MB 上限'); return; }
    if (S.storage && file.size > S.storage.remain) {
      toast('存储空间不足：剩余 ' + S.storage.remainText);
      return;
    }
    driveShowUp('准备上传 ' + file.name);

    api('POST', '/api/files/init', {
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      roomId: ''
    }, function (err, info) {
      if (err) { driveShowUp(''); toast(err.message); return; }
      var cs = info.chunkSize || 4194304;
      var total = info.totalChunks;
      var cur = 0;

      function loop() {
        if (cur >= total) return finish();
        var blob = file.slice(cur * cs, Math.min(file.size, (cur + 1) * cs));
        driveShowUp('上传 ' + file.name + ' ' + (cur + 1) + '/' + total);
        apiBinary('PUT', '/api/files/' + info.fileId + '/chunk?i=' + cur, blob, function (e2) {
          if (e2) { driveShowUp(''); toast(e2.message); return; }
          cur++;
          loop();
        });
      }

      function finish() {
        driveShowUp('合并中…');
        api('POST', '/api/files/' + info.fileId + '/complete', {}, function (e3, done) {
          if (e3) { driveShowUp(''); toast(e3.message); return; }
          if (done && done.storage) S.storage = done.storage;
          driveShowUp('');
          toast('上传完成');
          loadDriveFiles();
        });
      }
      loop();
    });
  }

  /* ================= 主题 ================= */

  function toggleTheme() {
    var dark = document.body.className === 'dark';
    document.body.className = dark ? '' : 'dark';
    try { localStorage.setItem('ll_lite_dark', dark ? '0' : '1'); } catch (e) { }
  }

  /* ================= 静态绑定 + 启动 ================= */

  function bindStatic() {
    bind('authTabLogin', function () { S.authMode = 'login'; renderAuth(); });
    bind('authTabReg', function () { S.authMode = 'reg'; renderAuth(); });
    var kinds = ['Password', 'Email', 'Otp', 'Wb'];
    for (var i = 0; i < kinds.length; i++) {
      (function (key) {
        bind('mode' + key, function () {
          S.authKind = key.toLowerCase();
          renderAuth();
        });
      })(kinds[i]);
    }
    bind('ab', doAuth);
    bind('acode', sendCode);
    bind('awb', doWorkBuddy);
    bind('navPublic', function () { switchView('public'); });
    bind('navRooms', function () { switchView('rooms'); });
    bind('navFriends', function () { switchView('friends'); });
    bind('navMe', function () { switchView('me'); });
    bind('themeBtn', toggleTheme);
    bind('backBtn', backToMain);
    bind('memberBtn', openMembers);
    bind('joinBtn', function () {
      if (!S.room) return;
      joinRoom(S.room.id, function () { openRoom(S.room.id); });
    });
    bind('sendBtn', sendMsg);
    bind('modalCancel', closeModal);
    bind('modalOk', function () {
      if (modalCb) { var keep = modalCb(); if (keep === false) return; }
      closeModal();
    });
    var mi = $('msgInput');
    if (mi) mi.onkeydown = function (e) {
      var k = e ? (e.keyCode || e.which) : window.event ? window.event.keyCode : 0;
      if (k === 13) { sendMsg(); return false; }
    };
    var fi = $('fileInput');
    if (fi) fi.onchange = function () {
      var f = (this.files && this.files[0]) || null;
      if (f) doUpload(f);
      try { this.value = ''; } catch (e2) { }
    };
  }

  function boot() {
    try {
      var m = String(location.search || '').match(/[?&]wl_token=([^&]+)/);
      if (m) { S.token = [已隐去](m[1]); saveToken(S.token); }
    } catch (e) { }
    try { if (localStorage.getItem('ll_lite_dark') === '1') document.body.className = 'dark'; }
    catch (e2) { }

    /* 关键：每一步单独 try/catch。
       老内核里只要有一处抛异常，后面的绑定就会全部跳过 ——
       表现正是「页面出来了，但所有按钮都点不动」。
       先保证按钮都绑上（ready），再谈数据加载。 */
    try { renderAuth(); } catch (e3) { pushErr('renderAuth', e3); }
    try { bindStatic(); } catch (e4) { pushErr('bindStatic', e4); }

    /* 到这里按钮已经能点了，标记初始化完成：守门脚本不会再降级到基础版 */
    try { if (window.__LL_LITE) window.__LL_LITE.ready = 1; } catch (e5) { }

    // 版本与能力标记（公开接口，不需要登录）
    api('GET', '/api/version', null, function (err0, d0) {
      if (!err0 && d0) S.version = d0;
    });

    if (!S.token) { screen('auth'); return; }
    api('GET', '/api/me', null, function (err, d) {
      if (err) { clearToken(); S.token = ''; screen('auth'); return; }
      S.user = d.user;
      $('tbUser').textContent = S.user.nickname || S.user.username;
      screen('main');
      loadRooms(function () { switchView(S.view); });
    });
    /* 全局轮询：低配设备同样能收到新消息与系统通知 */
    try { setInterval(pull, 3000); } catch (e6) { }
  }

  function pushErr(where, e) {
    try {
      if (window.__LL_LITE) {
        window.__LL_LITE.err.push('[' + where + '] ' + (e && e.message));
      }
    } catch (e2) { }
  }

  boot();
})();
