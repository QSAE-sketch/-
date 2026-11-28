/**
 * 图片小模型审核（nsfwjs · 服务器端推理 · 先发后审）
 *
 * 设计（官方 2026-11-28 定案）：
 *  - 模型：nsfwjs 内置 MobileNetV2（3.5MB，随 npm 包自带，不联网下载），
 *    纯 JS CPU 后端（@tensorflow/tfjs），单张推理 ~0.7s，服务器进程内完成，
 *    **不依赖任何人的电脑开机**。
 *  - 流程：先发后审。图片消息/头像发出后入队扫描，扫描中（scanning）与
 *    疑似违规待官方处置期间（pending）图片不可被查看（见 src/reviews.js）。
 *  - 判定：加权违规分 = porn*1 + hentai*1 + sexy*0.4，≥0.5 判疑似违规。
 *    该公式下 sexy 满分只有 0.4，泳装/健身这类正常图**数学上不可能误删**
 *    （实测比基尼照加权分 0.400 放行；要超线必须 porn/hentai ≥10% 附和）。
 *  - 超时：pending 2 小时官方不处理 → 由 reviews.sweep 自动删除。
 *  - 降级：nsfwjs/tfjs 未安装时模块自动关闭（enabled=false），enqueue 直接
 *    放行——核心功能零依赖原则不变，装上依赖即自动启用。
 *  - 解码：纯 JS 版 tfjs 没有 tf.node.decodeImage，用 jimp 解码 + 缩放
 *    （tools/test-nsfw.js 已实测该链路）。
 */
'use strict';

const { IMAGE_WINDOW_MS } = require('./reviews');

/** 加权违规分阈值 */
const THRESHOLD = 0.5;
/** 五分类加权：色情/色情动漫满权重，性感 0.4（防误伤正常图的结构性保险） */
const WEIGHTS = { Porn: 1, Hentai: 1, Sexy: 0.4, Neutral: 0, Drawing: 0 };
/** 队列并发上限（推理是 CPU 密集，串行最稳） */
const MAX_CONCURRENT = 1;

let tf = null;
let nsfwjs = null;
let Jimp = null;
let enabled = false;
let modelPromise = null;   // 懒加载：首个任务触发，全局只加载一次
const queue = [];          // 待扫任务
let running = 0;

function scoreOf(probs) {
  let s = 0;
  for (const k of Object.keys(WEIGHTS)) s += (probs[k] || 0) * WEIGHTS[k];
  return s;
}

async function loadModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      try { await tf.setBackend('cpu'); } catch (e) { /* 默认后端兜底 */ }
      await tf.ready();
      return nsfwjs.load('MobileNetV2');
    })();
  }
  return modelPromise;
}

function createImageModeration(reviews) {
  /* 可选依赖：没装就降级为不审核 */
  try {
    tf = require('@tensorflow/tfjs');
    nsfwjs = require('nsfwjs');
    Jimp = require('jimp');
    enabled = true;
    console.log('[image-moderation] nsfwjs 已启用（MobileNetV2 / CPU 后端）');
  } catch (e) {
    enabled = false;
    console.log('[image-moderation] 依赖未安装，图片审核降级为不启用: ' + e.message);
  }

  const api = {
    get enabled() { return enabled; },
    THRESHOLD,

    /**
     * 入队扫描。job = {
     *   targetType: 'message-image' | 'avatar',
     *   fileId, messageId?, roomId?, userId?,
     *   readBytes: async () => Buffer   // 字节读取闭包（服务器注入）
     * }
     * 立刻创建 scanning 审查单（图片随即对所有人隐藏），排队异步分类。
     */
    enqueue(job) {
      const review = reviews.createImageReview(job);
      if (!enabled) {
        // 未启用：扫描直接判正常放行（不让图片永远挂在 scanning 上）
        reviews.finishScan(review, 0, null);
        return review;
      }
      queue.push({ review, job });
      api._drain();
      return review;
    },

    async _drain() {
      if (running >= MAX_CONCURRENT) return;
      const item = queue.shift();
      if (!item) return;
      running++;
      try {
        await api._classifyOne(item);
      } catch (e) {
        console.error('[image-moderation] 扫描失败: ' + (e && e.message ? e.message : e));
        // 失败也放行：不让用户图片被卡死在 scanning（保守方向是宁可漏放，
        // 真违规靠举报兜底；卡死的 scanning 由 reviews.sweep 兜底转 pending）
        try { reviews.finishScan(item.review, 0, null); } catch (_) { /* ignore */ }
      } finally {
        running--;
        if (queue.length) api._drain();
      }
    },

    async _classifyOne(item) {
      const { review, job } = item;
      let buf;
      try {
        buf = await job.readBytes();
      } catch (e) {
        reviews.finishScan(review, 0, null);   // 字节没了（已删/过期），放行结束状态机
        return;
      }
      if (!buf || !buf.length) {
        reviews.finishScan(review, 0, null);
        return;
      }

      const model = await loadModel();
      // jimp 解码 + 缩到 299 宽控制内存（与 tools/test-nsfw.js 实测链路一致）
      const image = await Jimp.read(buf);
      if (image.bitmap.width > 299) image.resize(299, Jimp.AUTO);
      const tensor = tf.browser.fromPixels(image.bitmap);
      let probs;
      try {
        const preds = await model.classify(tensor);
        probs = {};
        for (const p of preds) probs[p.className] = p.probability;
      } finally {
        tensor.dispose();
      }

      const score = scoreOf(probs);
      reviews.finishScan(review, score, probs);
      if (score >= THRESHOLD) {
        console.log('[image-moderation] 疑似违规 → 上报官方 2h 处置: review=' + review.id +
          ' score=' + score.toFixed(3) + ' type=' + review.targetType +
          (review.messageId ? ' message=' + review.messageId : '') +
          (review.userId ? ' user=' + review.userId : ''));
      }
    },

    /** 运维概况（/api/admin 看） */
    info() {
      return {
        enabled,
        threshold: THRESHOLD,
        windowMs: IMAGE_WINDOW_MS,
        queueLength: queue.length,
        running
      };
    }
  };
  return api;
}

module.exports = { createImageModeration, scoreOf, THRESHOLD, WEIGHTS };
