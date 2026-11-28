/**
 * 内容安全：敏感词过滤（合规补强 · 2026-11-28）
 *
 * 词库来源：开源项目 konsheng/Sensitive-lexicon（MIT License），
 * 按聊天场景筛选合并 11 个违法/违规类目（色情/暴恐/涉枪涉爆/反动/政治/贪腐/补充/GFW/非法网址），
 * 共 23,498 条，避免误伤日常聊天未收录 民生/广告/网易/腾讯输入法 等宽泛类目。
 * 合并脚本：tools/build-moderation-words.py。
 *
 * 设计原则：
 *  1. 词库是**可编辑的数据**：优先读 data/moderation-words.json（用户自定义，
 *     每次调用按 mtime 重读、改完即生效），不存在则用内置 assets/moderation-words.json。
 *  2. 匹配前做轻量归一化（去空白/标点/零宽字符、转小写），防止「赌 博」「赌·博」式绕过；
 *     词库条目同样归一化后入集合（如网址去点号后仍能命中）。
 *  3. 只在服务端发消息入口调用，命中直接拒发（400），不做替换、不做静默丢弃——
 *     拒发是对用户最诚实的处置，也符合「发现违法信息停止传输」的义务定位。
 *  4. 纯子串集合匹配，无 AI 无分词；2 万+词条下单条消息耗时毫秒级，规模内足够。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const USER_FILE = path.join(ROOT, '..', 'data', 'moderation-words.json');
const BUILTIN_FILE = path.join(ROOT, '..', 'assets', 'moderation-words.json');

/** 归一化：去掉会干扰比对/被用来绕过的字符，统一小写 */
const STRIP_RE = /[\s\u200b-\u200f\u2028\u2029\uFEFF·・,.;:、，。；："'`~!@#$%^&*()_+=\[\]{}|<>？?！￥…（）【】《》\-—_=*\\/]/g;

function normalize(s) {
  return String(s || '').toLowerCase().replace(STRIP_RE, '');
}

let cache = { mtime: 0, set: null, allow: null, maxLen: 0, minLen: 0, count: 0, file: '' };

/** 读词库并构建匹配集合（按文件 mtime 缓存，改词库即生效） */
function loadWords() {
  const file = fs.existsSync(USER_FILE) ? USER_FILE : BUILTIN_FILE;
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch (e) { return null; }
  if (cache.set && cache.file === file && cache.mtime === mtime) return cache;

  let words = [];
  let allow = [];
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
    words = Array.isArray(j.words) ? j.words : (Array.isArray(j) ? j : []);
    allow = Array.isArray(j.allow) ? j.allow : [];
  } catch (e) {
    console.error('[moderation] 词库解析失败，暂用空词库:', e.message);
    return { set: new Set(), allow: new Set(), maxLen: 0, minLen: 0, count: 0, file, mtime };
  }

  const allowSet = new Set(allow.map(normalize).filter(Boolean));
  const set = new Set();
  let maxLen = 0, minLen = Infinity;
  for (const w of words) {
    const n = normalize(w);
    if (n.length < 2) continue;          // 单字符跳过：中文单字误伤率过高
    if (allowSet.has(n)) continue;       // 豁免名单：词库里的日常词放行
    set.add(n);
    if (n.length > maxLen) maxLen = n.length;
    if (n.length < minLen) minLen = n.length;
  }
  cache = { mtime, set, allow: allowSet, maxLen: maxLen || 0, minLen: minLen === Infinity ? 0 : minLen, count: set.size, file };
  return cache;
}

/**
 * 检查文本。返回 { ok, hit }：ok=true 放行；ok=false 时 hit 为命中的词条。
 * 空词库 / 空文本一律放行。
 */
function check(text) {
  const c = loadWords();
  if (!c || !c.set || !c.set.size) return { ok: true };
  const norm = normalize(text);
  if (!norm || norm.length < c.minLen) return { ok: true };

  // 从左到右按「最长词优先」扫窗口：命中即返回（不做全量枚举）
  for (let i = 0; i <= norm.length - c.minLen; i++) {
    const end = Math.min(norm.length, i + c.maxLen);
    for (let j = end; j >= i + c.minLen; j--) {
      const sub = norm.slice(i, j);
      if (c.set.has(sub)) return { ok: false, hit: sub };
    }
  }
  return { ok: true };
}

/** 词库概况（给 /api/admin 看的运维信息） */
function info() {
  const c = loadWords();
  if (!c) return { file: '', count: 0, error: '词库文件不存在' };
  return { file: c.file, count: c.count, maxLen: c.maxLen, custom: c.file === USER_FILE };
}

module.exports = { check, info, normalize };
