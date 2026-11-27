'use strict';
/**
 * 皮肤系统专项测试。
 * 覆盖：内置皮肤可见 / ZIP 上传 / manifest 校验 / 私密隔离 / 公开切换 / 删除 / 文件读取。
 * 用法：TEST_BASE=http://127.0.0.1:PORT node test/skins.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3311';
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (extra ? ' :: ' + JSON.stringify(extra) : '')); }
}
async function req(method, p, body, token, rawBody, contentType, extraHeaders) {
  const headers = {};
  if (token) headers['X-Token'] = token;
  if (extraHeaders) Object.assign(headers, extraHeaders);
  let payload;
  if (rawBody) { headers['Content-Type'] = contentType || 'application/octet-stream'; payload = rawBody; }
  else if (body !== undefined && body !== null) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + p, { method, headers, body: payload });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  return { status: r.status, json, text };
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function makeZip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(raw), crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, comp]); locals.push(local);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    centrals.push(Buffer.concat([ch, name]));
    off += local.length;
  }
  const cd = Buffer.concat(centrals), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

(async () => {
  const suffix = Date.now().toString().slice(-6);
  const A = 'skA' + suffix, B = 'skB' + suffix, PW = 'Pw' + suffix + 'x';
  for (const u of [A, B]) {
    const r = await req('POST', '/api/register', { username: u, password: PW, nickname: u });
    check('注册 ' + u, r.status === 200, r.json);
  }
  const la = await req('POST', '/api/login', { username: A, password: PW });
  const lb = await req('POST', '/api/login', { username: B, password: PW });
  const ta = la.json.token, tb = lb.json.token;

  // 1. 内置皮肤
  let r = await req('GET', '/api/skins', null, ta);
  check('列表含内置 openwire', r.status === 200 && (r.json.skins || []).some((s) => s.id === 'openwire' && s.builtin), r.json);
  check('列表含内置 washi（暖纸存档版）', (r.json.skins || []).some((s) => s.id === 'washi' && s.builtin), r.json);
  const builtin = (r.json.skins || []).find((s) => s.id === 'openwire');
  check('内置皮肤有预览图', !!(builtin && builtin.preview), builtin);
  const readSkinCss = (id) => fs.readFileSync(path.join(__dirname, '..', 'public', 'skins', id, 'skin.css'), 'utf8');
  const openwireCss = readSkinCss('openwire');
  const washiCss = readSkinCss('washi');
  check('washi 有真正的深色配色（非调亮度）', /:root\[data-theme="dark"\]/.test(washiCss) && /--bg:\s*#1c1c18/i.test(washiCss));
  check('washi 不用黑底大白边', !/#11110f/i.test(washiCss) && !/background:\s*#000/i.test(washiCss));
  check('openwire 保留原始粗黑荧光黄风格', /#11110f/i.test(openwireCss) && /#ffd43b/i.test(openwireCss));

  // 1a. 参考案例做的 12 套内置皮肤：数量、托管、深浅两套配色
  const NEW_SKIN_IDS = ['inkscroll','sky','plain','vermilion','parchment','mint',
    'nightgold','oldpaper','pine','deepsea','cloud','grey'];
  const builtins = (r.json.skins || []).filter((s) => s.builtin);
  check('内置皮肤共 14 套（原 2 + 新 12）', builtins.length >= 14, builtins.map((s) => s.id));
  check('12 套新皮肤都在列表里', NEW_SKIN_IDS.every((id) => builtins.some((s) => s.id === id)), builtins.map((s) => s.id));
  let pairOk = 0;
  for (const id of NEW_SKIN_IDS) {
    const css = readSkinCss(id);
    const lightBg = (css.match(/--bg:\s*(#[0-9a-f]{6})/i) || [])[1];
    const darkBg = (css.match(/--bg:\s*(#[0-9a-f]{6})[\s\S]*data-theme="dark"[\s\S]*?--bg:\s*(#[0-9a-f]{6})/i) || [])[2];
    if (lightBg && darkBg && lightBg.toLowerCase() !== darkBg.toLowerCase() &&
        /html\[data-skin="/.test(css)) pairOk++;
  }
  check('12 套新皮肤都有浅深两套不同配色和风格样式', pairOk === 12, pairOk);

  // 1c. 顶栏 / 预览标题条的文字对比度（防止字色和背景太接近看不清）
  const relLum = (hex) => {
    const h = hex.replace('#', '');
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(parseInt(h.slice(0, 2), 16)) +
           0.7152 * lin(parseInt(h.slice(2, 4), 16)) +
           0.0722 * lin(parseInt(h.slice(4, 6), 16));
  };
  const wcag = (a, b) => {
    const x = Math.max(relLum(a), relLum(b)), y = Math.min(relLum(a), relLum(b));
    return (x + 0.05) / (y + 0.05);
  };
  let contrastOk = 0, contrastBad = [];
  for (const id of NEW_SKIN_IDS) {
    const css = readSkinCss(id);
    const pv = fs.readFileSync(path.join(__dirname, '..', 'public', 'skins', id, 'preview.svg'), 'utf8');
    const split = css.indexOf('data-theme="dark"');
    const segments = [css.slice(0, split), css.slice(split)];
    const bars = pv.match(/<rect[^>]*height="30"[^>]*fill="([^"]+)"/g) || [];
    const textFills = pv.match(/<text[^>]*fill="([^"]+)"/g) || [];
    let allOk = true;
    for (let s = 0; s < 2; s++) {
      const tbg = (segments[s].match(/--topbar-bg:\s*(#[0-9a-f]{6})/i) || [])[1];
      const tfg = (segments[s].match(/--topbar-fg:\s*(#[0-9a-f]{6})/i) || [])[1];
      if (!tbg || !tfg || wcag(tbg, tfg) < 4.5) { allOk = false; break; }
      const bar = (bars[s] || '').match(/fill="(#[0-9a-f]{6})"/i);
      const fill = (textFills[s] || '').match(/fill="(#[0-9a-f]{6})"/i);
      if (!bar || !fill || wcag(bar[1], fill[1]) < 4.5) { allOk = false; break; }
    }
    if (allOk) contrastOk++; else contrastBad.push(id);
  }
  check('12 套皮肤顶栏/预览标题条文字对比度均≥4.5', contrastOk === 12, contrastBad);

  // 1d. 扩展皮肤（43 套）：总数 50+、每套有 style/tone 元数据、深浅配色齐、对比度达标
  const EXT_SKIN_IDS = ['rouge','indigo','amber','bamboo','lotus','crow','maple','silk','denim',
    'pine-soot','sandal','lilac','bamboo-moon','dai-blue','autumn','fei','azurite','tea','scallion',
    'moon-white','coral','wisteria','pine-flower','celadon','crimson','pale-blue','ginger','forest',
    'peach','sky-cyan','chestnut','rosewood','scallion-2','navy','honey','smoke','madder','spring',
    'guihua','frost','plum','jasper','clay'];
  check('内置皮肤总数≥55 套', builtins.length >= 55, builtins.length);
  check('43 套扩展皮肤全在列表里', EXT_SKIN_IDS.every((id) => builtins.some((s) => s.id === id)),
    EXT_SKIN_IDS.filter((id) => !builtins.some((s) => s.id === id)));
  check('扩展皮肤带 style/tone 风格元数据', EXT_SKIN_IDS.every((id) => {
    const s = builtins.find((b) => b.id === id); return s && s.style && s.tone;
  }), 'meta');
  let extOk = 0;
  for (const id of EXT_SKIN_IDS) {
    const css = readSkinCss(id);
    const pv = fs.readFileSync(path.join(__dirname, '..', 'public', 'skins', id, 'preview.svg'), 'utf8');
    const split = css.indexOf('data-theme="dark"');
    const segs = [css.slice(0, split), css.slice(split)];
    const bars = pv.match(/<rect[^>]*height="30"[^>]*fill="([^"]+)"/g) || [];
    const texts = pv.match(/<text[^>]*fill="([^"]+)"/g) || [];
    let ok = true;
    for (let s = 0; s < 2; s++) {
      const tbg = (segs[s].match(/--topbar-bg:\s*(#[0-9a-f]{6})/i) || [])[1];
      const tfg = (segs[s].match(/--topbar-fg:\s*(#[0-9a-f]{6})/i) || [])[1];
      if (!tbg || !tfg || wcag(tbg, tfg) < 4.5) { ok = false; break; }
      const bar = (bars[s] || '').match(/fill="(#[0-9a-f]{6})"/i);
      const fill = (texts[s] || '').match(/fill="(#[0-9a-f]{6})"/i);
      if (!bar || !fill || wcag(bar[1], fill[1]) < 4.5) { ok = false; break; }
    }
    if (ok) extOk++;
  }
  check('43 套扩展皮肤顶栏/预览对比度均≥4.5', extOk === 43, extOk);

  // 1b. 直接上传一份 CSS 就能做皮肤（自动生成 manifest 和预览图）
  const cssText = ':root{--bg:#abcdef}\n:root[data-theme="dark"]{--bg:#101010}';
  r = await req('POST', '/api/skins', null, ta, Buffer.from(cssText, 'utf8'),
    'application/octet-stream', { 'X-Skin-Name': encodeURIComponent('CSS皮肤' + suffix), 'X-File-Name': 'mine.css' });
  check('直接上传 CSS 成功', r.status === 200 && r.json.skin && /^css-/.test(r.json.skin.id), r.json);
  const cssId = r.json.skin && r.json.skin.id;
  check('CSS 皮肤自动生成预览图', !!(r.json.skin && r.json.skin.preview), r.json.skin);
  r = await req('GET', '/api/skins/' + cssId + '/file/skin.css', null, ta);
  check('CSS 文件内容正确', r.status === 200 && /abcdef/.test(r.text), r.status);
  r = await req('GET', '/api/skins/' + cssId + '/file/preview.svg', null, ta);
  check('自动预览图可访问', r.status === 200 && /<svg/.test(r.text), r.status);

  // 2. 上传合法 ZIP
  const id = 'testskin' + suffix;
  const manifest = { id, name: '测试皮肤', version: '1.0.0', author: 'tester', description: 'desc', entry: 'skin.css', preview: 'preview.svg' };
  const zip = makeZip([
    { name: 'manifest.json', data: JSON.stringify(manifest) },
    { name: 'skin.css', data: ':root{--accent:#123456}' },
    { name: 'preview.svg', data: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' }
  ]);
  r = await req('POST', '/api/skins', null, ta, zip, 'application/zip');
  check('上传 ZIP 成功', r.status === 200 && r.json.skin && r.json.skin.id === id, r.json);
  check('新皮肤默认私密', r.json.skin && r.json.skin.isPublic === false, r.json.skin);

  // 3. 私密隔离：B 看不到，也读不到文件
  r = await req('GET', '/api/skins', null, tb);
  check('B 列表看不到 A 的私密皮肤', !(r.json.skins || []).some((s) => s.id === id), r.json.skins);
  r = await req('GET', '/api/skins/' + id + '/file/skin.css', null, tb);
  check('B 读不到私密皮肤文件', r.status === 403, r.status);
  r = await req('GET', '/api/skins/' + id + '/file/skin.css', null, ta);
  check('A 能读到自己的皮肤文件', r.status === 200 && /123456/.test(r.text), r.status);

  // 4. 公开切换
  r = await req('POST', '/api/skins/' + id + '/public', null, ta, Buffer.from(JSON.stringify({ isPublic: true })), 'application/octet-stream');
  check('设为公开成功', r.status === 200 && r.json.skin.isPublic === true, r.json);
  r = await req('GET', '/api/skins', null, tb);
  check('B 现在能看到公开皮肤', (r.json.skins || []).some((s) => s.id === id), r.json.skins);
  r = await req('GET', '/api/skins/' + id + '/file/skin.css', null, tb);
  check('B 能读公开皮肤文件', r.status === 200 && /123456/.test(r.text), r.status);

  // 5. 非法 manifest 被拒
  const badZip = makeZip([
    { name: 'manifest.json', data: JSON.stringify({ id: 'bad', name: 'x', entry: 'nope.css' }) }
  ]);
  r = await req('POST', '/api/skins', null, ta, badZip, 'application/zip');
  check('入口 CSS 不存在被拒', r.status === 400, r.status);
  const badZip2 = makeZip([
    { name: 'manifest.json', data: JSON.stringify({ id: 'BAD ID!', name: 'x', entry: 'skin.css' }) },
    { name: 'skin.css', data: '/*x*/' }
  ]);
  r = await req('POST', '/api/skins', null, ta, badZip2, 'application/zip');
  check('非法 id 被拒', r.status === 400, r.status);

  // 6. 内置皮肤文件可通过静态路径读到
  r = await req('GET', '/skins/openwire/skin.css', null, null);
  check('内置皮肤 CSS 可访问', r.status === 200 && /OPENWIRE/i.test(r.text), r.status);
  r = await req('GET', '/skins/example-skin.zip', null, null);
  check('示例包可下载', r.status === 200 && r.text.length > 100, r.status);
  r = await req('GET', '/skins/example-skin.css', null, null);
  check('最简 CSS 示例可下载', r.status === 200 && /data-theme="dark"/.test(r.text), r.status);

  // 7. 删除
  r = await req('DELETE', '/api/skins/' + cssId, null, ta);
  check('删除 CSS 皮肤', r.status === 200, r.status);
  r = await req('DELETE', '/api/skins/' + id, null, ta);
  check('删除自己的皮肤', r.status === 200, r.status);
  r = await req('GET', '/api/skins', null, ta);
  check('删除后列表不再有', !(r.json.skins || []).some((s) => s.id === id), r.json.skins);
  r = await req('DELETE', '/api/skins/openwire', null, ta);
  check('内置皮肤不可删除', r.status === 404, r.status);

  // 清理测试账号
  await req('POST', '/api/account/delete', { confirm: true }, ta);
  await req('POST', '/api/account/delete', { confirm: true }, tb);

  console.log('\n皮肤专项：通过:' + pass + ' 失败:' + fail);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(2); });
