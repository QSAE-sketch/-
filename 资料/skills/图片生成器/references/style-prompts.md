# 提示词词库与模板（图片生成器 Skill 参考资料）

本文件是「图片生成器」Skill 的提示词弹药库。每次出图前读它，按「提示词构造公式」从下面挑词拼装。
目标只有一个：**让模型没有偷懒空间，输出成片感强、彩色、细节丰富、绝不涂鸦感**。

---

## 一、提示词构造公式

```
[1 主体与场景细节]  +  [2 构图与镜头]  +  [3 光影]  +  [4 色彩强制(彩色)]  +  [5 媒介/风格锚定]  +  [6 完成度质量标记]  +  [7 负向排除]
```

七块尽量都填。哪怕用户给了详细描写，也至少补 4/5/6/7 四块。

---

## 二、各块词库

### 1. 主体与场景细节（把名词扩成画面）
- 不要只写"龙"→ 写 "a coiled golden-scale dragon riding above a sea of clouds, whiskers flowing, claws splashing waves, scales catching light"
- 不要只写"城堡"→ 写 "a towering fantasy castle on a cliff, banners in wind, glowing windows, ivy on stone"
- 通用扩写手法：加材质（石/木/鳞/金属/丝绸）、加动作（盘旋/奔逃/静立/飞扬）、加环境（云海/晨雾/落日/星夜/密林）、加微小细节（地衣/纹路/反光/尘埃光）。

### 2. 构图与镜头
- `wide establishing shot`（大全景）、`close-up portrait`（特写）、`dynamic low angle`（仰拍张力）、`bird's-eye view`（俯视）、`rule of thirds composition`、`central symmetric composition`（中轴庄严感）、`depth layering foreground-midground-background`（前中后景分层）。

### 3. 光影
- `volumetric lighting`（体积光）、`golden hour`（黄金时刻暖光）、`cinematic rim light`（轮廓光）、`soft diffused light`（柔光）、`dramatic chiaroscuro`（强明暗对比）、`glowing bioluminescence`（自发光）、`god rays through trees`。

### 4. 色彩强制（彩色，非背景类必填）
- 必写基座：`full color, vibrant, richly saturated, vivid palette`
- 国风彩墨配色预设（挑 3–5 个）：`黛青(dark teal)`、`靛蓝(indigo)`、`朱砂(cinnabar red)`、`赭石(ochre)`、`藤黄(gamboge yellow)`、`石绿(malachite green)`、`胭脂(rouge)`、`金箔(gold leaf accent)`、`花青(indigo-blue)`。
- 其他风格配色：`neon cyberpunk (magenta+cyan)`、`warm earthy (amber+terracotta+sienna)`、`pastel dreamy (soft pink+mint+cream)`。
- **游戏背景例外**：见 SKILL.md「彩色强制规则」，可换 `monochrome ink wash, low saturation`。

### 5. 媒介 / 风格锚定（杜绝"简单插画"默认）
- 国风：`traditional Chinese gongbi color ink painting (工笔彩墨)`、`xieyi ink wash with color (写意彩墨)`、`Song-dynasty landscape aesthetic`、`Chinese mythological illustration`。
- 写实/游戏：`digital concept art`、`Unreal Engine 5 render`、`octane render`、`matte painting`、`Pixar-style 3D render`。
- 插画：`commercial illustration`、`artstation trending`、`studio ghibli background style`、`flat vector with rich detail`。
- 像素（游戏素材）：`16-bit pixel art, limited but vibrant palette, clean pixels, no anti-aliasing`（注意像素风本身就"简"，但要有设计感不是乱涂）。

### 6. 完成度质量标记（成片感核心）
- 基础：`masterpiece, best quality, ultra-detailed, 8k, sharp focus`
- 强化（还嫌潦草时加）：`hyper-detailed, intricately detailed, smooth rendering, clean lines, professional finish, polished artwork, fully rendered, not a draft`
- 质感：`rich textures, fine brushwork, crisp edges, high fidelity`

### 7. 负向排除（把"小孩涂鸦"挡在门外）
- 必写：`not a sketch, not a draft, not a child's drawing, not crude, no doodle, no stick-figure, no low-effort, no rough outline, no scribble`
- 防黑白（非背景类）：`not monochrome, not black and white, not grayscale`
- 防糊：`no blurry, no deformed, no extra limbs, no mutated hands`

---

## 三、默认彩墨提示词模板（无描述时直接用）

复制下面整段作为 `prompt`（可直接用，模型对这段理解很好）：

```
Traditional Chinese color ink painting (彩墨画), ink as bone and mineral pigment as robe, vibrant full color, richly saturated. Distant mountains in dark teal and indigo, jade-green river, peach-blossom pink, autumn leaves in cinnabar and ochre, gold-leaf accents on clouds. Xuan paper texture with flowing ink rhythm, fine gongbi brushwork combined with xieyi spirit. Composition in Northern Song landscape deep-distance style: layered mountain ranges in far view, pavilions and bridges in mid view, rocks and grasses in near view, mist swirling in the negative space. Majestic yet elegant, prosperous and auspicious atmosphere. masterpiece, best quality, ultra-detailed, 8k, sharp focus, smooth rendering, professional traditional Chinese painting, intricate details, vivid palette. NOT a sketch, NOT monochrome, NOT black and white, NOT a child's drawing, no crude doodle.
```

微调方向：
- 要"更喜庆/年画感" → 加 `festive, vermilion and gold dominant, auspicious clouds (祥云), fortune motifs`。
- 要"仙侠/玄幻" → 加 `immortal realm, floating peaks, spirit beasts, glowing mana, ethereal mist`。
- 要"山水空灵" → 加 `minimalist negative space, lone scholar boat, quiet moonlight, restrained color`。

---

## 四、示例：描述 → 重写成专业提示词

**用户原话**：「画个游戏里的火焰法师立绘」

**重写后 prompt**：
```
A flame mage character portrait for a game, standing pose, robes of deep crimson and gold embroidery, staff crowned with a blazing azure fire orb, embers drifting, determined expression, intricate armor trim. Close-up three-quarter portrait, dynamic low angle for presence. Volumetric firelight, rim light on silhouette, dark chamber background with glowing runes. Full color, vibrant, richly saturated (crimson+gold+azure). Digital concept art, Unreal Engine 5 render style, artstation trending. masterpiece, best quality, ultra-detailed, 8k, sharp focus, smooth rendering, polished artwork, intricate details. NOT a sketch, NOT a child's drawing, no crude doodle, no deformed hands, no blurry.
```

**用户原话**：「来张水墨」(无具体描述)

→ 直接用第三节「默认彩墨提示词模板」。

**用户原话**：「游戏地图背景，黑白水墨就行」

→ 命中"游戏背景例外"，用：`Traditional Chinese ink wash painting, monochrome sumi-e, low saturation, misty mountains and river, fine brushwork, professional finish, masterpiece, ultra-detailed, sharp focus. NOT a sketch, NOT crude, no doodle.`（彩色强制关闭，但完成度标记保留）

---

## 五、image-to-image（带参考图）提示词写法

当用户给了参考图（`image` 参数）：

- **重绘风格/配色**（保留构图，换皮）：`prompt = "reimagine the reference as traditional Chinese color ink painting, vibrant full color, gongbi brushwork"` + `input_fidelity: 0.35`
- **保构图精修**（当贴图/立绘处理）：`prompt = "clean up, add rich color and detail, professional game asset, sharp"` + `input_fidelity: 0.8`
- **局部改色**：`prompt = "change the robe to crimson and gold, keep everything else"` + `input_fidelity: 0.6`

---

## 六、质量兜底（出图不满意时逐级加料）

1. 仍扁平 → 加 `octane render, unreal engine 5 style lighting, hyper-detailed`。
2. 仍偏草图 → 加 `fully rendered painting, not a lineart, smooth filled colors`。
3. 意外黑白 → 确认 `full color` 在 prompt，并加 `not monochrome, not black and white, not grayscale`。
4. 主体糊/畸形 → 加 `sharp focus, anatomically correct, no mutated, clean composition`，必要时换 `size` 更大或 `quality: high`。
