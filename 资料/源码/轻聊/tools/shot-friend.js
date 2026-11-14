'use strict';
/**
 * 截图准备：注册两个账号，让 B 给 A 发一条带附言的好友申请，
 * 输出 A 的 token 与 B 的账号，供截图页面注入。
 */
const http = require('http');
const fs = require('fs');

const PORT = process.env.PORT || 18095;
const BASE = 'http://127.0.0.1:' + PORT;

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = (body === undefined || body === null) ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Type'] = 'application/json';
    const u = new URL(path, BASE);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(cs).toString()); } catch (e) {}
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const stamp = Date.now().toString().slice(-8);
  const A = 'qa' + stamp, B = 'qb' + stamp;
  let r = await req('POST', '/api/register', { username: A, password: 'pass123', nickname: '林小满' });
  const ta = r.json.token;
  const aid = r.json.user.id;
  r = await req('POST', '/api/register', { username: B, password: 'pass123', nickname: '陈知远' });
  const tb = r.json.token;
  const bid = r.json.user.id;
  await req('POST', '/api/friends/request', {
    userId: aid,
    message: '你好呀，我是在项目群里看到你的，想加个好友交流一下'
  }, tb);

  const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>shot</title>' +
    '<style>html,body{margin:0;padding:0;background:#e9ecef;}' +
    'iframe{width:420px;height:940px;border:0;display:block;margin:0 auto;background:#fff;}</style>' +
    '</head><body>' +
    '<iframe id="f" src="/"></iframe>' +
    '<script>' +
    'var TOKEN = ' + JSON.stringify(ta) + ';' +
    'var MODE = ' + JSON.stringify(process.env.SHOT_MODE || 'friends') + ';' +
    'var TARGET = ' + JSON.stringify(B) + ';' +
    'var THEME = ' + JSON.stringify(process.env.SHOT_THEME || 'light') + ';' +
    'try {' +
    '  localStorage.setItem("ll_token", TOKEN);' +
    '  localStorage.setItem("ll_theme_mode", "manual");' +
    '  localStorage.setItem("ll_theme_pref", THEME);' +
    '} catch (e) {}' +
    'var f = document.getElementById("f");' +
    'var done = false;' +
    'var reloaded = false;' +
    // iframe 比父页面的 script 先开始加载，第一次进来读不到 token → 写好后 reload 一次
    'f.addEventListener("load", function () {' +
    '  if (reloaded) { return; }' +
    '  reloaded = true;' +
    '  try {' +
    '    var lw = f.contentWindow.localStorage;' +
    '    lw.setItem("ll_token", TOKEN);' +
    '    lw.setItem("ll_theme_mode", "manual");' +
    '    lw.setItem("ll_theme_pref", THEME);' +
    '    f.contentWindow.location.reload();' +
    '  } catch (e) { }' +
    '  setTimeout(step, 1500);' +
    '});' +
    'function step() {' +
    '  if (done) { return; }' +
    '  var w = f.contentWindow;' +
    '  if (!w) { setTimeout(step, 300); return; }' +
    '  var d = w.document;' +
    '  var view = d.getElementById("view");' +
    '  if (!view || view.children.length === 0) { setTimeout(step, 300); return; }' +
    '  var btns = d.querySelectorAll(".tb-btn");' +
    '  if (!btns || btns.length < 3) { setTimeout(step, 300); return; }' +
    '  btns[2].click();' +
    '  setTimeout(function () {' +
    '    if (MODE === "profile") {' +
    '      var avs = d.querySelectorAll(".row-av");' +
    '      if (avs && avs.length) { avs[0].click(); }' +
    '    } else if (MODE === "search") {' +
    '      // 走搜索流程：搜索目标账号 → 点结果里的头像 → 进入「申请加好友」页' +
    '      var act = d.getElementById("searchUser");' +
    '      if (act) { act.click(); }' +
    '      setTimeout(function () {' +
    '        var uq = d.getElementById("uq");' +
    '        if (uq) { uq.value = TARGET; }' +
    '        var ok = d.getElementById("modalOk");' +
    '        if (ok) { ok.click(); }' +
    '        setTimeout(function () {' +
    '          var savs = d.querySelectorAll(".row-av");' +
    '          if (savs && savs.length) { savs[savs.length - 1].click(); }' +
    '        }, 1600);' +
    '      }, 600);' +
    '    }' +
    '    done = true;' +
    '    window.__ready = true;' +
    '  }, 1500);' +
    '}' +
    'setTimeout(step, 800);' +
    '</script></body></html>';
  fs.writeFileSync('public/_shot.html', html);
  console.log('SHOT_READY token=' + ta.slice(0, 12) + ' aid=' + aid + ' bid=' + bid);
})().catch((e) => { console.error(e); process.exit(1); });
