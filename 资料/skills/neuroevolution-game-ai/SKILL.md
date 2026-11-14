---
name: neuroevolution-game-ai
description: 让 AI 通过神经进化（遗传算法）自己学会玩一个自包含小游戏（如植物大战僵尸、跑酷等），无需人类示范、不依赖深度学习库（纯 numpy）。当用户说"让 AI 自己学玩游戏""做个会自己玩 X 的 AI""训练 AI 通关""神经进化小游戏 AI"时触发。提供完整脚手架：游戏环境(无头可跑) + 神经网络 + 遗传算法训练器 + 实时观看界面。
---

# 神经进化游戏 AI（Neuroevolution Game AI）

用户想做一个「像 B 站那种——AI 自己学会玩某个游戏」的项目时，用这套脚手架。
核心是 **MarI/O / QWOP 思路的简化版**：用遗传算法进化一个小神经网络，让它从随机乱按到逐渐变强。

## 何时用
- "让 AI 自己学玩植物大战僵尸 / 马里奥 / 跑酷 / 某游戏"
- "做个会自己玩游戏的 AI，不要我教"
- 用户想要**可见的学习过程**（一代比一代强，能实时看它玩）

## 架构（4 个模块 + 1 个入口）
1. **environment.py** —— 自包含游戏环境，**不依赖 pygame**，无头也能跑模拟。
   - 必须有 `reset()`、`observe()`（只读不前进）、`step(action)`（前进 1 步）。
   - 暴露一个**固定长度的「状态向量」**（给神经网络当输入）：如阳光/血量/各车道僵尸数量与距离/植物分布等，全部归一化到 ~[0,1]。
   - `decode_action(outputs, world)`：把网络输出翻译成具体动作（种什么/放哪/或啥也不干）。
   - `step` 内部按 tick 推进物理：植物产出/攻击、子弹飞行命中、僵尸移动/啃食、波次、胜负判定。
2. **neuroevolution.py** —— numpy 前馈神经网络 + 遗传算子。
   - 网络 = 基因组。输入层→双隐藏层(relu)→多个输出头（如「植物类型 / 车道 / 列」各一个 softmax 前的 logits）。
   - `crossover(a,b)`：均匀交叉；`mutate(net)`：逐权重高斯变异。
   - `save(npz)` / `load(npz)`：存最优权重给观看用。
3. **trainer.py** —— 训练主循环。
   - 每代：种群每个基因组各玩一整局 → 打分 → 排序。
   - 适应度（fitness）要**同时奖励过程与结果**：存活时间 + 击杀数×大权重 + 清波数×大权重 + 通关大奖。这样选择压力才够，AI 才会从「啥也不干」进化出有效策略。
   - 精英保留（top-K 直接进下一代）+ 锦标赛选父母 + 交叉变异补满种群。
   - 每代存 `best_genome.npz`（给 watch 用）+ 整个种群 `pop.pkl`（断点续训）+ `training_log.csv`。
   - 提供 `smoke()`：随机网络跑几局只验证不崩溃，**不真正训练**（用户睡觉前交差用）。
4. **watch.py** —— pygame 实时渲染战局（格子/植物/僵尸/子弹/HUD），加载最优权重让 AI 自己玩；支持速度调节、胜负重开。
   - `import pygame` 放文件顶部即可；`pygame.init()` 只在 watch 运行时调用，smoke/train 不受影响。
5. **run.py** —— argparse 入口：`train [--gens N] [--resume]` / `watch [--speed N]` / `smoke`。

## 关键设计要点
- **状态向量维度必须固定**，且和神经网络输入层一致（在 config 里定义 `NUM_INPUTS` 一处为准）。
- **动作空间别太大**：用「每隔 N 步决策一次、每次只落一子」能大幅加快学习。
- **训练必须无头快跑**（纯 Python + numpy，不渲染），弱机也能几秒一代；观看才用 pygame 实时。
- **胜利/失败条件要清晰**：如僵尸进家=失败、撑过 N 波=胜利。
- 想调难度/速度/变异强度，全放 `config.py` 一处，README 给张对照表。

## 可复用的完整范例
本仓库已有一个跑通的实现，直接复制改游戏即可：
`D:\AI\2026-07-22-02-15-59\pvz-ai\`（植物大战僵尸 · 神经进化 AI）。
它的 environment/trainer/watch 结构就是标准模板，把游戏逻辑换成别的游戏即可复用整套训练与观看管线。

## 依赖与坑
- 用本机托管 venv：`C:\Users\baoka\.workbuddy\binaries\python\envs\default`
- **Windows 上 venv 的 pip 在 `Scripts/` 不是 `bin/`**（git bash 里路径是 `Scripts/pip.exe`），装包别写错。
- 需要 `numpy`（通常已预装）+ `pygame`（观看用，缺了 `Scripts/pip.exe install pygame`）。
- 用户说「别帮我训练」时：**只跑 smoke 验证，绝不执行正式 train**。训练留给他自己看。

## 交付时要说清
- 怎么开训、怎么看、怎么续训（README 写清）。
- 看 `training_log.csv` 的「击杀/清波/胜利」列逐代上涨 = AI 在学。
- 如果某代后涨不动，提示用户调 `config.py`（变异率、种群、僵尸速度等）。

## 做成 Windows 桌面应用（可选增强）
当用户嫌命令行麻烦、要「双击就能用」时，把训练+观看**包进一个 pygame 单窗口**：
- `desktop_app.py`：左侧游戏画面/训练曲线，右侧控制面板（开始训练/停止、代数+种群步进按钮、看AI玩/停止、调速）。
  - **训练走后台线程**（`threading.Thread` daemon），用 `trainer.train(on_gen=..., stop_event=...)` 的回调把每代结果 `queue.Queue.put` 给主线程更新 UI；`stop_event.set()` 一键中断。
  - **观看走主循环**：按 speed 每帧 `world.step()` 几步，调用 `watch.render(flip=False)` 把画面画到子 `pygame.Surface` 再 blit 到主屏（避免 `flip` 翻转主显示）。
  - 按钮用「矩形+碰撞检测」自绘（`pygame.Rect.collidepoint` + `MOUSEBUTTONDOWN`），无需 GUI 库，契合像素风且零额外依赖。
- 兼容性改造（向下兼容 CLI）：`trainer.train` 加 `on_gen=None, stop_event=None`；`watch.render` 加 `flip=True` 参数（默认行为不变）。
- 打包：`pyinstaller --onedir --windowed --hidden-import numpy --hidden-import numpy.random desktop_app.py`。onedir 比 onefile 在弱机启动快（不解压 numpy）。exe 在 `dist/<name>/`，整个文件夹一起分发，双击即用。
- 坑：纯 pygame 自绘渲染到子 surface 时，**不要**调 `pygame.display.flip()`（会翻转主屏）——渲染函数加 `flip` 开关，桌面应用传 `False`。
