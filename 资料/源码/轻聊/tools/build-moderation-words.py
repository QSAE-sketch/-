# -*- coding: utf-8 -*-
"""合并开源词库 konsheng/Sensitive-lexicon 为 assets/moderation-words.json"""
import os, json

SRC = r'C:\Users\Administrator\AppData\Local\Temp\sens-lex\Vocabulary'
OUT = r'D:\apk-download-site\资料\源码\轻聊\assets\moderation-words.json'

FILES = ['色情词库.txt', '色情类型.txt', '暴恐词库.txt', '涉枪涉爆.txt',
         '反动词库.txt', '政治类型.txt', '贪腐词库.txt', '新思想启蒙.txt',
         '补充词库.txt', 'GFW补充词库.txt', '非法网址.txt']

seen = set()
per = []

# 自维护补充：开源词库里常见违法交易的完整短词大多只存在于被我排除的宽泛词库
# （腾讯输入法/网易）中，这里按「明显违法、不会误伤日常聊天」的标准手工补充。
SUPPLEMENT = [
    # 赌博类
    '赌博', '赌博网站', '赌博平台', '博彩', '博彩网站', '博彩平台', '赌场', '网赌',
    '赌球', '赌钱', '网络赌博', '线上赌场', '棋牌赌博', '赌博开户', '押注平台',
    '六合彩内部', '六合彩资料', '六合彩图库', '时时彩', '重庆时时彩', '北京赛车', 'pk10',
    '百家乐代理', '百家乐开户', '龙虎斗', '轮盘赌', '老虎机破解', '外围赌球', '下注网站',
    # 枪支弹药
    '买枪', '卖枪', '枪支买卖', '枪支出售', '购枪', '枪械交易', '弹药出售', '买弹药',
    '卖子弹', '枪支代办', '仿真枪出售', '气枪销售', '私藏枪支',
    # 毒品交易
    '毒品交易', '出售毒品', '购买毒品', '毒品下单', '吸毒工具出售', '溜冰约',
    '出售冰毒', '购买冰毒', '大麻出售', '大麻购买', '代购毒品',
    # 色情交易
    '色情服务', '嫖娼', '卖淫', '援交', '找小姐', '上门服务加微信', '全国约炮',
    '裸聊收费', '卖片加微信', '淫秽物品出售', '色情网站代理', '处对象收费',
    # 诈骗话术
    '兼职刷单', '刷单返利', '杀猪盘', '解冻费', '保证金转账汇款', '安全账户汇款',
    '冒充公检法', '钓鱼网站制作', '木马程序出售', '盗号软件出售', '身份证代办',
    # 暴恐
    '制造炸弹', '炸弹教程', '制毒教程', '炸药制作', '爆炸物制作', '雷管出售',
]
for w in SUPPLEMENT:
    if len(w) >= 2:
        seen.add(w)
per.append('自维护补充: +%d' % len(seen))

for fn in FILES:
    n0 = len(seen)
    with open(os.path.join(SRC, fn), encoding='utf-8-sig') as f:
        for line in f:
            w = line.strip()
            if not w or w.startswith('#') or w.startswith('//'):
                continue
            if len(w) < 2 or len(w) > 60:
                continue
            seen.add(w)
    per.append('%s: +%d' % (fn, len(seen) - n0))

words = sorted(seen)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
out = {
    '_meta': {
        'source': 'konsheng/Sensitive-lexicon (MIT License, https://github.com/konsheng/Sensitive-lexicon)',
        'merged': FILES,
        'note': ('聊天场景专用筛选版：未收录 民生/广告/网易/腾讯输入法 等宽泛类目以免误伤日常聊天。'
                 '整体替换：复制本文件到 data/moderation-words.json 修改即可（每次调用重读，无需重启）。'),
        'builtAt': '2026-11-28',
    },
    # 豁免名单：词库里的日常词，聊天场景不应硬拦（命中这些词放行）
    'allow': ['兼职', '出售', '代办', '发票', '维权', '开奖号'],
    'words': words,
}
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
print('词条数:', len(words))
print('文件大小:', os.path.getsize(OUT), 'bytes')
print('\n'.join(per))
