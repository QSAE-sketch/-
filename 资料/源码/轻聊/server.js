'use strict';
/**
 * 轻量在线聊天 + 文件传输 服务端
 * 零外部依赖（仅使用 Node 内置模块），单端口 HTTP，可直接部署。
 */

const http = require('http');
const https = require('https');
const { once } = require('events');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { URL } = require('url');

const { createStore } = require('./src/store');
const { CloudStore, PUBLIC_CONFIG } = require('./src/cloud');
const {
  createDb, ROLES, ROOM_PUBLIC, ROOM_GROUP, ROOM_DM,
  RECALL_WINDOW_MS, MAX_FILE_SIZE, MAX_ROOMS_PER_USER
} = require('./src/db');
const { FileStore } = require('./src/filestore');
const { LocalBlobStore, CloudBlobStore } = require('./src/blobstore');
const authcloud = require('./src/authcloud');
const perm = require('./src/perm');
const {
  randomId, hashPassword, verifyPassword, packSecret, unpackVerify, now, clampInt, safeFileName
} = require('./src/util');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VERSION_FILE = path.join(ROOT, 'version.json');
const CHANGELOG_FILE = path.join(__dirname, 'changelog.json');
const ANNOUNCEMENT_FILE = path.join(__dirname, 'announcement.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const CHUNK_SIZE = 4 * 1024 * 1024;          // 4MB/片，200MB → 50 片
const MAX_JSON_BODY = 1024 * 1024;            // 1MB，文本消息足够
const SESSION_TIMEOUT_MS = 30 * 24 * 3600 * 1000;

/**
 * 每位用户的存储配额（默认 2GB）。
 * 测试可用 USER_QUOTA_BYTES 调小，避免为了跑用例真的传几个 G。
 */
const USER_QUOTA_BYTES = Number(process.env.USER_QUOTA_BYTES) > 0
  ? Number(process.env.USER_QUOTA_BYTES)
  : 2 * 1024 * 1024 * 1024;

/** 解散后的保留期（默认 5 天），到期自动连数据一起彻底删除 */
const DISSOLVE_RETENTION_MS = Number(process.env.DISSOLVE_RETENTION_MS) > 0
  ? Number(process.env.DISSOLVE_RETENTION_MS)
  : 5 * 24 * 3600 * 1000;

/**
 * 云网盘：**内置于本站**，不是独立应用。
 *
 * 平台一个工作区只能挂一个线上应用，网盘单独发布会把聊天站覆盖掉，
 * 因此网盘改为本站的一个内置模块（/api/drive/*，路由见 src/drive.js）。
 * 好处不只是「省一个应用位」：
 *   · 网盘直接读 files 集合，聊天里发出的文件天生就在网盘里，无需二次转存；
 *   · 配额、云端持久化、分片断点续传与聊天共用同一套实现，不会出现两份账。
 */
const DRIVE_ENABLED = true;
// 对外站点地址：WorkBuddy OAuth 的回调必须指回这里
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || PUBLIC_CONFIG.endpoint;

/**
 * 存储后端选择：
 * - cloud（默认）：文档集合存 WorkBuddy 云数据库，进程重启/换机不丢数据
 * - local：退回本地 SQLite/JSON（可用 STORAGE_BACKEND=local 强制）
 * 云端不可用时自动降级到本地，保证服务始终可用（启动日志会明确告知当前后端）。
 */
const BACKEND = (process.env.STORAGE_BACKEND || 'cloud').toLowerCase();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const localStore = createStore(DATA_DIR);
let activeStore = localStore;
let cloudStore = null;

/**
 * 存储代理。
 *
 * db / files 在模块加载时就拿到了 store 的引用。若直接把 localStore 传进去，
 * 之后再把变量替换成云端实例并不会生效 —— db.js 用的是 createDb(store) 的参数
 * 闭包，早就锁定了原对象，结果就是「日志显示云端、实际仍写本地 SQLite」。
 *
 * 因此统一用代理转发到当前真实后端，后端切换或降级都能立即生效。
 */
const store = {
  get kind() { return activeStore.kind; },
  put(ns, id, doc, k1, k2) { return activeStore.put(ns, id, doc, k1, k2); },
  get(ns, id) { return activeStore.get(ns, id); },
  del(ns, id) { return activeStore.del(ns, id); },
  list(ns) { return activeStore.list(ns); },
  byIdx(ns, col, value) { return activeStore.byIdx(ns, col, value); },
  countByIdx(ns, col, value) { return activeStore.countByIdx(ns, col, value); },
  flush() { return activeStore.flush(); },
  close() { return activeStore.close(); }
};

/** 异步启动：优先连云数据库，失败则降级到本地后端 */
async function initStore() {
  if (BACKEND === 'local') {
    console.log('[chatapp] 存储后端: local (按 STORAGE_BACKEND=local 指定)');
    console.log('[chatapp] 文件字节: 本地磁盘');
    return;
  }
  try {
    const cs = new CloudStore(process.env.PUBLIC_ORIGIN || PUBLIC_CONFIG.endpoint);
    const rows = await cs.load();
    cloudStore = cs;
    activeStore = cs;
    console.log('[chatapp] 存储后端: workbuddy-cloud (已从云端加载 ' + rows + ' 条文档)');
    await initCloudBlobs(cs);
  } catch (e) {
    console.error('[chatapp] 云存储不可用，降级到本地后端: ' + (e && e.message ? e.message : e));
    activeStore = localStore;
    console.log('[chatapp] 文件字节: 本地磁盘（降级）');
  }
}

/**
 * 文件字节走云数据库（public.file_blobs 表）。
 *
 * 云端模式下，文件内容不再依赖实例本地磁盘 —— 实例换机/重启后，
 * 已上传的文件依然能从云端下载。
 *
 * 启动时做一次写读探测：表不存在或云端不可写时，退回本地磁盘，
 * 保证「发文件」这个功能不会因为云端异常而彻底不可用。
 */
async function initCloudBlobs(cs) {
  const probeId = '__probe__';
  try {
    const probe = new CloudBlobStore(cs.cloud, 'file_blobs', localBlobs);
    await probe.putChunk(probeId, 0, Buffer.from('probe'));
    await probe.settle(probeId);
    const idx = await probe.listIndexes(probeId);
    if (!idx.length) throw new Error('云端文件表写入后读不到');
    await probe.remove(probeId);
    files.setBlobStore(probe);
    console.log('[chatapp] 文件字节: workbuddy-cloud (public.file_blobs 表，本地磁盘作读缓存)');
  } catch (e) {
    console.error('[chatapp] 云端文件表不可用，文件字节退回本地磁盘: ' + (e && e.message ? e.message : e));
    files.setBlobStore(localBlobs);
  }
}

const db = createDb(store);
const localBlobs = new LocalBlobStore(UPLOAD_DIR);
const files = new FileStore(UPLOAD_DIR, db, localBlobs);

// 记录已通过密码校验的（token, roomId）
const roomPassCache = new Map();

/* ================================================================== */
/* 工具                                                                */
/* ================================================================== */

/**
 * JSON 响应出口。
 *
 * 云后端下写入是「内存先行 + 异步落云」。若在真正入库前就返回成功，
 * 进程一旦退出就会丢数据（接口说成功、实际没存上）。
 * 因此在写响应头/响应体之前等待一次 flush，让「返回成功」等价于「已持久化」。
 *
 * 门控只放在这里：静态文件（serveStatic）不写存储，不需要等待。
 * 同一响应只允许写一次，避免处理器报错后再补一个错误响应造成重复写。
 */
function json(res, code, obj) {
  if (res.__jsonPending) return;
  res.__jsonPending = true;
  const body = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  };
  Promise.resolve()
    .then(() => store.flush())
    .catch((e) => {
      console.error('[chatapp] 落盘失败: ' + (e && e.message ? e.message : e));
    })
    .then(() => {
      if (res.writableEnded || res.headersSent) return;
      res.writeHead(code, headers);
      res.end(body);
    });
}

function ok(res, obj) { json(res, 200, Object.assign({ ok: true }, obj || {})); }
function fail(res, code, msg) { json(res, code, { ok: false, error: msg }); }

function readJson(req) {
  return new Promise((resolve, reject) => {
    let len = 0;
    const chunks = [];
    req.on('data', (c) => {
      len += c.length;
      if (len > MAX_JSON_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function readBinary(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > limit) {
        reject(new Error('分片过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tokenOf(req, url) {
  const h = req.headers['x-token'] || req.headers['authorization'];
  if (h) return String(h).replace(/^Bearer\s+/i, '');
  if (url && url.searchParams.get('t')) return url.searchParams.get('t');
  return '';
}

function requireUser(req, url) {
  const token = tokenOf(req, url);
  if (!token) return null;
  const sess = db.getSession(token);
  if (!sess) return null;
  if (sess.expiresAt < now()) { db.dropSession(token); return null; }
  const user = db.getUser(sess.userId);
  if (!user) return null;
  // 永久权限账号：首次判定通过时把标记固化到账号上，之后改昵称也不会掉权限
  if (perm.latchFounder(user)) db.put('users', user);
  user._token = token;
  return user;
}

/**
 * 头像底色：与前端 public/app.js 的 colorOf() 用同一套算法，
 * 保证服务端下发的颜色与前端本地算出来的一致（不会出现两个色块）。
 */
function avatarColor(id) {
  const s = String(id || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffff;
  return 'hsl(' + (h % 360) + ',52%,52%)';
}

/**
 * 自定义头像地址：带 ?v= 时间戳做缓存戳，换头像后各端立即可见。
 * 没传过头像的用户返回空串，前端回落到「色块 + 首字」。
 */
function avatarUrl(u) {
  if (!u || !u.avatar) return '';
  return '/api/avatars/' + u.id + '?v=' + (u.avatarV || 0);
}

/** 头像图片签名 → 扩展名 / MIME；只收常见光栅图 */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { ext: 'gif', mime: 'image/gif' };
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

const AVATAR_MAX_BYTES = 512 * 1024;   // 原图上限 512KB（前端上传前会先压到 256px）

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    // 账号来源：password / email / otp / workbuddy
    authType: u.authType || 'password',
    email: u.email || '',
    createdAt: u.createdAt,
    // 头像：自定义头像优先，未设置时用色块底色 + 昵称首字
    avatar: avatarUrl(u),
    avatarColor: avatarColor(u.id),
    initial: String(u.nickname || u.username || '?').charAt(0).toUpperCase(),
    // 权限：永久权限账号 / 权限密钥 30 分钟窗口（前端据此显示入口与金色标识）
    founder: perm.isFounder(u),
    master: perm.isMaster(u),
    masterUntil: u.masterUntil || 0,
    masterRemainMs: perm.masterRemainMs(u)
  };
}

/**
 * 最高权限校验闸门：不满足时直接写 403 并返回 false。
 * 调用方一律 `if (!requireMaster(res, ctx.user)) return;`
 */
function requireMaster(res, user) {
  if (perm.isMaster(user)) return true;
  fail(res, 403, '需要最高权限：请在登录时或「我的」页输入权限密钥（使用后 30 分钟内有效）');
  return false;
}

/* ================================================================== */
/* 存储配额（每人 2GB）                                                */
/* ================================================================== */

function fmtSize(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024 * 1024) return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
  return v + ' B';
}

/**
 * 已用空间：只统计字节已经落盘（ready）的文件。
 * 上传中（uploading）不算，否则一次中断的上传会永久占住配额，
 * 而对应的分片文件本来就会被断点续传复用或后续清理。
 */
function userUsedBytes(userId) {
  let n = 0;
  for (const f of db.filesOfOwner(userId)) {
    if (!f || f.state !== 'ready') continue;
    n += Number(f.size) || 0;
  }
  return n;
}

function storageInfo(user) {
  const used = userUsedBytes(user.id);
  const quota = USER_QUOTA_BYTES;
  return {
    used,
    quota,
    remain: Math.max(0, quota - used),
    percent: quota > 0 ? Math.min(100, Math.round((used / quota) * 1000) / 10) : 100,
    usedText: fmtSize(used),
    quotaText: fmtSize(quota),
    remainText: fmtSize(Math.max(0, quota - used))
  };
}

function roomRole(roomId, userId) {
  const m = db.getMember(roomId, userId);
  return m ? m.role : null;
}

function roleInfo(key) {
  return ROLES[key] || ROLES.member;
}

/* ================================================================== */
/* 房间访问控制                                                        */
/* ================================================================== */

function canViewRoom(room, user, token) {
  // 私聊：仅双方成员可见。这是两人之间的对话，不是房间——任何其他人（含最高权限）
  // 都不能凭 id 围观，否则就是隐私泄露。必须放在最高权限放行之前。
  if (room.kind === ROOM_DM) return db.isMember(room.id, user.id);
  // 最高权限：可进入任意房间查看 / 清理内容（写入仍受房间规则限制）
  if (perm.isMaster(user)) return true;
  if (room.kind === ROOM_PUBLIC) return true;
  if (db.isMember(room.id, user.id)) return true;
  if (!room.passwordHash) return true;                   // 免密房间可直接进入
  const key = token + '|' + room.id;
  if (roomPassCache.has(key)) {
    const t = roomPassCache.get(key);
    if (t > now()) return true;
    roomPassCache.delete(key);
  }
  return false;
}

function canPostInRoom(room, user) {
  if (!roomActive(room)) return { allowed: false, reason: '房间已解散，仅可查看历史消息' };
  const member = db.getMember(room.id, user.id);
  if (room.kind === ROOM_PUBLIC) {
    return { allowed: true, member: member || db.addMember(room.id, user.id, 'member') };
  }
  if (!member) return { allowed: false, reason: '请先加入房间后再发送消息' };
  if (member.mutedUntil && member.mutedUntil > now()) {
    const mins = Math.ceil((member.mutedUntil - now()) / 60000);
    return { allowed: false, reason: '你已被禁言，剩余约 ' + mins + ' 分钟' };
  }
  return { allowed: true, member };
}

/* ================================================================== */
/* API 路由                                                            */
/* ================================================================== */

const routes = [];
function route(method, pattern, handler, auth) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:([A-Za-z_]+)/g, (m, k) => {
    keys.push(k);
    return '([^/]+)';
  }) + '$');
  routes.push({ method, rx, keys, handler, auth: auth !== false });
}

function matchRoute(method, pathname) {
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

/* ---------------- 账号 ---------------- */

/**
 * 四种登录 / 注册方式的共同收口：
 *
 *   账号+密码 —— 轻聊自有体系，直接查 users 表
 *   邮箱       —— 云服务邮箱密码（登录）/ 邮箱验证码（注册）
 *   验证码     —— 云服务发码 + 验码（邮箱或短信）
 *   WorkBuddy  —— 云服务 OAuth（PKCE），回调时按邮箱/云账号关联
 *
 * 云服务只负责「证明你是谁」；轻聊的 users 表负责「你是哪个账号、能看哪些房间」。
 * 因此不论从哪种方式进来，最终都会落到同一个轻聊账号上。
 */

/** 依据外部身份生成一个不冲突的登录名 */
function pickUsername(profile) {
  let base = profile.email || profile.phone || ('wb_' + String(profile.cloudId || '').slice(0, 12));
  base = String(base).trim() || 'user';
  if (!db.findUserByName(base)) return base;
  for (let i = 2; i < 100; i++) {
    const cand = base + '_' + i;
    if (!db.findUserByName(cand)) return cand;
  }
  return base + '_' + now();
}

/** 用云身份创建 / 关联轻聊账号 */
function linkCloudAccount(profile, mode, opts) {
  const o = opts || {};
  let user = null;
  if (profile.cloudId) user = db.findUserByCloudId(profile.cloudId);
  if (!user && profile.email) user = db.findUserByEmail(profile.email);
  if (!user && profile.phone) user = db.findUserByPhone(profile.phone);

  if (user) {
    // 已有账号：补齐后加入的身份字段
    let dirty = false;
    if (!user.cloudId && profile.cloudId) { user.cloudId = profile.cloudId; dirty = true; }
    if (!user.email && profile.email) { user.email = profile.email; dirty = true; }
    if (!user.phone && profile.phone) { user.phone = profile.phone; dirty = true; }
    if (dirty) db.put('users', user);
    return { user: user };
  }

  if (mode === 'login') {
    return { error: '该账号尚未注册，请先切换到「注册」' };
  }

  user = db.createUser(pickUsername(profile), '', profile.nickname || o.nickname || '', {
    authType: o.authType || 'cloud',
    email: profile.email || '',
    phone: profile.phone || '',
    cloudId: profile.cloudId || ''
  });
  // 注册时若用户填了密码，一并作为该账号的本地密码（哈希存储）
  if (o.password) {
    const { salt, hash } = hashPassword(o.password);
    user.salt = salt;
    user.passHash = hash;
    db.put('users', user);
  }
  return { user: user };
}

/**
 * 登录 / 注册时顺带输入的权限密钥。
 * 密钥错误不应阻断登录本身（否则打错一次就进不去），只回一个提示字段；
 * 密钥正确则立刻开启 30 分钟窗口。
 */
function applyPermKey(user, key) {
  const raw = String(key == null ? '' : key).trim();
  if (!raw) return null;
  if (!perm.keyMatches(raw)) return { granted: false, error: '权限密钥不正确' };
  const until = perm.grantMaster(user);
  db.put('users', user);
  return { granted: true, masterUntil: until, remainMs: perm.masterRemainMs(user) };
}

/** 登录 / 注册成功后的统一响应 */
function authOk(res, user, opts) {
  const o = opts || {};
  if (perm.latchFounder(user)) db.put('users', user);
  const sess = db.createSession(user.id);
  user.lastSeen = now();
  db.put('users', user);
  const out = { token: sess.id, user: publicUser(user) };
  const p = applyPermKey(user, o.permKey);
  if (p) {
    out.perm = p;
    // 权限生效后 user 的 master 字段可能刚变化，重新下发一份
    out.user = publicUser(user);
  }
  ok(res, out);
}

/** 激活 / 续期最高权限（登录后在「我的」页也能用，方便窗口过期后重新开启） */
route('POST', '/api/auth/perm', async (req, res, ctx) => {
  const b = await readJson(req);
  const p = applyPermKey(ctx.user, b.key);
  if (!p) return fail(res, 400, '请输入权限密钥');
  if (!p.granted) return fail(res, 400, p.error);
  ok(res, { perm: p, user: publicUser(ctx.user) });
});

route('POST', '/api/register', async (req, res, ctx) => {
  const b = await readJson(req);
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const nickname = String(b.nickname || '').trim();

  if (!/^[A-Za-z0-9_一-龥]{2,20}$/.test(username)) {
    return fail(res, 400, '账号需为 2-20 位中英文/数字/下划线');
  }
  if (password.length < 6) return fail(res, 400, '密码至少 6 位');
  if (db.findUserByName(username)) return fail(res, 409, '该账号已被注册');

  const { salt, hash } = hashPassword(password);
  const user = db.createUser(username, password, nickname || username, { authType: 'password' });
  user.salt = salt;
  user.passHash = hash;
  db.put('users', user);

  authOk(res, user, { permKey: b.permKey });
}, false);

route('POST', '/api/login', async (req, res, ctx) => {
  const b = await readJson(req);
  const user = db.findUserByName(String(b.username || '').trim());
  if (!user || !verifyPassword(String(b.password || ''), user.salt, user.passHash)) {
    return fail(res, 401, '账号或密码错误');
  }
  authOk(res, user, { permKey: b.permKey });
}, false);

/* ---------------- 方式二：邮箱（云服务邮箱密码） ---------------- */

route('POST', '/api/auth/email', async (req, res, ctx) => {
  const b = await readJson(req);
  const mode = b.mode === 'reg' ? 'reg' : 'login';
  const email = String(b.email || '').trim();
  const password = String(b.password || '');
  const nickname = String(b.nickname || '').trim();

  if (mode === 'reg') {
    // 注册必须先完成邮箱验证码验证（上游要求 verificationToken）
    if (!b.verificationId || !b.token) {
      return fail(res, 400, '请先获取并填写邮箱验证码');
    }
    const r = await authcloud.verifyOtp({
      channel: 'email', target: email, token: String(b.token || ''),
      verificationId: String(b.verificationId || ''), isExistingUser: !!b.isExistingUser,
      password: password, nickname: nickname
    });
    if (!r.ok) return fail(res, 400, r.error.message);
    if (password && password.length < 6) return fail(res, 400, '密码至少 6 位');
    const linked = linkCloudAccount(r.profile, mode, { authType: 'email', password: password, nickname: nickname });
    if (linked.error) return fail(res, 409, linked.error);
    return authOk(res, linked.user, { permKey: b.permKey });
  }

  // 登录：密码由云服务校验（轻聊本地也存了一份哈希，两边都对得上）
  const r = await authcloud.signInWithPassword(email, password);
  if (!r.ok) return fail(res, 401, r.error.message);
  const linked = linkCloudAccount(r.profile, mode, { authType: 'email' });
  if (linked.error) return fail(res, 409, linked.error);
  authOk(res, linked.user, { permKey: b.permKey });
}, false);

/* ---------------- 方式三：验证码（邮箱 / 短信） ---------------- */

/** 按输入内容判断验证码渠道：含 @ 走邮箱，否则按手机号处理 */
function guessChannel(target) {
  const t = String(target || '').trim();
  if (t.indexOf('@') > 0) return 'email';
  if (/^1\d{10}$/.test(t.replace(/\D/g, ''))) return 'sms';
  return 'email';
}

route('POST', '/api/auth/otp/send', async (req, res, ctx) => {
  const b = await readJson(req);
  const target = String(b.target || '').trim();
  const channel = guessChannel(target);
  const r = await authcloud.sendOtp(channel, target);
  if (!r.ok) return fail(res, 400, r.error.message);
  ok(res, {
    verificationId: r.verificationId,
    isExistingUser: r.isExistingUser,
    channel: channel,
    message: r.isExistingUser ? '验证码已发送，验证后即可登录' : '验证码已发送，验证后即可注册'
  });
}, false);

route('POST', '/api/auth/otp/verify', async (req, res, ctx) => {
  const b = await readJson(req);
  const mode = b.mode === 'reg' ? 'reg' : 'login';
  const target = String(b.target || '').trim();
  const channel = guessChannel(target);
  const password = String(b.password || '');

  if (mode === 'reg' && password && password.length < 6) return fail(res, 400, '密码至少 6 位');

  const r = await authcloud.verifyOtp({
    channel: channel, target: target, token: String(b.token || ''),
    verificationId: String(b.verificationId || ''), isExistingUser: !!b.isExistingUser,
    password: password, nickname: String(b.nickname || '').trim()
  });
  if (!r.ok) return fail(res, 400, r.error.message);

  const linked = linkCloudAccount(r.profile, mode, {
    authType: channel === 'sms' ? 'otp' : 'email',
    password: password,
    nickname: String(b.nickname || '').trim()
  });
  if (linked.error) return fail(res, 409, linked.error);
  authOk(res, linked.user, { permKey: b.permKey });
}, false);

/* ---------------- 方式四：WorkBuddy 账号（OAuth / PKCE） ---------------- */

route('GET', '/api/auth/wb/start', async (req, res, ctx) => {
  const redirect = new URL('/api/auth/wb/callback', PUBLIC_ORIGIN).toString();
  const r = await authcloud.startWorkBuddyOAuth(redirect);
  if (!r.ok) return fail(res, 400, r.error.message);
  ok(res, { url: r.url });
}, false);

route('GET', '/api/auth/wb/callback', async (req, res, ctx) => {
  const r = await authcloud.handleWorkBuddyCallback(ctx.url.search);
  if (!r.ok) {
    return fail(res, 400, r.error.message);
  }
  const linked = linkCloudAccount(r.profile, 'reg', { authType: 'workbuddy' });
  if (linked.error) return fail(res, 409, linked.error);
  const sess = db.createSession(linked.user.id);
  linked.user.lastSeen = now();
  db.put('users', linked.user);
  // 回到前端并带上本地会话令牌
  const back = new URL('/', PUBLIC_ORIGIN);
  back.searchParams.set('wl_token', sess.id);
  res.writeHead(302, { Location: back.toString() });
  res.end();
}, false);

route('POST', '/api/logout', async (req, res, ctx) => {
  if (ctx.user) db.dropSession(ctx.user._token);
  ok(res, {});
});

route('GET', '/api/me', async (req, res, ctx) => {
  ok(res, { user: publicUser(ctx.user), storage: storageInfo(ctx.user) });
});

/* ---------------- 同时在线（仅标准版使用） ---------------- */

/**
 * 心跳：前端定时调用，刷新当前用户 lastSeen。
 * 在线判定口径：最近 ONLINE_WINDOW_MS 内有过任何请求/心跳的用户 = 在线。
 */
const ONLINE_WINDOW_MS = 60 * 1000;
route('POST', '/api/pulse', async (req, res, ctx) => {
  ctx.user.lastSeen = now();
  db.put('users', ctx.user);
  ok(res, { serverTime: now() });
});

/**
 * 公共聊天室「同时在线」人数：最近 ONLINE_WINDOW_MS 内活跃、且是公共聊天室成员的用户。
 * 注意与 memberCount（累计加入过的成员总数）区分——那个数字只增不减，不是在线数。
 */
route('GET', '/api/online-count', async (req, res, ctx) => {
  const pub = db.publicRoom();
  const memberIds = {};
  for (const m of db.membersOf(pub.id)) memberIds[m.userId] = true;
  let count = 0;
  for (const u of db.list('users')) {
    if (!memberIds[u.id]) continue;
    if (u.id === ctx.user.id) { count++; continue; }     // 自己永远算在线
    if ((u.lastSeen || 0) >= now() - ONLINE_WINDOW_MS) count++;
  }
  ok(res, { online: count, windowMs: ONLINE_WINDOW_MS, serverTime: now() });
});


/* ---------------- 我的存储配额 ---------------- */

route('GET', '/api/me/storage', async (req, res, ctx) => {
  ok(res, storageInfo(ctx.user));
});

/* ---------------- 自定义头像（账号名 username 不可改） ---------------- */

/**
 * 上传头像：body.dataUrl = data:image/...;base64,xxx
 * 服务端校验图片签名后落盘 DATA_DIR/avatars/<userId>.<ext>，旧文件顺手清掉。
 */
route('POST', '/api/me/avatar', async (req, res, ctx) => {
  const b = await readJson(req);
  const dataUrl = String(b.dataUrl || '');
  const m = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(dataUrl);
  if (!m) return fail(res, 400, '请提交 data:image/...;base64 形式的图片');
  let buf;
  try {
    buf = Buffer.from(m[1], 'base64');
  } catch (_) {
    return fail(res, 400, '图片数据解析失败');
  }
  if (!buf.length) return fail(res, 400, '图片内容为空');
  if (buf.length > AVATAR_MAX_BYTES) {
    return fail(res, 413, '头像太大（上限 512KB），请先压缩或缩小图片');
  }
  const sig = sniffImage(buf);
  if (!sig) return fail(res, 400, '仅支持 PNG / JPEG / GIF / WebP 图片');

  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  // 先清掉这个用户旧的头像文件（扩展名可能不同），避免磁盘上越堆越多
  for (const ext of ['png', 'jpg', 'gif', 'webp']) {
    const old = path.join(AVATAR_DIR, ctx.user.id + '.' + ext);
    if (fs.existsSync(old)) {
      try { fs.unlinkSync(old); } catch (_) { /* 占用等竞态，忽略 */ }
    }
  }
  const file = path.join(AVATAR_DIR, ctx.user.id + '.' + sig.ext);
  fs.writeFileSync(file, buf);
  ctx.user.avatar = sig.ext;
  ctx.user.avatarMime = sig.mime;
  ctx.user.avatarV = now();
  db.put('users', ctx.user);
  ok(res, { user: publicUser(ctx.user) });
});

/* 恢复默认头像（色块 + 首字） */
route('DELETE', '/api/me/avatar', async (req, res, ctx) => {
  if (ctx.user.avatar) {
    const old = path.join(AVATAR_DIR, ctx.user.id + '.' + ctx.user.avatar);
    try { if (fs.existsSync(old)) fs.unlinkSync(old); } catch (_) { /* 忽略 */ }
  }
  delete ctx.user.avatar;
  delete ctx.user.avatarMime;
  ctx.user.avatarV = now();
  db.put('users', ctx.user);
  ok(res, { user: publicUser(ctx.user) });
});

/* 头像图片本体：公开读（头像本来就是给别人看的），带 v 时给长缓存 */
route('GET', '/api/avatars/:id', async (req, res, ctx) => {
  const u = db.getUser(ctx.params.id);
  if (!u || !u.avatar) return fail(res, 404, '头像不存在');
  const file = path.join(AVATAR_DIR, u.id + '.' + u.avatar);
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (_) {
    return fail(res, 404, '头像文件缺失');
  }
  const v = ctx.url.searchParams.get('v');
  res.writeHead(200, {
    'Content-Type': u.avatarMime || ('image/' + u.avatar),
    'Content-Length': buf.length,
    // 换头像会换 v 值，URL 变了缓存自然失效
    'Cache-Control': v ? 'public, max-age=31536000, immutable' : 'no-cache'
  });
  res.end(req.method === 'HEAD' ? undefined : buf);
}, false);

/* ---------------- 自定义昵称（账号名 username 不可改） ---------------- */

route('POST', '/api/me/nickname', async (req, res, ctx) => {
  const b = await readJson(req);
  const nickname = String(b.nickname || '').trim();
  if (!/^[A-Za-z0-9_一-龥]{2,20}$/.test(nickname)) {
    return fail(res, 400, '昵称需为 2-20 位中英文/数字/下划线');
  }
  ctx.user.nickname = nickname;
  db.put('users', ctx.user);
  ok(res, { user: publicUser(ctx.user) });
});

/* ---------------- 注销账号（不可逆硬删除） ---------------- */

route('POST', '/api/account/delete', async (req, res, ctx) => {
  const b = await readJson(req);
  if (b.confirm !== true) return fail(res, 400, '需要二次确认');
  const userId = ctx.user.id;
  const token = ctx.user._token;
  await purgeAccount(userId);
  db.dropSession(token);
  ok(res, { ok: true });
});

/**
 * 彻底清除账号：创建的内容与痕迹全部移除（不可逆）。
 * 房间按「遗产继承人 → 最早加入成员 → 解散」的继承规则处理。
 */
async function purgeAccount(userId) {
  const stats = { rooms: 0, dissolvedRooms: 0, messages: 0, files: 0 };
  // 1) 我创建的群：继承群主，或无人继承时解散
  const myRooms = db.byIdx('rooms', 'k2', userId).slice();
  for (const room of myRooms) {
    if (room.kind !== ROOM_GROUP) continue;
    if (room.dissolved) continue;           // 已解散的只读存档不再产生转让通知
    stats.rooms++;
    let heir = null;
    if (room.heirId) {
      const m = db.getMember(room.id, room.heirId);
      if (m) heir = room.heirId;
    }
    if (!heir) {
      const others = db.membersOf(room.id)
        .filter((m) => m.userId !== userId)
        .sort((a, b) => a.joinedAt - b.joinedAt);
      if (others.length) heir = others[0].userId;
    }
    if (heir) {
      // 昵称必须在移除成员/用户之前取快照，否则拿不到该房间的专属昵称
      const fromName = roomDisplayName(room.id, userId);
      const toName = roomDisplayName(room.id, heir);
      const byHeir = !!room.heirId && room.heirId === heir;
      db.updateMember(room.id, heir, { role: 'owner', appointedBy: null });
      db.removeMember(room.id, userId);
      room.ownerId = heir;          // rooms.k2=ownerId 索引必须同步换，否则新群主无权管理
      room.heirId = null;
      db.put('rooms', room);
      // 仅在该房间内发布一条系统通知，文案里的「某某」取本房间专属昵称
      postSystem(room.id, byHeir
        ? (fromName + '的群主权限已转让至固定继承人')
        : ('已继位给最早加入的' + toName));
    } else {
      // 无人继承：整群解散删除，房间内的消息一并清掉（计入统计）
      for (const m of db.messagesOf(room.id)) { db.deleteMessage(m.id); stats.messages++; }
      for (const m of db.membersOf(room.id)) db.removeMember(room.id, m.userId);
      db.del('rooms', room.id);
      stats.dissolvedRooms++;
    }
  }
  // 2) 我发布的消息（含他人房间里的）
  for (const msg of db.list('messages')) {
    if (msg.senderId === userId) { db.deleteMessage(msg.id); stats.messages++; }
  }
  // 3) 我上传的文件（物理删除 + 元数据）
  for (const f of db.filesOfOwner(userId)) {
    try { await files.removeBlob(f.id); } catch (e) { /* 已删或不存在 */ }
    db.del('files', f.id);
    stats.files++;
  }
  // 3.1) 网盘分享与自建目录（不随文件级联，必须单独清）
  for (const s of db.byIdx('shares', 'k1', userId)) db.del('shares', s.id);
  for (const d of db.byIdx('driveFolders', 'k1', userId)) db.del('driveFolders', d.id);
  // 4) 我的会话
  for (const s of db.byIdx('sessions', 'k2', userId)) db.del('sessions', s.id);
  // 5) 好友关系 + 好友申请
  for (const f of db.friendsOf(userId)) {
    db.removeFriend(userId, f.a === userId ? f.b : f.a);
  }
  for (const r of db.listFriendRequestsOf(userId)) db.del('friendReqs', r.id);
  // 6) 所有 membership（含加入他人房间的）
  for (const m of db.list('members')) {
    if (m.userId === userId) db.removeMember(m.roomId, userId);
  }
  // 7) 用户本身
  db.del('users', userId);
  return stats;
}

/* ---------------- 最高权限：管理接口 ---------------- */

/**
 * 注销指定用户（管理员操作，不可逆）。
 * 语义与「我自己注销账号」完全一致（复用 purgeAccount），
 * 因此该用户创建的群同样走继承规则，不会留下无人接管的孤儿群。
 */
route('POST', '/api/admin/users/:id/delete', async (req, res, ctx) => {
  if (!requireMaster(res, ctx.user)) return;
  const b = await readJson(req);
  if (b.confirm !== true) return fail(res, 400, '需要二次确认');
  const target = db.getUser(ctx.params.id);
  if (!target) return fail(res, 404, '用户不存在');
  if (target.id === ctx.user.id) {
    return fail(res, 400, '不能在这里注销自己，请使用「我的 → 注销账号」');
  }
  if (perm.isFounder(target)) {
    return fail(res, 403, '该账号为永久权限账号，不可注销');
  }
  const stats = await purgeAccount(target.id);
  ok(res, {
    deleted: true,
    user: { id: target.id, username: target.username, nickname: target.nickname },
    stats
  });
});

/**
 * 清空指定房间的全部消息（管理员操作，不可逆）。
 * 房间本身保留（公共大厅不能因为清空而消失），系统通知也一并清掉。
 */
route('POST', '/api/admin/rooms/:id/clear', async (req, res, ctx) => {
  if (!requireMaster(res, ctx.user)) return;
  const room = db.getRoom(ctx.params.id);
  if (!room) return fail(res, 404, '房间不存在');
  const b = await readJson(req);
  if (b.confirm !== true) return fail(res, 400, '需要二次确认');
  const all = db.messagesOf(room.id).slice();
  for (const m of all) {
    // 带文件的消息：字节也要一并释放，避免只清元数据留下孤儿分片
    if (m.fileId) {
      await files.removeBlob(m.fileId).catch(() => {});
      db.del('files', m.fileId);
    }
    db.deleteMessage(m.id);
  }
  ok(res, { cleared: all.length, roomId: room.id });
});

/* ---------------- 最高权限：概览 ---------------- */

route('GET', '/api/admin/overview', async (req, res, ctx) => {
  if (!requireMaster(res, ctx.user)) return;
  const users = db.list('users');
  const rooms = db.listRooms();
  ok(res, {
    userCount: users.length,
    roomCount: rooms.length,
    messageCount: db.list('messages').length,
    fileCount: db.list('files').length,
    founder: perm.isFounder(ctx.user),
    masterUntil: ctx.user.masterUntil || 0,
    remainMs: perm.masterRemainMs(ctx.user)
  });
});

/* ---------------- 线上版本信息 ---------------- */

/**
 * 读取项目根目录的 version.json（版本号的唯一来源）。
 * APK 是纯 WebView 壳，前端代码全在线上；设置页显示的是「当前连接的线上服务版本」，
 * 所以更新线上后，用户重开 App/刷新页面就能看到新版本，不会出现「看着是旧版、其实已是最新」。
 */
function readVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
    return {
      name: String(v.name || '0.0.0'),
      code: Number(v.code) || 0,
      releasedAt: String(v.releasedAt || ''),
      notes: Array.isArray(v.notes) ? v.notes.map(String) : []
    };
  } catch (e) {
    return { name: '0.0.0', code: 0, releasedAt: '', notes: [] };
  }
}

/** 版本更新历史（存一份在 changelog.json，默认不在界面显示，仅在「历史更新记录」里查看） */
function readChangelog() {
  try {
    const d = JSON.parse(fs.readFileSync(CHANGELOG_FILE, 'utf8'));
    return {
      app: String(d.app || '轻聊'),
      contact: String(d.contact || ''),
      releases: Array.isArray(d.releases) ? d.releases : []
    };
  } catch (e) {
    return { app: '轻聊', contact: '', releases: [] };
  }
}

/** 官方公告：存一份在 announcement.json，默认空 = 前端不显示；有内容才在公共页渲染 */
function readAnnouncement() {
  try {
    const d = JSON.parse(fs.readFileSync(ANNOUNCEMENT_FILE, 'utf8'));
    return {
      enabled: !!d.enabled,
      title: String(d.title || ''),
      content: String(d.content || '')
    };
  } catch (e) {
    return { enabled: false, title: '', content: '' };
  }
}

/**
 * 构建指纹：version.json + app.js + style.css 的内容一起算。
 * 只要部署过任何改动，这个值就变 —— 即使忘了手动改 version.json 的语义版本号，
 * 用户也能从构建号一眼看出「线上已经不是刚才那份代码了」。
 */
function buildId() {
  const h = crypto.createHash('sha1');
  // 用固定的相对标签，不用 path.relative()：Windows 会给出反斜杠、Linux 正斜杠，
  // 那样同一份代码在不同系统上会算出不同构建号。
  const files = [
    ['version.json', VERSION_FILE],
    ['public/app.js', path.join(PUBLIC_DIR, 'app.js')],
    ['public/style.css', path.join(PUBLIC_DIR, 'style.css')],
    ['public/app-basic.js', path.join(PUBLIC_DIR, 'app-basic.js')],
    ['public/style-basic.css', path.join(PUBLIC_DIR, 'style-basic.css')]
  ];
  for (const pair of files) {
    try { h.update(pair[0]); h.update(fs.readFileSync(pair[1])); }
    catch (e) { h.update(pair[0]); }
  }
  return h.digest('hex').slice(0, 10);
}

// 无需登录：设置页、登录页都能查询；不含任何用户数据
route('GET', '/api/version', async (req, res) => {
  const changelog = readChangelog();
  ok(res, {
    version: readVersion(),
    // 历史更新记录：只存一份、默认不显示；前端「历史更新记录」按钮点开才渲染
    changelog: changelog,
    contact: changelog.contact,
    announcement: readAnnouncement(),
    build: buildId(),
    serverTime: now(),
    // 内置云网盘（不再是独立应用，前端据此显示「网盘」入口）
    drive: { enabled: DRIVE_ENABLED },
    // 兼容字段：早期版本前端读的是独立网盘地址，现在恒为空
    netdiskUrl: '',
    storageQuota: USER_QUOTA_BYTES
  });
}, false);

route('GET', '/api/users', async (req, res, ctx) => {
  const q = String(ctx.url.searchParams.get('q') || '').trim().toLowerCase();
  if (!q) return ok(res, { users: [] });
  const all = db.list('users');
  const out = all
    .filter((u) => u.id !== ctx.user.id &&
      (u.usernameLower.includes(q) || String(u.nickname || '').toLowerCase().includes(q)))
    .slice(0, 30)
    .map((u) => {
      const o = publicUser(u);
      o.friend = db.areFriends(ctx.user.id, u.id);
      return o;
    });
  ok(res, { users: out });
});

/**
 * 单个用户的公开资料：申请加好友页面用它展示对方信息，
 * 同时给出「当前与 TA 的好友关系状态」，前端据此决定显示
 * 发消息 / 申请 / 待处理 / 已是好友 哪种操作。
 */
route('GET', '/api/users/:id', async (req, res, ctx) => {
  const u = db.getUser(ctx.params.id);
  if (!u) return fail(res, 404, '用户不存在');
  const info = publicUser(u);
  // 邮箱属于隐私信息，资料页只给账号 / 昵称 / 注册时间
  delete info.email;

  const pending = db.listFriendRequestsOf(ctx.user.id).find((r) => r.status === 'pending' &&
    ((r.fromId === ctx.user.id && r.toId === u.id) || (r.fromId === u.id && r.toId === ctx.user.id)));

  ok(res, {
    user: info,
    self: u.id === ctx.user.id,
    friend: db.areFriends(ctx.user.id, u.id),
    requested: !!(pending && pending.fromId === ctx.user.id),   // 我已经发出申请
    received: !!(pending && pending.toId === ctx.user.id),     // 对方已经发出申请
    pendingId: pending ? pending.id : ''
  });
});

/* ---------------- 房间 ---------------- */

/** 昵称校验：全局昵称与群/房间专属昵称共用同一套规则 */
const NICK_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$/;

/**
 * 某用户在「某个群/房间内」的显示名。
 * 专属昵称只存在 members.roomNickname 上，与 users.nickname（全局）互不同步：
 * 没设置 → 回退全局昵称；设置了 → 只在当前 roomId 生效，其它房间/全局都不变。
 */
function roomDisplayName(roomId, userId) {
  if (!userId) return '未知用户';
  const m = db.getMember(roomId, userId);
  if (m && m.roomNickname) return m.roomNickname;
  const u = db.getUser(userId);
  if (u) return u.nickname || u.username || '未知用户';
  return '已注销用户';
}

function roomActive(room) { return !room.dissolved; }

/** 所有写操作统一过这道闸：房间已解散就只留只读能力 */
function ensureActive(res, room) {
  if (!roomActive(room)) {
    fail(res, 410, '房间已解散，仅可查看历史消息');
    return false;
  }
  return true;
}

/**
 * 系统通知：只写在对应房间的消息流里（不进其它房间、不进任何全局列表）。
 * senderId 固定为 'system'，前端渲染成居中提示条，且不可撤回/彻底删除。
 */
function postSystem(roomId, content) {
  return db.createMessage(roomId, 'system', {
    kind: 'system',
    content: String(content || '').slice(0, 300)
  });
}

function roomBrief(room, userId, viewer) {
  const member = db.getMember(room.id, userId);
  const members = db.membersOf(room.id);
  const other = room.kind === ROOM_DM
    ? members.find((m) => m.userId !== userId)
    : null;
  const otherUser = other ? db.getUser(other.userId) : null;
  const master = perm.isMaster(viewer || db.getUser(userId));
  return {
    id: room.id,
    kind: room.kind,
    name: room.kind === ROOM_DM
      ? (otherUser ? otherUser.nickname || otherUser.username : '私聊')
      : room.name,
    hasPassword: !!room.passwordHash,
    memberCount: members.length,
    joined: !!member,
    role: member ? member.role : null,
    roleName: member ? roleInfo(member.role).name : null,
    muted: !!(member && member.mutedUntil && member.mutedUntil > now()),
    ownerId: room.ownerId,
    createdAt: room.createdAt,
    // 解散后房间保留为只读存档，所有端都能看到「已解散」并读到解散通知
    dissolved: !!room.dissolved,
    dissolvedAt: room.dissolvedAt || 0,
    dissolvedBy: room.dissolvedBy || null,
    // 保留到期时间：到期后后台任务会连消息/文件一起彻底删除
    retainUntil: roomRetainUntil(room),
    retentionDays: Math.round(DISSOLVE_RETENTION_MS / 86400000),
    // 当前账号能否解散：群主可解散自己的群；最高权限可解散任意群与公共大厅
    canDissolve: !room.dissolved && room.kind !== ROOM_DM &&
      (master || (room.kind === ROOM_GROUP && room.ownerId === userId)),
    // 公共大厅默认不可解散，仅最高权限可停用
    publicHall: room.kind === ROOM_PUBLIC
  };
}

route('GET', '/api/rooms', async (req, res, ctx) => {
  const pub = db.publicRoom();
  if (!db.isMember(pub.id, ctx.user.id)) db.addMember(pub.id, ctx.user.id, 'member');
  const all = db.listRooms();
  const mine = all.filter((r) => {
    // 私聊不是房间：不进入房间列表。私聊只通过好友页 /api/dm/:userId 进入，
    // 出现在房间列表里既不符合语义，也会误让人以为「房间=谁都能看到」。
    if (r.kind === ROOM_DM) return false;
    if (r.id === pub.id) return true;
    if (db.isMember(r.id, ctx.user.id)) return true;
    if (r.kind === ROOM_GROUP && r.ownerId === ctx.user.id) return true;
    return false;
  });
  const rooms = mine.map((r) => roomBrief(r, ctx.user.id, ctx.user));
  rooms.sort((a, b) => (a.kind === ROOM_PUBLIC ? -1 : b.kind === ROOM_PUBLIC ? 1 : b.createdAt - a.createdAt));
  ok(res, { rooms, publicRoomId: pub.id });
});

/**
 * 按房间名搜索（标准版 / 桌面端的「搜索房间」）：
 * 大小写不敏感子串匹配，排除私聊与已解散房间；
 * 未加入的房间也能搜到 —— 结果卡片提供「进去看看 / 加入该房间」。
 */
route('GET', '/api/rooms/search', async (req, res, ctx) => {
  const q = String(ctx.url.searchParams.get('q') || '').trim();
  if (!q) return fail(res, 400, '请输入搜索关键词');
  if (q.length > 40) return fail(res, 400, '关键词过长（最多 40 字）');
  const lower = q.toLowerCase();
  const results = [];
  for (const r of db.listRooms()) {
    if (r.kind === ROOM_DM) continue;       // 私聊不可搜索
    if (r.dissolved) continue;              // 已解散仅存档，不进搜索
    const name = String(r.name || '');
    if (name.toLowerCase().indexOf(lower) < 0) continue;
    const owner = r.ownerId ? db.getUser(r.ownerId) : null;
    results.push({
      id: r.id,
      kind: r.kind,
      name,
      hasPassword: !!r.passwordHash,
      memberCount: db.membersOf(r.id).length,
      joined: db.isMember(r.id, ctx.user.id),
      ownerId: r.ownerId || null,
      ownerName: owner ? (owner.nickname || owner.username) : '',
      createdAt: r.createdAt
    });
  }
  // 人多的在前，其次新房间在前
  results.sort((a, b) => b.memberCount - a.memberCount || b.createdAt - a.createdAt);
  ok(res, { results, keyword: q });
});

route('POST', '/api/rooms', async (req, res, ctx) => {
  const b = await readJson(req);
  const name = String(b.name || '').trim();
  if (!name) return fail(res, 400, '房间名不能为空');
  if (name.length > 40) return fail(res, 400, '房间名过长');
  const created = db.listGroupRoomsOf(ctx.user.id).length;
  if (created >= MAX_ROOMS_PER_USER) {
    return fail(res, 400, '最多只能创建 ' + MAX_ROOMS_PER_USER + ' 个房间');
  }
  const pwd = String(b.password || '');
  let passwordHash = null;
  if (pwd) {
    if (pwd.length < 4) return fail(res, 400, '房间密码至少 4 位');
    passwordHash = packSecret(pwd);
  }
  const room = db.createRoom(ROOM_GROUP, name, ctx.user.id, passwordHash);
  db.addMember(room.id, ctx.user.id, 'owner');
  ok(res, { room: roomBrief(room, ctx.user.id, ctx.user) });
});

route('POST', '/api/rooms/:id/verify', async (req, res, ctx) => {
  const room = db.getRoom(ctx.params.id);
  if (!room) return fail(res, 404, '房间不存在');
  if (!room.passwordHash) return ok(res, { verified: true });
  const b = await readJson(req);
  if (!unpackVerify(String(b.password || ''), room.passwordHash)) {
    return fail(res, 401, '房间密码错误');
  }
  roomPassCache.set(ctx.user._token + '|' + room.id, now() + SESSION_TIMEOUT_MS);
  ok(res, { verified: true });
});

route('POST', '/api/rooms/:id/join', async (req, res, ctx) => {
  const room = db.getRoom(ctx.params.id);
  if (!room) return fail(res, 404, '房间不存在');
  if (room.kind === ROOM_DM) return fail(res, 400, '私聊房间无需加入');
  if (room.passwordHash) {
    const b = await readJson(req);
    if (!unpackVerify(String(b.password || ''), room.passwordHash)) {
      return fail(res, 401, '房间密码错误');
    }
    roomPassCache.set(ctx.user._token + '|' + room.id, now() + SESSION_TIMEOUT_MS);
  }
  if (!db.isMember(room.id, ctx.user.id)) {
    db.addMember(room.id, ctx.user.id, 'member');
  }
  ok(res, { room: roomBrief(room, ctx.user.id, ctx.user) });
});

route('POST', '/api/rooms/:id/leave', async (req, res, ctx) => {
  const room = db.getRoom(ctx.params.id);
  if (!room) return fail(res, 404, '房间不存在');
  const member = db.getMember(room.id, ctx.user.id);
  if (member && member.role === 'owner') return fail(res, 400, '群主不能退出自己创建的房间');
  db.removeMember(room.id, ctx.user.id);
  ok(res, {});
});

route('GET', '/api/rooms/:id/members', async (req, res, ctx) => {
  const room = db.getRoom(ctx.params.id);
  if (!room) return fail(res, 404, '房间不存在');
  if (!canViewRoom(room, ctx.user, ctx.user._token)) return fail(res, 403, '需要房间密码');
  const members = db.membersOf(room.id).map((m) => {
    const u = db.getUser(m.userId);
    return {
      userId: m.userId,
      username: u ? u.username : '未知',
      nickname: u ? u.nickname : '未知',
      // 群/房间专属昵称：仅本房间生效。空串表示未设置（此时显示全局昵称）
      roomNickname: m.roomNickname || '',
      displayName: roomDisplayName(room.id, m.userId),
      role: m.role,
      roleName: roleInfo(m.role).name,
      mutedUntil: m.mutedUntil || 0,
      joinedAt: m.joinedAt,
      // 头像：自定义头像优先，回落色块 + 首字（与 publicUser 同一套）
      avatar: avatarUrl(u),
      avatarColor: avatarColor(m.userId),
      initial: roomDisplayName(room.id, m.userId).charAt(0).toUpperCase(),
      // 永久权限账号：成员面板也可据此加金色标识（低配版忽略）
      founder: perm.isFounder(u)
    };
  });
  members.sort((a, b) => roleInfo(b.role).rank - roleInfo(a.role).rank || a.joinedAt - b.joinedAt);
  const me = db.getMember(room.id, ctx.user.id);
  ok(res, {
    members,
    myRole: me ? me.role : null,
    canManage: !!me && roleInfo(me.role).rank >= 1,
    heirId: room.heirId || null,
    myRoomNickname: me && me.roomNickname ? me.roomNickname : '',
    dissolved: !!room.dissolved,
    // 解散能力：最高权限可解散任意房间（含公共大厅）；群主可解散自己的群
    canDissolve: !room.dissolved && room.kind !== ROOM_DM &&
      (perm.isMaster(ctx.user) || (room.kind === ROOM_GROUP && room.ownerId === ctx.user.id)),
    publicHall: room.kind === ROOM_PUBLIC,
    roomName: room.kind === ROOM_PUBLIC ? room.name : room.name,
    master: perm.isMaster(ctx.user)
  });
});

route('GET', '/api/rooms/:id/messages', async (req, res, ctx) => {
  const room = db.getRoom(ctx.params.id);
  if (!room) return fail(res, 404, '房间不存在');
  if (!canViewRoom(room, ctx.user, ctx.user._token)) return fail(res, 403, '需要输入房间密码');
  const since = Number(ctx.url.searchParams.get('since') || 0);
  const limit = clampInt(ctx.url.searchParams.get('limit'), 1, 200, 60);

  const all = db.messagesOf(room.id);
  const hidden = db.hiddenSet(ctx.user.id);
  const member = db.getMember(room.id, ctx.user.id);
  const canPost = roomActive(room) && (room.kind === ROOM_PUBLIC
    ? true
    : !!(member && !(member.mutedUntil && member.mutedUntil > now())));

  // 增量拉取：以 rev（全局修订号）为水位，撤回等修改也能被其他端拉到
  let msgs = all.filter((m) => (m.rev || m.seq) > since);
  // 被「直接删除」的消息：不返回任何正文，只把 id 下发，各端据此清掉本机副本
  // （必须在条数裁剪之前收集，否则连续消息过多时会漏掉删除通知）
  const purgedIds = [];
  msgs.forEach((m) => { if (m.purged) purgedIds.push(m.id); });
  if (msgs.length > limit) msgs = msgs.slice(msgs.length - limit);
  msgs = msgs.filter((m) => !hidden.has(m.id));
  msgs = msgs.filter((m) => !m.purged);

  const visible = all.filter((m) => !m.purged);

  const out = msgs.map((m) => decorateMessage(m, ctx.user, room));
  let lastSeq = since;
  all.forEach((m) => { const r = m.rev || m.seq; if (r > lastSeq) lastSeq = r; });
  ok(res, {
    messages: out,
    purgedIds,
    lastSeq,
    total: visible.length,
    canPost,
    muted: !!(member && member.mutedUntil && member.mutedUntil > now()),
    joined: !!member,
    kind: room.kind,
    role: member ? member.role : null,
    roleName: member ? roleInfo(member.role).name : null,
    dissolved: !!room.dissolved
  });
});

function decorateMessage(m, viewer, room) {
  const viewerId = viewer ? viewer.id : null;
  const viewerMaster = perm.isMaster(viewer);
  const isSystem = m.kind === 'system';
  const sender = isSystem ? null : db.getUser(m.senderId);
  const out = {
    id: m.id,
    roomId: m.roomId,
    kind: m.kind,
    content: m.content,
    fileId: m.fileId,
    recalled: !!m.recalled,
    createdAt: m.createdAt,
    seq: m.seq,
    rev: m.rev || m.seq,
    senderId: m.senderId,
    // 普通消息显示「该房间内的专属昵称」（没设则用全局昵称）
    senderName: isSystem ? '系统通知' : roomDisplayName(m.roomId, m.senderId),
    senderUsername: sender ? sender.username : '',
    // 永久权限账号：标准版据此渲染金色烫金名字框 + 珍贵头像框（低配版忽略该字段）
    senderFounder: !!sender && perm.isFounder(sender),
    // 发送者自定义头像（空串 = 用色块首字）
    senderAvatar: avatarUrl(sender),
    mine: !isSystem && m.senderId === viewerId,
    // 撤回：有 2 分钟窗口，超窗后前端仍展示入口并给出提示（不再直接消失）
    canRecall: !isSystem && m.senderId === viewerId && !m.recalled && (now() - m.createdAt) <= RECALL_WINDOW_MS,
    // 直接删除：本人无时限；最高权限可删任意内容
    canPurge: !isSystem && !m.recalled && (m.senderId === viewerId || viewerMaster),
    purged: !!m.purged,
    file: null
  };
  if (m.fileId) {
    const f = db.getFile(m.fileId);
    if (f) {
      out.file = {
        id: f.id,
        name: f.name,
        size: f.size,
        mime: f.mime,
        state: f.state,
        url: '/api/files/' + f.id + '/raw?k=' + encodeURIComponent(f.accessToken),
        // 强制 attachment 的下载入口（浏览器/客户端存盘用）
        dlUrl: '/api/files/' + f.id + '/download?k=' + encodeURIComponent(f.accessToken),
        isImage: /^image\//i.test(f.mime),
        isVideo: /^video\//i.test(f.mime),
        // 已移入网盘回收站：聊天里仍保留这条消息，但不再提供预览与下载
        deleted: !!f.deletedAt
      };
    }
  }
  return out;
}

/* ================================================================== */

/* ---------------- 发消息 ---------------- */

route('POST', '/api/rooms/:id/messages', async (req, res, ctx) => {
  const room = db.getRoom(ctx.params.id);
  if (!room) return fail(res, 404, '房间不存在');
  const check = canPostInRoom(room, ctx.user);
  if (!check.allowed) return fail(res, 403, check.reason);

  const b = await readJson(req);
  const kind = b.kind === 'file' ? 'file' : 'text';
  let content = String(b.content || '').slice(0, 4000);
  let fileId = null;

  if (kind === 'file') {
    fileId = String(b.fileId || '');
    const f = db.getFile(fileId);
    if (!f) return fail(res, 400, '文件不存在');
    if (f.ownerId !== ctx.user.id) return fail(res, 403, '不能发送他人文件');
    if (f.state !== 'ready') return fail(res, 400, '文件尚未上传完成');
    if (!f.roomId) { f.roomId = room.id; db.updateFile(f); }
    content = '';
  } else {
    if (!content.trim()) return fail(res, 400, '内容不能为空');
  }

  const msg = db.createMessage(room.id, ctx.user.id, { kind, content, fileId });
  ok(res, { message: decorateMessage(msg, ctx.user, room) });
});

/* ---------------- 删除 / 撤回 ---------------- */

/**
 * 「直接删除」的真正执行体（单条 / 批量共用）。
 *
 * 步骤：
 *   1) 文件字节彻底删除（云端分片 / 本地磁盘）
 *   2) 消息正文清空，保留空壳（purged=true）用于跨端同步
 *   3) 清掉所有人对这条消息 / 这个文件的隐藏记录，避免留下脏数据
 */
async function purgeMessage(m) {
  // 1) 先把文件字节彻底删掉（云端分片 / 本地磁盘）
  const fileId = m.fileId;
  if (fileId) {
    const f = db.getFile(fileId);
    if (f) {
      await files.removeBlob(f.id).catch((e) => {
        console.error('[chatapp] 直接删除：文件字节删除失败: ' + (e && e.message ? e.message : e));
      });
      db.del('files', f.id);
    }
  }

  // 2) 清空消息正文，保留空壳用于跨端同步
  m.content = '';
  m.fileId = null;
  m.purged = true;
  m.recalled = false;
  m.rev = db.bumpRev();     // 推进修订号，其它端增量拉取时能同步到「已被删除」
  db.updateMessage(m);

  // 3) 清掉所有人对这条消息 / 这个文件的隐藏记录，避免留下脏数据
  for (const h of db.list('hidden')) {
    if (h.targetId === m.id || (fileId && h.targetId === fileId)) {
      db.del('hidden', h.id);
    }
  }
}

/** 单条「删除」的执行体：仅对当前账号隐藏，服务器端数据原样保留 */
function hideMessage(m, userId) {
  db.hide(userId, m.id, 'message');
  if (m.fileId) db.hide(userId, m.fileId, 'file');
}

route('POST', '/api/messages/:id/delete', async (req, res, ctx) => {
  const m = db.getMessage(ctx.params.id);
  if (!m) return fail(res, 404, '消息不存在');
  const room = db.getRoom(m.roomId);
  if (!room) return fail(res, 404, '消息不存在');
  if (!canViewRoom(room, ctx.user, ctx.user._token)) return fail(res, 403, '无权操作');
  // 仅对当前账号隐藏并保留隐藏状态
  hideMessage(m, ctx.user.id);
  ok(res, { hidden: true });
});

/**
 * 批量「删除」（多选模式用）：仅对本账号隐藏，服务端数据不动。
 *
 * 与单条 /delete 完全同语义，只是一次处理多条。
 * 逐条独立判定，某条失败（不存在 / 无权）不影响其它条目。
 */
route('POST', '/api/messages/batch-delete', async (req, res, ctx) => {
  const b = await readJson(req);
  const ids = Array.isArray(b.ids) ? b.ids.map(String).filter(Boolean) : [];
  if (!ids.length) return fail(res, 400, '未选择任何消息');
  if (ids.length > 200) return fail(res, 400, '一次最多选择 200 条');

  const hidden = [];
  const failed = [];
  for (const id of ids) {
    const m = db.getMessage(id);
    if (!m) { failed.push({ id, reason: '消息不存在' }); continue; }
    const room = db.getRoom(m.roomId);
    if (!room) { failed.push({ id, reason: '消息不存在' }); continue; }
    if (!canViewRoom(room, ctx.user, ctx.user._token)) {
      failed.push({ id, reason: '无权操作' });
      continue;
    }
    hideMessage(m, ctx.user.id);
    hidden.push(id);
  }
  ok(res, { hidden, failed, count: hidden.length });
});

/**
 * 批量「直接删除」（多选模式用）：服务器端真正清除，所有设备同步消失。
 *
 * 与单条 /purge 同语义：只有发送者本人能清除，无时限。
 * 撤回过的消息不需要再删（正文早已清空），跳过即可。
 */
route('POST', '/api/messages/batch-purge', async (req, res, ctx) => {
  const b = await readJson(req);
  const ids = Array.isArray(b.ids) ? b.ids.map(String).filter(Boolean) : [];
  if (!ids.length) return fail(res, 400, '未选择任何消息');
  if (ids.length > 200) return fail(res, 400, '一次最多选择 200 条');

  const purged = [];
  const failed = [];
  const master = perm.isMaster(ctx.user);
  for (const id of ids) {
    const m = db.getMessage(id);
    if (!m) { failed.push({ id, reason: '消息不存在' }); continue; }
    const room = db.getRoom(m.roomId);
    if (!room) { failed.push({ id, reason: '消息不存在' }); continue; }
    if (!master && !canViewRoom(room, ctx.user, ctx.user._token)) {
      failed.push({ id, reason: '无权操作' });
      continue;
    }
    if (m.senderId !== ctx.user.id && !master) {
      failed.push({ id, reason: '只能直接删除自己发送的消息' });
      continue;
    }
    if (m.recalled) { failed.push({ id, reason: '消息已撤回，无需再删除' }); continue; }
    if (m.purged) { failed.push({ id, reason: '消息已被删除' }); continue; }
    await purgeMessage(m);
    purged.push(id);
  }
  ok(res, { purged, failed, count: purged.length });
});

route('POST', '/api/messages/:id/recall', async (req, res, ctx) => {
  const m = db.getMessage(ctx.params.id);
  if (!m) return fail(res, 404, '消息不存在');
  if (m.senderId !== ctx.user.id) return fail(res, 403, '只能撤回自己发送的消息');
  if (m.recalled) return fail(res, 400, '消息已撤回');
  if (now() - m.createdAt > RECALL_WINDOW_MS) {
    return fail(res, 400, '已超过 2 分钟撤回窗口，如需彻底清除请使用「直接删除」');
  }
  // 服务端彻底移除内容与文件
  if (m.fileId) {
    const f = db.getFile(m.fileId);
    if (f) {
      // 必须等字节真正删掉再返回，否则「撤回后立刻访问」还能拿到旧文件
      await files.removeBlob(f.id).catch((e) => {
        console.error('[chatapp] 删除文件字节失败: ' + (e && e.message ? e.message : e));
      });
      f.state = 'deleted';
      db.updateFile(f);
    }
  }
  m.content = '';
  m.fileId = null;
  m.recalled = true;
  m.rev = db.bumpRev();     // 推进修订号，其他端增量拉取时能同步到撤回状态
  db.updateMessage(m);
  ok(res, { recalled: true });
});

/**
 * 直接删除：无时间窗口限制，发送者可彻底删除自己发出的消息。
 *
 * 与「删除」的区别：
 *   删除   = 仅对当前账号隐藏，服务器端数据与文件字节原样保留，他人照常可见。
 *   直接删除 = 服务器端真正移除：消息正文清空、文件字节彻底删除、所有人的隐藏记录一并清除，
 *            所有设备（含其它端正在显示的副本）都会同步消失。
 *
 * 实现上保留一条「不含任何正文」的空壳消息（purged=true），仅用于让其它端在增量拉取时
 * 感知到「这条已被彻底删除」并把本机副本清掉；壳里没有内容、没有文件名、没有文件字节。
 */
route('POST', '/api/messages/:id/purge', async (req, res, ctx) => {
  const m = db.getMessage(ctx.params.id);
  if (!m) return fail(res, 404, '消息不存在');
  const room = db.getRoom(m.roomId);
  if (!room) return fail(res, 404, '消息不存在');
  // 最高权限可以删除任意内容（含他人发送的消息、自己进不去的房间）
  const master = perm.isMaster(ctx.user);
  if (!master && !canViewRoom(room, ctx.user, ctx.user._token)) return fail(res, 403, '无权操作');
  if (m.senderId !== ctx.user.id && !master) return fail(res, 403, '只能直接删除自己发送的消息');
  if (m.recalled) return fail(res, 400, '消息已撤回，无需再删除');
  if (m.purged) return fail(res, 400, '消息已被删除');

  await purgeMessage(m);

  ok(res, { purged: true, byMaster: master });
});

/* ---------------- 文件 ---------------- */

route('POST', '/api/files/init', async (req, res, ctx) => {
  const b = await readJson(req);
  const size = Number(b.size) || 0;
  if (size <= 0) return fail(res, 400, '文件为空');
  if (size > MAX_FILE_SIZE) return fail(res, 400, '文件超过 200MB 上限');
  // 配额闸门：剩余空间不够就直接拒，连分片都不让开始传
  const st = storageInfo(ctx.user);
  if (size > st.remain) {
    return fail(res, 403, '存储空间不足：剩余 ' + st.remainText + '，本次需要 ' + fmtSize(size));
  }
  const name = safeFileName(b.name || 'file');
  const mime = String(b.mime || 'application/octet-stream');
  const targetRoom = db.getRoom(String(b.roomId || ''));
  if (targetRoom && !roomActive(targetRoom)) return fail(res, 410, '房间已解散，仅可查看历史消息');
  const r = await files.init(ctx.user.id, String(b.roomId || ''), name, size, mime, CHUNK_SIZE, b.resumeId);
  ok(res, {
    fileId: r.file.id,
    chunkSize: r.file.chunkSize,
    totalChunks: Math.max(1, Math.ceil(r.file.size / r.file.chunkSize)),
    received: r.file.received.slice(),
    resumed: r.resumed
  });
});

route('GET', '/api/files/:id/status', async (req, res, ctx) => {
  const f = db.getFile(ctx.params.id);
  if (!f || f.ownerId !== ctx.user.id) return fail(res, 404, '文件不存在');
  ok(res, files.status(f.id));
});

route('PUT', '/api/files/:id/chunk', async (req, res, ctx) => {
  const f = db.getFile(ctx.params.id);
  if (!f || f.ownerId !== ctx.user.id) return fail(res, 404, '文件不存在');
  const index = clampInt(ctx.url.searchParams.get('i'), 0, 100000, -1);
  if (index < 0) return fail(res, 400, '缺少分片序号');
  const buf = await readBinary(req, f.chunkSize + 1024 * 64);
  const n = await files.writeChunk(f.id, index, buf);
  ok(res, { receivedCount: n, index });
});

route('POST', '/api/files/:id/complete', async (req, res, ctx) => {
  const f = db.getFile(ctx.params.id);
  if (!f || f.ownerId !== ctx.user.id) return fail(res, 404, '文件不存在');
  try {
    const done = await files.complete(f.id);
    // 并发上传 / 中途配额被占满的兜底：落盘后再核一次，超了就撤销这次上传
    const st = storageInfo(ctx.user);
    if (st.used > st.quota) {
      await files.removeBlob(done.id).catch(() => {});
      done.state = 'deleted';
      db.updateFile(done);
      return fail(res, 403, '存储空间不足（配额 ' + st.quotaText + '），本次上传已取消');
    }
    // 文件入网盘是天然行为：网盘直接读 files 集合，这里不需要任何转存动作

    ok(res, {
      fileId: done.id, name: done.name, size: done.size, mime: done.mime,
      storage: st
    });
  } catch (e) {
    fail(res, 400, e.message || '合并失败');
  }
});

route('DELETE', '/api/files/:id', async (req, res, ctx) => {
  const f = db.getFile(ctx.params.id);
  if (!f) return fail(res, 404, '文件不存在');
  // 最高权限：任意文件物理删除（含别人上传的），字节与元数据一起清掉
  if (f.ownerId !== ctx.user.id && perm.isMaster(ctx.user)) {
    await files.removeBlob(f.id).catch((e) => {
      console.error('[chatapp] 最高权限删除文件字节失败: ' + (e && e.message ? e.message : e));
    });
    db.del('files', f.id);
    return ok(res, { deleted: true, byMaster: true });
  }
  // 普通用户：仅对当前账号隐藏并保留隐藏状态
  db.hide(ctx.user.id, f.id, 'file');
  ok(res, { hidden: true });
});

/**
 * 文件访问校验（/raw 与 /download 共用，保证两条路径权限完全一致）。
 * 独立访问令牌 ?k=（供 <img>/<video> 直连）或登录态均可访问。
 * @returns {boolean} 是否放行（不放行时已写过响应）
 */
function guardFileAccess(res, ctx, f) {
  const k = ctx.url.searchParams.get('k');
  const byKey = !!(k && k === f.accessToken);
  // 已移入网盘回收站：任何入口都不再放行（分享链接同样失效）
  if (f.deletedAt) {
    fail(res, 404, '文件已被删除');
    return false;
  }
  if (byKey) return true;
  if (!ctx.user) {
    fail(res, 401, '需要登录');
    return false;
  }
  if (db.isHidden(ctx.user.id, f.id)) {
    fail(res, 404, '文件不存在');
    return false;
  }
  const room = f.roomId ? db.getRoom(f.roomId) : null;
  if (room && room.kind !== ROOM_PUBLIC && !canViewRoom(room, ctx.user, ctx.user._token)) {
    fail(res, 403, '需要房间密码');
    return false;
  }
  return true;
}

route('GET', '/api/files/:id/raw', async (req, res, ctx) => {
  const f = db.getFile(ctx.params.id);
  if (!f) return fail(res, 404, '文件不存在');
  if (f.state !== 'ready') return fail(res, 404, '文件不存在');
  if (!guardFileAccess(res, ctx, f)) return;
  const sent = await files.stream(req, res, f.id);
  if (!sent) fail(res, 404, '文件不存在');
}, false);

/**
 * 文件下载。
 *
 * 与 /raw 的区别只有响应头：强制 attachment，浏览器直接存盘而不是内嵌预览。
 * 权限校验、Range 支持、字节来源完全一致。
 */
route('GET', '/api/files/:id/download', async (req, res, ctx) => {
  const f = db.getFile(ctx.params.id);
  if (!f) return fail(res, 404, '文件不存在');
  if (f.state !== 'ready') return fail(res, 404, '文件不存在');
  if (!guardFileAccess(res, ctx, f)) return;
  // 中文名走 RFC 5987，同时给一个 ASCII 兜底名
  const ascii = String(f.name || 'download')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\;]/g, '_')
    .replace(/\s+/g, '_') || 'download';
  res.setHeader(
    'Content-Disposition',
    "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(f.name)
  );
  const sent = await files.stream(req, res, f.id);
  if (!sent) fail(res, 404, '文件不存在');
}, false);

/* ---------------- 站内云网盘 ---------------- */

/**
 * 网盘路由（/api/drive/*）。
 * 不新建文件体系：列表/详情/删除都直接作用于 files 集合与 blob 存储，
 * 所以「聊天里发过的文件」天然出现在网盘里，不需要任何同步动作。
 */
const drive = require('./src/drive')({
  route, db, files, perm, ok, fail, readJson, now, fmtSize, storageInfo, clampInt
});

/* ---------------- 皮肤系统（标准版） ----------------
 * 皮肤包 = ZIP，元数据进 db('skins')，文件落地 DATA_DIR/skins/。
 * 内置皮肤随源码放在 public/skins/<id>/，走静态 /skins/ 路径；
 * 每个目录自带 manifest.json，这里自动扫描注册，加皮肤只需丢一个目录。
 */
const SKIN_DIR = path.join(DATA_DIR, 'skins');
const BUILTIN_SKINS = fs.readdirSync(path.join(PUBLIC_DIR, 'skins'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => {
    const dir = path.join(PUBLIC_DIR, 'skins', e.name);
    try {
      const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      const files = fs.readdirSync(dir).filter((f) => /\.(css|svg|png|jpe?g|webp|gif)$/i.test(f));
      if (!/^[a-z0-9-]+$/.test(mf.id || '') || !fs.existsSync(path.join(dir, mf.entry || 'skin.css'))) return null;
      return { id: mf.id, name: mf.name || mf.id, version: mf.version || '1.0.0',
        author: mf.author || '系统内置', description: mf.description || '',
        entry: mf.entry || 'skin.css', files,
        style: mf.style || '', tone: mf.tone || '' };
    } catch (e2) { return null; }
  })
  .filter(Boolean);
require('./src/skins').registerSkins({
  route, db, ok, fail, readBinary, DATA_DIR, SKIN_DIR, PUBLIC_DIR,
  builtin: BUILTIN_SKINS
});

/* ---------------- 好友 / 私聊 ---------------- */

route('GET', '/api/friends', async (req, res, ctx) => {
  const friends = db.friendsOf(ctx.user.id).map((f) => {
    const otherId = f.a === ctx.user.id ? f.b : f.a;
    const u = db.getUser(otherId);
    return {
      id: otherId,
      username: u ? u.username : '未知',
      nickname: u ? u.nickname : '未知',
      avatar: avatarUrl(u),
      avatarColor: avatarColor(otherId),
      initial: String((u && (u.nickname || u.username)) || '?').charAt(0).toUpperCase(),
      createdAt: f.createdAt
    };
  });
  const incoming = db.incomingRequests(ctx.user.id).map((r) => {
    const u = db.getUser(r.fromId);
    return {
      id: r.id,
      fromId: r.fromId,
      username: u ? u.username : '未知',
      nickname: u ? u.nickname : '未知',
      avatar: avatarUrl(u),
      avatarColor: avatarColor(r.fromId),
      initial: String((u && (u.nickname || u.username)) || '?').charAt(0).toUpperCase(),
      message: r.message || '',
      createdAt: r.createdAt
    };
  });
  const outgoing = db.outgoingRequests(ctx.user.id).map((r) => {
    const u = db.getUser(r.toId);
    return {
      id: r.id,
      toId: r.toId,
      username: u ? u.username : '未知',
      nickname: u ? u.nickname : '未知',
      avatar: avatarUrl(u),
      avatarColor: avatarColor(r.toId),
      initial: String((u && (u.nickname || u.username)) || '?').charAt(0).toUpperCase(),
      message: r.message || '',
      createdAt: r.createdAt
    };
  });
  // 最近被对方同意的我发出的请求（7 天内）：用于「我发出的请求」入口的红点提示
  const recentAccepted = db.byIdx('friendReqs', 'k1', ctx.user.id)
    .filter((r) => r.status === 'accepted' && r.acceptedAt && r.acceptedAt >= now() - 7 * 24 * 60 * 60 * 1000)
    .map((r) => {
      const u = db.getUser(r.toId);
      return {
        id: r.id,
        toId: r.toId,
        username: u ? u.username : '未知',
        nickname: u ? u.nickname : '未知',
        acceptedAt: r.acceptedAt
      };
    });
  ok(res, { friends, incoming, outgoing, recentAccepted });
});

route('POST', '/api/friends/request', async (req, res, ctx) => {
  const b = await readJson(req);
  const target = b.userId ? db.getUser(String(b.userId)) : db.findUserByName(String(b.username || ''));
  if (!target) return fail(res, 404, '用户不存在');
  if (target.id === ctx.user.id) return fail(res, 400, '不能添加自己');
  if (db.areFriends(ctx.user.id, target.id)) return fail(res, 400, '你们已经是好友');
  const exist = db.listFriendRequestsOf(ctx.user.id).find(
    (r) => r.status === 'pending' &&
      ((r.fromId === ctx.user.id && r.toId === target.id) || (r.toId === ctx.user.id && r.fromId === target.id))
  );
  if (exist) return fail(res, 400, '已发送过好友请求，等待对方同意');
  const r = db.createFriendRequest(ctx.user.id, target.id, b.message);
  ok(res, {
    request: {
      id: r.id,
      toId: target.id,
      username: target.username,
      nickname: target.nickname,
      message: r.message
    }
  });
});

route('POST', '/api/friends/:id/accept', async (req, res, ctx) => {
  const r = db.getFriendRequest(ctx.params.id);
  if (!r) return fail(res, 404, '请求不存在');
  if (r.toId !== ctx.user.id) return fail(res, 403, '无权操作');
  r.status = 'accepted';
  r.acceptedAt = now();
  db.updateFriendRequest(r);
  db.addFriend(r.fromId, r.toId);
  ok(res, {});
});

route('POST', '/api/friends/:id/reject', async (req, res, ctx) => {
  const r = db.getFriendRequest(ctx.params.id);
  if (!r) return fail(res, 404, '请求不存在');
  if (r.toId !== ctx.user.id && r.fromId !== ctx.user.id) return fail(res, 403, '无权操作');
  r.status = 'rejected';
  db.updateFriendRequest(r);
  ok(res, {});
});

/**
 * 我参与的所有私聊（仅本人可见，供前端同步 / 清除本机记录时枚举私聊 id）。
 * 只返回「对方是谁 + 房间 id + 最后消息 rev」，绝不出现在房间列表或搜索里。
 */
route('GET', '/api/dm/list', async (req, res, ctx) => {
  const mine = db.listRooms().filter((r) => r.kind === ROOM_DM && db.isMember(r.id, ctx.user.id));
  const items = mine.map((r) => {
    const other = db.membersOf(r.id).find((m) => m.userId !== ctx.user.id);
    const u = other ? db.getUser(other.userId) : null;
    const msgs = db.messagesOf(r.id);
    let lastRev = 0;
    msgs.forEach((m) => { const v = m.rev || m.seq || 0; if (v > lastRev) lastRev = v; });
    return {
      id: r.id,
      userId: u ? u.id : (other ? other.userId : ''),
      nickname: u ? (u.nickname || u.username) : '未知',
      lastRev
    };
  });
  ok(res, { items });
});

route('GET', '/api/dm/:userId', async (req, res, ctx) => {
  const otherId = ctx.params.userId;
  const other = db.getUser(otherId);
  if (!other) return fail(res, 404, '用户不存在');
  if (!db.areFriends(ctx.user.id, otherId)) return fail(res, 403, '需先成为好友才能私聊');
  const pairKey = db.friendPairKey(ctx.user.id, otherId);
  let room = db.byIdx('rooms', 'k2', pairKey).find((r) => r.kind === ROOM_DM);
  if (!room) {
    room = db.createRoom(ROOM_DM, '', pairKey, null);
    db.addMember(room.id, ctx.user.id, 'member');
    db.addMember(room.id, otherId, 'member');
  }
  ok(res, { room: roomBrief(room, ctx.user.id, ctx.user) });
});

/* ---------------- 群管理：遗产继承人 ---------------- */

route('POST', '/api/rooms/:id/heir', async (req, res, ctx) => {
  const room = db.getRoom(ctx.params.id);
  if (!room) return fail(res, 404, '房间不存在');
  if (!ensureActive(res, room)) return;
  if (room.ownerId !== ctx.user.id) return fail(res, 403, '只有群主可设置遗产继承人');
  const b = await readJson(req);
  const heirId = String(b.heirId || '').trim();
  if (heirId) {
    const m = db.getMember(room.id, heirId);
    if (!m) return fail(res, 400, '继承人必须是本群成员');
    if (heirId === ctx.user.id) return fail(res, 400, '不能指定自己为继承人');
  }
  room.heirId = heirId || null;
  db.put('rooms', room);
  ok(res, { heirId: room.heirId });
});

/* ---------------- 群管理：房间专属昵称 ---------------- */

/**
 * 只改 members 上当前 roomId 那一条记录的 roomNickname，
 * 完全不碰 users.nickname。传空串表示清除（回退显示全局昵称）。
 */
route('POST', '/api/rooms/:id/nickname', async (req, res, ctx) => {
  const room = db.getRoom(ctx.params.id);
  if (!room) return fail(res, 404, '房间不存在');
  if (!ensureActive(res, room)) return;
  const me = db.getMember(room.id, ctx.user.id);
  if (!me) return fail(res, 403, '你不是该房间成员');
  const b = await readJson(req);
  const nickname = String(b.nickname === undefined || b.nickname === null ? '' : b.nickname).trim();
  if (nickname && !NICK_RE.test(nickname)) {
    return fail(res, 400, '房间昵称需为 2-20 位中英文/数字/下划线');
  }
  db.updateMember(room.id, ctx.user.id, { roomNickname: nickname });
  ok(res, {
    roomNickname: nickname,
    displayName: roomDisplayName(room.id, ctx.user.id),
    globalNickname: ctx.user.nickname
  });
});

/* ---------------- 群管理：主动转让群主 ---------------- */

route('POST', '/api/rooms/:id/transfer', async (req, res, ctx) => {
  const room = db.getRoom(ctx.params.id);
  if (!room) return fail(res, 404, '房间不存在');
  if (!ensureActive(res, room)) return;
  if (room.kind !== ROOM_GROUP) return fail(res, 400, '只有群聊可以转让群主');
  if (room.ownerId !== ctx.user.id) return fail(res, 403, '只有群主可以转让群主权限');
  const b = await readJson(req);
  if (b.confirm !== true) return fail(res, 400, '需要二次确认');
  const targetId = String(b.userId || '').trim();
  if (!targetId || targetId === ctx.user.id) return fail(res, 400, '不能转让给自己');
  const target = db.getMember(room.id, targetId);
  if (!target) return fail(res, 400, '受让方必须是本群成员');
  const fromName = roomDisplayName(room.id, ctx.user.id);
  const toName = roomDisplayName(room.id, targetId);
  db.updateMember(room.id, targetId, { role: 'owner', appointedBy: null });
  db.updateMember(room.id, ctx.user.id, { role: 'member', appointedBy: null });
  room.ownerId = targetId;
  room.heirId = null;
  db.put('rooms', room);
  const notice = fromName + '的群主权限已转让至' + toName;
  postSystem(room.id, notice);
  ok(res, { ownerId: targetId, systemNotice: notice });
});

/* ---------------- 群管理：解散群聊 ---------------- */

/**
 * 停用而非物理删除：保留成员与历史消息，房间变成只读存档，
 * 这样「向成员发布系统通知」才有落点，成员随时能进去看到解散说明。
 */
function dissolveRoom(room, actorId) {
  const name = roomDisplayName(room.id, actorId);
  const isPublic = room.kind === ROOM_PUBLIC;
  room.dissolved = true;
  room.dissolvedAt = now();
  room.dissolvedBy = actorId;
  room.heirId = null;
  // 保留期从解散那一刻起算，到期由后台清理任务连数据一起删掉
  room.retainUntil = room.dissolvedAt + DISSOLVE_RETENTION_MS;
  db.put('rooms', room);
  const days = Math.max(1, Math.round(DISSOLVE_RETENTION_MS / 86400000));
  postSystem(room.id, (isPublic ? '公共大厅已由' : '本群已由') + name + '解散，现仅可查看历史消息，' + days + ' 天后将自动彻底删除');
}

/* ---------------- 解散后的保留期与自动清理 ---------------- */

function roomRetainUntil(room) {
  if (!room || !room.dissolved) return 0;
  return room.retainUntil || ((room.dissolvedAt || 0) + DISSOLVE_RETENTION_MS);
}

/** 物理删除一个房间的全部数据（消息 → 文件字节 → 成员 → 房间本身） */
async function purgeRoomData(room) {
  let messages = 0;
  let filesN = 0;
  for (const m of db.messagesOf(room.id).slice()) {
    if (m.fileId) {
      await files.removeBlob(m.fileId).catch(() => {});
      db.del('files', m.fileId);
      filesN++;
    }
    db.deleteMessage(m.id);
    messages++;
  }
  // 已上传但还没挂到消息上的孤儿文件也一并释放
  for (const f of db.filesOf(room.id).slice()) {
    await files.removeBlob(f.id).catch(() => {});
    db.del('files', f.id);
    filesN++;
  }
  for (const mem of db.membersOf(room.id)) db.removeMember(room.id, mem.userId);
  db.del('rooms', room.id);
  return { messages, files: filesN };
}

/**
 * 清理已过保留期的解散房间。
 * 公共大厅不参与自动清理：它是全体成员的固定入口，解散后保持只读存档，
 * 避免「到期被删 → 下次访问又被自动重建」这种来回反转的状态。
 */
async function purgeExpiredRooms() {
  const t = now();
  const out = { rooms: 0, messages: 0, files: 0, roomIds: [] };
  for (const room of db.listRooms().slice()) {
    if (!room.dissolved) continue;
    if (room.kind === ROOM_PUBLIC) continue;
    if (roomRetainUntil(room) > t) continue;
    const r = await purgeRoomData(room);
    out.rooms++;
    out.messages += r.messages;
    out.files += r.files;
    out.roomIds.push(room.id);
    console.log('[chatapp] 保留期已到，已彻底删除房间 ' + room.id + '（消息 ' + r.messages + ' 条 / 文件 ' + r.files + ' 个）');
  }
  return out;
}

/** 手动触发一次清理（最高权限，也方便运维与测试） */
route('POST', '/api/admin/rooms/sweep', async (req, res, ctx) => {
  if (!requireMaster(res, ctx.user)) return;
  const r = await purgeExpiredRooms();
  ok(res, r);
});

/**
 * 清空所有房间与房间记录（最高权限，不可逆）。
 * 用服务自身的 db 层删，保证内存缓存与云端文档一致，不会出现「删了又写回」。
 * 公共大厅立即重建，避免清空后所有人打不开首页。
 */
route('POST', '/api/admin/rooms/wipe-all', async (req, res, ctx) => {
  if (!requireMaster(res, ctx.user)) return;
  const b = await readJson(req);
  if (b.confirm !== true) return fail(res, 400, '需要二次确认');
  if (String(b.phrase || '').trim() !== '清空所有房间') {
    return fail(res, 400, '确认口令不正确（需输入「清空所有房间」）');
  }
  const rooms = db.listRooms().slice();
  let messages = 0;
  let filesN = 0;
  for (const room of rooms) {
    const r = await purgeRoomData(room);
    messages += r.messages;
    filesN += r.files;
  }
  // 兜底：不属于任何房间的孤儿文件
  for (const f of db.list('files').slice()) {
    await files.removeBlob(f.id).catch(() => {});
    db.del('files', f.id);
    filesN++;
  }
  // 兜底：孤儿消息
  for (const m of db.list('messages').slice()) {
    db.deleteMessage(m.id);
    messages++;
  }
  const pub = db.publicRoom();   // 立即重建一个干净的公共大厅
  console.log('[chatapp] 已清空全部房间：' + rooms.length + ' 个 / 消息 ' + messages + ' 条 / 文件 ' + filesN + ' 个');
  ok(res, { rooms: rooms.length, messages, files: filesN, publicRoomId: pub.id });
});

/**
 * 解散规则：
 *   公共大厅 —— 默认任何人都无权解散（连群主概念都没有），只有最高权限可以；
 *   群聊     —— 群主本人，或最高权限；
 *   私聊     —— 不可解散（删好友即等同于关闭）。
 */
route('POST', '/api/rooms/:id/dissolve', async (req, res, ctx) => {
  const room = db.getRoom(ctx.params.id);
  if (!room) return fail(res, 404, '房间不存在');
  if (room.dissolved) return fail(res, 410, '房间已解散');
  const master = perm.isMaster(ctx.user);

  if (room.kind === ROOM_DM) return fail(res, 400, '私聊不支持解散');
  if (room.kind === ROOM_PUBLIC) {
    // 公共大厅是全体成员的公共资产，默认封死解散入口，只有最高权限能停用它
    if (!master) return fail(res, 403, '公共大厅默认不可解散');
  } else if (room.ownerId !== ctx.user.id && !master) {
    return fail(res, 403, '只有群主可以解散群聊');
  }

  const b = await readJson(req);
  if (b.confirm !== true) return fail(res, 400, '需要二次确认');
  dissolveRoom(room, ctx.user.id);
  ok(res, {
    dissolved: true, master: master, kind: room.kind,
    retainUntil: room.retainUntil, retentionDays: Math.round(DISSOLVE_RETENTION_MS / 86400000)
  });
});

/* ---------------- 群管理：官职任命 / 禁言 / 踢人 ---------------- */

route('POST', '/api/rooms/:id/appoint', async (req, res, ctx) => {
  const room = db.getRoom(ctx.params.id);
  if (!room) return fail(res, 404, '房间不存在');
  const b = await readJson(req);
  const targetId = String(b.userId || '');
  const role = String(b.role || '');
  if (!ROLES[role]) return fail(res, 400, '无效职级');

  const me = db.getMember(room.id, ctx.user.id);
  if (!me) return fail(res, 403, '你不是该房间成员');
  const myRole = roleInfo(me.role);
  const target = db.getMember(room.id, targetId);
  if (!target) return fail(res, 404, '目标用户不是成员');

  if (role === 'owner') return fail(res, 400, '不能任命群主');
  if (!myRole.canAppoint.includes(role)) {
    return fail(res, 403, myRole.name + ' 无权任命 ' + roleInfo(role).name);
  }
  // 新职级必须严格低于自己的职级（不能任命同级或更高级）
  if (roleInfo(role).rank >= myRole.rank) {
    return fail(res, 403, '只能任命比自己级别低的人');
  }
  // 不能动比自己级别高的人
  if (roleInfo(target.role).rank > myRole.rank) {
    return fail(res, 403, '只能任命或调整级别不高于自己的人');
  }
  // 降级调整（把同级或下属调低一档）不受"可任命职级"限制，但仍受人数上限
  const isDemote = roleInfo(target.role).rank > roleInfo(role).rank;
  // 人数上限：按"每个任命人各自可任命数量"统计（排除目标自身，避免改派时重复计数）
  const count = db.membersOf(room.id).filter(
    (m) => m.role === role && m.appointedBy === ctx.user.id && m.userId !== targetId
  ).length;
  if (count >= myRole.appointLimit) {
    return fail(res, 400, myRole.name + '最多任命 ' + myRole.appointLimit + ' 位' + roleInfo(role).name);
  }
  target.role = role;
  target.appointedBy = ctx.user.id;
  db.put('members', target);
  ok(res, { member: { userId: targetId, role: target.role, roleName: roleInfo(role).name, demoted: isDemote } });
});

route('POST', '/api/rooms/:id/mute', async (req, res, ctx) => {
  const room = db.getRoom(ctx.params.id);
  if (!room) return fail(res, 404, '房间不存在');
  const b = await readJson(req);
  const targetId = String(b.userId || '');
  const minutes = clampInt(b.minutes, 1, 60 * 24 * 30, 10);
  const me = db.getMember(room.id, ctx.user.id);
  if (!me) return fail(res, 403, '你不是该房间成员');
  const myRank = roleInfo(me.role).rank;
  const target = db.getMember(room.id, targetId);
  if (!target) return fail(res, 404, '目标用户不是成员');
  if (roleInfo(target.role).rank >= myRank) {
    return fail(res, 403, '只能禁言级别不高于自己的人');
  }
  target.mutedUntil = now() + minutes * 60000;
  target.mutedReason = '被' + roleInfo(me.role).name + '禁言';
  db.put('members', target);
  ok(res, { mutedUntil: target.mutedUntil, minutes });
});

route('POST', '/api/rooms/:id/kick', async (req, res, ctx) => {
  const room = db.getRoom(ctx.params.id);
  if (!room) return fail(res, 404, '房间不存在');
  const b = await readJson(req);
  const targetId = String(b.userId || '');
  const me = db.getMember(room.id, ctx.user.id);
  if (!me) return fail(res, 403, '你不是该房间成员');
  const myRank = roleInfo(me.role).rank;
  const target = db.getMember(room.id, targetId);
  if (!target) return fail(res, 404, '目标用户不是成员');
  if (roleInfo(target.role).rank >= myRank) {
    return fail(res, 403, '只能踢出级别不高于自己的人');
  }
  db.removeMember(room.id, targetId);
  ok(res, { kicked: targetId });
});

/* ================================================================== */
/* 静态资源                                                            */
/* ================================================================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

/**
 * 前端资源内容指纹：app.js + style.css 的内容一变，这个值就变。
 * 用它给 HTML 里的资源 URL 加 ?v=，浏览器/WebView 就会当成全新资源去下载，
 * 不会因为磁盘缓存继续跑旧代码。按「mtime + 体积」缓存，避免每次请求都读盘。
 */
let assetVerCache = { key: '', v: '' };
function assetVersion() {
  // 两套网页共用一个指纹：任一份代码变了，所有档位的资源 URL 都会更新
  const names = ['app.js', 'style.css', 'app-basic.js', 'style-basic.css'];
  let key = '';
  for (const n of names) {
    try {
      const st = fs.statSync(path.join(PUBLIC_DIR, n));
      key += n + ':' + st.mtimeMs + ':' + st.size + '|';
    } catch (e) { key += n + ':missing|'; }
  }
  if (key === assetVerCache.key) return assetVerCache.v;
  const h = crypto.createHash('sha1');
  for (const n of names) {
    try { h.update(fs.readFileSync(path.join(PUBLIC_DIR, n))); }
    catch (e) { h.update(n); }
  }
  assetVerCache = { key, v: h.digest('hex').slice(0, 10) };
  return assetVerCache.v;
}

/* ================================================================== */
/* 设备能力分级 + 双版本网页分发                                        */
/* ================================================================== */

/**
 * 设备能力三档分发（full / lite / basic）
 *
 * 三档的由来：
 *   full  → 现代浏览器（CSS 变量 + flex + ES5）。
 *   lite  → Windows Phone 级的老内核能跑，但**在部分 Android 5.x WebView 上仍会失败**，
 *           因为它用了 position:fixed（老 WebView 重绘 bug）与 FileReader 切片上传。
 *   basic → 最后一道防线，彻底不用上面两项，也不依赖 localStorage。
 *
 * 为什么要把 Android 5.x 直接判到 basic（而不是留在 lite）：
 *   红米 Note 2 一类的实测反馈是「低配版切过去了，但还是用不了」。
 *   与其在一堆未知的内核怪癖里逐个试，不如让这类设备直接拿到最保守的实现，
 *   再靠「设备自检」把真实缺口反馈回来。
 */
function cookieOf(req, name) {
  const parts = String(req.headers.cookie || '').split(';');
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    if (p.slice(0, i).trim() === name) {
      try { return decodeURIComponent(p.slice(i + 1).trim()); }
      catch (e) { return p.slice(i + 1).trim(); }
    }
  }
  return '';
}

/** 解析 UA 里的 Chromium 主版本与 Android 主版本 */
function uaNumbers(ua) {
  const s = String(ua || '');
  let chrome = 0, android = 0, m;
  m = s.match(/(?:Chrome|Chromium|CriOS)\/(\d+)/);
  if (m) chrome = Number(m[1]);
  m = s.match(/Android\s+(\d+)/);
  if (m) android = Number(m[1]);
  return { s, chrome, android };
}

/** 第三档：连低配版都跑不动的内核 */
function uaLooksBasic(ua) {
  const { s, chrome, android } = uaNumbers(ua);
  // Android 4.x 及更老
  if (android && android <= 4) return true;
  // Android 5.x 自带 WebView = Chromium 37/39：本次实测的重灾区
  if (android && android <= 5 && (!chrome || chrome < 45)) return true;
  // 更老的 Chromium 内核（不论平台）
  if (chrome && chrome < 40) return true;
  // Android System WebView（; wv）且内核偏老
  if (/;\s*wv\)/i.test(s) && chrome && chrome < 45) return true;
  return false;
}

function uaLooksLite(ua) {
  const { s, chrome, android } = uaNumbers(ua);
  // Android 5.x 及以下自带 WebView 是 Chromium 37/39，CSS 变量完全不支持
  if (android && android <= 5) return true;
  // Android System WebView 标记（; wv）且系统版本较老
  if (/;\s*wv\)/i.test(s) && android && android <= 6) return true;
  // 老 Chromium / IE / UC / 老 MIUI 自带浏览器
  if (chrome && chrome < 49) return true;
  if (/MSIE\s|Trident\//i.test(s)) return true;
  if (/UCBrowser\//i.test(s)) return true;
  const m = s.match(/MiuiBrowser\/(\d+)/i);
  if (m && Number(m[1]) < 9) return true;
  return false;
}

const ENTRY_OF_LEVEL = {
  full: '/index.html',
  basic: '/index-basic.html'
};

/**
 * 级别判定优先级：
 *   URL 显式 ?lite=2|1|0（用户主动切换，最高优先）> cookie / 容器请求头
 *   > 省流量/低内存信号 > User-Agent 兜底
 *
 * 一个必须注意的坑：cookie 里记着 lite 时不能直接采信。
 * 用户如果早先在低配版点过「低配兼容模式」，cookie 会被写成 ll_cap=lite；
 * 而红米这类设备恰恰是低配版跑不动的那批 —— 一旦无条件信 cookie，
 * 它会永久锁死在跑不动的版本上，怎么刷新都没用。
 * 所以「UA 明确判定为 basic」时，cookie/请求头里的 lite 一律让位。
 */
function capabilityLevel(req, url) {
  const forced = String(url.searchParams.get('lite') || '').toLowerCase();
  // 两档：full=标准版，basic=基础版。旧参数 lite/1 统一当基础版（兼容老链接）
  if (forced === '2' || forced === 'basic' || forced === '1' || forced === 'lite') return 'basic';
  if (forced === '0' || forced === 'full') return 'full';

  const ua = req.headers['user-agent'];
  const uaBasic = uaLooksBasic(ua);
  const respect = (v) => {
    if (v === 'full') return 'full';
    if (v === 'basic' || v === 'lite') return 'basic';  // lite 档已删，归到基础版
    return '';
  };
  const ck = respect(cookieOf(req, 'll_cap'));
  if (ck) return ck;
  const hdr = respect(String(req.headers['x-ll-cap'] || '').toLowerCase());
  if (hdr) return hdr;

  if (String(req.headers['save-data'] || '').toLowerCase() === 'on') return 'basic';
  const mem = Number(req.headers['device-memory'] || 0);
  if (mem > 0 && mem <= 1) return 'basic';

  // 老设备一律基础版；其余标准版
  if (uaBasic || uaLooksLite(ua)) return 'basic';
  return 'full';
}

function serveStatic(req, res, pathname, url) {
  const isEntry = pathname === '/' || pathname === '/index.html';
  // 公开分享落地页：/s/<shareId> → share.html。
  // 此前没有这条路由，serveStatic 把 /s/xxx 当静态文件找 → 404，
  // 导致分享链接发出去后别人打开直接 404（重大 bug）。
  const isSharePage = /^\/s\/[A-Za-z0-9_]+\/?$/.test(pathname);
  // 两档分发：老设备(红米 Note 2 等)默认基础版，现代设备标准版；用户可手动切换。
  // 低配版(lite)已删除，只剩 full / basic 两档。
  const level = capabilityLevel(req, url);
  let rel = isSharePage ? '/share.html'
    : (isEntry ? (ENTRY_OF_LEVEL[level] || '/index-basic.html') : pathname);
  rel = rel.replace(/\.\./g, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return fail(res, 403, 'forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const compressible = /text|javascript|json|svg/.test(type);
    // 仅当客户端声明支持 gzip 时才压缩，避免老内核解析失败
    const acceptEnc = String(req.headers['accept-encoding'] || '');
    const useGzip = compressible && acceptEnc.indexOf('gzip') >= 0;

    const isHtml = ext === '.html';
    const isCore = /^\/(app|style)(-lite|-basic)?\.(js|css)$/.test(rel);
    // 带内容指纹的请求才能长缓存；不带版本号的（老客户端）一律 no-store
    const versioned = /[?&]v=/.test(String(req.url || ''));
    let cacheControl;
    if (isHtml) cacheControl = 'no-store';                                   // 入口页永远回源
    else if (isCore) cacheControl = versioned
      ? 'public, max-age=31536000, immutable'                               // 内容指纹 URL 可永久缓存
      : 'no-store';                                                          // 兼容旧 HTML，不留在缓存里
    else cacheControl = 'public, max-age=300';                               // 图标 / manifest 等
    const headers = {
      'Content-Type': type,
      'Cache-Control': cacheControl
    };
    // 显式切换版本时把选择记下来，后续不带参数的导航仍走同一版本
    if (isEntry && url.searchParams.has('lite')) {
      headers['Set-Cookie'] = 'll_cap=' + level + '; Path=/; Max-Age=2592000; SameSite=Lax';
    }
    if (useGzip) headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();

    // index.html：注入带内容指纹的资源 URL。
    // 这样「线上更新 → 重新打开 App」不需要清缓存、也不需要等 5 分钟。
    //
    // 【关键修复】线上分享网关要求每个请求都带 sharecode，否则静态资源返回
    // 403「链接不完整」。原实现只给 JS/CSS 加了 ?v=指纹，丢了 sharecode，
    // 于是 HTML 能开、但脚本/样式全部 403 → 页面彻底瘫掉（红米首访无缓存尤其明显）。
    // 这里把原 query（sharecode 等）完整附加到每个资源 URL。
    if (isHtml) {
      let html = fs.readFileSync(file, 'utf8');
      const v = assetVersion();
      const q = [];
      url.searchParams.forEach((val, key) => {
        if (key !== 'lite') q.push(encodeURIComponent(key) + '=' + encodeURIComponent(val));
      });
      const tail = q.length ? '?' + q.join('&') + '&v=' + v : '?v=' + v;
      if (rel === '/share.html') {
        html = html
          .replace('href="/style.css"', 'href="/style.css' + tail + '"')
          .replace('src="/share.js"', 'src="/share.js' + tail + '"');
      } else if (rel === '/index-basic.html') {
        html = html
          .replace('href="/style-basic.css"', 'href="/style-basic.css' + tail + '"')
          .replace('src="/app-basic.js"', 'src="/app-basic.js' + tail + '"');
      } else {
        html = html
          .replace('href="/style.css"', 'href="/style.css' + tail + '"')
          .replace('src="/app.js"', 'src="/app.js' + tail + '"');
      }
      // 版本切换链接要保留原 query（尤其 sharecode，否则线上会被判「链接不完整」）
      const capBase = q.length ? '/?' + q.join('&') + '&' : '/?';
      html = html
        .replace('href="/?lite=1"', 'href="' + capBase + 'lite=1"')
        .replace('href="/?lite=2"', 'href="' + capBase + 'lite=2"')
        .replace('href="/?lite=0"', 'href="' + capBase + 'lite=0"');
      const buf = Buffer.from(html, 'utf8');
      if (useGzip) return res.end(zlib.gzipSync(buf));
      return res.end(buf);
    }

    const rs = fs.createReadStream(file);
    if (useGzip) {
      const gz = zlib.createGzip();
      rs.pipe(gz).pipe(res);
    } else {
      rs.pipe(res);
    }
  });
}

/* ================================================================== */
/* 服务器                                                              */
/* ================================================================== */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (_) {
    return fail(res, 400, 'bad url');
  }
  const pathname = url.pathname;

  // 跨域（便于外网访问调试）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Token, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (pathname.startsWith('/api/')) {
    const hit = matchRoute(req.method, pathname);
    if (!hit) return fail(res, 404, '接口不存在');
    try {
      /*
       * 已解散房间 = 只读存档。所有针对房间的写操作在这里统一拦截，
       * 避免每新增一个接口都要记得单独判一次；只读 GET（历史消息 / 成员 /
       * 解散通知）与「退出房间」仍放行，成员随时能进去看到解散说明。
       */
      if (req.method !== 'GET' && /^\/api\/rooms\/[^/]+\/.+/.test(pathname)) {
        const seg = pathname.split('/');
        const r = db.getRoom(decodeURIComponent(seg[3] || ''));
        if (r && r.dissolved && seg[4] !== 'leave') {
          return fail(res, 410, '房间已解散，仅可查看历史消息');
        }
      }
      const user = requireUser(req, url);
      if (hit.auth && !user) return fail(res, 401, '请先登录');
      await hit.handler(req, res, { params: hit.params, url, user });
    } catch (e) {
      if (!res.headersSent) fail(res, 500, e && e.message ? e.message : '服务器内部错误');
      else res.destroy();
    }
    return;
  }

  serveStatic(req, res, pathname, url);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.requestTimeout = 0;

/** 启动顺序：先连存储后端，再开端口 —— 避免首批请求读到未加载完的数据 */
initStore().then(() => {
  server.listen(PORT, HOST, () => {
    const pub = db.publicRoom();
    console.log('[chatapp] 启动于 http://' + HOST + ':' + PORT);
    console.log('[chatapp] 存储后端: ' + store.kind + ' | 数据目录: ' + DATA_DIR);
    console.log('[chatapp] 公共聊天室: ' + pub.id);
    // 启动即扫一遍过期的解散房间（上次停机期间到期的也一并清掉）
    purgeExpiredRooms().catch((e) => {
      console.error('[chatapp] 启动清理失败: ' + (e && e.message ? e.message : e));
    });
    // 之后每 30 分钟扫一次；unref 保证不会因为它让进程退不出去
    setInterval(() => {
      purgeExpiredRooms().catch((e) => {
        console.error('[chatapp] 定时清理失败: ' + (e && e.message ? e.message : e));
      });
    }, 30 * 60 * 1000).unref();

    // 网盘回收站：软删除 30 天后物理清除（启动一次 + 每小时一次）
    drive.purgeTrash().catch((e) => {
      console.error('[chatapp] 回收站清理失败: ' + (e && e.message ? e.message : e));
    });
    setInterval(() => {
      drive.purgeTrash().catch((e) => {
        console.error('[chatapp] 回收站定时清理失败: ' + (e && e.message ? e.message : e));
      });
    }, 60 * 60 * 1000).unref();
  });
}).catch((e) => {
  console.error('[chatapp] 启动失败: ' + (e && e.message ? e.message : e));
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try { await store.flush(); } catch (_) { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

process.on('uncaughtException', (e) => {
  console.error('[chatapp] uncaught:', e && e.message);
});
