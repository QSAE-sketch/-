'use strict';
/**
 * 测试编排器：起服务 → 依次跑各测试文件 → 汇总 → 关服务。
 *
 * 之所以不用 shell 脚本编排，是因为在 Windows + Git Bash 下 `kill $PID` 会把
 * 信号广播到整个进程组，连编排脚本自己一起被 SIGTERM 掉，测试结果拿不到。
 * 用 Node 的 child_process 精确管理子进程可以彻底避开这个问题。
 *
 * 用法：node tools/run-suite.js [cloud|local]
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const BACKEND = (process.argv[2] || 'cloud').toLowerCase();
const PORT = 3311;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(ROOT, 'data-suite-' + BACKEND);

const TESTS = [
  'test/e2e.js',
  'test/e2e2.js',
  'test/sync.js',
  'test/roles.js',
  'test/purge.js',
  'test/auth.js',
  'test/multiselect.js',
  'test/friend.js',
  'test/theme.js',
  'test/cache.js',
  'test/version.js',
  'test/account.js',
  'test/room-features.js',
  'test/perm.js',
  'test/drive.js',
  'test/limits.js',
  'test/avatar.js',
  'test/lite-boot.js',
  'test/ui.js'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;

/**
 * 云端模式下，跑完测试后只删除「本次运行新产生」的文档。
 * 用运行前后的差集，误删不了运行前就存在的任何数据。
 */
async function cloudCleanup() {
  if (BACKEND !== 'cloud') return;
  try {
    const { CloudStore } = require('../src/cloud');
    const cs = new CloudStore();
    await cs.load();
    const keys = [];
    cs.mem.forEach((b, ns) => b.forEach((rec, id) => keys.push([ns, id])));
    if (!keys.length) return;
    const client = cs.cloud;
    let n = 0;
    for (const [ns, id] of keys) {
      if (beforeCloud.has(ns + '/' + id)) continue;
      const { error } = await client.database.from('docs').delete().eq('ns', ns).eq('id', id);
      if (!error) n++;
    }
    console.log('[清理] 已删除本次测试产生的云端文档 ' + n + ' 条');
  } catch (e) {
    console.log('[清理] 跳过：' + (e && e.message ? e.message : e));
  }
}

let beforeCloud = new Set();

async function snapshotCloud() {
  if (BACKEND !== 'cloud') return;
  try {
    const { CloudStore } = require('../src/cloud');
    const cs = new CloudStore();
    await cs.load();
    cs.mem.forEach((b, ns) => b.forEach((rec, id) => beforeCloud.add(ns + '/' + id)));
  } catch (_) { /* 云端不可用时不影响本地测试 */ }
}

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        DATA_DIR: DATA_DIR,
        STORAGE_BACKEND: BACKEND
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d.toString(); });
    child.stderr.on('data', (d) => { log += d.toString(); });
    const t0 = Date.now();
    const poll = async () => {
      if (Date.now() - t0 > 45000) return reject(new Error('服务启动超时\n' + log));
      try {
        const r = await fetch(BASE + '/');
        if (r.ok) {
          const line = log.split('\n').filter((l) => l.includes('存储后端')).join(' | ');
          console.log('[服务] 已启动 (' + BACKEND + ') ' + line);
          return resolve();
        }
      } catch (_) {}
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
    try { child.kill(); } catch (_) {}
    setTimeout(() => { try { if (child && child.exitCode === null) child.kill('SIGKILL'); } catch (_) {} resolve(); }, 3000);
  });
}

(async () => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  await snapshotCloud();
  await startServer();

  let totalPass = 0;
  let totalFail = 0;
  const summary = [];

  for (const t of TESTS) {
    console.log('\n======== ' + t + ' ========');
    const r = spawnSync(process.execPath, [t], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        DATA_DIR: DATA_DIR,
        STORAGE_BACKEND: BACKEND
      }),
      encoding: 'utf8'
    });
    const out = (r.stdout || '') + (r.stderr || '');
    const lines = out.trim().split('\n');
    // 打印最后若干行汇总
    const tail = lines.slice(-6);
    tail.forEach((l) => console.log('  ' + l));
    const m = out.match(/通过[:：]\s*(\d+)\s*失败[:：]\s*(\d+)/);
    const p = m ? Number(m[1]) : 0;
    const f = m ? Number(m[2]) : (r.status === 0 ? 0 : 1);
    totalPass += p;
    totalFail += f;
    summary.push({ test: t, pass: p, fail: f });
    if (r.status !== 0 && f === 0) {
      console.log('  (退出码 ' + r.status + '，但未输出统计行)');
    }
  }

  console.log('\n================ 汇总 (' + BACKEND + ' 后端) ================');
  summary.forEach((s) => console.log('  ' + s.test.padEnd(16) + ' 通过 ' + s.pass + '  失败 ' + s.fail));
  console.log('  合计: 通过 ' + totalPass + '  失败 ' + totalFail);

  await stopServer();
  await cloudCleanup();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(totalFail ? 1 : 0);
})();
