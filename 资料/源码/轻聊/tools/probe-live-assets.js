'use strict';
/** 探测线上站点的前端资源是否已包含最新代码 */
const https = require('https');
const BASE = 'https://qingliao-chat-33476.app.workbuddy.host';
const SHARE_CODE = process.env.SHARE_CODE || 'T7ELJZOC5A';
const COOKIES = {};
function req(method, path) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    const headers = {};
    const ck = Object.keys(COOKIES).map(k => k + '=' + COOKIES[k]).join('; ');
    if (ck) headers['Cookie'] = ck;
    const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers }, (res) => {
      for (const line of (res.headers['set-cookie'] || [])) {
        const kv = line.split(';')[0]; const i = kv.indexOf('=');
        if (i > 0) COOKIES[kv.slice(0, i).trim()] = kv.slice(0 + i + 1).trim();
      }
      const cs = [];
      res.on('data', c => cs.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(cs).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });
}
(async () => {
  const hs = await req('GET', '/?sharecode=' + SHARE_CODE);
  console.log('握手 status=' + hs.status);
  const js = await req('GET', '/app.js');
  console.log('app.js status=' + js.status + ' 长度=' + js.body.length);
  for (const k of ['utf8Bytes', 'openProfile', 'faSend', 'acceptFriend', 'renderFriends', 'data-profile', 'avatarColor']) {
    console.log('  ' + k + ' : ' + (js.body.includes(k) ? '有' : '无'));
  }
  const html = await req('GET', '/');
  console.log('index.html status=' + html.status + ' friendAdd=' + (html.body.includes('friendAdd') ? '有' : '无'));
})().catch(e => { console.error(e); process.exit(1); });
