'use strict';
/**
 * 认证模块专项测试：四种登录 / 注册方式
 *
 *   password   账号 + 密码（默认，轻聊自有体系）
 *   email      邮箱（登录走邮箱密码，注册走邮箱验证码）
 *   otp        验证码（邮箱 / 短信）
 *   workbuddy  WorkBuddy 账号（OAuth / PKCE）
 *
 * 说明：验证码与 OAuth 的「完整闭环」需要真人收取验证码 / 完成授权，无法自动化，
 * 本文件覆盖的是可自动验证的部分：参数校验、渠道识别、路由契约、错误分支、
 * 以及本地账号模型的写入与查找。真实闭环由人工验收（见 README「认证模块」）。
 */
const http = require('http');
const crypto = require('crypto');

const BASE = 'http://127.0.0.1:' + (process.env.PORT || 3311);
let pass = 0, fail = 0;

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = (body === undefined || body === null) ? null : Buffer.from(JSON.stringify(body));
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
  const name = 'au' + uniq;

  /* ---------------- A. 账号 + 密码（默认方式，本地体系） ---------------- */
  console.log('\n【A】账号 + 密码（默认）');
  let r = await req('POST', '/api/register', { username: name, password: 'pass123', nickname: '甲' });
  check('注册成功并返回令牌', r.status === 200 && !!r.json.token, r.json);
  check('返回的用户带 authType=password', r.json.user && r.json.user.authType === 'password', r.json.user);
  check('注册返回的用户名正确', r.json.user && r.json.user.username === name, r.json.user);
  const tokenA = r.json.token;

  r = await req('POST', '/api/register', { username: name, password: 'pass123' });
  check('重复注册被拒(409)', r.status === 409, r.json);

  r = await req('POST', '/api/register', { username: 'a', password: 'pass123' });
  check('账号过短被拒(400)', r.status === 400, r.json);

  r = await req('POST', '/api/register', { username: 'a_b' + uniq, password: '123' });
  check('密码过短被拒(400)', r.status === 400, r.json);

  r = await req('POST', '/api/login', { username: name, password: 'pass123' });
  check('登录成功', r.status === 200 && !!r.json.token, r.json);

  r = await req('POST', '/api/login', { username: name, password: 'wrongpw' });
  check('密码错误被拒(401)', r.status === 401, r.json);

  r = await req('POST', '/api/login', { username: 'nobody_' + uniq, password: 'pass123' });
  check('账号不存在被拒(401)', r.status === 401, r.json);

  r = await req('GET', '/api/me', null, tokenA);
  check('会话可用且带 authType', r.status === 200 && r.json.user.authType === 'password', r.json);

  r = await req('GET', '/api/me', null, null);
  check('未登录访问受保护接口被拒(401)', r.status === 401, r.json);

  /* ---------------- B. 邮箱（发码 + 邮箱密码） ---------------- */
  console.log('\n【B】邮箱');
  const mail = 'ql_auth_' + uniq + '@example.com';

  r = await req('POST', '/api/auth/email', { mode: 'reg', email: mail, password: 'pass123' });
  check('邮箱注册缺少验证码被拒(400)', r.status === 400, r.json);

  r = await req('POST', '/api/auth/email', { mode: 'reg', email: mail, password: '123' });
  check('邮箱注册密码过短被拒(400)', r.status === 400, r.json);

  r = await req('POST', '/api/auth/email', { mode: 'login', email: 'not-an-email', password: 'pass123' });
  check('邮箱格式非法被拒(400/401)', r.status === 400 || r.status === 401, r.json);

  r = await req('POST', '/api/auth/email', { mode: 'login', email: mail, password: '[已隐去]' });
  check('邮箱密码错误被拒(401)', r.status === 401, r.json);

  /* ---------------- C. 验证码（邮箱 / 短信） ---------------- */
  console.log('\n【C】验证码');
  r = await req('POST', '/api/auth/otp/send', { target: 'not-an-email' });
  check('非法标识发码被拒(400)', r.status === 400, r.json);

  r = await req('POST', '/api/auth/otp/send', { target: '12345' });
  check('非法手机号发码被拒(400)', r.status === 400, r.json);

  r = await req('POST', '/api/auth/otp/verify', { mode: 'login', target: mail, token: '000000', verificationId: 'bogus' });
  check('错误验证码被拒(400)', r.status === 400, r.json);

  r = await req('POST', '/api/auth/otp/verify', { mode: 'login', target: mail, token: '' });
  check('缺少验证码被拒(400)', r.status === 400, r.json);

  r = await req('POST', '/api/auth/otp/verify', { mode: 'reg', target: mail, token: '000000', verificationId: 'bogus', password: '123' });
  check('注册时密码过短被拒(400)', r.status === 400, r.json);

  // 真发一次码：example.com 是 IANA 保留测试域名，不会骚扰真人
  r = await req('POST', '/api/auth/otp/send', { target: mail });
  check('邮箱发码成功', r.status === 200 && !!r.json.verificationId, r.json);
  check('发码返回 isExistingUser 标记', typeof r.json.isExistingUser === 'boolean', r.json);
  check('渠道识别为 email', r.json.channel === 'email', r.json);

  /* ---------------- D. WorkBuddy OAuth ---------------- */
  console.log('\n【D】WorkBuddy 账号');
  r = await req('GET', '/api/auth/wb/start', null, null);
  check('发起授权成功', r.status === 200 && !!r.json.url, r.json);
  const wbUrl = r.json.url || '';
  check('授权地址指向 Relay', wbUrl.indexOf('/oauth/authorize') > 0, wbUrl);
  check('指定 provider=workbuddy', wbUrl.indexOf('provider=workbuddy') > 0, wbUrl);
  check('带 callback_url 参数', wbUrl.indexOf('callback_url=') > 0, wbUrl);
  check('带 PKCE challenge', wbUrl.indexOf('code_challenge=') > 0 && wbUrl.indexOf('code_challenge_method=S256') > 0, wbUrl);
  // callback_url 是 URL 编码的，解码后再比对
  let cbDecoded = '';
  try { cbDecoded = decodeURIComponent(wbUrl); } catch (e) { cbDecoded = wbUrl; }
  check('回调地址指向本应用', cbDecoded.indexOf('/api/auth/wb/callback') > 0, cbDecoded);

  r = await req('GET', '/api/auth/wb/callback', null, null);
  check('回调缺少授权码被拒(400)', r.status === 400, r.json);

  /* ---------------- E. 账号模型 ---------------- */
  console.log('\n【E】账号模型');
  const os = require('os');
  const pathMod = require('path');
  const { createStore } = require('../src/store');
  const { createDb } = require('../src/db');
  const tmpDir = pathMod.join(os.tmpdir(), 'ql-auth-test-' + uniq);
  const db = createDb(createStore(tmpDir));
  const u1 = db.createUser('someone@example.com', '', '云用户', {
    authType: 'email', email: 'someone@example.com', phone: '', cloudId: 'cloud_abc'
  });
  check('新用户写入 authType', u1.authType === 'email', u1);
  check('新用户写入 email', u1.email === 'someone@example.com', u1);
  check('新用户写入 cloudId', u1.cloudId === 'cloud_abc', u1);
  check('按邮箱能找到用户', db.findUserByEmail('SOMEONE@example.com') && db.findUserByEmail('SOMEONE@example.com').id === u1.id);
  check('按云账号能找到用户', db.findUserByCloudId('cloud_abc') && db.findUserByCloudId('cloud_abc').id === u1.id);
  check('按手机号找不到（该用户没有手机号）', db.findUserByPhone('+86 13800000000') === null);
  const u2 = db.createUser('smsuser', '', '短信用户', { authType: 'otp', phone: '+86 13800000000' });
  check('按手机号能找到用户', db.findUserByPhone('+86 13800000000') && db.findUserByPhone('+86 13800000000').id === u2.id);
  check('按邮箱查不到手机号用户', db.findUserByEmail('smsuser') === null);

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常:', e && e.stack ? e.stack : e);
  console.log('\n通过: ' + pass + '  失败: ' + (fail + 1));
  process.exit(1);
});
