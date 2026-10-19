# pi-bili-scroll

Pi 包：**每天替你刷一轮 B 站** —— 搜视频、**逐条读字幕原文**判断、把值得的写成一份 Markdown 日报。

判据只有一句话：**值不值得占用你一次注意力。**

> 这是把 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)（DSH 插件）的思路，按 Pi 的机制重做的一版：
> 命令 + 判据 skill + 自带的 B 站 MCP 声明，**装一个包就能用**。

## 装

```bash
pi install /workspace/projects/pi-bili-scroll     # 本地路径（开发中）
pi install git:github.com/<you>/pi-bili-scroll    # 或从 git
```

装完**重启一次 Pi**（包资源要重新发现）。

### 前置

| 前置 | 说明 |
|---|---|
| `pi-mcp-adapter` | 包清单里的 `pi.mcp` 由 adapter 加载。**没装 adapter 时不会报错，但 B 站服务器不会连上** |
| Node ≥ 20 | MCP 服务器用 `node` 直跑（**不用 npx**，原因见下） |
| 服务器副本 | 一次性装一份到持久卷，见「准备服务器」 |
| B 站登录 | **必须你本人扫码**，见下 |

### 登录（现在扩展自己会做）

凭证存在 `~/.bilibili-mcp/config.json`。**扫码这件事扩展能代办**（见下），Agent 仍然不该、也不会向你索要 Cookie。

#### 方式一：让扩展生成二维码（推荐）

```
/bili-login
```

或直接说「登录 B 站」。扩展会：
1. 向 B站申请登录二维码；
2. 渲染成 PNG 存到 `downloads/bili-login-qr-<时间戳>.png`（权限 600），并**把路径告诉你**；
3. 你用手机 B站 App 扫码并确认（**选「记住我 / 长期」**）；
4. 确认后扩展写入凭证，并**自动删除二维码图片**；失效的二维码同样会被清理。

用工具调也行：`bili_login_start` → 轮询 `bili_login_status`。

#### 方式二：命令行（无扩展时的备选）

```bash
CLI=~/.local/share/bili-scroll/mcp/node_modules/@xzxzzx/bilibili-mcp/dist/cli.js
node "$CLI" setup     # 需要真终端；无 TTY 环境会拒绝画二维码
node "$CLI" check     # 确认凭证已加载
```

> 这条命令是**交互式**的，必须有真终端 —— 容器里一般没有，所以日常请用方式一。

### 准备服务器（一次性）

```bash
mkdir -p ~/.local/share/bili-scroll/mcp && cd ~/.local/share/bili-scroll/mcp
npm init -y >/dev/null
npm install --save-exact @xzxzzx/bilibili-mcp@1.14.3 --ignore-scripts
```

装到 `~/.local/share/bili-scroll/mcp/`（`pi-runtime` 卷，容器重建不丢），路径已写进 `mcp.json`。

> ⚠️ **为什么不用 `npx`**：该包 `cli.js` 用 `fileURLToPath(import.meta.url) === process.argv[1]`
> 判定主入口；Node 会把 `import.meta.url` 解析成**真实路径**，而经 `npx` / `.bin` 启动时
> `process.argv[1]` 是**符号链接路径**，两者不等 ⇒ 主入口不执行、**静默退出 0**。
> 已实测：`npx -y pkg` 无任何输出；`node <真实 cli.js>` 正常完成握手并返回 12 个工具。
> 有测试守着这一条（断言清单里不出现 `npx`）。

### 服务器能力

一共 **12 个工具，全部只读**：搜视频、读字幕/转写、读评论、视频概况/元数据/章节、
搜 UP 主、UP 主内容、收藏夹、登录状态。**没有发评论/私信/上传/发动态**（服务器自身设计如此），
所以「刷完 @ 我一下」本版做不到。

重连后让我调一次 `check_bilibili_credentials`，只有 `configured: true` 且 `logged_in: true` 才算成。

## 用

```
/bili-scroll            # 刷一轮（默认）
/bili-scroll status     # 家目录、今天刷过没有、当前配置
/bili-scroll help       # 用法
```

`/bili-scroll` 会把值班章程整段交给**当前会话**执行：搜 → 读字幕 → 读评论 → 判断 → 写日报。
日报落在 `~/.local/share/bili-scroll/out/<YYYY-MM-DD>.md`。

也可以什么都不敲，直接说「按 bili-scroll 的判据刷一轮」。

会话启动时，如果今天还没刷过，它会**提示一句**（只提示，不自动跑 —— 自动跑会在你没打算的时候消耗额度）。

## 配置（可选）

`~/.local/share/bili-scroll/config.json`（不存在就用默认值）：

```json
{
  "enabled": true,
  "keywords": ["AI Agent", "编程"],
  "perDay": 5,
  "reportDetail": "brief",
  "notifyOnStart": true,
  "workdir": null
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后 `/bili-scroll` 会拒绝跑，也不再提示 |
| `keywords` | `[]` | 关注关键词；空数组 = 用内置那几组 |
| `perDay` | `5` | 每天最多挑几条 |
| `reportDetail` | `"brief"` | `full` / `brief` / `none` |
| `notifyOnStart` | `true` | 会话开始提示"今天还没刷" |
| `workdir` | `null` | 人设目录：扩展会读 `<workdir>/AGENTS.md` 并**内联进提示词**；`null` = 按中性语气 |

### 人设（角色）

角色有**两个入口、一份文本**：

| 入口 | 用法 | 作用范围 |
|---|---|---|
| pi prompt 模板 `/bili` | 敲 `/bili 看看 BV1xxx 值不值得看` | 当前会话，按角色回答 |
| 巡检自动注入 | `/bili-scroll` 自动带上 | 只影响那一轮 |

文本放在 **pi 的标准位置**：`~/.pi/agent/prompts/bili.md`（带 frontmatter，同时是 `/bili` 命令）。
扩展通过软链读同一份：

```
~/.local/share/bili-scroll/persona/AGENTS.md  →  ~/.pi/agent/prompts/bili.md
config.json: { "workdir": "/home/node/.local/share/bili-scroll/persona" }
```

**改那一份，两个入口同时生效**，不用动代码、不用重装。扩展读的时候会自动剥掉
YAML frontmatter（那是给命令补全看的，不该进提示词正文）。

**扩展会把这份文件读进来内联**，不是只把路径丢给模型 —— 只给路径等于赌模型会不会去看，
实测常被忽略（设了人设但语气没变就是这个原因）。文件超过 16 KB 会截断并如实标注。

包内自带一份可直接用的初版角色（B 站内容编辑：默认不信标题、优先一手、宁可少一条）。
想调语气就改这个文件，**不用动代码、不用重装**。

字段类型不对时**逐字段回退到默认值**并在提示里说明，不会因为一个坏字段整体失效。

家目录可用环境变量 `BILI_SCROLL_HOME` 覆盖（测试与非默认部署用）。

## 写能力（发评论）

除了只读的 `@xzxzzx/bilibili-mcp`，本包还 vendor 了
[AGI_Ananas/bilibili-mcp](https://github.com/adoresever/bilibili-mcp)（MIT）作为第二个 MCP 服务器，
但**用白名单只放出 `bili_reply` 一个工具**（发评论/回复楼中楼）——那份实现原本有 27 个工具，
包含投稿、私信、发动态，全部挡在名单外：名单外的工具**连名字都不出现在 `list_tools` 里**。

准备它（一次性）：

```bash
node scripts/setup-mcp-write.mjs
```

会在 `~/.local/share/bili-scroll/mcp-write/` 建独立 venv 并装依赖（`mcp` 锁 `<2`）。

**写操作默认直接执行**（`config.confirmWrites: false`）——因为定时巡检跑的是 `pi -p`（无 UI），
逐次确认会让它永远发不出去。想恢复确认就把 `confirmWrites` 设成 `true`。

无论开关如何，**每次写操作都会记进 `~/.local/share/bili-scroll/writes.log`**
（时间 / 工具 / 参数摘要），事后可查"它到底发了什么"。

**发评论另有代码限额**（`src/quota.ts`，超了直接拒，不给例外）：

| 配置项 | 默认 | 含义 |
|---|---|---|
| `maxCommentsPerDay` | 3 | 每天最多几条 |
| `minMinutesBetweenComments` | 30 | 两条之间至少隔几分钟 |
| `sameVideoCooldownDays` | 7 | 同一视频 N 天内只评一次 |

**读取也有上限**（同样写在代码里，见 `src/readlimit.ts`）：

| 配置项 | 默认 | 含义 |
|---|---|---|
| `maxReadsPerRound` | 10 | 一轮内搜索/字幕/评论/元数据的次数上限 |
| `maxHeavyReadsPerRound` | 2 | 一轮内 `watch-video`/`debrief`（下载+抽帧）次数上限 |

为什么读也要限：2026-10-19 实测，一天内 100+ 次读取就撞了 B站 **412 风控**，
而那个只读服务器会把 412 误报成"无效响应"——很难看出是限流。

状态在 `comment-quota.json`（原子写、600、只留 30 天）。要放宽就改数字——没有"临时豁免"接口，
有例外口子就等于没有限额。

## 定时巡检（自己写的调度器）

容器里**没有 cron / systemd**，所以这里带了一个常驻调度进程，行为照搬鲸鱼的生物钟：

```bash
/bili-daemon start      # 拉起守护进程
/bili-daemon status     # 看进程、今日计划、报告、日志
/bili-daemon stop
```

- **窗口内随机时刻**（不是固定点），配置在 `~/.local/share/bili-scroll/schedule.json`
- **`skipChance`**：每次做计划独立掷骰子，0.3 表示 30% 概率"今天不想看"
- **计划落盘**（`schedule-state.json`），进程重启不会重复跑
- **补跑**：过了计划时刻一小时、今天仍没报告 → 补一次
- 到点执行 `pi -p "按 bili-scroll 判据刷一轮"`（detached，不阻塞循环）

⚠️ **容器重启后进程会丢**，需要重新 `/bili-daemon start` —— 这是没有 init 系统的环境限制。

⚠️ **时区**：容器实测是 `Etc/UTC`，而窗口按**使用者时区**解释，配置项 `"timezone"`（默认
`Asia/Shanghai`）。这点很关键——不设的话，写 `20:00–22:00` 会在北京时间凌晨 4 点跑。
实现上用 `Intl.DateTimeFormat` 显式指定时区，不依赖容器 `TZ`。

```json
// ~/.local/share/bili-scroll/schedule.json
{
  "enabled": true,
  "windows": [{ "start": "20:00", "end": "22:00", "wakes": 1 }],
  "skipChance": 0.3,
  "maxWakesPerDay": 2,
  "tickSeconds": 60,
  "catchUp": true,
  "command": ["pi", "-p", "按 bili-scroll 判据刷一轮"]
}
```

### 推送到 Telegram

到点触发后会把摘要推给你。**token 不进仓库**，写在本地：

```json
// ~/.local/share/bili-scroll/notify.json  （建议 chmod 600）
{ "telegram": { "token": "<bot token>", "chatId": "<你的 chat id>" } }
```

没配置时静默跳过，不会报错。`chatId` 的拿法：先和 bot 说句话，再
`curl "https://api.telegram.org/bot<token>/getUpdates"` 找 `message.chat.id`。

## 全功能工具集（vendor 自 dsh-bili-whale）

除了上面的巡检命令行，本包还 vendor 了
[`Alterssss/dsh-bili-whale`](https://github.com/Alterssss/dsh-bili-whale)（MIT）的整套工具（**46 个命令**），
通过一个工具暴露：`bili_whale({ command, args })`。

准备（一次性，把凭证接过来）：

```bash
node scripts/setup-whale.mjs     # 建 ~/.bili-ai/credentials.json → 我们凭证的软链
```

| 类别 | 命令 |
|---|---|
| 读 | `session` `thread` `search` `subtitles` `video` `debrief` `watch-video` `feed` `quota` `diary` `likes` `deps` `covers` `whois` `comment-digest` `check-comment` `check-dynamic` `check-mention` `recon` `watch` `comment-await` |
| 写（需确认） | `comment` `comment-del` `dm` `dynamic` `dynamic-image` `dynamic-edit` `danmaku` `reply-draft` `await` `dm-await` |

最值得说的两条：

- **`watch-video <BV> [3x3\|4x4]`** —— 真"看"画面：取直链 → 下载 → ffmpeg 按等间隔骨架 + 画面变化点抽帧 → 拼九宫格，交给模型看图。**需要 ffmpeg**（见下）。
- **`debrief <BV>`** —— 一条龙读懂：封面 + 简介 + 官方字幕 + 弹幕热区 + 热评 + 抽帧。

### 装 ffmpeg（只有抽帧要它）

容器里没有 root，用静态构建放到持久卷：

```bash
curl -sL -o /tmp/ff.tar.xz https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz
tar -xJf /tmp/ff.tar.xz -C /tmp
mkdir -p ~/.local/share/bili-scroll/bin
cp /tmp/ffmpeg-*/bin/ffmpeg ~/.local/share/bili-scroll/bin/ && chmod +x ~/.local/share/bili-scroll/bin/ffmpeg
ln -sfn ~/.local/share/bili-scroll/bin/ffmpeg ~/.local/bin/ffmpeg
```

装完跑 `bili_whale deps` 复检，四项应全绿。

## 它不做什么

| 不做 | 原因 |
|---|---|
| 自动发评论（"刷完 @ 我一下"） | 能发，但**必须你点头**：发评论拿你的号公开发布、不可撤回，所以不做成一键自动 |
| 私信 / 投稿 / 发动态 | vendored 那份有这些工具，但白名单没放。要放开需自己改 `BILI_MCP_TOOLS` 并承担风险 |
| **到点自动刷** | Pi 是按次启动的 CLI/TUI，不是常驻服务 —— 没有常驻进程就没有定时器。要真自动，得起外部 cron 跑 `pi -p "按 bili-scroll 判据刷一轮"` |
| **设置面板 UI** | Pi 没有 DSH 那种 web 设置页，配置走上面的 JSON |

## 验证

```bash
npm run check     # typecheck + 28 个测试
```

覆盖范围：

- **真实资源加载器**（`DefaultResourceLoader`）：命令与工具注册成功、状态工具声明为只读、**加载期不产生任何文件**
- **包清单发现路径**：按 `packages: [本包]` 加载时，扩展和 `bili-scroll` skill 都被认到
- **请求构造**：`reportDetail: none` 时不出现日报路径与写文件指令（曾经自相矛盾）
- **等待一轮结束**：先空后忙、已在运行、始终没起来时按超时兜底
- **配置容错**：坏字段逐项回退而不整体失效

另外两条只在真机上才能验，不在测试里：MCP 服务器能否连上（需 adapter + `npx`）、
B 站登录是否有效（需你本人扫码）。

## 交互与无 UI 模式

- 交互 / RPC：所有提示走 UI 通知；`/bili-scroll` 发起后**不阻塞输入**
- print / JSON（`pi -p`）：提示改走 **stderr**（不污染 stdout 的机器可读输出），
  并**等这一轮真的跑完**才返回，不会把巡检拦腰截断
- 模型正在回复时敲 `/bili-scroll`：按 `followUp` 排队，不会报「already processing」

## 许可

本项目以 **MIT License** 开源，全文见 [LICENSE](./LICENSE)。商业使用、修改、再分发都可以，
保留版权与许可声明即可。

```
SPDX-License-Identifier: MIT
Copyright (c) 2026 swordfate3
```

### 第三方归属

| 组件 | 许可 | 用途 |
|---|---|---|
| [`@xzxzzx/bilibili-mcp`](https://github.com/XZXZZX-Ai/bilibili-mcp) | Apache-2.0 | B 站读取能力（搜索/字幕/评论/元数据等 12 个只读工具）。**不在本仓库内分发**，由使用方自行安装，本包只在 `mcp.json` 里声明如何启动它 |
| 思路来源 [`dsh-bili-scroll`](https://github.com/c1overzz/dsh-bili-scroll) | MIT | 「值不值得占用一次注意力」的判据与日报形态。本仓库是按 Pi 机制重写，未复制其代码 |

本包自身只做「什么时候刷、按什么判据挑、日报写哪」这一层。
