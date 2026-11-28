'use strict';
/**
 * 站内云网盘。
 *
 * 设计要点：网盘**不另建一套文件体系**，直接复用聊天站的 files 集合与 blob 存储。
 *   · 聊天里发出的文件天生就在网盘里（ownerId 就是发送者），无需二次转存；
 *   · 配额、云端持久化、分片断点续传全部沿用已有实现，不会出现「聊天算一份、网盘算另一份」；
 *   · 网盘额外增加的只有两个轻量字段：folder（所在目录）与 deletedAt（回收站标记）。
 *
 * 因此这里只补「视图层 + 分享 + 回收站」，不碰存储。
 *
 * 集合：shares  k1=userId  k2=fileId
 */

const crypto = require('crypto');
const { randomId } = require('./util');

/** 回收站保留期：软删除后 30 天物理清除 */
const TRASH_KEEP_MS = 30 * 24 * 3600 * 1000;
/** 单文件上限与聊天上传保持一致（200MB） */
const MAX_FILE_SIZE = 200 * 1024 * 1024;
/** 分享默认有效期（天）与上限 */
const SHARE_DEFAULT_DAYS = 7;
const SHARE_MAX_DAYS = 365;
/** 详情里计算 md5 的体积上限：只对小文件算，避免把大文件读进内存 */
const MD5_LIMIT = 8 * 1024 * 1024;

const TYPE_LABEL = {
  image: '图片', video: '视频', audio: '音频',
  doc: '文档', archive: '压缩包', other: '其他'
};

/** 类型归类：先看 MIME，再按扩展名兜底 */
function typeGroup(mime, name) {
  const m = String(mime || '').toLowerCase();
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (m.indexOf('image/') === 0) return 'image';
  if (m.indexOf('video/') === 0) return 'video';
  if (m.indexOf('audio/') === 0) return 'audio';
  if (m === 'application/pdf') return 'doc';
  if (/^(doc|docx|xls|xlsx|ppt|pptx|txt|md|csv|rtf|json|xml|log)$/.test(ext)) return 'doc';
  if (/^(zip|rar|7z|gz|tar)$/.test(ext)) return 'archive';
  return 'other';
}

/** 提取码：4 位，去掉容易看错的 0/O/1/I */
function genCode() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  const buf = crypto.randomBytes(4);
  for (let i = 0; i < 4; i++) s += alphabet[buf[i] % alphabet.length];
  return s;
}

function md5Of(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

/**
 * 注册网盘路由。
 * @param {object} deps 由 server.js 注入的运行时依赖
 */
module.exports = function registerDrive(deps) {
  const {
    route, db, files, perm,
    ok, fail, readJson, now, fmtSize, storageInfo, clampInt,
    reviews   // 内容审查单（2026-11-28）：审核中/被举报的文件禁止经分享链接绕过下载
  } = deps;

  /* ================================================================ */
  /* 辅助                                                              */
  /* ================================================================ */

  /** 房间名的可读展示（网盘里标识文件来源） */
  function roomLabel(room) {
    if (!room) return '网盘上传';
    if (room.kind === 'public') return '公共聊天室';
    return room.name || '未命名房间';
  }

  /** 一条 files 文档是否是一份「可用的网盘文件」 */
  function isLiveFile(f, userId) {
    if (!f || f.state !== 'ready') return false;
    if (f.ownerId !== userId) return false;
    if (f.deletedAt) return false;                    // 在回收站里
    if (db.isHidden(userId, f.id)) return false;      // 已在聊天里「仅自己删除」
    return true;
  }

  /** 文件 -> 对外结构 */
  function toFile(f, opts) {
    const o = opts || {};
    const room = f.roomId ? db.getRoom(f.roomId) : null;
    const type = typeGroup(f.mime, f.name);
    // 图片/视频直接用独立访问令牌内联，供 <img>/<video> 与缩略图使用
    const raw = '/api/files/' + f.id + '/raw?k=' + encodeURIComponent(f.accessToken || '');
    const share = db.byIdx('shares', 'k2', f.id).filter((s) => s.userId === f.ownerId && !s.revoked)[0] || null;
    return {
      fileId: f.id,
      name: f.name,
      size: f.size,
      sizeText: fmtSize(f.size),
      mime: f.mime,
      type: type,
      typeLabel: TYPE_LABEL[type] || '其他',
      folder: f.folder || '',
      createdAt: f.createdAt,
      readyAt: f.readyAt || f.createdAt,
      // 来源：聊天里发出的文件会带上房间名，网盘直传的为空
      roomId: f.roomId || '',
      roomName: o.withRoom === false ? '' : roomLabel(room),
      fromChat: !!f.roomId,
      rawUrl: raw,
      thumbUrl: type === 'image' ? raw : '',
      downloadUrl: '/api/files/' + f.id + '/download?k=' + encodeURIComponent(f.accessToken || ''),
      sha256: f.sha256 || '',
      md5: f.md5 || '',
      share: share ? {
        shareId: share.id,
        encrypted: !!share.encrypted,
        code: share.code || '',
        expireAt: share.expireAt,
        downloads: share.downloads || 0,
        expired: share.expireAt > 0 && share.expireAt < now()
      } : null,
      deletedAt: f.deletedAt || 0
    };
  }

  /** 取自己的文件，且校验存在性/归属 */
  function ownFile(res, ctx, id) {
    const f = db.getFile(String(id || ''));
    if (!f || f.ownerId !== ctx.user.id) {
      fail(res, 404, '文件不存在');
      return null;
    }
    return f;
  }

  /** 分享是否仍有效 */
  function shareLive(s) {
    if (!s || s.revoked) return false;
    if (s.expireAt > 0 && s.expireAt < now()) return false;
    return true;
  }

  /* ================================================================ */
  /* 配额 / 统计                                                       */
  /* ================================================================ */

  route('GET', '/api/drive/storage', async (req, res, ctx) => {
    const st = storageInfo(ctx.user);
    const mine = db.filesOfOwner(ctx.user.id);
    let count = 0;
    let trashCount = 0;
    for (const f of mine) {
      if (f.state !== 'ready') continue;
      if (f.deletedAt) { trashCount++; continue; }
      if (db.isHidden(ctx.user.id, f.id)) continue;
      count++;
    }
    ok(res, Object.assign({}, st, { fileCount: count, trashCount: trashCount }));
  });

  /* ================================================================ */
  /* 文件列表 / 详情                                                    */
  /* ================================================================ */

  route('GET', '/api/drive/files', async (req, res, ctx) => {
    const q = ctx.url.searchParams;
    const keyword = String(q.get('keyword') || '').trim().toLowerCase();
    const type = String(q.get('type') || '').trim();
    const folder = q.get('folder');                 // 不传=全部；传 ''=根目录
    const sort = String(q.get('sort') || 'time');   // time | size | name
    const page = clampInt(q.get('page'), 1, 100000, 1);
    const size = clampInt(q.get('size'), 1, 100, 30);

    let list = db.filesOfOwner(ctx.user.id).filter((f) => isLiveFile(f, ctx.user.id));

    if (keyword) list = list.filter((f) => String(f.name || '').toLowerCase().indexOf(keyword) >= 0);
    if (type) list = list.filter((f) => typeGroup(f.mime, f.name) === type);
    if (folder !== null && folder !== undefined) {
      list = list.filter((f) => String(f.folder || '') === String(folder));
    }

    if (sort === 'size') list.sort((a, b) => (b.size || 0) - (a.size || 0));
    else if (sort === 'name') list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh'));
    else list.sort((a, b) => (b.readyAt || b.createdAt || 0) - (a.readyAt || a.createdAt || 0));

    const total = list.length;
    const start = (page - 1) * size;
    const items = list.slice(start, start + size).map((f) => toFile(f));

    // 顺带把目录清单回给前端，省一次请求
    // 目录来源有两处：显式创建的空/非空目录（driveFolders），以及文件上挂的 folder 字段。
    // 合在一起返回，前端不需要区分「文件夹是新建的还是移动时顺手建的」。
    const folders = [];
    const seen = Object.create(null);
    for (const d of db.byIdx('driveFolders', 'k1', ctx.user.id)) {
      const name = String(d.name || '');
      if (!name || seen[name]) continue;
      seen[name] = true;
      folders.push(name);
    }
    for (const f of db.filesOfOwner(ctx.user.id)) {
      if (!isLiveFile(f, ctx.user.id)) continue;
      const d = String(f.folder || '');
      if (!d || seen[d]) continue;
      seen[d] = true;
      folders.push(d);
    }
    folders.sort();

    ok(res, {
      items, total, page, size,
      pages: Math.max(1, Math.ceil(total / size)),
      folders,
      hasMore: start + items.length < total,
      types: Object.keys(TYPE_LABEL).map((k) => ({ key: k, label: TYPE_LABEL[k] }))
    });
  });

  route('GET', '/api/drive/files/:id', async (req, res, ctx) => {
    const f = ownFile(res, ctx, ctx.params.id);
    if (!f) return;
    if (f.state !== 'ready') return fail(res, 404, '文件尚未上传完成');

    const out = toFile(f);
    out.deleted = !!f.deletedAt;
    out.uploading = false;

    // md5：小文件且未缓存过时按需算一次并写回，避免每次详情都读盘
    if (!f.md5 && f.size <= MD5_LIMIT) {
      try {
        const buf = await readBlobBytes(f.id);
        if (buf) {
          f.md5 = md5Of(buf);
          db.updateFile(f);
          out.md5 = f.md5;
          out.md5Size = buf.length;
        }
      } catch (e) { /* 算不出来就不给，不影响其它字段 */ }
    }
    ok(res, out);
  });

  /**
   * 读取整个 blob（仅用于小文件的 md5 计算）。
   * 走 files.stream 之外的独立实现：这里要的是 Buffer，不是响应流。
   */
  async function readBlobBytes(fileId) {
    if (typeof files.readAll === 'function') return files.readAll(fileId);
    // 后端没有 readAll 时退化为「自己拼一个内存响应」
    const fakeRes = {
      _chunks: [],
      writeHead() {},
      setHeader() {},
      write(c) { if (c) this._chunks.push(Buffer.from(c)); return true; },
      end(c) { if (c) this._chunks.push(Buffer.from(c)); this._done = true; },
      end0() {}
    };
    const sent = await files.stream({ headers: {} }, fakeRes, fileId);
    if (!sent) return null;
    return Buffer.concat(fakeRes._chunks);
  }

  /* ================================================================ */
  /* 重命名 / 移动                                                     */
  /* ================================================================ */

  route('PATCH', '/api/drive/files/:id', async (req, res, ctx) => {
    const f = ownFile(res, ctx, ctx.params.id);
    if (!f) return;
    const b = await readJson(req);
    let changed = false;

    if (b.name !== undefined) {
      const name = String(b.name || '').trim();
      if (!name) return fail(res, 400, '文件名不能为空');
      if (name.length > 120) return fail(res, 400, '文件名过长（最多 120 字）');
      if (/[\\/:*?"<>|]/.test(name)) return fail(res, 400, '文件名不能包含 \\ / : * ? " < > |');
      f.name = name;
      changed = true;
    }
    if (b.folder !== undefined) {
      let folder = String(b.folder || '').trim();
      if (folder.length > 80) return fail(res, 400, '目录名过长（最多 80 字）');
      if (/[\\:*?"<>|]/.test(folder)) return fail(res, 400, '目录名不能包含 \\ : * ? " < > |');
      folder = folder.replace(/^\/+|\/+$/g, '');
      f.folder = folder;
      changed = true;
    }
    if (!changed) return fail(res, 400, '没有需要修改的内容');

    db.updateFile(f);
    ok(res, toFile(f));
  });

  /* ================================================================ */
  /* 目录：新建 / 删除                                                  */
  /* ================================================================ */

  /** 目录名归一化 + 校验，返回 {name} 或 {error} */
  function parseFolderName(raw) {
    let name = String(raw == null ? '' : raw).trim().replace(/^\/+|\/+$/g, '');
    if (!name) return { error: '目录名不能为空' };
    if (name.length > 80) return { error: '目录名过长（最多 80 字）' };
    if (/[\\:*?"<>|]/.test(name)) return { error: '目录名不能包含 \\ : * ? " < > |' };
    return { name };
  }

  /** 该目录名在「我的网盘」里是否已存在（显式目录或已有文件挂载） */
  function folderExists(userId, name) {
    if (db.byIdx('driveFolders', 'k1', userId).some((d) => d.name === name)) return true;
    return db.filesOfOwner(userId).some((f) => isLiveFile(f, userId) && String(f.folder || '') === name);
  }

  route('POST', '/api/drive/folders', async (req, res, ctx) => {
    const b = await readJson(req);
    const p = parseFolderName(b.name);
    if (p.error) return fail(res, 400, p.error);
    if (folderExists(ctx.user.id, p.name)) return fail(res, 409, '同名目录已存在');

    const doc = { id: randomId('fd'), ownerId: ctx.user.id, name: p.name, createdAt: now() };
    db.put('driveFolders', doc);
    ok(res, { id: doc.id, name: doc.name, createdAt: doc.createdAt });
  });

  /** 删除目录：只允许删空目录，避免一键把文件「删没」（文件请先在网盘里删或移走） */
  route('DELETE', '/api/drive/folders/:name', async (req, res, ctx) => {
    const p = parseFolderName(decodeURIComponent(ctx.params.name || ''));
    if (p.error) return fail(res, 400, p.error);
    const used = db.filesOfOwner(ctx.user.id)
      .filter((f) => isLiveFile(f, ctx.user.id) && String(f.folder || '') === p.name).length;
    if (used) return fail(res, 400, '目录里还有 ' + used + ' 个文件，先移走或删除后再删目录');

    for (const d of db.byIdx('driveFolders', 'k1', ctx.user.id)) {
      if (d.name === p.name) db.del('driveFolders', d.id);
    }
    ok(res, { deleted: true, name: p.name });
  });

  /* ================================================================ */
  /* 回收站：软删除 / 恢复 / 彻底删除                                   */
  /* ================================================================ */

  route('DELETE', '/api/drive/files/:id', async (req, res, ctx) => {
    const f = ownFile(res, ctx, ctx.params.id);
    if (!f) return;
    if (f.deletedAt) return ok(res, { deletedAt: f.deletedAt, already: true });
    f.deletedAt = now();
    db.updateFile(f);
    ok(res, { deletedAt: f.deletedAt, keepDays: Math.round(TRASH_KEEP_MS / 864e5) });
  });

  route('GET', '/api/drive/trash', async (req, res, ctx) => {
    const q = ctx.url.searchParams;
    const page = clampInt(q.get('page'), 1, 100000, 1);
    const size = clampInt(q.get('size'), 1, 100, 30);

    const list = db.filesOfOwner(ctx.user.id)
      .filter((f) => f.state === 'ready' && f.deletedAt)
      .sort((a, b) => b.deletedAt - a.deletedAt);

    const total = list.length;
    const start = (page - 1) * size;
    const items = list.slice(start, start + size).map((f) => {
      const o = toFile(f, { withRoom: false });
      o.expireAt = f.deletedAt + TRASH_KEEP_MS;
      o.remainDays = Math.max(0, Math.ceil((o.expireAt - now()) / 864e5));
      return o;
    });
    ok(res, { items, total, page, size, pages: Math.max(1, Math.ceil(total / size)) });
  });

  route('POST', '/api/drive/trash/:id/restore', async (req, res, ctx) => {
    const f = ownFile(res, ctx, ctx.params.id);
    if (!f) return;
    if (!f.deletedAt) return fail(res, 400, '该文件不在回收站');
    // 恢复前复核配额：回收站里的文件本来已占额度，这里主要防「空间被别人占满后恢复不进去」
    const st = storageInfo(ctx.user);
    if (st.used > st.quota) return fail(res, 403, '存储空间已超出配额，请先清理后再恢复');
    delete f.deletedAt;
    db.updateFile(f);
    ok(res, toFile(f));
  });

  route('DELETE', '/api/drive/trash/:id', async (req, res, ctx) => {
    const f = ownFile(res, ctx, ctx.params.id);
    if (!f) return;
    if (!f.deletedAt) return fail(res, 400, '该文件不在回收站，请先移入回收站');
    await files.removeBlob(f.id).catch(() => {});
    // 分享链接一并失效
    for (const s of db.byIdx('shares', 'k2', f.id)) db.del('shares', s.id);
    db.del('files', f.id);
    ok(res, { purged: true });
  });

  /** 回收站到期清理：启动扫一次 + 每小时一次 */
  async function purgeTrash() {
    const t = now();
    let n = 0;
    for (const f of db.list('files')) {
      if (!f.deletedAt) continue;
      if (f.deletedAt + TRASH_KEEP_MS > t) continue;
      await files.removeBlob(f.id).catch(() => {});
      for (const s of db.byIdx('shares', 'k2', f.id)) db.del('shares', s.id);
      db.del('files', f.id);
      n++;
    }
    if (n) console.log('[chatapp] 网盘回收站：物理清除 ' + n + ' 个到期文件');
    return n;
  }

  /* ================================================================ */
  /* 分享                                                              */
  /* ================================================================ */

  route('POST', '/api/drive/files/:id/share', async (req, res, ctx) => {
    const f = ownFile(res, ctx, ctx.params.id);
    if (!f) return;
    if (f.state !== 'ready') return fail(res, 400, '文件尚未上传完成');
    if (f.deletedAt) return fail(res, 400, '文件在回收站里，无法分享');

    const b = await readJson(req);
    // 时长允许小数天：既支持「7 天」这种常规用法，也让短时分享（秒级）可测可控
    let days = Number(b.days);
    if (!(days > 0)) days = SHARE_DEFAULT_DAYS;
    if (days > SHARE_MAX_DAYS) days = SHARE_MAX_DAYS;
    const encrypted = b.encrypted === true || !!b.encrypted;
    let code = String(b.code || '').trim();

    if (encrypted) {
      if (code && !/^[A-Za-z0-9]{2,12}$/.test(code)) {
        return fail(res, 400, '提取码需为 2-12 位字母或数字');
      }
      if (!code) code = genCode();
    } else {
      code = '';
    }

    // 同一文件已有有效分享时直接复用（避免一文件堆出无数条链接）
    let share = db.byIdx('shares', 'k2', f.id).filter((s) => s.userId === ctx.user.id && shareLive(s))[0];
    if (share) {
      share.encrypted = encrypted;
      share.code = code;
      share.expireAt = days > 0 ? now() + days * 864e5 : 0;
      db.put('shares', share);
    } else {
      share = {
        id: 'sh_' + crypto.randomBytes(8).toString('hex'),
        fileId: f.id,
        userId: ctx.user.id,
        encrypted: encrypted,
        code: code,
        expireAt: days > 0 ? now() + days * 864e5 : 0,
        downloads: 0,
        createdAt: now(),
        revoked: false
      };
      db.put('shares', share);
    }
    f.shareId = share.id;
    db.updateFile(f);

    ok(res, shareInfo(share, f));
  });

  route('GET', '/api/drive/shares', async (req, res, ctx) => {
    const list = db.byIdx('shares', 'k1', ctx.user.id)
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt);
    const out = [];
    for (const s of list) {
      const f = db.getFile(s.fileId);
      if (!f) continue;
      const o = shareInfo(s, f);
      o.shareId = s.id;
      o.fileName = f.name;
      o.fileSize = f.size;
      o.fileSizeText = fmtSize(f.size);
      out.push(o);
    }
    ok(res, { items: out, total: out.length });
  });

  route('DELETE', '/api/drive/shares/:id', async (req, res, ctx) => {
    const s = db.get('shares', ctx.params.id);
    if (!s || s.userId !== ctx.user.id) return fail(res, 404, '分享不存在');
    s.revoked = true;
    db.put('shares', s);
    ok(res, { revoked: true });
  });

  /** 分享对外结构：绝不暴露 fileId 之外的隐私字段 */
  function shareInfo(s, f) {
    return {
      shareId: s.id,
      url: '/s/' + s.id,
      encrypted: !!s.encrypted,
      code: s.code || '',
      expireAt: s.expireAt,
      downloads: s.downloads || 0,
      createdAt: s.createdAt,
      expired: s.expireAt > 0 && s.expireAt < now(),
      revoked: !!s.revoked,
      needCode: !!s.encrypted,
      fileName: f ? f.name : '',
      fileSize: f ? f.size : 0,
      fileSizeText: f ? fmtSize(f.size) : '',
      fileType: f ? typeGroup(f.mime, f.name) : 'other'
    };
  }

  /* ---------------- 公开分享（不需要登录） ---------------- */

  route('GET', '/api/drive/s/:sid', async (req, res, ctx) => {
    const s = db.get('shares', ctx.params.sid);
    if (!s || s.revoked) return fail(res, 404, '分享不存在或已取消');
    const f = db.getFile(s.fileId);
    if (!f || f.deletedAt || f.state !== 'ready') return fail(res, 404, '文件已被删除');
    if (s.expireAt > 0 && s.expireAt < now()) return fail(res, 410, '分享已过期');

    const code = String(ctx.url.searchParams.get('code') || '');
    const pass = !s.encrypted || (code && code.toLowerCase() === String(s.code || '').toLowerCase());
    const owner = db.getUser(s.userId);

    const o = shareInfo(s, f);
    o.ownerName = owner ? (owner.nickname || owner.username) : '已注销用户';
    o.passed = !!pass;
    o.rawUrl = pass ? '/api/files/' + f.id + '/raw?k=' + encodeURIComponent(f.accessToken || '') : '';
    o.downloadUrl = pass ? '/api/drive/s/' + s.id + '/dl?code=' + encodeURIComponent(code) : '';
    o.code = '';                       // 校验通过也不回显别人的提取码
    o.fileType = typeGroup(f.mime, f.name);
    ok(res, o);
  }, false);

  route('GET', '/api/drive/s/:sid/dl', async (req, res, ctx) => {
    const s = db.get('shares', ctx.params.sid);
    if (!s || s.revoked) return fail(res, 404, '分享不存在或已取消');
    const f = db.getFile(s.fileId);
    if (!f || f.deletedAt || f.state !== 'ready') return fail(res, 404, '文件已被删除');
    if (s.expireAt > 0 && s.expireAt < now()) return fail(res, 410, '分享已过期');

    const code = String(ctx.url.searchParams.get('code') || '');
    if (s.encrypted && code.toLowerCase() !== String(s.code || '').toLowerCase()) {
      return fail(res, 403, '提取码不正确');
    }
    // 内容审查：图片审核中不可查看；被举报文件 12h 观察期内不可下载
    // （分享链接不能成为绕过审查的下载通道）
    if (reviews && reviews.fileBlocked(f.id)) {
      return fail(res, 403, '内容审核中，暂时无法访问');
    }

    s.downloads = (s.downloads || 0) + 1;
    db.put('shares', s);

    const ascii = String(f.name || 'download')
      .replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_').replace(/\s+/g, '_') || 'download';
    res.setHeader('Content-Disposition',
      'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(f.name));
    const sent = await files.stream(req, res, f.id);
    if (!sent) fail(res, 404, '文件不存在');
  }, false);

  /* ================================================================ */
  /* 会话共享文件：某房间里的全部文件                                    */
  /* ================================================================ */

  route('GET', '/api/rooms/:id/files', async (req, res, ctx) => {
    const room = db.getRoom(ctx.params.id);
    if (!room) return fail(res, 404, '房间不存在');
    const member = db.getMember(room.id, ctx.user.id);
    if (room.kind !== 'public' && !member) return fail(res, 403, '请先加入该房间');

    const type = String(ctx.url.searchParams.get('type') || '');
    let list = db.filesOf(room.id).filter((f) => f.state === 'ready' && !f.deletedAt);
    // 自己隐藏掉的文件不再出现
    list = list.filter((f) => !db.isHidden(ctx.user.id, f.id));
    if (type) list = list.filter((f) => typeGroup(f.mime, f.name) === type);
    list.sort((a, b) => (b.readyAt || b.createdAt) - (a.readyAt || a.createdAt));

    ok(res, {
      files: list.slice(0, 200).map((f) => {
        const o = toFile(f, { withRoom: false });
        return o;
      }),
      total: list.length
    });
  });

  /* ================================================================ */
  /* 上传入口说明                                                      */
  /* ================================================================ */
  // 上传不另开接口：网盘直传直接复用
  //   POST /api/files/init  { name, size, mime }        —— roomId 留空即为「网盘文件」
  //   PUT  /api/files/:id/chunk?i=n
  //   POST /api/files/:id/complete
  // 下载复用 GET /api/files/:id/download?k=<accessToken>
  // 这样分片、断点续传、配额、云端持久化全部与聊天共用同一套实现。

  return { purgeTrash, typeGroup, TRASH_KEEP_MS, MAX_FILE_SIZE };
};
