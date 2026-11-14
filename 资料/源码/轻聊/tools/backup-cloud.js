'use strict';
/**
 * 云端数据备份：把房间相关的集合导出成一个 JSON 文件，便于「清空房间」后回滚。
 *
 * 只备份元数据（房间 / 消息 / 成员 / 文件记录 / 隐藏记录），
 * 文件字节在云存储里，体积可能很大，这里不下载；回滚时元数据能还原，
 * 但已删除的文件字节需要重新上传。
 *
 * 用法：node tools/backup-cloud.js
 */
const fs = require('fs');
const path = require('path');
const { CloudStore } = require('../src/cloud');

const NS = ['rooms', 'messages', 'members', 'files', 'hidden'];
const OUT_DIR = path.join(__dirname, '..', 'data-backups');

(async () => {
  const cs = new CloudStore();
  await cs.load();

  const out = {};
  let total = 0;
  for (const ns of NS) {
    const bucket = cs.mem.get(ns);
    out[ns] = [];
    if (!bucket) continue;
    bucket.forEach((rec) => {
      const doc = (rec && rec.doc) || rec;
      if (doc) { out[ns].push(doc); total++; }
    });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(OUT_DIR, 'rooms-backup-' + ts + '.json');
  fs.writeFileSync(file, JSON.stringify({
    createdAt: new Date().toISOString(),
    counts: NS.reduce((a, ns) => { a[ns] = out[ns].length; return a; }, {}),
    data: out
  }, null, 2), 'utf8');

  console.log('[备份] 已写入 ' + file);
  for (const ns of NS) console.log('  ' + ns.padEnd(10) + out[ns].length + ' 条');
  console.log('[备份] 合计 ' + total + ' 条记录');
})().catch((e) => {
  console.error('[备份] 失败:', e && e.stack ? e.stack : e);
  process.exit(1);
});
