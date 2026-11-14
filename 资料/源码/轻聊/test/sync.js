'use strict';
/** 多端同步 + 持久化验证：模拟"设备A关机后设备B仍可收发" */
const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PORT = process.env.PORT || 3311;
const BASE = 'http://127.0.0.1:' + PORT;
let pass = 0, fail = 0;

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const uniq = crypto.randomBytes(3).toString('hex');
  const U = 'sync' + uniq;

  console.log('\n【1】设备A 注册登录');
  let r = await req('POST', '/api/register', { username: U, password: 'pass123', nickname: '同步测试' });
  const tokenA = r.json.token;
  const userId = r.json.user.id;
  check('设备A 注册成功', r.status === 200 && !!tokenA, r.json);
  r = await req('GET', '/api/rooms', null, tokenA);
  const pubId = r.json.publicRoomId;
  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'text', content: '设备A在关机前发的消息' }, tokenA);
  check('设备A 发送消息', r.status === 200, r.json);
  const msgId = r.json.message.id;

  console.log('\n【2】设备B 登录同一账号（独立登录态）');
  r = await req('POST', '/api/login', { username: U, password: 'pass123' });
  const tokenB = r.json.token;
  check('设备B 登录成功，token 与 A 不同', r.status === 200 && tokenB !== tokenA, r.json);
  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0', null, tokenB);
  check('设备B 能看到设备A 的历史消息', r.json.messages.some((m) => m.content === '设备A在关机前发的消息'), r.json.messages.map((m) => m.content));
  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'text', content: '设备B发的消息' }, tokenB);
  check('设备B 发送消息成功', r.status === 200, r.json);

  console.log('\n【3】设备A 重新上线（模拟重启浏览器），消息仍在');
  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0', null, tokenA);
  check('设备A 重新上线后仍能看到设备B 的消息', r.json.messages.some((m) => m.content === '设备B发的消息'), r.json.messages.map((m) => m.content));
  check('两条消息都在', r.json.messages.length >= 2, r.json.messages.length);

  console.log('\n【4】增量拉取：只取新消息');
  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0&limit=1', null, tokenA);
  check('limit=1 只返回 1 条', r.json.messages.length === 1, r.json.messages.length);
  const lastSeq = r.json.lastSeq;
  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'text', content: '增量测试消息' }, tokenA);
  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=' + lastSeq, null, tokenB);
  check('按 seq 增量只返回新增消息', r.json.messages.length === 1 && r.json.messages[0].content === '增量测试消息', r.json.messages.map((m) => m.content));

  console.log('\n【5】撤回状态跨端同步（rev 机制）');
  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0', null, tokenA);
  const target = r.json.messages.find((m) => m.content === '设备B发的消息');
  const beforeRev = r.json.lastSeq;
  r = await req('POST', '/api/messages/' + target.id + '/recall', {}, tokenB);
  check('设备B 撤回自己的消息', r.status === 200, r.json);
  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=' + beforeRev, null, tokenA);
  const synced = r.json.messages.find((m) => m.id === target.id);
  check('设备A 通过增量拉取同步到撤回状态', synced && synced.recalled === true && !synced.content, synced);

  console.log('\n【6】会话失效');
  r = await req('POST', '/api/logout', {}, tokenA);
  check('设备A 登出成功', r.status === 200, r.json);
  r = await req('GET', '/api/rooms', null, tokenA);
  check('登出后 token 失效(401)', r.status === 401, r.json);
  r = await req('GET', '/api/rooms', null, tokenB);
  check('设备B 登录态不受影响', r.status === 200, r.json);

  console.log('\n────────────────────────────');
  console.log('通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
