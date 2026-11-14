'use strict';
/**
 * 线上好友系统验证脚本
 * 针对已部署的线上站点跑一遍完整的好友闭环：
 *   注册两个账号 → 查对方资料 → 带附言申请 → 对方收到（含附言/头像/时间）
 *   → 同意 → 双方互为好友 → 拒绝分支 → 权限校验
 */
const https = require('https');
const crypto = require('crypto');

const BASE = 'https://qingliao-chat-33476.app.workbuddy.host';
const SHARE_CODE = process.env.SHARE_CODE || 'T7ELJZOC5A';
let pass = 0, fail = 0;

const COOKIES = {};

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Type'] = 'application/json';
    const ck = Object.keys(COOKIES).map((k) => k + '=' + COOKIES[k]).join('; ');
    if (ck) headers['Cookie'] = ck;
    const u = new URL(path, BASE);
    const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers }, (res) => {
      const setC = res.headers['set-cookie'] || [];
      for (const line of setC) {
        const kv = line.split(';')[0];
        const i = kv.indexOf('=');
        if (i > 0) COOKIES[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      }
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(cs);
        let j = null;
        try { j = JSON.parse(raw.toString()); } catch (e) {}
        resolve({ status: res.statusCode, json: j, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
async function handshake() {
  const r = await req('GET', '/?sharecode=' + SHARE_CODE);
  return r.status === 200;
}
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 250) : '')); }
}
async function reg(prefix, nickname) {
  const username = prefix + crypto.randomBytes(3).toString('hex');
  const r = await req('POST', '/api/register', { username, password: 'pass123', nickname });
  const me = await req('GET', '/api/me', null, r.json.token);
  return { username, token: r.json.token, id: me.json.user.id, nickname };
}

(async () => {
  check('线上网关握手成功', await handshake());

  const A = await reg('la', '甲方好友');
  const B = await reg('lb', '乙方好友');
  check('两个账号注册成功', !!A.token && !!B.token);

  /* ---- 资料接口 ---- */
  let r = await req('GET', '/api/users/' + B.id, null, A.token);
  check('线上资料接口返回 200', r.status === 200, r.json);
  check('返回对方昵称', r.json && r.json.user && r.json.user.nickname === '乙方好友', r.json);
  check('下发头像底色', r.json && r.json.user && /^hsl\(/.test(r.json.user.avatarColor || ''), r.json);
  check('下发头像首字', r.json && r.json.user && r.json.user.initial === '乙', r.json);
  check('不下发邮箱', r.json && r.json.user && r.json.user.email === undefined, r.json);
  check('初始为未申请状态', r.json && r.json.friend === false && r.json.requested === false && r.json.received === false, r.json);

  /* ---- 带附言申请 ---- */
  const note = '线上验证：你好，想加个好友';
  r = await req('POST', '/api/friends/request', { userId: B.id, message: note }, A.token);
  check('发送带附言的申请成功', r.status === 200, r.json);
  const reqId = r.json && r.json.request && r.json.request.id;
  check('返回申请 id', !!reqId, r.json);

  r = await req('GET', '/api/friends', null, B.token);
  const inc = (r.json.incoming || [])[0];
  check('对方收到申请', !!inc, r.json);
  check('申请条目带附言', inc && inc.message === note, inc);
  check('申请条目带头像底色', inc && /^hsl\(/.test(inc.avatarColor || ''), inc);
  check('申请条目带头像首字', inc && inc.initial === '甲', inc);
  check('申请条目带申请时间', inc && !!inc.createdAt, inc);

  /* ---- 同意 → 双向好友 ---- */
  r = await req('POST', '/api/friends/' + reqId + '/accept', {}, B.token);
  check('同意成功', r.status === 200, r.json);

  r = await req('GET', '/api/friends', null, A.token);
  check('发起方好友列表里有对方', (r.json.friends || []).some((f) => f.id === B.id), r.json.friends);
  check('发起方的申请列表已清空', (r.json.incoming || []).length === 0, r.json.incoming);

  r = await req('GET', '/api/friends', null, B.token);
  check('接收方好友列表里也有对方（双向）', (r.json.friends || []).some((f) => f.id === A.id), r.json.friends);
  check('接收方的申请列表已清空', (r.json.incoming || []).length === 0, r.json.incoming);

  r = await req('GET', '/api/users/' + B.id, null, A.token);
  check('资料接口显示 friend=true', r.json && r.json.friend === true, r.json);

  /* ---- 拒绝分支 ---- */
  const C = await reg('lc', '丙方好友');
  r = await req('POST', '/api/friends/request', { userId: C.id, message: '交个朋友吧' }, B.token);
  check('对丙方发起申请', r.status === 200, r.json);
  const reqId2 = r.json.request.id;
  r = await req('POST', '/api/friends/' + reqId2 + '/reject', {}, C.token);
  check('拒绝成功', r.status === 200, r.json);
  r = await req('GET', '/api/friends', null, C.token);
  check('拒绝后该申请从列表移除', !(r.json.incoming || []).some((x) => x.id === reqId2), r.json.incoming);
  check('拒绝后仍不是好友', (r.json.friends || []).length === 0, r.json.friends);

  /* ---- 权限 ---- */
  r = await req('POST', '/api/friends/' + reqId2 + '/accept', {}, A.token);
  check('无关账号不能同意（403）', r.status === 403, r.json);

  /* ---- 前端资源已更新 ---- */
  r = await req('GET', '/app.js');
  const js = r.raw.toString();
  check('线上 app.js 含资料页逻辑', js.indexOf('openProfile') > 0 && js.indexOf('renderProfile') > 0);
  check('线上 app.js 含申请附言字段', js.indexOf('message: msg') > 0);
  check('线上 app.js 含好友申请列表', js.indexOf('收到的好友申请') > 0);
  r = await req('GET', '/index.html');
  const html = r.raw.toString();
  check('线上 index.html 含资料页 section', html.indexOf('id="friendAdd"') > 0);
  r = await req('GET', '/style.css');
  const css = r.raw.toString();
  check('线上 style.css 含资料页样式', css.indexOf('.prof-head') > 0 && css.indexOf('.req-row') > 0 && css.indexOf('.row-av') > 0);

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
