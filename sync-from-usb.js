const fs = require('fs');
const path = require('path');

const USB = 'E:/资料';
const REPO = 'D:/apk-download-site';
const DEST = path.join(REPO, '资料');

const EXCLUDE_DIRS = new Set(['游戏成果']);
const CATS = ['事件', '资源', '源码', '素材库', 'skills'];

// group1 = key+分隔符+可选开引号, group2 = 值, group3 = 可选闭引号
const SECRET_RE = [
  /((?:app_?secret|client_?secret|secret_?key|access_?token|refresh_?token|access_?key|private_?key|bot_?token|bot_?secret|api_?key|api_?secret|api_?secret|password|passwd|token)\s*[:=]\s*["']?)([A-Za-z0-9_\-]{8,})(["']?)/gi,
  /((?:secret|token)\s*[:=]\s*["']?)([A-Za-z0-9_\-]{16,})(["']?)/gi,
];
const MASK = '[已隐去]';
const IDENT_RE = /app_?id|appid|user_?id|userid|openid|uin|username|账号/i;

function isTextFile(p) {
  const ext = path.extname(p).toLowerCase();
  return ['.txt', '.md', '.json', '.js', '.jsx', '.ts', '.tsx', '.py', '.html', '.htm', '.css', '.bat', '.sh', '.yml', '.yaml', '.toml', '.ini', '.env', '.xml', '.csv', '.skl'].includes(ext);
}

let copied = 0, skipped = 0, redacted = 0, errs = [];

function redactText(s) {
  let changed = false;
  for (const re of SECRET_RE) {
    s = s.replace(re, (m, pre, val, post) => {
      if (IDENT_RE.test(pre)) return m; // appid 等标识符不屏蔽
      changed = true;
      return pre + MASK + post;
    });
  }
  if (changed) redacted++;
  return s;
}

function walk(src, rel) {
  let ents;
  try { ents = fs.readdirSync(src, { withFileTypes: true }); }
  catch (e) { errs.push('读目录失败 ' + src + ' ' + e.message); return; }
  for (const ent of ents) {
    const sp = path.join(src, ent.name);
    const rp = path.join(rel, ent.name);
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(ent.name)) { skipped++; continue; }
      walk(sp, rp);
    } else if (ent.isFile()) {
      const dp = path.join(DEST, rp);
      if (fs.existsSync(dp)) { skipped++; continue; }
      fs.mkdirSync(path.dirname(dp), { recursive: true });
      try {
        if (isTextFile(dp)) {
          fs.writeFileSync(dp, redactText(fs.readFileSync(sp, 'utf8')), 'utf8');
        } else {
          fs.copyFileSync(sp, dp);
        }
        copied++;
      } catch (e) { errs.push('复制失败 ' + sp + ' ' + e.message); }
    }
  }
}

for (const c of CATS) {
  const src = path.join(USB, c);
  if (fs.existsSync(src)) walk(src, c);
}

console.log(JSON.stringify({ copied, skipped, redacted, errs: errs.slice(0, 10) }, null, 2));
