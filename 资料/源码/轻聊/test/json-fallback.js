'use strict';
/**
 * JSON 兜底存储专项测试（沙箱若为旧 Node 走此路径）
 * 启动方式：先以 mock 方式禁用 node:sqlite 启动服务，再运行本脚本
 */
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3312;
const BASE = 'http://127.0.0.1:' + PORT;
let pass = 0, fail = 0;

function req(m, p, b, t) {
  return new Promise((resolve, reject) => {
    const d = (b === undefined || b === null) ? null : Buffer.from(JSON.stringify(b));
    const h = {};
    if (t) h['X-Token'] = t;
    if (d) h['Content-Type'] = 'application/json';
    const u = new URL(p, BASE);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: m, headers: h }, (rs) => {
      const c = [];
      rs.on('data', (x) => c.push(x));
      rs.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(c).toString()); } catch (e) {}
        resolve({ status: rs.statusCode, json: j });
      });
    });
    r.on('error', reject);
    if (d) r.write(d);
    r.end();
  });
}
function ck(n, c, e) {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (e ? '  → ' + JSON.stringify(e).slice(0, 220) : '')); }
}

(async () => {
  const sfx = crypto.randomBytes(3).toString('hex');
  const A = 'ja' + sfx, B = 'jb' + sfx;
  let r = await req('POST', '/api/register', { username: A, password: 'pass123', nickname: '甲' });
  const ta = r.json.token;
  r = await req('POST', '/api/register', { username: B, password: 'pass123', nickname: '乙' });
  const tb = r.json.token, ub = r.json.user;

  console.log('\n【账号与索引】');
  ck('注册成功', r.status === 200 && !!tb, r.json);
  r = await req('POST', '/api/register', { username: A, password: 'pass123' });
  ck('账号唯一性（byIdx 索引生效）', r.status === 409, r.json);
  r = await req('GET', '/api/users?q=' + B, null, ta);
  ck('用户搜索（byIdx 索引生效）', r.json.users.length === 1, r.json);

  console.log('\n【消息读写】');
  r = await req('GET', '/api/rooms', null, ta);
  const pid = r.json.publicRoomId;
  r = await req('POST', '/api/rooms/' + pid + '/messages', { kind: 'text', content: 'JSON消息' }, ta);
  const mid = r.json.message.id;
  ck('发送消息', r.status === 200, r.json);
  r = await req('GET', '/api/rooms/' + pid + '/messages?since=0', null, tb);
  ck('读取消息（byIdx 索引生效）', r.json.messages.some((m) => m.content === 'JSON消息'), r.json.messages);

  console.log('\n【密码房】');
  r = await req('POST', '/api/rooms', { name: '密室', password: 'pw1234' }, ta);
  const rid = r.json.room.id;
  r = await req('GET', '/api/rooms/' + rid + '/messages?since=0', null, tb);
  ck('他人未验证密码不能进(403)', r.status === 403, r.json);
  r = await req('POST', '/api/rooms/' + rid + '/join', { password: 'wrong' }, tb);
  ck('错误密码被拒(401)', r.status === 401, r.json);
  r = await req('POST', '/api/rooms/' + rid + '/join', { password: 'pw1234' }, tb);
  ck('正确密码可加入', r.status === 200, r.json);
  r = await req('POST', '/api/rooms/' + rid + '/messages', { kind: 'text', content: '密室消息' }, tb);
  ck('加入后可发言', r.status === 200, r.json);
  r = await req('GET', '/api/rooms/' + rid + '/messages?since=0', null, ta);
  ck('房主可见密室消息', r.json.messages.some((m) => m.content === '密室消息'), r.json.messages);

  console.log('\n【删除与撤回】');
  r = await req('POST', '/api/rooms/' + pid + '/messages', { kind: 'text', content: '待撤回' }, ta);
  const recId = r.json.message.id;
  r = await req('POST', '/api/messages/' + recId + '/recall', {}, ta);
  ck('撤回成功', r.status === 200, r.json);
  r = await req('GET', '/api/rooms/' + pid + '/messages?since=0', null, ta);
  let m = r.json.messages.find((x) => x.id === recId);
  ck('撤回后内容清空', m && m.recalled === true && !m.content, m);
  r = await req('POST', '/api/rooms/' + pid + '/messages', { kind: 'text', content: '待删除' }, ta);
  const delId = r.json.message.id;
  r = await req('POST', '/api/messages/' + delId + '/delete', {}, ta);
  ck('删除成功', r.status === 200, r.json);
  r = await req('GET', '/api/rooms/' + pid + '/messages?since=0', null, ta);
  ck('删除后自己看不到', !r.json.messages.some((x) => x.id === delId));
  r = await req('GET', '/api/rooms/' + pid + '/messages?since=0', null, tb);
  ck('删除不影响他人', r.json.messages.some((x) => x.id === delId));

  console.log('\n【好友与私聊】');
  r = await req('POST', '/api/friends/request', { userId: ub.id }, ta);
  const frId = r.json.request.id;
  ck('发送好友请求', r.status === 200, r.json);
  r = await req('GET', '/api/friends', null, tb);
  ck('收到好友请求', r.json.incoming.length === 1, r.json);
  r = await req('POST', '/api/friends/' + frId + '/accept', {}, tb);
  ck('同意好友', r.status === 200, r.json);
  r = await req('GET', '/api/dm/' + ub.id, null, ta);
  ck('发起私聊', r.status === 200 && r.json.room.kind === 'dm', r.json);
  const dmId = r.json.room.id;
  r = await req('POST', '/api/rooms/' + dmId + '/messages', { kind: 'text', content: '私聊内容' }, ta);
  ck('私聊发消息', r.status === 200, r.json);
  r = await req('GET', '/api/rooms/' + dmId + '/messages?since=0', null, tb);
  ck('对方读到私聊', r.json.messages.length === 1 && r.json.messages[0].content === '私聊内容', r.json.messages);
  r = await req('POST', '/api/rooms/' + dmId + '/messages', { kind: 'text', content: '对方回复' }, tb);
  ck('对方回复', r.status === 200, r.json);
  r = await req('GET', '/api/rooms/' + dmId + '/messages?since=0', null, ta);
  ck('发起方读到回复', r.json.messages.length === 2, r.json.messages);

  console.log('\n【群管理官职】');
  r = await req('POST', '/api/rooms', { name: '官房' }, ta);
  const gr = r.json.room.id;
  await req('POST', '/api/rooms/' + gr + '/join', {}, tb);
  r = await req('POST', '/api/rooms/' + gr + '/appoint', { userId: ub.id, role: 'admin' }, ta);
  ck('任命管理员', r.status === 200 && r.json.member.role === 'admin', r.json);
  r = await req('GET', '/api/rooms/' + gr + '/members', null, ta);
  ck('成员列表返回', r.json.members.length === 2, r.json);
  ck('官职名正确', r.json.members.some((x) => x.roleName === '丞相'), r.json.members.map((x) => x.roleName));
  r = await req('POST', '/api/rooms/' + gr + '/mute', { userId: ub.id, minutes: 10 }, ta);
  ck('禁言成功', r.status === 200, r.json);
  r = await req('POST', '/api/rooms/' + gr + '/messages', { kind: 'text', content: '禁言发言' }, tb);
  ck('禁言中不能发言', r.status === 403, r.json);
  r = await req('POST', '/api/rooms/' + gr + '/kick', { userId: ub.id }, ta);
  ck('踢出成功', r.status === 200, r.json);
  r = await req('GET', '/api/rooms/' + gr + '/members', null, ta);
  ck('被踢者已移出', !r.json.members.some((x) => x.userId === ub.id), r.json.members);

  console.log('\n【分片上传】');
  r = await req('POST', '/api/files/init', { name: 'j.txt', size: 5, mime: 'text/plain', roomId: pid }, ta);
  const fid = r.json.fileId;
  ck('初始化上传', r.status === 200, r.json);
  await new Promise((res) => {
    const rq = http.request({ hostname: '127.0.0.1', port: PORT, path: '/api/files/' + fid + '/chunk?i=0', method: 'PUT', headers: { 'X-Token': ta, 'Content-Type': 'application/octet-stream' } }, (rs) => { rs.on('data', () => {}); rs.on('end', res); });
    rq.write(Buffer.from('hello'));
    rq.end();
  });
  r = await req('POST', '/api/files/' + fid + '/complete', {}, ta);
  ck('合并完成', r.status === 200, r.json);
  r = await req('POST', '/api/rooms/' + pid + '/messages', { kind: 'file', fileId: fid }, ta);
  ck('文件消息', r.status === 200 && r.json.message.kind === 'file', r.json);
  const furl = r.json.message.file.url;
  r = await req('GET', furl.replace(BASE, ''), null, null);
  ck('文件可下载', r.status === 200, r.status);

  console.log('\n────────────────────────────');
  console.log('通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
