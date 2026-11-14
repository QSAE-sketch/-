'use strict';
const https = require('https');
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
  let r = await req('POST', '/api/login', { username: 'qa2411', password: '[已隐去]' });
  const A = r.json.token;
  r = await req('GET', '/api/friends', null, A);
  console.log('A 的好友接口：');
  console.log(JSON.stringify(r.json, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
