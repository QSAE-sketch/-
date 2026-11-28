'use strict';
/* 只读盘点：列出云端 users 集合，不做任何写入 */
const { createWorkBuddyCloud, createMemoryStorage } = require('@tencent-ai/workbuddy-cloud-sdk');

const CFG = {
  endpoint: 'https://qingliao-chat-33476.app.workbuddy.host',
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

(async () => {
  const rows = [];
  let from = 0;
  const page = 500;
  for (;;) {
    const { data, error } = await cloud.database.from('docs')
      .select('ns,id,k1,k2,doc').eq('ns', 'users').range(from, from + page - 1);
    if (error) { console.error('ERR', error.message || error); break; }
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < page) break;
    from += page;
  }
  console.log('总账号数:', rows.length);
  const list = rows.map(r => {
    let d = r.doc;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = {}; } }
    d = d || {};
    return {
      id: r.id,
      username: d.username || '',
      nickname: d.nickname || '',
      createdAt: d.createdAt || 0,
      lastSeen: d.lastSeen || 0,
      founder: !!d.founder,
      avatar: d.avatar ? 'Y' : ''
    };
  }).sort((a, b) => a.createdAt - b.createdAt);
  const day = (t) => t ? new Date(t).toISOString().slice(0, 10) : '-';
  for (const u of list) {
    console.log([u.createdAt ? day(u.createdAt) : '-', day(u.lastSeen), u.id.slice(0, 10), (u.username || '').padEnd(18).slice(0, 18), (u.nickname || '').slice(0, 12), u.founder ? 'FOUNDER' : '', u.avatar].join(' | '));
  }
  // 按月聚合，判断哪些是测试期批量产生
  const byMonth = {};
  for (const u of list) { const k = u.createdAt ? day(u.createdAt).slice(0, 7) : '未知'; byMonth[k] = (byMonth[k] || 0) + 1; }
  console.log('按月分布:', JSON.stringify(byMonth));
})().catch(e => console.error('FATAL', e.message));
