'use strict';
/**
 * 线上文件上传 / 下载闭环探测。
 * 用法: node tools/live-file-probe.js <baseUrl>
 */
const BASE = process.argv[2] || 'https://qingliao-chat-33476.app.workbuddy.host';
const SHARE = 'T7ELJZOC5A';
const U = 'fileprobe' + Date.now().toString().slice(-6);
const P = 'pass123';

let COOKIE = '';

function log(...a) { console.log(...a); }

async function req(method, path, body, token, extraHeaders) {
  const headers = Object.assign({}, extraHeaders || {});
  if (COOKIE) headers['Cookie'] = COOKIE;
  if (token) headers['X-Token'] = token;
  let payload = body;
  if (body && !Buffer.isBuffer(body) && typeof body !== 'string') {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of sc) {
    const kv = c.split(';')[0];
    if (kv) COOKIE = COOKIE ? COOKIE + '; ' + kv : kv;
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  return { status: res.status, json, text, res };
}

(async () => {
  log('=== 目标:', BASE, '===');
  log('--- 0) 带 sharecode 建立会话 ---');
  let r = await req('GET', '/?sharecode=' + SHARE);
  log('  首页 HTTP', r.status, '| cookie =', COOKIE ? COOKIE.slice(0, 60) + '...' : '(无)');
  if (r.status !== 200) process.exit(1);

  log('--- 1) 注册 ---');
  r = await req('POST', '/api/register', { username: U, password: P, nickname: '文件探测' });
  log('  注册 HTTP', r.status, JSON.stringify(r.json).slice(0, 200));
  if (r.status !== 200) process.exit(1);
  const token = r.json.token;
  log('  token =', String(token).slice(0, 20) + '...');

  log('--- 2) 建房间 ---');
  r = await req('POST', '/api/rooms', { name: '文件探测房' }, token);
  const roomId = r.json && r.json.room && r.json.room.id;
  log('  建房 HTTP', r.status, 'roomId =', roomId);

  log('--- 3) /api/files/init ---');
  const content = Buffer.from('HELLO-QINGLIAO-CLOUD-FILE-' + U + '\n'.repeat(50));
  r = await req('POST', '/api/files/init', {
    name: 'probe.txt', size: content.length, mime: 'text/plain', roomId: roomId
  }, token);
  log('  init HTTP', r.status, JSON.stringify(r.json).slice(0, 260));
  if (r.status !== 200) process.exit(1);
  const fileId = r.json.fileId;
  const chunkSize = r.json.chunkSize || 4194304;
  const total = r.json.totalChunks;

  log('--- 4) 上传分片 ---');
  for (let i = 0; i < total; i++) {
    const start = i * chunkSize;
    const slice = content.slice(start, Math.min(content.length, start + chunkSize));
    const rr = await req('PUT', '/api/files/' + fileId + '/chunk?i=' + i, slice, token,
      { 'Content-Type': 'application/octet-stream' });
    log('  chunk', i, 'HTTP', rr.status, JSON.stringify(rr.json).slice(0, 120));
  }

  log('--- 5) complete ---');
  r = await req('POST', '/api/files/' + fileId + '/complete', {}, token);
  log('  complete HTTP', r.status, JSON.stringify(r.json).slice(0, 220));

  log('--- 6) 立刻下载 raw ---');
  r = await req('GET', '/api/files/' + fileId + '/raw', null, token);
  log('  raw HTTP', r.status, 'Content-Type =', r.res.headers.get('content-type'),
    'len =', r.res.headers.get('content-length'));
  log('  body 前 80 字节:', JSON.stringify(r.text.slice(0, 80)));
  log('  内容一致 =', r.text === content.toString() ? 'YES' : 'NO');

  log('--- 7) 用 accessToken 直连 ---');
  const meta = await req('GET', '/api/rooms/' + roomId + '/messages', null, token);
  const f = (meta.json && meta.json.messages || []).map(m => m.file).filter(Boolean)[0];
  log('  消息里的 file =', JSON.stringify(f));
  if (f && f.url) {
    const rr = await req('GET', f.url, null, null);
    log('  直连 HTTP', rr.status, 'len =', rr.res.headers.get('content-length'));
  }

  log('--- 8) 状态查询 ---');
  r = await req('GET', '/api/files/' + fileId + '/status', null, token);
  log('  status HTTP', r.status, JSON.stringify(r.json).slice(0, 240));

  log('--- 9) 发文件消息 ---');
  r = await req('POST', '/api/rooms/' + roomId + '/messages', { kind: 'file', fileId: fileId }, token);
  log('  发消息 HTTP', r.status, JSON.stringify(r.json).slice(0, 300));
})().catch(e => { console.error('探测异常:', e); process.exit(1); });
