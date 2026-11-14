'use strict';
/**
 * WorkBuddy 云服务适配层。
 *
 * 职责：把「轻聊」的文档集合存储（ns / id / k1 / k2 / doc）映射到云数据库的
 * public.docs 表，并封装成与 src/store.js 一致的同步语义接口。
 *
 * 关键约束（来自 cloud-service 技能与实测）：
 * - endpoint 与 publishableKey 只能来自 workbuddy_cloud_service 返回的 publicConfig，
 *   不硬编码业务域名；本文件里的是该应用被激活时返回的真实值。
 * - 数据平面按 Origin 精确匹配：服务端必须以「自己对外暴露的域名」作为 Origin，
 *   否则 403 access_denied。因此这里不写死域名，而是由调用方传入实际对外地址，
 *   本地开发则回落到 endpoint 本身。
 * - 数据库模块只需 publishableKey 即可匿名访问（RLS 策略按应用维度放行）；
 *   存储模块额外要求终端用户会话，服务端无法代持，故文件二进制仍走本地磁盘。
 */

const { createWorkBuddyCloud, createMemoryStorage } = require('@tencent-ai/workbuddy-cloud-sdk');

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

/**
 * publicConfig（来自 workbuddy_cloud_service activate 的返回值）
 * endpoint 与应用发布域名同源，因此它同时是数据平面地址与合法的 Origin。
 */
const PUBLIC_CONFIG = {
  resourceId: 'wbcs_4WsBKz3YcQTh2Cs2eU2Wwy',
  endpoint: 'https://qingliao-chat-33476.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_uYiIp668K7SSIukHhaRkrR_gzmtwmIBcZ4yAX8o6J6Vo0Tu0RFjr67S'
};

const TABLE = 'docs';

/* ------------------------------------------------------------------ */
/* 客户端初始化                                                        */
/* ------------------------------------------------------------------ */

let client = null;

/**
 * 构造带 Origin 的 fetch。
 * 浏览器会自动带 Origin；Node 端没有，必须显式补上，否则网关拒绝。
 */
function originFetch(origin) {
  return function (input, init) {
    const headers = new Headers(init && init.headers);
    if (!headers.has('origin')) headers.set('origin', origin);
    return fetch(input, Object.assign({}, init, { headers: headers }));
  };
}

/**
 * 初始化（幂等）。
 * @param {string} [origin] 对外域名；缺省用 publicConfig.endpoint（发布后即自身域名）
 */
function getClient(origin) {
  if (client) return client;
  const org = origin || PUBLIC_CONFIG.endpoint;
  client = createWorkBuddyCloud({
    endpoint: PUBLIC_CONFIG.endpoint,
    oauthRelayBaseUrl: PUBLIC_CONFIG.oauthRelayBaseUrl,
    publishableKey: PUBLIC_CONFIG.publishableKey,
    // Node 端没有 localStorage，用内存实现
    storage: createMemoryStorage(),
    fetch: originFetch(org)
  });
  return client;
}

/* ------------------------------------------------------------------ */
/* 集合存储：与 src/store.js 的接口一致                                 */
/* ------------------------------------------------------------------ */

/**
 * 云后端文档存储。
 *
 * 与本地 SQLite/JSON 后端相比有两个差异：
 * 1) 全部操作是异步的（云数据库走 HTTP）；
 * 2) byIdx 依赖 k1/k2 索引列，与本地后端完全一致。
 *
 * 为了让上层 db.js 保持同步调用习惯，本类内部维护一个「写后读」的内存镜像：
 * 写入先落内存（保证同一请求内读到的就是刚写的），同时异步同步到云端。
 * 进程重启时从云端全量加载重建镜像，因此云端是真正的持久层。
 */
class CloudStore {
  constructor(origin) {
    this.kind = 'workbuddy-cloud';
    this.cloud = getClient(origin);
    this.mem = new Map();          // ns -> Map(id -> {doc, k1, k2})
    this.pending = new Map();       // ns -> Map(id -> isPut) 待同步
    this.writing = [];              // 在途的云端写入 Promise
    this.chains = new Map();        // "ns\0id" -> 上一次写入 Promise（用于按文档串行化）
    this.ready = false;
    this.lastError = null;
  }

  /**
   * 归一化 doc 字段。
   *
   * 背景：历史脏数据里出现过 doc 被写成 JSON 字符串的记录（早期直接用
   * database.from(TABLE).update({doc: JSON.stringify(d)}) 写库所致）。
   * 这类记录加载后会让 db.list('users') 返回字符串，随后 u.usernameLower
   * 之类字段访问直接抛 undefined 报错，拖垮整条 /api/users 路由。
   *
   * 这里做「读时兼容」：字符串尝试 JSON.parse，失败则原样保留（不抛错，
   * 避免一条坏数据让整个进程起不来）。同时保留原始串，便于排查。
   */
  normalizeDoc(raw) {
    if (typeof raw !== 'string') return raw;
    const s = raw.trim();
    if (!s) return raw;
    if (s.charAt(0) !== '{' && s.charAt(0) !== '[') return raw;
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) {
      // 不是合法 JSON，保留原值
    }
    return raw;
  }

  /** 从云端全量加载，重建内存镜像 */
  async load() {
    const { data, error } = await this.cloud.database
      .from(TABLE)
      .select('ns,id,k1,k2,doc');
    if (error) throw error;
    this.mem.clear();
    let repaired = 0;
    for (const row of data || []) {
      const bucket = this.bucket(row.ns);
      const doc = this.normalizeDoc(row.doc);
      if (doc !== row.doc) repaired++;
      bucket.set(row.id, { doc, k1: row.k1, k2: row.k2 });
    }
    this.ready = true;
    if (repaired) {
      console.warn('[cloud] 发现 %d 条 doc 为字符串的历史记录，已在内存中自动解析', repaired);
    }
    return (data || []).length;
  }

  bucket(ns) {
    let b = this.mem.get(ns);
    if (!b) { b = new Map(); this.mem.set(ns, b); }
    return b;
  }

  /* ---------------- 读 ---------------- */

  get(ns, id) {
    const rec = this.mem.get(ns) && this.mem.get(ns).get(id);
    return rec ? rec.doc : null;
  }

  list(ns) {
    const b = this.mem.get(ns);
    if (!b) return [];
    const out = [];
    b.forEach((rec) => out.push(rec.doc));
    return out;
  }

  byIdx(ns, col, value) {
    const b = this.mem.get(ns);
    if (!b) return [];
    const v = value === undefined || value === null ? null : String(value);
    const out = [];
    b.forEach((rec) => {
      const val = (col === 'k2' ? rec.k2 : rec.k1);
      const norm = val === undefined || val === null ? null : String(val);
      if (norm === v) out.push(rec.doc);
    });
    return out;
  }

  countByIdx(ns, col, value) {
    return this.byIdx(ns, col, value).length;
  }

  /* ---------------- 写 ---------------- */

  /**
   * 写入文档。
   *
   * 内存先行（保证同一请求内立刻能读到刚写的数据），同时**立即**发起云端写入，
   * 不等防抖窗口 —— 避免「接口已返回成功但进程随即退出，数据却没落库」。
   * 失败会记入 lastError 并重新入队，由下一次 flush 重试。
   */
  put(ns, id, doc, k1, k2) {
    const bucket = this.bucket(ns);
    bucket.set(id, {
      doc: doc,
      k1: k1 === undefined || k1 === null ? null : String(k1),
      k2: k2 === undefined || k2 === null ? null : String(k2)
    });
    this.pending.set(ns, (this.pending.get(ns) || new Map()).set(id, true));
    this.enqueue(ns, id, true);
    return doc;
  }

  del(ns, id) {
    const bucket = this.mem.get(ns);
    if (bucket) bucket.delete(id);
    this.pending.set(ns, (this.pending.get(ns) || new Map()).set(id, false));
    this.enqueue(ns, id, false);
  }

  /* ---------------- 同步到云端 ---------------- */

  /**
   * 把写入排进队列。
   *
   * 按「文档」维度串行化：同一 id 的多次写入排成一条链，保证顺序
   * （例如先 put 紧接着 del，若并发发出，delete 可能先到云端、随后 upsert 又把它写回来）。
   * 不同 id 之间仍然并行，不影响吞吐。
   */
  enqueue(ns, id, isPut) {
    const key = ns + '\u0000' + id;
    const prev = this.chains.get(key) || Promise.resolve();
    const next = prev.then(() => this.writeOne(ns, id, isPut));
    // 挂一个空 catch，避免在 flush 接管之前就被判定为未处理的 rejection
    next.catch(() => {});
    this.chains.set(key, next.catch(() => {}));
    this.writing.push(next);
    return next;
  }

  /** 单条写入云数据库 */
  async writeOne(ns, id, isPut) {
    try {
      if (isPut) {
        const rec = this.mem.get(ns) && this.mem.get(ns).get(id);
        if (!rec) return;
        const row = { ns: ns, id: id, k1: rec.k1, k2: rec.k2, doc: rec.doc };
        const { error } = await this.cloud.database
          .from(TABLE)
          .upsert(row, { onConflict: 'ns,id' });
        if (error) throw error;
      } else {
        const { error } = await this.cloud.database
          .from(TABLE)
          .delete()
          .eq('ns', ns)
          .eq('id', id);
        if (error) throw error;
      }
      // 该条已成功落云，从待同步队列移除
      const b = this.pending.get(ns);
      if (b && b.get(id) === isPut) b.delete(id);
    } catch (e) {
      this.lastError = e;
      throw e;
    }
  }

  /** 等待所有在途写入完成（路由在响应前调用，保证「返回成功 = 已持久化」） */
  async flush() {
    const inFlight = this.writing;
    this.writing = [];
    let failure = null;
    if (inFlight.length) {
      const results = await Promise.allSettled(inFlight);
      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length) failure = failed[0].reason;
    }
    // 队列里仍留着的（先前失败、或本轮并发新增的）补一次
    if (this.pending.size) {
      for (const [ns, ids] of this.pending) {
        for (const [id, isPut] of ids) {
          try {
            await this.enqueue(ns, id, isPut);
          } catch (e) {
            if (!failure) failure = e;
          }
        }
      }
    }
    if (failure) throw failure;
  }

  close() {
    return this.flush();
  }
}

/* ------------------------------------------------------------------ */
/* LLM：免密钥大模型调用（可选能力）                                     */
/* ------------------------------------------------------------------ */

/**
 * 调用云端大模型。必须用流式（SDK 的 create 只支持 stream:true）。
 * @param {Array} messages OpenAI 风格消息数组
 * @param {string} model 模型 id，默认 auto（平台自动路由）
 * @returns {Promise<string>} 完整文本
 */
async function chat(messages, model) {
  const cloud = getClient();
  const stream = await cloud.llm.chat.completions.create({
    model: model || 'auto',
    stream: true,
    messages: messages
  });
  let text = '';
  for await (const chunk of stream) {
    const choice = chunk && chunk.choices && chunk.choices[0];
    const piece = choice && choice.delta && choice.delta.content;
    if (piece) text += piece;
  }
  return text;
}

module.exports = {
  PUBLIC_CONFIG,
  TABLE,
  CloudStore,
  getClient,
  chat
};
