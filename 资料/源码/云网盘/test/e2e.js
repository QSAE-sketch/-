'use strict';
/**
 * 云网盘端到端测试（自带两个服务，不依赖外部环境）：
 *   聊天站（3401，本地存储）+ 网盘（3402，1MB 配额）
 * 覆盖：共用账号登录、直传、分片断点续传、列表/详情/改名、Range 下载、
 *       签名直链、公开/加密分享、配额闸门、软删除、服务间导入、鉴权拦截。
 *
 * 用法：node test/e2e.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHAT_ROOT = path.join(ROOT, '..', 'chatapp');
const CHAT_PORT = 3401;
const ND_PORT = 3402;
const CHAT_BASE = 'http://127.0.0.1:' + CHAT_PORT;
const ND_BASE = 'http://127.0.0.1:' + ND_PORT;
const QUOTA = 1024 * 1024;
const SVC_KEY = 'test-svc-key';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 260) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(base, method, p, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const data = opts.raw !== undefined ? opts.raw
      : (opts.body === undefined || opts.body === null ? null : Buffer.from(JSON.stringify(opts.body)));
    const headers = Object.assign({}, opts.headers || {});
    if (data) headers['Content-Length'] = data.length;
    if (data && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(cs);
        let j = null;
        try { j = JSON.parse(buf.toString('utf8')); } catch (e) {}
        resolve({ status: res.statusCode, json: j, buf, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let chatChild = null, ndChild = null;

function startChat() {
  return new Promise((resolve, reject) => {
    chatChild = spawn(process.execPath, ['server.js'], {
      cwd: CHAT_ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(CHAT_PORT),
        DATA_DIR: path.join(CHAT_ROOT, 'data-ndtest'),
        STORAGE_BACKEND: 'local'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    chatChild.stdout.on('data', (d) => { log += d.toString(); });
    chatChild.stderr.on('data', (d) => { log += d.toString(); });
    const t0 = Date.now();
    const poll = async () => {
      if (Date.now() - t0 > 30000) return reject(new Error('聊天站启动超时\n' + log));
      try { const r = await request(CHAT_BASE, 'GET', '/api/version'); if (r.status === 200) return resolve(); } catch (_) {}
      await sleep(250);
      return poll();
    };
    poll();
  });
}

function startNd() {
  return new Promise((resolve, reject) => {
    ndChild = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(ND_PORT),
        DATA_DIR: path.join(ROOT, 'data-test'),
        CHAT_API_BASE: CHAT_BASE,
        CHAT_SHARECODE: '',
        USER_QUOTA_BYTES: String(QUOTA),
        RATE_LIMIT: '500',
        SERVICE_KEY: SVC_KEY,
        JWT_SECRET: 'test-jwt-secret'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    ndChild.stdout.on('data', (d) => { log += d.toString(); });
    ndChild.stderr.on('data', (d) => { log += d.toString(); });
    const t0 = Date.now();
    const poll = async () => {
      if (Date.now() - t0 > 30000) return reject(new Error('网盘启动超时\n' + log));
      try { const r = await request(ND_BASE, 'GET', '/api/health'); if (r.status === 200) return resolve(); } catch (_) {}
      await sleep(250);
      return poll();
    };
    poll();
  });
}

function stopAll() {
  try { if (ndChild) ndChild.kill(); } catch (_) {}
  try { if (chatChild) chatChild.kill(); } catch (_) {}
}

(async () => {
  for (const d of [path.join(ROOT, 'data-test'), path.join(CHAT_ROOT, 'data-ndtest')]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
  await startChat();
  await startNd();

  /* ---------- 1. 基础 ---------- */
  console.log('\n【1】健康检查与元信息');
  let r = await request(ND_BASE, 'GET', '/api/health');
  check('健康检查 200', r.status === 200 && r.json.code === 0, r.json);
  r = await request(ND_BASE, 'GET', '/api/meta');
  check('元信息带配额', r.json.data.quotaBytes === QUOTA, r.json.data);
  check('元信息带分片大小', r.json.data.chunkSize > 0);

  /* ---------- 2. 共用账号登录 ---------- */
  console.log('\n【2】与轻聊共用账号');
  const uname = 'nd_' + crypto.randomBytes(3).toString('hex');
  r = await request(CHAT_BASE, 'POST', '/api/register', {
    body: { username: uname, password: 'pass123', nickname: '网盘用户' }
  });
  check('聊天站注册成功', r.status === 200 && r.json.token, r.json);

  r = await request(ND_BASE, 'POST', '/api/auth/login', {
    body: { username: uname, password: '[已隐去]' }
  });
  check('错误密码被聊天站拒绝', r.status === 401 && r.json.code === 40001, r.json);

  r = await request(ND_BASE, 'POST', '/api/auth/login', {
    body: { username: uname, password: 'pass123' }
  });
  check('网盘用聊天账号登录成功', r.status === 200 && r.json.data.accessToken, r.json);
  const token = r.json.data.accessToken;
  const refresh = r.json.data.refreshToken;
  check('返回 access + refresh', !!token && !!refresh);
  check('返回用户昵称', r.json.data.user.nickname === '网盘用户', r.json.data.user);

  r = await request(ND_BASE, 'GET', '/api/me', { headers: { Authorization: 'Bearer ' + token } });
  check('/api/me 可读', r.status === 200 && r.json.data.user.username === uname, r.json);
  check('初始配额为 1MB', r.json.data.storage.totalBytes === QUOTA, r.json.data.storage);

  r = await request(ND_BASE, 'POST', '/api/auth/refresh', { body: { refreshToken: refresh } });
  check('刷新 token 成功', r.status === 200 && r.json.data.accessToken, r.json);

  /* ---------- 3. 直传 ---------- */
  console.log('\n【3】小文件直传');
  const small = Buffer.from('hello netdisk ' + Date.now());
  r = await request(ND_BASE, 'POST', '/api/files/upload', {
    raw: small,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('便签.txt'),
      'X-File-Size': String(small.length)
    }
  });
  check('直传成功', r.status === 200 && r.json.code === 0, r.json);
  const f1 = r.json.data.file;
  check('文件名正确（中文不乱码）', f1.fileName === '便签.txt', f1.fileName);
  check('大小正确', f1.fileSize === small.length, f1);
  check('md5 已计算', /^[a-f0-9]{32}$/.test(f1.md5), f1.md5);
  check('类型判定为 document', f1.fileType === 'document', f1.fileType);

  r = await request(ND_BASE, 'POST', '/api/files/upload', {
    raw: Buffer.from('MZ'),
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('virus.exe'),
      'X-File-Size': '2'
    }
  });
  check('可执行文件被白名单拦截', r.status === 415 && r.json.code === 40003, r.json);

  /* ---------- 4. 列表 / 详情 / 改名 ---------- */
  console.log('\n【4】列表 / 详情 / 改名');
  r = await request(ND_BASE, 'GET', '/api/files', { headers: { Authorization: 'Bearer ' + token } });
  check('列表返回 1 条', r.json.data.total === 1, r.json.data);
  check('列表带配额信息', r.json.data.storage.usedBytes === small.length, r.json.data.storage);

  r = await request(ND_BASE, 'GET', '/api/files/' + f1.fileId, { headers: { Authorization: 'Bearer ' + token } });
  check('详情可读', r.status === 200 && r.json.data.fileId === f1.fileId, r.json);
  check('详情带签名下载链接', String(r.json.data.downloadUrl).indexOf('k=') > 0, r.json.data.downloadUrl);

  r = await request(ND_BASE, 'PATCH', '/api/files/' + f1.fileId, {
    headers: { Authorization: 'Bearer ' + token }, body: { fileName: '改过的名字.txt' }
  });
  check('改名成功', r.status === 200 && r.json.data.fileName === '改过的名字.txt', r.json);

  r = await request(ND_BASE, 'GET', '/api/files?keyword=' + encodeURIComponent('改过'), {
    headers: { Authorization: 'Bearer ' + token }
  });
  check('关键字搜索命中', r.json.data.total === 1, r.json.data);
  r = await request(ND_BASE, 'GET', '/api/files?type=image', { headers: { Authorization: 'Bearer ' + token } });
  check('类型筛选（图片）为空', r.json.data.total === 0, r.json.data);

  /* ---------- 5. 下载：Range + 签名直链 ---------- */
  console.log('\n【5】下载：Range 与签名直链');
  r = await request(ND_BASE, 'GET', '/api/files/' + f1.fileId + '/download', {
    headers: { Authorization: 'Bearer ' + token, Range: 'bytes=0-4' }
  });
  check('Range 返回 206', r.status === 206, r.status);
  check('Content-Range 正确', r.headers['content-range'] === 'bytes 0-4/' + small.length, r.headers['content-range']);
  check('分片内容正确', r.buf.toString() === small.slice(0, 5).toString());

  const dlUrl = (await request(ND_BASE, 'GET', '/api/files/' + f1.fileId, {
    headers: { Authorization: 'Bearer ' + token }
  })).json.data.downloadUrl;
  r = await request(ND_BASE, 'GET', dlUrl);
  check('签名直链无需登录即可下载', r.status === 200 && r.buf.length === small.length, r.status);

  r = await request(ND_BASE, 'GET', '/api/files/' + f1.fileId + '/download?k=bad&exp=' + (Date.now() + 60000));
  check('伪造签名被拒', r.status === 401, r.status);

  r = await request(ND_BASE, 'GET', '/api/files?page=1', {});
  check('未登录访问列表被拒 401', r.status === 401, r.status);

  /* ---------- 6. 分片上传 ---------- */
  console.log('\n【6】分片上传 + 断点续传');
  const bigSize = 600 * 1024;
  const big = crypto.randomBytes(bigSize);
  r = await request(ND_BASE, 'POST', '/api/files/upload/init', {
    headers: { Authorization: 'Bearer ' + token },
    body: { fileName: '大文件.zip', fileSize: bigSize, chunkSize: 256 * 1024 }
  });
  check('init 成功', r.status === 200 && r.json.data.totalChunks === 3, r.json.data);
  const upId = r.json.data.uploadId;
  const cs = r.json.data.chunkSize;

  // 只传第 0 片，模拟中断
  r = await request(ND_BASE, 'PUT', '/api/files/upload/' + upId + '/chunk?i=0', {
    raw: big.slice(0, cs),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' }
  });
  check('单片上传成功', r.status === 200, r.json);
  r = await request(ND_BASE, 'POST', '/api/files/upload/init', {
    headers: { Authorization: 'Bearer ' + token },
    body: { fileName: '大文件.zip', fileSize: bigSize, chunkSize: 256 * 1024, resumeUploadId: upId }
  });
  check('续传时返回已收分片', r.json.data.received.length === 1 && r.json.data.resumed === true, r.json.data);

  for (let i = 1; i < 3; i++) {
    await request(ND_BASE, 'PUT', '/api/files/upload/' + upId + '/chunk?i=' + i, {
      raw: big.slice(i * cs, Math.min(bigSize, (i + 1) * cs)),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' }
    });
  }
  r = await request(ND_BASE, 'POST', '/api/files/upload/' + upId + '/complete', {
    headers: { Authorization: 'Bearer ' + token }
  });
  check('合并完成', r.status === 200 && r.json.data.file.fileSize === bigSize, r.json);
  const bigFileId = r.json.data.file && r.json.data.file.fileId;

  r = await request(ND_BASE, 'GET', '/api/files/' + bigFileId + '/download', {
    headers: { Authorization: 'Bearer ' + token }
  });
  check('合并后的字节与源文件一致', r.buf.length === bigSize && r.buf.equals(big), r.buf.length);

  /* ---------- 7. 分享 ---------- */
  console.log('\n【7】分享：公开 / 提取码');
  r = await request(ND_BASE, 'POST', '/api/files/' + f1.fileId + '/share', {
    headers: { Authorization: 'Bearer ' + token }, body: { expireDays: 7 }
  });
  check('创建公开分享', r.status === 200 && r.json.data.shareType === 'public', r.json);
  const pubShare = r.json.data.shareId;

  r = await request(ND_BASE, 'GET', '/api/shares/' + pubShare);
  check('公开分享信息可读', r.status === 200 && r.json.data.fileName === '改过的名字.txt', r.json);
  r = await request(ND_BASE, 'GET', '/api/shares/' + pubShare + '/download');
  check('公开分享可直接下载', r.status === 200 && r.buf.length === small.length, r.status);

  r = await request(ND_BASE, 'POST', '/api/files/' + f1.fileId + '/share', {
    headers: { Authorization: 'Bearer ' + token }, body: { expireDays: 3, extractCode: '8888' }
  });
  check('创建加密分享', r.status === 200 && r.json.data.hasCode === true, r.json);
  const encShare = r.json.data.shareId;

  r = await request(ND_BASE, 'GET', '/api/shares/' + encShare);
  check('不带提取码提示需要提取码', r.status === 401 && r.json.data && r.json.data.needCode === true, r.json);
  r = await request(ND_BASE, 'GET', '/api/shares/' + encShare + '?code=0000');
  check('错误提取码被拒', r.status === 401, r.json);
  r = await request(ND_BASE, 'GET', '/api/shares/' + encShare + '?code=8888');
  check('正确提取码可读信息', r.status === 200 && r.json.data.fileName, r.json);

  /* ---------- 8. 配额 ---------- */
  console.log('\n【8】配额闸门');
  r = await request(ND_BASE, 'GET', '/api/storage', { headers: { Authorization: 'Bearer ' + token } });
  const used = r.json.data.usedBytes;
  check('已用空间统计正确', used === small.length + bigSize, r.json.data);

  const tooBig = QUOTA - used + 1024;
  r = await request(ND_BASE, 'POST', '/api/files/upload/init', {
    headers: { Authorization: 'Bearer ' + token },
    body: { fileName: '超额.zip', fileSize: tooBig }
  });
  check('超出剩余配额被拒 409', r.status === 409 && r.json.code === 40004, r.json);

  /* ---------- 9. 服务间导入（聊天文件自动存网盘） ---------- */
  console.log('\n【9】聊天文件自动存入网盘');
  const imp = Buffer.from('chat-imported-' + Date.now());
  r = await request(ND_BASE, 'POST', '/api/svc/import', {
    raw: imp,
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Svc-Key': SVC_KEY,
      'X-Chat-User': 'chat-uid-1',
      'X-Chat-Username': 'chat_user',
      'X-Chat-Nickname': encodeURIComponent('聊天用户'),
      'X-File-Name': encodeURIComponent('聊天里的图片.png'),
      'X-File-Size': String(imp.length)
    }
  });
  check('服务间导入成功', r.status === 200 && r.json.code === 0, r.json);
  check('导入文件标记来源', r.json.data.file.fileName === '聊天里的图片.png', r.json.data.file);

  r = await request(ND_BASE, 'POST', '/api/svc/import', {
    raw: imp,
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Svc-Key': 'wrong-key',
      'X-Chat-User': 'chat-uid-1',
      'X-File-Name': 'x.png',
      'X-File-Size': String(imp.length)
    }
  });
  check('错误服务密钥被拒', r.status === 401, r.json);

  /* ---------- 10. 软删除 ---------- */
  console.log('\n【10】软删除');
  r = await request(ND_BASE, 'DELETE', '/api/files/' + bigFileId, { headers: { Authorization: 'Bearer ' + token } });
  check('删除标记成功', r.status === 200 && r.json.data.isDeleted === true, r.json);
  check('返回物理清理时间', r.json.data.purgeAt > Date.now(), r.json.data);

  r = await request(ND_BASE, 'GET', '/api/files', { headers: { Authorization: 'Bearer ' + token } });
  check('列表不再包含已删除', !(r.json.data.list || []).some((f) => f.fileId === bigFileId));
  check('软删除仍占配额（回收站）', r.json.data.storage.usedBytes === used, r.json.data.storage);

  r = await request(ND_BASE, 'GET', '/api/files?deleted=1', { headers: { Authorization: 'Bearer ' + token } });
  check('回收站视图能看到', (r.json.data.list || []).some((f) => f.fileId === bigFileId));

  /* ---------- 11. 静态资源 ---------- */
  console.log('\n【11】静态页面');
  r = await request(ND_BASE, 'GET', '/');
  check('首页可访问且含登录框', r.status === 200 && r.buf.toString().indexOf('轻聊云网盘') >= 0);
  r = await request(ND_BASE, 'GET', '/s/' + pubShare);
  check('分享页路由回落到 share.html', r.status === 200 && r.buf.toString().indexOf('share.js') >= 0);
  r = await request(ND_BASE, 'GET', '/style.css');
  check('样式表可访问且不含 CSS 变量', r.status === 200 && r.buf.toString().indexOf('var(--') < 0);

  stopAll();
  for (const d of [path.join(ROOT, 'data-test'), path.join(CHAT_ROOT, 'data-ndtest')]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常:', e && e.stack ? e.stack : e);
  stopAll();
  console.log('\n通过: ' + pass + '  失败: ' + (fail + 1));
  process.exit(1);
});
