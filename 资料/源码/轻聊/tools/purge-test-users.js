'use strict';
/**
 * 一次性维护脚本：清理云端自动化测试遗留账号（保留 3 个真人号）。
 * 用法：node tools/tmp-purge-test-users.js          干跑，只打印名单
 *      node tools/tmp-purge-test-users.js --apply  真删
 */
const { createWorkBuddyCloud, createMemoryStorage } = require('@tencent-ai/workbuddy-cloud-sdk');

const BASE = 'https://qingliao-chat-33476.app.workbuddy.host';
const SC = 'sharecode=T7ELJZOC5A';
const PERM_KEY = 'lz-qingliao-2026';
const APPLY = process.argv.includes('--apply');

// 按用户名精确匹配（ID 在日志里是截断的，不足为凭）
const KEEP = new Set(['刘子墨', 'L18971035559', '刘子墨__小号']);

const CFG = {
  endpoint: BASE,
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_uYiIp668K7SSIukHhaRkrR_gzmtwmIBcZ4yAX8o6J6Vo0Tu0RFjr67S'
};
function originFetch(origin) {
  return function (input, init) {
    const h = new Headers(init && init.headers);
    if (!h.has('origin')) h.set('origin', origin);
    return fetch(input, Object.assign({}, init, { headers: h }));
  };
}
const cloud = createWorkBuddyCloud({
  endpoint: CFG.endpoint, oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
  publishableKey: CFG.publishableKey, storage: createMemoryStorage(),
  fetch: originFetch(CFG.endpoint)
});

function http(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path + (path.includes('?') ? '&' : '?') + SC);
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' };
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = require('https').request(u, { method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch (e) {}
        resolve({ status: res.statusCode, json, body: b });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // 1) 拉全量账号
  const rows = [];
  let from = 0;
  const page = 500;
  for (;;) {
    const { data, error } = await cloud.database.from('docs')
      .select('ns,id,k1,k2,doc').eq('ns', 'users').range(from, from + page - 1);
    if (error) throw new Error(error.message || 'query failed');
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < page) break;
    from += page;
  }
  const users = rows.map((r) => {
    let d = r.doc;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = {}; } }
    return { id: r.id, username: (d && d.username) || '', nickname: (d && d.nickname) || '' };
  });
  const keep = users.filter((u) => KEEP.has(u.username));
  const MAINT_ONLY = process.argv.includes('--maint-only');
  const targets = users.filter((u) => MAINT_ONLY ? u.username.startsWith('_maint') : !KEEP.has(u.username));

  console.log('总账号:', users.length, '| 保留:', keep.length, '| 待删:', targets.length);
  console.log('保留名单:', keep.map((u) => u.username + '(' + u.id + ')').join(', '));
  if (!APPLY) {
    console.log('干跑结束（未删除）。示例待删前 8 个:',
      targets.slice(0, 8).map((u) => u.username).join(', '));
    return;
  }

  // 2) 建维护账号并开权限窗口
  const mu = '_maint' + Date.now().toString().slice(-6);
  const mp = 'maint-' + Date.now();
  let r = await http('POST', '/api/register', { username: mu, password: mp, nickname: '维护' });
  if (!r.json || !r.json.token) throw new Error('注册维护账号失败: ' + r.body.slice(0, 120));
  const token = r.json.token;
  const myId = r.json.user && r.json.user.id;
  r = await http('POST', '/api/auth/perm', { key: PERM_KEY }, token);
  console.log('权限窗口:', r.status, r.json && r.json.perm ? '已开启' : r.body.slice(0, 100));
  if (r.status !== 200) throw new Error('开启最高权限失败，中止');

  // 3) 逐个注销
  let okCount = 0;
  const failed = [];
  for (const t of targets) {
    const res = await http('POST', '/api/admin/users/' + encodeURIComponent(t.id) + '/delete', { confirm: true }, token);
    if (res.status === 200 && res.json && res.json.deleted) okCount++;
    else failed.push({ id: t.id, username: t.username, status: res.status, msg: res.json && res.json.error });
    if ((okCount + failed.length) % 20 === 0) console.log('进度:', okCount + failed.length, '/', targets.length);
  }
  console.log('已注销:', okCount, '| 失败:', failed.length);
  if (failed.length) console.log('失败明细:', JSON.stringify(failed.slice(0, 10)));

  // 4) 自毁维护账号
  if (myId) {
    const d = await http('POST', '/api/account/delete', { password: mp, confirm: true }, token);
    console.log('维护账号自毁:', d.status, d.status === 200 ? 'OK' : d.body.slice(0, 100));
  }
  console.log('完成');
})().catch((e) => console.error('FATAL', e.message));
