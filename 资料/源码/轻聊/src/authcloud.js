'use strict';
/**
 * 云认证适配层：把 WorkBuddy 云服务的身份能力接到轻聊自己的账号体系上。
 *
 * 轻聊对外提供四种可选择的登录 / 注册方式：
 *   1. 账号 + 密码  —— 轻聊自有体系，不经过云服务（默认选项）
 *   2. 邮箱         —— 云服务邮箱密码（signInWithPassword / signUp）
 *   3. 验证码       —— 云服务发码 + 验码（邮箱验证码或短信验证码）
 *   4. WorkBuddy    —— 云服务 OAuth（PKCE）
 *
 * 无论用哪种方式登录，最终都会落到轻聊自己的 users 表上：
 * 云服务只负责「证明你是谁」，轻聊负责「你是哪个账号、能看哪些房间」。
 *
 * ---------------------------------------------------------------------------
 * 关于 WorkBuddy OAuth 的 sessionStorage
 * ---------------------------------------------------------------------------
 * SDK 的 PKCE verifier 存在 `globalThis.sessionStorage` 里
 * （WorkBuddyPkceStore.storage() 直接读这个全局对象）。
 * 浏览器里天然有；Node 端没有，SDK 会直接报
 * 「workbuddy sign-in requires sessionStorage ... unavailable in this runtime」。
 * 这里注入一个内存版实现：start 与 callback 两个请求跑在同一个进程里，
 * verifier 天然共享，语义上等价于浏览器的 sessionStorage。
 */

const { createWorkBuddyCloud, createMemoryStorage } = require('@tencent-ai/workbuddy-cloud-sdk');
const { PUBLIC_CONFIG } = require('./cloud');

/* ------------------------------------------------------------------ */
/* sessionStorage polyfill（必须在使用 SDK 之前注入）                    */
/* ------------------------------------------------------------------ */

(function installSessionStorage() {
  if (typeof globalThis.sessionStorage !== 'undefined' && globalThis.sessionStorage) return;
  const mem = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(String(k), String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
    key: (i) => Array.from(mem.keys())[i] || null,
    get length() { return mem.size; }
  };
})();

/* ------------------------------------------------------------------ */
/* 云客户端                                                             */
/* ------------------------------------------------------------------ */

let client = null;

function originFetch(origin) {
  return function (input, init) {
    const h = new Headers(init && init.headers);
    if (!h.has('origin')) h.set('origin', origin);
    return fetch(input, Object.assign({}, init, { headers: h }));
  };
}

function getClient() {
  if (client) return client;
  const org = PUBLIC_CONFIG.endpoint;
  client = createWorkBuddyCloud({
    endpoint: PUBLIC_CONFIG.endpoint,
    oauthRelayBaseUrl: PUBLIC_CONFIG.oauthRelayBaseUrl,
    publishableKey: PUBLIC_CONFIG.publishableKey,
    storage: createMemoryStorage(),
    fetch: originFetch(org)
  });
  return client;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                 */
/* ------------------------------------------------------------------ */

/** 把 SDK 的 CloudResult 拆成 (data, error) */
function unwrap(r) {
  if (!r) return { data: null, error: { message: '云服务无响应' } };
  if (r.error) {
    const msg = r.error && r.error.message ? r.error.message : '云服务返回错误';
    return { data: null, error: { message: msg, kind: r.error.kind || '', status: r.error.status || 0 } };
  }
  return { data: r.data, error: null };
}

/** CloudSession → 轻聊账号资料 */
function profileOf(session) {
  if (!session) return null;
  const u = session.user || {};
  return {
    cloudId: u.id || '',
    email: (u.email || '').trim().toLowerCase(),
    name: u.name || '',
    avatarUrl: u.avatarUrl || ''
  };
}

/** 归一化邮箱 / 手机号 */
function normalizeTarget(channel, target) {
  const t = String(target || '').trim();
  if (channel === 'sms') {
    const digits = t.replace(/\D/g, '');
    if (!/^1\d{10}$/.test(digits)) return null;
    return '+86 ' + digits;
  }
  const mail = t.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return null;
  return mail;
}

/* ------------------------------------------------------------------ */
/* 对外能力                                                             */
/* ------------------------------------------------------------------ */

/**
 * 发验证码。
 * @param {'email'|'sms'} channel
 * @param {string} target 邮箱或手机号
 * @returns {Promise<{ok:boolean, verificationId?:string, isExistingUser?:boolean, error?:object}>}
 */
async function sendOtp(channel, target) {
  const value = normalizeTarget(channel, target);
  if (!value) {
    return { ok: false, error: { message: channel === 'sms' ? '请填写正确的手机号' : '请填写正确的邮箱地址' } };
  }
  const creds = channel === 'sms' ? { phone: value } : { email: value };
  const { data, error } = unwrap(await getClient().auth.sendOtp(creds));
  if (error) return { ok: false, error };
  return {
    ok: true,
    verificationId: data.verificationId,
    // 上游告知这个标识是否已注册：已注册 → 登录；未注册 → 注册
    isExistingUser: !!data.isExistingUser
  };
}

/**
 * 验码。isExistingUser 决定走登录还是注册（上游给出的判断，SDK 不猜）。
 * 校验通过后返回轻聊账号资料。
 */
async function verifyOtp(opts) {
  const { channel, target, token, verificationId, isExistingUser, password, nickname } = opts;
  const value = normalizeTarget(channel, target);
  if (!value) return { ok: false, error: { message: channel === 'sms' ? '请填写正确的手机号' : '请填写正确的邮箱地址' } };
  if (!token) return { ok: false, error: { message: '请填写验证码' } };

  const params = { verificationId, token, isExistingUser: !!isExistingUser };
  if (channel === 'sms') params.phone = value;
  else params.email = value;
  if (password) params.password = password;

  const { data, error } = unwrap(await getClient().auth.verifyOtp(params));
  if (error) return { ok: false, error };
  const profile = profileOf(data);
  if (!profile) return { ok: false, error: { message: '云服务未返回用户信息' } };
  if (!profile.email && channel === 'email') profile.email = value;
  if (!profile.email && channel === 'sms') profile.email = '';
  profile.phone = channel === 'sms' ? value : '';
  profile.nickname = nickname || profile.name || profile.email || profile.phone || '用户';
  return { ok: true, profile };
}

/**
 * 邮箱 + 密码登录（云服务）。
 */
async function signInWithPassword(email, password) {
  const mail = normalizeTarget('email', email);
  if (!mail) return { ok: false, error: { message: '请填写正确的邮箱地址' } };
  const { data, error } = unwrap(await getClient().auth.signInWithPassword({ email: mail, password }));
  if (error) return { ok: false, error };
  const profile = profileOf(data);
  if (!profile) return { ok: false, error: { message: '云服务未返回用户信息' } };
  if (!profile.email) profile.email = mail;
  profile.phone = '';
  return { ok: true, profile };
}

/**
 * 邮箱注册（云服务）：必须先完成验证码验证，拿到 verificationToken。
 * 流程与验证码注册共用同一段验码逻辑，这里只是把密码一起带上去。
 */
async function signUpWithEmail(opts) {
  return verifyOtp(Object.assign({}, opts, { channel: 'email' }));
}

/**
 * 发起 WorkBuddy OAuth 登录，返回应跳转的地址。
 */
async function startWorkBuddyOAuth(redirectTo) {
  const { data, error } = unwrap(await getClient().auth.signInWithOAuth({
    provider: 'workbuddy',
    redirectTo
  }));
  if (error) return { ok: false, error };
  return { ok: true, url: data.url };
}

/**
 * 处理 WorkBuddy OAuth 回调，换取会话。
 * @param {string} search 回调 URL 的 query 部分
 */
async function handleWorkBuddyCallback(search) {
  const { data, error } = unwrap(await getClient().auth.handleWorkBuddyCallback(search));
  if (error) return { ok: false, error };
  if (!data) return { ok: false, error: { message: '回调缺少授权码，请重新登录' } };
  const profile = profileOf(data);
  if (!profile) return { ok: false, error: { message: '云服务未返回用户信息' } };
  profile.phone = '';
  return { ok: true, profile };
}

module.exports = {
  sendOtp,
  verifyOtp,
  signInWithPassword,
  signUpWithEmail,
  startWorkBuddyOAuth,
  handleWorkBuddyCallback,
  normalizeTarget
};
