/* 轻聊云网盘 · 前端
   约束：纯 ES5 + XMLHttpRequest，不用 fetch / Promise / classList / dataset / querySelector，
   兼容 Chrome 49 / Safari 9 / 老 Android WebView。 */
(function () {
  'use strict';

  var API = '/api';
  var SMALL_LIMIT = 8 * 1024 * 1024;   // 8MB 以下直传，以上走分片
  var CHUNK = 5 * 1024 * 1024;

  var S = {
    token: '',
    refresh: '',
    user: null,
    page: 1,
    size: 20,
    total: 0,
    list: [],
    uploading: null
  };

  /* ---------------- 基础工具 ---------------- */

  function $(id) { return document.getElementById(id); }
  function bind(id, fn) { var e = $(id); if (e) e.onclick = fn; return e; }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtTime(t) {
    if (!t) return '';
    var d = new Date(t);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function iconOf(type) {
    if (type === 'image') return '🖼';
    if (type === 'video') return '🎬';
    if (type === 'audio') return '🎵';
    if (type === 'document') return '📄';
    if (type === 'archive') return '📦';
    return '📎';
  }

  /* 本地存储：老容器可能禁用 DOM Storage，全部 try/catch + cookie 兜底 */
  function setItem(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { /* ignore */ }
    try { document.cookie = k + '=' + encodeURIComponent(v) + '; path=/; max-age=2592000'; } catch (e) { }
  }
  function getItem(k) {
    try {
      var v = localStorage.getItem(k);
      if (v) return v;
    } catch (e) { /* ignore */ }
    try {
      var m = document.cookie.match(new RegExp('(?:^|; )' + k + '=([^;]*)'));
      if (m) return decodeURIComponent(m[1]);
    } catch (e) { }
    return '';
  }
  function removeItem(k) {
    try { localStorage.removeItem(k); } catch (e) { }
    try { document.cookie = k + '=; path=/; max-age=0'; } catch (e) { }
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast hide'; }, ms || 2600);
  }

  var dlgOk = null;
  function dialog(title, bodyHtml, onOk, okText) {
    $('dlgTitle').textContent = title;
    $('dlgBody').innerHTML = bodyHtml;
    $('dlgOk').textContent = okText || '确定';
    dlgOk = onOk || null;
    $('mask').className = 'mask';
    var first = $('dlgBody').getElementsByTagName('input')[0];
    if (first) { try { first.focus(); } catch (e) { } }
  }
  function closeDialog() { $('mask').className = 'mask hide'; dlgOk = null; }

  /* ---------------- HTTP ---------------- */

  function parse(xhr, cb) {
    var raw = xhr.responseText || '';
    var j = null;
    try { j = JSON.parse(raw); } catch (e) { j = null; }
    if (!j) return cb({ code: -1, message: '服务器返回异常（HTTP ' + xhr.status + '）' }, null);
    if (j.code === 0) return cb(null, j.data);
    cb({ code: j.code, message: j.message || '请求失败', data: j.data }, null);
  }

  function api(method, path, body, cb, opt) {
    opt = opt || {};
    var xhr = new XMLHttpRequest();
    xhr.open(method, API + path, true);
    if (S.token) xhr.setRequestHeader('Authorization', 'Bearer ' + S.token);
    var payload = null;
    if (body !== undefined && body !== null) {
      payload = JSON.stringify(body);
      xhr.setRequestHeader('Content-Type', 'application/json');
    }
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status === 401 && !opt.retried && S.refresh) {
        return refreshToken(function (okRefresh) {
          if (!okRefresh) return logout();
          opt.retried = true;
          api(method, path, body, cb, opt);
        });
      }
      parse(xhr, cb);
    };
    xhr.onerror = function () { cb({ code: -1, message: '网络错误，请检查连接' }, null); };
    xhr.send(payload);
  }

  function refreshToken(cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', API + '/auth/refresh', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var okRefresh = false;
      try {
        var j = JSON.parse(xhr.responseText);
        if (j && j.code === 0 && j.data && j.data.accessToken) {
          S.token = j.data.accessToken;
          S.refresh = j.data.refreshToken;
          setItem('nd_token', S.token);
          setItem('nd_refresh', S.refresh);
          okRefresh = true;
        }
      } catch (e) { }
      cb(okRefresh);
    };
    xhr.onerror = function () { cb(false); };
    xhr.send(JSON.stringify({ refreshToken: S.refresh }));
  }

  /* ---------------- 登录 ---------------- */

  function doLogin() {
    var u = $('u').value.replace(/^\s+|\s+$/g, '');
    var p = $('p').value;
    if (!u || !p) { $('err').textContent = '请填写账号和密码'; return; }
    $('err').textContent = '';
    $('loginBtn').disabled = true;
    api('POST', '/auth/login', { username: u, password: p }, function (err, d) {
      $('loginBtn').disabled = false;
      if (err) { $('err').textContent = err.message; return; }
      S.token = d.accessToken;
      S.refresh = d.refreshToken;
      S.user = d.user;
      setItem('nd_token', S.token);
      setItem('nd_refresh', S.refresh);
      enterApp();
    });
  }

  function logout() {
    S.token = ''; S.refresh = ''; S.user = null;
    removeItem('nd_token'); removeItem('nd_refresh');
    $('main').className = 'wrap hide';
    $('top').className = 'top hide';
    $('auth').className = 'auth';
  }

  function enterApp() {
    $('auth').className = 'auth hide';
    $('top').className = 'top';
    $('main').className = 'wrap';
    $('who').textContent = (S.user && (S.user.nickname || S.user.username)) || '';
    loadFiles(1);
  }

  /* ---------------- 存储信息 ---------------- */

  function renderStorage(st) {
    if (!st) return;
    var pct = Math.round(Math.min(100, (st.usedBytes / st.totalBytes) * 100));
    $('used').textContent = fmtSize(st.usedBytes) + ' / ' + fmtSize(st.totalBytes);
    $('remain').textContent = '剩余 ' + fmtSize(st.remainingBytes);
    $('quotaFill').style.width = pct + '%';
    $('quotaFill').className = 'fill' + (pct >= 90 ? ' warn' : '');
  }

  /* ---------------- 列表 ---------------- */

  function loadFiles(page) {
    S.page = page || 1;
    var q = '?page=' + S.page + '&size=' + S.size;
    var kw = $('kw').value.replace(/^\s+|\s+$/g, '');
    if (kw) q += '&keyword=' + encodeURIComponent(kw);
    if ($('type').value) q += '&type=' + $('type').value;
    if ($('sort').value) q += '&sort=' + $('sort').value;

    api('GET', '/files' + q, null, function (err, d) {
      if (err) { toast(err.message); return; }
      S.total = d.total;
      renderStorage(d.storage);
      if (S.page === 1) S.list = d.list.slice();
      else S.list = S.list.concat(d.list);
      renderList();
    });
  }

  function renderList() {
    var box = $('list');
    if (!S.list.length) {
      box.innerHTML = '<div class="empty">还没有文件<br>点右上角「上传」传第一个吧</div>';
      $('more').className = 'more hide';
      return;
    }
    var h = '';
    for (var i = 0; i < S.list.length; i++) {
      var f = S.list[i];
      h += '<div class="file" data-id="' + esc(f.fileId) + '">' +
        '<div class="ico ' + esc(f.fileType) + '">' + iconOf(f.fileType) + '</div>' +
        '<div class="meta">' +
        '<div class="nm">' + esc(f.fileName) + '</div>' +
        '<div class="sub">' + fmtSize(f.fileSize) + ' · ' + fmtTime(f.uploadTime) +
        (f.folder ? ' · ' + esc(f.folder) : '') + '</div>' +
        '</div>' +
        '<div class="ops">' +
        '<button data-op="dl">下载</button>' +
        '<button data-op="share">分享</button>' +
        '<button data-op="rename">改名</button>' +
        '<button data-op="del" class="del">删除</button>' +
        '</div></div>';
    }
    box.innerHTML = h;
    $('more').className = 'more' + (S.list.length < S.total ? '' : ' hide');
  }

  /** 用事件委托处理列表按钮（避免给每行都绑事件，老设备更省） */
  function onListClick(e) {
    var el = e.target || e.srcElement;
    var op = el.getAttribute && el.getAttribute('data-op');
    if (!op) return;
    var row = el;
    while (row && row.getAttribute && !row.getAttribute('data-id')) row = row.parentNode;
    if (!row || !row.getAttribute) return;
    var id = row.getAttribute('data-id');
    var f = null;
    for (var i = 0; i < S.list.length; i++) if (S.list[i].fileId === id) f = S.list[i];
    if (!f) return;
    if (op === 'dl') doDownload(f);
    else if (op === 'share') doShare(f);
    else if (op === 'rename') doRename(f);
    else if (op === 'del') doDelete(f);
  }

  function doDownload(f) {
    api('GET', '/files/' + f.fileId, null, function (err, d) {
      if (err) { toast(err.message); return; }
      window.location.href = d.downloadUrl;
    });
  }

  function doShare(f) {
    dialog('分享文件',
      '<div>' + esc(f.fileName) + '</div>' +
      '<input id="shareDays" type="number" value="7" placeholder="有效天数">' +
      '<input id="shareCode" type="text" placeholder="提取码（留空=公开）" maxlength="8">',
      function () {
        var days = Number($('shareDays').value) || 7;
        var code = $('shareCode').value.replace(/^\s+|\s+$/g, '');
        closeDialog();
        api('POST', '/files/' + f.fileId + '/share', { expireDays: days, extractCode: code }, function (err, d) {
          if (err) { toast(err.message); return; }
          var url = window.location.protocol + '//' + window.location.host + d.shareUrl;
          var text = url + (d.hasCode ? '　提取码：' + code : '');
          dialog('分享链接', '<div style="word-break:break-all">' + esc(text) + '</div>', function () {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text);
              toast('已复制到剪贴板');
            } else {
              window.prompt('复制下面的链接：', text);
            }
            closeDialog();
          }, '复制');
        });
      }, '生成分享');
  }

  function doRename(f) {
    dialog('重命名',
      '<input id="newName" type="text" value="' + esc(f.fileName) + '">',
      function () {
        var v = $('newName').value.replace(/^\s+|\s+$/g, '');
        if (!v) { toast('文件名不能为空'); return; }
        closeDialog();
        api('PATCH', '/files/' + f.fileId, { fileName: v }, function (err) {
          if (err) { toast(err.message); return; }
          toast('已重命名');
          loadFiles(1);
        });
      }, '保存');
  }

  function doDelete(f) {
    dialog('删除文件',
      '<div>「' + esc(f.fileName) + '」<br>删除后进入回收站，30 天后彻底清除，期间占用配额。</div>',
      function () {
        closeDialog();
        api('DELETE', '/files/' + f.fileId, null, function (err) {
          if (err) { toast(err.message); return; }
          toast('已删除');
          loadFiles(1);
        });
      }, '删除');
  }

  /* ---------------- 上传 ---------------- */

  function onPick() {
    var input = $('pick');
    var files = input.files;
    if (!files || !files.length) return;
    var arr = [];
    for (var i = 0; i < files.length; i++) arr.push(files[i]);
    input.value = '';
    uploadNext(arr, 0);
  }

  function uploadNext(arr, idx) {
    if (idx >= arr.length) { $('upbar').className = 'upbar hide'; loadFiles(1); return; }
    var file = arr[idx];
    $('upbar').className = 'upbar';
    $('upFill').style.width = '0%';
    $('upTxt').textContent = '上传中 (' + (idx + 1) + '/' + arr.length + ') ' + file.name;
    if (file.size > 200 * 1024 * 1024) {
      toast('「' + file.name + '」超过 200MB 上限，已跳过');
      return uploadNext(arr, idx + 1);
    }
    if (file.size > SMALL_LIMIT) chunkedUpload(file, function () { uploadNext(arr, idx + 1); });
    else singleUpload(file, function () { uploadNext(arr, idx + 1); });
  }

  function singleUpload(file, done) {
    var xhr = new XMLHttpRequest();
    S.uploading = xhr;
    xhr.open('POST', API + '/files/upload', true);
    xhr.setRequestHeader('Authorization', 'Bearer ' + S.token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('X-File-Size', String(file.size));
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable) return;
      $('upFill').style.width = Math.round(e.loaded / e.total * 100) + '%';
    };
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      S.uploading = null;
      parse(xhr, function (err, d) {
        if (err) { toast('「' + file.name + '」上传失败：' + err.message, 4000); return done(); }
        renderStorage(d.storage);
        toast('「' + file.name + '」已上传');
        done();
      });
    };
    xhr.onerror = function () { S.uploading = null; toast('网络错误，上传中断', 3500); done(); };
    xhr.send(file);
  }

  function chunkedUpload(file, done) {
    var resumeKey = 'nd_up_' + file.name + '_' + file.size;
    var resumeId = getItem(resumeKey);
    var body = { fileName: file.name, fileSize: file.size, chunkSize: CHUNK };
    if (resumeId) body.resumeUploadId = resumeId;

    api('POST', '/files/upload/init', body, function (err, d) {
      if (err) { toast('「' + file.name + '」上传失败：' + err.message, 4000); return done(); }
      setItem(resumeKey, d.uploadId);
      var chunkSize = d.chunkSize;
      var total = d.totalChunks;
      var received = {};
      for (var i = 0; i < d.received.length; i++) received[d.received[i]] = 1;

      var idx = 0;
      function loop() {
        while (idx < total && received[idx]) idx++;
        if (idx >= total) return finish(d.uploadId);
        var cur = idx;
        var start = cur * chunkSize;
        var end = Math.min(file.size, start + chunkSize);
        putChunk(d.uploadId, cur, file.slice(start, end), chunkSize, function (ok) {
          if (!ok) { toast('上传中断，稍后可从断点继续', 3500); return done(); }
          received[cur] = 1;
          idx = cur + 1;
          loop();
        });
      }
      function finish(uploadId) {
        $('upTxt').textContent = '合并文件中…';
        api('POST', '/files/upload/' + uploadId + '/complete', null, function (err2, d2) {
          removeItem(resumeKey);
          if (err2) { toast('「' + file.name + '」合并失败：' + err2.message, 4000); return done(); }
          renderStorage(d2.storage);
          toast('「' + file.name + '」已上传');
          done();
        });
      }
      loop();
    });
  }

  function putChunk(uploadId, index, blob, chunkSize, cb) {
    var xhr = new XMLHttpRequest();
    S.uploading = xhr;
    xhr.open('PUT', API + '/files/upload/' + uploadId + '/chunk?i=' + index, true);
    xhr.setRequestHeader('Authorization', 'Bearer ' + S.token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable) return;
      var pct = Math.round(e.loaded / e.total * 100);
      $('upFill').style.width = Math.min(99, pct) + '%';
    };
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      S.uploading = null;
      cb(xhr.status === 200);
    };
    xhr.onerror = function () { S.uploading = null; cb(false); };
    xhr.send(blob);
  }

  /* ---------------- 启动 ---------------- */

  bind('loginBtn', doLogin);
  bind('logout', logout);
  bind('dlgOk', function () { var fn = dlgOk; if (fn) { fn(); } else { closeDialog(); } });
  bind('dlgCancel', closeDialog);
  bind('pick', null);
  $('pick').onchange = onPick;
  bind('moreBtn', function () { loadFiles(S.page + 1); });
  bind('upCancel', function () {
    if (S.uploading) { try { S.uploading.abort(); } catch (e) { } }
    S.uploading = null;
    $('upbar').className = 'upbar hide';
    toast('已取消上传');
  });
  bind('kw', null);
  $('kw').onkeydown = function (e) { if (e.keyCode === 13) loadFiles(1); };
  $('type').onchange = function () { loadFiles(1); };
  $('sort').onchange = function () { loadFiles(1); };
  $('list').onclick = onListClick;
  $('p').onkeydown = function (e) { if (e.keyCode === 13) doLogin(); };
  $('u').onkeydown = function (e) { if (e.keyCode === 13) $('p').focus(); };
  $('mask').onclick = function (e) {
    if ((e.target || e.srcElement) === $('mask')) closeDialog();
  };

  // 恢复登录态
  S.token = getItem('nd_token');
  S.refresh = getItem('nd_refresh');
  if (S.token) {
    api('GET', '/me', null, function (err, d) {
      if (err) { logout(); return; }
      S.user = d.user;
      enterApp();
      renderStorage(d.storage);
    });
  }
})();
