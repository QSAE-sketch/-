'use strict';
/**
 * 线上多选功能验证脚本
 * 针对已部署的线上站点跑一遍完整的多选闭环：
 *   注册 → 发消息 → 批量删除（本机隐藏）→ 批量直接删除（全端清除）
 * 同时验证旁观者视角的差异（隐藏 vs 彻底清除）。
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const BASE = 'https://qingliao-chat-33476.app.workbuddy.host';
const SHARE_CODE = process.env.SHARE_CODE || 'T7ELJZOC5A';
let pass = 0, fail = 0;

// 线上网关要求带 sharecode 访问过一次，拿到会话 Cookie 后后续 API 才能通
const COOKIES = {};

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Type'] = 'application/json';
    const ck = Object.keys(COOKIES).map((k) => k + '=' + COOKIES[k]).join('; ');
    if (ck) headers['Cookie'] = ck;
    const u = new URL(path, BASE);
    const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers }, (res) => {
      const setC = res.headers['set-cookie'] || [];
      for (const line of setC) {
        const kv = line.split(';')[0];
        const i = kv.indexOf('=');
        if (i > 0) COOKIES[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      }
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(cs);
        let j = null;
        try { j = JSON.parse(raw.toString()); } catch (e) {}
        resolve({ status: res.statusCode, json: j, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** 先访问带 sharecode 的首页，建立网关会话 */
async function handshake() {
  const r = await req('GET', '/?sharecode=' + SHARE_CODE);
  return r.status === 200;
}
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 250) : '')); }
}
function findMsg(list, id) { return (list || []).find((x) => x.id === id) || null; }

(async () => {
  const uniq = crypto.randomBytes(3).toString('hex');
  const A = 'qa' + uniq, B = 'qb' + uniq;
  const pw = 'pass123';

  check('网关会话握手成功（sharecode）', await handshake());

  let r = await req('POST', '/api/register', { username: A, password: pw, nickname: '甲' });
  const ta = r.json && r.json.token;
  r = await req('POST', '/api/register', { username: B, password: pw, nickname: '乙' });
  const tb = r.json && r.json.token;
  check('线上注册两个账号成功', !!ta && !!tb);

  r = await req('GET', '/api/rooms', null, ta);
  const pubId = r.json && r.json.publicRoomId;
  check('获取公共聊天室成功', !!pubId, r.json);

  /* ---- 批量删除：仅本机隐藏 ---- */
  console.log('\n【批量删除】仅对本机隐藏');
  const delIds = [];
  for (let i = 0; i < 3; i++) {
    r = await req('POST', '/api/rooms/' + pubId + '/messages',
      { kind: 'text', content: '线上批量删除验证 ' + i }, ta);
    delIds.push(r.json.message.id);
  }
  check('发送 3 条消息', delIds.every((x) => !!x), delIds);

  r = await req('POST', '/api/messages/batch-delete', { ids: delIds }, ta);
  check('线上批量删除接口返回 ok', r.status === 200 && r.json.ok === true, r.json);
  check('线上批量删除 3 条全部成功', r.json.count === 3 && r.json.hidden.length === 3, r.json);

  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0&limit=200', null, ta);
  check('本机已看不到这 3 条', !delIds.some((id) => findMsg(r.json.messages, id)), delIds);

  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0&limit=200', null, tb);
  check('旁观者仍能看到全部 3 条（服务端数据保留）',
    delIds.every((id) => findMsg(r.json.messages, id)), delIds);

  /* ---- 批量直接删除：全端清除 ---- */
  console.log('\n【批量直接删除】服务器端彻底清除');
  const purgeIds = [];
  for (let i = 0; i < 3; i++) {
    r = await req('POST', '/api/rooms/' + pubId + '/messages',
      { kind: 'text', content: '线上批量直接删除验证 ' + i }, ta);
    purgeIds.push(r.json.message.id);
  }
  check('再发送 3 条消息', purgeIds.every((x) => !!x), purgeIds);

  r = await req('POST', '/api/messages/batch-purge', { ids: purgeIds }, ta);
  check('线上批量直接删除接口返回 ok', r.status === 200 && r.json.ok === true, r.json);
  check('线上批量直接删除 3 条全部成功', r.json.count === 3 && r.json.purged.length === 3, r.json);

  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0&limit=200', null, ta);
  check('本机列表已不含这 3 条', !purgeIds.some((id) => findMsg(r.json.messages, id)), purgeIds);
  check('本机收到 purgedIds 同步通知',
    r.json.purgedIds && purgeIds.every((id) => r.json.purgedIds.indexOf(id) >= 0), r.json.purgedIds);

  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0&limit=200', null, tb);
  check('旁观者列表同样已不含这 3 条（全端清除）',
    !purgeIds.some((id) => findMsg(r.json.messages, id)), purgeIds);
  check('旁观者也收到 purgedIds',
    r.json.purgedIds && purgeIds.every((id) => r.json.purgedIds.indexOf(id) >= 0), r.json.purgedIds);

  /* ---- 参数校验 ---- */
  console.log('\n【参数校验】');
  r = await req('POST', '/api/messages/batch-delete', { ids: [] }, ta);
  check('空列表被拒(400)', r.status === 400, r.json);
  r = await req('POST', '/api/messages/batch-purge', { ids: [] }, ta);
  check('批量直接删除空列表被拒(400)', r.status === 400, r.json);
  r = await req('POST', '/api/messages/batch-delete', { ids: [] });
  check('未登录被拒(401)', r.status === 401, r.json);

  /* ---- 撤回仍为单条 ---- */
  console.log('\n【撤回】保持单条语义');
  r = await req('POST', '/api/rooms/' + pubId + '/messages', { kind: 'text', content: '线上撤回验证' }, ta);
  const rid = r.json.message.id;
  r = await req('POST', '/api/messages/' + rid + '/recall', {}, ta);
  check('单条撤回成功', r.status === 200 && r.json.recalled === true, r.json);
  r = await req('POST', '/api/messages/batch-purge', { ids: [rid] }, ta);
  check('已撤回消息在批量直接删除中被跳过', r.status === 200 && r.json.failed.length === 1, r.json);

  /* ---- 清理：把剩余的验证消息清掉 ---- */
  r = await req('GET', '/api/rooms/' + pubId + '/messages?since=0&limit=200', null, ta);
  const leftovers = (r.json.messages || [])
    .filter((m) => /线上批量删除验证|线上批量直接删除验证/.test(m.content || ''))
    .map((m) => m.id);
  if (leftovers.length) {
    await req('POST', '/api/messages/batch-purge', { ids: leftovers }, ta);
  }
  console.log('\n[清理] 已清除 ' + leftovers.length + ' 条验证残留消息');

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常:', e && e.stack ? e.stack : e);
  console.log('\n通过: ' + pass + '  失败: ' + (fail + 1));
  process.exit(1);
});
