'use strict';
/**
 * 清理云端历史测试数据（白名单法）
 * 用法: node tools/clean-test-data.js [--apply]
 * 默认 dry-run，只打印将删/将留的清单；加 --apply 才真正删除。
 * 删除前请确认已有 data-backups/cloud-full-*.json 备份。
 */
const APPLY = process.argv.indexOf('--apply') >= 0;
const { CloudStore } = require('../src/cloud');

// ===== 真实数据白名单 =====
const REAL_USERS = new Set([
  'u_4b055774cb1435a48b86213b',   // 刘子墨（founder）
  'u_54fc13d39772fb635f0b247e'    // L18971035559 爱吃榴莲的蘑菇
]);
const REAL_ROOMS = new Set([
  'r_86064996929b51073b7efedc'    // 公共聊天室
]);

(async () => {
  const cs = new CloudStore();
  await cs.load();
  const entries = [];
  cs.mem.forEach((b, ns) => b.forEach((rec, id) => entries.push({ ns, id, doc: rec && rec.doc ? rec.doc : rec })));
  const D = doc => doc && doc.doc ? doc.doc : doc;

  const del = [];
  const keep = [];
  for (const e of entries) {
    const d = D(e.doc);
    let remove = false;
    switch (e.ns) {
      case 'users':  remove = !REAL_USERS.has(e.id); break;
      case 'rooms':  remove = !REAL_ROOMS.has(e.id); break;
      case 'sessions': remove = !REAL_USERS.has(d.userId); break;
      case 'members': remove = !REAL_ROOMS.has(d.roomId) || !REAL_USERS.has(d.userId); break;
      case 'messages':
        remove = !REAL_ROOMS.has(d.roomId) || !REAL_USERS.has(d.senderId || d.userId) ||
                 /测试|自检|对照|selftest/i.test(String(d.content || ''));  // 连真实账号发的测试消息也清
        break;
      case 'files':  remove = !REAL_USERS.has(d.ownerId); break;
      case 'hidden': remove = !REAL_USERS.has(d.userId); break;
      case 'friendReqs': remove = !REAL_USERS.has(d.toId) && !REAL_USERS.has(d.fromId); break;
      case 'friendIdx': remove = !(REAL_USERS.has(d.a) && REAL_USERS.has(d.b)); break;
      case 'shares': remove = !REAL_USERS.has(d.userId); break;
      default: remove = true; // meta 等其它一律清
    }
    (remove ? del : keep).push(e);
  }

  const byNs = arr => arr.reduce((m,e)=>{m[e.ns]=(m[e.ns]||0)+1;return m;},{});
  console.log('=== 保留（真实数据）===', JSON.stringify(byNs(keep)));
  console.log('=== 删除（测试数据）===', JSON.stringify(byNs(del)));
  console.log('\n保留用户:');
  keep.filter(e=>e.ns==='users').forEach(e=>console.log('  ', e.doc.username || e.doc.nickname));
  console.log('保留房间:');
  keep.filter(e=>e.ns==='rooms').forEach(e=>console.log('  ', e.doc.name));
  console.log('保留消息数:', keep.filter(e=>e.ns==='messages').length, '| 保留文件数:', keep.filter(e=>e.ns==='files').length);

  if (!APPLY) {
    console.log('\n[DRY-RUN] 未删除任何数据。确认无误后加 --apply 执行。');
    return;
  }
  console.log('\n[APPLY] 开始删除 ' + del.length + ' 条...');
  const client = cs.cloud;
  let n = 0, err = 0;
  for (const e of del) {
    const { error } = await client.database.from('docs').delete().eq('ns', e.ns).eq('id', e.id);
    if (!error) n++; else { err++; console.error('  删除失败', e.ns, e.id, error.message); }
  }
  console.log('完成: 删除 ' + n + ' 条, 失败 ' + err + ' 条');
})().catch(e => { console.error('ERR', e); process.exit(1); });
