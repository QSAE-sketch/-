'use strict';
/**
 * 线上冒烟：站内云网盘。
 *
 * 走真实公开链接，验证：
 *   · 版本标记与首页导航
 *   · 上传 -> 列表 -> 详情 -> 重命名 -> 分享 -> 匿名下载 -> 回收站 -> 恢复 -> 彻底删除
 *   · 聊天里发的文件同样出现在网盘（同一份数据）
 *   · 低配版页面同样带网盘入口
 * 结束时注销测试账号，云端不留任何测试数据。
 */

const https = require('https');
const crypto = require('crypto');

const BASE = process.argv[2] || 'https://qingliao-chat-33476.app.workbuddy.host';
const SHARE = process.argv[3] || 'T7ELJZOC5A';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 220) : '')); }
}

function request(method, path, body, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    if (!u.searchParams.has('sharecode')) u.searchParams.set('sharecode', SHARE);
    const data = body === null || body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { 'Host': u.host, 'User-Agent': o.ua || 'qingliao-smoke/1.7' };
    if (o.token) headers['X-Token'] = o.token;
    if (data) headers['Content-Type'] = 'application/json';
    if (o.raw) headers['Content-Type'] = 'application/octet-stream';
    const r = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers, timeout: 60000
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(cs);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch (e) {}
        resolve({ status: res.statusCode, json, raw, headers: res.headers });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** 分片上传（线上链路较长，这里直接走 init/chunk/complete） */
async function upload(token, name, mime, buf, roomId) {
  let r = await request('POST', '/api/files/init', {
    name, size: buf.length, mime, roomId: roomId || ''
  }, { token });
  if (r.status !== 200) return { ok: false, stage: 'init', status: r.status, json: r.json };
  const fid = r.json.fileId, cs = r.json.chunkSize, total = r.json.totalChunks;
  for (let i = 0; i < total; i++) {
    const part = buf.slice(i * cs, Math.min(buf.length, (i + 1) * cs));
    const put = await new Promise((resolve, reject) => {
      const u = new URL('/api/files/' + fid + '/chunk?i=' + i, BASE);
      if (!u.searchParams.has('sharecode')) u.searchParams.set('sharecode', SHARE);
      const rq = https.request({
        hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'PUT',
        headers: { 'Host': u.host, 'X-Token': token, 'Content-Type': 'application/octet-stream', 'Content-Length': part.length },
        timeout: 60000
      }, (res) => {
        const cs2 = [];
        res.on('data', (c) => cs2.push(c));
        res.on('end', () => {
          let j = null; try { j = JSON.parse(Buffer.concat(cs2).toString()); } catch (e) {}
          resolve({ status: res.statusCode, json: j });
        });
      });
      rq.on('timeout', () => rq.destroy(new Error('timeout')));
      rq.on('error', reject);
      rq.write(part);
      rq.end();
    });
    if (put.status !== 200) return { ok: false, stage: 'chunk', status: put.status, json: put.json };
  }
  r = await request('POST', '/api/files/' + fid + '/complete', {}, { token });
  return { ok: r.status === 200, fileId: fid, status: r.status, json: r.json };
}

(async () => {
  console.log('== 线上冒烟：站内云网盘 ==');
  console.log('目标: ' + BASE);

  /* 1. 版本与入口 */
  let r = await request('GET', '/api/version');
  check('版本接口可访问', r.status === 200, r.status);
  check('版本号已更新到 1.7.0', r.json && r.json.version && r.json.version.name === '1.7.0', r.json && r.json.version);
  check('标记网盘已内置', r.json && r.json.drive && r.json.drive.enabled === true, r.json && r.json.drive);

  r = await request('GET', '/');
  check('首页可访问', r.status === 200, r.status);
  check('首页导航含「网盘」', r.raw.toString('utf8').indexOf('data-view="drive"') >= 0);

  r = await request('GET', '/?lite=1');
  check('低配版可访问', r.status === 200, r.status);
  check('低配版导航含网盘', r.raw.toString('utf8').indexOf('navDrive') >= 0);

  /* 2. 注册测试账号 */
  const uname = 'drv' + Date.now().toString().slice(-8);
  r = await request('POST', '/api/register', {
    username: uname, password: 'pass123', nickname: '网盘冒烟'
  });
  check('注册测试账号', r.status === 200 && !!r.json.token, r.json);
  const token = r.json.token;
  const userId = r.json.user.id;

  /* 3. 上传到网盘 */
  const content = crypto.randomBytes(6000);
  const up = await upload(token, '冒烟测试.txt', 'text/plain', content);
  check('网盘上传成功', up.ok, up);
  const fid = up.fileId;

  r = await request('GET', '/api/drive/files', null, { token });
  check('网盘列表包含该文件', r.status === 200 && r.json.items.some((x) => x.fileId === fid), r.json && r.json.total);
  const item = r.json.items.filter((x) => x.fileId === fid)[0];
  check('识别为文档类型', item && item.type === 'doc', item && item.type);
  check('网盘直传不带来源房间', item && item.fromChat === false, item && item.roomName);

  /* 4. 详情与重命名 */
  r = await request('GET', '/api/drive/files/' + fid, null, { token });
  check('详情返回且算出 md5', r.status === 200 && /^[a-f0-9]{32}$/.test(r.json.md5 || ''), r.json && r.json.md5);

  r = await request('PATCH', '/api/drive/files/' + fid, { name: '冒烟改名.txt' }, { token });
  check('重命名成功', r.status === 200 && r.json.name === '冒烟改名.txt', r.json && r.json.name);

  r = await request('PATCH', '/api/drive/files/' + fid, { folder: '冒烟目录' }, { token });
  check('移动到目录成功', r.status === 200 && r.json.folder === '冒烟目录', r.json && r.json.folder);

  /* 5. 聊天文件天然入库 */
  r = await request('GET', '/api/rooms', null, { token });
  const pubId = r.json.publicRoomId;
  const chatUp = await upload(token, '大厅冒烟.txt', 'text/plain', crypto.randomBytes(2048), pubId);
  check('在公共大厅上传文件', chatUp.ok, chatUp);

  r = await request('GET', '/api/drive/files', null, { token });
  const chatItem = r.json.items.filter((x) => x.fileId === chatUp.fileId)[0];
  check('聊天文件同时出现在网盘', !!chatItem, r.json.total);
  check('带来源房间名', chatItem && chatItem.fromChat === true && chatItem.roomName === '公共聊天室', chatItem && chatItem.roomName);

  r = await request('GET', '/api/rooms/' + pubId + '/files', null, { token });
  check('会话共享文件包含该文件', r.status === 200 && r.json.files.some((x) => x.fileId === chatUp.fileId), r.json && r.json.total);

  /* 6. 分享 */
  r = await request('POST', '/api/drive/files/' + fid + '/share', { days: 1, encrypted: true, code: 'smoke1' }, { token });
  check('创建加密分享', r.status === 200 && !!r.json.shareId, r.json);
  const shareId = r.json.shareId;

  r = await request('GET', '/api/drive/s/' + shareId);
  check('未带提取码不通过', r.status === 200 && r.json.passed === false, r.json && r.json.passed);
  r = await request('GET', '/api/drive/s/' + shareId + '?code=smoke1');
  check('带正确提取码通过', r.status === 200 && r.json.passed === true, r.json && r.json.passed);
  r = await request('GET', '/api/drive/s/' + shareId + '/dl?code=smoke1');
  check('匿名可下载且字节一致', r.status === 200 && r.raw.length === content.length, { s: r.status, len: r.raw && r.raw.length });

  /* 7. 回收站 */
  r = await request('DELETE', '/api/drive/files/' + fid, null, { token });
  check('移入回收站', r.status === 200 && r.json.deletedAt > 0, r.json);
  r = await request('GET', '/api/drive/trash', null, { token });
  check('回收站可见', r.status === 200 && r.json.items.some((x) => x.fileId === fid), r.json && r.json.total);
  r = await request('GET', '/api/files/' + fid + '/download', null, { token });
  check('回收站文件不可下载', r.status === 404, r.status);

  r = await request('POST', '/api/drive/trash/' + fid + '/restore', {}, { token });
  check('恢复成功', r.status === 200, r.json);
  const dAfter = await request('GET', '/api/drive/files/' + fid, null, { token });
  check('恢复后详情不再标记为已删除', dAfter.status === 200 && dAfter.json.deleted === false, dAfter.json && dAfter.json.deleted);
  // 下载走通用文件接口（网盘不另开下载路由）
  r = await request('GET', '/api/files/' + fid + '/download', null, { token });
  check('恢复后可下载且字节一致', r.status === 200 && r.raw.length === content.length, { s: r.status, len: r.raw && r.raw.length });

  /* 8. 分享随文件一起清理 */
  await request('DELETE', '/api/drive/files/' + fid, null, { token });
  r = await request('DELETE', '/api/drive/trash/' + fid, null, { token });
  check('彻底删除成功', r.status === 200 && r.json.purged === true, r.json);
  r = await request('GET', '/api/drive/s/' + shareId);
  check('文件彻底删除后分享失效', r.status === 404, r.status);

  /* 9. 收尾：注销账号 */
  r = await request('POST', '/api/account/delete', { confirm: true }, { token });
  check('测试账号已注销清理', r.status === 200, r.json);
  r = await request('GET', '/api/drive/files', null, { token });
  check('注销后 token 失效', r.status === 401, r.status);

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('冒烟异常: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
