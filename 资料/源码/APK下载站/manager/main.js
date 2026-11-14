const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk');

const publicConfig = {
  endpoint: 'https://apk-download-site.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_al8DGujKMUoSkD3CtP5Rsa_KHdhhRdGEu50JsJS0HiN5EZqZyHt2iSf'
};

const cloud = createWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
  publishableKey: publicConfig.publishableKey
});

const SITE_FILES = 'C:/Users/Administrator/Downloads/apk-site/files';
let cachePath = '';
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1020,
    height: 680,
    title: '下载站管理',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'ui.html'));
}

app.whenReady().then(async function () {
  cachePath = path.join(app.getPath('userData'), 'manifest.json');
  if (process.env.APK_MANAGER_SELFTEST === '1') {
    let text;
    try {
      const probe = await loadCloud();
      text = 'SELFTEST_OK rows=' + probe.length + ' first=' + (probe[0] ? probe[0].name : 'none');
    } catch (e) {
      text = 'SELFTEST_FAIL ' + e.message;
    }
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'selftest.txt'), text, 'utf8'); } catch (e) { /* ignore */ }
    try { fs.writeFileSync(path.join(path.dirname(process.execPath), 'selftest.txt'), text, 'utf8'); } catch (e) { /* ignore */ }
    app.quit();
    return;
  }
  createWindow();
});
app.on('window-all-closed', function () { app.quit(); });

function normalize(row) {
  return {
    id: row.id,
    name: row.file_name,
    label: row.display_name,
    size: row.size_label,
    type: row.file_type || 'APK',
    stored: row.stored_name || '',
    enabled: row.enabled !== false,
    url: row.download_url || ''
  };
}

async function loadCloud() {
  const r = await cloud.database.from('apk_catalog')
    .select('id, file_name, display_name, size_label, sort_order, enabled, download_url, file_type, stored_name')
    .order('sort_order');
  if (r.error) throw new Error(r.error.message || '云端读取失败');
  return (r.data || []).map(normalize);
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch (e) { return null; }
}
function writeCache(rows) {
  try { fs.writeFileSync(cachePath, JSON.stringify(rows, null, 2), 'utf8'); } catch (e) { /* ignore */ }
}

ipcMain.handle('load', async function () {
  try {
    const rows = await loadCloud();
    writeCache(rows);
    return { ok: true, rows: rows, note: '已从云端读取 ' + rows.length + ' 项' };
  } catch (e) {
    const cached = readCache();
    return { ok: false, rows: cached || [], note: '云端连接失败：' + e.message + (cached ? '，已加载本地缓存' : '') };
  }
});

ipcMain.handle('cache', function (e, rows) { writeCache(rows); return true; });

ipcMain.handle('save', async function (e, rows) {
  try {
    const current = await loadCloud();
    const byName = new Map(current.map(function (r) { return [r.name, r]; }));
    const wanted = new Set(rows.map(function (r) { return r.name; }));

    for (const r of current) {
      if (!wanted.has(r.name)) {
        const d = await cloud.database.from('apk_catalog').delete().eq('id', r.id).select();
        if (d.error) throw new Error('删除 ' + r.name + ' 失败：' + d.error.message);
      }
    }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const payload = {
        file_name: r.name,
        display_name: r.label || r.name,
        size_label: r.size || '',
        file_type: r.type || '其他',
        stored_name: r.stored || null,
        sort_order: i,
        enabled: r.enabled !== false,
        download_url: r.url || null
      };
      const old = byName.get(r.name);
      let out;
      if (old) out = await cloud.database.from('apk_catalog').update(payload).eq('id', old.id).select();
      else out = await cloud.database.from('apk_catalog').insert(payload).select();
      if (out.error) throw new Error((old ? '更新 ' : '新增 ') + r.name + ' 失败：' + out.error.message);
      if (!out.data || !out.data.length) throw new Error(r.name + ' 未写入（权限被拒）');
    }
    writeCache(rows);
    return { ok: true, note: '已同步 ' + rows.length + ' 项到云端，线上即时生效' };
  } catch (e) {
    return { ok: false, note: e.message };
  }
});

function guessType(name) {
  const ext = path.extname(name).replace(/^\./, '').toUpperCase();
  if (!ext) return '其他';
  const map = {
    APK: 'APK', TXT: 'TXT', MD: 'TXT', LOG: 'TXT', JSON: 'TXT', CSV: 'TXT',
    PPT: 'PPTX', PPTX: 'PPTX', DOC: 'DOCX', DOCX: 'DOCX',
    XLS: 'XLSX', XLSX: 'XLSX', PDF: 'PDF', PY: 'PY', JS: 'PY',
    ZIP: '压缩包', RAR: '压缩包', '7Z': '压缩包',
    PNG: '图片', JPG: '图片', JPEG: '图片', GIF: '图片', BMP: '图片',
    MP4: '视频', MP3: '音频'
  };
  return map[ext] || ext.slice(0, 10);
}

ipcMain.handle('pick-file', async function () {
  const r = await dialog.showOpenDialog(win, {
    title: '选择本地文件（任意类型）',
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths.length) return null;
  const src = r.filePaths[0];
  const name = path.basename(src);
  const isApk = /\.apk$/i.test(name);
  const stored = isApk ? '' : (name + '.bin');
  const destName = isApk ? name : stored;
  let copied = false;
  try {
    fs.mkdirSync(SITE_FILES, { recursive: true });
    const dest = path.join(SITE_FILES, destName);
    if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
    copied = true;
  } catch (e) { copied = false; }
  const size = fs.statSync(src).size;
  const label = size >= 1048576 ? (size / 1048576).toFixed(1) + ' MB'
    : (size >= 1024 ? Math.round(size / 1024) + ' KB' : size + ' B');
  return {
    name: name,
    stored: stored,
    size: label,
    type: guessType(name),
    copied: copied,
    isApk: isApk
  };
});
