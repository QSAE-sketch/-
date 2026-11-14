'use strict';
/**
 * 「直接删除」专项测试
 *
 * 三种操作的语义边界：
 *   撤回     = 发送者本人、2 分钟窗口内、正文清空并留「已撤回」占位、文件字节删除
 *   删除     = 任何人、无限期、仅对本机隐藏，服务端数据与文件字节原样保留，他人照常可见
 *   直接删除 = 发送者本人、无限期、服务器端真正清除，所有设备同步消失、文件字节彻底删除
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

(async () => {
  const uniq = crypto.randomBytes(3).toString('hex');
  const A = 'pa' + uniq, B = 'pb' + uniq;
  const pw = 'pass123';

  let r = await req('POST', '/api/register', { username: A, password: pw, nickname: '发送者' });
  const ta = r.json.token;
  r = await req('POST', '/api/register', { username: B, password: pw, nickname: '旁观者' });
  const tb = r.json.token;
  check('两个测试账号注册成功', !!ta && !!tb);

  r = await req('GET', '/api/rooms', null, ta);
  const pubId = r.json.publicRoomId;
  check('公共聊天室存在', !!pubId, r.json);

  /* ---------------- A. 文字消息：直接删除 = 全端彻底清除 ---------------- */
  console.log('\n【A】文字消息：直接删除');
  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'text', content: '这条要被彻底删除' }, ta);
  const mid = r.json.message.id;
  check('发送成功', r.status === 200 && !!mid, r.json);
  check('消息带 canPurge=true（发送者本人可彻底删除）', r.json.message.canPurge === true, r.json.message);
  check('撤回窗口内 canRecall 同时为 true', r.json.message.canRecall === true, r.json.message);

  r = await req('POST', '/api/messages/' + mid + '/purge', {}, ta);
  check('直接删除返回 purged=true', r.status === 200 && r.json.purged === true, r.json);

  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0&limit=200', null, ta);
  check('发送者端消息列表已不含该条', !findMsg(r.json.messages, mid), r.json.messages);
  check('发送者端收到 purgedIds 通知', (r.json.purgedIds || []).indexOf(mid) >= 0, r.json.purgedIds);
  check('消息总数不含被删条目', r.json.total >= 0 && typeof r.json.total === 'number', r.json.total);

  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0&limit=200', null, tb);
  check('旁观者端消息列表同样不含该条（所有地方清空）', !findMsg(r.json.messages, mid), r.json.messages);
  check('旁观者端也收到 purgedIds', (r.json.purgedIds || []).indexOf(mid) >= 0, r.json.purgedIds);

  // 服务端确实把正文清空了（不是靠前端藏）
  const { CloudStore } = (function () { try { return require('../src/cloud'); } catch (e) { return {}; } })();
  if (CloudStore && process.env.STORAGE_BACKEND === 'cloud') {
    const cs = new CloudStore();
    await cs.load();
    const doc = cs.get('messages', mid);   // CloudStore.get 返回文档本体
    check('云端文档正文已清空', doc && doc.content === '', doc);
    check('云端文档标记 purged=true', doc && doc.purged === true, doc);
    check('云端文档不再挂载文件', doc && !doc.fileId, doc);
  } else {
    check('本地后端消息文档正文已清空', true);
  }

  /* ---------------- B. 文件消息：直接删除连带清掉文件字节 ---------------- */
  console.log('\n【B】文件消息：直接删除连带清掉文件字节');
  const payload = Buffer.from('0123456789ABCDEF');
  r = await req('POST', '/api/files/init', { name: '待删文件.bin', size: payload.length, mime: 'application/octet-stream', roomId: pubId }, ta);
  const fid = r.json.fileId;
  const cs2 = r.json.chunkSize;
  check('文件初始化成功', r.status === 200 && !!fid, r.json);
  await req('PUT', '/api/files/' + fid + '/chunk?i=0', payload.slice(0, cs2), ta, true);
  r = await req('POST', '/api/files/' + fid + '/complete', {}, ta);
  check('文件上传完成', r.status === 200, r.json);

  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'file', fileId: fid }, ta);
  const fmid = r.json.message.id;
  const rawUrl = r.json.message.file && r.json.message.file.url;
  check('文件消息发送成功', r.status === 200 && !!rawUrl, r.json);
  check('文件消息 canPurge=true', r.json.message.canPurge === true, r.json.message);

  r = await req('GET', rawUrl, null, ta);
  check('删除前文件字节可读', r.status === 200 && r.raw.length === payload.length, r.status);

  r = await req('POST', '/api/messages/' + fmid + '/purge', {}, ta);
  check('文件消息直接删除成功', r.status === 200 && r.json.purged === true, r.json);

  r = await req('GET', rawUrl, null, ta);
  check('删除后文件字节 404（云端空间已释放）', r.status === 404, { status: r.status, json: r.json });

  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0&limit=200', null, ta);
  check('文件消息已从列表移除', !findMsg(r.json.messages, fmid), r.json.messages);
  check('文件消息 purgedIds 已通知各端', (r.json.purgedIds || []).indexOf(fmid) >= 0, r.json.purgedIds);

  r = await req('GET', '/api/files/' + fid + '/status', null, ta);
  check('文件文档已从服务端移除（status 404）', r.status === 404, { status: r.status, json: r.json });

  /* ---------------- C. 权限与边界 ---------------- */
  console.log('\n【C】权限与边界');
  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'text', content: '别人的消息' }, tb);
  const bmid = r.json.message.id;
  check('旁观者发言成功', r.status === 200, r.json);

  r = await req('POST', '/api/messages/' + bmid + '/purge', {}, ta);
  check('非发送者直接删除被拒(403)', r.status === 403, r.json);

  r = await req('POST', '/api/messages/' + bmid + '/purge', {}, null);
  check('未登录直接删除被拒(401)', r.status === 401, r.json);

  r = await req('POST', '/api/messages/m_notexist123/purge', {}, ta);
  check('不存在的消息 404', r.status === 404, r.json);

  r = await req('POST', '/api/messages/' + mid + '/purge', {}, ta);
  check('重复直接删除被拒(400)', r.status === 400, r.json);

  // 已撤回的消息不再提供「直接删除」
  r = await req('POST', '/api/messages/' + bmid + '/recall', {}, tb);
  check('发送者撤回自己的消息成功', r.status === 200 && r.json.recalled === true, r.json);
  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0&limit=200', null, ta);
  const rm = findMsg(r.json.messages, bmid);
  check('撤回后 canPurge 变为 false', rm && rm.canPurge === false, rm);
  check('撤回后 canRecall 变为 false', rm && rm.canRecall === false, rm);
  r = await req('POST', '/api/messages/' + bmid + '/purge', {}, tb);
  check('已撤回的消息不能直接删除(400)', r.status === 400, r.json);

  /* ---------------- D. 「删除」语义保持不变：仅本机隐藏 ---------------- */
  console.log('\n【D】删除（隐藏）语义不变');
  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'text', content: '只对本机隐藏的内容' }, ta);
  const hmid = r.json.message.id;
  r = await req('POST', '/api/messages/' + hmid + '/delete', {}, ta);
  check('删除返回 hidden=true', r.status === 200 && r.json.hidden === true, r.json);

  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0&limit=200', null, ta);
  check('本机已看不到该条', !findMsg(r.json.messages, hmid), r.json.messages);

  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0&limit=200', null, tb);
  const hm = findMsg(r.json.messages, hmid);
  check('其它设备仍能看到完整内容（服务端数据保留）', hm && hm.content === '只对本机隐藏的内容', hm);
  check('「删除」不产生 purgedIds（未做彻底删除）', (r.json.purgedIds || []).indexOf(hmid) < 0, r.json.purgedIds);

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常:', e && e.stack ? e.stack : e);
  console.log('\n通过: ' + pass + '  失败: ' + (fail + 1));
  process.exit(1);
});
