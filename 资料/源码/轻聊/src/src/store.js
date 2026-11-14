'use strict';
/**
 * 轻量存储层：优先使用 SQLite（node:sqlite / better-sqlite3），
 * 若运行环境不可用则自动降级为 JSON 文件存储（写入去抖 + 退出前落盘）。
 *
 * 对外统一为「文档集合」接口：
 *   put(ns, id, doc, k1, k2)
 *   get(ns, id)
 *   del(ns, id)
 *   list(ns)                 -> doc[]
 *   byIdx(ns, col, value)    -> doc[]   col ∈ {'k1','k2'}
 *   countByIdx(ns, col, value) -> number
 *   flush()                  -> Promise<void>
 */

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ */
/* SQLite 后端                                                         */
/* ------------------------------------------------------------------ */

function openSqliteBackend(file) {
  // 1) Node 内置 node:sqlite（Node >= 22.5，免 flag 亦可）
  let kind = null;
  let raw = null;
  try {
    raw = require('node:sqlite');
    kind = 'node:sqlite';
  } catch (_) { /* ignore */ }

  // 2) 回退 better-sqlite3（可选依赖，装不上也不影响发布）
  if (!raw) {
    try {
      raw = require('better-sqlite3');
      kind = 'better-sqlite3';
    } catch (_) { /* ignore */ }
  }
  if (!raw) return null;

  let db;
  if (kind === 'node:sqlite') {
    db = new raw.DatabaseSync(file);
  } else {
    db = new raw(file);
  }

  db.exec(`CREATE TABLE IF NOT EXISTS docs (
    ns  TEXT NOT NULL,
    id  TEXT NOT NULL,
    k1  TEXT,
    k2  TEXT,
    doc TEXT NOT NULL,
    PRIMARY KEY (ns, id)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_docs_k1 ON docs(ns, k1)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_docs_k2 ON docs(ns, k2)`);

  const stPut = db.prepare(
    `INSERT INTO docs(ns,id,k1,k2,doc) VALUES(?,?,?,?,?)
     ON CONFLICT(ns,id) DO UPDATE SET k1=excluded.k1, k2=excluded.k2, doc=excluded.doc`
  );
  const stGet = db.prepare(`SELECT doc FROM docs WHERE ns=? AND id=?`);
  const stDel = db.prepare(`DELETE FROM docs WHERE ns=? AND id=?`);
  const stList = db.prepare(`SELECT doc FROM docs WHERE ns=?`);
  const stIdx1 = db.prepare(`SELECT doc FROM docs WHERE ns=? AND k1=?`);
  const stIdx2 = db.prepare(`SELECT doc FROM docs WHERE ns=? AND k2=?`);
  const stCnt1 = db.prepare(`SELECT COUNT(*) AS c FROM docs WHERE ns=? AND k1=?`);
  const stCnt2 = db.prepare(`SELECT COUNT(*) AS c FROM docs WHERE ns=? AND k2=?`);

  const parse = (row) => (row ? JSON.parse(row.doc) : null);
  const parseAll = (rows) => rows.map((r) => JSON.parse(r.doc));

  return {
    kind,
    put(ns, id, doc, k1, k2) {
      stPut.run(ns, id, k1 === undefined || k1 === null ? null : String(k1),
        k2 === undefined || k2 === null ? null : String(k2), JSON.stringify(doc));
    },
    get(ns, id) {
      const r = stGet.get(ns, id);
      return r ? parse(r) : null;
    },
    del(ns, id) {
      stDel.run(ns, id);
    },
    list(ns) {
      return parseAll(stList.all(ns));
    },
    byIdx(ns, col, value) {
      const v = value === undefined || value === null ? null : String(value);
      const rows = col === 'k2' ? stIdx2.all(ns, v) : stIdx1.all(ns, v);
      return parseAll(rows);
    },
    countByIdx(ns, col, value) {
      const v = value === undefined || value === null ? null : String(value);
      const row = col === 'k2' ? stCnt2.get(ns, v) : stCnt1.get(ns, v);
      return row ? Number(row.c) : 0;
    },
    flush() {
      return Promise.resolve();
    },
    close() {
      try { db.close(); } catch (_) { /* ignore */ }
    }
  };
}

/* ------------------------------------------------------------------ */
/* JSON 文件后端（兜底）                                               */
/* ------------------------------------------------------------------ */

function openJsonBackend(file) {
  let data = { __meta: { version: 1 } };
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      if (raw && raw.trim()) data = JSON.parse(raw);
    }
  } catch (_) {
    data = { __meta: { version: 1 } };
  }
  if (!data.__meta) data.__meta = { version: 1 };

  const dirty = new Set();
  let timer = null;
  let writing = false;

  const persist = () => {
    if (writing) return;
    writing = true;
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
    writing = false;
    dirty.clear();
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; persist(); }, 400);
    if (timer.unref) timer.unref();
  };

  const bucket = (ns) => {
    if (!data[ns] || typeof data[ns] !== 'object') data[ns] = {};
    return data[ns];
  };

  // 剥离内部索引字段，返回干净文档
  const strip = (rec) => {
    const out = Object.assign({}, rec);
    delete out._k1;
    delete out._k2;
    return out;
  };

  return {
    kind: 'json-file',
    put(ns, id, doc, k1, k2) {
      const rec = Object.assign({}, doc);
      rec._k1 = k1 === undefined || k1 === null ? null : String(k1);
      rec._k2 = k2 === undefined || k2 === null ? null : String(k2);
      bucket(ns)[id] = rec;
      dirty.add(ns);
      schedule();
    },
    get(ns, id) {
      const rec = bucket(ns)[id];
      return rec ? strip(rec) : null;
    },
    del(ns, id) {
      if (bucket(ns)[id]) {
        delete bucket(ns)[id];
        dirty.add(ns);
        schedule();
      }
    },
    list(ns) {
      const b = bucket(ns);
      const out = [];
      const ids = Object.keys(b);
      for (let i = 0; i < ids.length; i++) out.push(strip(b[ids[i]]));
      return out;
    },
    byIdx(ns, col, value) {
      const key = col === 'k2' ? '_k2' : '_k1';
      const v = value === undefined || value === null ? null : String(value);
      const b = bucket(ns);
      const out = [];
      const ids = Object.keys(b);
      for (let i = 0; i < ids.length; i++) {
        const rec = b[ids[i]];
        const val = rec[key] === undefined ? null : rec[key];
        if (val === v) out.push(strip(rec));
      }
      return out;
    },
    countByIdx(ns, col, value) {
      return this.byIdx(ns, col, value).length;
    },
    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      persist();
      return Promise.resolve();
    },
    close() {
      persist();
    }
  };
}

/* ------------------------------------------------------------------ */

function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const sqliteFile = path.join(dataDir, 'app.db');
  const jsonFile = path.join(dataDir, 'store.json');

  let backend = null;
  try {
    backend = openSqliteBackend(sqliteFile);
  } catch (e) {
    backend = null;
  }
  if (!backend) backend = openJsonBackend(jsonFile);
  return backend;
}

module.exports = { createStore };
