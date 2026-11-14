'use strict';
/**
 * 多选（批量操作）专项测试
 *
 * 交互约定（微信 / QQ 式）：
 *   多选模式    = 可勾选多条消息
 *   批量删除    = 仅对本机隐藏，服务端数据与文件字节原样保留，他人照常可见
 *   批量直接删除 = 服务器端真正清除，所有设备同步消失，文件字节彻底删除
 *   撤回        = 只支持单条，多选模式下不提供（接口本身也一直是单条的）
 *
 * 本文件验证服务端批量接口的语义边界：
 *   - 空列表 / 超量列表被拒
 *   - 批量删除只影响当前账号
 *   - 批量直接删除仅发送者本人可执行，他人消息被跳过而不是整批失败
 *   - 批量直接删除后 purgedIds 正常下发（跨端同步信号）
 *   - 撤回仍是单条接口，不受多选影响
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
        resolve({ status: res.statusCode, json: j, raw, headers: res.headers });
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
function findMsg(list, id) {
  return (list || []).find((x) => x.id === id) || null;
}
async function send(token, roomId, content) {
  const r = await req('POST', '/api/rooms/' + roomId + '/messages', { kind: 'text', content }, token);
  return r.json && r.json.message ? r.json.message.id : null;
}

(async () => {
  const uniq = crypto.randomBytes(3).toString('hex');
  const A = 'ma' + uniq, B = 'mb' + uniq;
  const pw = 'pass123';

  let r = await req('POST', '/api/register', { username: A, password: pw, nickname: '甲' });
  const ta = r.json.token;
  r = await req('POST', '/api/register', { username: B, password: pw, nickname: '乙' });
  const tb = r.json.token;
  check('两个测试账号注册成功', !!ta && !!tb);

  r = await req('GET', '/api/rooms', null, ta);
  const pubId = r.json.publicRoomId;
  check('公共聊天室存在', !!pubId, r.json);

  /* ---------------- A. 参数校验 ---------------- */
  console.log('\n【A】批量接口参数校验');

  r = await req('POST', '/api/messages/batch-delete', { ids: [] }, ta);
  check('批量删除：空列表被拒(400)', r.status === 400, r.json);

  r = await req('POST', '/api/messages/batch-purge', { ids: [] }, ta);
  check('批量直接删除：空列表被拒(400)', r.status === 400, r.json);

  r = await req('POST', '/api/messages/batch-delete', { ids: [] });
  check('批量删除：未登录被拒(401)', r.status === 401, r.json);

  r = await req('POST', '/api/messages/batch-purge', { ids: [] });
  check('批量直接删除：未登录被拒(401)', r.status === 401, r.json);

  const tooMany = [];
  for (let i = 0; i < 201; i++) tooMany.push('x' + i);
  r = await req('POST', '/api/messages/batch-delete', { ids: tooMany }, ta);
  check('批量删除：超过 200 条被拒(400)', r.status === 400, r.json);

  r = await req('POST', '/api/messages/batch-purge', { ids: tooMany }, ta);
  check('批量直接删除：超过 200 条被拒(400)', r.status === 400, r.json);

  r = await req('POST', '/api/messages/batch-delete', { ids: 'notanarray' }, ta);
  check('批量删除：ids 非数组被拒(400)', r.status === 400, r.json);

  /* ---------------- B. 批量删除：仅本机隐藏 ---------------- */
  console.log('\n【B】批量删除（仅本机隐藏）');

  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await send(ta, pubId, '批量删除测试 ' + i));
  check('批量创建 5 条消息', ids.every((x) => !!x), ids);

  r = await req('POST', '/api/messages/batch-delete', { ids }, ta);
  check('批量删除返回 ok', r.status === 200 && r.json.ok === true, r.json);
  check('批量删除返回 hidden 列表', r.json.hidden && r.json.hidden.length === 5, r.json);
  check('批量删除 count = 5', r.json.count === 5, r.json);
  check('批量删除无失败项', !r.json.failed || r.json.failed.length === 0, r.json.failed);

  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0&limit=200', null, ta);
  const stillA = ids.filter((id) => findMsg(r.json.messages, id));
  check('本机已看不到这 5 条', stillA.length === 0, stillA);

  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0&limit=200', null, tb);
  const stillB = ids.filter((id) => findMsg(r.json.messages, id));
  check('旁观者端仍能看到全部 5 条（服务端数据保留）', stillB.length === 5, stillB);
  const bm = findMsg(r.json.messages, ids[0]);
  check('旁观者端内容完整未被清空', bm && bm.content === '批量删除测试 0', bm);

  /* ---------------- C. 批量删除：混入不存在 / 无权的条目 ---------------- */
  console.log('\n【C】批量删除的容错');

  const mixOk = await send(ta, pubId, '混合删除 - 正常条目');
  r = await req('POST', '/api/messages/batch-delete',
    { ids: [mixOk, 'm_notexist999'] }, ta);
  check('含不存在条目时整体仍返回 ok', r.status === 200 && r.json.ok === true, r.json);
  check('存在的条目被成功隐藏', r.json.hidden && r.json.hidden.indexOf(mixOk) >= 0, r.json);
  check('不存在的条目进入 failed', r.json.failed && r.json.failed.length === 1, r.json.failed);
  check('失败原因写明「消息不存在」',
    r.json.failed && r.json.failed[0].reason && r.json.failed[0].reason.indexOf('不存在') >= 0,
    r.json.failed);

  /* ---------------- D. 批量直接删除：仅发送者本人 ---------------- */
  console.log('\n【D】批量直接删除（服务器端彻底清除）');

  const mine = [];
  for (let i = 0; i < 3; i++) mine.push(await send(ta, pubId, '甲的批量待删 ' + i));
  const theirs = [];
  for (let i = 0; i < 2; i++) theirs.push(await send(tb, pubId, '乙的批量待删 ' + i));

  r = await req('POST', '/api/messages/batch-purge', { ids: mine }, ta);
  check('批量直接删除返回 ok', r.status === 200 && r.json.ok === true, r.json);
  check('自己的 3 条全部清除', r.json.purged && r.json.purged.length === 3, r.json);
  check('count = 3', r.json.count === 3, r.json);

  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0&limit=200', null, ta);
  check('本机列表已不含这 3 条', !mine.some((id) => findMsg(r.json.messages, id)), mine);
  check('本机收到 purgedIds 通知',
    r.json.purgedIds && mine.every((id) => r.json.purgedIds.indexOf(id) >= 0), r.json.purgedIds);

  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0&limit=200', null, tb);
  check('旁观者端列表同样已不含这 3 条（所有地方清空）',
    !mine.some((id) => findMsg(r.json.messages, id)), mine);
  check('旁观者端也收到 purgedIds',
    r.json.purgedIds && mine.every((id) => r.json.purgedIds.indexOf(id) >= 0), r.json.purgedIds);
  check('旁观者端仍能看到乙自己的消息', theirs.every((id) => findMsg(r.json.messages, id)), theirs);

  /* 混入他人消息：他人消息被跳过，而不是整批失败 */
  const oneMine = await send(ta, pubId, '甲的单独一条');
  r = await req('POST', '/api/messages/batch-purge', { ids: [oneMine, theirs[0]] }, ta);
  check('混入他人消息时整体仍返回 ok', r.status === 200 && r.json.ok === true, r.json);
  check('自己的那条被清除', r.json.purged && r.json.purged.indexOf(oneMine) >= 0, r.json);
  check('他人的那条被跳过', r.json.failed && r.json.failed.length === 1, r.json.failed);
  check('跳过原因写明「只能直接删除自己发送的消息」',
    r.json.failed && r.json.failed[0].reason && r.json.failed[0].reason.indexOf('自己发送') >= 0,
    r.json.failed);

  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0&limit=200', null, tb);
  check('乙自己的消息未被甲删掉', findMsg(r.json.messages, theirs[0]), theirs[0]);

  /* 重复批量删除同一批：全部进入 failed，不报错 */
  r = await req('POST', '/api/messages/batch-purge', { ids: mine }, ta);
  check('重复批量直接删除不报错', r.status === 200 && r.json.ok === true, r.json);
  check('重复清除的条目全部进入 failed', r.json.failed && r.json.failed.length === 3, r.json.failed);

  /* ---------------- E. 撤回仍是单条，不受多选影响 ---------------- */
  console.log('\n【E】撤回保持单条语义');

  const recallId = await send(ta, pubId, '待撤回的单条');
  r = await req('POST', '/api/messages/' + recallId + '/recall', {}, ta);
  check('单条撤回成功', r.status === 200 && r.json.recalled === true, r.json);

  r = await req('POST', '/api/messages/batch-purge', { ids: [recallId] }, ta);
  check('已撤回的消息在批量直接删除中被跳过', r.status === 200 && r.json.failed && r.json.failed.length === 1, r.json);

  r = await req('POST', '/api/messages/' + recallId + '/recall', {}, ta);
  check('重复撤回被拒(400)', r.status === 400, r.json);

  /* ---------------- F. 文件消息的批量处理 ---------------- */
  console.log('\n【F】带文件的消息');

  r = await req('POST', '/api/files/init', {
    name: 'batch.txt', size: 5, mime: 'text/plain', roomId: pubId
  }, ta);
  const fileId = r.json.fileId;
  check('文件初始化成功', !!fileId, r.json);
  r = await req('PUT', '/api/files/' + fileId + '/chunk?i=0', Buffer.from('hello'), ta, true);
  check('分片上传成功', r.status === 200, r.json);
  r = await req('POST', '/api/files/' + fileId + '/complete', {}, ta);
  check('文件完成', r.status === 200 && r.json.fileId === fileId, r.json);

  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'file', fileId }, ta);
  const fileMsgId = r.json.message.id;
  check('文件消息发送成功', !!fileMsgId, r.json);

  r = await req('POST', '/api/messages/batch-purge', { ids: [fileMsgId] }, ta);
  check('带文件的消息可被批量直接删除', r.status === 200 && r.json.purged && r.json.purged.length === 1, r.json);

  r = await req('GET', '/api/files/' + fileId + '/status', null, ta);
  check('文件元数据已随消息一并清除', r.status === 404 || (r.json && !r.json.file), r.json);

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常:', e && e.stack ? e.stack : e);
  console.log('\n通过: ' + pass + '  失败: ' + (fail + 1));
  process.exit(1);
});
