'use strict';
/**
 * 启动脚本：兼容不同 Node 版本
 * - Node >= 22.5：直接使用内置 node:sqlite
 * - Node 22.5 ~ 22.x 且需 flag：以 --experimental-sqlite 重启
 * - Node < 22.5：跳过重启，交给 JSON 文件存储兜底（功能一致）
 */
const path = require('path');

const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
const supportsSqlite = major > 22 || (major === 22 && minor >= 5);
const needsFlag = major === 22 && minor >= 5 && minor < 13;

if (needsFlag && !process.env.__LL_RESPAWNED) {
  let sqliteOk = false;
  try {
    require('node:sqlite');
    sqliteOk = true;
  } catch (e) {
    sqliteOk = false;
  }
  if (!sqliteOk) {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath,
      ['--experimental-sqlite', path.join(__dirname, 'server.js')],
      { stdio: 'inherit', env: Object.assign({}, process.env, { __LL_RESPAWNED: '1' }) }
    );
    child.on('exit', (code) => process.exit(code === null ? 0 : code));
    return;
  }
}

// Node < 22.5 或已尝试过：直接启动，存储层会自动降级
require('./server.js');
