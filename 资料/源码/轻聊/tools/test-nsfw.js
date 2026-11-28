#!/usr/bin/env node
/**
 * nsfwjs 图片审核模型实测脚本
 * 用法: node tools/test-nsfw.js <图片1> [图片2] ...
 * 输出每张图的五分类概率 + 违规判定（加权分 >= 0.5 判疑似违规）
 * 五分类: Neutral(正常) / Drawing(绘画) / Sexy(性感) / Hentai(色情动漫) / Porn(色情)
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 与 image-moderation.js 保持一致的加权判定
const WEIGHTS = { Porn: 1, Hentai: 1, Sexy: 0.4, Neutral: 0, Drawing: 0 };
const THRESHOLD = 0.5;

async function main() {
  const tf = require('@tensorflow/tfjs');
  const nsfwjs = require('nsfwjs');
  const Jimp = require('jimp');

  // 强制 CPU 后端（服务器无 GPU）
  try { await tf.setBackend('cpu'); } catch (e) { /* 默认后端兜底 */ }
  await tf.ready();
  console.log('TF 后端: ' + tf.getBackend());

  const args = process.argv.slice(2);
  const modelArgIdx = args.indexOf('--model');
  let modelName = undefined; // 默认 MobileNetV2（3.5MB 最小）
  if (modelArgIdx !== -1) {
    modelName = args[modelArgIdx + 1]; // 'MobileNetV2' | 'MobileNetV2Mid' | 'InceptionV3'
    args.splice(modelArgIdx, 2);
  }
  if (!args.length) {
    console.error('用法: node tools/test-nsfw.js [--model MobileNetV2|MobileNetV2Mid|InceptionV3] <图片...>');
    process.exit(1);
  }

  const t0 = Date.now();
  const model = await nsfwjs.load(modelName || 'MobileNetV2');
  console.log('模型: ' + (modelName || 'MobileNetV2(默认 3.5MB)') + '  加载耗时: ' + (Date.now() - t0) + 'ms\n');

  for (const p of args) {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) {
      console.log('\n[跳过] 文件不存在: ' + p);
      continue;
    }
    const buf = fs.readFileSync(abs);
    try {
      const image = await Jimp.read(abs);
      // nsfwjs 输入要求 299x224 区间内的图，大图先缩到 299 宽（模型内部还会再缩，这一步控制内存）
      if (image.bitmap.width > 299) image.resize(299, Jimp.AUTO);
      const tensor = tf.browser.fromPixels(image.bitmap);
      const t1 = Date.now();
      const preds = await model.classify(tensor);
      const dt = Date.now() - t1;
      tensor.dispose();

      const byName = {};
      for (const pr of preds) byName[pr.className] = pr.probability;
      const score = (byName.Porn || 0) * WEIGHTS.Porn + (byName.Hentai || 0) * WEIGHTS.Hentai + (byName.Sexy || 0) * WEIGHTS.Sexy;
      const verdict = score >= THRESHOLD ? '❌ 判违规(删)' : '✅ 放行';

      console.log('--- ' + path.basename(p) + ' (' + (buf.length / 1024).toFixed(0) + 'KB) ---');
      for (const pr of preds) {
        console.log('  ' + pr.className.padEnd(9) + ' ' + (pr.probability * 100).toFixed(2) + '%');
      }
      console.log('  加权违规分: ' + score.toFixed(3) + ' / 阈值 ' + THRESHOLD + '  →  ' + verdict + '  (推理 ' + dt + 'ms)\n');
    } catch (e) {
      console.log('--- ' + path.basename(p) + ' 解码失败: ' + e.message + '\n');
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
