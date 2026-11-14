'use strict';
/**
 * 清理线上验证产生的测试数据。
 * 只删本次好友验证创建的账号（username 以 la / lb / lc 开头）及其关联数据，
 * 其余用户的数据一律不动。
 */
const { CloudStore } = require('../src/cloud');

const TEST_USER_RE = /^(la|lb|lc)[0-9a-f]{6}$/;

(async () => {
  const cs = new CloudStore();
  await cs.load();
  const del = async (ns, id) => {
    const { error } = await cs.cloud.database.from('docs').delete().eq('ns', ns).eq('id', id);
    if (!error) return 1;
    return 0;
  };

  // 1) 找出测试用户
  const testIds = new Set();
  const users = cs.mem.get('users');
  if (users) {
    for (const [id, rec] of users) {
      const d = rec.doc || {};
      if (TEST_USER_RE.test(String(d.username || ''))) testIds.add(id);
    }
  }
  console.log('测试用户 ' + testIds.size + ' 个');

  // 2) 删关联数据
  const counts = {};
  const plan = {
    users: [...testIds],
    sessions: [],
    friendReqs: [],
    friendIdx: [],
    members: [],
    messages: [],
    hidden: [],
    files: [],
  };
  const scan = (ns, match) => {
    const b = cs.mem.get(ns);
    if (!b) return;
    for (const [id, rec] of b) {
      const d = rec.doc || {};
      if (match(d)) plan[ns].push(id);
    }
  };
  scan('sessions', (d) => testIds.has(d.userId));
  scan('friendReqs', (d) => testIds.has(d.fromId) || testIds.has(d.toId));
  scan('friendIdx', (d) => testIds.has(d.a) || testIds.has(d.b));
  scan('members', (d) => testIds.has(d.userId));
  scan('messages', (d) => testIds.has(d.senderId));
  scan('hidden', (d) => testIds.has(d.userId));
  scan('files', (d) => testIds.has(d.ownerId));

  for (const ns of Object.keys(plan)) {
    let n = 0;
    for (const id of plan[ns]) n += await del(ns, id);
    counts[ns] = n;
    if (n) console.log('  ' + ns + ' 删除 ' + n + ' 条');
  }

  // 3) 复查
  const cs2 = new CloudStore();
  await cs2.load();
  console.log('\n清理后云端剩余：');
  for (const [ns, b] of cs2.mem) {
    if (ns === 'meta') continue;
    console.log('  ' + ns + ': ' + b.size);
  }
  const u2 = cs2.mem.get('users');
  if (u2) for (const [, rec] of u2) {
    const d = rec.doc || {};
    console.log('  保留用户: ' + d.username + ' (' + d.nickname + ')');
  }
})().catch((e) => { console.error(e); process.exit(1); });
