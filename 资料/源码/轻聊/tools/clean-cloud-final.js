'use strict';
/**
 * 云端数据体检 + 清理 + 一致性修复。
 *
 * 背景（本轮遗留问题）：
 * 1) 线上验证 / 云端回归产生了一批测试账号（zzbob123、fchk* 等），
 *    及其会话、成员、隐藏记录、消息等残留，需要精确清理。
 * 2) 早期有一次误用 database.from('docs').update({doc: JSON.stringify(d)})，
 *    把一条 users 记录的 doc 写成了 JSON 字符串 —— 已用 src/cloud.js 的
 *    normalizeDoc() 做「读时兼容」兜底，并把那条记录重写回对象形式。
 * 3) 有条 status='accepted' 的历史好友申请，但 friendIdx 里没有对应的好友
 *    关系记录（写库时丢了），导致「已同意」在好友列表里看不到人。
 *    这里补一条 friendIdx，让数据自洽。
 *
 * 安全原则：
 * - 只删「用户已不存在」或「明确是测试账号」的记录；
 * - 真实用户（刘子墨、爱吃榴莲的蘑菇）及其本人发的消息、文件一律不动；
 * - 删除走 CloudStore 的 delete（精确按 ns+id 命中），不做模糊批量。
 */

const { CloudStore } = require('../src/cloud');

/* 明确的测试账号用户名（精确匹配，不用宽泛正则，避免误伤真实账号） */
const TEST_USERNAMES = new Set([
  'zzbob123',
  'fchk1794130404'
]);

/* 历史上用过的测试账号名前缀（形如 la1a2b3、lbxxxxxx）
   lv = live-chat-avatar-verify、sa/sb = shot-chat-avatar、qa/qb/qc = 早期浏览器验证 */
const TEST_PREFIX_RE = /^(la|lb|lc|br|noct|wct|enc|zz|fchk|lv|sa|sb|qa|qb|qc|ver|ra)[0-9a-z]*$/i;

function isTestUsername(username) {
  const u = String(username || '');
  if (TEST_USERNAMES.has(u)) return true;
  if (u.length >= 3 && u.length <= 24 && TEST_PREFIX_RE.test(u)) return true;
  return false;
}

(async () => {
  const cs = new CloudStore();
  await cs.load();

  /* ---------- 1. 体检 ---------- */
  const usersBucket = cs.mem.get('users') || new Map();
  const allUsers = [];
  for (const [id, rec] of usersBucket) {
    const d = rec.doc || {};
    allUsers.push({ id, username: d.username, nickname: d.nickname, doc: d });
  }
  const liveUserIds = new Set(allUsers.map(u => u.id));

  console.log('=== 云端体检 ===');  for (const [ns, b] of cs.mem) {
    if (ns === 'meta') continue;
    console.log('  ' + ns + ': ' + b.size);
  }
  console.log('  用户列表：');
  for (const u of allUsers) {
    console.log('    ' + u.username + ' (' + u.nickname + ') id=' + u.id +
      (isTestUsername(u.username) ? '   ← 测试账号' : ''));
  }

  /* ---------- 2. 计划删除 ---------- */
  const delUserIds = new Set();
  for (const u of allUsers) {
    if (isTestUsername(u.username)) delUserIds.add(u.id);
  }
  // 清理后应当保留的用户（真实用户）
  const keepUserIds = new Set(allUsers.filter(u => !delUserIds.has(u.id)).map(u => u.id));

  // 关联清理：命中已删账号 或 指向不存在用户的记录
  const plan = {
    users: [],
    sessions: [],
    friendReqs: [],
    friendIdx: [],
    members: [],
    messages: [],
    hidden: [],
    files: []
  };

  const scan = (ns, match) => {
    const b = cs.mem.get(ns);
    if (!b) return;
    for (const [id, rec] of b) {
      const d = rec.doc || {};
      if (match(d, id)) plan[ns].push(id);
    }
  };

  for (const u of allUsers) if (delUserIds.has(u.id)) plan.users.push(u.id);

  // 会话：属于待删账号，或属于根本不存在的账号（历史孤儿）
  scan('sessions', (d) => delUserIds.has(d.userId) || !keepUserIds.has(d.userId));
  // 好友申请 / 好友关系：涉及待删账号
  scan('friendReqs', (d) => delUserIds.has(d.fromId) || delUserIds.has(d.toId));
  scan('friendIdx', (d) => delUserIds.has(d.a) || delUserIds.has(d.b));
  // 成员：属于待删账号或不存在账号
  scan('members', (d) => delUserIds.has(d.userId) || !keepUserIds.has(d.userId));
  // 消息：发送者是不存在的账号（真实用户发的消息一律保留）
  scan('messages', (d) => d.senderId && !keepUserIds.has(d.senderId));
  // 隐藏记录：属于待删账号或不存在账号
  scan('hidden', (d) => delUserIds.has(d.userId) || !keepUserIds.has(d.userId));
  // 文件：上传者是不存在的账号
  scan('files', (d) => d.ownerId && !keepUserIds.has(d.ownerId));

  // 顺带清掉「指向已删除消息/文件」的隐藏墓碑（避免悬挂记录）
  const doomedTargets = new Set([].concat(plan.messages, plan.files));
  if (doomedTargets.size) {
    const before = plan.hidden.length;
    plan.hidden = plan.hidden.filter((id) => {
      const b = cs.mem.get('hidden');
      const rec = b && b.get(id);
      const d = (rec && rec.doc) || {};
      return !doomedTargets.has(d.targetId);
    });
    if (plan.hidden.length !== before) {
      console.log('  （额外移除指向已删消息的隐藏墓碑 ' + (before - plan.hidden.length) + ' 条）');
    }
  }

  console.log('\n=== 删除计划 ===');
  for (const ns of Object.keys(plan)) {
    if (!plan[ns].length) continue;
    console.log('  ' + ns + ': ' + plan[ns].length + ' 条');
    for (const id of plan[ns]) console.log('      ' + id);
  }

  const total = Object.keys(plan).reduce((n, ns) => n + plan[ns].length, 0);
  if (!total) console.log('  （无）');

  if (process.env.DRY === '1') {
    console.log('\n[DRY] 只预览不执行。');
    return;
  }

  /* ---------- 3. 执行删除 ---------- */
  const del = async (ns, id) => {
    const { error } = await cs.cloud.database.from('docs').delete().eq('ns', ns).eq('id', id);
    if (error) { console.error('  删除失败 ' + ns + '/' + id + ':', error); return 0; }
    return 1;
  };
  console.log('\n=== 执行 ===');
  for (const ns of Object.keys(plan)) {
    let n = 0;
    for (const id of plan[ns]) n += await del(ns, id);
    if (n) console.log('  ' + ns + ' 已删除 ' + n + ' 条');
  }

  /* ---------- 4. 一致性修复：accepted 的申请补 friendIdx ---------- */
  console.log('\n=== 一致性修复 ===');
  const cs2 = new CloudStore();
  await cs2.load();
  const frs = cs2.mem.get('friendReqs');
  let fixed = 0;
  if (frs) {
    for (const [id, rec] of frs) {
      const d = rec.doc || {};
      if (d.status !== 'accepted') continue;
      const a = d.fromId, b = d.toId;
      if (!a || !b) continue;
      const key = [a, b].sort().join('~');
      const exists = cs2.mem.get('friendIdx') && cs2.mem.get('friendIdx').get(key);
      if (exists) { console.log('  好友关系已存在: ' + key); continue; }
      // 用与 db.js 相同的写入路径落库，保证 k1/k2 索引列正确
      const doc = { id: key, a, b, createdAt: Date.now() };
      cs2.put('friendIdx', key, doc, a, b);
      await cs2.flush();
      fixed++;
      console.log('  补建好友关系: ' + key + '（' + d.fromId + ' ↔ ' + d.toId + '）');
    }
  }
  if (!fixed) console.log('  无需修复');

  /* ---------- 5. 复查 ---------- */
  const cs3 = new CloudStore();
  await cs3.load();
  console.log('\n=== 清理后云端 ===');
  for (const [ns, b] of cs3.mem) {
    if (ns === 'meta') continue;
    console.log('  ' + ns + ': ' + b.size);
  }
  const u3 = cs3.mem.get('users');
  if (u3) for (const [, rec] of u3) {
    const d = rec.doc || {};
    console.log('  保留用户: ' + d.username + ' (' + d.nickname + ')');
  }
  const fi3 = cs3.mem.get('friendIdx');
  if (fi3) for (const [id, rec] of fi3) {
    const d = rec.doc || {};
    console.log('  好友关系: ' + id + ' a=' + d.a + ' b=' + d.b);
  }
})().catch((e) => { console.error(e); process.exit(1); });
