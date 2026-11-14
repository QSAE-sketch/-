'use strict';
/**
 * 云端数据清空工具。
 *
 * 清空范围（全部业务数据，用户要求「清空云端现有全部数据」）：
 *   - public.docs      文档集合：用户/会话/房间/成员/消息/文件元数据/隐藏记录/好友/元数据
 *   - public.file_blobs 文件字节分片
 *
 * 安全措施：
 *   - 默认需显式传 --yes 才真正执行；不加参数只做「预览」。
 *   - 逐表先统计再删除，删除后再复查，确保真的清空。
 *
 * 用法：
 *   node tools/cloud-reset.js          # 预览（不删）
 *   node tools/cloud-reset.js --yes    # 真删
 */

const { CloudStore, PUBLIC_CONFIG } = require('../src/cloud');

const YES = process.argv.includes('--yes');

async function main() {
  const cs = new CloudStore(process.env.PUBLIC_ORIGIN || PUBLIC_CONFIG.endpoint);
  await cs.load();

  // 统计各集合
  const byNs = {};
  for (const [ns, m] of cs.mem) byNs[ns] = m.size;
  const totalDocs = Object.values(byNs).reduce((a, b) => a + b, 0);

  console.log('=== 清空前云端概况 ===');
  console.log('  docs 文档总数:', totalDocs);
  for (const ns of Object.keys(byNs).sort()) {
    console.log('    ' + ns + ': ' + byNs[ns]);
  }

  // 文件字节
  const { data: blobRows, error: blobErr } = await cs.cloud.database
    .from('file_blobs')
    .select('file_id,idx');
  if (blobErr) {
    console.error('读取 file_blobs 失败:', JSON.stringify(blobErr));
    process.exit(1);
  }
  const blobFiles = new Set((blobRows || []).map(r => r.file_id));
  console.log('  file_blobs 分片行数:', (blobRows || []).length, ' 涉及文件数:', blobFiles.size);

  if (!YES) {
    console.log('\n[预览模式] 未执行任何删除。确认无误后加 --yes 真正执行：');
    console.log('  node tools/cloud-reset.js --yes');
    return;
  }

  console.log('\n=== 开始清空 ===');

  // 1) 删除文件字节分片
  const { error: delBlobErr } = await cs.cloud.database.from('file_blobs').delete().neq('file_id', '__never_match__');
  if (delBlobErr) {
    console.error('删除 file_blobs 失败:', JSON.stringify(delBlobErr));
    process.exit(1);
  }
  console.log('  [1/2] file_blobs 已清空');

  // 2) 删除全部文档
  const { error: delDocErr } = await cs.cloud.database.from('docs').delete().neq('ns', '__never_match__');
  if (delDocErr) {
    console.error('删除 docs 失败:', JSON.stringify(delDocErr));
    process.exit(1);
  }
  console.log('  [2/2] docs 已清空');

  // 3) 复查
  const { data: afterDocs } = await cs.cloud.database.from('docs').select('ns,id');
  const { data: afterBlobs } = await cs.cloud.database.from('file_blobs').select('file_id');
  console.log('\n=== 清空后复查 ===');
  console.log('  docs 剩余:', (afterDocs || []).length);
  console.log('  file_blobs 剩余:', (afterBlobs || []).length);

  if ((afterDocs || []).length === 0 && (afterBlobs || []).length === 0) {
    console.log('\n✅ 云端已完全清空');
  } else {
    console.log('\n⚠️ 仍有残留，请检查');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('执行失败:', e && e.message ? e.message : e);
  process.exit(1);
});
