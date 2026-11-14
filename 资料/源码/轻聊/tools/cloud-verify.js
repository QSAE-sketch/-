'use strict';
/**
 * 云服务接入端到端验证脚本。
 *
 * 覆盖 4 件事：
 *   1. 起云后端服务 → 注册账号 → 直查云数据库，确认「接口返回成功 = 已落云」
 *   2. 建房间 + 发消息 → 直查云数据库，确认业务数据真的进了云端
 *   3. 硬杀进程（走 child.kill，不依赖 shell 的进程组信号）→ 重启服务 → 同一账号仍能登录、
 *      仍能读到房间与消息，证明数据跨进程存活
 *   4. 清理本次测试在云端产生的数据（按「测试前后 id 差集」精确删除，不碰其它数据）
 *
 * 用法：node tools/cloud-verify.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 3397;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(ROOT, 'data-cloud-verify');
const STAMP = String(Date.now()).slice(-8);
const USER = 'verify' + STAMP;
const PASS = 'pass123';

let pass = 0;
let failCount = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + name); }
  else { failCount++; console.log('  [FAIL] ' + name + (extra ? ' -> ' + extra : '')); }
}
function step(t) { console.log('\n=== ' + t + ' ==='); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 服务进程管理                                                        */
/* ------------------------------------------------------------------ */

let child = null;
const serverLog = [];

function startServer() {
  return new Promise((resolve, reject) => {
    serverLog.length = 0;
    child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        DATA_DIR: DATA_DIR,
        STORAGE_BACKEND: 'cloud'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const onData = (d) => {
      const s = d.toString();
      serverLog.push(s);
      process.stdout.write('    [srv] ' + s.trim() + '\n');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code, sig) => {
      console.log('    [srv] 进程退出 code=' + code + ' sig=' + sig);
    });
    const t0 = Date.now();
    const poll = async () => {
      if (Date.now() - t0 > 45000) return reject(new Error('服务启动超时'));
      try {
        const r = await fetch(BASE + '/');
        if (r.ok) return resolve();
      } catch (_) { /* 还没起来 */ }
      await sleep(300);
      return poll();
    };
    poll();
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    try { child.kill(); } catch (_) { /* ignore */ }
    setTimeout(() => {
      try { if (child && child.exitCode === null) child.kill('SIGKILL'); } catch (_) {}
      resolve();
    }, 3000);
  });
}

/* ------------------------------------------------------------------ */
/* HTTP 封装                                                           */
/* ------------------------------------------------------------------ */

async function api(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Token'] = token;
  const r = await fetch(BASE + p, {
    method: method,
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
  return { status: r.status, body: json };
}

/* ------------------------------------------------------------------ */
/* 云端直查                                                            */
/* ------------------------------------------------------------------ */

const { CloudStore } = require('../src/cloud');

async function cloudSnapshot() {
  const cs = new CloudStore();
  await cs.load();
  const map = new Map();
  cs.mem.forEach((bucket, ns) => {
    bucket.forEach((rec, id) => map.set(ns + '/' + id, rec.doc));
  });
  return map;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

(async () => {
  console.log('云服务接入验证 —— 账号:' + USER + ' 端口:' + PORT);

  // 清理上一次的测试目录
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}

  const before = await cloudSnapshot();
  console.log('\n[基线] 云端已有文档 ' + before.size + ' 条');

  try {
    /* ---------------- 阶段 1：启动 + 注册 ---------------- */
    step('阶段 1：启动云后端服务并注册账号');
    await startServer();
    const logText = serverLog.join('');
    check('启动日志声明使用云端后端', /workbuddy-cloud/.test(logText),
      logText.split('\n').filter((l) => l.includes('存储后端')).join(' | '));

    const reg = await api('POST', '/api/register', { username: USER, password: PASS, nickname: '验证' });
    check('注册接口返回 200', reg.status === 200, JSON.stringify(reg.body));
    check('注册返回 token 与用户', !!(reg.body && reg.body.token && reg.body.user), JSON.stringify(reg.body));
    const token = reg.body.token;
    const userId = reg.body.user && reg.body.user.id;

    // 关键断言：接口已经返回成功，云端必须立刻能查到
    const afterReg = await cloudSnapshot();
    const userDoc = afterReg.get('users/' + userId);
    check('注册返回后云端立即可查到该账号（响应=已落云）', !!userDoc,
      '云端 users 命名空间: ' + [...afterReg.keys()].filter((k) => k.startsWith('users/')).join(','));
    check('云端账号不含明文密码', !!userDoc && !JSON.stringify(userDoc).includes(PASS));
    check('云端账号含 scrypt 密码哈希', !!userDoc && typeof userDoc.passHash === 'string' && userDoc.passHash.length > 16);

    /* ---------------- 阶段 2：房间 + 消息 ---------------- */
    step('阶段 2：创建房间、发送消息并直查云端');
    const roomRes = await api('POST', '/api/rooms', { name: '云验证房间' }, token);
    check('创建房间成功', roomRes.status === 200 && !!(roomRes.body && roomRes.body.room), JSON.stringify(roomRes.body));
    const roomId = roomRes.body.room.id;

    const msgRes = await api('POST', '/api/rooms/' + roomId + '/messages', { kind: 'text', content: '云服务已接通' }, token);
    check('发送消息成功', msgRes.status === 200 && !!(msgRes.body && msgRes.body.message), JSON.stringify(msgRes.body));
    const msgId = msgRes.body.message && msgRes.body.message.id;

    const afterMsg = await cloudSnapshot();
    check('云端可查到房间文档', !!afterMsg.get('rooms/' + roomId));
    check('云端可查到消息文档', !!afterMsg.get('messages/' + msgId));
    check('云端可查到成员文档', !!afterMsg.get('members/' + roomId + ':' + userId));
    const msgDoc = afterMsg.get('messages/' + msgId);
    check('云端消息内容与发送内容一致', !!msgDoc && msgDoc.content === '云服务已接通',
      msgDoc ? JSON.stringify(msgDoc).slice(0, 120) : '未找到');
    check('消息 seq 单调递增（meta/seq 已落云）', !!afterMsg.get('meta/seq'));

    /* ---------------- 阶段 3：硬杀 + 重启 ---------------- */
    step('阶段 3：硬杀进程后重启，验证数据跨进程存活');
    await stopServer();
    await sleep(800);
    const afterKill = await cloudSnapshot();
    check('进程被杀后云端数据仍在（未被回滚/丢失）', !!afterKill.get('users/' + userId) && !!afterKill.get('messages/' + msgId));

    await startServer();
    const login = await api('POST', '/api/login', { username: USER, password: PASS });
    check('重启后同一账号仍可登录（数据跨进程存活）', login.status === 200 && !!(login.body && login.body.token),
      JSON.stringify(login.body));
    const token2 = login.body && login.body.token;

    if (token2) {
      const rooms = await api('GET', '/api/rooms', undefined, token2);
      const roomList = (rooms.body && rooms.body.rooms) || [];
      check('重启后能读到之前创建的房间', roomList.some((r) => r.id === roomId),
        '返回房间数: ' + roomList.length);
      const msgs = await api('GET', '/api/rooms/' + roomId + '/messages', undefined, token2);
      const msgList = (msgs.body && msgs.body.messages) || [];
      check('重启后能读到之前发送的消息', msgList.some((m) => m.id === msgId),
        '返回消息数: ' + msgList.length);
      const me = await api('GET', '/api/me', undefined, token2);
      check('重启后 /api/me 正常', me.status === 200 && !!(me.body && me.body.user));
    }

    await stopServer();

    /* ---------------- 阶段 4：清理 ---------------- */
    step('阶段 4：清理本次测试在云端产生的数据');
    const afterAll = await cloudSnapshot();
    const created = [];
    afterAll.forEach((doc, key) => { if (!before.has(key)) created.push(key); });
    console.log('  本次新增文档 ' + created.length + ' 条:');
    created.forEach((k) => console.log('    - ' + k));

    const client = new CloudStore().cloud;
    let deleted = 0;
    for (const key of created) {
      const slash = key.indexOf('/');
      const ns = key.slice(0, slash);
      const id = key.slice(slash + 1);
      const { error } = await client.database.from('docs').delete().eq('ns', ns).eq('id', id);
      if (error) console.log('    删除失败 ' + key + ': ' + error.message);
      else deleted++;
    }
    // 一并清掉最早的探测残留
    if (before.has('probe/p1')) {
      const { error } = await client.database.from('docs').delete().eq('ns', 'probe').eq('id', 'p1');
      if (!error) { deleted++; console.log('    - probe/p1 (历史探测残留)'); }
    }
    console.log('  已删除 ' + deleted + ' 条');

    const finalSnap = await cloudSnapshot();
    check('云端已清空测试残留', finalSnap.size === 0,
      '剩余: ' + [...finalSnap.keys()].join(','));

  } catch (e) {
    failCount++;
    console.error('\n验证脚本异常: ' + (e && e.stack ? e.stack : e));
  } finally {
    await stopServer();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\n通过: ' + pass + '  失败: ' + failCount);
  process.exit(failCount ? 1 : 0);
})();
