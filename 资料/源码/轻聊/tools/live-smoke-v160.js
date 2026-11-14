'use strict';
// 线上冒烟：验证 v1.6.0 的配额、保留期、新版消息操作面板都已生效。
// 跑完会把测试建的群一并清掉（wipe-all），再注销临时账号，不留痕迹。
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const BASE = process.argv[2] || 'https://qingliao-chat-33476.app.workbuddy.host';
const SHARECODE = process.argv[3] || 'T7ELJZOC5A';
const KEY = process.env.PERM_KEY || 'lz-qingliao-2026';
const MOD = BASE.startsWith('https') ? https : http;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 220) : '')); }
}
function reqRaw(method, p, body, token, raw) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, BASE);
    if (!u.searchParams.has('sharecode')) u.searchParams.set('sharecode', SHARECODE);
    const data = body === undefined || body === null ? null : (raw ? body : Buffer.from(JSON.stringify(body)));
    const headers = { Host: u.host };
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Type'] = raw ? 'application/octet-stream' : 'application/json';
    const r = MOD.request({
      hostname: u.hostname, port: u.port || (BASE.startsWith('https') ? 443 : 80),
      path: u.pathname + u.search, method, headers, timeout: 30000
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(cs);
        let j = null;
        try { j = JSON.parse(buf.toString()); } catch (e) {}
        resolve({ status: res.statusCode, json: j, text: buf.toString() });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const req = (m, p, b, t) => reqRaw(m, p, b, t, false);

(async () => {
  /* 1. 前端资源 */
  let r = await req('GET', '/');
  check('首页 200', r.status === 200);
  check('首页带消息操作面板容器', r.text.indexOf('id="actSheet"') >= 0);
  check('首页已移除顶栏「多选」按钮', r.text.indexOf('id="multiBtn"') < 0);
  check('首页仍有权限密钥输入', r.text.indexOf('id="ak"') >= 0);

  r = await req('GET', '/style.css');
  check('样式含操作面板', r.text.indexOf('.actsheet') >= 0);
  check('样式含配额条', r.text.indexOf('.quota-track') >= 0);
  check('样式含多选勾选框显示规则', r.text.indexOf('.msgs.selmode .msg .pick') >= 0);

  r = await req('GET', '/api/version');
  check('线上版本 1.6.0', r.json && r.json.version.name === '1.6.0', r.json && r.json.version);

  /* 2. 配额 */
  const uname = 'smoke6_' + crypto.randomBytes(4).toString('hex');
  r = await req('POST', '/api/register', {
    username: uname, password: 'smoke123', nickname: '配额冒烟', permKey: KEY
  });
  check('注册临时账号（含最高权限）', r.status === 200 && r.json.user.master === true);
  const token = r.json.token;

  r = await req('GET', '/api/me/storage', null, token);
  check('配额为 2GB', r.json.quota === 2 * 1024 * 1024 * 1024, r.json);
  check('初始已用 0', r.json.used === 0, r.json);
  check('配额文案可读', !!(r.json.quotaText && r.json.remainText), r.json);

  r = await req('GET', '/api/rooms', null, token);
  const pubId = r.json.publicRoomId;
  check('清空后仍有公共大厅', !!pubId);

  // 传一个小文件 → 计入配额 → 发消息 → 撤销消息 → 配额回落
  const buf = Buffer.from('hello-v160-' + crypto.randomBytes(64).toString('hex'));
  r = await req('POST', '/api/files/init', {
    name: 'smoke.txt', size: buf.length, mime: 'text/plain', roomId: pubId
  }, token);
  check('小文件 init 成功', r.status === 200, r.json);
  const fid = r.json.fileId;
  await reqRaw('PUT', '/api/files/' + fid + '/chunk?i=0', buf, token, true);
  r = await req('POST', '/api/files/' + fid + '/complete', {}, token);
  check('上传完成并回传配额', r.status === 200 && r.json.storage && r.json.storage.used > 0, r.json);

  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'file', fileId: fid }, token);
  const msgId = r.json && r.json.message && r.json.message.id;
  check('文件消息发送成功', !!msgId, r.json);
  const usedWithFile = (await req('GET', '/api/me/storage', null, token)).json.used;
  check('配额已计入该文件', usedWithFile >= buf.length, usedWithFile);

  r = await req('POST', '/api/messages/' + msgId + '/purge', {}, token);
  check('直接删除文件消息', r.status === 200, r.json);
  r = await req('GET', '/api/me/storage', null, token);
  check('删除后配额立即释放', r.json.used === 0, r.json);

  /* 3. 保留期 */
  const gname = '保留期冒烟' + crypto.randomBytes(2).toString('hex');
  r = await req('POST', '/api/rooms', { name: gname }, token);
  const gid = r.json && r.json.room && r.json.room.id;
  check('建群成功', !!gid, r.json);
  await req('POST', '/api/rooms/' + gid + '/messages', { content: '保留期冒烟消息' }, token);

  const before = Date.now();
  r = await req('POST', '/api/rooms/' + gid + '/dissolve', { confirm: true }, token);
  check('解散成功并返回保留截止时间',
    r.status === 200 && r.json.retainUntil > before, r.json);
  const days = (r.json.retainUntil - before) / 86400000;
  check('保留期约 5 天', days > 4.9 && days < 5.1, days);

  r = await req('GET', '/api/rooms', null, token);
  const gb = (r.json.rooms || []).find((x) => x.id === gid);
  check('列表里房间为「已解散」且带保留期',
    !!gb && gb.dissolved === true && gb.retentionDays === 5, gb);

  r = await req('GET', '/api/rooms/' + gid + '/messages?since=0&limit=50', null, token);
  check('保留期内历史消息可读', (r.json.messages || []).some((m) => m.content === '保留期冒烟消息'));

  /* 4. 收尾：清掉冒烟房间与临时账号 */
  r = await req('POST', '/api/admin/rooms/wipe-all', {}, token);
  check('缺少口令被拒', r.status === 400, r.json);

  const pubBefore = pubId;
  r = await req('POST', '/api/admin/rooms/wipe-all', { confirm: true, phrase: '清空所有房间' }, token);
  check('清空所有房间成功（含刚建的冒烟群）', r.status === 200 && r.json.rooms >= 2, r.json);
  check('公共大厅已重建（新 id）', !!(r.json.publicRoomId && r.json.publicRoomId !== pubBefore), r.json);

  r = await req('GET', '/api/rooms', null, token);
  check('清空后只剩公共大厅', (r.json.rooms || []).length === 1, r.json.rooms.length);

  r = await req('POST', '/api/account/delete', { confirm: true }, token);
  check('临时账号已注销', r.status === 200, r.json);

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常:', e && e.stack ? e.stack : e);
  console.log('\n通过: ' + pass + '  失败: ' + (fail + 1));
  process.exit(1);
});
