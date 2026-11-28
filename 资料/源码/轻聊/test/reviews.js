'use strict';
/**
 * 内容审查专项（合规补强 · 2026-11-28）：
 *   1. 图片消息：发出即入队扫描 → scanning 期间图片不可查看 → clean 后恢复
 *      （nsfwjs 已安装时走真实模型；未安装时降级直接 clean）
 *   2. 举报文件：12h 观察期内消息可查看、raw 可预览、download 拦截、分享 dl 拦截
 *   3. 举报文本消息：期间消息可见，官方 delete 后消息 purged
 *   4. 官方处置：待处理列表可见，keep 恢复 / delete 删除
 *   5. 超时自动删：短窗口（环境变量）下官方不处理 → sweep 自动删除
 *
 * 环境变量（由 run-suite 透传）：REVIEW_REPORT_WINDOW_MS / REVIEW_SWEEP_MS
 */
const http = require('http');

const PORT = Number(process.env.PORT || 3311);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const r = http.request({
      hostname: '127.0.0.1', port: PORT, path: p, method,
      headers: Object.assign(
        { 'content-type': 'application/json' },
        token ? { 'x-token': token } : {},
        data ? { 'content-length': data.length } : {}
      )
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(cs);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* 非JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** raw body 上传一个分片（PUT /api/files/:id/chunk?i=index） */
function putChunk(fileId, index, buf, tok) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      hostname: '127.0.0.1', port: PORT,
      path: '/api/files/' + fileId + '/chunk?i=' + index, method: 'PUT',
      headers: { 'x-token': tok, 'content-type': 'application/octet-stream', 'content-length': buf.length }
    }, (res) => {
      const cs = []; res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const b = Buffer.concat(cs).toString('utf8');
        let j = null; try { j = JSON.parse(b); } catch (_) {}
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject); r.write(buf); r.end();
  });
}

async function uploadFile(tok, name, buf, mime, roomId) {
  const init = await req('POST', '/api/files/init', {
    name, size: buf.length, mime, chunkSize: 1024 * 1024, roomId
  }, tok);
  const fileId = init.json.fileId || (init.json.file && init.json.file.id);
  const ch = await putChunk(fileId, 0, buf, tok);
  if (!(ch.json && ch.json.ok)) console.log('  [dbg] chunk 失败:', ch.status, ch.body && ch.body.toString().slice(0, 120));
  const done = await req('POST', '/api/files/' + fileId + '/complete', {}, tok);
  if (!(done.json && done.json.ok)) console.log('  [dbg] complete 失败:', done.status, done.body && done.body.toString().slice(0, 120), 'fileId=', fileId);
  return { fileId, init: init.json, done: done.json };
}

/** 最小合法 PNG（2×2 纯色，模型必判 Neutral） */
function tinyPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAlYAP9' +
    'lV0HAAAAAElFTkSuQmCC', 'base64');
}

(async () => {
  console.log('\n──── 内容审查：图片审核 / 举报 / 官方处置 ────');

  // 普通用户 A
  const uniq = 'rv' + Date.now().toString(36);
  const regA = await req('POST', '/api/register', { username: uniq + 'a', password: 'pass1234', nickname: '审查测试A' });
  const tokA = regA.json && regA.json.token;
  check('用户A注册', !!tokA, regA.json);

  // 官方审核账号：REVIEWER_USERNAME 精确匹配 'L13902499337'，注册即永久最高权限
  // （账号可能已存在于测试库，注册失败就登录）
  let regR = await req('POST', '/api/register', { username: 'L13902499337', password: 'pass1234', nickname: '官方审核' });
  let tokR = regR.json && regR.json.token;
  if (!tokR) {
    const lg = await req('POST', '/api/login', { username: 'L13902499337', password: 'pass1234' });
    tokR = lg.json && lg.json.token;
  }
  check('官方审核账号可用', !!tokR, regR.json);
  const meR = tokR ? await req('GET', '/api/me', null, tokR) : null;
  check('官方账号有最高权限', !!(meR && meR.json && meR.json.user && (meR.json.user.founder || (meR.json.user.masterUntil || 0) > 0)),
    meR && meR.json && meR.json.user);

  // 公共房间
  const pub = await req('GET', '/api/rooms', null, tokA);
  const pubRoom = { id: pub.json.publicRoomId };
  check('公共房间存在', !!pubRoom.id);

  /* ---- 1. 图片消息：scanning 拦截 → clean 恢复 ---- */
  const png = tinyPng();
  const up1 = await uploadFile(tokA, 'test.png', png, 'image/png', pubRoom.id);
  const fileId = up1.fileId;
  check('图片上传完成', !!(up1.done && up1.done.ok), up1.done);

  const sendMsg = await req('POST', '/api/rooms/' + pubRoom.id + '/messages', {
    kind: 'file', fileId
  }, tokA);
  check('图片消息发送成功', !!(sendMsg.json && sendMsg.json.ok), sendMsg.json);
  const msgId = sendMsg.json && sendMsg.json.message && sendMsg.json.message.id;
  const msgUrl = sendMsg.json && sendMsg.json.message && sendMsg.json.message.file &&
    sendMsg.json.message.file.url || '';
  const key = msgUrl.split('k=')[1] || '';

  // scanning 窗口极短（模型加载 ~2.7s + 推理），发完立刻查大概率撞上 scanning
  const immediate = await req('GET', '/api/files/' + fileId + '/raw?k=' + encodeURIComponent(key));
  // 该断言仅在模型启用时有效（scanning 有真实耗时）；降级模式下直接 clean
  const mod = await req('GET', '/api/reviews', null, tokR);
  const modEnabled = mod.json && mod.json.moderation && mod.json.moderation.enabled;
  if (modEnabled) {
    check('扫描期间图片被拦（scanning 不可查看）', immediate.status === 403, immediate.status);
  } else {
    console.log('  - nsfwjs 未启用（降级模式），跳过 scanning 拦截断言');
  }

  // 轮询等 clean（模型判 Neutral → 放行；最多等 40s）
  let clean = false;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const lst = await req('GET', '/api/rooms/' + pubRoom.id + '/messages', null, tokA);
    const m = (lst.json.messages || []).find((x) => x.id === msgId);
    if (m && m.file && m.file.url && !m.file.reviewing) {
      const back = await req('GET', '/api/files/' + fileId + '/raw?k=' +
        encodeURIComponent(m.file.url.split('k=')[1]));
      if (back.status === 200) { clean = true; break; }
    }
  }
  check('扫描完成图片恢复可查看（clean → 200）', clean);

  /* ---- 2. 举报文件：观察期消息可见 / 可预览 / 禁下载 ---- */
  const fUp = await uploadFile(tokA, '被举报.txt', Buffer.from('被举报内容!'), 'text/plain', pubRoom.id);
  const fId = fUp.fileId;
  check('文件上传完成', !!(fUp.done && fUp.done.ok), fUp.done);
  const fMsg = await req('POST', '/api/rooms/' + pubRoom.id + '/messages', { kind: 'file', fileId: fId }, tokA);
  const fMsgId = fMsg.json && fMsg.json.message && fMsg.json.message.id;
  check('文件消息发送成功', !!fMsgId, fMsg.json);

  const rep1 = await req('POST', '/api/reports', {
    targetKind: 'file', targetId: fId, reason: '测试举报：疑似违规内容'
  }, tokA);
  check('举报提交成功', !!(rep1.json && rep1.json.ok && rep1.json.reviewId), rep1.json);
  const repDup = await req('POST', '/api/reports', {
    targetKind: 'file', targetId: fId, reason: '重复举报'
  }, tokA);
  check('重复举报去重', !!(repDup.json && repDup.json.duplicated), repDup.json);

  const lst2 = await req('GET', '/api/rooms/' + pubRoom.id + '/messages', null, tokA);
  const fMsgBack = (lst2.json.messages || []).find((x) => x.id === fMsgId);
  check('观察期内消息仍可见', !!fMsgBack, fMsgBack);
  check('观察期内 file.reported 标记', !!(fMsgBack && fMsgBack.file && fMsgBack.file.reported));
  check('观察期内下载入口被摘除', !!(fMsgBack && fMsgBack.file && fMsgBack.file.dlUrl === null));
  const rawView = await req('GET', '/api/files/' + fId + '/raw?k=' +
    encodeURIComponent((fMsgBack.file.url || '').split('k=')[1] || 'x'));
  check('观察期内预览（raw）放行', rawView.status === 200, rawView.status);
  const dlTry = await req('GET', '/api/files/' + fId + '/download?k=' +
    encodeURIComponent((fMsgBack.file.url || '').split('k=')[1] || 'x'));
  check('观察期内下载被拦', dlTry.status === 403, dlTry.status);
  const repNoReason = await req('POST', '/api/reports', { targetKind: 'file', targetId: fId, reason: '' }, tokA);
  check('空理由举报被拒', repNoReason.status === 400, repNoReason.status);

  /* ---- 3. 官方处置：delete 删除被举报文件 ---- */
  const list1 = await req('GET', '/api/reviews', null, tokR);
  check('官方待处理列表可见', !!(list1.json && list1.json.ok && list1.json.reviews.length >= 1), list1.json);
  const reportReview = (list1.json.reviews || []).find((r) => r.kind === 'report');
  check('举报单在列表中（带目标快照）', !!(reportReview && reportReview.targetFile), reportReview);
  const delR = await req('POST', '/api/reviews/' + reportReview.id + '/handle', { action: 'delete' }, tokR);
  check('官方确认违规删除', !!(delR.json && delR.json.ok), delR.json);
  const afterDel = await req('GET', '/api/files/' + fId + '/raw', null, tokA);
  check('被删文件字节不可访问', afterDel.status === 404, afterDel.status);
  const lst3 = await req('GET', '/api/rooms/' + pubRoom.id + '/messages', null, tokA);
  check('文件消息同步清除（purgedIds 下发）',
    !!(lst3.json.purgedIds || []).includes(fMsgId) &&
    !(lst3.json.messages || []).some((x) => x.id === fMsgId),
    { purgedIds: lst3.json.purgedIds, fMsgId });
  const listAgain = await req('GET', '/api/reviews', null, tokR);
  check('已处理单不再出现在待处理列表',
    !(listAgain.json.reviews || []).some((r) => r.id === reportReview.id));

  /* ---- 4. 举报文本消息 → 官方 keep 恢复 ---- */
  const tMsg = await req('POST', '/api/rooms/' + pubRoom.id + '/messages', { kind: 'text', content: '这是一条被误举报的正常消息' }, tokA);
  const tMsgId = tMsg.json.message.id;
  const rep2 = await req('POST', '/api/reports', { targetKind: 'message', targetId: tMsgId, reason: '误报测试' }, tokA);
  check('文本消息举报成功', !!(rep2.json && rep2.json.ok), rep2.json);
  const lst4 = await req('GET', '/api/rooms/' + pubRoom.id + '/messages', null, tokA);
  const tBack = (lst4.json.messages || []).find((x) => x.id === tMsgId);
  check('观察期内文本消息内容仍可见', !!(tBack && tBack.content === '这是一条被误举报的正常消息'), tBack);
  const list2 = await req('GET', '/api/reviews', null, tokR);
  const repReview2 = (list2.json.reviews || []).find((r) => r.kind === 'report' && r.targetId === tMsgId);
  check('文本举报单带消息快照', !!(repReview2 && repReview2.targetMessage), repReview2);
  const keepR = await req('POST', '/api/reviews/' + repReview2.id + '/handle', { action: 'keep' }, tokR);
  check('官方确认无问题（keep）', !!(keepR.json && keepR.json.ok), keepR.json);
  const lst5 = await req('GET', '/api/rooms/' + pubRoom.id + '/messages', null, tokA);
  const tBack2 = (lst5.json.messages || []).find((x) => x.id === tMsgId);
  check('keep 后消息恢复正常（无 reported 标记）', !!(tBack2 && tBack2.content && !(tBack2.file && tBack2.file.reported)));

  /* ---- 5. 超时自动删（短窗口：REVIEW_REPORT_WINDOW_MS / REVIEW_SWEEP_MS 由环境变量注入） ---- */
  const winMs = Number(process.env.REVIEW_REPORT_WINDOW_MS || 0);
  if (winMs > 0 && winMs < 5000) {
    const tUp = await uploadFile(tokA, '超时删.txt', Buffer.from('hello'), 'text/plain', pubRoom.id);
    const tFileId = tUp.fileId;
    const tSend = await req('POST', '/api/rooms/' + pubRoom.id + '/messages', { kind: 'file', fileId: tFileId }, tokA);
    const tSendId = tSend.json.message.id;
    await req('POST', '/api/reports', { targetKind: 'file', targetId: tFileId, reason: '超时自动删测试' }, tokA);
    console.log('  - 等待 ' + (winMs + Number(process.env.REVIEW_SWEEP_MS || 60000) + 1500) + 'ms 让 sweep 自动删除…');
    await sleep(winMs + Number(process.env.REVIEW_SWEEP_MS || 60000) + 1500);
    const gone = await req('GET', '/api/files/' + tFileId + '/raw', null, tokA);
    check('官方超时未处理 → sweep 自动删除文件', gone.status === 404, gone.status);
    const lst6 = await req('GET', '/api/rooms/' + pubRoom.id + '/messages', null, tokA);
    check('超时删除同步清消息（purgedIds 下发）',
      !!(lst6.json.purgedIds || []).includes(tSendId) &&
      !(lst6.json.messages || []).some((x) => x.id === tSendId),
      { purgedIds: lst6.json.purgedIds, tSendId });
  } else {
    console.log('  - 未设置短窗口环境变量，跳过超时自动删实测（状态机已由前序用例覆盖）');
  }

  /* ---- 6. 普通用户不能碰官方处置接口 ---- */
  const denied = await req('GET', '/api/reviews', null, tokA);
  check('普通用户查待处理列表被拒', denied.status === 403, denied.status);
  const denied2 = await req('POST', '/api/reviews/xxx/handle', { action: 'delete' }, tokA);
  check('普通用户处置被拒', denied2.status === 403, denied2.status);

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e);
  console.log('通过: ' + pass + '  失败: ' + (fail + 1));
  process.exit(1);
});
