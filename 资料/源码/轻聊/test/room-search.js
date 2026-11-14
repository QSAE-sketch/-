'use strict';
/**
 * 房间搜索专项（标准版 + 桌面端）：
 *   1. GET /api/rooms/search 按名称大小写不敏感子串匹配
 *   2. 排除私聊与已解散房间
 *   3. 未加入的房间也能被搜到（发现新房间）
 *   4. 结果字段：name / memberCount / hasPassword / joined / ownerName
 *   5. 关键词校验（空 / 过长）
 *   6. 进去看看语义：/verify 只验密码不加入；加入走 /join
 *   7. 网页标准版有「进去看看 / 加入该房间」两个按钮；低配/基础版没有
 *   8. 桌面端源码有对应搜索入口
 */
const http = require('http');

const PORT = Number(process.env.PORT || 3311);
const ROOT = require('path').join(__dirname, '..');

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
        try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* ignore */ }
        resolve({ status: res.statusCode, body: buf, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const fs = require('fs');
const uniq = 'sr' + Date.now().toString(36);

(async () => {
  // ---- 两个用户：一个建房，一个搜房（模拟“发现未加入的房间”） ----
  const owner = { username: uniq + 'a', password: 'pass1234', nickname: '房主甲' };
  const hunter = { username: uniq + 'b', password: 'pass1234', nickname: '搜房乙' };
  let r = await req('POST', '/api/register', owner);
  check('注册房主', r.status === 200 && r.json && r.json.token, r.status);
  const tokO = r.json.token;
  r = await req('POST', '/api/register', hunter);
  check('注册搜索用户', r.status === 200 && r.json && r.json.token, r.status);
  const tokH = r.json.token;

  // ---- 关键词校验 ----
  r = await req('GET', '/api/rooms/search?q=', null, tokH);
  check('空关键词被拒绝', r.status === 400, r.status);
  r = await req('GET', '/api/rooms/search?q=' + encodeURIComponent('x'.repeat(41)), null, tokH);
  check('超长关键词被拒绝', r.status === 400, r.status);

  // ---- 建房：名称带独特关键词，一间免密一间带密码一间无关一间已解散 ----
  const kw = '星尘' + uniq.slice(-4);
  r = await req('POST', '/api/rooms', { name: kw + '讨论组', password: '' }, tokO);
  check('创建免密房', r.status === 200 && r.json.room, r.status);
  const roomFree = r.json.room;

  r = await req('POST', '/api/rooms', { name: kw + '机密室', password: 'pw' + uniq.slice(-4) }, tokO);
  check('创建密码房', r.status === 200 && r.json.room, r.status);
  const roomPwd = r.json.room;

  r = await req('POST', '/api/rooms', { name: '完全无关的房间' + uniq.slice(-4), password: '' }, tokO);
  check('创建无关房', r.status === 200 && r.json.room, r.status);
  const roomOther = r.json.room;

  // ---- 搜索：命中子串（大小写不敏感的中文按原文） ----
  r = await req('GET', '/api/rooms/search?q=' + encodeURIComponent(kw), null, tokH);
  check('搜索成功', r.status === 200 && Array.isArray(r.json.results), r.status);
  const results = (r.json && r.json.results) || [];
  check('命 2 间（免密+密码）', results.length === 2, results.map((x) => x.name));
  const names = results.map((x) => x.name).join('|');
  check('结果含免密房', names.indexOf(roomFree.name) >= 0, names);
  check('结果含密码房', names.indexOf(roomPwd.name) >= 0, names);
  check('无关房不在结果里', names.indexOf(roomOther.name) < 0, names);

  const hitFree = results.find((x) => x.id === roomFree.id) || {};
  const hitPwd = results.find((x) => x.id === roomPwd.id) || {};
  check('结果带 memberCount', typeof hitFree.memberCount === 'number', hitFree);
  check('免密房标记 hasPassword=false', hitFree.hasPassword === false, hitFree);
  check('密码房标记 hasPassword=true', hitPwd.hasPassword === true, hitPwd);
  check('搜索者未加入标记 joined=false', hitFree.joined === false, hitFree);
  check('结果带房主名', hitFree.ownerName === owner.nickname, hitFree);
  check('keyword 原样返回', r.json.keyword === kw, r.json.keyword);

  // ---- 大小写不敏感（英文房间名） ----
  r = await req('POST', '/api/rooms', { name: 'AlphaBeta-' + uniq.slice(-4), password: '' }, tokO);
  const roomEn = r.json.room;
  r = await req('GET', '/api/rooms/search?q=alphabeta-' + uniq.slice(-4), null, tokH);
  check('英文大小写不敏感匹配',
    r.status === 200 && r.json.results.some((x) => x.id === roomEn.id), r.json);

  // ---- 已解散的房间不进搜索 ----
  r = await req('POST', '/api/rooms/' + roomOther.id + '/dissolve', { confirm: true }, tokO);
  check('解散房间', r.status === 200 || r.status === 410, r.status);
  r = await req('GET', '/api/rooms/search?q=' + encodeURIComponent('完全无关'), null, tokH);
  check('已解散房间不出现在搜索里',
    r.status === 200 && r.json.results.every((x) => x.id !== roomOther.id), r.json.results);

  // ---- 进去看看语义：verify 只验密码、不加入 ----
  r = await req('POST', '/api/rooms/' + roomPwd.id + '/verify', { password: 'wrong-pass' }, tokH);
  check('错误密码验证失败', r.status === 401, r.status);
  r = await req('POST', '/api/rooms/' + roomPwd.id + '/verify', { password: 'pw' + uniq.slice(-4) }, tokH);
  check('正确密码验证通过', r.status === 200 && r.json.verified, r.status);
  r = await req('GET', '/api/rooms/' + roomPwd.id + '/messages?since=0&limit=5', null, tokH);
  check('验证后可读消息（未加入）', r.status === 200 && r.json.joined === false, r.status);

  // ---- 加入该房间：join 后 joined 变 true ----
  r = await req('POST', '/api/rooms/' + roomFree.id + '/join', { password: '' }, tokH);
  check('加入免密房成功', r.status === 200 && r.json.room, r.status);
  r = await req('GET', '/api/rooms/search?q=' + encodeURIComponent(kw), null, tokH);
  const afterJoin = ((r.json && r.json.results) || []).find((x) => x.id === roomFree.id) || {};
  check('加入后搜索结果标记 joined=true', afterJoin.joined === true, afterJoin);

  // ---- 仅标准版与桌面版生效：静态校验 ----
  const appJs = fs.readFileSync(require('path').join(ROOT, 'public/app.js'), 'utf8');
  check('网页标准版有「进去看看」', appJs.indexOf('进去看看') > 0);
  check('网页标准版有「加入该房间」', appJs.indexOf('加入该房间') > 0);
  check('网页标准版有搜索房间入口', appJs.indexOf('搜索房间') > 0);
  check('网页标准版调用搜索接口', appJs.indexOf('/api/rooms/search') > 0);

  const appLite = fs.readFileSync(require('path').join(ROOT, 'public/app-lite.js'), 'utf8');
  const appBasic = fs.readFileSync(require('path').join(ROOT, 'public/app-basic.js'), 'utf8');
  check('低配版不带房间搜索', appLite.indexOf('/api/rooms/search') < 0 && appLite.indexOf('进去看看') < 0);
  check('基础版不带房间搜索', appBasic.indexOf('/api/rooms/search') < 0 && appBasic.indexOf('进去看看') < 0);

  const cpp = fs.readFileSync(require('path').join(ROOT, 'native-win/src/main.cpp'), 'utf8');
  check('桌面端有搜索房间入口', cpp.indexOf('搜索房间') > 0);
  check('桌面端有「进去看看」按钮', cpp.indexOf('进去看看') > 0);
  check('桌面端有「加入该房间」按钮', cpp.indexOf('加入该房间') > 0);
  const apiCpp = fs.readFileSync(require('path').join(ROOT, 'native-win/src/api.cpp'), 'utf8');
  check('桌面端 API 调用搜索接口', apiCpp.indexOf('/api/rooms/search') > 0);

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e);
  console.log('\n通过: ' + pass + '  失败: ' + (fail + 1));
  process.exit(1);
});
