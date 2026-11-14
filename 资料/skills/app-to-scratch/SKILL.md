---
name: app-to-scratch
description: 把 Windows 桌面应用（HTML/JS、Python GUI、.exe）转换成 Scratch 能直接打开的 .sb3 项目。高保真尽量 1:1 还原界面与交互，无法还原的能力明确标注。
---

# app-to-scratch

把任意 Windows 桌面应用，转换成一个**合法、Scratch 能直接打开运行**的 `.sb3` 项目文件。

核心思路：分析应用的界面元素与交互逻辑 → 映射成 Scratch 的「舞台 + 角色 + 积木」→ 生成标准 `.sb3`（ZIP 包内 `project.json` + SVG 造型）。无法还原的能力不硬编，而是生成一个「⚠️未支持功能」角色明确标注。

## 何时用
- 用户拖入一个桌面应用（文件夹 / 单个 .html / .py 源码 / .exe），要求「转成 Scratch / 转成 sb3 / 转成 Scratch 能打开的模式 / 让 Scratch 识别」。
- 这是「桌面应用 → Scratch 项目」的一站式转换器。

## 支持的输入形态（detect.py 自动识别）

| 形态 | 识别依据 | 解析深度 |
|------|----------|----------|
| HTML/JS 网页应用 | 目录含 .html/.js，或单个 .html | 高：DOM 元素 + 启发式提取 JS 交互（点击/变量/显隐/提示/网络） |
| Python GUI（tkinter 为主） | .py 含 tkinter / PyQt | 中：控件 + 回调（点击/变量/文本更新/显隐） |
| .exe 二进制 | 扩展名 .exe | 降级：提取字符串 + 猜测框架 + 标注「需提供源码」 |

## 工作流程（统一入口 convert.py）

```
应用路径
  → detect.py      识别形态
  → 对应解析器      HTML/Python/exe → AppModel 中间表示
  → build_sb3.py    AppModel → 合法 .sb3
  → auto_fix_sb3.py  🐞联动 bug-fixer：生成后自动检查并修复通用结构性 bug（见下节）
  → verify_sb3.py   校验结构合法 + 硬性工程要求（见下）；不通过则转换失败
```

一条命令：
```bash
python convert.py <应用路径> [out.sb3]
```
- 自动产出 `<out>.appmodel.json` 中间产物
- 末尾打印转换报告：元素数 / 变量数 / 绑定交互数 / 无法还原清单

## 中间表示 AppModel（解析器与生成器的契约）

```jsonc
{
  "title": "应用名",
  "page_w": 800, "page_h": 600,        // 页面逻辑尺寸，用于坐标映射(舞台480x360)
  "variables": [{"name":"count","init":0}],
  "broadcasts": ["消息1"],
  "elements": [
    {"kind":"button|label|input|image|canvas|container",
     "id":"btn1","text":"确定",
     "x":100,"y":80,"w":120,"h":40,
     "events":[{"trigger":"click",
                "actions":[{"type":"set_var","var":"count","value":1},
                           {"type":"say","text":"已点击"},
                           {"type":"show"}]}]}
  ],
  "unsupported": ["网络请求(fetch/XHR)", "..."]   // 无法还原的能力
}
```

## 映射规则
- 页面/窗口 → 舞台背景（显示标题）
- 按钮/标签/输入框/图片/画布 → 各自一个 Scratch 角色，带自动生成的 SVG 造型
- 元素坐标 → 舞台坐标（480×360，中心原点）映射
- 点击事件 → `当本角色被点击` + 对应动作积木串
- JS/Python 变量 → Scratch 全局变量（舞台「绿旗」初始化设初值）
- 显示/隐藏元素 → `显示` / `隐藏` 积木
- 提示(alert / 文本更新) → `说` 积木
- 广播 → `广播` 积木
- 无法还原的能力 → 生成「⚠️未支持功能」角色，`说` 出清单

## 硬性要求（生成的 .sb3 必须是「真正的 Scratch 工程」，不是代码壳）

Scratch 是拼积木的环境：产物被 Scratch 打开后，**编码区必须能正常显示拼好的积木、舞台上必须能看到创建出来的角色**。转换时死守以下规则，并由 `verify_sb3.py` 卡关：

1. **每个应用组件 → 一个真实角色(sprite)**：按钮/标签/输入框/图片/画布/游戏实体各自成一个 sprite，带自动生成的 SVG 造型。舞台只放背景、全局变量/列表、广播。绝不允许"所有逻辑塞舞台、没有角色"。
2. **每个角色至少 1 条 `topLevel` 积木脚本**：保证在 Scratch 里点开该角色就能看到拼好的积木（`当绿旗被点击` / `当本角色被点击` / `当接收到 xx` 起步）。没有 topLevel 积木的角色 = 编码区空白 = 不合格。
3. **积木绝不能只挂在 `next` 链上**：`next` 链上的块固然要设 `parent`，**但更致命的是——所有作为 `input`/`SUBSTACK` 嵌套进去的块（变量块、运算块、条件块等）也必须把它的 `parent` 指回"包着它的那个块"**。凡是 `parent` 为 `null` 的非顶层块，加载器会当成"孤块"、拼不回父块 → **脚本区渲染失败、积木显示不出来（这是"打开后看不到积木"的头号根因）**。生成器必须在序列化前做一次 `parent` 全局回填（沿 `next` 链 + 递归遍历每个块的 `inputs`/`SUBSTACK`）。`verify_sb3.py` 已把"非顶层块 parent=null"列为致命错误。
4. **Stage 绝不能带 sprite 专属字段**：`x`/`y`/`size`/`direction`/`draggable`/`rotationStyle`/`visible` 只能出现在 sprite 上，舞台上写这些字段会导致加载器异常或行为不对。舞台字段集严格参考 Scratch 官方：仅 `tempo`/`volume`/`videoState`/`videoTransparency`/`textToSpeechLanguage`。
5. **数字字面量必须是字符串形式**：`[1, [4, "0"]]` 是对的，`[1, [4, 0]]` 会被某些加载器拒绝。**字符串字面量**用 `[1, [10, "文本"]]`。
6. **每个造型必须有 `rotationCenterX/Y` 和 `bitmapResolution`**：缺少会导致加载器无法定位或渲染失败。
7. **meta 字段使用桌面版 Scratch 格式**：`agent` 应为 `Scratch/X.Y.Z Electron/...`，`vm` 为 `13.7.4-svg`，而非网页版旧格式。
8. **每个角色至少 1 个可见造型**：创建的角色要在舞台上真的出现。
9. `verify_sb3.py` 不通过（角色数=0 / 某角色无 topLevel 积木 / 引用断链 / 非顶层块 parent=null / 广播格式错 / Stage 含 sprite 字段 / 数字字面量非字符串 / 造型缺字段）即视为转换失败，必须修到 OK 再交付。

## 限制（「高保真尽量 1:1」的边界）
Scratch 是 2D 少儿编程环境，**不是**通用运行时，以下会进 `unsupported` 标注（不丢不崩，明确告知）：
- 网络请求(fetch/XHR)、本地存储、Canvas 绘制、定时器/动画循环、音频播放、打开新窗口
- 复杂条件分支/循环、第三方库、文件读写、数据库
- `.exe` 二进制无法深入解析（提示用户提供源码目录以获得高保真）

HTML/Python 解析均为**启发式正则**，写法特别复杂时可能漏解。遇到漏解：在报告中说明，并尽量给出可运行的 Scratch 近似；不要编造无法验证的还原。

## 联动 bug-fixer（自动自检自修）

转换不是「生成完就甩给大佬」。本 skill 内置 bug-fixer 能力：**build 生成 .sb3 之后，convert.py 自动调用 `auto_fix_sb3.py` 跑一遍全量结构体检，发现问题当场修掉，再交给 `verify_sb3.py` 卡关**。等价于「做完 → 自动检查 → 有 bug 就修 → 再校验」的闭环。

`auto_fix_sb3.py` 会自动修掉的通用 bug（均为「打开即崩 / 看不到积木 / 广播失灵」已证实根因）：

1. **共享积木非法结构**——同一积木被多个 input/next 槽引用（入度>1）→ 深克隆去重，保证每块只有 1 个 parent。
2. **parent 回填**——所有非顶层块的 parent 指向「包着它的块」（parent=null 是积木显示不出来的头号根因）。
3. **广播发送块格式**——`event_broadcast`/`event_broadcastandwait` 必须用 `inputs.BROADCAST_INPUT=[1,[11,名,id]]`，不能用 `fields.BROADCAST_OPTION`（用错则广播可能发不出去，状态机失灵）。
4. **广播注册**——发送块引用的广播名若不在工程 broadcasts 池，自动注册进去（否则「有发送无接收」）。
5. **数字字面量**——`[4, 0]` → `[4, "0"]`（某些加载器拒绝非字符串）。
6. **Stage 剥离 sprite 专属字段**——`x/y/size/direction/draggable/rotationStyle/visible` 会导致加载异常。
7. **造型补 `rotationCenterX/Y` + `bitmapResolution`**（缺则渲染失败）。

**两层兜底**：若 `auto_fix_sb3.py` 修完、`verify_sb3.py` 仍不通过（遇到非结构性、需理解业务逻辑的 bug，如坐标飞到太空、切换按钮连锁失效），convert.py 会提示「请 @skill:bug-fixer 人工介入」，此时再显式召唤 bug-fixer 做更深的行为级排查。

## 文件清单
- `scripts/detect.py` — 形态识别
- `scripts/parse_html.py` — HTML/JS → AppModel
- `scripts/parse_python.py` — Python GUI(tkinter) → AppModel
- `scripts/parse_exe.py` — .exe 降级
- `scripts/build_sb3.py` — AppModel → .sb3
- `scripts/auto_fix_sb3.py` — 🐞bug-fixer 联动：生成后自动修复通用结构性 bug
- `scripts/verify_sb3.py` — .sb3 合法性校验
- `scripts/convert.py` — 统一入口
- `examples/` — 测试样本（sample_app 为 HTML、sample_py_app 为 tkinter）

## 扩展方向
- 支持更多控件（滑块/下拉/复选框）
- JS 条件/循环 → Scratch 控制积木的更精细映射
- PyQt 深度解析
- 从 .exe（pyinstaller 打包）解包取回源码再转换
