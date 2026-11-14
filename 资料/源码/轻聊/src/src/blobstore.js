'use strict';
/**
 * 文件字节存储后端。
 *
 * 「轻聊」的上传/下载只依赖下面这一组接口，因此本地磁盘与云数据库可以互换：
 *
 *   putChunk(fileId, index, buffer)   写入一个分片
 *   listIndexes(fileId)               列出已落地的分片序号
 *   readRange(fileId, start, end, cs) 顺序读出 [start,end) 字节
 *   totalBytes(fileId)                已存储总字节数（没有则 null）
 *   finalize(fileId, size)            收尾（本地合并成 blob.bin；云端无需）
 *   remove(fileId)                    删除该文件的全部字节
 *
 * 附加的可选钩子（不实现即视为空操作）：
 *   settle(fileId)     等待该文件在途的异步写入落地
 *   repair(fileId, n)  补写缺失分片（本地有、云端没有时自愈）
 *
 * 两种后端的定位：
 * - LocalBlobStore：原有行为，磁盘分片 + 合并后的 blob.bin，逐字节不变。
 * - CloudBlobStore：云数据库 public.file_blobs 表为权威存储，本地磁盘只作读缓存。
 */

const fs = require('fs');
const path = require('path');

/* ================================================================== */
/* 本地磁盘后端                                                        */
/* ================================================================== */

class LocalBlobStore {
  constructor(rootDir) {
    this.root = rootDir;
    this.kind = 'local';
    fs.mkdirSync(path.join(rootDir, 'tmp'), { recursive: true });
  }

  dirOf(fileId) { return path.join(this.root, fileId); }
  chunkDirOf(fileId) { return path.join(this.dirOf(fileId), 'chunks'); }
  blobPath(fileId) { return path.join(this.dirOf(fileId), 'blob.bin'); }
  chunkPath(fileId, index) {
    return path.join(this.chunkDirOf(fileId), String(index).padStart(5, '0') + '.part');
  }

  /** 预建目录（新建上传会话时调用） */
  async prepare(fileId) {
    fs.mkdirSync(this.chunkDirOf(fileId), { recursive: true });
  }

  async putChunk(fileId, index, buffer) {
    const dir = this.chunkDirOf(fileId);
    fs.mkdirSync(dir, { recursive: true });
    const p = this.chunkPath(fileId, index);
    const tmp = p + '.tmp';
    await fs.promises.writeFile(tmp, buffer);
    await fs.promises.rename(tmp, p);
  }

  async listIndexes(fileId) {
    let names = [];
    try {
      names = await fs.promises.readdir(this.chunkDirOf(fileId));
    } catch (_) {
      return [];
    }
    const out = [];
    for (const n of names) {
      const m = /^(\d+)\.part$/.exec(n);
      if (m) out.push(Number(m[1]));
    }
    return out.sort((a, b) => a - b);
  }

  async hasChunk(fileId, index) {
    return fs.existsSync(this.chunkPath(fileId, index));
  }

  async totalBytes(fileId) {
    try {
      const s = await fs.promises.stat(this.blobPath(fileId));
      return s.size;
    } catch (_) {
      return null;
    }
  }

  /** 合并分片 → blob.bin，并清理分片目录 */
  async finalize(fileId, expectedSize) {
    const indexes = await this.listIndexes(fileId);
    if (!indexes.length) return false;
    const out = this.blobPath(fileId);
    const outTmp = out + '.tmp';
    const ws = fs.createWriteStream(outTmp);
    let written = 0;
    try {
      for (const i of indexes) {
        const buf = await fs.promises.readFile(this.chunkPath(fileId, i));
        written += buf.length;
        if (!ws.write(buf)) {
          await new Promise((res) => ws.once('drain', res));
        }
      }
    } finally {
      await new Promise((res, rej) => ws.end((e) => (e ? rej(e) : res())));
    }
    if (expectedSize && written !== expectedSize) {
      await fs.promises.unlink(outTmp).catch(() => {});
      throw new Error('文件大小校验失败 ' + written + ' != ' + expectedSize);
    }
    await fs.promises.rename(outTmp, out);
    // 清理分片
    const dir = this.chunkDirOf(fileId);
    const names = await fs.promises.readdir(dir).catch(() => []);
    for (const f of names) {
      await fs.promises.unlink(path.join(dir, f)).catch(() => {});
    }
    return true;
  }

  async *readRange(fileId, start, end) {
    const p = this.blobPath(fileId);
    let stat;
    try {
      stat = await fs.promises.stat(p);
    } catch (_) {
      return;
    }
    const from = Math.max(0, Math.min(start, stat.size - 1));
    const to = Math.max(from, Math.min(end, stat.size - 1));
    const stream = fs.createReadStream(p, { start: from, end: to });
    for await (const c of stream) yield c;
  }

  async remove(fileId) {
    try {
      fs.rmSync(this.dirOf(fileId), { recursive: true, force: true });
    } catch (_) { /* ignore */ }
  }
}

/* ================================================================== */
/* 云数据库后端                                                        */
/* ================================================================== */

/**
 * 云端文件字节后端。
 *
 * 权威存储是云数据库的 public.file_blobs 表，一行一个分片：
 *   (file_id TEXT, idx INTEGER, data TEXT /* base64 *\/, bytes INTEGER)
 *
 * 本地磁盘通过 LocalBlobStore 兼作读缓存：
 * - 写入时双写（云端权威、本地缓存），本地写失败不影响云端；
 * - 读取时若本地已合并出 blob.bin 就走磁盘（Range 快），否则回源云端。
 *
 * 分片写入不阻塞上传请求（云端往返约 1~2 秒/片，串起来会让大文件上传慢 3 倍），
 * 但在途写入会被 track/settle 追踪，complete/init 前一定等待落地，
 * 因此「接口返回成功」仍然等价于「字节已进云端」。
 */
class CloudBlobStore {
  constructor(client, table, cache) {
    this.client = client;
    this.table = table || 'file_blobs';
    this.cache = cache || null;
    this.kind = 'cloud';
    this.pending = new Map();   // fileId -> Promise[]
    this.lastError = null;
  }

  /* ---------- 在途写入追踪 ---------- */

  track(fileId, promise) {
    let arr = this.pending.get(fileId);
    if (!arr) {
      arr = [];
      this.pending.set(fileId, arr);
    }
    arr.push(promise);
    const done = () => {
      const a = this.pending.get(fileId);
      if (!a) return;
      const i = a.indexOf(promise);
      if (i >= 0) a.splice(i, 1);
      if (!a.length) this.pending.delete(fileId);
    };
    promise.then(done, done);
    return promise;
  }

  /** 等待该文件所有在途写入落地；任一失败则抛出 */
  async settle(fileId) {
    const arr = this.pending.get(fileId);
    if (!arr || !arr.length) return;
    const results = await Promise.allSettled(arr.slice());
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) throw failed[0].reason;
  }

  /* ---------- 写 ---------- */

  async writeRow(fileId, index, buffer) {
    const { error } = await this.client.database
      .from(this.table)
      .upsert({
        file_id: fileId,
        idx: index,
        data: buffer.toString('base64'),
        bytes: buffer.length
      }, { onConflict: 'file_id,idx' });
    if (error) throw error;
  }

  /**
   * 写入分片。**不 await 云端写入**，只登记在途任务，由 settle() 统一等待。
   * 本地缓存同步写一份，供同实例快速读取与 Range 拖动。
   */
  putChunk(fileId, index, buffer) {
    const tasks = [this.writeRow(fileId, index, buffer)];
    if (this.cache) tasks.push(this.cache.putChunk(fileId, index, buffer));
    const p = Promise.all(tasks).then(() => undefined);
    this.track(fileId, p);
    // 防止未处理 rejection 提前抛出（错误会在 settle 时汇总）
    p.catch(() => {});
    return Promise.resolve();
  }

  async prepare(fileId) {
    if (this.cache) await this.cache.prepare(fileId).catch(() => {});
  }

  /* ---------- 读 ---------- */

  /** 云端已落地的分片序号 */
  async listIndexes(fileId) {
    const { data, error } = await this.client.database
      .from(this.table)
      .select('idx')
      .eq('file_id', fileId);
    if (error) throw error;
    return (data || []).map((r) => Number(r.idx)).sort((a, b) => a - b);
  }

  async hasChunk(fileId, index) {
    const { data, error } = await this.client.database
      .from(this.table)
      .select('idx')
      .eq('file_id', fileId)
      .eq('idx', index);
    if (error) throw error;
    return !!(data && data.length);
  }

  /** 云端已存储的总字节数 */
  async cloudBytes(fileId) {
    const { data, error } = await this.client.database
      .from(this.table)
      .select('bytes')
      .eq('file_id', fileId);
    if (error) throw error;
    if (!data || !data.length) return null;
    let n = 0;
    for (const r of data) n += Number(r.bytes || 0);
    return n;
  }

  async totalBytes(fileId) {
    const cloud = await this.cloudBytes(fileId);
    if (cloud !== null) return cloud;
    return this.cache ? this.cache.totalBytes(fileId) : null;
  }

  /**
   * 自愈：本地缓存里有、云端缺的分片，补写回云端。
   * （云端写失败但本地写成功时，complete 前会自动补齐。）
   */
  async repair(fileId, total) {
    if (!this.cache) return;
    const cloud = new Set(await this.listIndexes(fileId));
    if (cloud.size >= total) return;
    for (let i = 0; i < total; i++) {
      if (cloud.has(i)) continue;
      const p = this.cache.chunkPath(fileId, i);
      let buf = null;
      try {
        buf = await fs.promises.readFile(p);
      } catch (_) {
        continue;
      }
      await this.writeRow(fileId, i, buf);
    }
  }

  /** 从云端按分片顺序读出 [start,end) 字节 */
  async *readCloudRange(fileId, start, end, chunkSize) {
    if (!(end >= start)) return;
    const cs = chunkSize > 0 ? chunkSize : 4 * 1024 * 1024;
    const first = Math.floor(start / cs);
    const last = Math.floor((end - 1) / cs);
    // 分批取，避免一次性把整个大文件读进内存
    const BATCH = 4;
    for (let base = first; base <= last; base += BATCH) {
      const hi = Math.min(last, base + BATCH - 1);
      const { data, error } = await this.client.database
        .from(this.table)
        .select('idx,data')
        .eq('file_id', fileId)
        .gte('idx', base)
        .lte('idx', hi)
        .order('idx', { ascending: true });
      if (error) throw error;
      for (const row of data || []) {
        const buf = Buffer.from(row.data, 'base64');
        const chunkStart = Number(row.idx) * cs;
        const chunkEnd = chunkStart + buf.length;
        const s = Math.max(start, chunkStart);
        const e = Math.min(end, chunkEnd);
        if (e > s) yield buf.slice(s - chunkStart, e - chunkStart);
      }
    }
  }

  /** 优先走本地缓存（已合并的 blob.bin），否则回源云端 */
  async *readRange(fileId, start, end, chunkSize) {
    if (this.cache) {
      const local = await this.cache.totalBytes(fileId);
      if (local !== null) {
        yield* this.cache.readRange(fileId, start, end);
        return;
      }
    }
    yield* this.readCloudRange(fileId, start, end, chunkSize);
  }

  /* ---------- 收尾 / 删除 ---------- */

  /**
   * 收尾：云端不需要合并（分片本身就是存储单元），
   * 但尽量把本地分片合并成 blob.bin，作为同实例的读缓存。
   */
  async finalize(fileId, expectedSize) {
    if (!this.cache) return false;
    try {
      return await this.cache.finalize(fileId, expectedSize);
    } catch (_) {
      // 本地缓存合并不影响云端可用性
      return false;
    }
  }

  async remove(fileId) {
    if (this.cache) await this.cache.remove(fileId).catch(() => {});
    const { error } = await this.client.database
      .from(this.table)
      .delete()
      .eq('file_id', fileId);
    if (error) throw error;
  }
}

module.exports = { LocalBlobStore, CloudBlobStore };
