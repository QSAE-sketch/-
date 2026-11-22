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
async function req(method, p, body, token, rawBody, contentType) {
  const headers = {};
  if (token) headers['X-Token'] = token;
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
  const builtin = (r.json.skins || []).find((s) => s.id === 'openwire');
  check('内置皮肤有预览图', !!(builtin && builtin.preview), builtin);

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
  check('内置皮肤 CSS 可访问', r.status === 200 && /openwire/.test(r.text), r.status);
  r = await req('GET', '/skins/example-skin.zip', null, null);
  check('示例包可下载', r.status === 200 && r.text.length > 100, r.status);

  // 7. 删除
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
