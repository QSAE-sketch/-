'use strict';
/** 补充流程测试：免密房间"进入→未加入不能发言→加入后可发言"、密码房流程、断点续传 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

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

(async () => {
  const uniq = crypto.randomBytes(3).toString('hex');
  const A = 'ra' + uniq, B = 'rb' + uniq;

  let r = await req('POST', '/api/register', { username: A, password: 'pass123', nickname: '房主' });
  const ta = r.json.token, ua = r.json.user;
  r = await req('POST', '/api/register', { username: B, password: 'pass123', nickname: '访客' });
  const tb = r.json.token, ub = r.json.user;

  console.log('\n【A】免密房间：进入→加入→发言');
  r = await req('POST', '/api/rooms', { name: '免密测试房' }, ta);
  const fr = r.json.room.id;
  check('创建免密房间', r.status === 200 && r.json.room.hasPassword === false, r.json);
  r = await req('GET', '/api/rooms/' + fr + '/messages?since=0', null, tb);
  check('未加入也能进入查看', r.status === 200, r.json);
  check('服务端标记 joined=false', r.json.joined === false, r.json);
  check('服务端标记 canPost=false（加入后才可发消息）', r.json.canPost === false, r.json);
  r = await req('POST', '/api/rooms/' + fr + '/messages', { kind: 'text', content: 'x' }, tb);
  check('未加入发消息被拒(403)', r.status === 403, r.json);
  r = await req('POST', '/api/rooms/' + fr + '/join', {}, tb);
  check('免密房间一键加入', r.status === 200, r.json);
  r = await req('GET', '/api/rooms/' + fr + '/messages?since=0', null, tb);
  check('加入后 joined=true 且 canPost=true', r.json.joined === true && r.json.canPost === true, r.json);
  r = await req('POST', '/api/rooms/' + fr + '/messages', { kind: 'text', content: '加入后可以说话了' }, tb);
  check('加入后发言成功', r.status === 200, r.json);

  console.log('\n【B】密码房：校验→加入→发言');
  r = await req('POST', '/api/rooms', { name: '密室', password: 'open sesame' }, ta);
  const pr = r.json.room.id;
  check('创建密码房', r.status === 200 && r.json.room.hasPassword === true, r.json);
  r = await req('GET', '/api/rooms/' + pr + '/messages?since=0', null, tb);
  check('密码房未验证不能进入(403)', r.status === 403, r.json);
  r = await req('POST', '/api/rooms/' + pr + '/join', { password: 'bad pass' }, tb);
  check('错误密码被拒(401)', r.status === 401, r.json);
  r = await req('POST', '/api/rooms/' + pr + '/verify', { password: 'open sesame' }, tb);
  check('verify 接口密码正确', r.status === 200, r.json);
  r = await req('GET', '/api/rooms/' + pr + '/messages?since=0', null, tb);
  check('验证后可以进入查看', r.status === 200, r.json);
  r = await req('POST', '/api/rooms/' + pr + '/join', { password: 'open sesame' }, tb);
  check('正确密码加入成功', r.status === 200, r.json);
  r = await req('POST', '/api/rooms/' + pr + '/messages', { kind: 'text', content: '密室内发言' }, tb);
  check('密码房加入后可发言', r.status === 200, r.json);

  console.log('\n【C】断点续传：中途模拟断网后续传');
  const payload = crypto.randomBytes(9 * 1024 * 1024);   // 9MB → 3 片
  r = await req('POST', '/api/files/init', { name: 'resume.bin', size: payload.length, mime: 'application/octet-stream', roomId: fr }, ta);
  const fid = r.json.fileId, cs = r.json.chunkSize, total = r.json.totalChunks;
  check('初始化上传，totalChunks=' + total, r.status === 200 && total === 3, r.json);
  // 只传第 0 片，然后"断网"
  await req('PUT', '/api/files/' + fid + '/chunk?i=0', payload.slice(0, cs), ta, true);
  r = await req('GET', '/api/files/' + fid + '/status', null, ta);
  check('断点状态记录已收 1 片', r.json.receivedCount === 1 && r.json.received[0] === 0, r.json);
  // 重新 init 携带 resumeId → 服务端识别未完成会话
  r = await req('POST', '/api/files/init', { name: 'resume.bin', size: payload.length, mime: 'application/octet-stream', roomId: fr, resumeId: fid }, ta);
  check('续传会话被复用(resumed=true)', r.json.resumed === true && r.json.fileId === fid, r.json);
  check('续传返回已收分片清单', r.json.received.length === 1, r.json);
  // 继续传剩余分片
  for (let i = 1; i < total; i++) {
    await req('PUT', '/api/files/' + fid + '/chunk?i=' + i, payload.slice(i * cs, Math.min(payload.length, (i + 1) * cs)), ta, true);
  }
  r = await req('POST', '/api/files/' + fid + '/complete', {}, ta);
  check('续传后合并成功', r.status === 200, r.json);
  // 上传完成后发送文件消息
  r = await req('POST', '/api/rooms/' + fr + '/messages', { kind: 'file', fileId: fid }, ta);
  check('文件消息发送成功', r.status === 200 && r.json.message.kind === 'file', r.json);
  r = await req('GET', '/api/rooms/' + fr + '/messages?since=0', null, tb);
  const fm = r.json.messages.find((m) => m.kind === 'file');
  check('文件消息出现在房间中', !!fm, r.json.messages);
  r = await req('GET', fm.file.url.replace(BASE, ''), null, null);
  check('下载文件内容与原文件完全一致', r.status === 200 && r.raw.equals(payload), { s: r.status, l: r.raw.length, o: payload.length });

  console.log('\n【D】大文件分片（模拟 200MB / 50片）');
  const bigSize = 200 * 1024 * 1024;
  r = await req('POST', '/api/files/init', { name: 'huge.bin', size: bigSize, mime: 'application/octet-stream', roomId: fr }, ta);
  check('200MB 文件初始化，总片数=50', r.status === 200 && r.json.totalChunks === 50, r.json);

  console.log('\n【E】Range 请求（视频拖动）');
  r = await req('GET', fm.file.url.replace(BASE, ''), null, null);
  check('完整下载返回 200 且带 Accept-Ranges', r.status === 200 && r.headers['accept-ranges'] === 'bytes', { s: r.status, ar: r.headers['accept-ranges'] });
  r = await req('GET', fm.file.url.replace(BASE, '') , null, null);
  check('可访问完整文件', r.raw.length === payload.length);

  console.log('\n【F】撤回后文件彻底移除');
  r = await req('POST', '/api/rooms/' + fr + '/messages', { kind: 'file', fileId: fid }, ta);
  const fmsg = r.json.message;
  const furl = fmsg.file.url;
  r = await req('GET', furl.replace(BASE, ''), null, null);
  check('撤回前文件可下载', r.status === 200, r.status);
  r = await req('POST', '/api/messages/' + fmsg.id + '/recall', {}, ta);
  check('撤回带文件的消息成功', r.status === 200, r.json);
  r = await req('GET', furl.replace(BASE, ''), null, null);
  check('撤回后文件服务端已彻底移除(404)', r.status === 404, r.status);
  r = await req('GET', '/api/rooms/' + fr + '/messages?since=0', null, tb);
  const rec = r.json.messages.find((m) => m.id === fmsg.id);
  check('撤回后消息内容清空且标记 recalled', rec && rec.recalled === true && !rec.content && !rec.file, rec);

  console.log('\n【G】删除文件（仅本账号隐藏）');
  r = await req('POST', '/api/files/init', { name: 'del.txt', size: 10, mime: 'text/plain', roomId: fr }, ta);
  const dfid = r.json.fileId;
  await req('PUT', '/api/files/' + dfid + '/chunk?i=0', Buffer.from('0123456789'), ta, true);
  await req('POST', '/api/files/' + dfid + '/complete', {}, ta);
  r = await req('POST', '/api/rooms/' + fr + '/messages', { kind: 'file', fileId: dfid }, ta);
  const dmsg = r.json.message;
  r = await req('POST', '/api/messages/' + dmsg.id + '/delete', {}, ta);
  check('删除消息成功', r.status === 200, r.json);
  r = await req('GET', '/api/rooms/' + fr + '/messages?since=0', null, ta);
  check('自己不再看到该消息', !r.json.messages.some((m) => m.id === dmsg.id));
  r = await req('GET', '/api/rooms/' + fr + '/messages?since=0', null, tb);
  check('他人仍能看到该消息（仅本账号隐藏）', r.json.messages.some((m) => m.id === dmsg.id));

  console.log('\n────────────────────────────');
  console.log('通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
