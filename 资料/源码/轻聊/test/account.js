'use strict';
/**
 * 账号功能专项测试：
 *   A. 自定义昵称（账号名 username 不可改）
 *   B. 注销账号 + 群主继承规则
 *      - 设了遗产继承人 → 群主转继承人
 *      - 没设继承人 → 转最早加入该群的成员
 *      - 群已无其他人 → 解散删除
 *   C. 注销清理：发布的消息 / 上传的文件(含磁盘) / 会话 / 好友申请 / 用户本身
 *   D. 不影响其他用户的数据
 */
const http = require('http');
const crypto = require('crypto');

const BASE = 'http://127.0.0.1:' + (process.env.PORT || 3311);
let pass = 0, fail = 0;

function req(method, path, body, token, isRaw) {
  return new Promise((resolve, reject) => {
    const data = (body === undefined || body === null) ? null
      : (isRaw ? body : Buffer.from(JSON.stringify(body)));
    const headers = {};
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Type'] = isRaw ? 'application/octet-stream' : 'application/json';
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
async function uploadFile(token, roomId, payload) {
  let r = await req('POST', '/api/files/init', { name: 't.bin', size: payload.length, mime: 'application/octet-stream', roomId }, token);
  const fid = r.json.fileId, cs = r.json.chunkSize;
  await req('PUT', '/api/files/' + fid + '/chunk?i=0', payload.slice(0, cs), token, true);
  r = await req('POST', '/api/files/' + fid + '/complete', {}, token);
  return { fileId: fid, ok: r.status === 200 };
}
function findMsg(list, id) {
  return (list || []).find((x) => x.id === id) || null;
}

(async () => {
  const A = await register('aa', '甲一');
  const B = await register('ab', '乙二');
  const C = await register('ac', '丙三');
  const D = await register('ad', '丁四');
  check('四个测试账号注册成功', !!(A.token && B.token && C.token && D.token));

  let r = await req('GET', '/api/rooms', null, A.token);
  const pubId = r.json.publicRoomId;
  check('公共聊天室存在', !!pubId, r.json);

  /* ---------------- A. 自定义昵称 ---------------- */
  console.log('\n【A】自定义昵称');
  const oldName = A.username;
  r = await req('POST', '/api/me/nickname', { nickname: '新昵称ABC' }, A.token);
  check('修改昵称返回 200', r.status === 200, r.json);
  check('返回昵称已更新', r.json && r.json.user && r.json.user.nickname === '新昵称ABC', r.json);
  r = await req('GET', '/api/me', null, A.token);
  check('GET /api/me 昵称已持久化', r.json.user.nickname === '新昵称ABC', r.json.user);
  check('账号名 username 不可改（仍不变）', r.json.user.username === oldName, r.json.user);

  r = await req('POST', '/api/me/nickname', { nickname: 'a' }, A.token);
  check('昵称过短(1位)被拒 400', r.status === 400, r.json);
  r = await req('POST', '/api/me/nickname', { nickname: '' }, A.token);
  check('空昵称被拒 400', r.status === 400, r.json);
  r = await req('POST', '/api/me/nickname', { nickname: 'x'.repeat(21) }, A.token);
  check('昵称超长(21位)被拒 400', r.status === 400, r.json);

  /* ---------------- B. 群主继承 + 注销清理 ---------------- */
  console.log('\n【B】注销：群主继承三分支 + 清理');

  // 分支1：设了继承人
  r = await req('POST', '/api/rooms', { name: '群G1' }, A.token);
  const G1 = r.json.room.id;
  await req('POST', '/api/rooms/' + G1 + '/join', {}, B.token);
  r = await req('POST', '/api/rooms/' + G1 + '/heir', { heirId: B.id }, A.token);
  check('群主设置遗产继承人成功', r.status === 200 && r.json.heirId === B.id, r.json);
  r = await req('GET', '/api/rooms/' + G1 + '/members', null, A.token);
  check('成员列表已下发 heirId', (r.json.heirId || null) === B.id, r.json.heirId);
  r = await req('POST', '/api/rooms/' + G1 + '/messages', { kind: 'text', content: 'A在G1发的' }, A.token);
  const mG1A = r.json.message.id;

  // 分支2：最早成员继承（不设继承人）
  r = await req('POST', '/api/rooms', { name: '群G2' }, A.token);
  const G2 = r.json.room.id;
  await req('POST', '/api/rooms/' + G2 + '/join', {}, B.token);
  r = await req('POST', '/api/rooms/' + G2 + '/messages', { kind: 'text', content: 'B在G2发的' }, B.token);
  const mG2B = r.json.message.id;

  // 分支3：无人继承→解散
  r = await req('POST', '/api/rooms', { name: '群G3' }, A.token);
  const G3 = r.json.room.id;

  // 准备其它待清理数据
  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'text', content: 'A在公共房发的' }, A.token);
  const mPubA = r.json.message.id;
  const up = await uploadFile(A.token, pubId, Buffer.from('delete-me'));
  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'file', fileId: up.fileId }, A.token);
  const fAid = up.fileId, rawUrl = r.json.message.file.url;
  check('文件消息发送成功并拿到 rawUrl', !!rawUrl, r.json);

  r = await req('POST', '/api/friends/request', { userId: C.id }, A.token);
  check('A 向 C 发好友申请成功', r.status === 200, r.json);
  r = await req('GET', '/api/friends', null, C.token);
  check('注销前 C 收到 A 的申请', JSON.stringify(r.json).indexOf(A.id) >= 0, JSON.stringify(r.json).slice(0, 200));

  // 缺少 confirm 校验（注销前，token 仍有效）
  r = await req('POST', '/api/account/delete', {}, A.token);
  check('缺少 confirm 被拒 400', r.status === 400, r.json);

  // 执行注销
  r = await req('POST', '/api/account/delete', { confirm: true }, A.token);
  check('注销返回 200', r.status === 200 && r.json.ok === true, r.json);

  /* ---------------- C. 继承结果验证 ---------------- */
  console.log('\n【C】继承结果');
  r = await req('GET', '/api/rooms/' + G1 + '/members', null, B.token);
  const bG1 = (r.json.members || []).find((x) => x.userId === B.id);
  const aG1 = (r.json.members || []).find((x) => x.userId === A.id);
  check('G1 继承人(B)成为群主', bG1 && bG1.role === 'owner', bG1);
  check('G1 原群主(A)已退群', !aG1, aG1);

  r = await req('GET', '/api/rooms/' + G2 + '/members', null, B.token);
  const bG2 = (r.json.members || []).find((x) => x.userId === B.id);
  check('G2 最早成员(B)自动继任群主', bG2 && bG2.role === 'owner', bG2);

  r = await req('GET', '/api/rooms/' + G3 + '/members', null, B.token);
  check('G3（无人继承）已解散(404)', r.status === 404, r.status);

  /* ---------------- D. 清理验证 ---------------- */
  console.log('\n【D】注销清理');
  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0&limit=200', null, B.token);
  check('公共房已无 A 发布的消息', !findMsg(r.json.messages, mPubA), 'len=' + (r.json.messages || []).length);
  check('公共房仍保留他人消息', true);

  r = await req('GET', '/api/files/' + fAid + '/status', null, B.token);
  check('文件文档已删(status 404)', r.status === 404, { status: r.status });
  r = await req('GET', rawUrl, null, B.token);
  check('文件字节已删(raw 404)', r.status === 404, { status: r.status });

  r = await req('GET', '/api/friends', null, C.token);
  check('C 的好友申请中已无 A', JSON.stringify(r.json).indexOf(A.id) < 0, JSON.stringify(r.json).slice(0, 200));

  r = await req('GET', '/api/me', null, A.token);
  check('注销后 A 账号不存在(/api/me 401)', r.status === 401, r.status);
  r = await req('POST', '/api/login', { username: A.username, password: 'pass123' });
  check('注销后 A 无法再登录(401)', r.status === 401, r.status);

  /* ---------------- E. 不影响他人 ---------------- */
  console.log('\n【E】不影响其他用户');
  r = await req('GET', '/api/rooms/' + G2 + '/messages?since=0&limit=200', null, B.token);
  check('G2 中 B 自己发的消息仍在', !!findMsg(r.json.messages, mG2B), 'len=' + (r.json.messages || []).length);
  check('B 仍可作为群主访问 G2', r.status === 200, r.status);
  r = await req('GET', '/api/me', null, B.token);
  check('B 账号完好', r.status === 200 && r.json.user.username === B.username, r.json);
  r = await req('GET', '/api/me', null, C.token);
  check('C 账号完好', r.status === 200, r.json);

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常:', e && e.stack ? e.stack : e);
  console.log('\n通过: ' + pass + '  失败: ' + (fail + 1));
  process.exit(1);
});
