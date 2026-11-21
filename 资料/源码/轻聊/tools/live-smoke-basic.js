'use strict';
/**
 * 线上冒烟：老设备三档分发 + 基础版完整业务流。
 *
 * 为什么要单独一个脚本：
 *   红米 Note 2 这类设备的问题只能在真实链路上验，本地 mock 证明不了
 *   「线上代理 + sharecode + 真实云存储」这套组合还成立。
 *
 * 覆盖：
 *   · 三档分发（老 UA→basic、cookie 锁 lite 也被纠正、显式 ?lite 尊重用户）
 *   · 三档静态资源都能取到，且 basic 里确实没有 fixed / FileReader 这类坑
 *   · 基础版会走的完整业务流：注册 → 改昵称 → 发消息 → 上传 → 网盘 → 下载 → 删除 → 注销
 * 结束时自动注销测试账号，云端不留残留。
 */

const https = require('https');
const crypto = require('crypto');

const BASE = process.argv[2] || 'https://qingliao-chat-33476.app.workbuddy.host';
const SHARE = process.argv[3] || 'T7ELJZOC5A';

/* 红米 Note 2 / Android 5.1 / MIUI WebView Chromium 39 */
const OLD_UA = 'Mozilla/5.0 (Linux; Android 5.1; Redmi Note 2 Build/LMY47D) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/39.0.0.0 Mobile Safari/537.36';
/* 更老：Android 4.4 / Chrome 33 */
const ANCIENT_UA = 'Mozilla/5.0 (Linux; Android 4.4.2; HM NOTE 1LTE Build/KOT49H) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/33.0.0.0 Mobile Safari/537.36';
const NEW_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 220) : ''));
  }
}

function request(method, path, body, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    if (!u.searchParams.has('sharecode')) u.searchParams.set('sharecode', SHARE);
    const data = (body === null || body === undefined || o.rawBody)
      ? null : Buffer.from(JSON.stringify(body));
    const headers = { Host: u.host, 'User-Agent': o.ua || 'qingliao-smoke/1.8' };
    if (o.token) headers['X-Token'] = o.token;
    if (o.cookie) headers['Cookie'] = o.cookie;
    if (o.cap) headers['X-LL-Cap'] = o.cap;
    if (data) headers['Content-Type'] = 'application/json';
    if (o.rawBody) headers['Content-Type'] = 'application/octet-stream';
    if (o.rawBody) headers['Content-Length'] = o.rawBody.length;

    const r = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers, timeout: 90000
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(cs);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch (e) { }
        resolve({ status: res.statusCode, json, raw, headers: res.headers });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (data) r.write(data);
    if (o.rawBody) r.write(o.rawBody);
    r.end();
  });
}

/** 按基础版的方式上传：init -> 单片 PUT -> complete */
async function uploadOneChunk(token, name, mime, buf, roomId) {
  const init = await request('POST', '/api/files/init',
    { name, size: buf.length, mime, roomId: roomId || '' }, { token });
  if (init.status !== 200) return { ok: false, stage: 'init', status: init.status, json: init.json };

  const fid = init.json.fileId;
  const put = await request('PUT', '/api/files/' + fid + '/chunk?i=0', null,
    { token, rawBody: buf });
  if (put.status !== 200) return { ok: false, stage: 'chunk', status: put.status, json: put.json };

  const done = await request('POST', '/api/files/' + fid + '/complete', {}, { token });
  if (done.status !== 200) return { ok: false, stage: 'complete', status: done.status, json: done.json };
  return { ok: true, fileId: fid };
}

(async () => {
  console.log('\n========== 线上冒烟：老设备三档分发 + 基础版业务 ==========');

  /* ---------------- A. 三档分发 ---------------- */
  console.log('\n【A】三档分发');

  let r = await request('GET', '/', null, { ua: OLD_UA });
  check('红米 Note 2（Android 5.1 / Chrome 39）→ 基础版',
    r.status === 200 && r.raw.toString().indexOf('data-ll-cap="basic"') >= 0,
    { status: r.status, hit: r.raw.toString().indexOf('data-ll-cap="basic"') });
  check('基础版页面加载的是 app-basic.js',
    r.raw.toString().indexOf('app-basic.js') >= 0);
  check('基础版不加载标准版脚本',
    r.raw.toString().indexOf('src="/app.js"') < 0);
  check('基础版内联了守门脚本（初始化失败可自愈）',
    r.raw.toString().indexOf('__LL') >= 0);

  r = await request('GET', '/', null, { ua: ANCIENT_UA });
  check('Android 4.4 / Chrome 33 → 基础版',
    r.raw.toString().indexOf('data-ll-cap="basic"') >= 0);

  r = await request('GET', '/', null, { ua: OLD_UA, cookie: 'll_cap=lite' });
  check('老设备即使 cookie 记着 lite，也被纠正到基础版（不被锁死）',
    r.raw.toString().indexOf('data-ll-cap="basic"') >= 0);

  r = await request('GET', '/', null, { ua: OLD_UA, cap: 'lite' });
  check('老设备容器要求 lite 时同样纠正到基础版',
    r.raw.toString().indexOf('data-ll-cap="basic"') >= 0);

  r = await request('GET', '/?lite=1', null, { ua: OLD_UA });
  check('显式 ?lite=1 仍尊重用户选择',
    r.raw.toString().indexOf('data-ll-cap="lite"') >= 0);

  r = await request('GET', '/', null, { ua: NEW_UA });
  const fullHtml = r.raw.toString();
  check('现代浏览器 → 标准版',
    fullHtml.indexOf('src="/app.js') >= 0 &&
    fullHtml.indexOf('app-basic') < 0,
    { appjs: fullHtml.indexOf('src="/app.js'), basic: fullHtml.indexOf('app-basic') });

  /* 静态资源都得能取到（线上代理会校验 sharecode，这里走的是同一套） */
  r = await request('GET', '/index-basic.html', null, { ua: NEW_UA });
  check('线上可取到 index-basic.html', r.status === 200 && r.raw.length > 2000, r.status);
  r = await request('GET', '/app-basic.js', null, { ua: NEW_UA });
  const basicJs = r.raw.toString('utf8');
  check('线上可取到 app-basic.js', r.status === 200 && basicJs.length > 8000, r.status);
  r = await request('GET', '/style-basic.css', null, { ua: NEW_UA });
  const basicCss = r.raw.toString('utf8');
  check('线上可取到 style-basic.css', r.status === 200 && basicCss.length > 2000, r.status);

  /* 线上实际下发的内容也要真的「更保守」——注释先剥掉，否则会误判 */
  const basicJsNoCmt = basicJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const basicCssNoCmt = basicCss.replace(/\/\*[\s\S]*?\*\//g, '');
  check('线上基础版 JS 不设 xhr.timeout（改用 setTimeout）', !/\.timeout\s*=/.test(basicJsNoCmt));
  check('线上基础版 JS 不用 forEach/map/filter', !/\.forEach\(|\.map\(|\.filter\(/.test(basicJsNoCmt));
  check('线上基础版 CSS 零 position:fixed', !/position\s*:\s*fixed/.test(basicCssNoCmt));
  check('线上基础版 CSS 零 flex', !/display\s*:\s*flex/.test(basicCssNoCmt));

  /* ---------------- B. 基础版会走的完整业务流 ---------------- */
  console.log('\n【B】基础版业务流（注册 → 消息 → 上传 → 网盘 → 下载 → 注销）');

  const uname = 'bsm' + Date.now().toString().slice(-7);
  r = await request('POST', '/api/register',
    { username: uname, password: 'pass123', nickname: '基础版冒烟' }, { ua: OLD_UA });
  check('基础版 UA 下注册成功', r.status === 200 && !!(r.json && r.json.token), r.json);
  const token = r.json && r.json.token;
  if (!token) {
    console.log('\n注册失败，后续跳过。');
    console.log('\n通过: ' + pass + '  失败: ' + fail);
    process.exit(1);
  }

  r = await request('GET', '/api/me', null, { token, ua: OLD_UA });
  check('基础版拿得到 /api/me', r.status === 200 && r.json.user.username === uname);

  r = await request('POST', '/api/me/nickname', { nickname: '基础版改名' }, { token });
  check('基础版可改全局昵称', r.status === 200 && r.json.user.nickname === '基础版改名', r.json);

  r = await request('GET', '/api/rooms', null, { token });
  const pubId = r.json && r.json.publicRoomId;
  check('基础版拿得到房间列表与公共大厅', r.status === 200 && !!pubId);

  r = await request('POST', '/api/rooms/' + pubId + '/messages',
    { kind: 'text', content: '基础版冒烟消息 ' + uname }, { token });
  check('基础版可发文本消息', r.status === 200, r.json);

  r = await request('GET', '/api/rooms/' + pubId + '/messages?since=0&limit=50', null, { token });
  const found = (r.json && r.json.messages || []).some((m) => String(m.content).indexOf(uname) >= 0);
  check('自己发的消息能拉回来', r.status === 200 && found);
  check('消息接口下发房间状态（canPost / dissolved）',
    r.json && typeof r.json.canPost === 'boolean' && typeof r.json.dissolved === 'boolean');

  /* 上传：基础版是整文件一次发送 */
  const content = crypto.randomBytes(24 * 1024);
  const up = await uploadOneChunk(token, 'basic-test.bin', 'application/octet-stream', content, pubId);
  check('基础版方式（单片直传）上传成功', up.ok, up);

  if (up.ok) {
    r = await request('POST', '/api/rooms/' + pubId + '/messages',
      { kind: 'file', fileId: up.fileId, content: 'basic-test.bin' }, { token });
    check('上传后可作为文件消息发出', r.status === 200, r.json);

    r = await request('GET', '/api/drive/files?page=1&size=30', null, { token });
    const inDrive = (r.json && r.json.items || []).some((f) => f.fileId === up.fileId);
    check('聊天上传的文件同时出现在网盘', r.status === 200 && inDrive);

    r = await request('GET', '/api/drive/storage', null, { token });
    check('配额接口正常且已计入该文件',
      r.status === 200 && r.json.used >= content.length, r.json);

    /* 下载（基础版是 <a href=downloadUrl> 直接跳，不经过 XHR） */
    const detail = await request('GET', '/api/drive/files/' + up.fileId, null, { token });
    const dlUrl = (detail.json && detail.json.downloadUrl) || '';
    check('文件详情里带可直链下载的 downloadUrl', dlUrl.indexOf('/download?k=') >= 0, dlUrl);
    r = await request('GET', dlUrl, null, { token });
    check('基础版下载链接返回原始字节', r.status === 200 && Buffer.compare(r.raw, content) === 0,
      { status: r.status, len: r.raw && r.raw.length });

    r = await request('DELETE', '/api/drive/files/' + up.fileId, null, { token });
    check('基础版可移入回收站', r.status === 200, r.json);

    r = await request('GET', '/api/drive/trash?page=1&size=30', null, { token });
    const inTrash = (r.json && r.json.items || []).some((f) => f.fileId === up.fileId);
    check('回收站能看到该文件', r.status === 200 && inTrash);
  }

  /* 注销：不留残留 */
  r = await request('POST', '/api/account/delete', { confirm: true }, { token });
  check('基础版可注销账号（清理测试数据）', r.status === 200, r.json);

  r = await request('POST', '/api/login', { username: uname, password: 'pass123' }, { ua: OLD_UA });
  check('注销后无法再登录', r.status === 401 || r.status === 400, r.status);

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('冒烟异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
