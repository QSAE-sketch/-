'use strict';
/**
 * 云网盘核心层：配置 / 工具 / JWT / 文档存储 / 文件字节存储。
 * 零第三方依赖，只用 Node 内置模块；所有 IO 走流式，避免大文件吃满内存。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ================= 常量配置 ================= */
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const BLOBS_DIR = path.join(DATA_DIR, 'blobs');
const CHUNKS_DIR = path.join(DATA_DIR, 'chunks');

/** 每位用户总配额 2GB —— 防止超大文件耗尽应用有限且用完即止的资源点 */
const USER_QUOTA_BYTES = Number(process.env.USER_QUOTA_BYTES) || 2 * 1024 * 1024 * 1024;
/** 单文件上限默认 2GB，且不得超过用户配额 */
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE) || 2 * 1024 * 1024 * 1024;
const CHUNK_SIZE = 5 * 1024 * 1024;
const SMALL_UPLOAD_LIMIT = 100 * 1024 * 1024;

const ACCESS_TTL = 2 * 3600 * 1000;
const REFRESH_TTL = 7 * 24 * 3600 * 1000;
const SIGNED_URL_TTL = 15 * 60 * 1000;
const SHARE_DEFAULT_DAYS = 7;
const RATE_LIMIT = Number(process.env.RATE_LIMIT) || 60;
const RATE_WINDOW = Number(process.env.RATE_WINDOW_MS) || 60 * 1000;
const RECYCLE_KEEP_MS = 30 * 24 * 3600 * 1000;

const JWT_SECRET = process.env.JWT_SECRET || 'qingliao-netdisk-jwt-secret-2026';
const SERVICE_KEY = process.env.SERVICE_KEY || 'qingliao-netdisk-service-key';
/** 聊天网站地址：仅用于 /auth/login 的服务间身份校验 */
const CHAT_API_BASE = process.env.CHAT_API_BASE || 'https://qingliao-chat-33476.app.workbuddy.host';
/** 聊天站的分享码：发布后的网关要求每个请求都带，否则 403 */
const CHAT_SHARECODE = process.env.CHAT_SHARECODE || 'T7ELJZOC5A';
const ALLOW_ORIGINS = String(process.env.ALLOW_ORIGINS || '*').split(',').map(function (s) { return s.trim(); });

/** 文件类型白名单：按扩展名兜底 + MIME 前缀；可执行文件一律拒绝 */
const ALLOWED_EXT = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico',
  'mp4', 'webm', 'mov', 'm4v', '3gp', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'rtf',
  'zip', 'rar', '7z', 'gz', 'tar', 'json', 'xml', 'log', 'apk'
]);
const BLOCKED_EXT = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'js', 'vbs', 'ps1', 'sh', 'dll', 'sys']);

/** 统一错误码 */
const CODE = {
  OK: 0,
  AUTH_FAILED: 40001,
  FILE_TOO_LARGE: 40002,
  TYPE_NOT_ALLOWED: 40003,
  NO_SPACE: 40004,
  SHARE_EXPIRED: 40005,
  FILE_NOT_FOUND: 40006,
  RATE_LIMITED: 40007,
  BAD_REQUEST: 40008,
  INTERNAL: 50000
};
const HTTP_OF_CODE = {
  40001: 401, 40002: 413, 40003: 415, 40004: 409, 40005: 410,
  40006: 404, 40007: 429, 40008: 400, 50000: 500
};
const MESSAGE_OF_CODE = {
  0: 'ok', 40001: '认证失败或登录已过期', 40002: '文件过大',
  40003: '文件类型不在白名单内', 40004: '剩余配额不足，禁止上传与自动保存',
  40005: '分享已过期或提取码错误', 40006: '文件不存在',
  40007: '请求过于频繁，请稍后再试', 40008: '请求参数有误', 50000: '服务器内部错误'
};

/* ================= 通用工具 ================= */
function now() { return Date.now(); }
function randomId(prefix) { return String(prefix || 'id') + '_' + crypto.randomBytes(8).toString('hex'); }
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return Buffer.from(t, 'base64');
}
function md5Hex(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }
function sha256Hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 32).toString('hex');
}
function safeFileName(name) {
  const s = String(name || 'file').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 180);
  return s || 'file';
}
function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}
function mimeOf(name, fallback) {
  const ext = extOf(name);
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg',
    wav: 'audio/wav', m4a: 'audio/mp4', pdf: 'application/pdf', txt: 'text/plain',
    zip: 'application/zip', json: 'application/json', apk: 'application/vnd.android.package-archive'
  };
  return map[ext] || fallback || 'application/octet-stream';
}
function fileTypeGroup(mime, name) {
  const m = String(mime || '');
  if (m.indexOf('image/') === 0) return 'image';
  if (m.indexOf('video/') === 0) return 'video';
  if (m.indexOf('audio/') === 0) return 'audio';
  if (m.indexOf('pdf') >= 0 || /^(doc|docx|xls|xlsx|ppt|pptx|txt|md|csv|rtf)$/.test(extOf(name))) return 'document';
  if (/^(zip|rar|7z|gz|tar)$/.test(extOf(name))) return 'archive';
  return 'other';
}
function fmtSize(b) { return Number(b) || 0; }

/** 校验文件名与大小；返回错误码或 0 */
function validateFile(name, size) {
  if (size <= 0) return CODE.BAD_REQUEST;
  if (size > MAX_FILE_SIZE || size > USER_QUOTA_BYTES) return CODE.FILE_TOO_LARGE;
  const ext = extOf(name);
  if (BLOCKED_EXT.has(ext)) return CODE.TYPE_NOT_ALLOWED;
  if (ext && !ALLOWED_EXT.has(ext)) return CODE.TYPE_NOT_ALLOWED;
  return CODE.OK;
}

/* ================= JWT（HS256，零依赖手写） ================= */
function signJwt(payload, ttlMs) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = Object.assign({}, payload, { iat: now(), exp: now() + ttlMs });
  const head = b64url(JSON.stringify(header));
  const data = b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac('sha256', JWT_SECRET).update(head + '.' + data).digest());
  return head + '.' + data + '.' + sig;
}
function verifyJwt(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const expect = b64url(crypto.createHmac('sha256', JWT_SECRET).update(parts[0] + '.' + parts[1]).digest());
    if (expect !== parts[2]) return null;
    const body = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
    if (!body || !body.exp || body.exp < now()) return null;
    return body;
  } catch (e) { return null; }
}
function signTokens(user) {
  return {
    accessToken: signJwt({ sub: user.id, typ: 'access', name: user.username }, ACCESS_TTL),
    refreshToken: signJwt({ sub: user.id, typ: 'refresh', jti: randomId('jti') }, REFRESH_TTL),
    expiresIn: Math.floor(ACCESS_TTL / 1000),
    userId: user.id,
    nickname: user.nickname || user.username
  };
}
/** 签名 URL：绑定 fileId + 过期时间，15 分钟有效 */
function signUrl(fileId, accessToken) {
  const exp = now() + SIGNED_URL_TTL;
  const raw = fileId + '|' + exp + '|' + String(accessToken || '');
  const k = b64url(crypto.createHmac('sha256', JWT_SECRET).update(raw).digest()).slice(0, 24);
  return { k: k, exp: exp };
}
function checkUrl(fileId, k, exp) {
  if (!k || !exp || Number(exp) < now()) return false;
  const raw = fileId + '|' + exp + '|';
  const expect = b64url(crypto.createHmac('sha256', JWT_SECRET).update(raw).digest()).slice(0, 24);
  return expect === String(k);
}

/* ================= 文档存储（JSON，原子写） ================= */
const NAMESPACES = ['users', 'files', 'shares', 'uploads', 'logs', 'revoked'];
const mem = {};
let flushTimer = null;

function loadStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BLOBS_DIR, { recursive: true });
  fs.mkdirSync(CHUNKS_DIR, { recursive: true });
  for (const ns of NAMESPACES) {
    mem[ns] = new Map();
    const f = path.join(DATA_DIR, ns + '.json');
    try {
      if (fs.existsSync(f)) {
        const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
        for (const doc of arr) mem[ns].set(doc.id, doc);
      }
    } catch (e) { console.error('[netdisk] 读取 ' + ns + ' 失败: ' + e.message); }
  }
}
function flushStore() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  for (const ns of NAMESPACES) {
    const f = path.join(DATA_DIR, ns + '.json');
    const tmp = f + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(Array.from(mem[ns].values()), null, 0));
      fs.renameSync(tmp, f);
    } catch (e) { console.error('[netdisk] 写入 ' + ns + ' 失败: ' + e.message); }
  }
}
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushStore, 120);
}
function put(ns, doc) { mem[ns].set(doc.id, doc); scheduleFlush(); return doc; }
function get(ns, id) { return mem[ns].get(id) || null; }
function del(ns, id) { mem[ns].delete(id); scheduleFlush(); }
function all(ns) { return Array.from(mem[ns].values()); }
function findBy(ns, fn) { return all(ns).find(fn) || null; }

/* ================= 文件字节存储 ================= */
function blobPath(userId, fileId) { return path.join(BLOBS_DIR, String(userId), String(fileId) + '.bin'); }
function ensureUserDir(userId) {
  const d = path.join(BLOBS_DIR, String(userId));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
/** 流式写入普通上传的字节到临时文件，完成后重命名 */
function writeBlob(userId, fileId, req, limit) {
  return new Promise(function (resolve, reject) {
    ensureUserDir(userId);
    const target = blobPath(userId, fileId);
    const tmp = target + '.part';
    const ws = fs.createWriteStream(tmp);
    let size = 0;
    let aborted = false;
    req.on('data', function (c) {
      size += c.length;
      if (size > limit) {
        aborted = true;
        ws.destroy();
        req.destroy();
        reject(new Error('TOO_LARGE'));
        return;
      }
      ws.write(c);
    });
    req.on('end', function () {
      if (aborted) return;
      ws.end(function () {
        try { fs.renameSync(tmp, target); resolve(size); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', function (e) { aborted = true; ws.destroy(); reject(e); });
    ws.on('error', function (e) { aborted = true; reject(e); });
  });
}
/** 分片写入（每片独立文件，便于断点续传） */
function writeChunk(uploadId, index, req, limit) {
  return new Promise(function (resolve, reject) {
    const dir = path.join(CHUNKS_DIR, String(uploadId));
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, String(index) + '.part');
    const tmp = target + '.tmp';
    const ws = fs.createWriteStream(tmp);
    let size = 0, aborted = false;
    req.on('data', function (c) {
      size += c.length;
      if (size > limit) {
        aborted = true; ws.destroy(); req.destroy(); reject(new Error('TOO_LARGE')); return;
      }
      ws.write(c);
    });
    req.on('end', function () {
      if (aborted) return;
      ws.end(function () {
        try { fs.renameSync(tmp, target); resolve(size); } catch (e) { reject(e); }
      });
    });
    req.on('error', function (e) { aborted = true; ws.destroy(); reject(e); });
    ws.on('error', function (e) { aborted = true; reject(e); });
  });
}
function chunkIndexes(uploadId) {
  const dir = path.join(CHUNKS_DIR, String(uploadId));
  try {
    return fs.readdirSync(dir)
      .filter(function (f) { return /^\d+\.part$/.test(f); })
      .map(function (f) { return Number(f.replace('.part', '')); })
      .sort(function (a, b) { return a - b; });
  } catch (e) { return []; }
}
/** 合并分片：逐片流式 append，不把整文件读进内存 */
function mergeChunks(uploadId, userId, fileId, totalChunks) {
  return new Promise(function (resolve, reject) {
    ensureUserDir(userId);
    const target = blobPath(userId, fileId);
    const tmp = target + '.part';
    const ws = fs.createWriteStream(tmp);
    const dir = path.join(CHUNKS_DIR, String(uploadId));
    let i = 0, total = 0;
    function next() {
      if (i >= totalChunks) {
        ws.end(function () {
          try {
            fs.renameSync(tmp, target);
            fs.rmSync(dir, { recursive: true, force: true });
            resolve(total);
          } catch (e) { reject(e); }
        });
        return;
      }
      const src = path.join(dir, i + '.part');
      const rs = fs.createReadStream(src);
      rs.on('data', function (c) { total += c.length; ws.write(c); });
      rs.on('error', reject);
      rs.on('end', function () { i++; next(); });
    }
    next();
  });
}
function removeBlob(userId, fileId) {
  try { fs.rmSync(blobPath(userId, fileId), { force: true }); } catch (e) { }
}

/* ================= 配额 ================= */
/** 统计用户已用空间（不含软删除？软删除仍占空间，到期物理清理后释放） */
function usedBytes(userId) {
  let n = 0;
  for (const f of all('files')) if (f.userId === userId) n += fmtSize(f.fileSize);
  return n;
}
function remainingBytes(userId) { return Math.max(0, USER_QUOTA_BYTES - usedBytes(userId)); }
function storageInfo(userId) {
  const used = usedBytes(userId);
  let recycled = 0;
  for (const f of all('files')) if (f.userId === userId && f.isDeleted) recycled += fmtSize(f.fileSize);
  return {
    usedBytes: used,
    totalBytes: USER_QUOTA_BYTES,
    remainingBytes: Math.max(0, USER_QUOTA_BYTES - used),
    usedPercent: Math.round(used / USER_QUOTA_BYTES * 10000) / 100,
    fileCount: all('files').filter(function (f) { return f.userId === userId && !f.isDeleted; }).length,
    recycledBytes: recycled
  };
}
/** 上传前统一配额闸：剩余不足直接拦，防止耗尽资源点 */
function canStore(userId, size) {
  if (size > MAX_FILE_SIZE || size > USER_QUOTA_BYTES) return CODE.FILE_TOO_LARGE;
  if (remainingBytes(userId) < size) return CODE.NO_SPACE;
  return CODE.OK;
}

/* ================= 限流 ================= */
const rateBuckets = new Map();
function rateCheck(userId) {
  const t = now();
  let arr = rateBuckets.get(userId) || [];
  arr = arr.filter(function (x) { return t - x < RATE_WINDOW; });
  if (arr.length >= RATE_LIMIT) { rateBuckets.set(userId, arr); return false; }
  arr.push(t);
  rateBuckets.set(userId, arr);
  return true;
}

/* ================= 操作日志 ================= */
function opLog(userId, action, fileId, ip, result) {
  put('logs', {
    id: randomId('log'), userId: userId, action: action, fileId: fileId || '',
    timestamp: now(), ip: String(ip || ''), result: String(result || 'ok')
  });
}

module.exports = {
  ROOT, PORT, HOST, DATA_DIR, PUBLIC_DIR, BLOBS_DIR,
  USER_QUOTA_BYTES, MAX_FILE_SIZE, CHUNK_SIZE, SMALL_UPLOAD_LIMIT,
  ACCESS_TTL, REFRESH_TTL, SIGNED_URL_TTL, SHARE_DEFAULT_DAYS,
  RECYCLE_KEEP_MS, JWT_SECRET, SERVICE_KEY, CHAT_API_BASE, CHAT_SHARECODE, ALLOW_ORIGINS,
  CODE, HTTP_OF_CODE, MESSAGE_OF_CODE,
  now, randomId, b64url, md5Hex, sha256Hex, hashPassword, safeFileName,
  extOf, mimeOf, fileTypeGroup, fmtSize, validateFile,
  signJwt, verifyJwt, signTokens, signUrl, checkUrl,
  loadStore, flushStore, put, get, del, all, findBy,
  blobPath, ensureUserDir, writeBlob, writeChunk, chunkIndexes, mergeChunks, removeBlob,
  usedBytes, remainingBytes, storageInfo, canStore, rateCheck, opLog
};
