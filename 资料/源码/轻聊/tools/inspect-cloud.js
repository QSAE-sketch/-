'use strict';
const { CloudStore } = require('../src/cloud');
(async () => {
  const cs = new CloudStore();
  await cs.load();
  console.log('=== 云端现状 ===');
  for (const [ns, b] of cs.mem) {
    if (ns === 'meta') continue;
    console.log('  ' + ns + ': ' + b.size);
  }
  console.log('\n=== 用户 ===');
  const u = cs.mem.get('users');
  if (u) for (const [id, rec] of u) {
    const d = rec.doc || {};
    console.log('  id=' + id + ' username=' + d.username + ' nickname=' + d.nickname + ' createdAt=' + d.createdAt);
  }
  console.log('\n=== friendReqs ===');
  const fr = cs.mem.get('friendReqs');
  if (fr) for (const [id, rec] of fr) {
    const d = rec.doc || {};
    console.log('  ' + id + ' from=' + d.fromId + ' to=' + d.toId + ' status=' + d.status + ' msg=' + JSON.stringify(d.message));
  }
  console.log('\n=== friendIdx ===');
  const fi = cs.mem.get('friendIdx');
  if (fi) for (const [id, rec] of fi) {
    const d = rec.doc || {};
    console.log('  ' + id + ' a=' + d.a + ' b=' + d.b);
  }
  console.log('\n=== sessions ===');
  const ss = cs.mem.get('sessions');
  if (ss) for (const [id, rec] of ss) {
    const d = rec.doc || {};
    console.log('  ' + id + ' userId=' + d.userId);
  }
})().catch(e => { console.error(e); process.exit(1); });
