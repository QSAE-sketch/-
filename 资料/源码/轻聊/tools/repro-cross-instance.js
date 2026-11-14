'use strict';
/**
 * 决定性复现：云端后端下，实例换新磁盘后已上传文件是否还能下载。
 *
 * 阶段 A: DATA_DIR=dirA 启动 -> 注册 -> 上传 -> complete
 * 阶段 B: 停服 -> DATA_DIR=dirB(全新空目录) 启动 -> 登录 -> 下载
 *
 * 若 B 阶段下载失败 => 文件元数据在云端、字节在本地磁盘，跨实例不可用。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 3488;
const BASE = 'http://127.0.0.1:' + PORT;
const U = 'repro' + Date.now().toString().slice(-6);
const P = 'pass123';

function log(...a) { console.log(...a); }

async function req(method, p, body, token) {
  const headers = {};
  if (token) headers['X-Token'] = token;
  let payload = body;
  if (body && !Buffer.isBuffer(body)) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(BASE + p, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text, res };
}

function startServer(dataDir, label) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: dataDir, STORAGE_BACKEND: 'cloud',
      PUBLIC_ORIGIN: 'https://qingliao-chat-33476.app.workbuddy.host'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => { if (process.env.VERBOSE) process.stdout.write('[' + label + '] ' + d); });
  child.stderr.on('data', (d) => { if (process.env.VERBOSE) process.stdout.write('[' + label + '!] ' + d); });
  return child;
}

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(BASE + '/api/rooms');
      if (r.status) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 3000);
  });
}

(async () => {
  const dirA = path.join(ROOT, 'data-repro-a');
  const dirB = path.join(ROOT, 'data-repro-b');
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });

  log('=== 阶段 A: DATA_DIR=' + dirA + ' ===');
  let srv = startServer(dirA, 'A');
  if (!await waitReady()) { console.error('A 未就绪'); process.exit(1); }
  log('  A 已就绪');

  let r = await req('POST', '/api/register', { username: U, password: P, nickname: 'r' });
  if (r.status !== 200) { console.error('注册失败', r.status, r.text); process.exit(1); }
  const token = r.json.token;
  log('  注册成功', U);

  const content = Buffer.from('REPRO-BYTES-' + U + '\n'.repeat(40));
  r = await req('POST', '/api/files/init', { name: 'r.txt', size: content.length, mime: 'text/plain' }, token);
  const fileId = r.json.fileId;
  await req('PUT', '/api/files/' + fileId + '/chunk?i=0', content, token);
  r = await req('POST', '/api/files/' + fileId + '/complete', {}, token);
  log('  上传完成 HTTP', r.status, JSON.stringify(r.json));

  r = await req('GET', '/api/files/' + fileId + '/raw', null, token);
  log('  阶段 A 同实例下载 HTTP', r.status, '内容一致 =', r.text === content.toString() ? 'YES' : 'NO');

  log('  停止 A，模拟实例更换（磁盘清空）...');
  await stop(srv);

  log('=== 阶段 B: DATA_DIR=' + dirB + '（全新空目录，模拟新实例）===');
  srv = startServer(dirB, 'B');
  if (!await waitReady()) { console.error('B 未就绪'); process.exit(1); }
  log('  B 已就绪');

  r = await req('POST', '/api/login', { username: U, password: P });
  log('  登录 HTTP', r.status, r.json && r.json.token ? 'OK' : 'FAIL ' + r.text);
  const token2 = r.json && r.json.token;

  r = await req('GET', '/api/files/' + fileId + '/status', null, token2);
  log('  文件元数据 status HTTP', r.status, JSON.stringify(r.json).slice(0, 200));

  r = await req('GET', '/api/files/' + fileId + '/raw', null, token2);
  log('  >>> 阶段 B 跨实例下载 HTTP', r.status, '| body:', JSON.stringify(r.text.slice(0, 120)));
  log('  >>> 结论: 跨实例可下载 =', r.status === 200 ? 'YES' : 'NO  ← 文件字节未进云端');

  await stop(srv);
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
