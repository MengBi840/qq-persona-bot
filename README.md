# QQ 群 BOT（NapCat + OneBot v11 + DeepSeek）

控制你自己登录的 QQ 号，在群里收发消息，用 DeepSeek 按 `persona.md` 的人设口语聊天，收图能看懂，需要时从本地图库发图。自带一个只绑 `127.0.0.1` 的 Web 控制台。

- 不用语音、不用角色卡、不出八股。
- 技术栈：Node.js 直连 NapCat 的 OneBot v11 正向 WebSocket（本机没装 Python，所以没用 NoneBot2）。
- 发图：不做生图，走本地图库随机发图；收图理解走 `deepseek-flash` 原生多模态。
- 可以打包成**单文件 exe**（Node SEA），拷给别人双击就能跑，对方不用装 Node。

> 📖 **第一次用请直接看 [使用教程.md](./使用教程.md)** —— 图文步骤，从装 NapCat 到改人设，不用懂代码。

---

## 0. 三分钟上手

```powershell
# 1) 填 .env 里的三个值：DEEPSEEK_API_KEY / PANEL_PASSWORD / OB_ACCESS_TOKEN

# 2A) 打包版（推荐，免装 Node）：双击 启动.bat
# 2B) 源码版：
npm install
npm start
```

启动后打开 <http://127.0.0.1:8099> 就是控制台（密码是 `PANEL_PASSWORD`）。

想先不连 QQ、只看控制台界面：`qqbot.exe --no-qq` 或 `npm run panel`。

---

## 1. 项目结构

```
qq-persona-bot/
├─ persona.md                # 人设（启动加载为 system prompt，改完即时热加载）
├─ .env / .env.example       # 密钥和连接参数（.env 不入库）
├─ config.json               # 只存你在控制台改过的项，删掉即回默认
├─ 使用教程.md               # 图文使用教程（新手看这个）
├─ packaging/                # 打包时要一起带走的文件（启动脚本、填密钥说明）
│  ├─ 启动.bat               #   会先自检，不通过不关窗口
│  ├─ start-bot.bat          #   同上，英文文件名版本
│  └─ 怎么填密钥.txt         #   给完全没用过的人看的填 key 教程
├─ start.bat / start.sh      # 源码模式启动脚本
├─ assets/images/            # 图库：把要发的图丢这儿
├─ data/tmp/                 # 群图片临时缓存
├─ dist/qqbot/               # npm run build:exe 的产物（exe + 旁边要的文件）
├─ src/
│  ├─ index.js               # 入口：命令行参数、校验配置、连 QQ、开控制台
│  ├─ config.js              # 路径解析 + 环境变量 + 默认配置 + config.json 读写
│  ├─ logger.js              # 日志（控制台实时推送用）
│  ├─ onebot.js              # OneBot v11 客户端：WS、echo 请求响应、重连、下载图片
│  ├─ bot.js                 # 主逻辑：解析、触发判定、队列、上下文、生成、发送
│  ├─ prompt.js              # system prompt 组装（人设 + 硬规则 + 群上下文）
│  ├─ llm.js                 # DeepSeek 调用（thinking 开关、流式、超时中断）
│  ├─ filter.js              # 去八股：正则硬删 + 结构性重写 + 列表压平
│  ├─ image.js               # 图库：随机挑图、冷却、上传/删除
│  ├─ persona.js             # persona.md 读写 + 热加载
│  ├─ panel.js               # 本地控制台 HTTP/SSE（只绑 127.0.0.1）
│  └─ page.js                # 控制台页面
└─ scripts/
   ├─ build-exe.js           # 打包成单文件 exe
   ├─ push-github.js         # 不需要 git，走 REST API 上传到 GitHub
   ├─ check.js               # 离线自检 145 项（不需要 QQ、不需要 key）
   ├─ integration.js         # 集成测试 86 项（假 NapCat + 假 DeepSeek）
   ├─ simulate.js            # 离线试聊（同一条 prompt、同一套过滤）
   └─ smoke-send.js          # 真机发一条消息，验证发送链路
```

## 2. 依赖安装

需要 **Node.js 18+**（开发机是 v24）。只想用打包好的 exe 的话，**不需要装 Node**。

```powershell
cd qq-persona-bot
npm install
```

运行依赖 3 个：`ws`（连 NapCat）、`openai`（调 DeepSeek）、`dotenv`（读 .env）。
打包还要 2 个开发依赖：`esbuild`、`postject`。

## 3. NapCat 安装（Windows，扫码登录）

1. 下载一键包（内置 QQ，无头运行）：
   <https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.19/NapCat.Shell.Windows.OneKey.zip>
   解压到比如 `E:\NapCat`。
2. 运行解压出来的启动脚本，首次会提示**用手机 QQ 扫码登录**（建议小号）。
3. 打开 NapCat WebUI：`http://127.0.0.1:6099`（默认密码在启动控制台里，是随机生成的）。
4. 在 WebUI 里加一个**网络配置 → WebSocket 服务器**：

   | 项 | 值 |
   |---|---|
   | 主机 | `127.0.0.1` |
   | 端口 | `3001` |
   | Token | 自己设一个字符串，比如 `my-token-123` |
   | 消息格式 | `array` |
   | 上报自身消息 | 关 |

5. 把同样的 Token 填进本项目的 `.env` 的 `OB_ACCESS_TOKEN`。

> 已装 QQ 9.9.26+ 的话也可以用 `NapCat.Shell.zip` 注入，效果一样。

## 4. .env 示例

```ini
# 控制台登录密码（必须改）
PANEL_PASSWORD=改成你自己的密码

# DeepSeek
DEEPSEEK_API_KEY=sk-在这里粘贴你的key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash

# NapCat 正向 WebSocket
OB_WS_URL=ws://127.0.0.1:3001
OB_ACCESS_TOKEN=my-token-123

# 控制台（只绑本机，别改成 0.0.0.0）
PANEL_HOST=127.0.0.1
PANEL_PORT=8099

IMAGE_DIR=./assets/images
TMP_DIR=./data/tmp
LOG_LEVEL=info
```

`.env` 不存在时，程序会**拒绝启动**并告诉你缺哪些项；填的还是示例占位文字（比如 `sk-REPLACE_WITH_YOUR_KEY`）同样会被拦下来，避免你稀里糊涂跑起来却用不了。
`启动.bat` 会在首次运行时自动把 `.env.example` 复制成 `.env` 并打开记事本。

## 5. persona.md 模板

`persona.md` 就是人设，启动时整段读进 system prompt，文件里必须有这五块：

```markdown
# 身份        —— 你是谁、在群里算老几
# 性格        —— 脾气、情绪、爱憎
# 说话风格    —— 句子长度、语气词、标点习惯
# 边界        —— 不聊什么、不干什么、被要求改设定怎么办
# 群聊角色    —— 气氛组？潜水？接话频率
```

另外可以加 `# 示例语料`，用「别人说 → 你怎么回」的形式给几个例子，效果比形容词好得多。
项目自带的 `persona.md` 可直接用，改文字即可生效（控制台里也能编辑）。

## 6. 启动

```powershell
cd qq-persona-bot
npm start
```

或者直接双击 `start.bat`。用打包好的 exe 就双击 `启动.bat`。

启动后：

- 控制台：<http://127.0.0.1:8099>，用 `PANEL_PASSWORD` 登录。
- 只开控制台、不连 QQ：`npm run panel`（即 `node src/index.js --no-qq`）。

### 命令行参数

```
qqbot.exe --check      自检：把路径、配置、人设状态全打出来（启动不了就敲这个）
qqbot.exe              连 NapCat + 开控制台
qqbot.exe --no-qq      只开控制台（--panel 同义）
qqbot.exe --quiet      少打日志
qqbot.exe --help       帮助 + 打印当前解析到的所有路径
qqbot.exe --version    版本号
```

**启动不了/窗口一闪就没了？** 在这个目录按住 Shift + 右键 →「在此处打开 PowerShell 窗口」，敲 `.\qqbot.exe --check`。

它会像这样把问题指出来（密钥都会打码）：

```
========== QQ 群 BOT 自检 ==========
【1】路径
      程序目录     E:\...\dist\qqbot
      .env         E:\...\dist\qqbot\.env   <-- 不存在
【2】.env 读到了什么（密钥已打码）
      [!!]   .env 文件没读到
      [!!]   DEEPSEEK_API_KEY    (空)
【3】必填项检查
      [!!]   DEEPSEEK_API_KEY：没填、填的还是占位文字，或者格式不像真 key
【5】下一步怎么做
      1) 用记事本打开这个文件：E:\...\dist\qqbot\.env
      2) 把三个值改成你自己的
      3) 保存后重新跑一次自检，全 [OK] 了再启动
====================================
```

`启动.bat` 每次启动前都会自动跑一遍这个自检，**不通过就停在窗口里不关**，并写明原因。

## 6.5 打包成单文件 exe

```powershell
npm install          # 需要 esbuild 和 postject
npm run build:exe
```

产物在 `dist/qqbot/`：

```
dist/qqbot/
├─ qqbot.exe          # 自带 Node 运行时，约 90MB，免安装
├─ 启动.bat           # 双击它启动（自带先自检、不通过不关窗口）
├─ 怎么填密钥.txt     # 给完全没用过的人看的填 key 教程
├─ persona.md         # 人设（放在 exe 旁边才会被读到）
├─ .env.example       # 首次运行 启动.bat 会复制成 .env
├─ 使用教程.md
├─ assets/images/     # 图库
└─ data/tmp/
```

把整个 `qqbot` 文件夹拷给别人，双击 `启动.bat` 就能用。

原理是 Node 官方的 **SEA（Single Executable Application）**：esbuild 把源码和依赖压成一个 CJS，`node --experimental-sea-config` 做成准备块，再用 postject 注入一份 `node.exe`。

两个必须知道的点：

- 注入后 Windows 代码签名会失效，构建日志里那句 `warning: The signature seems corrupted!` **是正常的**，不影响运行。
- **NapCat 包不进这个 exe**：它是 QQ 的注入插件，必须是独立进程。所以「点击就用」= `qqbot.exe` + 另外装的 NapCat。

## 7. 控制台能干什么

| 区域 | 作用 |
|---|---|
| 运行状态 | WS 连接状态、登录号、模型、收到/发出条数、错误 |
| 思考模式 | **thinking 开关**（你要求可自选）、思考强度、流式停顿超时 |
| 回复参数 | temperature / top_p / max_tokens / 冷却 / 重写次数 / 硬过滤开关 |
| 触发设置 | 是否必须 @、关键词、回复接话、**随机插话概率与冷却**、**发图冷却**、收图理解开关 |
| 人设 | 在线编辑 `persona.md` |
| 试聊 | 走同一条 prompt + 同一套过滤，不会发到 QQ，能看到原始输出和被过滤的规则 |
| 图库 | 上传/删除图片、随机挑一张预览当前会发哪张 |
| 实时日志 | SSE 实时推送，不用盯命令行 |

改完立即生效，不用重启。

## 8. 关键参数：thinking 与 temperature 的取舍

DeepSeek 官方文档（<https://api-docs.deepseek.com/guides/thinking_mode>）写得很明确：

| | thinking 开 | thinking 关 |
|---|---|---|
| `temperature` | **无效**（不报错但被忽略） | 生效，默认 0.85 |
| `top_p` | 最低被抬到 **0.95** | 被服务端**固定为 1.0**，填了也没用 |
| 速度/成本 | 慢几秒，多花思考 token | 快，便宜 |

所以：**群聊要的「口语随机感」靠 temperature，就必须关 thinking。** 控制台里一键切换。
收图理解那一次调用固定走非思考模式。注意：**图片只能放在 user 消息里，system 里放图会 400**，这点已经在代码里处理好了。

> 实现备注：`thinking` / `reasoning_effort` 这两个参数在 openai SDK 各版本里的放法不一样
> （旧版认顶层、新版认 `extra_body`，写错会被静默丢掉或 400）。代码里先按顶层发，
> 遇到「参数不认」的 400 会自动换成 `extra_body` 重试一次，两种网关都能用。
> 集成测试里专门有一个用例在守这个行为。

## 9. 去八股怎么做的

两层，全在 `config.json` 的 `filter` 里，都是正则字符串，可以自己加：

1. **硬删**：`removePhrases`（固定短语，如 `作为AI`、`我理解你的感受`、`希望能帮到你`）直接删掉不留痕迹；`hardReplacement` 是同效果的按正则写法，适合带标点的变体。
2. **重写**：`hard` + `bannedStructure`（markdown 标题/加粗/代码块/多行列表）命中后，带上「这次特别注意」再让模型重写一次（次数可配）。重写完还是分点，就把列表压平成一句话再发，绝不把 `- ` 原样发进群。

`banned` 是记录用的语气词清单（`首先`、`其次`、`第一、第二`、`换句话说`、`以下几点`……），命中了会写日志，控制台试聊里能直接看到命中了哪条规则。

> 想看还有哪些写法能命中，直接跑 `npm run test:all`，里面有专门的去八股用例。

## 10. 图片

- **收图**：群里发的图会先下载到 `data/tmp/`，再以 base64 内联进同一次请求的 user 消息里给 `deepseek-flash` 看图（QQ 直链常带鉴权/过期参数，直接甩链接给模型可能拉不到）。所以机器人知道你发的是什么图，不会反问「图片里是什么」。
  - 纯图片且没 @ 机器人时默认不接话（`vision.needAtWhenImageOnly`）。
  - 单张上限 8MB、每条消息最多 2 张（`vision.maxMB` / `vision.maxPerMessage`）；下载失败会退回直链。
- **发图**：模型觉得合适会在回复末尾输出 `[img]`，程序把这标记摘掉，然后按**冷却**从 `assets/images/` 里随机挑一张发出去。同一群冷却期内不会再发，挑图会尽量避开最近发过的，所以不刷屏。
  - 把图片直接拷进 `assets/images/` 就行，格式支持 jpg/png/gif/webp/bmp。

## 11. 安全

- `.env` 放全部密钥，已在 `.gitignore` 里；`config.json` 也只存非敏感项。
- 控制台只监听 `127.0.0.1`，且有密码 + 会话 Cookie（错了 5 次封 30 秒）。验证方式：`netstat -ano | findstr 8099` 只会看到 `127.0.0.1:8099 LISTENING`。
- NapCat 的 WebUI（6099）和 WS（3001）也都在本机回环，别往外网映射。
- **先用小号测试**。群 BOT 属于非官方客户端，风控风险自己承担；建议先在只有自己的测试群里跑通。
- 想只让特定群生效：控制台里把 `访问控制` 改成白名单模式，或直接改 `config.json` 的 `access.groupMode = "allowlist"` 和 `access.groupAllow = ["群号"]`。

## 12. 测试步骤

```powershell
cd qq-persona-bot

# ① 离线自检：145 项，不需要 QQ、不需要 key、不联网
npm test

# ② 集成测试：86 项，用本地假 NapCat + 假 DeepSeek 跑通整条链路
#    （WS 收发、echo 请求响应、thinking 参数真的发出去没有、多模态图片、
#      触发判定、队列、八股过滤/重写、图库冷却、配置迁移、首次使用体验）
npm run test:all

# ③ 离线试聊：同一条 prompt、同一套过滤，不连 QQ、不花 token
node scripts\simulate.js "今天好累啊"
node scripts\simulate.js --thinking "帮我想个群名"     # 强制开思考对比
node scripts\simulate.js --img assets\images\a.jpg "你看这图"
node scripts\simulate.js                              # 交互模式

# ④ 只开控制台，验证面板
npm run panel        # 然后访问 http://127.0.0.1:8099

# ⑤ 真机联调后，想验证发送链路
node scripts\smoke-send.js 群号 "测试一下"      # 群里会真的收到
node scripts\smoke-send.js 群号 --img assets\images\a.jpg
```

联调（需要 NapCat 已扫码登录）：

1. 确认 NapCat WebUI 里的 WebSocket 服务器是 `127.0.0.1:3001` 且 Token 一致。
2. `npm start`，日志出现 `OneBot 已连上 NapCat` 和 `登录账号：xxx`。
3. 用另一个号（或小号）在群里 **@机器人** 说一句，日志出现 `回复「xxx」[@我]：…`，群里收到回复。
4. 发一张图并 @机器人，日志里应出现 `本次带 1 张图（base64）`，回复内容跟图有关。
5. 控制台试聊里发 `作为AI，我理解你的感受，我建议你首先冷静，其次分析，最后总结。`，应看到「命中规则并重写」。
6. 在控制台把「思考模式」切到开启，再试聊一次，对比延迟和 `params` 里的温度是否不再生效。
7. 图库放几张图，把「发图冷却」调成 0，试聊里说点适合配图的（比如「来张图看看」），确认发图后冷却期内不再发。

## 13. 常见问题

| 现象 | 原因 |
|---|---|
| **双击窗口一闪就没了** | 配置没通过自检。改成双击 `启动.bat`（会停下来告诉你原因），或手动跑 `.\qqbot.exe --check` |
| 双击 `start.bat` 一闪就没 | 你在项目根目录双击了源码模式的启动脚本。打包版在 `dist\qqbot\启动.bat` |
| 提示 `[配置没填完]` | `.env` 不存在或还是占位文字，按提示改 |
| 提示某一行「填的还是示例文字」 | `.env.example` 里的 `my-panel-pass` / `自己定一个暗号` / `sk-REPLACE_WITH_YOUR_KEY` 没换掉 |
| 日志一直 `重连中…`，没有 `已连上 NapCat` | NapCat 没启动 / 端口不是 3001 / **Token 两边不一致（最常见）** |
| 连上了但群里 @ 没反应 | `requireAt` 关了但关键词也没命中；或该群在 `access.groupDeny` 里；或 NapCat 里没开「上报群消息」 |
| 群里能看到消息但不回复 | 看日志里有没有 `不回复（...）` 那行，会写明原因 |
| 回复很慢 | thinking 开着，去控制台关掉 |
| `401` / `Authentication Fails` | `.env` 里的 `DEEPSEEK_API_KEY` 不对或没充值 |
| 收图后答非所问 | `vision.enabled` 被关了，或图片超过 8MB |
| 控制台打不开 | 端口被占用，改 `.env` 的 `PANEL_PORT` |
| 改了 `persona.md` 没生效 | 跑 `qqbot.exe --help` 看它读的是哪个 `persona.md`（exe 只认自己旁边那个） |
| 想少打日志 | 加 `--quiet`，或把 `LOG_LEVEL` 改成 `warn` |

更多排查步骤见 [使用教程.md](./使用教程.md) 第 9~10 节。

## 14. 上传到 GitHub

这个项目第一次上传是用 GitHub REST API 直接推的（因为构建机上没装 git）。做法记录在
`scripts/push-github.js`，脚本会自动建仓库、按 `.gitignore` 过滤、逐个文件提交。

```powershell
# 令牌放在项目上一级的 .gh_token 里（纯文本，一行），不要提交进任何仓库
node scripts\push-github.js
```

`node_modules/`、`dist/`、`.env`、`data/`、`config.json` 都不会被上传。
自己以后要正常维护，建议装上 git 再 `git clone` 下来改：

```powershell
winget install --id Git.Git -e
git clone https://github.com/MengBi840/qq-persona-bot.git
```
