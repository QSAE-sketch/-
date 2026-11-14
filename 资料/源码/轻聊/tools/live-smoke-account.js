'use strict';
// 线上冒烟测试：验证昵称修改 + 注销 两个新接口在线上真实生效。
// 跑完会自动注销测试账号（清理云端数据），不留痕迹。
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const BASE = process.argv[2] || 'https://qingliao-chat-33476.app.workbuddy.host';
const SHARECODE = process.argv[3] || 'T7ELJZOC5A';
const MOD = BASE.startsWith('https') ? https : http;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 200) : '')); }
}
function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    if (!u.searchParams.has('sharecode')) u.searchParams.set('sharecode', SHARECODE);
    const data = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body));
    const headers = { 'Host': u.host };
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Type'] = 'application/json';
    const r = MOD.request({
      hostname: u.hostname, port: u.port || (BASE.startsWith('https') ? 443 : 80), path: u.pathname + u.search,
      method, headers, timeout: 15000
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        let j = null; try { j = JSON.parse(Buffer.concat(cs).toString()); } catch (e) {}
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const uniq = crypto.randomBytes(4).toString('hex');
  const username = 'smoke_' + uniq;
  let r = await req('POST', '/api/register', { username, password: '[已隐去]', nickname: '原始昵称' });
  check('线上注册测试账号成功', r.status === 200 && r.json.token, r.json);
  const token = r.json.token;

  // 1) 修改昵称
  r = await req('POST', '/api/me/nickname', { nickname: '线上新昵称' }, token);
  check('线上修改昵称返回 200', r.status === 200, r.json);
  r = await req('GET', '/api/me', null, token);
  check('线上昵称已持久化', r.json && r.json.user && r.json.user.nickname === '线上新昵称', r.json && r.json.user);
  check('线上账号名 username 不变', r.json.user.username === username, r.json.user.username);

  // 2) 注销（自动清理云端数据）
  r = await req('POST', '/api/account/delete', {}, token);
  check('缺少 confirm 被拒 400', r.status === 400, r.json);
  r = await req('POST', '/api/account/delete', { confirm: true }, token);
  check('线上注销返回 200', r.status === 200 && r.json.ok === true, r.json);
  r = await req('POST', '/api/login', { username, password: '[已隐去]' });
  check('线上注销后无法再登录(401)', r.status === 401, r.status);

  console.log('\n线上冒烟 通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常:', e && e.stack ? e.stack : e); console.log('\n线上冒烟 失败(异常)'); process.exit(1); });
