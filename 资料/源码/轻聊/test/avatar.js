'use strict';
/**
 * 自定义头像专项：
 *   1. 上传 dataURL → 落盘 → publicUser 带 avatar 地址
 *   2. GET /api/avatars/:id 能取回图片字节（公开读）
 *   3. 换头像后 ?v= 戳变化（缓存失效）
 *   4. 非法图片（假 base64 / 超大 / 非图片）被拒绝
 *   5. DELETE /api/me/avatar 恢复默认（avatar 清空，色块首字仍在）
 *   6. 消息序列化带 senderAvatar（founder 金泡渲染依据）
 */
const http = require('http');

const PORT = Number(process.env.PORT || 3311);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const r = http.request({
      hostname: '127.0.0.1', port: PORT, path: p, method,
      headers: Object.assign(
        { 'content-type': 'application/json' },
        token ? { 'x-token': token } : {},
        data ? { 'content-length': data.length } : {}
      )
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(cs);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* 图片响应 */ }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** 最小合法 PNG（2×2 纯色） */
function tinyPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAlYAP9' +
    'lV0HAAAAAElFTkSuQmCC', 'base64');
}

const uniq = 'av' + Date.now().toString(36);
const user = { username: uniq, password: '[已隐去]', nickname: '头像测试' };

(async () => {
  console.log('\n──── 自定义头像 ────');

  const reg = await req('POST', '/api/register', user);
  check('注册成功拿到 token', !!(reg.json && reg.json.ok && reg.json.token), reg.json);
  const tok = reg.json && reg.json.token;
  if (!tok) { console.log('\n通过: ' + pass + '  失败: ' + fail); process.exit(1); }

  // 初始无头像
  check('新账号没有自定义头像', !reg.json.user.avatar, reg.json.user.avatar);
  check('新账号仍有色块 + 首字回落', !!reg.json.user.avatarColor && !!reg.json.user.initial);

  // 上传
  const png = tinyPng();
  const up = await req('POST', '/api/me/avatar', {
    dataUrl: 'data:image/png;base64,' + png.toString('base64')
  }, tok);
  check('上传头像成功', !!(up.json && up.json.ok), up.json);
  check('publicUser 返回 avatar 地址', !!(up.json && up.json.user && up.json.user.avatar),
    up.json && up.json.user);
  const avUrl = up.json && up.json.user && up.json.user.avatar;
  check('avatar 地址带 ?v= 缓存戳', /\/api\/avatars\/[^?]+\?v=\d+/.test(avUrl || ''), avUrl);

  // 取图
  const got = await req('GET', avUrl || '/api/avatars/none');
  check('GET 头像返回 200', got.status === 200, got.status);
  check('头像字节是 PNG', got.body.length > 8 && got.body[0] === 0x89 && got.body[1] === 0x50,
    got.body.slice(0, 4));
  check('带 v 的头像可长缓存',
    /max-age=31536000/.test(String(got.headers['cache-control'])), got.headers['cache-control']);

  // 换头像 → v 戳变化
  const png2 = tinyPng();
  const up2 = await req('POST', '/api/me/avatar', {
    dataUrl: 'data:image/png;base64,' + png2.toString('base64')
  }, tok);
  const avUrl2 = up2.json && up2.json.user && up2.json.user.avatar;
  check('换头像后地址 v 戳变化', avUrl2 && avUrl2 !== avUrl, { avUrl, avUrl2 });

  // 非法输入
  const bad1 = await req('POST', '/api/me/avatar', { dataUrl: 'data:text/plain;base64,aGVsbG8=' }, tok);
  check('拒绝非图片 dataURL', bad1.status >= 400, bad1.status);
  const bad2 = await req('POST', '/api/me/avatar', { dataUrl: 'data:image/png;base64,!!!!' }, tok);
  check('拒绝损坏的 base64', bad2.status >= 400, bad2.status);
  const bad3 = await req('POST', '/api/me/avatar', { dataUrl: '' }, tok);
  check('拒绝空图片', bad3.status >= 400, bad3.status);

  // 消息里带 senderAvatar
  const rooms = await req('GET', '/api/rooms', null, tok);
  const pub = rooms.json && rooms.json.publicRoomId;
  const send = await req('POST', '/api/rooms/' + pub + '/messages',
    { kind: 'text', content: '头像测试消息' }, tok);
  const msg = send.json && send.json.message;
  check('消息序列化带 senderAvatar', msg && typeof msg.senderAvatar === 'string', msg && msg.senderAvatar);
  check('senderAvatar 与用户头像一致', msg && msg.senderAvatar === avUrl2,
    { msgAvatar: msg && msg.senderAvatar, avUrl2 });

  // 恢复默认
  const del = await req('DELETE', '/api/me/avatar', null, tok);
  check('DELETE 恢复默认成功', !!(del.json && del.json.ok), del.json);
  check('恢复后 avatar 清空', del.json && del.json.user && !del.json.user.avatar,
    del.json && del.json.user);
  const gone = await req('GET', avUrl2 || '/api/avatars/none');
  check('恢复后旧头像地址 404', gone.status === 404, gone.status);

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('❌ 测试执行失败:', e.message);
  process.exit(1);
});
