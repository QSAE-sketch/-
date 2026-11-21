# 轻聊 · 在线聊天与文件传输

轻量化在线聊天网站，针对**红米 Note 2 + VIA 浏览器**优化：单页应用、零图片资源、约 48KB 前端资源、低内存占用。

## 快速启动

```bash
node start.js          # 或 npm start
```

默认端口 3000，可用环境变量覆盖：`PORT=8080 node start.js`

- Node ≥ 22.5 → 使用内置 `node:sqlite`
- Node < 22.5 → 自动以 `--experimental-sqlite` 重启
- 两者都不可用 → 自动降级为 JSON 文件存储（功能完全一致）

**零外部依赖**，无需 `npm install` 即可运行。

> 默认走 **WorkBuddy 云服务**（见下方「云服务接入」），云端不可用时自动降级到本地
> SQLite/JSON，服务始终可用。若要强制使用本地后端：`STORAGE_BACKEND=local node start.js`。

## 云服务接入

「轻聊」已接入 WorkBuddy 云服务（应用 `轻聊`，`wbapp_uYiIp668K7SSIukHhaRkrR`），
存储后端为 **云数据库**，进程重启、换机器都不丢数据。

### 架构

```
HTTP 请求
   └─ src/db.js（数据模型层，零改动）
        └─ store 代理（server.js）──▶ activeStore
             ├─ CloudStore  → 云数据库 public.docs 表   ← 默认
             └─ localStore  → data/app.db（SQLite）      ← 云端异常时自动降级
```

`src/db.js` 与全部 `/api/*` 路由**零改动**：云后端与本地后端实现同一套接口
（`get / list / byIdx / countByIdx / put / del / flush / close`），
所以上层代码完全感知不到底层是云端还是本地。

### 云端表结构

单表承载全部集合，精确映射既有 store 层的 `(ns, id, k1, k2, doc)` 抽象：

| 列 | 类型 | 说明 |
|---|---|---|
| `ns` | text | 集合名（users / sessions / rooms / members / messages / files / hidden / friendReqs / friendIdx / meta） |
| `id` | text | 文档主键 |
| `k1` | text | 一级索引（如 users.username、rooms.kind） |
| `k2` | text | 二级索引（如 rooms.ownerId、messages.seq） |
| `doc` | jsonb | 文档体 |
| `updated_at` | timestamptz | 更新时间 |

主键 `(ns, id)`，索引 `idx_docs_ns_k1` / `idx_docs_ns_k2`。
RLS 已开启，4 条策略：`docs_read_all` / `docs_insert_all` / `docs_update_all` / `docs_delete_all`
（应用维度放行，与既有「服务端统一鉴权、客户端不直连」的架构一致）。

### 文件字节表 `public.file_blobs`

文件二进制不进 `docs`（JSONB 存不下大块字节），单独用一张分片表：

| 列 | 类型 | 说明 |
|---|---|---|
| `file_id` | text | 关联 `docs` 中 `ns='files'` 的文档 id |
| `idx` | integer | 分片序号，从 0 起 |
| `data` | text | 该分片的 Base64 字节 |

`(file_id, idx)` 为主键，读取时按序拼接；本地磁盘仅作读缓存，
云端是权威存储。撤回 / 硬删除时同步清空该表对应行。

### 关键约束

- **Origin 精确匹配**：数据平面按 `Origin` 精确校验，域名不符返回 403 `access_denied`。
  服务端以 `PUBLIC_ORIGIN`（缺省为应用发布域名）作为 Origin 发起请求；
  发布到新域名时必须同步设置该环境变量，否则云端读写会被拒。
- **写后读内存镜像**：`CloudStore` 内部维护内存镜像，写入先落内存再立即落云，
  保持 `db.js` 的同步调用习惯；进程启动时从云端全量加载重建镜像。
- **响应前落盘**：所有 JSON 响应在写响应头之前先 `await store.flush()`，
  保证「接口返回成功 = 数据已持久化」，进程被强杀也不会丢已确认的数据。
- **同文档写入串行化**：同一 id 的多次写入按序排队，避免「先 put 后 del」时 delete 先到云端。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `STORAGE_BACKEND` | `cloud` | `cloud` = 云数据库；`local` = 本地 SQLite/JSON |
| `PUBLIC_ORIGIN` | 应用发布域名 | 数据平面的 Origin，必须与应用实际对外域名一致 |
| `DATA_DIR` | `./data` | 本地兜底后端的数据目录、文件二进制存放目录 |
| `PORT` | `3000` | 监听端口 |

### 模块接入范围与取舍

| 云服务模块 | 是否接入 | 说明 |
|---|---|---|
| Database | ✅ 全部业务数据 | 账号、房间、成员、消息、文件元数据、好友、隐藏记录、序号 |
| LLM API | ✅ 可用 | `src/cloud.js` 的 `chat(messages, model)`，免密钥流式调用（默认模型 `auto`） |
| Auth | ❌ 有意不接入 | 现有账号体系为用户名/密码 + 自建 session，迁移到云端 Auth 会改变登录行为 |
| Storage | ✅ 文件二进制入云 | 云存储需终端用户会话令牌（服务端无法代持），改用云库 `public.file_blobs` 表按分片存字节，本地磁盘降级为读缓存；分片合并 / Range 流式 / 断点续传语义全部保留 |

### 验证

```bash
node tools/cloud-verify.js     # 云服务端到端验证（19 项断言，含跨进程持久化）
node tools/run-suite.js cloud  # 完整回归（云端后端，401 项）
node tools/run-suite.js local  # 完整回归（本地后端基线，398 项）
```


## 功能对照

| 需求 | 实现 |
|---|---|
| 账号注册/登录、唯一性、密码安全存储 | 账号唯一索引；scrypt + 随机盐哈希（N=16384），数据库中无明文 |
| 四种登录 / 注册方式 | 账号+密码（默认）、邮箱、验证码、WorkBuddy 账号 —— 见下节「认证模块」 |
| 数据落库、多端同步 | SQLite 持久化；服务端常驻，设备关机不影响其他端收发；同账号多端独立登录态 |
| 公共聊天室 | 所有登录用户可发文字/图片/视频/文件，无需加入 |
| 200MB 单文件上限 | 服务端 + 客户端双重校验，图片视频同受此限 |
| 分片上传 / 断点续传 / 进度显示 | 4MB 分片，服务端记录已收分片，续传复用同一会话；前端进度条 |
| 自定义房间上限 5 个 | 每个账号最多创建 5 个 |
| 房间密码 | 免密房可直接进入查看，加入后方可发言；有密码房需正确密码才能进入并加入 |
| 好友与私聊 | 头像点开对方资料页 → 附言申请 → 同意即建立**双向**好友关系 → 私聊，沿用全部消息与文件能力 |
| 删除 | 仅对当前账号隐藏，隐藏状态落库，他人照常可见 |
| 撤回 | 仅发送者本人、发出后 2 分钟内；服务端彻底移除内容与文件，所有人（含发送者）不可再查看 |
| 直接删除 | **发送者本人、无时间窗口限制**；服务端真正清除消息正文 + 文件字节 + 所有人隐藏记录，所有设备同步消失；二次确认，不可恢复 |
| 全球访问 | 单端口 HTTP 服务，可直接部署为公网应用 |
| 设置页 · 清除缓存 | 释放本机缓存（含 WebView 真实缓存目录），显示真实占用，不动聊天记录与登录态 |
| 设置页 · 清除聊天记录 | **仅影响本机**，服务端数据保留，其它设备照常可见；两层二次确认 |
| 设置页 · 自定义下载路径 | 任意文件夹（SAF 目录树）；路径不可写时四档降级并提示实际落盘位置 |
| 文件下载 | `/api/files/:id/download` 走 attachment 响应，原始中文名保留；APK 内落盘到用户选定目录 |
| 深色 / 浅色主题 | 三种模式：**手动**（自选深浅）、**按时间**（阈值可配，跨阈值自动切换）、**跟随系统**（`prefers-color-scheme` 实时同步）；一套 CSS 变量双主题，首屏无闪烁 —— 见下节「主题系统」 |

## 认证模块：四种登录 / 注册方式

登录页与注册页都提供**同样的一组方式**，由用户自行切换选择；**账号+密码是默认选项**。

| 方式 | 登录表单 | 注册表单 | 身份由谁验证 |
|---|---|---|---|
| **账号+密码**（默认） | 账号 + 密码 | 账号 + 密码 + 昵称 | 轻聊本地（scrypt + 随机盐） |
| **邮箱** | 邮箱 + 密码 | 邮箱 + 验证码 + 密码 + 昵称 | 云服务（密码由云服务校验） |
| **验证码** | 邮箱或手机号 + 验证码 | 邮箱或手机号 + 验证码（+密码可选） | 云服务（发码 / 验码） |
| **WorkBuddy** | 一键跳转官方授权页 | 同上（首次登录即自动建号） | 云服务 OAuth（PKCE） |

### 选择与校验流程

**账号+密码**（默认，走本地体系，不碰云服务）

```
注册：账号格式校验(2-20位中英文数字下划线) → 密码≥6位 → 账号唯一性检查
      → scrypt 加盐哈希 → 写入 users 表 → 签发本地会话
登录：按账号查表 → 校验哈希 → 签发本地会话
```

**邮箱**

```
注册：先「获取验证码」→ 云服务 sendOtp 发码（返回 verificationId）
      → 填验证码 + 密码 + 昵称 → 云服务 verifyOtp（上游完成 signUp）
      → 按邮箱关联/创建轻聊账号 → 签发本地会话
登录：邮箱 + 密码 → 云服务 signInWithPassword 校验 → 按邮箱关联轻聊账号
```

**验证码**

```
点「获取验证码」→ 服务端按输入内容自动判断渠道（含 @ 走邮箱，否则按手机号）
                 → 云服务 sendOtp 发码 → 返回 verificationId 与 isExistingUser
填验证码提交   → 云服务 verifyOtp（isExistingUser=true 走登录，false 走注册）
                 → 按邮箱/手机号关联或创建轻聊账号
```

**WorkBuddy**

```
点按钮 → GET /api/auth/wb/start → 云服务生成 PKCE challenge 并返回授权地址
       → 浏览器跳转 WorkBuddy 官方授权页 → 授权后回调 /api/auth/wb/callback
       → 服务端用本地 verifier 换会话 → 按邮箱/云账号关联或创建轻聊账号
       → 302 回前端并带上本地会话令牌（?wl_token=…）
```

### 账号如何落到同一个体系

云服务只回答「**你是谁**」，轻聊的 `users` 表回答「**你是哪个账号、能看哪些房间**」。
不论从哪种方式进来，最终都落到同一张表：

| 字段 | 用途 |
|---|---|
| `authType` | `password` / `email` / `otp` / `workbuddy`，标识账号来源 |
| `email` | 邮箱方式、验证码（邮箱）方式、WorkBuddy 方式的关联键 |
| `phone` | 验证码（短信）方式的关联键 |
| `cloudId` | 云服务用户 ID，WorkBuddy 方式的首选关联键 |

关联顺序：**cloudId → email → phone**。三种都找不到时：

- 注册模式 → 自动建号
- 登录模式 → 提示「该账号尚未注册，请先切换到『注册』」

已有账号在用新方式登录时，会**补齐**缺失的 `email` / `phone` / `cloudId` 字段，
所以同一个邮箱先用验证码登录过、后来又用邮箱密码登录，会落到同一个账号。

### 服务端为什么能跑 WorkBuddy OAuth

SDK 把 PKCE verifier 存在 `globalThis.sessionStorage` 里（`WorkBuddyPkceStore.storage()` 直接读这个全局对象）。
浏览器天然有；Node 端没有，SDK 会直接报
`workbuddy sign-in requires sessionStorage ... unavailable in this runtime`。

`src/authcloud.js` 在加载时注入一个**内存版 sessionStorage**：`start` 与 `callback`
两个请求跑在同一个进程里，verifier 天然共享，语义上等价于浏览器的 sessionStorage。

### 相关文件

| 文件 | 作用 |
|---|---|
| `src/authcloud.js` | 云认证适配层（sessionStorage polyfill + 四种方式的云调用） |
| `src/db.js` | 用户模型扩展（authType / email / phone / cloudId）与查找方法 |
| `server.js` | 认证路由 + 账号关联逻辑（`linkCloudAccount`） |
| `public/app.js` | 登录页方式切换与表单编排（`syncAuthForm` / `otpInfo`） |
| `public/index.html` | 方式选择器、验证码行、WorkBuddy 按钮 |
| `test/auth.js` | 认证专项测试（38 项） |

> ⚠️ 验证码的**完整闭环**（收到邮件 / 短信 → 填码 → 登录）需要真人参与，无法自动化；
> `test/auth.js` 覆盖的是参数校验、渠道识别、路由契约、错误分支与账号模型，
> 真实闭环需人工验收。

## 消息操作：撤回 / 删除 / 直接删除

三种操作语义完全不同，界面上并排放在每条消息的操作区里：

| 操作 | 权限 | 时间窗 | 服务端发生了什么 | 其它设备看到什么 |
|---|---|---|---|---|
| **撤回** | 仅发送者本人 | **2 分钟内** | 正文清空、文件字节删除、消息标记 `recalled` | 「该消息已被撤回」占位 |
| **删除** | 房间成员 | 无限制 | **什么都不动**，只在本账号写一条隐藏记录 | 原样照常可见 |
| **直接删除** | 仅发送者本人 | **无限制** | 正文真删、文件字节真删、文件文档真删、所有人隐藏记录清空 | **同步消失**（所有设备、所有用户） |

### 为什么撤回入口不再「点不到」

**根因不在 2 分钟窗口，而在操作区从来没有被展开过。**

CSS 里写的是：

```css
.bub .tools     { display: none; }
.bub.open .tools { display: block; }   /* 需要 .open 类 */
```

但前端代码里**从来没有给气泡加过 `open` 类**，也没有任何点击处理会切换它 ——
于是 `.tools` 永远 `display:none`，「撤回 / 删除 / 直接删除」三个入口从上线起就
**一次都没显示过**。上一轮只把「撤回入口常驻 + 超窗变灰」补上治标不治本，
用户看到的仍然是「根本点不到」。

现在改为：**点击消息气泡即展开该条的操作区**，再点一次收起，同一时间只展开一条。

此外原先只在 `canRecall === true` 时才渲染撤回按钮，超过 2 分钟按钮直接消失，
用户既点不到也看不到原因。现在改成：

- 自己的消息**始终渲染撤回入口**，超窗时文案变为 `撤回·已超窗`（灰色）
- 点击超窗的撤回 → 明确提示「已超过 2 分钟撤回窗口。如需彻底清除，请点『直接删除』」
- 同时**始终提供「直接删除」**，不受任何时间窗限制

### 多选模式（微信 / QQ 式批量操作）

除了单条操作，聊天页还支持**多选**，一次处理多条消息：

| 入口 | 说明 |
|---|---|
| 顶栏「多选」按钮 | 点击进入 / 退出多选模式 |
| **长按任意消息** | 直接进入多选并选中该条（480ms 判定，与微信一致） |
| 勾选框 | 多选模式下每条消息左侧出现圆形勾选框，点击切换选中 |
| 底部「全选」 | 选中 / 取消当前已加载的全部消息 |

进入多选后，**底部输入框被操作栏取代**：

```
已选 3 条  [全选]        [删除]  [直接删除]  [取消]
```

| 批量操作 | 对应单条接口 | 服务端行为 |
|---|---|---|
| **删除** | `POST /api/messages/batch-delete` | 仅对本账号隐藏，服务端数据与文件字节原样保留，他人照常可见 |
| **直接删除** | `POST /api/messages/batch-purge` | 发送者本人可执行，服务器端真正清除，所有设备同步消失 |

**多选模式下不提供「撤回」**：撤回只能单条单条地撤（它有 2 分钟窗口的语义，
且服务端接口本身就是单条的）。退出多选后，单条撤回照常可用。

批量接口的容错规则：**逐条独立判定**，某条失败（不存在 / 无权 / 不是自己发的）
不会导致整批失败，响应里 `hidden` / `purged` 是成功列表，`failed` 是失败列表
（每项带 `reason`）。例如多选里混了别人的消息，「直接删除」会删掉自己的那几条，
别人的那几条进入 `failed`，前端提示「N 条被跳过（仅能删除自己发送的消息）」。

### 「直接删除」的跨端同步机制

服务端删除消息后不能只留个空壳，否则其它端增量拉取时无从得知「这条没了」。
实现上：

1. 服务端把消息正文清空、标记 `purged: true`、推进全局修订号 `rev`
2. 消息列表接口**不再返回该消息的任何内容**，改为单独下发 `purgedIds: [id]`
3. 其它端拉到 `purgedIds` 后，移除本机 DOM 里的副本
4. 空壳消息不含正文、不含文件名、不含文件字节，只承担同步信号

```js
// 服务端：POST /api/messages/:id/purge（批量接口复用同一个执行体）
const fileId = m.fileId;
if (fileId) {
  await files.removeBlob(fileId);   // 云端分片 / 本地磁盘，真删
  db.del('files', fileId);          // 文件文档也删掉
}
m.content = ''; m.fileId = null; m.purged = true;
m.rev = db.bumpRev();               // 推进修订号，其它端增量能拉到
db.updateMessage(m);
// 顺手清掉所有人对这条消息 / 这个文件的隐藏记录
```

前端确认弹层明确区分两个入口：

> **直接删除这条消息** · ⚠️ 此操作不可恢复 · 将从服务器端**彻底删除**这条消息，
> **所有设备、所有用户**的界面上都会立即消失。消息携带的文件会一并删除，
> 云端占用的存储空间同时释放。若只想让**自己**看不到，请改用「删除」。

测试覆盖：`test/purge.js`（37 项断言，服务端语义 + 云端落库校验）、
`test/multiselect.js`（45 项断言，批量删除 / 批量直接删除的参数校验、容错、跨端语义）、
`test/ui.js`（操作区三入口可见可点、二次确认弹层、超窗入口可见性、多选全流程）。

## 好友系统：申请加好友 + 收到的好友申请

### 1. 头像点开「申请加好友」页

任何一个头像都是资料入口，点开进入独立的用户资料页：

| 入口 | 位置 | 点击后 |
|---|---|---|
| **消息里的发送者头像** | **聊天页每条消息左侧**（公共聊天室 / 自定义房间 / 私聊通用） | 打开该发送者的资料页 |
| **房间成员面板里的头像** | **聊天页右上角 👥 → 成员管理** | 打开该成员的资料页 |
| 好友列表里的头像 | 好友 → 我的好友 | 打开该好友的资料页 |
| 申请条目里的头像 | 好友 → 收到的好友申请 | 打开申请人的资料页 |
| 搜索结果里的头像 | 好友 → 搜索用户 | 打开该用户的资料页 |

> 聊天页的头像入口对**所有房间都生效**：公共聊天室、自定义房间、私聊，
> 用的是同一套 `appendMsg()` 渲染逻辑，不需要区分房间类型。

资料页（`public/index.html` 的 `#friendAdd` 独立 section，不是弹层）展示：

- **大头像**（色块底 + 昵称首字，底色由 `id` 哈希决定，前后端同一套算法）
- 昵称 / 账号 / 注册时间
- 根据关系状态给出对应操作：

| 状态 | 页面呈现 |
|---|---|
| 自己 | 「这是你的个人资料页」 |
| 已是好友 | 「发消息」按钮 |
| 对方已申请你 | 「对方已申请添加你」+「去处理好友申请」 |
| 我已申请过 | 「申请已发送，等待对方同意」 |
| 都没申请 | **附言输入框** +「发送好友申请」 |

附言默认填「你好，我想加你为好友」，可改，最长 200 字。

### 2. 「收到的好友申请」列表

好友页第一张卡片就是收到的申请，每条包含：

- **申请人头像**（可点击看资料）
- 昵称 + 账号徽章
- **附言**（没填时显示「（未填写附言）」）
- **申请时间**（相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前，超过 30 天显示具体日期）
- 「同意」「拒绝」两个按钮

同意 → 服务端把双方写入好友索引 → **申请条目消失、好友列表实时刷新**；
拒绝 → 该条申请从列表移除，双方仍不是好友。

空列表显示「暂无收到的好友申请」，另有「我发出的请求」「我的好友」两张卡片，
各自的空状态分别是「暂无发出的好友请求」「还没有好友，搜索添加一个吧」。

### 3. 实时更新

- 切进好友页时主动拉一次 `/api/friends`（不只看缓存）
- 好友页每 5 秒轮询一次，只有数据指纹变化才重绘（不闪动）
- 离开好友页 / 页面卸载时 `clearInterval`，不留后台空转

```js
// 数据指纹：三个列表的 id 拼起来
function friendSig(friends, incoming, outgoing) {
  function ids(a, key) {
    var r = [];
    for (var i = 0; i < a.length; i++) r.push(a[i][key] || a[i].id);
    return r.join(',');
  }
  return ids(friends || [], 'id') + '|' + ids(incoming || [], 'id') + '|' + ids(outgoing || [], 'id');
}
```

### 4. 修掉的一个真 bug：好友关系本来不是双向的

`friendIdx` 一条记录里 `k1=fromId、k2=toId`（见 `src/db.js` 的 `meta()`），
而 `addFriend(fromId, toId)` 的顺序取决于**谁先发起申请**。
原来的 `friendsOf()` 只按 `k1` 查，于是：

- 申请发起方 → 能看到对方是好友 ✅
- 被加的那个人 → **看不到对方是好友** ❌

现在 `friendsOf()` 两个方向都查并按 id 去重，双方看到的才是同一份好友列表：

```js
friendsOf(userId) {
  const seen = {};
  const out = [];
  const push = (list) => {
    for (let i = 0; i < list.length; i++) {
      const id = list[i].id;
      if (seen[id]) continue;
      seen[id] = true;
      out.push(list[i]);
    }
  };
  push(this.byIdx('friendIdx', 'k1', userId));
  push(this.byIdx('friendIdx', 'k2', userId));
  return out;
}
```

### 5. 相关接口

| 接口 | 说明 |
|---|---|
| `GET /api/users/:id` | 用户资料 + 好友关系状态（`friend` / `requested` / `received` / `self`），**不下发邮箱** |
| `GET /api/friends` | 好友、收到的申请（含附言、头像、时间）、发出的申请 |
| `POST /api/friends/request` | 发送申请，body 可带 `message`（附言，截断 200 字） |
| `POST /api/friends/:id/accept` | 同意 → 建立双向好友关系 |
| `POST /api/friends/:id/reject` | 拒绝 |

测试覆盖：`test/friend.js`（65 项断言，资料接口 / 附言落库 / 双向关系 / 权限 / 空状态）、
`test/ui.js`（好友页渲染、头像点击进资料页、同意后实时刷新、空状态、
**聊天页点头像 → 资料页 → 发申请 → 返回回聊天页**）。

### 6. 修掉的一个真 bug：聊天页点头像「点了没反应」

**现象**：在公共聊天室 / 自定义房间里点消息头像，页面像是没反应。

**根因**：`main` / `chat` / `friendAdd` 三个 `.screen` 区块在文档流里**上下排布**，
而原来的 `openProfile()` 只把 `#main` 隐藏掉，**没隐藏 `#chat`**：

```js
// 修之前
$('main').className = 'screen hide';
$('friendAdd').className = 'screen';   // ← #chat 还挡在前面
```

于是从聊天页进来时，聊天页仍然占着屏幕，资料页被顶到**屏幕外看不见** ——
表现为「点了头像什么也没发生」（只在搜索结果 / 好友页点头像才正常，因为那两个入口不经过 `#chat`）。

**修法**：

1. 打开资料页时**同时**隐藏 `#main` 和 `#chat`；
2. 记录来源 `S.profileFrom`（`'chat'` / `'main'`），返回时回到原场景，
   而不是一律跳回主界面；
3. 「去处理好友申请」按钮改走 `gotoFriendsFromProfile()`，无论从哪进来都回主界面。

```js
function openProfile(userId) {
  if (!userId) return;
  api('GET', '/api/users/' + encodeURIComponent(userId), null, function (err, data) {
    if (err) { toast(err.message); return; }
    S.profile = data;
    var chat = $('chat');
    var fromChat = !!(chat && chat.className.indexOf('hide') < 0);
    S.profileFrom = fromChat ? 'chat' : 'main';   // 记住来源，返回时原路返回
    $('faTitle').textContent = data.self ? '我的资料' : '用户资料';
    $('main').className = 'screen hide';
    if (chat) chat.className = 'screen hide chat-screen';   // ← 关键：同时隐藏聊天页
    $('friendAdd').className = 'screen';
    renderProfile();
  });
}
```

### 7. 房间成员面板也能点头像

聊天页右上角 👥 → 成员管理，原先是纯文字列表（没有头像，也点不了）。
现在每个成员前面有头像色块，点开就是对方的资料页，同样能发好友申请：

- 服务端 `GET /api/rooms/:id/members` 补 `avatarColor` / `initial` 字段
- 前端成员列表改为**真实 DOM 构建**（不再是 innerHTML 字符串），头像直接绑事件
- 弹层 `openModal()` 支持传入 DOM 节点（字符串仍兼容）

### 8. 修掉的一个测试脆弱点：主题测试会随机失败

`test/theme.js` 原来用「跨度 > 60 秒」来识别「跨越阈值」的主题定时器。
但阈值固定在**整点**，当测试恰好跑在整点前 1 分钟内时，
离下一个阈值只有几十秒 → 被误判成「没排期」→ **测试随机失败**
（本地单独跑通过、放进云端 suite 就失败，正是这个原因）。

**修法**（两处）：

1. 测试用**固定时钟**（`2026-01-15 10:30`），与真实墙上时间彻底解耦；
2. 定时器识别改为「未被清理 + 跨度 >= 1 秒」，并排除 toast / 滚动这类固定时长任务。

新增 `tools/verify-theme-determinism.js`：把固定时钟换成
「整点前 1 分钟」「整点前 59 秒」「23:59:59」「00:00:00」等极端时刻逐一跑一遍，
确认全部稳定通过。

## 中文编码与数据健壮性

这两处是好友系统上线后实测暴露并修掉的问题，一并记在 README 里，避免以后再踩。

### 1. 前端显式 UTF-8 字节（中文昵称乱码）

**现象**：注册/发消息时中文昵称变成 `鑒谶饔鑿` 这类乱码。

**根因**：老 WebView（Android 4.4 / 5.x 的 Chromium 内核）在 `XMLHttpRequest.send(字符串)`
时按**本地编码**（GBK）转字节，而不是 UTF-8。同一段 `JSON.stringify` 结果，
在 Chrome 上是对的，在红米 Note 2 上就是乱码。

**修复**：`public/app.js` 里手写 `utf8Bytes(str)`，把 JS 字符串按 UTF-8 编成 `Uint8Array`
再发送，服务端收到的就是标准 UTF-8 字节：

```js
function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) { out.push(c); }
    else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      // 高低代理对 → 4 字节（emoji）
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
               0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return new Uint8Array(out);
}
// api() 里：
xhr.send(utf8Bytes(JSON.stringify(body)));
```

`test/ui.js` 里有 6 组逐字节比对断言（含 emoji 与代理对），
保证这段手写编码与标准 UTF-8 **完全等价**，不是"差不多能用"。

### 2. 云端 doc 类型自愈（一条脏数据拖垮整条路由）

**现象**：`GET /api/users` 报 `Cannot read properties of undefined (reading 'includes')`，
整个用户列表接口 500。

**根因**：云端 `docs` 表的 `doc` 列，历史上有一条记录被写成了 **JSON 字符串**而不是对象
（早期直接 `database.from('docs').update({ doc: JSON.stringify(d) })` 所致）。
`src/cloud.js` 的 `load()` 原样把字符串塞进内存镜像，于是 `db.list('users')` 返回的是字符串，
`u.usernameLower` 自然取不到。

**修复**：`load()` 增加 `normalizeDoc()` —— 字符串就尝试 `JSON.parse`，成功则按对象用，
失败则原样保留（**不让一条坏数据把整个进程带崩**），并在日志里提示修复条数：

```js
normalizeDoc(raw) {
  if (typeof raw !== 'string') return raw;
  const s = raw.trim();
  if (!s) return raw;
  if (s.charAt(0) !== '{' && s.charAt(0) !== '[') return raw;
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (e) { /* 不是合法 JSON，保留原值 */ }
  return raw;
}
```

配套的 `tools/clean-cloud-final.js` 做体检 + 精确清理 + 一致性修复：

- 按「**用户已不存在**」而非「模糊前缀」判定垃圾数据，避免误伤真实账号；
- 一并清理孤儿会话、成员、隐藏墓碑，以及指向已删消息的悬挂墓碑；
- 补建「`status='accepted'` 但 `friendIdx` 丢了」的好友关系，让数据自洽；
- 真实用户（刘子墨、爱吃榴莲的蘑菇）及其消息 / 文件 / 隐藏记录**一律不动**。

## 设置页（本地数据管理）

入口：`我的 → ⚙️ 设置`。三功能全部落地，前端只负责编排，**存储类操作由原生桥完成**
（浏览器环境下自动降级为 Web API 实现）。

| 功能 | 行为 | 降级路径 |
|---|---|---|
| **清除缓存** | 统计并释放本机缓存占用；实测 WebView `app_webview/Cache` 由 60KB → 4KB，显示 39.0 KB → 0 B | 无原生桥时清 `Cache Storage` + 一次性本地键 |
| **清除聊天记录** | **只清本机**：服务端一条不动，其它设备/用户照常看到 | 纯网页环境同样生效（写本机水位 + 清 localStorage） |
| **自定义下载路径** | 选任意目录存 PPT 等文件；默认系统 `Downloads` | 四档降级 → 应用私有目录，并明示实际路径 |

### 「仅影响本地数据」的实现：全局隐藏水位

服务端 `rev` 是**全局单调递增**的修订号（`meta/seq` 计数器），因此**不需要为每条消息记 ID**，
只要本机记住一个「隐藏水位」即可精确表达「这些消息在我这台机器上不显示了」：

```
localStorage['ll_hidden_rev'] = 本机隐藏的最大 rev
```

拉取/渲染时统一走 `appendMsg()` 入口过滤：

```js
var rev = m.rev || m.seq || 0;
bumpSeenRev(rev);
if (rev && rev <= S.hiddenRev) return null;   // 本机已隐藏 → 不渲染，服务端数据不动
```

清除本地聊天记录时，把各房间当前最大 `seq` 取 max 写入该水位，再清掉本地聊天键、
内存态与 HTTP 缓存。**服务端数据一条不删**，所以另一台设备重新拉取时消息照常出现。

### 二次确认

「清除聊天记录」走**两层独立确认**（第一层正文含 `⚠️ 此操作仅影响本地数据`，
第二层标题「再次确认」），任一层取消都不产生任何写入。

---



权限按古代官职命名，逐级递减：

| 官职 | 等级 | 可任命 | 人数上限 | 管理能力 |
|---|---|---|---|---|
| 群主 | 4 | 丞相 / 县令 / 乡长 | 每级 3 人 | 禁言、踢出全部下级 |
| 丞相（管理员） | 3 | 县令 | 2 人 | 禁言、踢出下级 |
| 县令（小管理员） | 2 | 乡长 | 2 人 | 禁言、踢出下级 |
| 乡长 | 1 | — | — | 禁言、踢出百姓 |
| 百姓 | 0 | — | — | — |

规则：
- 只能任命**级别低于自己**的人，不能任命同级或更高级
- 每个官职的任命数量**按任命人分别计数**（群主设 3 位丞相后，某位丞相仍可再设 2 位县令）
- 支持**降级调整**：上级可把下属或同级的职级调低一档（如把丞相降为县令），不受"可任命职级"限制
- 禁言可设置时长（5 分钟 ~ 7 天），被禁言者仍可读取消息
- 踢出后立即失去成员身份，但历史消息保留
- 管理能力按职级递减：乡长可禁言/踢出百姓，但不能动县令及以上

## 版本号：线上实时同步，APK 不用跟着换

**问题**：APK 是纯 WebView 壳，前端代码全在线上。如果版本号写死在 APK 里，
线上更新了好几轮之后，设置页仍显示旧版本号 —— 看着像很久没更新，实际跑的是最新代码。

**做法**：版本号不写死在任何一端，而是由**服务端实时下发**。

```
version.json（项目根目录，唯一来源）
   ├── GET /api/version ──→ 设置页「关于」每次打开都重新拉
   └── android/app/build.gradle 打包时读取 → versionCode / versionName
```

设置页「关于」展示：

- `v1.4.3` + 「当前线上版本」徽章
- **构建号** `#xxxxxxxx`：由 `version.json + app.js + style.css` 的内容算 SHA-1 前 10 位
- 版本代号、发布日期、本次更新说明
- 一行提示：「划掉后台重新打开即可看到最新版本，无需更换安装包」

构建号是关键：即使忘了手动改 `version.json` 的语义版本号，**只要部署过任何改动它就会变**，
用户一眼就能看出"线上已经不是刚才那份代码了"。接口带 `no-store`，浏览器/WebView 不会把版本号缓存成旧值。

`GET /api/version` 无需登录、不含任何用户数据；响应里的 `serverTime` 是服务端当前时间。

### 每次更新必做（维护约定）

**每次版本更新，除了改 `version.json`，必须同步往 `changelog.json` 的 `releases`
数组开头追加一条记录**（版本号 / code / 日期 / changes 列表：本次新增了什么、修了什么 bug）。
应用内「我的 / 关于 → 历史更新记录」按钮读的就是这份文件——它是唯一数据源，
只存一份、平时不显示，漏加就等于用户在更新记录里看不到这一版。
`changelog.json` 里的 `contact` 字段是开发者联系邮箱（显示在设置/关于页）。

> 构建指纹用固定的相对标签（`version.json` / `public/app.js` / `public/style.css`）参与哈希，
> 不用 `path.relative()` —— Windows 是反斜杠、Linux 是正斜杠，会让同一份代码算出不同构建号。

### 产物命名策略（近期固定）

| 项 | 取值 |
|---|---|
| APK 产物 | `轻聊.apk`（**不带版本号后缀**） |
| 电脑端产物 | `desktop/轻聊.exe`（**不带版本号后缀**） |
| 应用名 | 轻聊 |
| 版本号展示位置 | **仅应用内「设置 → 关于」**，由线上 `/api/version` 实时下发 |

历史带版本号的 APK 已移到 `dist/archive/`，不再作为交付物。
`android/app/build.gradle` 里用 `applicationVariants` 把 release 输出名固定为 `轻聊.apk`。

**近期不改变这套策略**，仍按老式手机应用场景处理：常规更新只改线上内容 → 部署 → 生效，
不因为版本调整或线上内容变更重新构建 APK / exe。只有改原生层
（Android Java、权限、图标、`strings.xml` 里的站点地址、桌面启动器 C++ 源码）才重新构建产物。

未来若发生版本号策略变更或应用大改版，产物可能重新加上版本号 —— 但**近期不做**。
**暂不实现恢复旧版本功能。**

## 电脑端（Windows 桌面启动器）

`desktop/轻聊.exe`，MinGW-w64 编译，**44 KB**。

设计上刻意保持「网站应用」定位：**纯壳，不内嵌任何前端代码、不捆绑 Chromium、不本地存业务数据**。
启动时查找系统已安装的 Edge / Chrome，用 `--app=<线上地址>` 打开独立应用窗口
（无地址栏/标签栏、任务栏可固定），并用 `%LOCALAPPDATA%\QingLiaoDesktop` 独立 profile 隔离会话。

```
desktop/
├── main.cpp        # 启动器源码（Win32 / Unicode，零第三方依赖）
├── resources.rc    # 图标资源
├── favicon.ico     # 从 public/ 复制，6 尺寸
├── rename_exe.py   # Unicode 文件名处理（.bat 在中文 Windows 下按 ANSI 解析会乱码）
├── build.bat       # 一键构建（需 g++ / windres / python 在 PATH）
└── 轻聊.exe        # 产物：无版本号后缀
```

关键取舍：

- **不捆绑浏览器**：Win10/11 自带 Edge，包体只有 APK 的一半不到，冷启动就是启动浏览器，
  没有 Electron 那种 200MB+ 运行时初始化开销
- **单实例**：命名互斥体 + 隐藏宿主窗口，重复双击只把已有窗口调到前台，不抢同一个 profile
- **兜底**：没找到 Edge/Chrome 时用系统默认浏览器打开普通标签页，功能仍完整
- **线上更新即时生效**：exe 里只有站点 URL 一个常量，前端代码全在线上；
  网站改功能不需要重建 exe，用户重开窗口就是新版

> 构建脚本全程 ASCII：`.bat` 在中文 Windows 下会按本地 ANSI 代码页解析，
> 中文注释/文件名会被弄乱，所以中文文件名由 `rename_exe.py` 用 Unicode API 写入。

## 发布验收（红米 Note 2）

**每次发布必做**，完整清单见 [`docs/红米Note2发布验收清单.md`](docs/红米Note2发布验收清单.md)。

```bash
node tools/release-acceptance.js   # 自动化部分；报告写入 docs/last-release-acceptance.json
node tools/clean-cloud-final.js    # 清理验收注册的临时账号
```

自动化部分（`CPU 4x 降速 + Regular 3G` 模拟红米 Note 2 级别硬件）：

- 产物命名不带版本号、应用名不带版本号
- 入口页 `no-store`、前端资源内容指纹、`/api/version` 实时版本
- 首屏 FCP / DCL / load、接口 P50、首屏可交互
- 跨账号消息同步、好友申请实时到达

本次实测：FCP **932ms**、load **1022ms**、接口 P50 **156ms**、同步往返 **341ms**，自动化 17/17 通过。

**真机 6 项必须由人在红米 Note 2 上确认**（脚本不能代跑）：冷启动不卡顿、滑动/切页流畅、
点击响应快、跨设备信息同步、深浅主题切换、挂后台回前台补齐消息。任一不达标则本次发布不算通过。

## 主题系统：手动 / 时间 / 跟随系统

三种模式**共用同一套 CSS 变量**，模式只决定「用哪一套变量」，样式实现只有一份。
配色全部从 `style.css` 的硬编码值抽成变量，两套主题变量名完全一致。

### 主题属性如何挂载到根元素

```html
<html lang="zh-CN" data-theme="light">   <!-- 或 data-theme="dark" -->
```

- `:root` → 浅色变量（默认值）
- `[data-theme="dark"]` → 深蓝夜间变量

选择器刻意用 `[data-theme="dark"]` 而不是 `html[data-theme="dark"]`：
写在 `<html>` 上是整站切换，写在任意容器上则**只影响该容器**（变量可继承），
便于同页并排对比两套主题。两者特异性同为 `(0,1,0)`，深色块在文件里靠后 → 覆盖生效。

### 三种模式与切换逻辑

| 模式 | `ll_theme_mode` | 判定依据 | 变化来源 |
|---|---|---|---|
| **跟随系统** | `system` | `prefers-color-scheme: dark` | 系统切换时 `matchMedia` 的 `change` 事件实时同步 |
| **按时间** | `time` | 本机小时是否落在 `[日间开始, 夜间开始)` | 排「跨越阈值」定时器，到点自动切换 |
| **手动** | `manual` | 用户选的 `ll_theme_pref`（`light`/`dark`） | 用户点击后立即生效 |

JS 关键点（`public/app.js` 顶部 `Theme` 模块）：

```js
// 1) 判定：三种模式收敛成一个 resolve()
function themeResolve() {
  if (Theme.mode === 'manual') return Theme.pref;
  if (Theme.mode === 'time') {
    return themeIsDay(new Date().getHours(), Theme.dayStart, Theme.nightStart) ? 'light' : 'dark';
  }
  return themeSystemDark() ? 'dark' : 'light';
}

// 2) 落地：写根元素属性 + 同步浏览器 UI 颜色
document.documentElement.setAttribute('data-theme', Theme.current);
document.querySelector('meta[name="theme-color"]').setAttribute('content', ...);

// 3) 时间模式排期：主题只在「日间开始 / 夜间开始」两个整点变化，
//    取今天与明天这四个时刻里最近的一个还没到的
Theme.timer = setTimeout(function () { Theme.timer = null; themeRefresh(); }, ms + 500);

// 4) 定时器清理：切换模式时先 clearTimeout 再重排；
//    页面卸载（pagehide / beforeunload）也清理，visibilitychange 回到前台再核对一次
```

### 首次访问不闪白

`index.html` 的 `<head>` 里有一段**内联引导脚本**，位置在 `<link rel="stylesheet">` **之前**：
样式表生效之前就把 `data-theme` 与 `theme-color` 写好，因此不会出现「先浅色闪一下再变深色」。
该脚本的判定逻辑与 `app.js` 保持一致（同一套 mode/pref/time 键）。

### 持久化键

| 键 | 值 | 说明 |
|---|---|---|
| `ll_theme_mode` | `system` / `time` / `manual` | 首次访问缺省为 `system`，首次进入即显式落盘 |
| `ll_theme_pref` | `light` / `dark` | 手动模式下用户的选择 |
| `ll_theme_time` | `{"d":7,"n":18}` | 时间模式的日间 / 夜间起始小时（0-23） |

三个键都加入 `KEEP_LOCAL_KEYS` → 「清除聊天记录」不会把主题偏好一起清掉。

### Android 端的系统深浅色

红米 Note 2 这类老设备的 WebView 可能不支持 `prefers-color-scheme`，
所以原生侧额外补了一条通道：

| 环节 | 做法 |
|---|---|
| 首屏 | 加载地址附带 `sys=dark|light`（`MainActivity.withSystemTheme`），站点的引导脚本据此定主题 → **首屏就是对的，不闪白** |
| 运行期 | 系统切换深色主题时 `onConfigurationChanged` 调 `window.__qlSystemTheme('dark')` → 站点「跟随系统」模式即时生效 |
| 容器底色 | `values-night/colors.xml` 提供深色 `window_bg` / `web_bg`；WebView 背景改为读 `@color/web_bg`，页面 CSS 生效前不再闪白 |
| 状态栏 | `values-night-v21/themes.xml` 把状态栏染成深蓝 `#131d30`，与深色顶栏一致 |

站点的 `app.js` 与 `index.html` 引导脚本共用同一套判定键，
并且都认 `sys` 参数 —— 保证「首屏判定」与「运行期判定」不会打架。

### 入口

- **顶栏快捷按钮**：主界面右上角 `🌙 / ☀️`，点击弹层直接选三种模式，并显示当前生效主题
- **设置页「外观 · 主题」卡片**：三模式选择 + 当前生效状态 + 手动深浅 + 时间阈值（两个下拉）
- **「我的」页**：额外一行显示当前主题（例：`🎨 外观 · 当前主题：深色（跟随系统）`）

### 全部 CSS 变量

两套主题共用同一批变量名（`test/theme.js` 会断言两边的变量集合完全一致）。

| 变量 | 浅色 `:root` | 深色 `[data-theme=dark]` | 用途 |
|---|---|---|---|
| `--bg` | `#f2f3f5` | `#0d1524` | 页面底色 |
| `--surface` | `#ffffff` | `#151f33` | 卡片 / 气泡 / 输入框 / 弹层底色 |
| `--surface-2` | `#fafbfc` | `#1b2740` | 卡片头 / 次级面 |
| `--surface-3` | `#f6f8fa` | `#22304e` | 按下 / 悬浮态 |
| `--surface-4` | `#eef0f2` | `#18233a` | 标签条 / 次要按钮底 |
| `--fg` | `#1f2328` | `#bac9e9` | 正文 |
| `--fg-2` | `#57606a` | `#9aadd3` | 次级文字 |
| `--fg-3` | `#8b949e` | `#7b90ba` | 弱化文字 |
| `--fg-4` | `#9aa1a9` | `#6d81ab` | 时间戳 |
| `--fg-5` | `#a0a6ad` | `#63769e` | 空态 |
| `--ph` | `#8b949e` | `#6d81ab` | 占位符 |
| `--border` | `#e3e6ea` | `#24324f` | 主描边 |
| `--border-2` | `#f0f2f4` | `#1d2841` | 行分隔线 |
| `--border-3` | `#d0d7de` | `#30426a` | 输入框描边 |
| `--border-4` | `#eef0f2` | `#202c47` | 操作区分隔线 |
| `--accent` | `#1f6feb` | `#5b9dff` | 主色 |
| `--accent-2` | `#1a5fd0` | `#3d84f2` | 主色按下 |
| `--accent-soft` | `#eaf2ff` | `#1b2c4a` | 主色浅底 |
| `--accent-soft-border` | `#c3d9ff` | `#2b4470` | 主色浅底描边 |
| `--accent-ring` | `rgba(31,111,235,.35)` | `rgba(91,157,255,.45)` | 展开描边 |
| `--on-accent` | `#ffffff` | `#06101f` | 主色上的文字 |
| `--danger` | `#d1242f` | `#ff8a80` | 危险文字 |
| `--danger-2` | `#a40e26` | `#e05c52` | 危险按钮按下 |
| `--warn` | `#bc4c00` | `#e0ac63` | 警告文字 |
| `--topbar-bg` / `--topbar-fg` | `#1f6feb` / `#ffffff` | `#131d30` / `#c6d5f2` | 顶栏 |
| `--tabbar-bg` | `#ffffff` | `#131d30` | 底部导航 |
| `--bubble` / `--bubble-mine` | `#ffffff` / `#d6e6ff` | `#19233a` / `#1e3055` | 气泡底色 |
| `--bubble-fg` / `--bubble-who` / `--bubble-meta` | `#1f2328` / `#8b949e` / `#9aa1a9` | `#bac9e9` / `#7b90ba` / `#6d81ab` | 气泡内文字 |
| `--av-fg` | `#ffffff` | `#dde8fb` | 头像文字 |
| `--pick-bg` / `--pick-border` / `--pick-on` | `#ffffff` / `#c4c9d0` / `#1f6feb` | `#19233a` / `#3c4d75` / `#5b9dff` | 多选勾选框 |
| `--up-bg` / `--up-fg` / `--up-track` / `--up-fill` | `#fff8e6` / `#8a6d3b` / `#f0e2c0` / `#d29922` | `#1b2740` / `#a7bbdd` / `#2a3a5c` / `#5b9dff` | 上传进度条 |
| `--toast-bg` / `--toast-fg` | `rgba(24,26,30,.92)` / `#ffffff` | `rgba(14,24,42,.95)` / `#c6d5f2` | 轻提示 |
| `--badge-bg` / `--badge-fg` | `#eef3ff` / `#1f6feb` | `#1b2c4a` / `#8fb8ff` | 徽章 |
| `--badge-gray-bg` / `--badge-gray-fg` | `#f0f2f4` / `#57606a` | `#1e2a42` / `#9aadd3` | 灰色徽章 |
| `--badge-warn-bg` / `--badge-warn-fg` | `#fff1e5` / `#bc4c00` | `#332d22` / `#e0b072` | 警告徽章 |
| `--role-0..4-bg` / `--role-0..4-fg` | 五级职衔原色 | 五级低饱和深色 | 职衔标签 |
| `--link` / `--link-hover` | `#1f6feb` / `#1a5fd0` | `#7fb2ff` / `#a6caff` | 链接与悬停 |
| `--code-bg` / `--code-fg` / `--code-border` | `#f6f8fa` / `#1f2328` / `#e3e6ea` | `#1b2740` / `#b9c9e8` / `#2a3a5c` | 代码块 / 行内代码 |
| `--quote-bg` / `--quote-border` / `--quote-fg` | `#fafbfc` / `#d0d7de` / `#57606a` | `#18233a` / `#30426a` / `#9aadd3` | 引用块 |
| `--table-head-bg` / `--table-border` / `--table-stripe` / `--table-hover` | `#fafbfc` / `#e3e6ea` / `#f6f8fa` / `#eef0f2` | `#1b2740` / `#24324f` / `#18233a` / `#22304e` | 表格 |
| `--img-bg` / `--img-border` | `#f2f3f5` / `#e3e6ea` | `#18233a` / `#2a3a5c` | 图片 / 头像容器 |
| `--shadow` / `--overlay` | `rgba(0,0,0,.18)` / `rgba(0,0,0,.45)` | `rgba(0,0,0,.55)` / `rgba(3,8,18,.66)` | 阴影 / 弹层遮罩 |
| `--scrollbar-thumb` / `--scrollbar-thumb-hover` / `--scrollbar-track` | `#c9ced4` / `#a8afb8` / `transparent` | `#34456a` / `#46598a` / `#131d30` | 滚动条 |

深色模式额外一条规则：危险按钮改成「淡描边 + 轻底」，
避免大块实色红在深蓝背景上发刺：

```css
[data-theme="dark"] .btn.danger {
  background: rgba(232,120,110,.15);
  color: #f0928a;
  border: 1px solid rgba(232,120,110,.5);
}
```

## 目录结构

```
chatapp/
├── version.json      # 版本号唯一来源（网站「关于」+ Android build.gradle 共用）
├── start.js          # 启动器（Node 版本自适应）
├── server.js         # HTTP 服务 + 全部 API 路由 + 存储后端选择
├── src/
│   ├── cloud.js      # 云服务适配层（CloudStore + LLM 封装）
│   ├── store.js      # 本地存储层：SQLite 优先，JSON 兜底
│   ├── db.js         # 数据模型与集合读写（用户模型含 authType/email/phone/cloudId）
│   ├── authcloud.js  # 云认证适配层：sessionStorage polyfill + 四种登录方式
│   ├── filestore.js  # 分片存储、断点续传、Range 流式读取
│   ├── blobstore.js  # 文件二进制在云库的块存取（file_blobs 表）
│   └── util.js       # 密码哈希、ID、工具函数
├── public/
│   ├── index.html    # 单页界面（含设置页、用户资料 / 申请加好友页）
│   ├── app.js        # 前端逻辑（ES5 语法 + XHR，兼容老内核）
│   ├── style.css     # 移动端样式
│   ├── favicon.ico   # 浏览器标签页图标（6 档尺寸），桌面 exe 复用
│   ├── favicon-*.png # 16 / 32 / 192 / 512 PNG 图标
│   ├── apple-touch-icon.png # iOS 主屏图标
│   ├── logo.png      # 登录页展示图
│   └── manifest.webmanifest # PWA 清单
├── desktop/          # Windows 桌面启动器（纯壳，读取线上站点）
│   ├── main.cpp      # Win32 / Unicode 源码，零第三方依赖
│   ├── resources.rc  # 图标资源
│   ├── rename_exe.py # Unicode 文件名处理
│   ├── build.bat     # 一键构建
│   └── 轻聊.exe      # 产物（无版本号）
├── dist/archive/     # 历史带版本号 APK，仅归档，不作为交付物
├── 轻聊.apk          # 当前 Android 产物（无版本号）
├── test/
│   ├── e2e.js            # 8 项需求全量测试（75 项断言）
│   ├── e2e2.js           # 房间流程 / 分片续传 / Range 测试（33 项）
│   ├── sync.js           # 多端同步与持久化测试（14 项）
│   ├── roles.js          # 职级任命 / 降级调整 / 上限测试（19 项）
│   ├── auth.js           # 四种登录 / 注册方式专项测试（38 项）
│   ├── purge.js          # 撤回 / 删除 / 直接删除语义专项（37 项）
│   ├── multiselect.js    # 多选批量操作专项（45 项：批量删除 / 批量直接删除）
│   ├── theme.js          # 主题模式专项（36 项：三模式判定 / 持久化 / 定时器 / 变量表 / 原生桥）
│   ├── friend.js         # 好友系统专项（65 项：资料接口 / 附言 / 双向关系 / 权限 / 空状态）
│   ├── cache.js          # 静态资源缓存专项（16 项：内容指纹 / 部署即生效 / no-store）
│   ├── version.js        # 线上版本信息专项（23 项：版本接口 / 构建指纹 / 单一数据源）
│   ├── json-fallback.js  # JSON 兜底存储专项（34 项）
│   └── ui.js             # 前端逻辑测试（模拟 DOM 驱动真实脚本，含设置页、消息操作区、多选流程、好友申请流程）
├── tools/
│   ├── cloud-verify.js   # 云服务端到端验证（含跨进程持久化）
│   ├── cloud-reset.js    # 云端数据清空（预览 / --yes 执行）
│   ├── live-file-probe.js # 线上环境文件上传/下载连通性探测
│   ├── live-friend-verify.js # 线上好友系统闭环验证（31 项：注册 → 申请 → 同意 → 双向 → 权限）
│   ├── live-chat-avatar-verify.js # 线上聊天头像入口专项（44 项：公共聊天室 / 自定义房间 / 成员面板）
│   ├── shot-chat-avatar.js   # 线上视觉终检（headless Chrome + CDP：点头像 → 资料页 → 返回）
│   ├── verify-theme-determinism.js # 主题测试确定性验证（把固定时钟换成极端时刻逐一跑）
│   ├── clean-cloud-final.js # 云端体检 + 精确清理 + 好友关系一致性修复（DRY=1 只预览）
│   ├── clean-dangling-hidden.js # 清理指向已删消息/文件的隐藏墓碑
│   ├── fix-cloud-nickname.js # 历史乱码昵称修复 + doc 类型规范化
│   ├── repro-cross-instance.js # 跨实例复现脚本
│   ├── gen_icons.py    # 应用图标生成脚本（矢量重绘 → 全套 PNG / ico / mipmap）
│   ├── release-acceptance.js # 发布验收（自动化部分：低端模拟性能 / 同步 / 产物命名）
│   └── run-suite.js      # 测试编排器（cloud / local 两种后端）
├── docs/
│   ├── 红米Note2适配方案.md      # 目标机型适配方案、实测数据、关键取舍、模块结构
│   ├── 红米Note2发布验收清单.md  # 每次发布必做：自动化项 + 真机 6 项
│   └── last-release-acceptance.json # 最近一次验收报告（脚本生成）
└── data/                 # 运行时生成：app.db + uploads/（云端异常时的兜底）
```

## 测试

```bash
npm test                        # 本地后端：398 项断言全部通过
node tools/run-suite.js cloud   # 云端后端：401 项断言全部通过
node tools/run-suite.js local   # 本地后端基线对照：398 项
node tools/cloud-verify.js      # 云服务专项：19 项（含进程被杀后数据不丢）
node tools/cloud-reset.js       # 云端数据清空（不带 --yes 时只预览范围）
node tools/live-friend-verify.js # 线上闭环：31 项（注册 → 带附言申请 → 同意 → 双向 → 权限）
node tools/live-chat-avatar-verify.js # 线上聊天头像入口：44 项（公共聊天室 / 自定义房间 / 成员面板）
node tools/shot-chat-avatar.js  # 线上视觉终检：headless Chrome 驱动真实站点，产出三张截图
node tools/verify-theme-determinism.js # 主题测试确定性：极端时刻逐一跑，确认不再随机失败
node tools/release-acceptance.js # 发布验收：低端模拟性能 / 信息同步 / 产物命名（每次发布必跑）
node tools/clean-cloud-final.js # 云端体检 + 清理（DRY=1 只预览，不写入）
```

云端比本地多 3 项断言（云端多一条「账号唯一可查」，`test/purge.js` 多 2 条云端落库校验），
行为完全一致。认证专项 `test/auth.js` 两端各 38 项。
线上闭环 `tools/live-friend-verify.js` 31 项全部通过（直连已发布域名，走网关握手拿会话）。
线上聊天头像专项 `tools/live-chat-avatar-verify.js` 44 项全部通过。

> 线上验证会注册 `la*` / `lb*` / `lc*` 前缀的临时账号，跑完请用
> `node tools/clean-cloud-final.js` 清理；真实用户的数据不会被脚本碰到。

沙箱若为旧 Node（无 `node:sqlite`），自动降级为 JSON 存储，功能完全一致，
已用 `test/json-fallback.js` 单独验证（34 项）。

## 移动端适配要点

- **ES5 语法 + XMLHttpRequest**：不使用 fetch / async-await / 可选链，兼容老内核
- **不用 flex `gap`**：旧版 Chromium 不支持，改用 margin
- **图片懒加载**（`loading="lazy"`）、视频 `preload="none"`，避免一次性解码占内存
- **增量轮询**：2.5 秒拉一次，仅取 `rev` 之后的新增/变更，回合轻量
- **安全区适配**：`env(safe-area-inset-bottom)` 兼容刘海屏

## 应用图标

界面内的功能图标（📎👥多选等）继续用 Unicode 字符，零请求；
但**应用本身的标识**（浏览器标签页、手机桌面、PWA）用位图资源：

| 文件 | 用途 |
|---|---|
| `public/favicon.ico` | 浏览器标签页（16/32/48/64/128/256 六档） |
| `public/favicon-16.png`、`favicon-32.png` | 浏览器标签页（现代浏览器优先取 PNG） |
| `public/favicon-192.png`、`favicon-512.png` | PWA manifest 图标（`any` + `maskable`） |
| `public/apple-touch-icon.png` | iOS 添加到主屏（180×180） |
| `public/logo.png` | 登录页顶部展示（96×96） |
| `public/manifest.webmanifest` | PWA 清单：名称、独立窗口、主题色 |

图标矢量：`tools/gen_icons.py` 按实测几何重绘（3 个圆角方块 `#2688FF` + 1 个圆形 `#74B6FF`，
2×2 排布），4 倍超采样后 LANCZOS 降采样，16px→512px 全尺寸清晰。改颜色或形状只需改该脚本的常量。

```bash
python tools/gen_icons.py   # 重新生成 public/ 与 android/ 下的全部图标
```

### Android 启动图标

- `mipmap-{m,h,xh,xxh,xxxh}dpi/ic_launcher.png`（48→192px）：深色圆角方块底
- `mipmap-*/ic_launcher_round.png`：圆形版本（`roundIcon`）
- `mipmap-anydpi-v26/ic_launcher.xml`：Android 8.0+ 自适应图标
  - 背景 `@color/ic_launcher_background` = `#262626`
  - 前景 `drawable/ic_launcher_foreground.xml` 是矢量标志，收在中心 60×60 安全区内，
    圆形 / 方形 / squircle 遮罩下都不会被裁掉

## 部署

服务监听 `PORT` 环境变量，绑定 `0.0.0.0`，单端口即可发布：

```bash
PORT=3000 node start.js
```

数据默认写入 `data/`（可用 `DATA_DIR` 覆盖）。部署到临时文件系统时需挂载持久卷，否则重启会丢数据。

**发布到公网时**：云后端默认开启，业务数据落云数据库，不依赖容器磁盘；
文件二进制在云端模式下同样落云库（`file_blobs` 表），仅本地留读缓存。
若强制 `STORAGE_BACKEND=local`，则文件二进制写入 `DATA_DIR/uploads`，
临时文件系统上会随重启丢失，生产环境需把 `DATA_DIR` 指向持久卷。

发布域名变更时，必须同步设置 `PUBLIC_ORIGIN` 为新的对外域名 ——
数据平面按 Origin 精确匹配，域名不符会被拒绝（403 `access_denied`）。

### 常规发布流程（不重新构建产物）

```bash
# 1. 改线上前端/服务端代码（或只改 version.json 的更新说明）
# 2. 部署线上站点
# 3. 跑发布验收（自动化部分）
node tools/release-acceptance.js
# 4. 在红米 Note 2 真机上按清单确认 6 项
#    见 docs/红米Note2发布验收清单.md
# 5. 清理验收临时账号
node tools/clean-cloud-final.js
```

**APK / exe 都不需要重新构建**：两者都是纯壳，前端代码全在线上；
入口页 `no-store` + 静态资源内容指纹保证用户重开即拉到最新代码。
只有改原生层（Android Java / 权限 / 图标 / 站点地址、桌面启动器 C++）才重新构建产物。

> 站点地址若变更，需同步改 `android/.../strings.xml` 的 `app_url`
> 与 `desktop/main.cpp` 的 `kAppUrl` —— 这种情况才需要出新包。

## 安全说明

- 密码使用 scrypt 加盐哈希，数据库中不存明文
- 会话 token 存储于服务端，支持登出立即失效
- 消息内容使用 `textContent` 渲染，前端无 `innerHTML` 注入点
- 文件访问支持独立令牌，便于 `<img>` / `<video>` 直接引用
- 撤回会物理删除文件数据，磁盘不留副本
- 云端表的 RLS 策略按应用维度放行（`docs_*_all`），因为数据访问全部经服务端鉴权，
  客户端不持有 publishableKey，也不直连数据平面
