'use strict';
/**
 * 线上冒烟：双版本分发 + 群昵称 / 转让通知 / 解散 + 两版数据互通。
 * 跑完自动注销测试账号（房间已解散，云端不留残留数据）。
 * 用法：node tools/live-smoke-rooms.js [base] [sharecode]
 */
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const BASE = process.argv[2] || 'https://qingliao-chat-33476.app.workbuddy.host';
const SHARE = process.argv[3] || 'T7ELJZOC5A';
const MOD = BASE.indexOf('https') === 0 ? https : http;
const OLD_UA = 'Mozilla/5.0 (Linux; Android 5.1; Redmi Note 2 Build/LMY47D) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/39.0.0.0 Mobile Safari/537.36';
const NEW_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 220) : '')); }
}
function url(path) {
  return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'sharecode=' + SHARE;
}
function req(method, path, body, token, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(url(path), BASE);
    const data = (body === undefined || body === null) ? null : Buffer.from(JSON.stringify(body));
    const headers = { Host: u.host, 'User-Agent': opts.ua || NEW_UA };
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Type'] = 'application/json';
    if (opts.headers) for (const k in opts.headers) headers[k] = opts.headers[k];
    const r = MOD.request({
      hostname: u.hostname, port: u.port || (MOD === https ? 443 : 80),
      path: u.pathname + u.search, method, headers, timeout: 20000
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(cs);
        let j = null; try { j = JSON.parse(raw.toString()); } catch (e) { }
        resolve({ status: res.statusCode, json: j, text: raw.toString(), headers: res.headers });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
async function register(prefix, nickname, ua) {
  const username = prefix + crypto.randomBytes(4).toString('hex');
  const r = await req('POST', '/api/register', { username, password: '[已隐去]', nickname }, null, { ua: ua });
  const me = await req('GET', '/api/me', null, r.json.token, { ua: ua });
  return { username, token: r.json.token, id: me.json.user.id };
}
function sysTexts(list) {
  return list.filter((m) => m.kind === 'system').map((m) => m.content);
}

(async () => {
  console.log('\n【线上】设备能力分发');
  let r = await req('GET', '/', null, null, { ua: OLD_UA });
  check('老设备 UA 拿到低配兼容版', r.status === 200 &&
    r.text.indexOf('data-ll-cap="lite"') >= 0 && r.text.indexOf('app-lite.js') >= 0, r.status);
  r = await req('GET', '/', null, null, { ua: NEW_UA });
  check('现代 UA 拿到标准版', r.status === 200 && r.text.indexOf('src="/app.js?v=') >= 0, r.status);
  r = await req('GET', '/?lite=1', null, null, { ua: NEW_UA });
  check('强制低配可用且写 cookie', r.text.indexOf('data-ll-cap="lite"') >= 0 &&
    /ll_cap=lite/.test(String(r.headers['set-cookie'] || '')), String(r.headers['set-cookie']));
  r = await req('GET', '/app-lite.js', null, null, { ua: OLD_UA });
  check('低配 JS 线上可访问', r.status === 200 && r.text.length > 10000, r.status);
  r = await req('GET', '/style-lite.css', null, null, { ua: OLD_UA });
  check('低配 CSS 线上可访问', r.status === 200 && r.text.length > 3000, r.status);

  console.log('\n【线上】低配设备走完整业务流程（与标准版同库）');
  const A = await register('lrA', '线上甲', OLD_UA);
  const B = await register('lrB', '线上乙', NEW_UA);
  check('低配 UA 可注册', !!A.token);
  check('标准 UA 可注册', !!B.token);

  r = await req('POST', '/api/rooms', { name: '线上验证群' }, A.token, { ua: OLD_UA });
  const roomId = r.json.room.id;
  check('低配端可建群', r.status === 200 && !!roomId, r.json);
  r = await req('POST', '/api/rooms/' + roomId + '/join', {}, B.token, { ua: NEW_UA });
  check('标准端可加入同一群', r.status === 200, r.json);

  r = await req('POST', '/api/rooms/' + roomId + '/nickname', { nickname: '群内甲' }, A.token, { ua: OLD_UA });
  check('低配端可改群内昵称', r.status === 200 && r.json.displayName === '群内甲', r.json);
  r = await req('GET', '/api/me', null, A.token, { ua: NEW_UA });
  check('全局昵称未被同步（两版共用同一账号）', r.json.user.nickname === '线上甲', r.json.user);

  r = await req('POST', '/api/rooms/' + roomId + '/messages', { kind: 'text', content: '低配端消息' },
    A.token, { ua: OLD_UA });
  check('低配端可发消息', r.status === 200, r.json);
  r = await req('GET', '/api/rooms/' + roomId + '/messages?since=0&limit=200', null, B.token, { ua: NEW_UA });
  check('标准端可见该消息且显示群内昵称',
    (r.json.messages || []).some((m) => m.content === '低配端消息' && m.senderName === '群内甲'),
    (r.json.messages || []).map((m) => m.senderName));

  console.log('\n【线上】转让通知 / 解散');
  await req('POST', '/api/rooms/' + roomId + '/nickname', { nickname: '受让乙' }, B.token, { ua: NEW_UA });
  r = await req('POST', '/api/rooms/' + roomId + '/transfer',
    { userId: B.id, confirm: true }, A.token, { ua: OLD_UA });
  check('低配端可转让群主', r.status === 200 && r.json.ownerId === B.id, r.json);
  r = await req('GET', '/api/rooms/' + roomId + '/messages?since=0&limit=200', null, B.token, { ua: NEW_UA });
  check('标准端看到转让系统通知（群内昵称）',
    (r.json.messages || []).some((m) => m.kind === 'system' &&
      m.content === '群内甲的群主权限已转让至受让乙'), sysTexts(r.json.messages || []));

  r = await req('POST', '/api/rooms/' + roomId + '/dissolve', { confirm: true }, B.token, { ua: NEW_UA });
  check('标准端可解散群聊', r.status === 200 && r.json.dissolved === true, r.json);
  r = await req('GET', '/api/rooms/' + roomId + '/messages?since=0&limit=200', null, A.token, { ua: OLD_UA });
  check('低配端可读解散通知与只读状态', r.status === 200 && r.json.canPost === false &&
    (r.json.messages || []).some((m) => m.kind === 'system' && m.content.indexOf('解散') >= 0),
    { canPost: r.json.canPost, sys: sysTexts(r.json.messages || []) });
  r = await req('POST', '/api/rooms/' + roomId + '/messages', { kind: 'text', content: '还能发吗' },
    A.token, { ua: OLD_UA });
  check('解散后低配端发送被停用', r.status === 410, r.json);

  // 清理：两个测试账号都注销，不留云端残留
  await req('POST', '/api/account/delete', { confirm: true }, A.token, { ua: OLD_UA });
  await req('POST', '/api/account/delete', { confirm: true }, B.token, { ua: NEW_UA });
  console.log('  （测试账号已自动注销清理）');

  console.log('\n线上冒烟 通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常:', e && e.stack ? e.stack : e);
  console.log('\n线上冒烟 失败(异常)');
  process.exit(1);
});
