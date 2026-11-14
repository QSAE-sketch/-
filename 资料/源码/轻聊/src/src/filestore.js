'use strict';
/**
 * 分片文件存储：支持 200MB 级文件、断点续传、进度统计、Range 流式读取。
 *
 * 字节落到哪由 blob 后端决定（见 src/blobstore.js）：
 * - 本地模式：磁盘分片 + 合并后的 blob.bin（原有行为，逐字节不变）
 * - 云端模式：云数据库 public.file_blobs 表为权威存储，本地磁盘只作读缓存
 *
 * 本文件只保留「上传会话」的业务语义：初始化、收片、合并、撤回删除、Range 输出。
 */

const fs = require('fs');
const path = require('path');
const { LocalBlobStore } = require('./blobstore');

class FileStore {
  constructor(rootDir, db, blobs) {
    this.root = rootDir;
    this.db = db;
    this.blobs = blobs || new LocalBlobStore(rootDir);
    fs.mkdirSync(path.join(rootDir, 'tmp'), { recursive: true });
  }

  /** 切换字节存储后端（云端模式下由 initStore 调用） */
  setBlobStore(backend) {
    this.blobs = backend;
  }

  dirOf(fileId) {
    return path.join(this.root, fileId);
  }

  chunkDirOf(fileId) {
    return path.join(this.dirOf(fileId), 'chunks');
  }

  blobPath(fileId) {
    return path.join(this.dirOf(fileId), 'blob.bin');
  }

  chunkPath(fileId, index) {
    return path.join(this.chunkDirOf(fileId), String(index).padStart(5, '0') + '.part');
  }

  /** 初始化上传（同名同大小可复用未完成的会话，实现断点续传） */
  async init(ownerId, roomId, name, size, mime, chunkSize, resumeFileId) {
    if (resumeFileId) {
      const f = this.db.getFile(resumeFileId);
      if (f && f.ownerId === ownerId && f.state === 'uploading' && f.size === Number(size)) {
        // 等在途分片写入落地，再以「后端实际存了什么」为准修正已收清单。
        // 云端模式下实例换过之后，元数据可能比后端多，必须以后端为准。
        await this.blobs.settle?.(f.id);
        const have = new Set(await this.blobs.listIndexes(f.id));
        const fixed = f.received.filter((i) => have.has(i));
        if (fixed.length !== f.received.length) {
          f.received = fixed;
          this.db.updateFile(f);
        }
        await this.blobs.prepare?.(f.id);
        return { file: f, resumed: true };
      }
    }
    const doc = this.db.createFile(ownerId, roomId, name, size, mime, chunkSize);
    await this.blobs.prepare?.(doc.id);
    return { file: doc, resumed: false };
  }

  /** 接收一个分片，返回已收分片数 */
  async writeChunk(fileId, index, buffer) {
    const file = this.db.getFile(fileId);
    if (!file) throw new Error('文件不存在');
    if (file.state === 'ready') return file.received.length;
    // 字节先落地，再更新元数据 —— 元数据永远只是「已落地分片」的子集
    await this.blobs.putChunk(fileId, index, buffer);
    if (!file.received.includes(index)) {
      file.received.push(index);
      file.received.sort((a, b) => a - b);
      this.db.updateFile(file);
    }
    return file.received.length;
  }

  /** 查询已上传分片，供断点续传 */
  status(fileId) {
    const file = this.db.getFile(fileId);
    if (!file) return null;
    const total = Math.max(1, Math.ceil(file.size / file.chunkSize));
    return {
      id: file.id,
      name: file.name,
      size: file.size,
      chunkSize: file.chunkSize,
      totalChunks: total,
      received: file.received.slice(),
      receivedCount: file.received.length,
      state: file.state
    };
  }

  /** 校验分片齐全 → 收尾 → 标记可用 */
  async complete(fileId) {
    const file = this.db.getFile(fileId);
    if (!file) throw new Error('文件不存在');
    if (file.state === 'ready') return file;
    const total = Math.max(1, Math.ceil(file.size / file.chunkSize));
    // 等所有在途分片写入落地（云端模式下这一步才真正保证字节已进云库）
    await this.blobs.settle?.(fileId);
    // 自愈：本地有、云端缺的分片补写回云端
    await this.blobs.repair?.(fileId, total);
    const got = new Set(await this.blobs.listIndexes(fileId));
    for (let i = 0; i < total; i++) {
      if (!got.has(i)) throw new Error('分片缺失 index=' + i);
    }
    await this.blobs.finalize(fileId, file.size);
    file.state = 'ready';
    file.readyAt = Date.now();
    this.db.updateFile(file);
    return file;
  }

  async blobExists(fileId) {
    const n = await this.blobs.totalBytes(fileId);
    return n !== null;
  }

  /** 物理删除（撤回 / 硬删除） */
  async removeBlob(fileId) {
    await this.blobs.remove(fileId);
  }

  /**
   * 一次性读出整个文件（返回 Buffer）。
   * 仅供「小文件的校验值计算」这类明确知道体积上限的场景使用；
   * 下载/预览一律走下面的 stream，绝不把大文件读进内存。
   */
  async readAll(fileId) {
    const total = await this.blobs.totalBytes(fileId);
    if (total === null || total <= 0) return null;
    const f = this.db.getFile(fileId);
    const cs = f ? f.chunkSize : undefined;
    const parts = [];
    for await (const buf of this.blobs.readRange(fileId, 0, total - 1, cs)) {
      if (buf && buf.length) parts.push(buf);
    }
    return Buffer.concat(parts);
  }

  /** Range 流式输出，支持视频拖动进度条 */
  async stream(req, res, fileId) {
    const file = this.db.getFile(fileId);
    if (!file) return false;
    const available = await this.blobs.totalBytes(fileId);
    if (available === null) return false;
    const total = available;

    let start = 0;
    let end = total - 1;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        if (m[1]) start = parseInt(m[1], 10);
        if (m[2]) end = parseInt(m[2], 10);
        if (!m[1] && m[2]) {
          start = Math.max(0, total - parseInt(m[2], 10));
          end = total - 1;
        }
      }
      if (Number.isNaN(start) || start < 0) start = 0;
      if (end >= total) end = total - 1;
      if (start > end) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + total });
        res.end();
        return true;
      }
      res.writeHead(206, {
        'Content-Type': file.mime || 'application/octet-stream',
        'Content-Length': end - start + 1,
        'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
        'Accept-Ranges': 'bytes'
      });
    } else {
      res.writeHead(200, {
        'Content-Type': file.mime || 'application/octet-stream',
        'Content-Length': total,
        'Accept-Ranges': 'bytes'
      });
    }

    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    try {
      for await (const buf of this.blobs.readRange(fileId, start, end, file.chunkSize)) {
        if (!buf || !buf.length) continue;
        if (!res.write(buf)) {
          await new Promise((res2) => res.once('drain', res2));
        }
      }
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ ok: false, error: '文件读取失败' }));
      return true;
    }
    res.end();
    return true;
  }
}

module.exports = { FileStore };
