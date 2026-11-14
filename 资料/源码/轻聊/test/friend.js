'use strict';
/**
 * 好友系统专项测试
 *
 * 覆盖本次的两项改进：
 *   1) 申请加好友页面所需的用户资料接口（头像 / 昵称 / 账号 / 注册时间 / 关系状态）
 *   2) 好友申请的「附言」字段，以及「收到的好友申请」列表所需的下发数据
 *
 * 另外把三种操作语义再钉一遍：
 *   申请 → 双方 pending
 *   同意 → 双向好友关系成立，申请从 pending 列表消失
 *   拒绝 → 申请从 pending 列表消失，双方仍不是好友
 */
const http = require('http');
const crypto = require('crypto');

const BASE = 'http://127.0.0.1:' + (process.env.PORT || 3311);
let pass = 0, fail = 0;

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
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 250) : '')); }
}
async function register(prefix, nickname) {
  const uniq = crypto.randomBytes(3).toString('hex');
  const username = prefix + uniq;
  const r = await req('POST', '/api/register', { username, password: 'pass123', nickname });
  const token = r.json.token;
  const me = await req('GET', '/api/me', null, token);
  return { username, token, id: me.json.user.id, nickname };
}

(async () => {
  const A = await register('fa', '甲方');
  const B = await register('fb', '乙方');
  const C = await register('fc', '丙方');
  check('三个测试账号注册成功', !!A.token && !!B.token && !!C.token);

  /* ---------------- A. 用户资料接口 ---------------- */
  console.log('\n【A】用户资料接口 GET /api/users/:id');

  let r = await req('GET', '/api/users/' + A.id, null, B.token);
  check('返回 200', r.status === 200, r.json);
  check('返回对方昵称', r.json && r.json.user && r.json.user.nickname === '甲方', r.json);
  check('返回对方账号', r.json && r.json.user && r.json.user.username === A.username, r.json);
  check('下发了头像底色', r.json && r.json.user && /^hsl\(/.test(r.json.user.avatarColor || ''), r.json);
  check('下发了头像首字', r.json && r.json.user && r.json.user.initial === '甲', r.json);
  check('下发了注册时间', r.json && r.json.user && !!r.json.user.createdAt, r.json);
  check('资料页不下发邮箱（隐私）', r.json && r.json.user && r.json.user.email === undefined, r.json);
  check('未申请时 friend=false', r.json && r.json.friend === false, r.json);
  check('未申请时 requested=false', r.json && r.json.requested === false, r.json);
  check('未申请时 received=false', r.json && r.json.received === false, r.json);
  check('查看他人时 self=false', r.json && r.json.self === false, r.json);

  r = await req('GET', '/api/users/' + A.id, null, A.token);
  check('查看自己时 self=true', r.json && r.json.self === true, r.json);

  r = await req('GET', '/api/users/u_not_exist_zzz', null, B.token);
  check('用户不存在返回 404', r.status === 404, r.json);

  r = await req('GET', '/api/users/' + A.id, null, null);
  check('未登录访问资料返回 401', r.status === 401, r.json);

  /* ---------------- B. 发送申请 + 附言 ---------------- */
  console.log('\n【B】发送好友申请（含附言）');

  r = await req('GET', '/api/friends', null, B.token);
  check('新账号的收到列表为空数组', r.json && Array.isArray(r.json.incoming) && r.json.incoming.length === 0, r.json);
  check('新账号的好友列表为空数组', r.json && Array.isArray(r.json.friends) && r.json.friends.length === 0, r.json);
  check('新账号的发出的列表为空数组', r.json && Array.isArray(r.json.outgoing) && r.json.outgoing.length === 0, r.json);

  const msg = '你好，我是项目组的张三，想和你交流一下';
  r = await req('POST', '/api/friends/request', { userId: B.id, message: msg }, A.token);
  check('发送申请成功', r.status === 200, r.json);
  const reqId = r.json && r.json.request && r.json.request.id;
  check('返回申请 id', !!reqId, r.json);
  check('返回里带上了附言', r.json && r.json.request && r.json.request.message === msg, r.json);

  r = await req('GET', '/api/friends', null, B.token);
  const inc = (r.json.incoming || []);
  check('对方收到 1 条申请', inc.length === 1, r.json);
  const one = inc[0];
  check('申请条目带申请人昵称', one && one.nickname === '甲方', one);
  check('申请条目带申请人账号', one && one.username === A.username, one);
  check('申请条目带附言', one && one.message === msg, one);
  check('申请条目带申请时间', one && !!one.createdAt, one);
  check('申请条目带头像底色', one && /^hsl\(/.test(one.avatarColor || ''), one);
  check('申请条目带头像首字', one && one.initial === '甲', one);
  check('申请条目带申请人 id', one && one.fromId === A.id, one);

  r = await req('GET', '/api/friends', null, A.token);
  check('发起方看到的是「我发出的请求」', r.json && r.json.outgoing.length === 1, r.json);
  check('发起方不在自己的收到列表里', r.json && r.json.incoming.length === 0, r.json);
  check('发出的请求也带附言', r.json && r.json.outgoing[0] && r.json.outgoing[0].message === msg, r.json);

  r = await req('GET', '/api/users/' + B.id, null, A.token);
  check('发起方视角 requested=true', r.json && r.json.requested === true, r.json);
  check('发起方视角 received=false', r.json && r.json.received === false, r.json);

  r = await req('GET', '/api/users/' + A.id, null, B.token);
  check('接收方视角 received=true', r.json && r.json.received === true, r.json);
  check('接收方视角 requested=false', r.json && r.json.requested === false, r.json);
  check('接收方能看到 pendingId', r.json && r.json.pendingId === reqId, r.json);

  // 重复申请
  r = await req('POST', '/api/friends/request', { userId: B.id, message: '再来一次' }, A.token);
  check('重复申请被拒（400）', r.status === 400, r.json);

  // 加自己
  r = await req('POST', '/api/friends/request', { userId: A.id, message: '加自己' }, A.token);
  check('不能添加自己（400）', r.status === 400, r.json);

  // 附言超长截断
  const C2 = await register('fd', '丁方');
  const longMsg = '长'.repeat(500);
  r = await req('POST', '/api/friends/request', { userId: C2.id, message: longMsg }, A.token);
  check('超长附言也能提交', r.status === 200, r.json);
  r = await req('GET', '/api/friends', null, C2.token);
  check('附言被截断到 200 字', r.json && r.json.incoming[0] && r.json.incoming[0].message.length === 200, r.json && r.json.incoming[0] && r.json.incoming[0].message.length);

  // 空附言
  r = await req('POST', '/api/friends/request', { userId: C.id }, A.token);
  check('不传附言也能申请', r.status === 200, r.json);
  r = await req('GET', '/api/friends', null, C.token);
  check('没填附言时 message 为空串', r.json && r.json.incoming[0] && r.json.incoming[0].message === '', r.json);

  /* ---------------- C. 权限 ---------------- */
  console.log('\n【C】权限校验');

  r = await req('POST', '/api/friends/' + reqId + '/accept', {}, C.token);
  check('无关账号不能同意别人的申请（403）', r.status === 403, r.json);

  r = await req('POST', '/api/friends/' + reqId + '/accept', {}, A.token);
  check('申请发起方不能自己同意（403）', r.status === 403, r.json);

  r = await req('POST', '/api/friends/fr_not_exist_zzz/accept', {}, B.token);
  check('不存在的申请返回 404', r.status === 404, r.json);

  /* ---------------- D. 同意 → 双向好友 ---------------- */
  console.log('\n【D】同意申请 → 建立双向好友关系');

  r = await req('POST', '/api/friends/' + reqId + '/accept', {}, B.token);
  check('接收方同意成功', r.status === 200, r.json);

  r = await req('GET', '/api/friends', null, A.token);
  const fa = r.json.friends || [];
  check('发起方的好友列表里有对方', fa.some((x) => x.id === B.id), fa);
  check('发起方好友条目带头像底色', fa[0] && /^hsl\(/.test(fa[0].avatarColor || ''), fa[0]);
  check('发起方好友条目带头像首字', fa[0] && fa[0].initial === '乙', fa[0]);
  check('同意后给 B 的申请已从「我发出的请求」移除',
    !(r.json.outgoing || []).some((x) => x.id === reqId), r.json.outgoing);

  r = await req('GET', '/api/friends', null, B.token);
  const fb = r.json.friends || [];
  check('接收方的好友列表里也有对方（双向）', fb.some((x) => x.id === A.id), fb);
  check('接收方好友条目带头像底色', fb[0] && /^hsl\(/.test(fb[0].avatarColor || ''), fb[0]);
  check('接收方好友条目带头像首字', fb[0] && fb[0].initial === '甲', fb[0]);
  check('同意后「收到的申请」清空', r.json.incoming.length === 0, r.json);

  r = await req('GET', '/api/users/' + B.id, null, A.token);
  check('同意后资料页显示 friend=true', r.json && r.json.friend === true, r.json);
  check('同意后 requested 归零', r.json && r.json.requested === false, r.json);

  r = await req('POST', '/api/friends/request', { userId: B.id }, A.token);
  check('已是好友再申请被拒（400）', r.status === 400, r.json);

  /* ---------------- E. 拒绝 ---------------- */
  console.log('\n【E】拒绝申请');

  r = await req('POST', '/api/friends/request', { userId: C.id, message: '交个朋友' }, B.token);
  check('对第三个账号发起申请', r.status === 200, r.json);
  const reqId2 = r.json.request.id;

  r = await req('POST', '/api/friends/' + reqId2 + '/reject', {}, C.token);
  check('拒绝成功', r.status === 200, r.json);

  r = await req('GET', '/api/friends', null, C.token);
  check('拒绝后该条申请从收到列表移除',
    !(r.json.incoming || []).some((x) => x.id === reqId2), r.json.incoming);
  check('拒绝后仍不是好友', (r.json.friends || []).length === 0, r.json);

  r = await req('GET', '/api/users/' + B.id, null, C.token);
  check('拒绝后资料页 friend=false', r.json && r.json.friend === false, r.json);
  check('拒绝后 received 归零', r.json && r.json.received === false, r.json);

  r = await req('GET', '/api/friends', null, B.token);
  check('被拒的申请从「我发出的请求」消失', (r.json.outgoing || []).length === 0, r.json);

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
