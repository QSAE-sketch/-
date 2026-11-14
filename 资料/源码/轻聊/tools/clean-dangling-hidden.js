'use strict';
/** 清理「指向已不存在消息/文件」的隐藏墓碑 */
const { CloudStore } = require('../src/cloud');
(async () => {
  const cs = new CloudStore();
  await cs.load();
  const ids = new Set();
  for (const ns of ['messages', 'files']) {
    const b = cs.mem.get(ns);
    if (b) for (const id of b.keys()) ids.add(id);
  }
  const hb = cs.mem.get('hidden');
  let n = 0;
  if (hb) {
    for (const [id, rec] of hb) {
      const d = rec.doc || {};
      if (d.targetId && !ids.has(d.targetId)) {
        const { error } = await cs.cloud.database.from('docs').delete().eq('ns', 'hidden').eq('id', id);
        if (!error) { console.log('  删除悬挂墓碑 ' + id + ' -> ' + d.targetId); n++; }
        else console.error('  删除失败', id, error);
      }
    }
  }
  console.log('悬挂墓碑清理 ' + n + ' 条');
})().catch(e => { console.error(e); process.exit(1); });
