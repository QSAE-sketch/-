'use strict';
/**
 * 权限体系（最高权限）
 *
 * 三条独立来源，任一命中即为「最高权限」：
 *   1. 永久权限账号：账号名与昵称同时为「刘子墨」（命中后打上 founder 标记固化，
 *      之后改昵称也不会掉权限，避免手滑把永久权限改没了）。
 *   2. 权限密钥：登录 / 注册时输入，或登录后在「我的」页激活。
 *      密钥本身长期有效，**使用后**开启 30 分钟权限窗口（不是只能持有 30 分钟）。
 *      重复使用会重新计时（续期）。
 *   3. 无其他来源 —— 普通群主只能管自己的群，管不了公共大厅。
 *
 * 本模块只做纯计算，不读写数据库，方便直接单测。
 */

/** 权限窗口：30 分钟（自「使用密钥」那一刻开始计时） */
const MASTER_WINDOW_MS = 30 * 60 * 1000;

/** 永久权限账号的账号名 / 昵称 */
const FOUNDER_USERNAME = '刘子墨';
const FOUNDER_NICKNAME = '刘子墨';

/**
 * 官方审核账号（2026-11-28 合规补强新增）：
 * 内容合规需要人工审核通道，官方会用专门账号清除不良信息。
 * 该账号名注册即视为永久最高权限（昵称不限，命中后打 founder 标记固化）。
 */
const REVIEWER_USERNAME = 'L13902499337';

/**
 * 权限密钥默认值。可在部署环境用 PERM_KEY 覆盖（建议正式环境覆盖掉默认值）。
 * 默认值带品牌前缀，方便口头传达，不至于和普通密码混淆。
 */
const DEFAULT_PERM_KEY = 'lz-qingliao-2026';

function permKey() {
  const k = String(process.env.PERM_KEY || '').trim();
  return k || DEFAULT_PERM_KEY;
}

/**
 * 定长比较，避免按字符提前返回带来的时序差异。
 * 长度不同直接判否（密钥长度本身不是秘密）。
 */
function keyMatches(input) {
  const a = String(input == null ? '' : input);
  const b = permKey();
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 是否为永久权限账号（founder 标记优先；其次看创始人账号名+昵称，或官方审核账号名） */
function isFounder(user) {
  if (!user) return false;
  if (user.founder) return true;
  return (user.username === FOUNDER_USERNAME &&
      String(user.nickname || '') === FOUNDER_NICKNAME) ||
    user.username === REVIEWER_USERNAME;
}

/** 当前是否处于最高权限状态 */
function isMaster(user, ts) {
  if (!user) return false;
  if (isFounder(user)) return true;
  const t = typeof ts === 'number' ? ts : Date.now();
  return !!user.masterUntil && user.masterUntil > t;
}

/** 剩余有效期（毫秒）；永久权限返回 -1，无权限返回 0 */
function masterRemainMs(user, ts) {
  if (!user) return 0;
  if (isFounder(user)) return -1;
  const t = typeof ts === 'number' ? ts : Date.now();
  if (!user.masterUntil || user.masterUntil <= t) return 0;
  return user.masterUntil - t;
}

/**
 * 开启 / 续期权限窗口。
 * 每次调用都把到期时间重置为「现在 + 30 分钟」，而不是叠加。
 */
function grantMaster(user, ts) {
  if (!user) return 0;
  const t = typeof ts === 'number' ? ts : Date.now();
  user.masterAt = t;
  user.masterUntil = t + MASTER_WINDOW_MS;
  return user.masterUntil;
}

/** 命中永久权限条件时打标记（幂等，只在需要落库时由调用方保存） */
function latchFounder(user) {
  if (!user || user.founder) return false;
  // 创始人：账号名 + 昵称同时命中；审核账号：账号名命中即可（昵称不限）
  if (user.username === REVIEWER_USERNAME ||
      (user.username === FOUNDER_USERNAME &&
       String(user.nickname || '') === FOUNDER_NICKNAME)) {
    user.founder = true;
    return true;
  }
  return false;
}

module.exports = {
  MASTER_WINDOW_MS,
  FOUNDER_USERNAME,
  FOUNDER_NICKNAME,
  REVIEWER_USERNAME,
  DEFAULT_PERM_KEY,
  permKey,
  keyMatches,
  isFounder,
  isMaster,
  masterRemainMs,
  grantMaster,
  latchFounder
};
