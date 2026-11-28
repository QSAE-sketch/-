/* 轻聊 · 反馈箱适配器（参考天线 OPENWIRE 设计，保留原有功能） */
/* 复制自 /c/Users/Administrator/Documents/Trae-CN/temp_20261121_01/openwire/public/app.js 并适配 */
(function () {
  'use strict';

  /* ---------------- 反馈箱 HTML 注入 ---------------- */
  function injectFeedbackModals() {
    if (document.getElementById('feedbackModal')) return; // 已注入

    var html = '\
<!-- 反馈箱主面板 -->\
<div class="modal" id="feedbackModal" role="dialog" aria-modal="true" aria-labelledby="feedbackTitle" data-open="false">\
  <div class="modal-card modal-wide">\
    <h2 id="feedbackTitle">反馈箱</h2>\
    <p class="modal-sub" id="feedbackSub">这里可以看到你提交的问题和官方的回复。</p>\
    <div class="list" id="feedbackList"></div>\
    <div class="modal-actions" style="margin-top:16px">\
      <button class="btn btn-sm" type="button" data-close="feedbackModal">关闭</button>\
      <button class="btn btn-sm btn-primary" type="button" id="btnNewFeedback">提交反馈</button>\
    </div>\
  </div>\
</div>\
\
<!-- 提交反馈表单 -->\
<div class="modal" id="feedbackFormModal" role="dialog" aria-modal="true" aria-labelledby="feedbackFormTitle" data-open="false">\
  <div class="modal-card">\
    <h2 id="feedbackFormTitle">提交反馈</h2>\
    <p class="modal-sub">描述遇到的问题或想要的功能，官方账号会看到并回复，结果会出现在你的反馈箱里。</p>\
    <div class="field">\
      <label for="feedbackInputTitle">标题</label>\
      <input type="text" id="feedbackInputTitle" maxlength="60" placeholder="一句话说明问题">\
    </div>\
    <div class="field">\
      <label for="feedbackInputBody">详细描述</label>\
      <textarea id="feedbackInputBody" maxlength="2000" rows="4" style="width:100%;min-height:96px;resize:vertical" placeholder="发生了什么、在哪个页面、你期望的结果"></textarea>\
    </div>\
    <div class="error" id="feedbackFormError" hidden></div>\
    <div class="modal-actions">\
      <button class="btn btn-sm" type="button" data-close="feedbackFormModal">取消</button>\
      <button class="btn btn-sm btn-primary" type="button" id="btnSubmitFeedback">提交</button>\
    </div>\
  </div>\
</div>';

    var container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
  }

  /* ---------------- 反馈箱核心逻辑 ---------------- */
  function loadFeedback(mark) {
    // mark=true: 官方视角（显示全部待处理）；mark=false: 用户视角（只显示自己的）
    var url = '/api/feedback/mine' + (mark ? '?admin=1' : '');
    return api('GET', url, null).then(function (d) {
      var isAdmin = !!(d && d.isAdmin);
      var sub = document.getElementById('feedbackSub');
      if (sub) {
        sub.textContent = isAdmin
          ? '所有用户提交的反馈都在这里；填写回复后会标记为已处理，并出现在对方的反馈箱。'
          : '这里可以看到你提交的问题和官方的回复。';
      }
      var newBtn = document.getElementById('btnNewFeedback');
      if (newBtn) newBtn.hidden = isAdmin;
      renderFeedback(d.feedback || [], isAdmin);
      return d;
    });
  }

  function renderFeedback(items, isAdmin) {
    var list = document.getElementById('feedbackList');
    if (!list) return;
    list.innerHTML = '';
    if (!items.length) {
      list.appendChild(el('div', 'empty', isAdmin ? '暂时没有用户反馈。' : '你还没有提交过反馈。'));
      return;
    }
    items.forEach(function (f) {
      var card = el('div', 'fb-card');
      var head = el('div', 'fb-head');
      var title = f.title || '无标题';
      // 类型徽章
      var typeMap = { bug: '问题', idea: '建议', complaint: '举报' };
      var typeLabel = typeMap[f.type] || f.type;
      var typeClass = f.type === 'complaint' ? 'warn' : f.type === 'idea' ? 'ok' : 'gray';
      head.appendChild(el('span', 'fb-title', title));
      head.appendChild(el('span', 'tag is-' + typeClass, typeLabel));
      // 状态
      var statusLabel = f.status === 'replied' ? '已回复' : '处理中';
      var statusClass = f.status === 'replied' ? 'is-mint' : 'is-pink';
      head.appendChild(el('span', 'tag ' + statusClass, statusLabel));
      card.appendChild(head);

      // 元信息：官方视角显示用户名
      var meta = '';
      if (isAdmin && f.userName) {
        meta = esc(f.userName) + '（' + esc(f.userId || '') + '） · ';
      }
      meta += dateLabel(f.createdAt) + ' ' + fmtTime(f.createdAt);
      card.appendChild(el('div', 'fb-meta', meta));

      // 内容
      card.appendChild(el('div', 'fb-body', f.content || ''));

      // 关联消息（举报类型）
      if (f.refId && f.refKind) {
        var ref = el('div', 'fb-ref', '关联：' + esc(f.refKind) + ' #' + esc(f.refId));
        card.appendChild(ref);
      }

      // 官方回复
      if (f.reply) {
        var rep = el('div', 'fb-reply');
        rep.appendChild(el('div', 'fb-reply-label', '官方回复'));
        rep.appendChild(el('div', 'fb-reply-text', esc(f.reply)));
        card.appendChild(rep);
      }

      // 官方处理区：待处理时显示回复输入框
      if (isAdmin && f.status === 'open') {
        var ta = document.createElement('textarea');
        ta.className = 'fb-reply-input';
        ta.placeholder = '填写处理结果或回复内容…';
        var btn = el('button', 'btn btn-sm btn-primary', '回复并标记已处理');
        btn.type = 'button';
        btn.addEventListener('click', function () {
          var text = ta.value.trim();
          if (!text) { toast('请填写回复内容。'); return; }
          btn.disabled = true;
          api('POST', '/api/feedback/' + f.id + '/reply', { reply: text }).then(function () {
            toast('已回复并标记为已处理。');
            return loadFeedback(true);
          }).catch(function (err) {
            if (err && err.status === 401) return;
            toast(err.message || '回复失败。');
          }).then(function () { btn.disabled = false; });
        });
        card.appendChild(ta);
        card.appendChild(btn);
      }

      list.appendChild(card);
    });
  }

  function openFeedback() {
    injectFeedbackModals();
    openModal('feedbackModal');
    loadFeedback(true).catch(function (err) {
      if (err && err.status === 401) return;
      toast(err.message || '反馈箱加载失败。');
    });
  }

  function openFeedbackForm() {
    injectFeedbackModals();
    hideError('feedbackFormError');
    var titleEl = document.getElementById('feedbackInputTitle');
    var bodyEl = document.getElementById('feedbackInputBody');
    if (titleEl) titleEl.value = '';
    if (bodyEl) bodyEl.value = '';
    openModal('feedbackFormModal');
    setTimeout(function () { if (titleEl) titleEl.focus(); }, 30);
  }

  function submitFeedback() {
    var titleEl = document.getElementById('feedbackInputTitle');
    var bodyEl = document.getElementById('feedbackInputBody');
    var title = (titleEl ? titleEl.value : '').trim();
    var text = (bodyEl ? bodyEl.value : '').trim();
    if (title.length < 2) { showError('feedbackFormError', '标题至少 2 个字。'); return; }
    if (text.length < 2) { showError('feedbackFormError', '详细描述至少 2 个字。'); return; }
    var btn = document.getElementById('btnSubmitFeedback');
    if (btn) btn.disabled = true;
    // 兼容现有 API：type 默认 bug，后端已支持 complaint
    api('POST', '/api/feedback', { title: title, content: text, type: 'bug' }).then(function () {
      closeModal('feedbackFormModal');
      toast('反馈已提交，官方回复后会出现在反馈箱。');
      openFeedback();
    }).catch(function (err) {
      if (err && err.status === 401) return;
      showError('feedbackFormError', (err && err.message) || '提交失败，请稍后重试。');
    }).then(function () { if (btn) btn.disabled = false; });
  }

  function checkFeedbackOnEnter() {
    if (!S.me) return;
    api('GET', '/api/feedback/mine').then(function (d) {
      var items = d.feedback || [];
      if (S.me && (S.me.founder || S.me.masterUntil > 0)) {
        var open = items.filter(function (f) { return f.status === 'open'; });
        if (open.length) {
          openFeedback();
          toast('有 ' + open.length + ' 条待处理反馈。');
        }
        return;
      }
      var unread = items.filter(function (f) { return f.status === 'replied' && !f.seenAt; }).length;
      var menuBtn = document.querySelector('[data-menu="feedback"]');
      if (menuBtn) menuBtn.textContent = unread ? '反馈箱 · 新回复' : '反馈箱';
    }).catch(function () { });
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindFeedbackEvents() {
    // btnNewFeedback 在 openFeedback -> loadFeedback -> renderFeedback 后动态生成，用事件委托
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.id === 'btnNewFeedback') { openFeedbackForm(); }
      else if (t && t.id === 'btnSubmitFeedback') { submitFeedback(); }
    });
  }

  /* ---------------- 辅助函数（复用现有） ---------------- */
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt !== undefined) n.textContent = txt;
    return n;
  }
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');
  }
  // dateLabel, fmtTime, api, openModal, closeModal, toast, showError, hideError 均来自 app.js 全局

  /* ---------------- 导出 ---------------- */
  window.FeedbackBox = {
    open: openFeedback,
    openForm: openFeedbackForm,
    checkOnEnter: checkFeedbackOnEnter,
    bindEvents: bindFeedbackEvents
  };

  // 页面加载完成后自动绑定
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindFeedbackEvents);
  } else {
    bindFeedbackEvents();
  }
})();