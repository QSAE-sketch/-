'use strict';
// 线上冒烟测试：验证「权限密钥 + 最高权限 + 公共大厅保护」在线上真实生效。
// 不真解散公共大厅（只验证权限闸门），跑完自动注销所有测试账号。
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const BASE = process.argv[2] || 'https://qingliao-chat-33476.app.workbuddy.host';
const SHARECODE = process.argv[3] || 'T7ELJZOC5A';
const KEY = process.env.PERM_KEY || 'lz-qingliao-2026';
const MOD = BASE.startsWith('https') ? https : http;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 200) : '')); }
}
function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    if (!u.searchParams.has('sharecode')) u.searchParams.set('sharecode', SHARECODE);
    const data = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body));
    const headers = { 'Host': u.host };
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Type'] = 'application/json';
    const r = MOD.request({
      hostname: u.hostname, port: u.port || (BASE.startsWith('https') ? 443 : 80), path: u.pathname + u.search,
      method, headers, timeout: 20000
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        let j = null; try { j = JSON.parse(Buffer.concat(cs).toString()); } catch (e) {}
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const uniq = crypto.randomBytes(4).toString('hex');

  /* 1. 普通账号：登录时输入正确密钥 → 拿到 30 分钟最高权限 */
  const mu = 'smoke_m_' + uniq;
  let r = await req('POST', '/api/register', { username: mu, password: 'smoke123', nickname: '权限冒烟', permKey: KEY });
  check('线上注册并提交权限密钥', r.status === 200 && r.json.token, r.json);
  const mTok = r.json && r.json.token;
  check('密钥正确 → perm.granted', !!(r.json && r.json.perm && r.json.perm.granted === true), r.json && r.json.perm);
  check('账号获得最高权限', !!(r.json && r.json.user && r.json.user.master === true));
  const remain = r.json && r.json.user ? r.json.user.masterRemainMs : 0;
  check('有效期为 30 分钟窗口', remain > 29 * 60000 && remain <= 30 * 60000, remain);

  /* 2. 普通账号（无密钥）：公共大厅不可解散 */
  const nu = 'smoke_n_' + uniq;
  r = await req('POST', '/api/register', { username: nu, password: 'smoke123', nickname: '普通冒烟' });
  const nTok = r.json && r.json.token;
  check('普通账号注册成功', !!nTok, r.json);

  r = await req('GET', '/api/rooms', null, nTok);
  const pubId = r.json && r.json.publicRoomId;
  check('拿到公共大厅 id', !!pubId, r.json);
  r = await req('POST', '/api/rooms/' + pubId + '/dissolve', { confirm: true }, nTok);
  check('普通账号解散公共大厅被拒 403', r.status === 403, r.json);

  /* 3. 最高权限：越过权限闸但不真解散（只发不带 confirm 的请求） */
  r = await req('POST', '/api/rooms/' + pubId + '/dissolve', {}, mTok);
  check('最高权限已过权限闸（返回需要二次确认）', r.status === 400, r.json);

  /* 4. 最高权限：删除他人消息 */
  r = await req('POST', '/api/rooms/' + pubId + '/messages', { content: '冒烟消息 ' + uniq }, nTok);
  const msgId = r.json && r.json.message && r.json.message.id;
  check('普通账号在公共大厅发言成功', !!msgId, r.json);
  r = await req('POST', '/api/messages/' + msgId + '/purge', {}, mTok);
  check('最高权限可删除他人消息', r.status === 200 && r.json.purged === true, r.json);

  /* 5. 线上永久权限账号被正确识别 */
  r = await req('GET', '/api/users?q=' + encodeURIComponent('刘子墨'), null, mTok);
  const hit = r.json && (r.json.users || []).find((u) => u.username === '刘子墨');
  check('线上刘子墨账号已标记 founder', !!(hit && hit.founder === true), hit || r.json);
  if (hit) check('线上刘子墨账号为永久最高权限', hit.master === true, hit);

  /* 6. 最高权限：注销指定用户 */
  const du = 'smoke_d_' + uniq;
  r = await req('POST', '/api/register', { username: du, password: 'smoke123', nickname: '待注销冒烟' });
  const dTok = r.json && r.json.token;
  const dId = r.json && r.json.user && r.json.user.id;
  check('待注销账号注册成功', !!(dTok && dId), r.json);
  r = await req('POST', '/api/admin/users/' + dId + '/delete', { confirm: true }, nTok);
  check('普通账号调用注销接口被拒 403', r.status === 403, r.json);
  r = await req('POST', '/api/admin/users/' + dId + '/delete', { confirm: true }, mTok);
  check('最高权限可注销指定用户', r.status === 200 && r.json.deleted === true, r.json);
  r = await req('POST', '/api/login', { username: du, password: 'smoke123' });
  check('被注销账号无法登录', r.status === 401, r.json);

  /* 7. 清理：注销两个冒烟账号 */
  r = await req('POST', '/api/account/delete', { confirm: true }, mTok);
  check('最高权限账号自注销成功', r.status === 200, r.json);
  r = await req('POST', '/api/account/delete', { confirm: true }, nTok);
  check('普通账号自注销成功', r.status === 200, r.json);

  /* 8. 双版本仍正常分发 */
  r = await req('GET', '/api/version', null, null);
  check('线上版本已更新到 1.5.0', !!(r.json && r.json.version && r.json.version.name === '1.5.0'), r.json && r.json.version);

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常:', e && e.stack ? e.stack : e);
  console.log('\n通过: ' + pass + '  失败: ' + (fail + 1));
  process.exit(1);
});
