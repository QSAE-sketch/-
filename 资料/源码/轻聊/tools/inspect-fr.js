'use strict';
const { CloudStore } = require('../src/cloud');
(async () => {
  const cs = new CloudStore();
  await cs.load();
  const fr = cs.mem.get('friendReqs');
  if (fr) for (const [id, rec] of fr) {
    console.log('id=' + id);
    console.log('k1=' + rec.k1 + ' k2=' + rec.k2);
    console.log('doc=' + JSON.stringify(rec.doc));
  }
  console.log('--- 原始行（不过滤 ns）---');
  const { data } = await cs.cloud.database.from('docs').select('ns,id,k1,k2');
  const rows = data || [];
  console.log('总行数=' + rows.length);
  for (const r of rows) console.log('  ns=' + r.ns + ' id=' + r.id + ' k1=' + r.k1 + ' k2=' + r.k2);
})().catch(e => { console.error(e); process.exit(1); });
