'use strict';
/**
 * 站内云网盘专项测试。
 *
 * 覆盖：
 *   A. 网盘列表 / 搜索 / 类型筛选 / 排序 / 分页
 *   B. 详情（含 md5）、重命名、移动目录
 *   C. 聊天文件天然入库（网盘复用 files 集合，不存在「转存」动作）
 *   D. 回收站：软删除 -> 恢复 -> 彻底删除（配额随之释放）
 *   E. 分享：公开 / 加密提取码 / 过期 / 取消
 *   F. 权限隔离与配额闸门
 *   G. 会话共享文件聚合、版本接口标记
 *
 * 自带独立服务（PORT=3316，DATA_DIR=data-drive），不干扰主套件。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3316;
const DATA_DIR = path.join(ROOT, 'data-drive');
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 260) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rnd() { return crypto.randomBytes(3).toString('hex'); }

function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (token) headers['X-Token'] = token;
    if (data) headers['Content-Type'] = 'application/json';
    const u = new URL(urlPath, BASE);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(cs);
        let j = null;
        try { j = JSON.parse(raw.toString()); } catch (e) { /* 可能是二进制 */ }
        resolve({ status: res.statusCode, json: j, raw: raw, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function putChunk(fileId, i, buf, token) {
  return new Promise((resolve, reject) => {
    const u = new URL('/api/files/' + fileId + '/chunk?i=' + i, BASE);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'PUT',
      headers: { 'X-Token': token, 'Content-Type': 'application/octet-stream' }
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        let j = null; try { j = JSON.parse(Buffer.concat(cs).toString()); } catch (e) {}
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    r.write(buf);
    r.end();
  });
}

/** 走完整上传链路；roomId 留空即为「网盘直传」 */
async function upload(token, opts) {
  const o = opts || {};
  const size = o.size || 4096;
  const buf = o.buf || crypto.randomBytes(size);
  const name = o.name || ('f-' + rnd() + '.bin');
  const mime = o.mime || 'application/octet-stream';

  let r = await req('POST', '/api/files/init', {
    name: name, size: buf.length, mime: mime, roomId: o.roomId || ''
  }, token);
  if (r.status !== 200) return { ok: false, stage: 'init', status: r.status, json: r.json };

  const fid = r.json.fileId, cs = r.json.chunkSize, total = r.json.totalChunks;
  for (let i = 0; i < total; i++) {
    const part = buf.slice(i * cs, Math.min(buf.length, (i + 1) * cs));
    const pr = await putChunk(fid, i, part, token);
    if (pr.status !== 200) return { ok: false, stage: 'chunk', status: pr.status, json: pr.json };
  }
  r = await req('POST', '/api/files/' + fid + '/complete', {}, token);
  return { ok: r.status === 200, fileId: fid, buf: buf, name: name, status: r.status, json: r.json };
}

async function register(prefix, nickname) {
  const u = prefix + rnd();
  const r = await req('POST', '/api/register', { username: u, password: 'pass123', nickname: nickname || '网盘用户' });
  return { username: u, token: r.json && r.json.token, user: r.json && r.json.user, status: r.status, json: r.json };
}

let child = null;
function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        DATA_DIR: DATA_DIR,
        STORAGE_BACKEND: 'local'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d.toString(); });
    child.stderr.on('data', (d) => { log += d.toString(); });
    const t0 = Date.now();
    const poll = async () => {
      if (Date.now() - t0 > 30000) return reject(new Error('测试服务启动超时\n' + log));
      try {
        const r = await req('GET', '/api/version');
        if (r.status === 200) return resolve();
      } catch (_) {}
      await sleep(250);
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
    setTimeout(() => { try { if (child && child.exitCode === null) child.kill('SIGKILL'); } catch (_) {} resolve(); }, 2500);
  });
}

(async () => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  await startServer();

  /* ================= 0. 版本标记 ================= */
  console.log('\n【0】网盘内置于本站');
  let r = await req('GET', '/api/version');
  check('版本接口标记 drive.enabled', r.status === 200 && r.json.drive && r.json.drive.enabled === true, r.json);
  check('不再下发独立网盘地址', r.json.netdiskUrl === '', r.json.netdiskUrl);

  const A = await register('drv_a_', '网盘甲');
  const B = await register('drv_b_', '网盘乙');
  check('两个测试账号注册成功', !!A.token && !!B.token);
  const pubId = (await req('GET', '/api/rooms', null, A.token)).json.publicRoomId;

  /* ================= A. 列表 / 搜索 / 筛选 / 排序 ================= */
  console.log('\n【A】列表、搜索、类型筛选、排序');

  r = await req('GET', '/api/drive/storage', null, A.token);
  check('新账号配额已就绪', r.status === 200 && r.json.quota > 0 && r.json.used === 0, r.json);
  check('新账号文件数 0', r.json.fileCount === 0, r.json);
  check('新账号回收站 0', r.json.trashCount === 0, r.json);

  r = await req('GET', '/api/drive/files', null, A.token);
  check('网盘初始为空', r.status === 200 && r.json.total === 0, r.json);

  const img = await upload(A.token, { name: '风景.png', mime: 'image/png', size: 3000 });
  const doc = await upload(A.token, { name: '说明.txt', mime: 'text/plain', size: 9000 });
  const zip = await upload(A.token, { name: '打包.zip', mime: 'application/zip', size: 20000 });
  check('图片上传成功（网盘直传，不带房间）', img.ok, img);
  check('文档上传成功', doc.ok, doc);
  check('压缩包上传成功', zip.ok, zip);

  r = await req('GET', '/api/drive/files', null, A.token);
  check('列表返回 3 个文件', r.json.total === 3, r.json.total);
  check('文件类型识别正确', r.json.items.every((x) => typeof x.typeLabel === 'string' && x.typeLabel.length > 0));
  const imgItem = r.json.items.filter((x) => x.fileId === img.fileId)[0];
  check('图片被归类为 image', imgItem && imgItem.type === 'image', imgItem && imgItem.type);
  check('网盘直传的文件不带来源房间', imgItem && imgItem.fromChat === false && imgItem.roomName === '网盘上传', imgItem);

  r = await req('GET', '/api/drive/files?keyword=风景', null, A.token);
  check('按文件名搜索命中 1 个', r.json.total === 1 && r.json.items[0].fileId === img.fileId, r.json.total);

  r = await req('GET', '/api/drive/files?keyword=' + encodeURIComponent('.txt'), null, A.token);
  check('搜索不区分大小写与位置', r.json.total === 1 && r.json.items[0].fileId === doc.fileId, r.json.total);

  r = await req('GET', '/api/drive/files?type=archive', null, A.token);
  check('按类型筛选出压缩包', r.json.total === 1 && r.json.items[0].fileId === zip.fileId, r.json.total);

  r = await req('GET', '/api/drive/files?sort=size', null, A.token);
  check('按体积倒序', r.json.items[0].fileId === zip.fileId, r.json.items.map((x) => x.size));

  r = await req('GET', '/api/drive/files?sort=name', null, A.token);
  check('按名称排序可用', r.json.total === 3, r.json.total);

  r = await req('GET', '/api/drive/files?page=1&size=2', null, A.token);
  check('分页：每页 2 条', r.json.items.length === 2 && r.json.pages === 2, { n: r.json.items.length, pages: r.json.pages });
  check('分页：还有下一页', r.json.hasMore === true, r.json.hasMore);

  /* ================= B. 详情 / 重命名 / 移动 ================= */
  console.log('\n【B】详情、重命名、移动目录');

  r = await req('GET', '/api/drive/files/' + doc.fileId, null, A.token);
  check('详情返回文件名与体积', r.status === 200 && r.json.name === '说明.txt' && r.json.size === 9000, r.json);
  check('小文件自动算出 md5', /^[a-f0-9]{32}$/.test(r.json.md5 || ''), r.json.md5);
  check('详情给出下载入口', typeof r.json.downloadUrl === 'string' && r.json.downloadUrl.indexOf('/api/files/') === 0);

  r = await req('PATCH', '/api/drive/files/' + doc.fileId, { name: '说明（改）.txt' }, A.token);
  check('重命名成功', r.status === 200 && r.json.name === '说明（改）.txt', r.json);
  r = await req('GET', '/api/drive/files/' + doc.fileId, null, A.token);
  check('重命名已持久化', r.json.name === '说明（改）.txt', r.json.name);

  r = await req('PATCH', '/api/drive/files/' + doc.fileId, { name: 'bad/name.txt' }, A.token);
  check('含非法字符的名字被拒 400', r.status === 400, r.json);
  r = await req('PATCH', '/api/drive/files/' + doc.fileId, { name: '   ' }, A.token);
  check('空名字被拒 400', r.status === 400, r.json);
  r = await req('PATCH', '/api/drive/files/' + doc.fileId, {}, A.token);
  check('没有可改字段被拒 400', r.status === 400, r.json);

  r = await req('PATCH', '/api/drive/files/' + doc.fileId, { folder: '资料' }, A.token);
  check('移动到目录成功', r.status === 200 && r.json.folder === '资料', r.json);

  r = await req('GET', '/api/drive/files?folder=' + encodeURIComponent('资料'), null, A.token);
  check('按目录筛选命中 1 个', r.json.total === 1 && r.json.items[0].fileId === doc.fileId, r.json.total);
  check('目录清单包含「资料」', r.json.folders.indexOf('资料') >= 0, r.json.folders);

  r = await req('GET', '/api/drive/files?folder=', null, A.token);
  check('根目录筛选排除已移动的文件', r.json.items.every((x) => x.fileId !== doc.fileId), r.json.total);

  /* ================= C. 聊天文件天然入库 ================= */
  console.log('\n【C】聊天里发出的文件天生在网盘里');

  const chatFile = await upload(A.token, {
    name: '大厅文件.txt', mime: 'text/plain', size: 2048, roomId: pubId
  });
  check('往公共大厅上传文件成功', chatFile.ok, chatFile);

  r = await req('GET', '/api/drive/files', null, A.token);
  const cf = r.json.items.filter((x) => x.fileId === chatFile.fileId)[0];
  check('聊天文件自动出现在网盘（无需转存）', !!cf, r.json.total);
  check('带来源房间名', cf && cf.fromChat === true && cf.roomName === '公共聊天室', cf && cf.roomName);

  r = await req('GET', '/api/rooms/' + pubId + '/files', null, A.token);
  check('会话共享文件聚合到该文件', r.status === 200 && r.json.files.some((x) => x.fileId === chatFile.fileId), r.json.total);
  r = await req('GET', '/api/rooms/' + pubId + '/files?type=image', null, A.token);
  check('会话文件可按类型筛选', r.status === 200 && r.json.files.every((x) => x.type === 'image'), r.json.total);

  /* ================= D. 回收站 ================= */
  console.log('\n【D】回收站：软删 -> 恢复 -> 彻底删除');

  const beforeUsed = (await req('GET', '/api/drive/storage', null, A.token)).json.used;

  r = await req('DELETE', '/api/drive/files/' + zip.fileId, null, A.token);
  check('软删除成功', r.status === 200 && r.json.deletedAt > 0, r.json);
  check('提示保留天数 30', r.json.keepDays === 30, r.json.keepDays);

  r = await req('GET', '/api/drive/files', null, A.token);
  check('列表里不再出现', r.json.items.every((x) => x.fileId !== zip.fileId), r.json.total);

  r = await req('GET', '/api/drive/trash', null, A.token);
  check('回收站里能看到', r.json.items.some((x) => x.fileId === zip.fileId), r.json.total);
  const trashed = r.json.items.filter((x) => x.fileId === zip.fileId)[0];
  check('回收站给出剩余天数', trashed && trashed.remainDays >= 29, trashed && trashed.remainDays);

  r = await req('GET', '/api/rooms/' + pubId + '/files', null, A.token);
  check('会话文件列表同样隐藏回收站文件', r.json.files.every((x) => x.fileId !== zip.fileId));

  r = await req('DELETE', '/api/drive/files/' + zip.fileId, null, A.token);
  check('重复软删幂等', r.status === 200 && r.json.already === true, r.json);

  r = await req('GET', '/api/drive/storage', null, A.token);
  check('回收站内仍占用配额（30 天内可恢复）', r.json.used === beforeUsed, { used: r.json.used, before: beforeUsed });
  check('回收站计数为 1', r.json.trashCount === 1, r.json.trashCount);

  r = await req('GET', '/api/files/' + zip.fileId + '/download', null, A.token);
  check('回收站文件不可下载 404', r.status === 404, r.json);
  r = await req('GET', '/api/files/' + zip.fileId + '/raw', null, A.token);
  check('回收站文件不可预览 404', r.status === 404, r.json);

  r = await req('POST', '/api/drive/trash/' + zip.fileId + '/restore', {}, A.token);
  check('恢复成功', r.status === 200 && !!r.json.fileId, r.json);
  r = await req('GET', '/api/drive/files', null, A.token);
  check('恢复后重新出现在列表', r.json.items.some((x) => x.fileId === zip.fileId));
  r = await req('GET', '/api/files/' + zip.fileId + '/download', null, A.token);
  check('恢复后可正常下载', r.status === 200 && r.raw.length === 20000, { status: r.status, len: r.raw.length });

  r = await req('DELETE', '/api/drive/trash/' + zip.fileId, null, A.token);
  check('未在回收站时彻底删除被拒 400', r.status === 400, r.json);

  await req('DELETE', '/api/drive/files/' + zip.fileId, null, A.token);
  r = await req('DELETE', '/api/drive/trash/' + zip.fileId, null, A.token);
  check('彻底删除成功', r.status === 200 && r.json.purged === true, r.json);
  r = await req('GET', '/api/drive/trash', null, A.token);
  check('回收站已清空该文件', r.json.items.every((x) => x.fileId !== zip.fileId), r.json.total);
  r = await req('GET', '/api/drive/storage', null, A.token);
  check('彻底删除后配额释放', r.json.used === beforeUsed - 20000, { used: r.json.used, expect: beforeUsed - 20000 });
  r = await req('GET', '/api/drive/files/' + zip.fileId, null, A.token);
  check('彻底删除后详情 404', r.status === 404, r.json);

  /* ================= E. 分享 ================= */
  console.log('\n【E】分享：公开 / 加密 / 过期 / 取消');

  r = await req('POST', '/api/drive/files/' + img.fileId + '/share', { days: 7 }, A.token);
  check('创建公开分享', r.status === 200 && !!r.json.shareId, r.json);
  check('公开分享不需要提取码', r.json.needCode === false && r.json.encrypted === false, r.json);
  const pubShareId = r.json.shareId;
  check('分享地址形如 /s/xxx', r.json.url === '/s/' + pubShareId, r.json.url);
  check('默认 7 天有效期', r.json.expireAt > Date.now() + 6 * 864e5, r.json.expireAt);

  // 分享落地页路由：此前 /s/xxx 被当静态文件 → 404（重大 bug）
  r = await req('GET', '/s/' + pubShareId);
  check('分享页返回 200（不再 404）', r.status === 200, r.status);
  check('分享页是 share.html', /文件分享/.test(r.raw.toString()) &&
    /src="\/share\.js/.test(r.raw.toString()), r.raw.toString().slice(0, 120));
  r = await req('GET', '/s/' + pubShareId + '?sharecode=TESTCODE');
  check('分享页资源保留 sharecode', /\/share\.js\?sharecode=TESTCODE/.test(r.raw.toString()), r.raw.toString().slice(0, 400));

  // 匿名访问（不带 token）
  r = await req('GET', '/api/drive/s/' + pubShareId);
  check('匿名可读公开分享', r.status === 200 && r.json.passed === true, r.json);
  check('分享不回显提取码', r.json.code === '', r.json.code);
  check('分享带上传者昵称', r.json.ownerName === '网盘甲', r.json.ownerName);

  r = await req('GET', '/api/drive/s/' + pubShareId + '/dl');
  check('匿名可下载公开分享', r.status === 200 && r.raw.length === 3000, { status: r.status, len: r.raw && r.raw.length });

  r = await req('GET', '/api/drive/s/' + pubShareId);
  check('下载次数已累计', r.json.downloads >= 1, r.json.downloads);

  r = await req('POST', '/api/drive/files/' + img.fileId + '/share', { days: 3, encrypted: true, code: 'ab12' }, A.token);
  check('同一文件复用分享记录', r.status === 200 && r.json.shareId === pubShareId, r.json);
  check('切换为加密分享', r.json.encrypted === true && r.json.needCode === true, r.json);

  r = await req('GET', '/api/drive/s/' + pubShareId);
  check('加密分享未带码：不通过', r.json.passed === false, r.json);
  check('未带码时不给出下载地址', r.json.downloadUrl === '', r.json.downloadUrl);

  r = await req('GET', '/api/drive/s/' + pubShareId + '?code=ab12');
  check('带正确提取码通过', r.json.passed === true && !!r.json.downloadUrl, r.json);

  r = await req('GET', '/api/drive/s/' + pubShareId + '?code=zzzz');
  check('错误提取码不通过', r.json.passed === false, r.json);

  r = await req('GET', '/api/drive/s/' + pubShareId + '/dl?code=zzzz');
  check('错误提取码下载被拒 403', r.status === 403, r.json);
  r = await req('GET', '/api/drive/s/' + pubShareId + '/dl?code=ab12');
  check('正确提取码可下载', r.status === 200 && r.raw.length === 3000, { status: r.status, len: r.raw && r.raw.length });

  r = await req('GET', '/api/drive/shares', null, A.token);
  check('我的分享列表包含该条', r.json.items.some((x) => x.shareId === pubShareId), r.json.total);

  // 过期：用极短时长（约 1 秒）
  r = await req('POST', '/api/drive/files/' + doc.fileId + '/share', { days: 1 / 86400 }, A.token);
  check('创建短时分享', r.status === 200 && !!r.json.shareId, r.json);
  const shortShareId = r.json.shareId;
  await sleep(1400);
  r = await req('GET', '/api/drive/s/' + shortShareId);
  check('过期分享被拒 410', r.status === 410, r.json);
  r = await req('GET', '/api/drive/s/' + shortShareId + '/dl');
  check('过期分享不可下载 410', r.status === 410, r.json);

  r = await req('DELETE', '/api/drive/shares/' + pubShareId, null, A.token);
  check('取消分享成功', r.status === 200 && r.json.revoked === true, r.json);
  r = await req('GET', '/api/drive/s/' + pubShareId);
  check('取消后匿名访问 404', r.status === 404, r.json);

  r = await req('POST', '/api/drive/files/' + img.fileId + '/share', { encrypted: true, code: 'x' }, A.token);
  check('提取码过短被拒 400', r.status === 400, r.json);

  /* ================= F. 隔离与配额 ================= */
  console.log('\n【F】权限隔离与配额闸门');

  r = await req('GET', '/api/drive/files', null, B.token);
  check('B 看不到 A 的文件', r.status === 200 && r.json.total === 0, r.json.total);

  r = await req('GET', '/api/drive/files/' + img.fileId, null, B.token);
  check('B 读 A 的文件详情被拒 404', r.status === 404, r.json);
  r = await req('DELETE', '/api/drive/files/' + img.fileId, null, B.token);
  check('B 不能删 A 的文件', r.status === 404, r.json);
  r = await req('POST', '/api/drive/files/' + img.fileId + '/share', {}, B.token);
  check('B 不能分享 A 的文件', r.status === 404, r.json);
  r = await req('PATCH', '/api/drive/files/' + img.fileId, { name: 'hack.png' }, B.token);
  check('B 不能改 A 的文件名', r.status === 404, r.json);

  r = await req('POST', '/api/files/init', {
    name: 'huge.bin', size: 3 * 1024 * 1024 * 1024, mime: 'application/octet-stream'
  }, B.token);
  check('超过单文件上限被拒 400', r.status === 400, r.json);

  r = await req('GET', '/api/drive/files', null, null);
  check('未登录访问网盘被拒 401', r.status === 401, r.json);

  /* ================= G. 收尾 ================= */
  console.log('\n【G】配额统计与收尾');

  r = await req('GET', '/api/drive/storage', null, A.token);
  // A 此时保留：img(3000) + doc(9000) + chatFile(2048)
  check('文件数统计正确', r.json.fileCount === 3, r.json.fileCount);
  check('已用空间等于三者之和', r.json.used === 3000 + 9000 + 2048, r.json.used);
  check('剩余空间 = 配额 - 已用', r.json.remain === r.json.quota - r.json.used, r.json);

  r = await req('POST', '/api/account/delete', { confirm: true }, A.token);
  check('注销账号成功', r.status === 200, r.json);
  r = await req('GET', '/api/drive/s/' + shortShareId);
  check('账号注销后其分享失效', r.status === 404 || r.status === 410, r.status);

  await stopServer();
  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('测试异常: ' + (e && e.stack ? e.stack : e));
  await stopServer();
  process.exit(1);
});
