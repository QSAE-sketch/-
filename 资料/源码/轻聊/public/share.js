'use strict';
/* 分享落地页：纯 ES5，兼容老内核。接口走现有 /api/drive/s/:sid（无需登录）。 */
(function () {
  function $(id) { return document.getElementById(id); }
  function toast(msg) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg; t.className = 'toast';
    setTimeout(function () { t.className = 'toast hide'; }, 2600);
  }
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }
  function iconOf(type) {
    if (type === 'image') return '🖼';
    if (type === 'video') return '🎬';
    if (type === 'audio') return '🎵';
    if (type === 'doc') return '📄';
    if (type === 'archive') return '📦';
    return '📎';
  }
  /* 线上发布平台校验 sharecode：同源 API 请求也要带上，否则被判「链接不完整」 */
  function withShare(path) {
    try {
      var m = String(location.search || '').match(/[?&](sharecode=[^&]+)/);
      if (!m) return path;
      return path + (path.indexOf('?') >= 0 ? '&' : '?') + m[1];
    } catch (e) { return path; }
  }

  var shareId = '';
  try {
    var m = String(location.pathname || '').match(/^\/s\/([A-Za-z0-9_]+)\/?$/);
    if (m) shareId = m[1];
  } catch (e) {}

  var state = { needCode: false };

  function showErr(msg) {
    $('name').textContent = msg;
    $('err').textContent = '';
    $('dl').disabled = true;
  }

  function load(code) {
    var xhr;
    try { xhr = new XMLHttpRequest(); } catch (e) { showErr('浏览器不支持'); return; }
    var q = '/api/drive/s/' + encodeURIComponent(shareId) + (code ? '?code=' + encodeURIComponent(code) : '');
    xhr.open('GET', withShare(q), true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var j = null;
      try { j = JSON.parse(xhr.responseText); } catch (e) { j = null; }
      if (!j) { showErr('加载失败'); return; }

      // 需要提取码：后端未通过校验但仍返回 200 + passed:false / needCode:true
      if (j.ok && j.needCode && !j.passed) {
        state.needCode = true;
        $('icon').textContent = '🔒';
        $('name').textContent = j.fileName || '受保护的文件';
        $('sub').textContent = '这是一个需要提取码的分享';
        $('codeBox').className = 'share-code';
        $('err').textContent = code ? '提取码不正确，请重试' : '';
        $('dl').disabled = false;
        $('dl').textContent = '确 认';
        $('foot').textContent = '来自 ' + (j.ownerName || '轻聊用户');
        return;
      }

      // 失败：过期 / 取消 / 删除 / 提取码错
      if (!j.ok || (j.passed === false && !j.needCode)) {
        $('codeBox').className = 'share-code hide';
        showErr(j.error || '分享不可用');
        $('sub').textContent = '链接可能已过期、被取消，或提取码错误';
        return;
      }

      // 成功
      state.needCode = false;
      $('icon').textContent = iconOf(j.fileType);
      $('name').textContent = j.fileName || '文件';
      $('sub').textContent = fmtSize(j.fileSize) + ' · 来自 ' + (j.ownerName || '轻聊用户') +
        ' · 已下载 ' + (j.downloads || 0) + ' 次';
      $('codeBox').className = 'share-code hide';
      $('err').textContent = '';
      $('dl').disabled = false;
      $('dl').textContent = '下 载';
      state.downloadUrl = j.downloadUrl;
      if (j.expireAt) {
        try { $('foot').textContent = '有效期至 ' + new Date(j.expireAt).toLocaleString(); }
        catch (e) { $('foot').textContent = '分享链接来自轻聊'; }
      }
    };
    xhr.onerror = function () { showErr('网络错误'); };
    try { xhr.send(null); } catch (e) { showErr('请求失败'); }
  }

  function doDownload() {
    if (state.needCode) {
      var code = String($('code').value || '').replace(/^\s+|\s+$/g, '');
      if (!code) { toast('请输入提取码'); return; }
      load(code);   // 带码重新校验，通过后按钮变为「下载」
      return;
    }
    if (!state.downloadUrl) { toast('下载链接不可用'); return; }
    window.location.href = withShare(state.downloadUrl);
  }

  $('dl').onclick = doDownload;
  $('code').onkeydown = function (e) { if (e && (e.keyCode === 13 || e.key === 'Enter')) doDownload(); };

  if (!shareId) showErr('分享链接不完整');
  else load('');
})();
