'use strict';
/**
 * 云端数据维护：修复历史乱码昵称 + 清理验证测试账号。
 *
 * 乱码成因：早期部分环境（老 WebView 的 XHR.send(字符串)）按本地编码（GBK）
 * 发中文，服务端解出来就成了乱码。
 * 现在前端已改为显式发 UTF-8 字节（utf8Bytes），不会再产生新的乱码；
 * 这个脚本把已经落库的历史脏数据还原。
 *
 * 还原靠显式映射：自动判定不可靠（生僻字与常用字的码点区间重叠，
 * 而多次转码后的字节序列已不可逆），所以用写死的对照表最稳妥。
 */
const { CloudStore } = require('../src/cloud');

/**
 * 乱码昵称 -> 正确昵称。
 * 用 \u 转义写死，避免文件本身的编码影响。
 */
const MOJIBAKE_MAP = {
  '鑒谶饔鑿': '刘子墨'
};

const TEST_USER_RE = /^(la|lb|lc|br|noct|wct|enc)[0-9a-z]{6,10}$/;

/** 读取文档本体：兼容 doc 被写成 JSON 字符串的异常情况 */
function docOf(rec) {
  let d = (rec && rec.doc) || {};
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch (e) { d = {}; }
  }
  return d;
}

(async () => {
  const cs = new CloudStore();
  await cs.load();

  /* ---------- 1. 修复乱码昵称 ---------- */
  const users = cs.mem.get('users');
  let fixed = 0;
  if (users) {
    for (const [id, rec] of users) {
      const d = docOf(rec);
      const nm = String(d.nickname || '');
      const want = MOJIBAKE_MAP[nm];
      if (!want) continue;
      console.log('  还原昵称: ' + nm + '  →  ' + want);
      d.nickname = want;
      // 用 CloudStore 自己的写入通道，保证 doc / k1 / k2 的结构与其它记录一致
      cs.put('users', id, d, rec.k1, rec.k2);
      fixed++;
    }
  }
  if (fixed) await cs.flush();
  console.log('修复乱码昵称 ' + fixed + ' 条');

  /* ---------- 1b. 规范化 doc 类型 ---------- */
  // 早期一次错误的 update 把 doc 写成了 JSON 字符串；CloudStore 加载时不解析，
  // 于是 db.list('users') 拿到的是字符串，u.usernameLower 直接 undefined。
  // 这里把所有命名空间里「doc 是字符串」的记录重写成对象。
  let normalized = 0;
  cs.mem.forEach((bucket, ns) => {
    bucket.forEach((rec, id) => {
      if (!rec || typeof rec.doc !== 'string') return;
      let d;
      try { d = JSON.parse(rec.doc); } catch (e) { return; }
      if (!d || typeof d !== 'object') return;
      cs.put(ns, id, d, rec.k1, rec.k2);
      normalized++;
    });
  });
  if (normalized) {
    await cs.flush();
    console.log('规范化 doc 类型（字符串 → 对象）' + normalized + ' 条');
  }

  /* ---------- 2. 清理测试账号 ---------- */
  const testIds = new Set();
  const u2 = cs.mem.get('users');
  if (u2) {
    for (const [id, rec] of u2) {
      const d = docOf(rec);
      if (TEST_USER_RE.test(String(d.username || ''))) testIds.add(id);
    }
  }
  const del = async (ns, id) => {
    const { error } = await cs.cloud.database.from('docs').delete().eq('ns', ns).eq('id', id);
    return error ? 0 : 1;
  };
  const plan = {
    users: [...testIds], sessions: [], friendReqs: [], friendIdx: [],
    members: [], messages: [], hidden: [], files: []
  };
  const scan = (ns, match) => {
    const b = cs.mem.get(ns);
    if (!b) return;
    for (const [id, rec] of b) {
      const d = docOf(rec);
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
    if (n) console.log('  ' + ns + ' 删除 ' + n + ' 条');
  }

  /* ---------- 3. 复查 ---------- */
  const cs2 = new CloudStore();
  await cs2.load();
  console.log('\n云端现状：');
  for (const [ns, b] of cs2.mem) {
    if (ns === 'meta') continue;
    console.log('  ' + ns + ': ' + b.size);
  }
  const u3 = cs2.mem.get('users');
  if (u3) for (const [, rec] of u3) {
    const d = docOf(rec);
    console.log('  用户: ' + d.username + ' / ' + d.nickname + ' / ' + d.authType);
  }
})().catch((e) => { console.error(e); process.exit(1); });
