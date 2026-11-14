'use strict';
/**
 * 线上专项验证：聊天页（公共聊天室 / 自定义房间）点头像 → 资料页 → 加好友。
 *
 * 覆盖 31 项旧断言 + 本轮新增的「聊天页头像入口」相关断言。
 * 走真实的线上域名（含 sharecode 握手），验证的是部署后的实际产物。
 */
const https = require('https');
const crypto = require('crypto');

const BASE = 'https://qingliao-chat-33476.app.workbuddy.host';
const SHARE_CODE = process.env.SHARE_CODE || 'T7ELJZOC5A';
const COOKIES = {};

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = (body === undefined || body === null) ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Type'] = 'application/json; charset=utf-8';
    const ck = Object.keys(COOKIES).map((k) => k + '=' + COOKIES[k]).join('; ');
    if (ck) headers['Cookie'] = ck;
    const u = new URL(path, BASE);
    const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers }, (res) => {
      for (const line of (res.headers['set-cookie'] || [])) {
        const kv = line.split(';')[0];
        const i = kv.indexOf('=');
        if (i > 0) COOKIES[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      }
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(cs).toString('utf8');
        let j = null;
        try { j = JSON.parse(raw); } catch (e) {}
        resolve({ status: res.statusCode, json: j, body: raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function uniq(p) { return p + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'); }

(async () => {
  console.log('\n【线上】聊天页点头像加好友（公共聊天室 / 自定义房间 / 成员面板）');

  // 握手
  const hs = await req('GET', '/?sharecode=' + SHARE_CODE);
  check('sharecode 握手成功', hs.status === 200, hs.status);

  // 注册两个账号
  const un = uniq('lv');
  const regA = await req('POST', '/api/register', { username: un + 'a', password: 'pass123', nickname: '聊友甲' });
  check('账号 A 注册成功', !!(regA.json && regA.json.token), regA.json);
  const A = regA.json.token;
  const meA = await req('GET', '/api/me', null, A);
  const aid = meA.json.user.id;
  check('A 的昵称正确（中文不乱码）', meA.json.user.nickname === '聊友甲', meA.json.user.nickname);

  const regB = await req('POST', '/api/register', { username: un + 'b', password: 'pass123', nickname: '聊友乙' });
  check('账号 B 注册成功', !!(regB.json && regB.json.token), regB.json);
  const B = regB.json.token;
  const meB = await req('GET', '/api/me', null, B);
  const bid = meB.json.user.id;

  // ---------- 公共聊天室：对方发言 → 消息头像可点 ----------
  const rooms = await req('GET', '/api/rooms', null, B);
  const pub = rooms.json && rooms.json.rooms ? rooms.json.rooms.find((r) => r.kind === 'public') : null;
  check('找到公共聊天室', !!pub, rooms.json);
  const text = '线上验证消息-' + Date.now();
  const sent = await req('POST', '/api/rooms/' + pub.id + '/messages', { kind: 'text', content: text }, B);
  check('B 在公共聊天室发消息成功', !!(sent.json && sent.json.ok), sent.json);

  const msgs = await req('GET', '/api/rooms/' + pub.id + '/messages?since=0&limit=80', null, A);
  const m = msgs.json && msgs.json.messages ? msgs.json.messages.find((x) => x.content === text) : null;
  check('A 能在公共聊天室看到该消息', !!m);
  check('消息带 senderId（头像入口依赖它）', !!(m && m.senderId === bid), m && m.senderId);

  // ---------- 需求 1：A 通过资料接口打开 B 的资料页并发申请 ----------
  const prof = await req('GET', '/api/users/' + bid, null, A);
  check('GET /api/users/:id 返回 200', prof.status === 200, prof.status);
  check('资料接口返回对方昵称', !!(prof.json && prof.json.user && prof.json.user.nickname === '聊友乙'),
    prof.json && prof.json.user);
  check('资料接口不含 email（隐私）', !(prof.json && prof.json.user && prof.json.user.email),
    prof.json && prof.json.user && prof.json.user.email);
  check('资料接口带 avatarColor', !!(prof.json && prof.json.user && prof.json.user.avatarColor));
  check('资料接口带 initial', !!(prof.json && prof.json.user && prof.json.user.initial));
  check('资料接口 self=false', prof.json && prof.json.self === false);
  check('资料接口 friend=false', prof.json && prof.json.friend === false);
  check('资料接口 requested=false', prof.json && prof.json.requested === false);

  const note = '你好呀！我是刚才在公共聊天室看到你的';
  const rq = await req('POST', '/api/friends/request', { userId: bid, message: note }, A);
  check('从聊天页发起好友申请成功', !!(rq.json && rq.json.request), rq.json);

  // B 收到申请
  const fr = await req('GET', '/api/friends', null, B);
  const inc = fr.json && fr.json.incoming ? fr.json.incoming[0] : null;
  check('B 收到好友申请', !!inc, fr.json);
  check('申请附言一字不差', !!(inc && inc.message === note), inc && inc.message);
  check('申请条目带申请人头像色', !!(inc && inc.avatarColor));
  check('申请条目带申请人首字', !!(inc && inc.initial));

  // 重复申请被拒
  const dup = await req('POST', '/api/friends/request', { userId: bid, message: '再来一次' }, A);
  check('重复申请被拒绝', dup.status === 400 || dup.status === 409, dup.status);

  // ---------- 需求 2：B 同意 → 双方建立好友关系 ----------
  const acc = await req('POST', '/api/friends/' + inc.id + '/accept', {}, B);
  check('B 同意好友申请成功', !!(acc.json && acc.json.ok), acc.json);

  const fa = await req('GET', '/api/friends', null, A);
  const fb = await req('GET', '/api/friends', null, B);
  check('A 的好友列表里有 B', !!(fa.json && fa.json.friends.some((f) => f.id === bid)),
    fa.json && fa.json.friends);
  check('B 的好友列表里有 A（双向关系）', !!(fb.json && fb.json.friends.some((f) => f.id === aid)),
    fb.json && fb.json.friends);

  const fr2 = await req('GET', '/api/friends', null, B);
  check('同意后申请列表清空', fr2.json && fr2.json.incoming.length === 0, fr2.json && fr2.json.incoming);

  // ---------- 成员面板：头像可点所需的字段 ----------
  const mem = await req('GET', '/api/rooms/' + pub.id + '/members', null, A);
  check('成员接口返回 200', mem.status === 200, mem.status);
  const members = mem.json && mem.json.members ? mem.json.members : [];
  check('成员列表非空', members.length > 0, members.length);
  const withAv = members.filter((x) => x.avatarColor && x.initial);
  check('成员条目带 avatarColor 与 initial（头像入口依赖）', withAv.length === members.length,
    members.map((x) => ({ u: x.nickname, c: x.avatarColor, i: x.initial })));

  // ---------- 自定义房间：同样能点头像 ----------
  const roomName = '线上验证房' + Date.now().toString().slice(-5);
  const cr = await req('POST', '/api/rooms', { name: roomName }, A);
  check('A 创建自定义房间成功', !!(cr.json && cr.json.room), cr.json);
  const roomId = cr.json && cr.json.room ? cr.json.room.id : '';
  const jr = await req('POST', '/api/rooms/' + roomId + '/join', {}, B);
  check('B 加入自定义房间成功', !!(jr.json && jr.json.ok), jr.json);
  const rtext = '房间内消息-' + Date.now();
  const rs = await req('POST', '/api/rooms/' + roomId + '/messages', { kind: 'text', content: rtext }, B);
  check('B 在自定义房间发言成功', !!(rs.json && rs.json.ok), rs.json);
  const rmsgs = await req('GET', '/api/rooms/' + roomId + '/messages?since=0&limit=50', null, A);
  const rm = rmsgs.json && rmsgs.json.messages ? rmsgs.json.messages.find((x) => x.content === rtext) : null;
  check('A 在自定义房间看到消息且带 senderId', !!(rm && rm.senderId === bid), rm && rm.senderId);

  const rmem = await req('GET', '/api/rooms/' + roomId + '/members', null, A);
  check('自定义房间成员接口返回头像字段',
    !!(rmem.json && rmem.json.members && rmem.json.members.every((x) => x.avatarColor && x.initial)),
    rmem.json && rmem.json.members);

  // ---------- 前端产物含新代码 ----------
  const js = await req('GET', '/app.js');
  const src = js.body || '';
  check('线上 app.js 含 openProfile（头像入口）', src.indexOf('openProfile') >= 0);
  check('线上 app.js 含 profileFrom（来源追踪，返回回原场景）', src.indexOf('profileFrom') >= 0);
  check('线上 app.js 含 gotoFriendsFromProfile', src.indexOf('gotoFriendsFromProfile') >= 0);
  check('线上 app.js 含 memberAct（成员头像）', src.indexOf('memberAct') >= 0);
  check('线上 app.js 含 utf8Bytes（中文编码）', src.indexOf('utf8Bytes') >= 0);

  const html = await req('GET', '/');
  check('线上 index.html 含 friendAdd 资料页', (html.body || '').indexOf('friendAdd') >= 0);

  const css = await req('GET', '/style.css');
  check('线上 style.css 含成员头像样式 .m-av', (css.body || '').indexOf('.m-av') >= 0);
  check('线上 style.css 含头像可点样式 cursor:pointer', (css.body || '').indexOf('cursor: pointer') >= 0);

  // ---------- 权限 ----------
  const cAcc = await req('POST', '/api/friends/' + inc.id + '/accept', {}, A);
  check('无关账号不能代为同意（403）', cAcc.status === 403, cAcc.status);
  const selfReq = await req('POST', '/api/friends/request', { userId: aid, message: '加自己' }, A);
  check('不能给自己发申请', selfReq.status === 400 || selfReq.status === 409, selfReq.status);

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('验证异常:', e && e.message); process.exit(1); });
