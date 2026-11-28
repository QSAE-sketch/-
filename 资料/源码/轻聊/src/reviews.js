/**
 * 内容审查单（合规补强 · 2026-11-28）
 *
 * 两类审查，一张表（db ns = reviews），规则由官方定案：
 *
 *  1. 图片小模型审核（kind=image，先发后审）
 *     - 发出即入队扫描（status=scanning），扫描中图片**不可被任何人查看**
 *     - 小模型判疑似违规 → status=pending 并上报官方，**2 小时**内不可查看
 *       官方 2 小时内处理：keep=确认无害恢复可见 / delete=确认违规删除
 *     - 官方 2 小时不处理 → 自动删除（宁可错删，不留违规内容挂着）
 *     - 判为正常 → status=clean，恢复可见
 *
 *  2. 用户举报（kind=report）
 *     - 被举报内容进入 pending，窗口拉长为 **12 小时**
 *     - 期间**消息可查看**（文本、图片消息的气泡都在），但**文件不可下载**
 *       （图片消息里的图片也按文件处理：不可加载）
 *     - 官方处理：keep=确认无问题恢复正常 / delete=删除内容
 *     - 官方 12 小时不处理 → 自动删除
 *
 * 本模块只管「审查单」的状态机与可见性判定；
 * 真正的字节删除 / 消息清除由 server.js 注入回调（purge 钩子）执行。
 * 模型推理在 src/image-moderation.js，产出的状态写进本模块。
 */
'use strict';

const { randomId, now } = require('./util');

/** 图片审核（小模型审出疑似违规，上报官方）的处置窗口：2 小时（测试可调短） */
const IMAGE_WINDOW_MS = Number(process.env.REVIEW_IMAGE_WINDOW_MS) > 0
  ? Number(process.env.REVIEW_IMAGE_WINDOW_MS)
  : 2 * 60 * 60 * 1000;
/** 被举报内容的处置窗口：12 小时（测试可调短） */
const REPORT_WINDOW_MS = Number(process.env.REVIEW_REPORT_WINDOW_MS) > 0
  ? Number(process.env.REVIEW_REPORT_WINDOW_MS)
  : 12 * 60 * 60 * 1000;
/** scanning 卡死兜底：超过 10 分钟没扫完的按 pending 处理（保守） */
const SCANNING_STUCK_MS = 10 * 60 * 1000;
/** clean 审查单保留时长（留底审计，过期清理） */
const CLEAN_RETAIN_MS = 24 * 60 * 60 * 1000;

function createReviews(db) {
  const api = {
    IMAGE_WINDOW_MS,
    REPORT_WINDOW_MS,

    /* ---------------- 创建 ---------------- */

    /** 图片审核单（消息图片 / 头像）。创建即 scanning，立刻对所有人隐藏 */
    createImageReview(payload) {
      const doc = {
        id: randomId('rv_'),
        kind: 'image',
        status: 'scanning',
        targetType: payload.targetType,          // message-image / avatar
        fileId: payload.fileId || null,
        messageId: payload.messageId || null,
        roomId: payload.roomId || null,
        userId: payload.userId || null,          // 发送者 / 头像主人
        score: null,
        probs: null,
        deadline: null,
        action: null,
        handledBy: null,
        handledAt: null,
        createdAt: now()
      };
      return db.put('reviews', doc);
    },

    /** 举报审查单（内容进入 12 小时观察期） */
    createReportReview(payload) {
      const doc = {
        id: randomId('rv_'),
        kind: 'report',
        status: 'pending',
        targetType: payload.targetKind,          // message / file
        targetId: payload.targetId,              // 消息 id 或文件 id
        messageId: payload.targetKind === 'message' ? payload.targetId : null,
        fileId: payload.targetKind === 'file' ? payload.targetId : null,
        roomId: payload.roomId || null,
        userId: null,
        reporterId: payload.reporterId || null,
        reason: String(payload.reason || '').slice(0, 500),
        feedbackId: payload.feedbackId || null,  // 关联的反馈箱条目
        score: null,
        probs: null,
        deadline: now() + REPORT_WINDOW_MS,
        action: null,
        handledBy: null,
        handledAt: null,
        createdAt: now()
      };
      return db.put('reviews', doc);
    },

    /* ---------------- 状态推进 ---------------- */

    /** 小模型扫完：score < 0.5 → clean（恢复可见）；否则 pending + 2h 窗口 */
    finishScan(review, score, probs) {
      if (!review || review.status !== 'scanning') return review;
      if (score < 0.5) {
        review.status = 'clean';
        review.score = score;
        review.probs = probs || null;
      } else {
        review.status = 'pending';
        review.score = score;
        review.probs = probs || null;
        review.deadline = now() + IMAGE_WINDOW_MS;
      }
      db.put('reviews', review);
      return review;
    },

    /** 官方处理：keep=确认无害（恢复可见）/ delete=确认违规（立即删除） */
    handle(review, action, masterUser) {
      if (!review) return null;
      if (review.status === 'handled') return review;
      if (['keep', 'delete'].indexOf(action) === -1) throw new Error('无效的处置动作');
      review.status = 'handled';
      review.action = action;
      review.handledBy = masterUser ? masterUser.id : null;
      review.handledAt = now();
      db.put('reviews', review);
      return review;
    },

    /* ---------------- 查询 ---------------- */

    get(id) {
      return db.get('reviews', id);
    },

    /** 官方待处理列表（pending 的 image + report，按创建时间正序） */
    pendingList() {
      const list = db.byIdx('reviews', 'k1', 'pending')
        .concat(db.byIdx('reviews', 'k1', 'scanning'))
        .filter((r) => r.status === 'pending' || r.status === 'scanning');
      list.sort((a, b) => a.createdAt - b.createdAt);
      return list;
    },

    /** 某目标的全部有效审查单（handled/clean 过期的不算） */
    activeOf(targetId) {
      return db.list('reviews').filter((r) =>
        (r.fileId === targetId || r.messageId === targetId || r.targetId === targetId) &&
        (r.status === 'scanning' || r.status === 'pending'));
    },

    /**
     * 文件字节是否被审查拦截（/raw /download 等所有访问入口共用）：
     *  - 图片审核 scanning / pending：所有人不可查看
     *  - 被举报（report pending）：文件不可下载（消息本体仍可见）
     */
    fileBlocked(fileId) {
      const list = db.byIdx('reviews', 'k2', String(fileId));
      for (const r of list) {
        if (r.status === 'scanning' || r.status === 'pending') {
          if (r.kind === 'image') return r;         // 图片审核：完全不可见
          if (r.kind === 'report') return r;        // 被举报文件：不可下载
        }
      }
      return null;
    },

    /** 消息是否被举报挂起（消息本体可见，但里面的文件被 fileBlocked 拦） */
    messageReported(messageId) {
      const list = db.byIdx('reviews', 'k2', String(messageId));
      for (const r of list) {
        if (r.kind === 'report' && r.status === 'pending') return r;
      }
      return null;
    },

    /** 头像是否审查挂起（scanning/pending 期间对外显示默认头像） */
    avatarBlocked(userId) {
      const list = db.byIdx('reviews', 'k2', String(userId));
      for (const r of list) {
        if (r.kind === 'image' && r.targetType === 'avatar' &&
            (r.status === 'scanning' || r.status === 'pending')) return r;
      }
      return null;
    },

    /* ---------------- 清扫 ---------------- */

    /**
     * 到期清扫（server 定时器每分钟调一次）。
     * deps = { purgeImage(review), purgeTarget(review) }：
     *  - purgeImage：删图片文件字节 + 消息置空（消息图片超时删）
     *  - purgeTarget：删被举报的消息 / 文件
     * 返回处理数量（供运维日志）。
     */
    sweep(deps) {
      const t = now();
      let n = 0;
      for (const r of db.list('reviews')) {
        // scanning 卡死兜底：超 10 分钟没结果，保守转入 pending 计入 2h 窗口
        if (r.status === 'scanning' && t - r.createdAt > SCANNING_STUCK_MS) {
          r.status = 'pending';
          r.deadline = r.createdAt + IMAGE_WINDOW_MS;
          db.put('reviews', r);
          continue;
        }
        if (r.status !== 'pending') continue;
        const dl = r.deadline || (r.kind === 'report'
          ? r.createdAt + REPORT_WINDOW_MS
          : r.createdAt + IMAGE_WINDOW_MS);
        if (t < dl) continue;
        // 窗口到期官方没处理 → 自动删除
        try {
          if (r.kind === 'report' && deps.purgeTarget) deps.purgeTarget(r);
          else if (deps.purgeImage) deps.purgeImage(r);
        } catch (e) {
          console.error('[reviews] 到期自动删除失败 id=' + r.id + ': ' + (e && e.message ? e.message : e));
          continue; // 删除失败的下轮重试
        }
        r.status = 'handled';
        r.action = 'delete';
        r.handledBy = null;   // 系统自动执行
        r.handledAt = t;
        r.autoPurged = true;
        db.put('reviews', r);
        n++;
      }
      // 顺手清理过期的 clean 单（留底 24h）
      for (const r of db.list('reviews')) {
        if (r.status === 'clean' && t - (r.handledAt || r.createdAt) > CLEAN_RETAIN_MS) {
          db.del('reviews', r.id);
        }
      }
      return n;
    },

    /** 审查单的对外摘要（官方待处理列表 / 前端标记共用） */
    summary(r) {
      return {
        id: r.id,
        kind: r.kind,
        status: r.status,
        targetType: r.targetType,
        targetId: r.targetId || r.fileId || r.messageId || null,
        fileId: r.fileId,
        messageId: r.messageId,
        roomId: r.roomId,
        reporterId: r.reporterId,
        reason: r.reason,
        score: r.score,
        probs: r.probs,
        deadline: r.deadline,
        remainMs: r.deadline ? Math.max(0, r.deadline - now()) : null,
        createdAt: r.createdAt
      };
    }
  };
  return api;
}

module.exports = {
  createReviews,
  IMAGE_WINDOW_MS,
  REPORT_WINDOW_MS,
  SCANNING_STUCK_MS,
  CLEAN_RETAIN_MS
};
