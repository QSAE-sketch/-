'use strict';
/**
 * 房间功能专项测试：
 *   A. 设备/浏览器能力分级 + 服务器分发低配/标准版网页
 *   B. 两版共用同一套数据（账号 / 房间 / 消息 / 文件互通）
 *   C. 群/房间专属昵称（与全局昵称独立、互不同步）
 *   D. 群主转让生效后的房间内系统通知（两种文案 + 群内昵称 + 仅本房间）
 *   E. 解散群聊（角色 / 二次确认 / 停用 / 向成员发通知）
 *   F. 不影响其它用户与其它房间
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'http://127.0.0.1:' + (process.env.PORT || 3311);
const ROOT = path.join(__dirname, '..');
const OLD_UA = 'Mozilla/5.0 (Linux; Android 5.1; Redmi Note 2 Build/LMY47D) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/39.0.0.0 Mobile Safari/537.36';
const NEW_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
let pass = 0, fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 260) : '')); }
}
function req(method, urlPath, body, token, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const data = (body === undefined || body === null) ? null
      : (opts.raw ? body : Buffer.from(JSON.stringify(body)));
    const headers = Object.assign({}, opts.headers || {});
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Type'] = opts.raw ? 'application/octet-stream' : 'application/json';
    if (!headers['User-Agent']) headers['User-Agent'] = NEW_UA;
    const u = new URL(urlPath, BASE);
    const r = http.request({
      hostname: u.hostname, port: u.port,
      path: u.pathname + u.search, method, headers
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(cs);
        let j = null;
        try { j = JSON.parse(raw.toString()); } catch (e) { /* HTML / 二进制 */ }
        resolve({ status: res.statusCode, json: j, text: raw.toString(), raw, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
async function register(prefix, nickname, opts) {
  const username = prefix + crypto.randomBytes(3).toString('hex');
  const r = await req('POST', '/api/register', { username, password: 'pass123', nickname }, null, opts);
  const me = await req('GET', '/api/me', null, r.json.token, opts);
  return { username, token: r.json.token, id: me.json.user.id, nickname };
}
async function createRoom(owner, name, opts) {
  const r = await req('POST', '/api/rooms', { name }, owner.token, opts);
  return r.json.room.id;
}
async function join(token, roomId, opts) {
  return req('POST', '/api/rooms/' + roomId + '/join', {}, token, opts);
}
async function msgs(token, roomId, opts) {
  const r = await req('GET', '/api/rooms/' + roomId + '/messages?since=0&limit=200', null, token, opts);
  return r.json.messages || [];
}
function systemTexts(list) {
  return list.filter((m) => m.kind === 'system').map((m) => m.content);
}
function hasText(list, text) {
  return list.some((m) => m.kind === 'system' && m.content === text);
}
async function uploadFile(token, roomId, payload, opts) {
  let r = await req('POST', '/api/files/init', {
    name: 't.bin', size: payload.length, mime: 'application/octet-stream', roomId
  }, token, opts);
  if (r.status !== 200) return { ok: false, init: r.status };
  const fid = r.json.fileId, cs = r.json.chunkSize;
  await req('PUT', '/api/files/' + fid + '/chunk?i=0', payload.slice(0, cs), token, Object.assign({ raw: true }, opts || {}));
  r = await req('POST', '/api/files/' + fid + '/complete', {}, token, opts);
  return { ok: r.status === 200, fileId: fid, complete: r.status };
}

(async () => {
  /* ---------------- A. 能力分级 + 服务器分发 ---------------- */
  console.log('\n【A】设备能力分级与双版本分发');

  let r = await req('GET', '/', null, null, { headers: { 'User-Agent': OLD_UA } });
  check('红米 Note 2 / Android 5.1 / Chrome39 → 基础版（最保守档）', r.status === 200 &&
    r.text.indexOf('data-ll-cap="basic"') >= 0 && r.text.indexOf('app-basic.js') >= 0, r.status);
  check('基础版不加载标准版与低配版脚本', r.text.indexOf('src="/app.js"') < 0 &&
    r.text.indexOf('src="/app-lite.js"') < 0);
  check('基础版内联了守门脚本', r.text.indexOf('__LL_LITE') < 0 && r.text.indexOf('__LL') >= 0);

  r = await req('GET', '/', null, null, { headers: { 'User-Agent': NEW_UA } });
  check('现代浏览器 → 标准版', r.status === 200 && r.text.indexOf('能力探测') >= 0 &&
    r.text.indexOf('src="/app.js?v=') >= 0, r.status);

  r = await req('GET', '/?lite=1&sharecode=TESTCODE', null, null, { headers: { 'User-Agent': NEW_UA } });
  check('?lite=1 强制低配并写 cookie', r.text.indexOf('data-ll-cap="lite"') >= 0 &&
    /ll_cap=lite/.test(String(r.headers['set-cookie'] || '')), String(r.headers['set-cookie']));
  check('版本切换链接保留 sharecode', r.text.indexOf('sharecode=TESTCODE&lite=0') >= 0,
    (r.text.match(/href="[^"]*lite=0[^"]*"/) || [''])[0]);

  r = await req('GET', '/?lite=0', null, null, { headers: { 'User-Agent': OLD_UA } });
  check('?lite=0 强制标准版', r.text.indexOf('src="/app.js?v=') >= 0);

  /* ---- 第三档：基础版（basic）---- */
  r = await req('GET', '/?lite=2&sharecode=TESTCODE', null, null, { headers: { 'User-Agent': NEW_UA } });
  check('?lite=2 强制基础版并写 cookie', r.text.indexOf('data-ll-cap="basic"') >= 0 &&
    /ll_cap=basic/.test(String(r.headers['set-cookie'] || '')), String(r.headers['set-cookie']));
  check('基础版切换链接保留 sharecode', /sharecode=TESTCODE&lite=1/.test(r.text),
    (r.text.match(/href="[^"]*lite=1[^"]*"/) || [''])[0]);

  r = await req('GET', '/', null, null, { headers: { 'User-Agent': NEW_UA, Cookie: 'll_cap=basic' } });
  check('客户端探测 cookie → 基础版', r.text.indexOf('data-ll-cap="basic"') >= 0);
  r = await req('GET', '/', null, null, { headers: { 'User-Agent': NEW_UA, 'X-LL-Cap': 'basic' } });
  check('原生容器能力头 → 基础版', r.text.indexOf('data-ll-cap="basic"') >= 0);

  /* 关键：用户早先在低配版点过切换、cookie 记着 lite，也不能把老设备锁死在跑不动的那版 */
  r = await req('GET', '/', null, null, { headers: { 'User-Agent': OLD_UA, Cookie: 'll_cap=lite' } });
  check('老设备即使 cookie 记着 lite，仍被纠正到基础版（不被锁死）',
    r.text.indexOf('data-ll-cap="basic"') >= 0, r.text.indexOf('data-ll-cap="lite"') >= 0 ? '仍返回 lite' : '');
  r = await req('GET', '/', null, null, { headers: { 'User-Agent': OLD_UA, 'X-LL-Cap': 'lite' } });
  check('老设备容器要求 lite 时同样纠正到基础版',
    r.text.indexOf('data-ll-cap="basic"') >= 0);
  // 但用户主动在地址栏指定 lite 时仍然尊重（他自己要试）
  r = await req('GET', '/?lite=1', null, null, { headers: { 'User-Agent': OLD_UA } });
  check('老设备显式 ?lite=1 仍尊重用户选择', r.text.indexOf('data-ll-cap="lite"') >= 0);

  // 更老的内核（Android 4.4 / Chrome 33）也必须落到基础版
  const ANCIENT_UA = 'Mozilla/5.0 (Linux; Android 4.4.2; HM NOTE 1LTE Build/KOT49H) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/33.0.0.0 Mobile Safari/537.36';
  r = await req('GET', '/', null, null, { headers: { 'User-Agent': ANCIENT_UA } });
  check('Android 4.4 / Chrome33 → 基础版', r.text.indexOf('data-ll-cap="basic"') >= 0);

  // 静态资源可访问
  r = await req('GET', '/index-basic.html', null, null, { headers: { 'User-Agent': NEW_UA } });
  check('GET /index-basic.html 可访问', r.status === 200 && r.raw.length > 2000, r.status);
  r = await req('GET', '/app-basic.js', null, null, { headers: { 'User-Agent': NEW_UA } });
  check('GET /app-basic.js 可访问', r.status === 200 && r.raw.length > 8000, r.status);
  r = await req('GET', '/style-basic.css', null, null, { headers: { 'User-Agent': NEW_UA } });
  check('GET /style-basic.css 可访问', r.status === 200 && r.raw.length > 2000, r.status);

  // 基础版必须真正「更保守」：这些特性一个都不许出现
  const basicJs = fs.readFileSync(path.join(ROOT, 'public/app-basic.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const basicCss = fs.readFileSync(path.join(ROOT, 'public/style-basic.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const basicHtml = fs.readFileSync(path.join(ROOT, 'public/index-basic.html'), 'utf8');

  check('基础版 JS 无 ES6+ 语法', !/=>|\blet\s|\bconst\s|`/.test(basicJs));
  check('基础版 JS 不用 Promise / fetch / classList / dataset',
    !/Promise|fetch\(|classList|dataset|addEventListener/.test(basicJs));
  check('基础版 JS 不用 Array.forEach/map/filter（老内核手写循环）',
    !/\.forEach\(|\.map\(|\.filter\(/.test(basicJs));
  check('基础版 JS 不用 String.trim / Date.now',
    !/\.trim\(\)|Date\.now\(/.test(basicJs));
  check('基础版 JS 不设 xhr.timeout（改用 setTimeout）',
    !/\.timeout\s*=/.test(basicJs) && basicJs.indexOf('setTimeout') >= 0);
  check('基础版 CSS 零 position:fixed（老 WebView 重绘 bug）',
    basicCss.indexOf('position: fixed') < 0 && basicCss.indexOf('position:fixed') < 0);
  check('基础版 CSS 零 flex / CSS 变量 / vh / calc / rem',
    !/var\(--|display\s*:\s*flex|\d+vh|\d+vw|calc\(|\d+rem/.test(basicCss));
  check('基础版 CSS 零圆角与阴影（规避老内核渲染差异）',
    !/border-radius|box-shadow/.test(basicCss));
  check('基础版 HTML 标记 data-ll-cap=basic', basicHtml.indexOf('data-ll-cap="basic"') >= 0);
  check('基础版 HTML 不含金色烫金元素（保持低配一致）',
    basicHtml.indexOf('d4af37') < 0 && basicCss.indexOf('d4af37') < 0);
  check('基础版 HTML 自带设备自检入口', /设备自检/.test(basicHtml));

  r = await req('GET', '/', null, null, { headers: { 'User-Agent': NEW_UA, 'Device-Memory': '0.5' } });
  check('低内存设备 → 低配版', r.text.indexOf('data-ll-cap="lite"') >= 0);
  r = await req('GET', '/', null, null, { headers: { 'User-Agent': NEW_UA, 'Save-Data': 'on' } });
  check('省流量模式 → 低配版', r.text.indexOf('data-ll-cap="lite"') >= 0);
  r = await req('GET', '/', null, null, { headers: { 'User-Agent': NEW_UA, Cookie: 'll_cap=lite' } });
  check('客户端探测 cookie → 低配版', r.text.indexOf('data-ll-cap="lite"') >= 0);
  r = await req('GET', '/', null, null, { headers: { 'User-Agent': NEW_UA, 'X-LL-Cap': 'lite' } });
  check('原生容器能力头 → 低配版', r.text.indexOf('data-ll-cap="lite"') >= 0);

  const liteJs = fs.readFileSync(path.join(ROOT, 'public/app-lite.js'), 'utf8');
  const liteCss = fs.readFileSync(path.join(ROOT, 'public/style-lite.css'), 'utf8');
  const liteHtml = fs.readFileSync(path.join(ROOT, 'public/index-lite.html'), 'utf8');
  const stdHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  // 先剥掉注释：文件头注释里正好列举了这些禁用词，别把它们误判成代码
  const liteJsCode = liteJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('低配 JS 纯 ES5（无箭头/let/const/Promise/fetch/classList/dataset）',
    !/=>|\blet\s|\bconst\s|Promise|fetch\(|classList|dataset|addEventListener/.test(liteJsCode));
  check('低配 CSS 无 CSS 变量 / flex / vh / calc / rem 单位',
    !/var\(--|display\s*:\s*flex|\d+vh|\d+vw|calc\(|\d+rem/.test(liteCss));
  check('低配 HTML 标记 data-ll-cap=lite', liteHtml.indexOf('data-ll-cap="lite"') >= 0);
  check('标准版含能力探测引导（CSS.supports + localStorage 兜底）',
    stdHtml.indexOf("CSS.supports('color', 'var(--x)')") >= 0 &&
    stdHtml.indexOf('__ll_probe__') >= 0 && stdHtml.indexOf('try') >= 0);

  r = await req('GET', '/app-lite.js', null, null, { headers: { 'User-Agent': OLD_UA } });
  check('GET /app-lite.js 可访问', r.status === 200 && r.raw.length > 10000, r.status);
  r = await req('GET', '/style-lite.css', null, null, { headers: { 'User-Agent': OLD_UA } });
  check('GET /style-lite.css 可访问', r.status === 200 && r.raw.length > 3000, r.status);

  /* ---------------- B. 两版共用同一套数据 ---------------- */
  console.log('\n【B】低配版与标准版数据互通');
  const liteOpts = { headers: { 'User-Agent': OLD_UA } };
  const P = await register('lp', '低配用户', liteOpts);   // 低配设备上注册
  check('老设备 UA 可注册账号', !!P.token);
  r = await req('POST', '/api/login', { username: P.username, password: 'pass123' }, null,
    { headers: { 'User-Agent': NEW_UA } });
  check('标准设备可登录同一账号', r.status === 200 && r.json.user.id === P.id, r.json);

  let g = await req('GET', '/api/rooms', null, P.token, liteOpts);
  const pubId = g.json.publicRoomId;

  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'text', content: '低配端发的消息' },
    P.token, liteOpts);
  check('低配端可发消息', r.status === 200 && r.json.message.content === '低配端发的消息', r.json);
  let list = await msgs(P.token, pubId);
  check('标准端能读到低配端消息', list.some((m) => m.content === '低配端发的消息'));

  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'text', content: '标准端发的消息' },
    P.token);
  check('标准端可发消息', r.status === 200);
  list = await msgs(P.token, pubId, liteOpts);
  check('低配端能读到标准端消息', list.some((m) => m.content === '标准端发的消息'));

  const up = await uploadFile(P.token, pubId, Buffer.from('cross-version-file'), liteOpts);
  check('低配端可分片上传文件', up.ok, up);
  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'file', fileId: up.fileId }, P.token);
  check('标准端可发送低配端上传的文件', r.status === 200 && r.json.message.file, r.json);
  const rawUrl = r.json.message.file.url;
  r = await req('GET', rawUrl, null, P.token, liteOpts);
  check('低配端能下载同一文件字节', r.status === 200 && r.text === 'cross-version-file', r.status);

  /* ---------------- C. 群/房间专属昵称 ---------------- */
  console.log('\n【C】群/房间专属昵称（与全局独立）');
  const A = await register('ra', '甲一');
  const B = await register('rb', '乙二');
  const G1 = await createRoom(A, '昵称群一');
  const G2 = await createRoom(A, '昵称群二');
  await join(B.token, G1);
  await join(B.token, G2);

  r = await req('POST', '/api/rooms/' + G1 + '/nickname', { nickname: '群内甲' }, A.token);
  check('设置 G1 专属昵称成功', r.status === 200 && r.json.displayName === '群内甲' &&
    r.json.globalNickname === '甲一', r.json);
  r = await req('GET', '/api/me', null, A.token);
  check('全局昵称未被同步修改', r.json.user.nickname === '甲一', r.json.user);

  await req('POST', '/api/rooms/' + G1 + '/messages', { kind: 'text', content: 'G1 里发的' }, A.token);
  await req('POST', '/api/rooms/' + G2 + '/messages', { kind: 'text', content: 'G2 里发的' }, A.token);
  const l1 = await msgs(B.token, G1);
  const l2 = await msgs(B.token, G2);
  check('G1 消息显示专属昵称', l1.some((m) => m.content === 'G1 里发的' && m.senderName === '群内甲'),
    l1.filter((m) => m.senderName).map((m) => m.senderName));
  check('G2 消息仍显示全局昵称（互不同步）', l2.some((m) => m.content === 'G2 里发的' && m.senderName === '甲一'),
    l2.filter((m) => m.senderName).map((m) => m.senderName));

  r = await req('GET', '/api/rooms/' + G1 + '/members', null, B.token);
  const aMem = (r.json.members || []).find((m) => m.userId === A.id);
  const bMem = (r.json.members || []).find((m) => m.userId === B.id);
  check('成员列表下发 roomNickname / displayName', aMem && aMem.roomNickname === '群内甲' &&
    aMem.displayName === '群内甲' && aMem.nickname === '甲一', aMem);
  check('其他成员显示不受影响', bMem && bMem.displayName === '乙二' && bMem.roomNickname === '', bMem);
  check('成员列表下发 myRoomNickname', typeof r.json.myRoomNickname === 'string');

  r = await req('POST', '/api/rooms/' + G1 + '/nickname', { nickname: 'x' }, A.token);
  check('1 位昵称被拒 400', r.status === 400, r.json);
  r = await req('POST', '/api/rooms/' + G1 + '/nickname', { nickname: 'x'.repeat(21) }, A.token);
  check('超长昵称被拒 400', r.status === 400, r.json);
  const C = await register('rc', '丙三');
  r = await req('POST', '/api/rooms/' + G1 + '/nickname', { nickname: '非成员' }, C.token);
  check('非成员不能改该房间昵称 403', r.status === 403, r.json);

  r = await req('POST', '/api/rooms/' + G1 + '/nickname', { nickname: '' }, A.token);
  check('清空后回退全局昵称', r.status === 200 && r.json.displayName === '甲一', r.json);
  await req('POST', '/api/rooms/' + G1 + '/nickname', { nickname: '群内甲' }, A.token);

  /* ---------------- D. 群主转让系统通知 ---------------- */
  console.log('\n【D】转让生效后的房间内系统通知');

  // D1 主动转让：文案用双方在本群的专属昵称
  await req('POST', '/api/rooms/' + G1 + '/nickname', { nickname: '受让乙' }, B.token);
  r = await req('POST', '/api/rooms/' + G1 + '/transfer', { userId: B.id }, A.token);
  check('转让缺 confirm 被拒 400', r.status === 400, r.json);
  r = await req('POST', '/api/rooms/' + G1 + '/transfer', { userId: B.id, confirm: true }, A.token);
  check('群主主动转让成功', r.status === 200 && r.json.ownerId === B.id, r.json);
  list = await msgs(B.token, G1);
  check('主动转让发出系统通知，昵称取群内专属昵称',
    hasText(list, '群内甲的群主权限已转让至受让乙'), systemTexts(list));
  check('通知只出现在 G1，不进 G2', !hasText(await msgs(B.token, G2), '群内甲的群主权限已转让至受让乙'));
  r = await req('GET', '/api/rooms/' + G1 + '/members', null, B.token);
  const newOwner = (r.json.members || []).find((m) => m.userId === B.id);
  check('新群主角色与 ownerId 已生效', newOwner && newOwner.role === 'owner', newOwner);
  r = await req('POST', '/api/rooms/' + G1 + '/heir', { heirId: A.id }, B.token);
  check('新群主可以行使群主权限（设继承人）', r.status === 200, r.json);
  const sysMsg = list.find((m) => m.kind === 'system');
  r = await req('POST', '/api/messages/' + sysMsg.id + '/purge', {}, B.token);
  check('系统通知不可被彻底删除', r.status !== 200, r.json);
  r = await req('POST', '/api/messages/' + sysMsg.id + '/recall', {}, B.token);
  check('系统通知不可被撤回', r.status !== 200, r.json);

  // D2 注销 · 固定继承人
  const H1 = await register('rh', '继承甲');
  const H2 = await register('ri', '继承乙');
  const R1 = await createRoom(H1, '继承群一');
  await join(H2.token, R1);
  await req('POST', '/api/rooms/' + R1 + '/nickname', { nickname: '原主甲' }, H1.token);
  await req('POST', '/api/rooms/' + R1 + '/heir', { heirId: H2.id }, H1.token);
  r = await req('POST', '/api/account/delete', { confirm: true }, H1.token);
  check('H1 注销成功', r.status === 200, r.json);
  list = await msgs(H2.token, R1);
  check('固定继承人分支文案 + 群内昵称', hasText(list, '原主甲的群主权限已转让至固定继承人'), systemTexts(list));
  check('该通知不含全局昵称', !systemTexts(list).some((t) => t.indexOf('继承甲') >= 0), systemTexts(list));

  // D3 注销 · 最早加入成员
  const E1 = await register('re', '最早甲');
  const E2 = await register('rf', '最早乙');
  const E3 = await register('rg', '最早丙');
  const R2 = await createRoom(E1, '继位群二');
  await join(E2.token, R2);
  await join(E3.token, R2);
  await req('POST', '/api/rooms/' + R2 + '/nickname', { nickname: '首位乙' }, E2.token);
  r = await req('POST', '/api/account/delete', { confirm: true }, E1.token);
  check('E1 注销成功', r.status === 200, r.json);
  list = await msgs(E2.token, R2);
  check('最早成员继位文案 + 继位者群内昵称',
    hasText(list, '已继位给最早加入的首位乙'), systemTexts(list));
  check('继位通知不出现在别的房间', !hasText(await msgs(B.token, G1), '已继位给最早加入的首位乙'));
  const r2mem = await req('GET', '/api/rooms/' + R2 + '/members', null, E2.token);
  check('最早加入者角色变为群主',
    (r2mem.json.members || []).find((m) => m.userId === E2.id).role === 'owner');

  /* ---------------- E. 解散群聊 ---------------- */
  console.log('\n【E】解散群聊：角色 / 确认 / 停用 / 通知');
  const D1 = await register('rd', '解散甲');
  const D2 = await register('rk', '成员乙');
  const DR = await createRoom(D1, '待解散群');
  await join(D2.token, DR);
  r = await req('POST', '/api/rooms/' + DR + '/dissolve', { confirm: true }, D2.token);
  check('非群主不能解散 403', r.status === 403, r.json);
  r = await req('POST', '/api/rooms/' + DR + '/dissolve', {}, D1.token);
  check('解散缺 confirm 被拒 400', r.status === 400, r.json);
  await req('POST', '/api/rooms/' + DR + '/nickname', { nickname: '解散者甲' }, D1.token);
  r = await req('POST', '/api/rooms/' + DR + '/dissolve', { confirm: true }, D1.token);
  check('群主解散成功', r.status === 200 && r.json.dissolved === true, r.json);

  list = await msgs(D2.token, DR);
  // 文案里现在还会带上「5 天后将自动彻底删除」，所以用前缀匹配而不是全等
  check('成员收到解散系统通知',
    systemTexts(list).some((t) => t.indexOf('本群已由解散者甲解散，现仅可查看历史消息') >= 0),
    systemTexts(list));
  check('解散通知用群内昵称而非全局昵称',
    !systemTexts(list).some((t) => t.indexOf('本群已由解散甲') >= 0), systemTexts(list));

  r = await req('GET', '/api/rooms', null, D2.token);
  const dr = (r.json.rooms || []).find((x) => x.id === DR);
  check('房间列表标记 dissolved=true', dr && dr.dissolved === true, dr);
  r = await req('GET', '/api/rooms/' + DR + '/messages?since=0&limit=200', null, D2.token);
  check('解散后历史消息仍可读（只读存档）', r.status === 200 && r.json.canPost === false &&
    r.json.dissolved === true, { status: r.status, canPost: r.json.canPost });

  r = await req('POST', '/api/rooms/' + DR + '/messages', { kind: 'text', content: '还能发吗' }, D2.token);
  check('解散后发消息被停用 410', r.status === 410, r.json);
  const up2 = await uploadFile(D2.token, DR, Buffer.from('x'));
  check('解散后上传文件被停用 410', up2.ok === false && up2.init === 410, up2);
  const D3 = await register('rz', '后来丙');
  r = await join(D3.token, DR);
  check('解散后不能新加入 410', r.status === 410, r.json);
  r = await req('POST', '/api/rooms/' + DR + '/nickname', { nickname: '改不了' }, D2.token);
  check('解散后不能改群昵称 410', r.status === 410, r.json);
  r = await req('POST', '/api/rooms/' + DR + '/heir', { heirId: D2.id }, D1.token);
  check('解散后不能设继承人 410', r.status === 410, r.json);
  r = await req('POST', '/api/rooms/' + DR + '/dissolve', { confirm: true }, D1.token);
  check('重复解散被拒 410', r.status === 410, r.json);

  /* ---------------- F. 不影响其它用户 / 房间 ---------------- */
  console.log('\n【F】不影响其它用户与其它房间');
  r = await req('GET', '/api/me', null, B.token);
  check('其它账号完好', r.status === 200 && r.json.user.nickname === '乙二', r.json.user);
  list = await msgs(B.token, G2);
  check('其它房间历史消息完好', list.some((m) => m.content === 'G2 里发的'));
  check('公共聊天室不受解散影响', (await msgs(B.token, pubId)).length > 0);
  check('低配端账号在标准端仍可用', (await req('GET', '/api/me', null, P.token)).status === 200);

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常:', e && e.stack ? e.stack : e);
  console.log('\n通过: ' + pass + '  失败: ' + (fail + 1));
  process.exit(1);
});
