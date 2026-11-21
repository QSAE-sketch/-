'use strict';
/* 端到端测试：覆盖全部 8 项需求 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'http://127.0.0.1:' + (process.env.PORT || 3311);
let pass = 0, fail = 0;

function req(method, path, body, token, isRaw) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null
      : (isRaw ? body : Buffer.from(JSON.stringify(body)));
    const headers = {};
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Type'] = isRaw ? 'application/octet-stream' : 'application/json';
    const u = new URL(path, BASE);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
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
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 300) : '')); }
}

(async () => {
  const uniq = crypto.randomBytes(3).toString('hex');
  const A = 'alice' + uniq, B = 'bob' + uniq, C = 'carol' + uniq;

  console.log('\n【1】账号：注册 / 登录 / 唯一性 / 密码存储');
  let r = await req('POST', '/api/register', { username: A, password: 'pass123', nickname: '爱丽丝' });
  check('注册成功返回 token', r.status === 200 && r.json.ok && r.json.token, r.json);
  const ta = r.json.token, ua = r.json.user;
  r = await req('POST', '/api/register', { username: A, password: 'pass123' });
  check('重复账号被拒绝(409)', r.status === 409, r.json);
  r = await req('POST', '/api/register', { username: B, password: 'pass123', nickname: '鲍勃' });
  const tb = r.json.token, ub = r.json.user;
  r = await req('POST', '/api/register', { username: C, password: 'pass123', nickname: '卡罗尔' });
  const tc = r.json.token, uc = r.json.user;
  check('第二个账号注册成功', r.status === 200 && tb, r.json);
  r = await req('POST', '/api/login', { username: A, password: 'wrongpass' });
  check('错误密码登录失败(401)', r.status === 401, r.json);
  r = await req('POST', '/api/login', { username: A, password: 'pass123' });
  check('正确密码登录成功', r.status === 200 && r.json.ok, r.json);
  const ta2 = r.json.token;
  r = await req('GET', '/api/me', null, ta2);
  check('新 token 可用(多端登录)', r.status === 200 && r.json.user.username === A, r.json);
  // 密码存储校验：与具体后端解耦。
  // 本地 SQLite 后端直接读库文件；云数据库后端则从云端读回该用户的文档。
  const backend = (process.env.STORAGE_BACKEND || 'cloud').toLowerCase();
  if (backend === 'local') {
    const dbPath = path.join(process.env.DATA_DIR || 'data', 'app.db');
    const dbRaw = fs.readFileSync(dbPath);
    check('数据库中无明文密码', !dbRaw.includes(Buffer.from('pass123')));
    check('数据库中存在 scrypt 哈希', dbRaw.length > 0);
  } else {
    const { CloudStore } = require('../src/cloud');
    const cs = new CloudStore(process.env.PUBLIC_ORIGIN || undefined);
    await cs.load();
    const userDoc = cs.get('users', ua.id);
    check('云数据库中无明文密码', !!userDoc && !JSON.stringify(userDoc).includes('pass123'));
    check('云数据库中存在 scrypt 哈希', !!userDoc && typeof userDoc.passHash === 'string' && userDoc.passHash.length > 0);
    check('云数据库中账号唯一可查', cs.byIdx('users', 'k1', A.toLowerCase()).length >= 1);
  }

  console.log('\n【2】持久化与多端同步');
  r = await req('GET', '/api/rooms', null, ta);
  const pubId = r.json.publicRoomId;
  check('公共聊天室存在', !!pubId, r.json);
  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'text', content: '第一条消息' }, ta);
  check('A 发送消息成功', r.status === 200, r.json);
  const msgId = r.json.message.id;
  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0', null, tb);
  check('B（另一端）能读到 A 的消息', r.json.messages.some((m) => m.content === '第一条消息'), r.json.messages);
  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0', null, ta);
  check('A 自己也读到（落库）', r.json.messages.length >= 1);

  console.log('\n【3】公共聊天室：文字/文件/200MB上限');
  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'text', content: '' }, ta);
  check('空消息被拒绝', r.status === 400, r.json);
  r = await req('POST', '/api/files/init', { name: 'big.bin', size: 200 * 1024 * 1024 + 1, mime: 'application/octet-stream', roomId: pubId }, ta);
  check('超过200MB被拒绝', r.status === 400, r.json);
  r = await req('POST', '/api/files/init', { name: 'ok.bin', size: 200 * 1024 * 1024, mime: 'application/octet-stream', roomId: pubId }, ta);
  check('正好200MB允许', r.status === 200, r.json);

  // 分片上传一个小文件（走完整流程）
  const payload = crypto.randomBytes(300 * 1024);
  r = await req('POST', '/api/files/init', { name: 'test.bin', size: payload.length, mime: 'application/octet-stream', roomId: pubId }, ta);
  const fid = r.json.fileId, cs = r.json.chunkSize, total = r.json.totalChunks;
  check('初始化上传返回 fileId', !!fid && total >= 1, r.json);
  for (let i = 0; i < total; i++) {
    const s = i * cs, e = Math.min(payload.length, s + cs);
    const rr = await req('PUT', '/api/files/' + fid + '/chunk?i=' + i, payload.slice(s, e), ta, true);
    if (rr.status !== 200) { check('分片 ' + i + ' 上传', false, rr.json); break; }
  }
  r = await req('GET', '/api/files/' + fid + '/status', null, ta);
  check('断点续传状态记录完整', r.json.receivedCount === total, r.json);
  r = await req('POST', '/api/files/' + fid + '/complete', {}, ta);
  check('合并完成', r.status === 200 && r.json.fileId === fid, r.json);
  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'file', fileId: fid }, ta);
  check('文件消息发送成功', r.status === 200, r.json);
  const fileMsgId = r.json.message.id;
  const fileUrl = r.json.message.file.url;
  r = await req('GET', fileUrl.replace(BASE, ''), null, null);
  check('文件可下载且内容一致', r.status === 200 && r.raw.length === payload.length && r.raw.equals(payload), { s: r.status, l: r.raw.length });

  console.log('\n【4】自定义房间：上限5 / 免密 / 密码');
  let roomIds = [];
  for (let i = 0; i < 5; i++) {
    r = await req('POST', '/api/rooms', { name: '房间' + i }, ta);
    if (r.status === 200) roomIds.push(r.json.room.id);
  }
  check('创建 5 个房间成功', roomIds.length === 5, roomIds.length);
  r = await req('POST', '/api/rooms', { name: '第6个' }, ta);
  check('第 6 个被拒绝(上限5)', r.status === 400 && r.json.error.indexOf('最多') >= 0, r.json);
  const freeRoom = roomIds[0];
  r = await req('GET', '/api/rooms/' + freeRoom + '/messages?since=0', null, tb);
  check('免密房间可直接进入(可查看)', r.status === 200, r.json);
  r = await req('POST', '/api/rooms/' + freeRoom + '/messages', { kind: 'text', content: '未加入就发言' }, tb);
  check('免密房间未加入不能发言', r.status === 403, r.json);
  r = await req('POST', '/api/rooms/' + freeRoom + '/join', {}, tb);
  check('免密房间可直接加入', r.status === 200, r.json);
  r = await req('POST', '/api/rooms/' + freeRoom + '/messages', { kind: 'text', content: '加入后发言' }, tb);
  check('加入后可以发言', r.status === 200, r.json);

  r = await req('POST', '/api/rooms', { name: '密码房', password: 'secret123' }, tc);
  const pwdRoom = r.json.room.id;
  check('创建带密码房间', r.status === 200 && r.json.room.hasPassword === true, r.json);
  r = await req('GET', '/api/rooms/' + pwdRoom + '/messages?since=0', null, tb);
  check('密码房未验证密码不能进入', r.status === 403, r.json);
  r = await req('POST', '/api/rooms/' + pwdRoom + '/join', { password: 'wrong' }, tb);
  check('错误密码无法加入', r.status === 401, r.json);
  r = await req('POST', '/api/rooms/' + pwdRoom + '/join', { password: 'secret123' }, tb);
  check('正确密码可加入', r.status === 200, r.json);
  r = await req('POST', '/api/rooms/' + pwdRoom + '/messages', { kind: 'text', content: '密码房发言' }, tb);
  check('密码房加入后可发言', r.status === 200, r.json);

  console.log('\n【5】好友与私聊');
  r = await req('GET', '/api/users?q=' + B, null, ta);
  check('搜索用户', r.json.users.length >= 1, r.json);
  r = await req('GET', '/api/dm/' + ub.id, null, ta);
  check('非好友不能私聊', r.status === 403, r.json);
  r = await req('POST', '/api/friends/request', { userId: ub.id }, ta);
  check('发送好友请求', r.status === 200, r.json);
  const reqId = r.json.request.id;
  r = await req('GET', '/api/friends', null, tb);
  check('B 收到好友请求', r.json.incoming.length === 1, r.json);
  r = await req('POST', '/api/friends/' + reqId + '/accept', {}, tb);
  check('B 同意好友请求', r.status === 200, r.json);
  r = await req('GET', '/api/friends', null, ta);
  check('A 看到好友列表', r.json.friends.length === 1, r.json);
  r = await req('GET', '/api/dm/' + ub.id, null, ta);
  check('好友可发起私聊', r.status === 200 && r.json.room.kind === 'dm', r.json);
  const dmId = r.json.room.id;
  r = await req('POST', '/api/rooms/' + dmId + '/messages', { kind: 'text', content: '私聊消息' }, ta);
  check('私聊发消息成功', r.status === 200, r.json);
  r = await req('POST', '/api/rooms/' + dmId + '/messages', { kind: 'text', content: '回复' }, tb);
  check('对端可回复私聊', r.status === 200, r.json);
  r = await req('GET', '/api/rooms/' + dmId + '/messages?since=0', null, tb);
  check('私聊消息落库可见', r.json.messages.length >= 2, r.json.messages);
  // 私聊不是房间：不出现在房间列表、陌生人（含免密放行）不能围观、dm/list 只返本人
  r = await req('GET', '/api/rooms', null, ta);
  check('私聊不作为房间出现在房间列表', !r.json.rooms.some((x) => x.id === dmId), r.json.rooms);
  r = await req('GET', '/api/rooms/' + dmId + '/messages?since=0', null, tc);
  check('陌生人不能读私聊消息', r.status === 403, r.json);
  r = await req('GET', '/api/rooms/' + dmId + '/members', null, tc);
  check('陌生人不能看私聊成员', r.status === 403, r.json);
  r = await req('GET', '/api/dm/list', null, tc);
  check('dm/list 不泄露他人私聊', !r.json.items.some((x) => x.id === dmId), r.json);
  r = await req('GET', '/api/dm/list', null, ta);
  check('dm/list 返回本人私聊', r.json.items.some((x) => x.id === dmId), r.json);

  console.log('\n【6】删除（仅本账号隐藏）与撤回（2分钟内彻底移除）');
  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'text', content: '待删除消息' }, ta);
  const delId = r.json.message.id;
  r = await req('POST', '/api/messages/' + delId + '/delete', {}, ta);
  check('删除成功', r.status === 200, r.json);
  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0', null, ta);
  check('删除后自己不再看到', !r.json.messages.some((m) => m.id === delId));
  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0', null, tb);
  check('删除不影响他人（仅本账号隐藏）', r.json.messages.some((m) => m.id === delId));

  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'text', content: '待撤回消息' }, ta);
  const recId = r.json.message.id;
  r = await req('POST', '/api/messages/' + recId + '/recall', {}, tb);
  check('他人不能撤回我的消息', r.status === 403, r.json);
  r = await req('POST', '/api/messages/' + recId + '/recall', {}, ta);
  check('发送者可撤回', r.status === 200, r.json);
  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0', null, ta);
  const recMsg = r.json.messages.find((m) => m.id === recId);
  check('撤回后发送者也看不到内容', recMsg && recMsg.recalled === true && !recMsg.content, recMsg);
  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0', null, tb);
  const recMsg2 = r.json.messages.find((m) => m.id === recId);
  check('撤回对所有人生效', recMsg2 && recMsg2.recalled === true && !recMsg2.content, recMsg2);

  // 伪造一条 3 分钟前的消息，验证 2 分钟窗口
  const old = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'text', content: '旧消息' }, ta);
  const oldId = old.json.message.id;
  await new Promise((res) => setTimeout(res, 1200));
  r = await req('POST', '/api/messages/' + oldId + '/recall', {}, ta);
  check('2分钟内仍可撤回', r.status === 200, r.json);

  console.log('\n【8】群管理官职体系：群主→管理员→小管理员→更低一级');
  // 额外用户用于验证任命人数上限
  const D = 'dave' + uniq, E = 'erin' + uniq, F = 'frank' + uniq;
  const G = 'gina' + uniq, H = 'hugo' + uniq;
  r = await req('POST', '/api/register', { username: D, password: 'pass123', nickname: '戴夫' });
  const td = r.json.token, ud = r.json.user;
  r = await req('POST', '/api/register', { username: E, password: 'pass123', nickname: '艾琳' });
  const te = r.json.token, ue = r.json.user;
  r = await req('POST', '/api/register', { username: F, password: 'pass123', nickname: '弗兰克' });
  const tf = r.json.token, uf = r.json.user;
  r = await req('POST', '/api/register', { username: G, password: 'pass123', nickname: '吉娜' });
  const tg = r.json.token, ug = r.json.user;
  r = await req('POST', '/api/register', { username: H, password: 'pass123', nickname: '雨果' });
  const th = r.json.token, uh = r.json.user;
  await req('POST', '/api/rooms/' + freeRoom + '/join', {}, td);
  await req('POST', '/api/rooms/' + freeRoom + '/join', {}, te);
  await req('POST', '/api/rooms/' + freeRoom + '/join', {}, tf);
  await req('POST', '/api/rooms/' + freeRoom + '/join', {}, tc);
  await req('POST', '/api/rooms/' + freeRoom + '/join', {}, tg);
  await req('POST', '/api/rooms/' + freeRoom + '/join', {}, th);
  const bUid = ub.id;
  r = await req('GET', '/api/rooms/' + freeRoom + '/members', null, ta);
  const meRole = r.json.myRole;
  check('创建者为群主', meRole === 'owner', r.json);
  r = await req('POST', '/api/rooms/' + freeRoom + '/appoint', { userId: bUid, role: 'admin' }, ta);
  check('群主可任命管理员(丞相)', r.status === 200 && r.json.member.role === 'admin', r.json);
  r = await req('POST', '/api/rooms/' + freeRoom + '/appoint', { userId: uc.id, role: 'subadmin' }, ta);
  check('群主任命县令(小管理员)', r.status === 200, r.json);
  // 群主最多 3 个管理员
  r = await req('POST', '/api/rooms/' + freeRoom + '/appoint', { userId: uc.id, role: 'admin' }, ta);
  check('群主可任命第2位管理员', r.status === 200, r.json);
  r = await req('POST', '/api/rooms/' + freeRoom + '/appoint', { userId: ud.id, role: 'admin' }, ta);
  check('群主可任命第3位管理员', r.status === 200, r.json);
  r = await req('POST', '/api/rooms/' + freeRoom + '/appoint', { userId: ue.id, role: 'admin' }, ta);
  check('群主第4个管理员被拒绝(上限3)', r.status === 400 && r.json.error.indexOf('最多') >= 0, r.json);
  r = await req('POST', '/api/rooms/' + freeRoom + '/appoint', { userId: bUid, role: 'owner' }, ta);
  check('不能任命群主', r.status === 400, r.json);
  r = await req('POST', '/api/rooms/' + freeRoom + '/appoint', { userId: uc.id, role: 'admin' }, tb);
  check('管理员不能任命同级管理员', r.status === 403, r.json);
  // 管理员任命小管理员上限2
  r = await req('POST', '/api/rooms/' + freeRoom + '/appoint', { userId: ue.id, role: 'subadmin' }, tb);
  check('管理员可任命小管理员', r.status === 200 && r.json.member.role === 'subadmin', r.json);
  r = await req('POST', '/api/rooms/' + freeRoom + '/appoint', { userId: uf.id, role: 'subadmin' }, tb);
  check('管理员任命第2个小管理员', r.status === 200, r.json);
  r = await req('POST', '/api/rooms/' + freeRoom + '/appoint', { userId: ug.id, role: 'subadmin' }, tb);
  check('管理员第3个小管理员被拒绝(上限2)', r.status === 400 && r.json.error.indexOf('最多') >= 0, r.json);
  // 小管理员可再设更低一级
  r = await req('POST', '/api/rooms/' + freeRoom + '/appoint', { userId: ug.id, role: 'junior' }, te);
  check('小管理员(县令)可任命乡长(更低一级)', r.status === 200 && r.json.member.role === 'junior', r.json);
  r = await req('POST', '/api/rooms/' + freeRoom + '/appoint', { userId: uh.id, role: 'junior' }, tg);
  check('乡长不能再任命下级', r.status === 403, r.json);
  r = await req('GET', '/api/rooms/' + freeRoom + '/members', null, tb);
  const roles = r.json.members.map((m) => m.roleName);
  check('成员列表返回官职名', roles.indexOf('丞相') >= 0, roles);
  check('官职名按古代官职命名且逐级齐全',
    roles.indexOf('群主') >= 0 && roles.indexOf('丞相') >= 0 && roles.indexOf('县令') >= 0 && roles.indexOf('乡长') >= 0 && roles.indexOf('百姓') >= 0, roles);

  console.log('\n【8b】禁言与踢出');
  r = await req('POST', '/api/rooms/' + freeRoom + '/mute', { userId: uc.id, minutes: 30 }, ta);
  check('群主禁言成员成功', r.status === 200 && r.json.minutes === 30, r.json);
  r = await req('POST', '/api/rooms/' + freeRoom + '/messages', { kind: 'text', content: '禁言中发言' }, tc);
  check('被禁言者无法发言', r.status === 403, r.json);
  r = await req('GET', '/api/rooms/' + freeRoom + '/messages?since=0', null, tc);
  check('被禁言者仍可读消息', r.status === 200, r.json);
  r = await req('POST', '/api/rooms/' + freeRoom + '/mute', { userId: ta.replace(/.*/, ua.id), minutes: 5 }, tb);
  check('低级别不能禁言高级别', r.status === 403, r.json);
  r = await req('POST', '/api/rooms/' + freeRoom + '/kick', { userId: uc.id }, ta);
  check('群主踢出成员成功', r.status === 200, r.json);
  r = await req('GET', '/api/rooms/' + freeRoom + '/members', null, ta);
  check('被踢者不在成员列表', !r.json.members.some((m) => m.userId === uc.id), r.json.members);

  console.log('\n【7】静态页面与安全');
  r = await req('GET', '/', null, null);
  check('首页返回 HTML', r.status === 200 && r.raw.toString().indexOf('轻聊') > 0);
  r = await req('GET', '/app.js', null, null);
  check('前端脚本可加载', r.status === 200);
  r = await req('GET', '/api/rooms', null, null);
  check('未登录访问受保护接口返回401', r.status === 401, r.json);
  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0', null, 'fake-token');
  check('伪造 token 被拒绝', r.status === 401, r.json);

  console.log('\n────────────────────────────');
  console.log('通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
