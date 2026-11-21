'use strict';
/**
 * 最高权限专项测试：
 *   A. 权限模块纯逻辑（永久账号 / 30 分钟窗口 / 续期 / 过期）
 *   B. 公共大厅默认不可解散（普通用户、群主都不行）
 *   C. 登录 / 注册时输入权限密钥：错误不阻断登录，正确即开启 30 分钟窗口
 *   D. 最高权限能力：删他人消息、删任意文件、清空房间、解散他人群、注销指定用户
 *   E. 非最高权限调用管理接口一律 403
 *   F. 永久权限账号：标识、消息 senderFounder、不可被注销
 *   G. 金色视觉仅标准版有，低配版完全没有
 *
 * ⚠️ 本文件**故意**不对真实公共大厅提交 confirm=true：
 *    测试面向的是线上同一套云数据，真解散了会把大家的公共大厅停用。
 *    「最高权限可解散公共大厅」用「过头一道闸、返回 400 需要二次确认」来证明，
 *    这足以说明权限校验已通过，而不产生任何破坏。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const perm = require('../src/perm');

const BASE = 'http://127.0.0.1:' + (process.env.PORT || 3311);
const ROOT = path.join(__dirname, '..');
const KEY = process.env.PERM_KEY || perm.DEFAULT_PERM_KEY;
let pass = 0, fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 240) : '')); }
}
function req(method, urlPath, body, token, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const data = (body === undefined || body === null) ? null
      : (opts.raw ? body : Buffer.from(JSON.stringify(body)));
    const headers = Object.assign({}, opts.headers || {});
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Type'] = opts.raw ? 'application/octet-stream' : 'application/json';
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
        try { j = JSON.parse(raw.toString()); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json: j, text: raw.toString(), raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function rnd() { return crypto.randomBytes(3).toString('hex'); }

async function register(prefix, nickname, extra) {
  const username = prefix + rnd();
  const body = Object.assign({ username, password: 'pass123', nickname: nickname || username }, extra || {});
  const r = await req('POST', '/api/register', body, null);
  if (r.status !== 200) return { error: r.status, json: r.json, username };
  const me = await req('GET', '/api/me', null, r.json.token);
  return { username, password: 'pass123', token: r.json.token, id: me.json.user.id, json: r.json, nickname: body.nickname };
}
async function login(username, password, permKey) {
  const body = { username, password };
  if (permKey) body.permKey = permKey;
  return req('POST', '/api/login', body, null);
}
async function createRoom(token, name) {
  const r = await req('POST', '/api/rooms', { name }, token);
  return r.json && r.json.room ? r.json.room.id : null;
}

(async () => {
  /* ================= A. 权限模块纯逻辑 ================= */
  console.log('\n【A】权限模块：永久账号 / 30 分钟窗口 / 续期 / 过期');

  const T0 = 1700000000000;
  const normal = { username: 'someone', nickname: '某人' };
  check('默认密钥可用', perm.keyMatches(perm.DEFAULT_PERM_KEY));
  check('错误密钥被拒', perm.keyMatches('wrong-key') === false);
  check('空密钥被拒', perm.keyMatches('') === false);
  check('普通账号无最高权限', perm.isMaster(normal, T0) === false);

  perm.grantMaster(normal, T0);
  check('授权到期时间 = 使用时刻 + 30 分钟', normal.masterUntil === T0 + 30 * 60000);
  check('使用后 1 分钟仍有效', perm.isMaster(normal, T0 + 60000) === true);
  check('使用后 29 分钟仍有效', perm.isMaster(normal, T0 + 29 * 60000) === true);
  check('使用后 31 分钟已失效', perm.isMaster(normal, T0 + 31 * 60000) === false);
  check('剩余时间随时钟递减',
    perm.masterRemainMs(normal, T0 + 10 * 60000) === 20 * 60000);

  perm.grantMaster(normal, T0 + 10 * 60000);
  check('重新使用 = 从此刻重新计时 30 分钟',
    normal.masterUntil === T0 + 40 * 60000 &&
    perm.isMaster(normal, T0 + 39 * 60000) === true);

  const founder = { username: '刘子墨', nickname: '刘子墨' };
  check('账号名与昵称均为刘子墨 → 识别为永久账号', perm.isFounder(founder) === true);
  check('永久账号无需密钥即最高权限', perm.isMaster(founder, T0) === true);
  check('永久账号剩余时间为 -1（永久）', perm.masterRemainMs(founder, T0) === -1);
  check('只有昵称相同不算永久账号',
    perm.isFounder({ username: 'abc', nickname: '刘子墨' }) === false);
  check('只有账号名相同不算永久账号',
    perm.isFounder({ username: '刘子墨', nickname: '小李' }) === false);

  const latch = { username: '刘子墨', nickname: '刘子墨' };
  check('首次命中会固化 founder 标记', perm.latchFounder(latch) === true && latch.founder === true);
  latch.nickname = '改了个昵称';
  check('改昵称后仍保留永久权限（标记已固化）', perm.isFounder(latch) === true);

  /* ================= 准备账号 ================= */
  const A = await register('pa_', '权限甲');
  const B = await register('pb_', '权限乙');
  const C = await register('pc_', '权限丙');
  check('三个测试账号注册成功', !!(A.token && B.token && C.token), [A.error, B.error, C.error]);

  const roomsRes = await req('GET', '/api/rooms', null, A.token);
  const pubId = roomsRes.json.publicRoomId;
  check('拿到公共大厅 id', !!pubId, roomsRes.json);

  /* ================= B. 公共大厅默认不可解散 ================= */
  console.log('\n【B】公共大厅默认不可解散');

  let r = await req('POST', '/api/rooms/' + pubId + '/dissolve', { confirm: true }, A.token);
  check('普通用户解散公共大厅被拒 403', r.status === 403 && /公共大厅/.test(r.json.error || ''), r.json);

  const G = await createRoom(A.token, '甲创建的群' + rnd());
  check('群创建成功', !!G);
  r = await req('POST', '/api/rooms/' + pubId + '/dissolve', { confirm: true }, A.token);
  check('群主身份也不能解散公共大厅', r.status === 403, r.json);

  const pubAfter = await req('GET', '/api/rooms', null, A.token);
  const pubBrief = (pubAfter.json.rooms || []).find((x) => x.id === pubId);
  check('公共大厅仍然可用', !!pubBrief && pubBrief.dissolved === false, pubAfter.json);
  check('普通用户 room.canDissolve 为 false', !!pubBrief && pubBrief.canDissolve === false, pubBrief);

  /* ================= C. 权限密钥 ================= */
  console.log('\n【C】登录时输入权限密钥');

  r = await login(A.username, A.password, 'totally-wrong');
  check('密钥错误仍然登录成功', r.status === 200 && !!r.json.token, r.json && r.json.error);
  check('密钥错误时回 false 而非报错', !!(r.json.perm && r.json.perm.granted === false && r.json.perm.error));
  check('密钥错误不授予最高权限', r.json.user.master === false);
  let me = await req('GET', '/api/me', null, r.json.token);
  check('/api/me 也是无最高权限', me.json.user.master === false && me.json.user.founder === false);

  const before = Date.now();
  r = await login(A.username, A.password, KEY);
  check('密钥正确 → 授予最高权限', r.status === 200 && r.json.perm && r.json.perm.granted === true, r.json);
  check('响应里 user.master = true', r.json.user.master === true);
  const remain = r.json.user.masterRemainMs;
  check('有效期约 30 分钟（>29 分钟）', remain > 29 * 60000 && remain <= 30 * 60000, remain);
  check('到期时间 ≈ 现在 + 30 分钟',
    Math.abs(r.json.user.masterUntil - (before + 30 * 60000)) < 60000);
  const A2Token = r.json.token;

  r = await req('POST', '/api/auth/perm', { key: 'bad' }, A2Token);
  check('「我的」页激活：错误密钥被拒 400', r.status === 400, r.json);
  r = await req('POST', '/api/auth/perm', {}, A2Token);
  check('「我的」页激活：未填密钥被拒 400', r.status === 400, r.json);
  r = await req('POST', '/api/auth/perm', { key: KEY }, A2Token);
  check('「我的」页激活：正确密钥可续期', r.status === 200 && r.json.user.master === true, r.json);

  /* ================= D. 最高权限能力 ================= */
  console.log('\n【D】最高权限：删他人消息 / 删任意文件 / 清空房间 / 解散他人群 / 注销用户');

  // 乙在甲的群里发消息，甲（此时是最高权限）删掉乙的消息
  await req('POST', '/api/rooms/' + G + '/join', {}, B.token);
  r = await req('POST', '/api/rooms/' + G + '/messages', { content: '乙发的普通消息' }, B.token);
  const bMsgId = r.json.message && r.json.message.id;
  check('乙成功发消息', !!bMsgId, r.json);

  // 先证明「非最高权限」删不了别人的消息
  r = await req('POST', '/api/messages/' + bMsgId + '/purge', {}, C.token);
  check('非最高权限删他人消息被拒', r.status === 403, r.json);

  r = await req('POST', '/api/messages/' + bMsgId + '/purge', {}, A2Token);
  check('最高权限可删除他人消息', r.status === 200 && r.json.purged === true, r.json);
  let list = await req('GET', '/api/rooms/' + G + '/messages?since=0&limit=200', null, B.token);
  const gone = (list.json.messages || []).find((m) => m.id === bMsgId);
  check('他人消息已被彻底删除（所有人同步消失）', !gone || gone.purged === true);

  // 文件：乙上传，甲（最高权限）物理删除
  const payload = Buffer.from('hello-perm-test-' + rnd());
  let fi = await req('POST', '/api/files/init', {
    name: 'p.txt', size: payload.length, mime: 'text/plain', roomId: G
  }, B.token);
  let bFileId = null;
  if (fi.status === 200) {
    bFileId = fi.json.fileId;
    await req('PUT', '/api/files/' + bFileId + '/chunk?i=0', payload.slice(0, fi.json.chunkSize), B.token, { raw: true });
    await req('POST', '/api/files/' + bFileId + '/complete', {}, B.token);
  }
  check('乙上传文件成功', !!bFileId, fi.json);
  r = await req('DELETE', '/api/files/' + bFileId, null, A2Token);
  check('最高权限可物理删除他人文件', r.status === 200 && r.json.deleted === true, r.json);
  r = await req('GET', '/api/files/' + bFileId + '/status', null, B.token);
  check('文件元数据已不存在', r.status === 404, r.json);

  // 清空房间：丙的群，甲清空
  const G2 = await createRoom(C.token, '丙创建的群' + rnd());
  await req('POST', '/api/rooms/' + G2 + '/messages', { content: '要被清掉 1' }, C.token);
  await req('POST', '/api/rooms/' + G2 + '/messages', { content: '要被清掉 2' }, C.token);
  r = await req('POST', '/api/admin/rooms/' + G2 + '/clear', { confirm: true }, B.token);
  check('非最高权限清空房间被拒 403', r.status === 403, r.json);
  r = await req('POST', '/api/admin/rooms/' + G2 + '/clear', { confirm: true }, A2Token);
  check('最高权限可清空任意房间', r.status === 200 && r.json.cleared >= 2, r.json);
  list = await req('GET', '/api/rooms/' + G2 + '/messages?since=0&limit=200', null, C.token);
  check('房间消息已清空', (list.json.messages || []).length === 0);

  // 解散他人群：甲解散丙的群
  r = await req('POST', '/api/rooms/' + G2 + '/dissolve', { confirm: true }, A2Token);
  check('最高权限可解散他人创建的群', r.status === 200 && r.json.dissolved === true, r.json);
  r = await req('POST', '/api/rooms/' + G2 + '/messages', { content: '解散后还能发吗' }, C.token);
  check('被解散的群已停用（写操作 403/410）', r.status === 403 || r.status === 410, r.json);

  // 公共大厅：确认最高权限已越过权限闸（到「需要二次确认」这一步就停，不真解散）
  r = await req('POST', '/api/rooms/' + pubId + '/dissolve', {}, A2Token);
  check('最高权限解散公共大厅已过权限闸（要 400 二次确认）',
    r.status === 400 && /二次确认/.test(r.json.error || ''), r.json);
  const pubStill = await req('GET', '/api/rooms', null, A.token);
  const pubStillBrief = (pubStill.json.rooms || []).find((x) => x.id === pubId);
  check('公共大厅仍然存活（测试不破坏线上数据）', !!pubStillBrief && pubStillBrief.dissolved === false);

  /* ================= E. 非最高权限拦截 ================= */
  console.log('\n【E】非最高权限调用管理接口');

  r = await req('POST', '/api/admin/users/' + C.id + '/delete', { confirm: true }, B.token);
  check('普通用户注销他人账号被拒 403', r.status === 403, r.json);
  r = await req('GET', '/api/admin/overview', null, B.token);
  check('普通用户读管理概览被拒 403', r.status === 403, r.json);
  r = await req('GET', '/api/admin/overview', null, A2Token);
  check('最高权限可读管理概览', r.status === 200 && typeof r.json.userCount === 'number', r.json);

  /* ================= F. 注销指定用户 ================= */
  console.log('\n【F】注销指定用户');

  const D = await register('pd_', '待注销用户');
  const GD = await createRoom(D.token, '待注销用户的群' + rnd());
  await req('POST', '/api/rooms/' + GD + '/messages', { content: '这条会随账号消失' }, D.token);
  check('待注销用户已产生房间与消息', !!(D.token && GD));

  r = await req('POST', '/api/admin/users/' + D.id + '/delete', {}, A2Token);
  check('缺少二次确认被拒 400', r.status === 400, r.json);
  r = await req('POST', '/api/admin/users/' + D.id + '/delete', { confirm: true }, A2Token);
  check('最高权限可注销指定用户', r.status === 200 && r.json.deleted === true, r.json);
  check('返回清理统计', !!(r.json.stats && r.json.stats.messages >= 1), r.json && r.json.stats);

  r = await login(D.username, D.password);
  check('被注销的账号无法再登录', r.status === 401, r.json);
  list = await req('GET', '/api/rooms/' + G + '/messages?since=0&limit=200', null, B.token);
  check('其发布的消息已一并清除',
    !(list.json.messages || []).some((m) => m.content === '这条会随账号消失'));

  r = await req('POST', '/api/admin/users/' + A.id + '/delete', { confirm: true }, A2Token);
  check('不能通过管理接口注销自己', r.status === 400, r.json);

  /* ================= G. 永久权限账号 ================= */
  console.log('\n【G】永久权限账号与金色标识');

  // 该账号在云端可能早已存在（用户本人在用），此时只能用「搜索」验证标识
  const regBody = await req('POST', '/api/register', {
    username: '刘子墨', password: 'pass123', nickname: '刘子墨'
  }, null);

  let founderRes = null;
  if (regBody.status === 200) {
    founderRes = await req('GET', '/api/me', null, regBody.json.token);
    check('永久账号注册后 founder = true', founderRes.json.user.founder === true, founderRes.json);
    check('永久账号 master = true（无需密钥）', founderRes.json.user.master === true);
    check('永久账号剩余时间为 -1', founderRes.json.user.masterRemainMs === -1);

    // 发一条消息，验证 senderFounder 标记（标准版据此加金色框）
    const GF = await createRoom(regBody.json.token, '永久账号的群' + rnd());
    await req('POST', '/api/rooms/' + GF + '/messages', { content: '永久权限的发言' }, regBody.json.token);
    const fl = await req('GET', '/api/rooms/' + GF + '/messages?since=0&limit=50', null, regBody.json.token);
    const mine = (fl.json.messages || []).find((m) => m.content === '永久权限的发言');
    check('永久账号消息带 senderFounder 标记', !!(mine && mine.senderFounder === true), mine);

    // 改昵称后永久权限依旧（founder 已固化）
    await req('POST', '/api/me/nickname', { nickname: '刘子墨改' }, regBody.json.token);
    const after = await req('GET', '/api/me', null, regBody.json.token);
    check('改昵称后仍保留永久权限', after.json.user.founder === true && after.json.user.master === true, after.json.user);

    // 永久账号不可被注销
    const meF = await req('GET', '/api/me', null, regBody.json.token);
    r = await req('POST', '/api/admin/users/' + meF.json.user.id + '/delete', { confirm: true }, A2Token);
    check('永久权限账号不可被注销', r.status === 403, r.json);
  } else {
    // 账号已存在（线上真人账号）：用搜索验证服务端确实把它标记为 founder
    check('账号已存在（沿用线上账号）', regBody.status === 409, regBody.json);
    const s = await req('GET', '/api/users?q=' + encodeURIComponent('刘子墨'), null, A.token);
    const hit = (s.json.users || []).find((u) => u.username === '刘子墨');
    check('线上刘子墨账号被标记为 founder', !!(hit && hit.founder === true), s.json);
    check('线上刘子墨账号为最高权限', !!(hit && hit.master === true), hit);
  }

  // 视觉：标准版有金色烫金样式，基础版完全没有
  const cssStd = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
  const cssBasic = fs.readFileSync(path.join(ROOT, 'public/style-basic.css'), 'utf8');
  const jsStd = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const jsBasic = fs.readFileSync(path.join(ROOT, 'public/app-basic.js'), 'utf8');
  check('标准版样式含烫金名字框', cssStd.indexOf('founder-who') >= 0 && cssStd.indexOf('#d4af37') >= 0);
  check('标准版样式含金色头像框', /\.msg\.founder \.av/.test(cssStd));
  check('标准版脚本带 senderFounder 渲染', jsStd.indexOf('senderFounder') >= 0);
  check('基础版样式完全不含金色元素',
    cssBasic.indexOf('founder') < 0 && cssBasic.indexOf('d4af37') < 0 && cssBasic.indexOf('gold') < 0);
  check('基础版脚本不渲染金色标识',
    jsBasic.indexOf('senderFounder') < 0 && jsBasic.indexOf('founder-who') < 0 && jsBasic.indexOf('d4af37') < 0);

  // 基础版页面同样能提交权限密钥（功能一致，只是不展示金色）
  const basicHtmlPerm = fs.readFileSync(path.join(ROOT, 'public/index-basic.html'), 'utf8');
  check('基础版登录页也支持权限密钥', /id="inKey"/.test(basicHtmlPerm));
  check('基础版脚本会带上 permKey', jsBasic.indexOf('permKey') >= 0);

  // 分发：老设备拿到基础版，且不含金色标识
  r = await req('GET', '/', null, null, { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 5.1; Redmi Note 2 Build/LMY47D) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/39.0.0.0 Mobile Safari/537.36' } });
  check('老设备分发到基础版', r.text.indexOf('data-ll-cap="basic"') >= 0);
  check('基础版 HTML 不含金色样式', r.text.indexOf('founder') < 0);

  const basicHtml = fs.readFileSync(path.join(ROOT, 'public/index-basic.html'), 'utf8');
  const basicJs = fs.readFileSync(path.join(ROOT, 'public/app-basic.js'), 'utf8');
  check('基础版登录页也支持权限密钥', /id="inKey"/.test(basicHtml));
  check('基础版脚本会带上 permKey', basicJs.indexOf('permKey') >= 0);
  check('基础版不展示烫金标识（无 founder-who 类名）',
    basicHtml.indexOf('founder-who') < 0 && basicJs.indexOf('founder-who') < 0);

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常:', e && e.stack ? e.stack : e);
  console.log('\n通过: ' + pass + '  失败: ' + (fail + 1));
  process.exit(1);
});
