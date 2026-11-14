'use strict';
/** 职级任命与降级调整专项测试 */
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3311;
const BASE = 'http://127.0.0.1:' + PORT;
let pass = 0, fail = 0;

function req(m, p, b, t) {
  return new Promise((resolve, reject) => {
    const d = (b === undefined || b === null) ? null : Buffer.from(JSON.stringify(b));
    const h = {};
    if (t) h['X-Token'] = t;
    if (d) h['Content-Type'] = 'application/json';
    const u = new URL(p, BASE);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: m, headers: h }, (rs) => {
      const c = [];
      rs.on('data', (x) => c.push(x));
      rs.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(c).toString()); } catch (e) {}
        resolve({ status: rs.statusCode, json: j });
      });
    });
    r.on('error', reject);
    if (d) r.write(d);
    r.end();
  });
}
function ck(n, c, e) {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (e ? '  → ' + JSON.stringify(e).slice(0, 220) : '')); }
}

(async () => {
  const sfx = crypto.randomBytes(3).toString('hex');
  const mk = async (n) => {
    const r = await req('POST', '/api/register', { username: n + sfx, password: 'pass123' });
    return { token: r.json.token, user: r.json.user };
  };
  const A = await mk('ra'), B = await mk('rb'), C = await mk('rc');
  const P = await mk('rp');   // 保持百姓身份，用于验证完整官职链

  console.log('\n【层级链：群主→丞相→县令→乡长】');
  let r = await req('POST', '/api/rooms', { name: '职级房' }, A.token);
  const rid = r.json.room.id;
  await req('POST', '/api/rooms/' + rid + '/join', {}, B.token);
  await req('POST', '/api/rooms/' + rid + '/join', {}, C.token);
  await req('POST', '/api/rooms/' + rid + '/join', {}, P.token);

  r = await req('POST', '/api/rooms/' + rid + '/appoint', { userId: B.user.id, role: 'admin' }, A.token);
  ck('群主 → 任命丞相', r.status === 200 && r.json.member.role === 'admin', r.json);
  r = await req('POST', '/api/rooms/' + rid + '/appoint', { userId: C.user.id, role: 'subadmin' }, B.token);
  ck('丞相 → 任命县令（小管理员）', r.status === 200 && r.json.member.role === 'subadmin', r.json);
  r = await req('GET', '/api/rooms/' + rid + '/members', null, A.token);
  ck('官职齐全（群主/丞相/县令/百姓）',
    ['群主', '丞相', '县令', '百姓'].every((x) => r.json.members.some((m) => m.roleName === x)),
    r.json.members.map((m) => m.roleName));

  console.log('\n【越权防护】');
  r = await req('POST', '/api/rooms/' + rid + '/appoint', { userId: C.user.id, role: 'admin' }, B.token);
  ck('丞相不能任命同级丞相', r.status === 403, r.json);
  r = await req('POST', '/api/rooms/' + rid + '/appoint', { userId: B.user.id, role: 'junior' }, C.token);
  ck('县令不能任命乡长（县令只能任命更低一级）', r.status === 403, r.json);
  r = await req('POST', '/api/rooms/' + rid + '/appoint', { userId: B.user.id, role: 'owner' }, A.token);
  ck('不能任命群主', r.status === 400, r.json);

  console.log('\n【降级调整】');
  r = await req('POST', '/api/rooms/' + rid + '/appoint', { userId: B.user.id, role: 'subadmin' }, A.token);
  ck('群主可将丞相降级为县令', r.status === 200 && r.json.member.role === 'subadmin', r.json);
  r = await req('GET', '/api/rooms/' + rid + '/members', null, A.token);
  ck('降级后职级已更新',
    r.json.members.find((m) => m.userId === B.user.id).role === 'subadmin',
    r.json.members.map((m) => m.role));
  r = await req('POST', '/api/rooms/' + rid + '/appoint', { userId: B.user.id, role: 'admin' }, A.token);
  ck('可重新升回丞相', r.status === 200 && r.json.member.role === 'admin', r.json);

  console.log('\n【人数上限（按任命人分别计数）】');
  const D = await mk('rd'), E = await mk('re'), F = await mk('rf'), G = await mk('rg');
  r = await req('POST', '/api/rooms', { name: '上限房' }, A.token);
  const rid2 = r.json.room.id;
  for (const u of [D, E, F, G]) await req('POST', '/api/rooms/' + rid2 + '/join', {}, u.token);
  let okc = 0;
  for (const u of [D, E, F]) {
    const rr = await req('POST', '/api/rooms/' + rid2 + '/appoint', { userId: u.user.id, role: 'admin' }, A.token);
    if (rr.status === 200) okc++;
  }
  ck('群主成功任命 3 位丞相', okc === 3, '成功 ' + okc);
  r = await req('POST', '/api/rooms/' + rid2 + '/appoint', { userId: G.user.id, role: 'admin' }, A.token);
  ck('第 4 位丞相被拒（上限 3）', r.status === 400 && r.json.error.indexOf('最多') >= 0, r.json);

  // 丞相各自可任命 2 位县令（按人分别计数，互不影响）
  const H = await mk('rh'), I = await mk('ri'), J = await mk('rj');
  for (const u of [H, I, J]) await req('POST', '/api/rooms/' + rid2 + '/join', {}, u.token);
  let okd = 0, oke = 0;
  for (const u of [H, I]) {
    const rr = await req('POST', '/api/rooms/' + rid2 + '/appoint', { userId: u.user.id, role: 'subadmin' }, D.token);
    if (rr.status === 200) okd++;
  }
  ck('丞相甲可任命 2 位县令', okd === 2, '成功 ' + okd);
  const rr3 = await req('POST', '/api/rooms/' + rid2 + '/appoint', { userId: J.user.id, role: 'subadmin' }, D.token);
  ck('丞相甲第 3 位县令被拒（上限 2）', rr3.status === 400 && rr3.json.error.indexOf('最多') >= 0, rr3.json);
  const rre = await req('POST', '/api/rooms/' + rid2 + '/appoint', { userId: J.user.id, role: 'subadmin' }, E.token);
  ck('丞相乙不受甲的上限影响（各自计数）', rre.status === 200, rre.json);

  console.log('\n【管理能力随职级递减】');
  // 县令（已任命 C 为县令）可任命乡长；乡长只能管理百姓
  const Jr = await mk('rjr');
  await req('POST', '/api/rooms/' + rid + '/join', {}, Jr.token);
  r = await req('POST', '/api/rooms/' + rid + '/appoint', { userId: Jr.user.id, role: 'junior' }, C.token);
  ck('县令 → 任命乡长（更低一级管理员）', r.status === 200 && r.json.member.role === 'junior', r.json);
  r = await req('POST', '/api/rooms/' + rid + '/appoint', { userId: P.user.id, role: 'junior' }, Jr.token);
  ck('乡长不能再任命下级', r.status === 403, r.json);
  r = await req('POST', '/api/rooms/' + rid + '/mute', { userId: P.user.id, minutes: 5 }, Jr.token);
  ck('乡长可禁言百姓', r.status === 200, r.json);
  r = await req('POST', '/api/rooms/' + rid + '/mute', { userId: C.user.id, minutes: 5 }, Jr.token);
  ck('乡长不能禁言县令（级别高于自己）', r.status === 403, r.json);
  r = await req('POST', '/api/rooms/' + rid + '/kick', { userId: B.user.id }, Jr.token);
  ck('乡长不能踢出丞相', r.status === 403, r.json);

  console.log('\n────────────────────────────');
  console.log('通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
