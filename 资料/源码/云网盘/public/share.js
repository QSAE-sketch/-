/* 分享页：纯 ES5 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
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
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast';
    setTimeout(function () { t.className = 'toast hide'; }, 2600);
  }
  function iconOf(type) {
    if (type === 'image') return '🖼';
    if (type === 'video') return '🎬';
    if (type === 'audio') return '🎵';
    if (type === 'document') return '📄';
    if (type === 'archive') return '📦';
    return '📎';
  }

  var shareId = '';
  var m = String(location.pathname).match(/\/s\/([A-Za-z0-9_]+)/);
  if (m) shareId = m[1];

  var state = { info: null, needCode: false };

  function load(code) {
    var xhr = new XMLHttpRequest();
    var q = '/api/shares/' + shareId + (code ? '?code=' + encodeURIComponent(code) : '');
    xhr.open('GET', q, true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var j = null;
      try { j = JSON.parse(xhr.responseText); } catch (e) { j = null; }
      if (!j) { $('name').textContent = '加载失败'; return; }
      if (j.code !== 0) {
        if (j.data && j.data.needCode) {
          state.needCode = true;
          state.info = { fileName: j.data.fileName, fileSize: 0, fileType: 'other' };
          $('name').textContent = j.data.fileName;
          $('sub').textContent = '需要提取码才能下载';
          $('codeBox').style.display = '';
          $('icon').textContent = iconOf('other');
          if (code) toast('提取码不正确');
          return;
        }
        $('name').textContent = j.message || '分享不可用';
        $('sub').textContent = '链接可能已过期或被取消';
        $('dl').disabled = true;
        return;
      }
      state.info = j.data;
      $('icon').textContent = iconOf(j.data.fileType);
      $('name').textContent = j.data.fileName;
      $('sub').textContent = fmtSize(j.data.fileSize) + ' · 来自 ' + (j.data.owner || '轻聊用户') +
        ' · 已下载 ' + (j.data.downloadCount || 0) + ' 次';
      $('codeBox').style.display = 'none';
      $('tip').textContent = '有效期至 ' + new Date(j.data.expireTime).toLocaleString();
      $('dl').disabled = false;
    };
    xhr.onerror = function () { $('name').textContent = '网络错误'; };
    xhr.send(null);
  }

  $('dl').onclick = function () {
    if (state.needCode && !state.info) return;
    if (state.needCode) {
      var code = $('code').value.replace(/^\s+|\s+$/g, '');
      if (!code) { toast('请输入提取码'); return; }
      window.location.href = '/api/shares/' + shareId + '/download?code=' + encodeURIComponent(code);
      return;
    }
    window.location.href = state.info.downloadUrl;
  };
  $('code').onkeydown = function (e) {
    if (e.keyCode !== 13) return;
    var code = $('code').value.replace(/^\s+|\s+$/g, '');
    if (!code) { toast('请输入提取码'); return; }
    load(code);
  };

  if (!shareId) { $('name').textContent = '分享链接不完整'; }
  else load('');
})();
