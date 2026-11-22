'use strict';
/**
 * 极简 ZIP 读取器（只依赖 Node 内置 zlib，无第三方包）。
 *
 * 皮肤包是静态资源包，不需要压缩/加密/分卷这种复杂能力：
 *   · 支持 store(0) 与 deflate(8) 两种压缩方式（zip 默认就是这两种）；
 *   · 从「中央目录」枚举条目，能正确处理目录前缀和空目录；
 *   · 拒绝加密条目、拒绝路径穿越（../ 或绝对路径）。
 *
 * 暴露 parseZip(buf) -> [{ name, data:Buffer }]，name 是包内相对路径（用 / 分隔）。
 */

const zlib = require('zlib');

class ZipError extends Error {}

function findEnd(buf) {
  // EOCD: PK\x05\x06，长度 22 + 注释。从尾部往前找。
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf[i] === sig[0] && buf[i + 1] === sig[1] && buf[i + 2] === sig[2] && buf[i + 3] === sig[3]) {
      return i;
    }
  }
  throw new ZipError('不是有效的 ZIP 文件（找不到结束标记）');
}

function safeName(name) {
  let n = String(name || '').replace(/\\/g, '/');
  if (!n || n[0] === '/' || /^[A-Za-z]:/.test(n) || n.indexOf('\0') >= 0) {
    throw new ZipError('ZIP 里含有非法文件路径：' + name);
  }
  const parts = n.split('/');
  for (const p of parts) {
    if (p === '..') throw new ZipError('ZIP 里含有目录穿越路径：' + name);
  }
  return parts.filter(Boolean).join('/');
}

function parseZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('文件太小，不是 ZIP');
  const eocd = findEnd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];

  for (let i = 0; i < total; i++) {
    // 中央目录头 PK\x01\x02
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new ZipError('ZIP 中央目录损坏');
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = safeName(buf.toString('utf8', off + 46, off + 46 + nameLen));

    if (flags & 0x1) throw new ZipError('不支持加密的 ZIP：' + name);
    off += 46 + nameLen + extraLen + commentLen;

    if (!name || name.slice(-1) === '/') continue;   // 目录条目跳过

    // 本地文件头 PK\x03\x04
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new ZipError('ZIP 文件头损坏：' + name);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataOff, dataOff + compSize);

    let data;
    if (method === 0) data = raw;
    else if (method === 8) {
      try { data = zlib.inflateRawSync(raw); }
      catch (e) { throw new ZipError('ZIP 解压失败：' + name); }
    } else {
      throw new ZipError('不支持的 ZIP 压缩方式(' + method + ')：' + name);
    }
    out.push({ name, data });
  }
  return out;
}

module.exports = { parseZip, ZipError };
