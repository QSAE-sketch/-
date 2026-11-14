'use strict';
/**
 * 轻聊 · 云网盘 服务端
 *
 * 独立服务，零第三方依赖（只用 Node 内置模块），单端口 HTTP，可直接发布。
 * 与轻聊聊天站共用账号：登录时由本服务代用户向聊天站 /api/login 校验，
 * 通过后按「聊天站 userId」映射出本地账号，再签发本服务自己的 JWT。
 * 聊天站不需要任何改动，密码也不落在本服务里。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

const core = require('./src/core');
const {
  PORT, HOST, DATA_DIR, PUBLIC_DIR, BLOBS_DIR,
  USER_QUOTA_BYTES, CHUNK_SIZE, SMALL_UPLOAD_LIMIT,
  ACCESS_TTL, SHARE_DEFAULT_DAYS, RECYCLE_KEEP_MS,
  SERVICE_KEY, CHAT_API_BASE, CHAT_SHARECODE, ALLOW_ORIGINS,
  CODE, HTTP_OF_CODE, MESSAGE_OF_CODE,
  now, randomId, md5Hex, safeFileName, extOf, mimeOf, fileTypeGroup,
  validateFile, signTokens, verifyJwt, signUrl, checkUrl,
  loadStore, flushStore, put, get, del, all, findBy,
  ensureUserDir, writeBlob, writeChunk, chunkIndexes, mergeChunks, removeBlob,
  storageInfo, canStore, rateCheck, opLog
} = require('./src/core');

const VERSION_FILE = path.join(__dirname, 'version.json');
const MAX_JSON_BODY = 512 * 1024;

/* ================================================================== */
/* 基础工具                                                            */
/* ================================================================== */

function readJson(req) {
  return new Promise((resolve, reject) => {
    const cs = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > MAX_JSON_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      cs.push(c);
    });
    req.on('end', () => {
      if (!cs.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(cs).toString('utf8'))); }
      catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, extraHeaders) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  }, extraHeaders || {});
  res.writeHead(status, headers);
  res.end(body);
}
function ok(res, data) { sendJson(res, 200, { code: CODE.OK, message: 'ok', data: data === undefined ? null : data }); }
function fail(res, code) {
  const status = HTTP_OF_CODE[code] || 400;
  sendJson(res, status, { code: code, message: MESSAGE_OF_CODE[code] || '请求失败', data: null });
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) || '';
}

/** 鉴权：Authorization: Bearer xxx，或 ?token= （下载直连用） */
function authUser(req, url) {
  let raw = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!raw && url) raw = url.searchParams.get('token') || '';
  if (!raw) return null;
  const body = verifyJwt(raw);
  if (!body || body.typ !== 'access') return null;
  const u = get('users', body.sub);
  if (!u) return null;
  return u;
}

function publicFile(f) {
  return {
    fileId: f.id,
    fileName: f.fileName,
    fileSize: f.fileSize,
    fileType: f.fileType,
    mime: f.mime,
    folder: f.folder || '',
    md5: f.md5,
    uploadTime: f.uploadTime,
    updateTime: f.updateTime || f.uploadTime,
    isDeleted: !!f.isDeleted,
    shareId: f.shareId || null
  };
}

/* ================================================================== */
/* 账号：与轻聊共用                                                     */
/* ================================================================== */

/**
 * 向聊天站校验账号密码。
 * 聊天站部署在分享链接后面，必须带 sharecode，否则网关直接 403。
 */
function chatLogin(username, password) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL('/api/login', CHAT_API_BASE);
    } catch (e) { return resolve({ ok: false, error: '聊天站地址无效' }); }
    if (CHAT_SHARECODE) u.searchParams.set('sharecode', CHAT_SHARECODE);
    const body = Buffer.from(JSON.stringify({ username, password }), 'utf8');
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const r = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'User-Agent': 'qingliao-netdisk/1.0'
      },
      timeout: 15000
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(cs).toString('utf8')); } catch (e) {}
        if (res.statusCode === 200 && j && j.user) return resolve({ ok: true, user: j.user });
        resolve({ ok: false, error: (j && j.error) || '账号或密码错误' });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', (e) => resolve({ ok: false, error: '连接聊天站失败：' + e.message }));
    r.write(body);
    r.end();
  });
}

/** 按聊天站用户映射出本地账号（只存 id / 账号名 / 昵称，不存密码） */
function upsertUser(chatUser) {
  const id = 'u_' + String(chatUser.id);
  let u = get('users', id);
  if (!u) {
    u = { id: id, chatUserId: chatUser.id, username: chatUser.username, nickname: chatUser.nickname || chatUser.username, createdAt: now() };
  } else {
    u.username = chatUser.username;
    u.nickname = chatUser.nickname || chatUser.username;
  }
  u.lastSeen = now();
  put('users', u);
  return u;
}

/* ================================================================== */
/* 路由表                                                              */
/* ================================================================== */

const routes = [];
function route(method, pattern, handler, opt) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:([A-Za-z_]+)/g, (m, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, handler, auth: !(opt && opt.auth === false) });
}
function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.rx.exec(pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { handler: r.handler, params, auth: r.auth };
  }
  return null;
}

/* ---------------- 健康检查 / 版本 ---------------- */

route('GET', '/api/health', async (req, res) => {
  ok(res, { status: 'ok', serverTime: now() });
}, { auth: false });

route('GET', '/api/meta', async (req, res) => {
  let v = { name: '1.0.0' };
  try { v = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')); } catch (e) {}
  ok(res, {
    version: v,
    quotaBytes: USER_QUOTA_BYTES,
    chunkSize: CHUNK_SIZE,
    smallUploadLimit: SMALL_UPLOAD_LIMIT,
    chatBase: CHAT_API_BASE
  });
}, { auth: false });

/* ---------------- 认证 ---------------- */

route('POST', '/api/auth/login', async (req, res) => {
  const b = await readJson(req);
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  if (!username || !password) return fail(res, CODE.BAD_REQUEST);

  const r = await chatLogin(username, password);
  if (!r.ok) return sendJson(res, 401, { code: CODE.AUTH_FAILED, message: r.error, data: null });

  const u = upsertUser(r.user);
  opLog(u.id, 'login', '', clientIp(req), 'ok');
  ok(res, Object.assign({ user: { id: u.id, username: u.username, nickname: u.nickname } }, signTokens(u)));
}, { auth: false });

route('POST', '/api/auth/refresh', async (req, res) => {
  const b = await readJson(req);
  const body = verifyJwt(String(b.refreshToken || ''));
  if (!body || body.typ !== 'refresh') return fail(res, CODE.AUTH_FAILED);
  const u = get('users', body.sub);
  if (!u) return fail(res, CODE.AUTH_FAILED);
  ok(res, signTokens(u));
}, { auth: false });

route('GET', '/api/me', async (req, res, ctx) => {
  ok(res, {
    user: { id: ctx.user.id, username: ctx.user.username, nickname: ctx.user.nickname },
    storage: storageInfo(ctx.user.id)
  });
});

/* ---------------- 上传：小文件直传 ---------------- */

/** 浏览器会用 encodeURIComponent 传文件名，这里要能兼容「编码过」与「没编码」两种 */
function headerName(v) {
  const s = String(v == null ? '' : v);
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

route('POST', '/api/files/upload', async (req, res, ctx) => {
  const name = safeFileName(headerName(req.headers['x-file-name']) || 'file');
  const size = Number(req.headers['x-file-size'] || req.headers['content-length'] || 0);
  const v = validateFile(name, size);
  if (v === CODE.FILE_TOO_LARGE) return fail(res, CODE.FILE_TOO_LARGE);
  if (v === CODE.TYPE_NOT_ALLOWED) return fail(res, CODE.TYPE_NOT_ALLOWED);
  if (v !== CODE.OK) return fail(res, v);
  if (size > SMALL_UPLOAD_LIMIT) return fail(res, CODE.FILE_TOO_LARGE);
  const q = canStore(ctx.user.id, size);
  if (q !== CODE.OK) return fail(res, q);

  const fileId = randomId('f');
  const stored = await writeBlob(ctx.user.id, fileId, req, size + 1024).catch(() => -1);
  if (stored < 0) return fail(res, CODE.FILE_TOO_LARGE);
  if (stored !== size) {
    removeBlob(ctx.user.id, fileId);
    return fail(res, CODE.BAD_REQUEST);
  }
  // md5 只对小文件算：大文件读进内存算哈希会直接顶爆低配机器
  const md5 = stored <= 16 * 1024 * 1024
    ? md5Hex(fs.readFileSync(require('./src/core').blobPath(ctx.user.id, fileId)))
    : '';
  const doc = {
    id: fileId, userId: ctx.user.id, fileName: name, fileSize: stored,
    fileType: fileTypeGroup(mimeOf(name), name), mime: mimeOf(name),
    folder: String(req.headers['x-folder'] || ''), md5: md5,
    uploadTime: now(), isDeleted: false, deletedAt: 0, shareId: null
  };
  put('files', doc);
  opLog(ctx.user.id, 'upload', fileId, clientIp(req), 'ok');
  ok(res, { file: publicFile(doc), storage: storageInfo(ctx.user.id) });
});

/* ---------------- 上传：分片 + 断点续传 ---------------- */

route('POST', '/api/files/upload/init', async (req, res, ctx) => {
  const b = await readJson(req);
  const name = safeFileName(b.fileName || 'file');
  const size = Number(b.fileSize) || 0;
  const v = validateFile(name, size);
  if (v !== CODE.OK) return fail(res, v);
  const q = canStore(ctx.user.id, size);
  if (q !== CODE.OK) return fail(res, q);

  const chunkSize = Math.min(CHUNK_SIZE, Math.max(256 * 1024, Number(b.chunkSize) || CHUNK_SIZE));
  const totalChunks = Math.max(1, Math.ceil(size / chunkSize));
  const uploadId = randomId('up');

  let doc = b.resumeUploadId ? get('uploads', String(b.resumeUploadId)) : null;
  if (doc && (doc.userId !== ctx.user.id || doc.fileName !== name || doc.fileSize !== size || doc.done)) doc = null;

  if (!doc) {
    doc = {
      id: uploadId, userId: ctx.user.id, fileName: name, fileSize: size,
      mime: mimeOf(name), folder: String(b.folder || ''),
      chunkSize: chunkSize, totalChunks: totalChunks, received: [],
      done: false, createdAt: now()
    };
    put('uploads', doc);
  } else {
    doc.received = chunkIndexes(doc.id);
    put('uploads', doc);
  }
  ok(res, {
    uploadId: doc.id, chunkSize: doc.chunkSize, totalChunks: doc.totalChunks,
    received: doc.received.slice(), resumed: !!b.resumeUploadId && doc.received.length > 0
  });
});

route('PUT', '/api/files/upload/:uploadId/chunk', async (req, res, ctx) => {
  const doc = get('uploads', ctx.params.uploadId);
  if (!doc || doc.userId !== ctx.user.id || doc.done) return fail(res, CODE.FILE_NOT_FOUND);
  const i = Number(ctx.url.searchParams.get('i'));
  if (!(i >= 0 && i < doc.totalChunks)) return fail(res, CODE.BAD_REQUEST);
  const n = await writeChunk(doc.id, i, req, doc.chunkSize + 64 * 1024).catch(() => -1);
  if (n < 0) return fail(res, CODE.FILE_TOO_LARGE);
  doc.received = chunkIndexes(doc.id);
  put('uploads', doc);
  ok(res, { index: i, receivedCount: doc.received.length, chunkSize: n });
});

route('POST', '/api/files/upload/:uploadId/complete', async (req, res, ctx) => {
  const doc = get('uploads', ctx.params.uploadId);
  if (!doc || doc.userId !== ctx.user.id || doc.done) return fail(res, CODE.FILE_NOT_FOUND);
  const got = chunkIndexes(doc.id);
  if (got.length < doc.totalChunks) {
    return sendJson(res, 400, {
      code: CODE.BAD_REQUEST,
      message: '分片未传完（' + got.length + '/' + doc.totalChunks + '）',
      data: { received: got }
    });
  }
  // 合并后再核一次配额：并发上传可能在中途把剩余空间吃满
  const q = canStore(ctx.user.id, doc.fileSize);
  if (q !== CODE.OK) return fail(res, q);

  const fileId = randomId('f');
  const total = await mergeChunks(doc.id, ctx.user.id, fileId, doc.totalChunks).catch(() => -1);
  if (total < 0) return fail(res, CODE.INTERNAL);
  const real = fs.statSync(require('./src/core').blobPath(ctx.user.id, fileId)).size;
  if (real !== doc.fileSize) {
    removeBlob(ctx.user.id, fileId);
    return fail(res, CODE.BAD_REQUEST);
  }
  const fileDoc = {
    id: fileId, userId: ctx.user.id, fileName: doc.fileName, fileSize: real,
    fileType: fileTypeGroup(doc.mime, doc.fileName), mime: doc.mime,
    folder: doc.folder || '', md5: '', uploadTime: now(), isDeleted: false, deletedAt: 0, shareId: null
  };
  put('files', fileDoc);
  doc.done = true;
  put('uploads', doc);
  opLog(ctx.user.id, 'upload_chunked', fileId, clientIp(req), 'ok');
  ok(res, { file: publicFile(fileDoc), storage: storageInfo(ctx.user.id) });
});

/* ---------------- 列表 / 详情 / 改名 / 删除 ---------------- */

route('GET', '/api/files', async (req, res, ctx) => {
  const q = ctx.url.searchParams;
  const page = Math.max(1, Number(q.get('page')) || 1);
  const size = Math.min(100, Math.max(1, Number(q.get('size')) || 20));
  const type = String(q.get('type') || '').trim();
  const keyword = String(q.get('keyword') || '').trim().toLowerCase();
  const sort = String(q.get('sort') || 'uploadTime');
  const order = String(q.get('order') || 'desc') === 'asc' ? 1 : -1;
  const includeDeleted = q.get('deleted') === '1';

  let list = all('files').filter((f) => f.userId === ctx.user.id);
  if (!includeDeleted) list = list.filter((f) => !f.isDeleted);
  if (type) list = list.filter((f) => f.fileType === type);
  if (keyword) list = list.filter((f) => String(f.fileName).toLowerCase().indexOf(keyword) >= 0);

  const key = sort === 'fileSize' ? 'fileSize' : (sort === 'fileName' ? 'fileName' : 'uploadTime');
  list.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === 'string') return av.localeCompare(bv) * order;
    return (av - bv) * order;
  });

  const total = list.length;
  const slice = list.slice((page - 1) * size, page * size);
  ok(res, {
    total: total, page: page, size: size,
    list: slice.map(publicFile),
    storage: storageInfo(ctx.user.id)
  });
});

route('GET', '/api/files/:id', async (req, res, ctx) => {
  const f = get('files', ctx.params.id);
  if (!f || f.userId !== ctx.user.id) return fail(res, CODE.FILE_NOT_FOUND);
  const signed = signUrl(f.id);
  const d = publicFile(f);
  d.thumbnailUrl = f.fileType === 'image' ? '/api/files/' + f.id + '/download?k=' + signed.k + '&exp=' + signed.exp : null;
  d.downloadUrl = '/api/files/' + f.id + '/download?k=' + signed.k + '&exp=' + signed.exp;
  ok(res, d);
});

route('PATCH', '/api/files/:id', async (req, res, ctx) => {
  const f = get('files', ctx.params.id);
  if (!f || f.userId !== ctx.user.id) return fail(res, CODE.FILE_NOT_FOUND);
  if (f.isDeleted) return fail(res, CODE.FILE_NOT_FOUND);
  const b = await readJson(req);
  if (b.fileName !== undefined) {
    const name = safeFileName(b.fileName);
    const v = validateFile(name, f.fileSize);
    if (v === CODE.TYPE_NOT_ALLOWED) return fail(res, CODE.TYPE_NOT_ALLOWED);
    f.fileName = name;
  }
  if (b.folder !== undefined) f.folder = String(b.folder || '').slice(0, 60);
  f.updateTime = now();
  put('files', f);
  opLog(ctx.user.id, 'rename', f.id, clientIp(req), 'ok');
  ok(res, publicFile(f));
});

route('DELETE', '/api/files/:id', async (req, res, ctx) => {
  const f = get('files', ctx.params.id);
  if (!f || f.userId !== ctx.user.id) return fail(res, CODE.FILE_NOT_FOUND);
  if (f.isDeleted) return ok(res, { fileId: f.id, isDeleted: true });
  f.isDeleted = true;
  f.deletedAt = now();
  put('files', f);
  opLog(ctx.user.id, 'delete', f.id, clientIp(req), 'ok');
  ok(res, { fileId: f.id, isDeleted: true, purgeAt: f.deletedAt + RECYCLE_KEEP_MS });
});

/* ---------------- 下载（Range + 签名直连） ---------------- */

route('GET', '/api/files/:id/download', async (req, res, ctx) => {
  const f = get('files', ctx.params.id);
  if (!f) return fail(res, CODE.FILE_NOT_FOUND);
  const url = ctx.url;
  const signedOk = checkUrl(f.id, url.searchParams.get('k'), url.searchParams.get('exp'));
  if (!signedOk) {
    // 这条路由不能挂全局鉴权（否则签名直链会被拦），登录态在这里手动校验
    const u = ctx.user || authUser(req, url);
    if (!u || u.id !== f.userId) return fail(res, CODE.AUTH_FAILED);
  }
  const fp = require('./src/core').blobPath(f.userId, f.id);
  if (!fs.existsSync(fp)) return fail(res, CODE.FILE_NOT_FOUND);

  const stat = fs.statSync(fp);
  const range = String(req.headers.range || '');
  const mime = f.mime || 'application/octet-stream';
  const dispo = 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(f.fileName);

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) return sendJson(res, 416, { code: CODE.BAD_REQUEST, message: 'Range 不合法', data: null });
    let start = m[1] === '' ? null : Number(m[1]);
    let end = m[2] === '' ? null : Number(m[2]);
    if (start === null && end === null) return sendJson(res, 416, { code: CODE.BAD_REQUEST, message: 'Range 不合法', data: null });
    if (start === null) { start = Math.max(0, stat.size - end); end = stat.size - 1; }
    else if (end === null || end >= stat.size) end = stat.size - 1;
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': mime,
      'Content-Length': end - start + 1,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': dispo
    });
    return fs.createReadStream(fp, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': dispo
  });
  fs.createReadStream(fp).pipe(res);
}, { auth: false });

/** 直连预览（图片/视频内嵌，不带 attachment） */
route('GET', '/api/files/:id/raw', async (req, res, ctx) => {
  const f = get('files', ctx.params.id);
  if (!f) return fail(res, CODE.FILE_NOT_FOUND);
  const url = ctx.url;
  const signedOk = checkUrl(f.id, url.searchParams.get('k'), url.searchParams.get('exp'));
  if (!signedOk) {
    const u = ctx.user || authUser(req, url);
    if (!u || u.id !== f.userId) return fail(res, CODE.AUTH_FAILED);
  }
  const fp = require('./src/core').blobPath(f.userId, f.id);
  if (!fs.existsSync(fp)) return fail(res, CODE.FILE_NOT_FOUND);
  const stat = fs.statSync(fp);
  res.writeHead(200, { 'Content-Type': f.mime || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'private, max-age=900' });
  fs.createReadStream(fp).pipe(res);
}, { auth: false });

/* ---------------- 分享 ---------------- */

route('POST', '/api/files/:id/share', async (req, res, ctx) => {
  const f = get('files', ctx.params.id);
  if (!f || f.userId !== ctx.user.id || f.isDeleted) return fail(res, CODE.FILE_NOT_FOUND);
  const b = await readJson(req);
  const days = Math.min(30, Math.max(1, Number(b.expireDays) || SHARE_DEFAULT_DAYS));
  const code = b.extractCode ? String(b.extractCode).trim().slice(0, 8) : '';
  const doc = {
    id: randomId('s'), fileId: f.id, userId: ctx.user.id, fileName: f.fileName,
    shareType: code ? 'private' : 'public', extractCode: code,
    expireTime: now() + days * 86400000, downloadCount: 0, createTime: now(), enabled: true
  };
  put('shares', doc);
  f.shareId = doc.id;
  put('files', f);
  opLog(ctx.user.id, 'share', f.id, clientIp(req), 'ok');
  ok(res, {
    shareId: doc.id, fileId: f.id, fileName: doc.fileName,
    shareType: doc.shareType, hasCode: !!code,
    expireTime: doc.expireTime, createTime: doc.createTime, downloadCount: 0,
    shareUrl: '/s/' + doc.id
  });
});

route('GET', '/api/shares/:shareId', async (req, res, ctx) => {
  const s = get('shares', ctx.params.shareId);
  if (!s) return fail(res, CODE.SHARE_EXPIRED);
  if (s.expireTime < now()) return fail(res, CODE.SHARE_EXPIRED);
  const code = ctx.url.searchParams.get('code') || '';
  if (s.shareType === 'private' && code !== s.extractCode) {
    return sendJson(res, 401, { code: CODE.SHARE_EXPIRED, message: '提取码错误', data: { needCode: true, fileName: s.fileName } });
  }
  const f = get('files', s.fileId);
  ok(res, {
    shareId: s.id, fileName: s.fileName, fileSize: f ? f.fileSize : 0,
    fileType: f ? f.fileType : 'other', mime: f ? f.mime : '',
    shareType: s.shareType, expireTime: s.expireTime, downloadCount: s.downloadCount,
    owner: (get('users', s.userId) || {}).nickname || '未知',
    downloadUrl: '/api/shares/' + s.id + '/download' + (s.shareType === 'private' ? '?code=' + encodeURIComponent(code) : '')
  });
}, { auth: false });

route('GET', '/api/shares/:shareId/download', async (req, res) => {
  const s = get('shares', req._params.shareId);
  if (!s || s.expireTime < now()) return fail(res, CODE.SHARE_EXPIRED);
  const code = req._url.searchParams.get('code') || '';
  if (s.shareType === 'private' && code !== s.extractCode) return fail(res, CODE.SHARE_EXPIRED);
  const f = get('files', s.fileId);
  if (!f || f.isDeleted) return fail(res, CODE.FILE_NOT_FOUND);
  const fp = require('./src/core').blobPath(f.userId, f.id);
  if (!fs.existsSync(fp)) return fail(res, CODE.FILE_NOT_FOUND);
  s.downloadCount = (s.downloadCount || 0) + 1;
  put('shares', s);
  const stat = fs.statSync(fp);
  res.writeHead(200, {
    'Content-Type': f.mime || 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(f.fileName)
  });
  fs.createReadStream(fp).pipe(res);
}, { auth: false });

/* ---------------- 存储空间 ---------------- */

route('GET', '/api/storage', async (req, res, ctx) => {
  ok(res, storageInfo(ctx.user.id));
});

/* ---------------- 服务间：聊天站文件自动存网盘 ---------------- */

/**
 * 聊天站上传完文件后，用服务密钥调用本接口，把字节顺手存一份到用户网盘。
 * 身份靠 X-Svc-Key + chatUserId 头部，不需要用户 JWT。
 * 配额同样校验：空间不够直接 409，聊天站只记一条日志，不影响上传本身。
 */
route('POST', '/api/svc/import', async (req, res, ctx) => {
  if (String(req.headers['x-svc-key'] || '') !== SERVICE_KEY) return fail(res, CODE.AUTH_FAILED);
  const chatUserId = String(req.headers['x-chat-user'] || '');
  const chatUsername = String(req.headers['x-chat-username'] || 'user');
  const chatNickname = String(headerName(req.headers['x-chat-nickname']) || chatUsername);
  const name = safeFileName(headerName(req.headers['x-file-name']) || 'file');
  const size = Number(req.headers['x-file-size'] || 0);
  if (!chatUserId || size <= 0) return fail(res, CODE.BAD_REQUEST);

  const u = upsertUser({ id: chatUserId, username: chatUsername, nickname: chatNickname });
  const v = validateFile(name, size);
  if (v !== CODE.OK) return fail(res, v);
  const q = canStore(u.id, size);
  if (q !== CODE.OK) return fail(res, q);

  const fileId = randomId('f');
  const stored = await writeBlob(u.id, fileId, req, size + 1024).catch(() => -1);
  if (stored < 0 || stored !== size) {
    removeBlob(u.id, fileId);
    return fail(res, stored < 0 ? CODE.FILE_TOO_LARGE : CODE.BAD_REQUEST);
  }
  const doc = {
    id: fileId, userId: u.id, fileName: name, fileSize: stored,
    fileType: fileTypeGroup(mimeOf(name), name), mime: mimeOf(name),
    folder: '来自聊天', md5: '', uploadTime: now(), isDeleted: false, deletedAt: 0, shareId: null,
    source: 'chat'
  };
  put('files', doc);
  opLog(u.id, 'import_from_chat', fileId, clientIp(req), 'ok');
  ok(res, { file: publicFile(doc), storage: storageInfo(u.id) });
}, { auth: false });

/* ================================================================== */
/* 回收站清理：软删除 30 天后物理删除                                    */
/* ================================================================== */

function purgeRecycled() {
  const t = now();
  let n = 0;
  for (const f of all('files')) {
    if (!f.isDeleted) continue;
    if (f.deletedAt + RECYCLE_KEEP_MS > t) continue;
    removeBlob(f.userId, f.id);
    del('files', f.id);
    n++;
  }
  if (n) console.log('[netdisk] 回收站清理：物理删除 ' + n + ' 个文件');
  return n;
}

/* ================================================================== */
/* 静态文件                                                            */
/* ================================================================== */

const MIME_STATIC = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function serveStatic(req, res, pathname) {
  let rel = pathname;
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/s' || rel.indexOf('/s/') === 0) rel = '/share.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([.][.][/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
  const ext = path.extname(file).toLowerCase();
  const type = MIME_STATIC[ext] || 'application/octet-stream';
  const buf = fs.readFileSync(file);
  const gz = /^(text|application\/javascript|application\/json)/.test(type) && buf.length > 1024;
  const headers = { 'Content-Type': type, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' };
  if (gz && String(req.headers['accept-encoding'] || '').indexOf('gzip') >= 0) {
    headers['Content-Encoding'] = 'gzip';
    const z = zlib.gzipSync(buf);
    headers['Content-Length'] = z.length;
    res.writeHead(200, headers);
    return res.end(z);
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(200, headers);
  res.end(buf);
}

/* ================================================================== */
/* 服务器                                                              */
/* ================================================================== */

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || 'localhost';
  let url;
  try { url = new URL(req.url, 'http://' + host); }
  catch (e) { res.writeHead(400); return res.end('bad request'); }

  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Content-Length': 0 });
    return res.end();
  }

  if (pathname.indexOf('/api/') !== 0) return serveStatic(req, res, pathname);

  const m = match(req.method, pathname);
  if (!m) return sendJson(res, 404, { code: 40400, message: '接口不存在', data: null });

  req._url = url;
  req._params = m.params;
  const ctx = { url: url, params: m.params, user: null };

  try {
    if (m.auth) {
      const u = authUser(req, url);
      if (!u) return fail(res, CODE.AUTH_FAILED);
      // 分片上传会连续发几十个请求，不能按普通接口的 60/分钟 限流
      const isChunk = req.method === 'PUT' && pathname.indexOf('/upload/') > 0;
      if (!isChunk && !rateCheck(u.id)) return fail(res, CODE.RATE_LIMITED);
      ctx.user = u;
    }
    await m.handler(req, res, ctx);
  } catch (e) {
    console.error('[netdisk] ' + req.method + ' ' + pathname + ' 失败: ' + (e && e.message));
    if (!res.headersSent) sendJson(res, 500, { code: CODE.INTERNAL, message: MESSAGE_OF_CODE[CODE.INTERNAL], data: null });
    else res.end();
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.requestTimeout = 0;

loadStore();

server.listen(PORT, HOST, () => {
  console.log('[netdisk] 启动于 http://' + HOST + ':' + PORT);
  console.log('[netdisk] 数据目录: ' + DATA_DIR + ' | 配额: ' + Math.round(USER_QUOTA_BYTES / 1024 / 1024) + 'MB');
  console.log('[netdisk] 账号来源: ' + CHAT_API_BASE);
  purgeRecycled();
  setInterval(purgeRecycled, 60 * 60 * 1000).unref();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { flushStore(); } catch (e) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

process.on('uncaughtException', (e) => {
  console.error('[netdisk] uncaught:', e && e.message);
});
