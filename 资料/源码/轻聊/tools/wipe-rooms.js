'use strict';
/**
 * 清空线上所有房间与房间记录（不可逆）。
 *
 * 走服务自身的最高权限接口，保证内存缓存与云端文档一致：
 *   1. 用权限密钥注册一个临时管理账号（注册后立刻自注销，不留痕迹）
 *   2. POST /api/admin/rooms/wipe-all  （confirm + 口令「清空所有房间」）
 *   3. 打印统计并注销临时账号
 *
 * 前置：先跑 node tools/backup-cloud.js 备份，万一要回滚还有元数据。
 * 用法：node tools/wipe-rooms.js [baseUrl] [sharecode]
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const BASE = process.argv[2] || 'https://qingliao-chat-33476.app.workbuddy.host';
const SHARECODE = process.argv[3] || 'T7ELJZOC5A';
const KEY = process.env.PERM_KEY || 'lz-qingliao-2026';
const MOD = BASE.startsWith('https') ? https : http;

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, BASE);
    if (!u.searchParams.has('sharecode')) u.searchParams.set('sharecode', SHARECODE);
    const data = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body));
    const headers = { Host: u.host };
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Type'] = 'application/json';
    const r = MOD.request({
      hostname: u.hostname, port: u.port || (BASE.startsWith('https') ? 443 : 80),
      path: u.pathname + u.search, method, headers, timeout: 30000
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(cs).toString()); } catch (e) {}
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
  const uname = 'wipe_' + crypto.randomBytes(4).toString('hex');
  let r = await req('POST', '/api/register', {
    username: uname, password: 'wipe123456', nickname: '清库临时账号', permKey: KEY
  });
  if (r.status !== 200 || !r.json.user || r.json.user.master !== true) {
    console.error('✗ 无法取得最高权限：' + JSON.stringify(r.json));
    process.exit(1);
  }
  const token = r.json.token;
  console.log('✓ 已取得最高权限（临时账号 ' + uname + '）');

  r = await req('POST', '/api/admin/rooms/wipe-all', {}, token);
  console.log('  · 缺少口令 → ' + r.status + '（应为 400）');

  r = await req('POST', '/api/admin/rooms/wipe-all', { confirm: true, phrase: '清空所有房间' }, token);
  if (r.status !== 200) {
    console.error('✗ 清空失败：' + JSON.stringify(r.json));
    process.exit(1);
  }
  console.log('✓ 已清空：房间 ' + r.json.rooms + ' 个 / 消息 ' + r.json.messages +
    ' 条 / 文件 ' + r.json.files + ' 个');
  console.log('  · 新公共大厅 id: ' + r.json.publicRoomId);

  // 复核
  r = await req('GET', '/api/rooms', null, token);
  const rooms = (r.json && r.json.rooms) || [];
  console.log('✓ 复核：当前房间数 ' + rooms.length + '（应只剩公共大厅）');

  r = await req('POST', '/api/account/delete', { confirm: true }, token);
  console.log((r.status === 200 ? '✓' : '✗') + ' 临时账号已注销');
})().catch((e) => {
  console.error('异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
