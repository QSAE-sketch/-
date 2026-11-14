'use strict';
/**
 * 配额与保留期专项测试（自带独立服务，不干扰主套件）：
 *   A. 每人 2GB 配额：用 USER_QUOTA_BYTES=1MB 起服务，验证「剩余不足直接拒传」
 *   B. 删除文件后配额释放
 *   C. 解散房间保留期：用 DISSOLVE_RETENTION_MS=1500 起服务，到期 sweep 连数据一起删
 *   D. 公共大厅不参与自动清理
 *
 * 为什么要单独起服务：配额与保留期都是启动时读环境变量的常量，
 * 主套件的服务用默认值（2GB / 5 天），没法在这里改小。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3313;
const DATA_DIR = path.join(ROOT, 'data-limits');
const QUOTA = 1024 * 1024;          // 1MB
const RETAIN_MS = 1500;
const BASE = 'http://127.0.0.1:' + PORT;
const KEY = process.env.PERM_KEY || 'lz-qingliao-2026';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 240) : '')); }
}
function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Type'] = 'application/json';
    const u = new URL(urlPath, BASE);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(cs);
        let j = null;
        try { j = JSON.parse(raw.toString()); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function putChunk(fileId, i, buf, token) {
  return new Promise((resolve, reject) => {
    const u = new URL('/api/files/' + fileId + '/chunk?i=' + i, BASE);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'PUT',
      headers: { 'X-Token': token, 'Content-Type': 'application/octet-stream' }
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        let j = null; try { j = JSON.parse(Buffer.concat(cs).toString()); } catch (e) {}
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    r.write(buf);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rnd() { return crypto.randomBytes(3).toString('hex'); }

async function upload(token, roomId, size) {
  const buf = crypto.randomBytes(size);
  let r = await req('POST', '/api/files/init', {
    name: 'q-' + size + '.bin', size: size, mime: 'application/octet-stream', roomId: roomId
  }, token);
  if (r.status !== 200) return { ok: false, init: r.status, json: r.json };
  const fid = r.json.fileId, cs = r.json.chunkSize, total = r.json.totalChunks;
  for (let i = 0; i < total; i++) {
    const part = buf.slice(i * cs, Math.min(size, (i + 1) * cs));
    const pr = await putChunk(fid, i, part, token);
    if (pr.status !== 200) return { ok: false, chunk: pr.status, json: pr.json };
  }
  r = await req('POST', '/api/files/' + fid + '/complete', {}, token);
  return { ok: r.status === 200, fileId: fid, complete: r.status, json: r.json };
}

let child = null;
function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        DATA_DIR: DATA_DIR,
        STORAGE_BACKEND: 'local',
        USER_QUOTA_BYTES: String(QUOTA),
        DISSOLVE_RETENTION_MS: String(RETAIN_MS)
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d.toString(); });
    child.stderr.on('data', (d) => { log += d.toString(); });
    const t0 = Date.now();
    const poll = async () => {
      if (Date.now() - t0 > 30000) return reject(new Error('测试服务启动超时\n' + log));
      try {
        const r = await req('GET', '/api/version');
        if (r.status === 200) return resolve();
      } catch (_) {}
      await sleep(250);
      return poll();
    };
    poll();
  });
}
function stopServer() {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    try { child.kill(); } catch (_) {}
    setTimeout(() => { try { if (child && child.exitCode === null) child.kill('SIGKILL'); } catch (_) {} resolve(); }, 2500);
  });
}

(async () => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  await startServer();

  /* ================= A. 配额 ================= */
  console.log('\n【A】每人配额：剩余不足直接拒传');

  const uname = 'lq_' + rnd();
  let r = await req('POST', '/api/register', {
    username: uname, password: 'pass123', nickname: '配额测试', permKey: KEY
  });
  check('注册并取得最高权限', r.status === 200 && r.json.user.master === true, r.json);
  const token = r.json.token;

  r = await req('GET', '/api/me/storage', null, token);
  check('初始配额正确', r.json && r.json.quota === QUOTA && r.json.used === 0, r.json);
  check('剩余 = 配额', r.json.remain === QUOTA);
  check('百分比为 0', r.json.percent === 0);
  check('返回可读文案', !!(r.json.quotaText && r.json.remainText), r.json);

  r = await req('GET', '/api/rooms', null, token);
  const pubId = r.json.publicRoomId;

  // 512KB 上传成功
  let up = await upload(token, pubId, Math.floor(QUOTA * 0.5));
  check('第一次上传（512KB）成功', up.ok, up);
  r = await req('GET', '/api/me/storage', null, token);
  check('已用空间被计入', r.json.used > QUOTA * 0.45, r.json);
  check('百分比已更新', r.json.percent >= 45 && r.json.percent <= 55, r.json);

  // 再来 600KB：剩余只有 ~350KB，必须直接拒
  up = await upload(token, pubId, Math.floor(QUOTA * 0.6));
  check('超出剩余配额的上传被拒', up.ok === false && up.init === 403, up);
  check('拒绝信息说明剩余空间', !!(up.json && /空间不足/.test(up.json.error || '')), up.json);

  // 刚好在剩余范围内（200KB）应放行
  r = await req('GET', '/api/me/storage', null, token);
  const remain = r.json.remain;
  up = await upload(token, pubId, Math.min(remain - 1024, 200 * 1024));
  check('剩余空间内的上传成功', up.ok, up);

  /* ================= B. 删除文件后释放配额 ================= */
  console.log('\n【B】彻底删除文件后配额释放');

  const before = (await req('GET', '/api/me/storage', null, token)).json.used;

  // 用一个更小的文件走完整链路：init → chunk → complete → 发消息 → 直接删除
  const small = 64 * 1024;
  const buf = crypto.randomBytes(small);
  r = await req('POST', '/api/files/init', {
    name: 'release.bin', size: small, mime: 'application/octet-stream', roomId: pubId
  }, token);
  check('小文件 init 成功', r.status === 200, r.json);
  const fid = r.json.fileId;
  await putChunk(fid, 0, buf, token);
  r = await req('POST', '/api/files/' + fid + '/complete', {}, token);
  check('小文件上传完成', r.status === 200, r.json);
  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'file', fileId: fid }, token);
  const msgId = r.json && r.json.message && r.json.message.id;
  check('文件消息发送成功', !!msgId, r.json);

  const withFile = (await req('GET', '/api/me/storage', null, token)).json.used;
  check('文件占用已计入配额', withFile > before, { before, withFile });

  r = await req('POST', '/api/messages/' + msgId + '/purge', {}, token);
  check('直接删除该文件消息成功', r.status === 200, r.json);
  r = await req('GET', '/api/me/storage', null, token);
  check('删除后配额立即释放', r.json.used === before, { before, after: r.json.used });

  /* ================= C. 解散房间保留期 ================= */
  console.log('\n【C】解散后仅保留保留期，到期连数据一起删');

  const gname = '保留期群' + rnd();
  r = await req('POST', '/api/rooms', { name: gname }, token);
  const gid = r.json.room.id;
  await req('POST', '/api/rooms/' + gid + '/messages', { content: '解散前的消息' }, token);
  r = await req('POST', '/api/rooms/' + gid + '/dissolve', { confirm: true }, token);
  check('解散成功', r.status === 200, r.json);
  check('返回保留到期时间', !!(r.json.retainUntil > Date.now()), r.json);

  r = await req('GET', '/api/rooms', null, token);
  const gb = (r.json.rooms || []).find((x) => x.id === gid);
  check('保留期内房间仍在（只读存档）', !!gb && gb.dissolved === true, gb);
  check('列表带 retainUntil', !!(gb && gb.retainUntil > Date.now()), gb);

  let list = await req('GET', '/api/rooms/' + gid + '/messages?since=0&limit=100', null, token);
  check('保留期内历史消息仍可读', (list.json.messages || []).some((m) => m.content === '解散前的消息'));

  // 等过期后触发清理
  await sleep(RETAIN_MS + 900);
  r = await req('POST', '/api/admin/rooms/sweep', {}, token);
  check('清理接口执行成功', r.status === 200, r.json);
  check('清理掉了 1 个到期房间', r.json.rooms >= 1, r.json);
  check('清理统计含消息数', r.json.messages >= 1, r.json);

  r = await req('GET', '/api/rooms', null, token);
  check('到期房间已从列表消失', !(r.json.rooms || []).some((x) => x.id === gid));
  r = await req('GET', '/api/rooms/' + gid + '/messages?since=0&limit=10', null, token);
  check('到期房间的消息一并删除（房间不存在 404）', r.status === 404, r.json);

  /* ================= D. 公共大厅不参与自动清理 ================= */
  console.log('\n【D】公共大厅不受保留期影响');

  r = await req('GET', '/api/rooms', null, token);
  const pub = (r.json.rooms || []).find((x) => x.id === pubId);
  check('公共大厅仍在且可用', !!pub && pub.dissolved === false, pub);

  r = await req('POST', '/api/admin/rooms/sweep', {}, token);
  check('再次清理不影响公共大厅', r.json.rooms === 0, r.json);

  await stopServer();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('异常:', e && e.stack ? e.stack : e);
  await stopServer();
  console.log('\n通过: ' + pass + '  失败: ' + (fail + 1));
  process.exit(1);
});
