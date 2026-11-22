'use strict';
/**
 * 皮肤系统（标准版）。
 *
 * 一个皮肤 = 一个 ZIP 包，目录结构由开发者自定，但根目录必须有 manifest.json：
 *   {
 *     "id": "my-skin",          // 英文小写+数字+横线，全局唯一（被占用会自动加后缀）
 *     "name": "我的皮肤",        // 展示名
 *     "version": "1.0.0",
 *     "author": "作者名",
 *     "description": "一句话介绍",
 *     "entry": "skin.css",      // 入口 CSS（相对包根）；也可省略，默认找 skin.css
 *     "preview": "preview.png"  // 预览图（可选，没就不显示）
 *   }
 *
 * CSS 靠覆盖公开的变量（--bg / --surface / --fg / --accent ...）改配色；
 * 需要改结构时可用 body[data-skin="皮肤id"] 作用域写任意选择器。
 * 图片/字体等资源允许随包上传，CSS 里用相对路径引用，运行时统一走 /api/skins/:id/file/:path。
 *
 * 存储：元数据进 db('skins')，文件落地 DATA_DIR/skins/<皮肤id>/。
 * 上架/下架由 isPublic 控制：仅本人可见 vs 所有人可用。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseZip, ZipError } = require('./zipread');

/** 单个皮肤包解压后的体积上限（防压缩包炸弹），10MB */
const MAX_UNPACKED = 10 * 1024 * 1024;
/** 上传 ZIP 本体上限，3MB */
const MAX_ZIP = 3 * 1024 * 1024;
/** 允许的文件扩展名（CSS / 图片 / 字体 / 文本） */
const ALLOW_EXT = /\.(css|png|jpe?g|gif|webp|svg|woff2?|ttf|otf|json|txt)$/i;
/** manifest 字段长度上限 */
const STR_MAX = 120;

function cleanStr(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || STR_MAX);
}

/** 校验并规范化 manifest */
function parseManifest(entries) {
  const mf = entries.find((e) => e.name.toLowerCase() === 'manifest.json');
  if (!mf) throw new ZipError('缺少 manifest.json');
  let m;
  try { m = JSON.parse(mf.data.toString('utf8')); }
  catch (e) { throw new ZipError('manifest.json 不是合法 JSON'); }
  if (!m || typeof m !== 'object') throw new ZipError('manifest.json 内容无效');

  const id = cleanStr(m.id, 48).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,47}$/.test(id)) {
    throw new ZipError('皮肤 id 只能用小写字母/数字/横线/下划线，长度 2-48');
  }
  const entry = cleanStr(m.entry || 'skin.css', 120).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!entry || !ALLOW_EXT.test(entry) || !/\.css$/i.test(entry)) {
    throw new ZipError('入口 CSS（entry）必须是包内的 .css 文件');
  }
  if (!entries.some((e) => e.name.toLowerCase() === entry.toLowerCase())) {
    throw new ZipError('入口 CSS 不存在：' + entry);
  }
  let preview = cleanStr(m.preview || '', 120).replace(/\\/g, '/').replace(/^\.\//, '');
  if (preview) {
    if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(preview) ||
        !entries.some((e) => e.name.toLowerCase() === preview.toLowerCase())) {
      preview = '';   // 预览图无效就忽略，不阻断上传
    }
  }
  return {
    id,
    name: cleanStr(m.name, 40) || id,
    version: cleanStr(m.version, 24) || '1.0.0',
    author: cleanStr(m.author, 40),
    description: cleanStr(m.description, 160),
    entry,
    preview
  };
}

function publicSkin(s, user) {
  return {
    id: s.id, name: s.name, version: s.version, author: s.author,
    description: s.description,
    preview: s.preview
      ? (s.builtin ? '/skins/' + s.id + '/' + s.preview : '/api/skins/' + s.id + '/file/' + encodeURI(s.preview))
      : '',
    isPublic: !!s.isPublic, builtin: !!s.builtin,
    ownerId: s.ownerId, mine: !!(user && s.ownerId === user.id),
    createdAt: s.createdAt,
    url: s.builtin
      ? '/skins/' + s.id + '/' + s.entry
      : '/api/skins/' + s.id + '/file/' + encodeURI(s.entry)
  };
}

/**
 * 注册皮肤路由。
 * @param deps { route, db, ok, fail, readBinary, SKIN_DIR, builtin }
 */
function registerSkins(deps) {
  const { route, db, ok, fail, readBinary, SKIN_DIR, builtin } = deps;
  fs.mkdirSync(SKIN_DIR, { recursive: true });

  function skinDir(id) { return path.join(SKIN_DIR, id); }

  function writeFiles(id, entries) {
    const dir = skinDir(id);
    fs.mkdirSync(dir, { recursive: true });
    for (const e of entries) {
      const target = path.join(dir, e.name);
      // 二次校验：解压后的名字也不能跑出目录
      if (!target.startsWith(dir + path.sep)) throw new ZipError('非法文件路径：' + e.name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.data);
    }
  }

  function removeFiles(id) {
    const dir = skinDir(id);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  // 把内置皮肤写进 db（幂等），这样列表逻辑只需查一处
  function ensureBuiltin() {
    for (const b of builtin) {
      if (!db.get('skins', b.id)) {
        db.put('skins', {
          id: b.id, name: b.name, version: b.version, author: '系统内置',
          description: b.description, entry: b.entry, preview: 'preview.svg',
          isPublic: true, builtin: true, ownerId: '', createdAt: Date.now(),
          files: b.files
        });
      }
    }
  }
  ensureBuiltin();

  /** 列表：内置 + 全部公开 + 本人私有 */
  route('GET', '/api/skins', async (req, res, ctx) => {
    const all = db.list('skins');
    const mine = all.filter((s) => s.builtin || s.isPublic || (ctx.user && s.ownerId === ctx.user.id));
    mine.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    ok(res, { skins: mine.map((s) => publicSkin(s, ctx.user)) });
  });

  /** 上传皮肤 ZIP（二进制 body，Content-Type: application/zip） */
  route('POST', '/api/skins', async (req, res, ctx) => {
    let buf;
    try { buf = await readBinary(req, MAX_ZIP); }
    catch (e) { return fail(res, 413, '皮肤包超过 3MB 上限'); }
    let entries;
    try { entries = parseZip(buf); }
    catch (e) { return fail(res, 400, e.message || 'ZIP 解析失败'); }

    let total = 0;
    for (const e of entries) {
      total += e.data.length;
      if (!ALLOW_EXT.test(e.name)) return fail(res, 400, '皮肤包含不允许的文件类型：' + e.name);
    }
    if (total > MAX_UNPACKED) return fail(res, 413, '皮肤包解压后超过 10MB');

    let meta;
    try { meta = parseManifest(entries); }
    catch (e) { return fail(res, 400, e.message || 'manifest.json 校验失败'); }

    let id = meta.id;
    // 内置 id 保留，用户撞名自动加后缀
    if (db.get('skins', id) || builtin.some((b) => b.id === id)) {
      id = id + '-' + crypto.randomBytes(2).toString('hex');
    }
    writeFiles(id, entries);
    const doc = {
      id, name: meta.name, version: meta.version, author: meta.author,
      description: meta.description, entry: meta.entry, preview: meta.preview,
      isPublic: false, builtin: false, ownerId: ctx.user.id, createdAt: Date.now()
    };
    db.put('skins', doc);
    ok(res, { skin: publicSkin(doc, ctx.user) });
  });

  /** 取皮肤内的文件；私有皮肤仅本人可读 */
  route('GET', '/api/skins/:id/file/:name', async (req, res, ctx) => {
    const s = db.get('skins', ctx.params.id);
    if (!s) return fail(res, 404, '皮肤不存在');
    if (!s.isPublic && !s.builtin && (!ctx.user || s.ownerId !== ctx.user.id)) {
      return fail(res, 403, '这个皮肤是私密的');
    }
    const rel = decodeURIComponent(ctx.params.name).replace(/\\/g, '/');
    if (!rel || rel.indexOf('..') >= 0 || !ALLOW_EXT.test(rel)) return fail(res, 400, '非法文件路径');

    let file;
    if (s.builtin) {
      // 内置皮肤文件随源码发布，存在 PUBLIC_DIR/skins/<id>/ 下
      file = path.join(deps.PUBLIC_DIR, 'skins', s.id, rel);
    } else {
      file = path.join(skinDir(s.id), rel);
      if (!file.startsWith(skinDir(s.id) + path.sep)) return fail(res, 400, '非法文件路径');
    }
    let buf;
    try { buf = fs.readFileSync(file); }
    catch (e) { return fail(res, 404, '文件不存在'); }

    const ext = rel.split('.').pop().toLowerCase();
    const MIME = {
      css: 'text/css; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
      woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
      json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8'
    };
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': s.builtin ? 'public, max-age=3600' : 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  }, false);

  /** 公开/私有切换：仅本人 */
  route('POST', '/api/skins/:id/public', async (req, res, ctx) => {
    const s = db.get('skins', ctx.params.id);
    if (!s || s.builtin) return fail(res, 404, '皮肤不存在');
    if (s.ownerId !== ctx.user.id) return fail(res, 403, '只能管理自己的皮肤');
    const b = await readBinary(req, 1024);
    let v;
    try { v = JSON.parse(b.toString('utf8')); } catch (e) { v = {}; }
    s.isPublic = !!v.isPublic;
    db.put('skins', s);
    ok(res, { skin: publicSkin(s, ctx.user) });
  });

  /** 删除皮肤：仅本人 */
  route('DELETE', '/api/skins/:id', async (req, res, ctx) => {
    const s = db.get('skins', ctx.params.id);
    if (!s || s.builtin) return fail(res, 404, '皮肤不存在');
    if (s.ownerId !== ctx.user.id) return fail(res, 403, '只能删除自己的皮肤');
    db.del('skins', s.id);
    removeFiles(s.id);
    ok(res, { ok: true });
  });
}

module.exports = { registerSkins, parseManifest, parseZip };
