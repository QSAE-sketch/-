'use strict';
/** 给线上账号造一条带中文附言的好友申请（用于视觉终检） */
const https = require('https');
const crypto = require('crypto');
const BASE = 'https://qingliao-chat-33476.app.workbuddy.host';
const COOKIES = {};
function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Type'] = 'application/json; charset=utf-8';
    const ck = Object.keys(COOKIES).map(k => k + '=' + COOKIES[k]).join('; ');
    if (ck) headers['Cookie'] = ck;
    const u = new URL(path, BASE);
    const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers }, res => {
      for (const line of (res.headers['set-cookie'] || [])) {
        const kv = line.split(';')[0]; const i = kv.indexOf('=');
        if (i > 0) COOKIES[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      }
      const cs = [];
      res.on('data', c => cs.push(c));
      res.on('end', () => {
        let j = null; try { j = JSON.parse(Buffer.concat(cs).toString('utf8')); } catch (e) {}
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
(async () => {
  await req('GET', '/?sharecode=T7ELJZOC5A');
  // 登录 A（浏览器里刚注册的账号）
  let r = await req('POST', '/api/login', { username: 'qa2411', password: '[已隐去]' });
  if (!r.json || !r.json.token) { console.error('A 登录失败', r.status, JSON.stringify(r.json)); process.exit(1); }
  const A = r.json.token;
  const meA = await req('GET', '/api/me', null, A);
  const aid = meA.json.user.id;
  console.log('A =', meA.json.user.nickname, meA.json.user.username, aid);

  // 注册 B（中文昵称）
  const bName = 'qb' + crypto.randomBytes(3).toString('hex');
  r = await req('POST', '/api/register', { username: bName, password: 'pass123', nickname: '陈知远' });
  const B = r.json.token;
  const meB = await req('GET', '/api/me', null, B);
  const bid = meB.json.user.id;
  console.log('B =', meB.json.user.nickname, bName, bid);

  // B 给 A 发带中文附言的申请
  r = await req('POST', '/api/friends/request', { userId: aid, message: '你好呀！我是群里的老成员，看到你也在这儿，交个朋友吧～' }, B);
  console.log('申请状态', r.status, JSON.stringify(r.json));

  // 读 A 的好友接口，确认收到
  r = await req('GET', '/api/friends', null, A);
  console.log('A 收到申请数 =', (r.json.incoming || []).length);
  console.log('内容:', JSON.stringify(r.json.incoming && r.json.incoming[0]));
  console.log('\nA_TOKEN=' + A);
  console.log('B_USER=' + bName);
})().catch(e => { console.error(e); process.exit(1); });
