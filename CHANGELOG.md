# Changelog

本文件记录**每个版本改了什么**（给人看，不是给机器看）。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本：
`feat` → MINOR，`fix` → PATCH，不兼容改动 → MAJOR。

> 设计取舍写在 [`DECISIONS.md`](./DECISIONS.md)，用法写在 [`README.md`](./README.md)，
> 这里只回答一个问题：**这一版和上一版差在哪。**

## [1.4.3] — 2026-10-19

### 新增
- `summarizeReport()`：把日报 Markdown 压成适合推送的纯文本（条数、标题、BV、为什么值得），
  超长自动截断。给 Telegram 推送和将来的其他通道复用。

### 修复
- **摘要把 `### 附注` 当成了一条视频**：原来按"任意 `###`"切块，而日报里除了
  `### BV…` 还有 `### 附注` 小节——实测推出去的消息多了一条"附注"。
  现在只认 `### BV…` 这一种标题（与插件计数口径一致），并补了三条用例。

## [1.4.2] — 2026-10-19

### 修复
- **同一天会跑两轮**：`shouldRun()` 里 `reportExists` 判断写在提前 return 之后，**等于完全没生效**。
  表现为"今天已经手动跑过、有报告了"，到点仍会再跑一遍（白烧一次额度）。
  现在报告存在即判为"今天已有结果，不重复跑"。
- 补上对应用例：报告存在 → 不跑；报告缺失 → 才跑。

## [1.4.1] — 2026-10-19

### 修复
- **Telegram 通知在本容器里发不出去**：Node 的 `fetch` **不读** `HTTP_PROXY`，而容器靠代理出网。
  实测默认 fetch 一定 `fetch failed`；`NODE_USE_ENV_PROXY` 只能**在 Node 启动前**生效，
  在脚本里赋值无效（已证）。
  改为 `postJson()`：优先 fetch，失败**自动降级到 curl**（curl 会读代理变量），
  保证通知不因启动方式而悄悄失效。

### 新增
- `src/` 与脚本里所有 TG 相关错误都带上可执行的提示（`proxyHint`），不再只吐 `fetch failed`。

## [1.4.0] — 2026-10-19

### 新增
- **自带调度守护进程**（`scripts/bili-daemon.mjs` + `/bili-daemon start|stop|status`）：
  容器里没有 cron/systemd，所以自己写循环。行为照搬鲸鱼的生物钟——窗口内**随机**时刻、
  `skipChance` 概率"今天不想看"、计划落盘重启不丢、过点一小时没报告则**补跑**。
  到点执行 `pi -p "按 bili-scroll 判据刷一轮"`（detached，不阻塞）。
- **Telegram 推送**：`scripts/schedule-core.mjs` 的 `notifyTelegram()` 走 Bot API；
  token 与 chatId 写在 `~/.local/share/bili-scroll/notify.json`（不进仓库），未配置时静默跳过。
- 调度纯逻辑单独成文件（`schedule-core.mjs`）：`parseHHMM` / `windowRange` / `planToday` /
  `shouldRun` / `needsCatchUp`，注入 `rng` 与 `now` 便于测试。

### 说明
- **容器重启后守护进程会丢**，需重新 `/bili-daemon start` —— 环境没有 init 系统，不是实现缺陷。

## [1.3.0] — 2026-10-19

### 新增
- **vendor `dsh-bili-whale` 全功能工具集**（MIT，`Copyright (c) 2026 ALTERSSSS`）：
  53 个文件、46 个命令，原样放进 `vendor/bili-whale/tools/`，不改其源码。
- **`bili_whale({ command, args })` 工具**：一次调用分发到那 46 个命令，读写都通。
  对接层全在 `src/whale.ts`（命令分类、`execFile` 分发、20K 输出截断）。
- **凭证对接**：`scripts/setup-whale.mjs` 建软链
  `~/.bili-ai/credentials.json → ~/.bilibili-mcp/config.json` —— 两边字段名对得上
  （sessdata / bili_jct），换账号后自动同步。上游把路径写死，软链是不改源码的唯一对接方式。
- **抽帧看画面真的通了**：装 ffmpeg 静态构建到持久卷后，`watch-video` 取直链 → 下载 →
  按等间隔骨架 + 画面变化点抽帧 → 拼九宫格，模型直接看图。实测 720P 视频取 9 帧用时约 1 分钟。

### 安全
- 写命令（`comment` / `comment-del` / `dm` / `dynamic` / `danmaku` / `reply-draft` 等）
  在 `tool_call` 里要求用户确认；**未知命令按写处理**（fail closed），不会因为拼错名字就默认放行。
- 无 UI 模式（print/JSON）一律拒绝写命令。

### 已就绪的自检
`bili_whale deps` 四项全绿：B站 cookie（已登录 小小deepseek）、ffmpeg、Node、数据目录可写。

## [1.2.2] — 2026-10-19

### 修复
- **重新生成登录二维码时清掉上一张**。`force` 重发会直接覆盖内存里的 `activeLogin`，
  上一张图片的路径随之丢失、文件永远留在 `downloads/` 里（实跑中留下过
  `bili-login-qr-20261019-082557.png`）。二维码是一次性登录入口，残留既是垃圾也可能被截图外传。

## [1.2.1] — 2026-10-19

### 新增
- **`/bili` prompt 模板**（`~/.pi/agent/prompts/bili.md`）：敲一下就进入「B 站内容编辑」角色，
  可带任务（`/bili BV1xxx 值得看吗`）。角色文本与巡检共用一份，改一处两边同时生效。

### 修复
- 读人设时**剥掉 YAML frontmatter**：模板的 `description` / `argument-hint` 是给命令补全看的，
  内联进提示词只是噪音。
- 删除误放在 `~/.pi/agent/prompts/` 的 `eli5-page.md`（用户不需要那个模板）。

## [1.2.0] — 2026-10-19

### 新增
- **人设真读进来内联**（`src/persona.ts`）：读 `<workdir>/AGENTS.md`，正文以
  「## 你的人设」一节嵌入提示词，并声明与本轮默认语气冲突时以它为准。文件上限 16 KB，超长截断并标注。

### 修复
- 原来 `workdir` 只是把路径写进提示词（"有 AGENTS.md 时按那里的语气说话"），
  等于**赌模型会不会自己去看**——实测常被忽略，表现为"配了人设但语气没变"。
  读不到时现在会如实说"里面没有可用的 AGENTS.md，按中性语气"，不假装有设定。

## [1.1.0] — 2026-10-19

### 新增
- **写能力**：vendor [`adoresever/bilibili-mcp`](https://github.com/adoresever/bilibili-mcp)
  （LICENSE 署名 AGI_Ananas，MIT），只打两处补丁——凭证改读 `~/.bilibili-mcp/config.json`
  （可用 `BILI_CRED_FILE` 覆盖）并加容错；加 `_ALLOWED` + `tool()` 白名单（读 `BILI_MCP_TOOLS`）。
- `mcp.json` 新增 `bilibili-write` 服务器，`BILI_MCP_TOOLS=bili_reply` ——
  **27 个工具只放出 1 个**，投稿/私信/发动态连名字都不出现在 `list_tools` 里。
- `scripts/setup-mcp-write.mjs`：把脚本复制到持久卷并建独立 venv（`mcp` 锁 `<2`）。
- **确认闸门**：`tool_call` 钩子在真正发评论前弹窗给用户看正文并征求同意；
  无 UI 模式（print/JSON）**一律拒绝**（fail closed）。

### 修复
- 移除误提交的 `vendor/bilibili-mcp/__pycache__/*.pyc`，并把 `__pycache__/`、`*.pyc` 加进 `.gitignore`。

## [1.0.1] — 2026-10-19

### 修复
- **`jsonResult` 自递归**：一次批量正则替换把它的函数体改成了 `return jsonResult(details)`，
  导致所有走这个 helper 的工具（`bili_scroll_status` / `bili_login_start` / `bili_login_status`）
  一调用就 `RangeError: Maximum call stack size exceeded`。`tsc` 与 39 个测试全过——它们覆盖不到
  "工具能不能跑"这一层，于是带着这个 bug 推了远程。
- 补上能抓住这类问题的测试：`tests/unit/extension-helpers.test.ts`（形状 + 不许自递归）、
  集成测试里**真的调用一次** `execute()`。并反向验证过：把递归版本放回去时 3 个用例失败。

## [1.0.0] — 2026-10-19

### 新增
- **扫码登录**：`/bili-login` 命令 + `bili_login_start` / `bili_login_status` 工具 +
  `bili-login` skill。二维码渲染成 PNG 存到 `downloads/`（配置项 `qrDir`），
  登录成功后**自动删除图片**，失效也删。
- 自己走 B 站官方 `generate`/`poll` 接口，**不依赖 `bilibili-mcp setup`** ——
  那个命令是交互式的，无 TTY 环境会拒绝画码。

### 修复
- **MCP 启动方式改掉 `npx`**：该包 `cli.js` 用 `fileURLToPath(import.meta.url) === process.argv[1]`
  判定主入口，经 `npx`/`.bin` 启动时 `argv[1]` 是符号链接路径，主入口不执行、**静默退出 0**。
  改为 `node` + 持久卷上的绝对路径，并加回归断言（清单不得出现 `npx`）。
- 按实测补齐 skill：工具经 `mcp` 代理调用、关键词参数叫 `query`、`ai_subtitle` 要标注来源。

## [0.1.0] — 2026-10-19

### 新增
- 首版：`/bili-scroll` 命令（搜 → 逐条读字幕原文 → 读评论 → 判断 → 写日报）、
  `bili_scroll_status` 只读状态工具、判据 skill（`bili-scroll`）、
  自带 B 站只读 MCP 服务器声明（`pi.mcp` → `@xzxzzx/bilibili-mcp@1.14.3`）。
- 日报落在 `~/.local/share/bili-scroll/out/<日期>.md`；"今天刷过没有"以该文件是否存在为准。
- 配套文档：`README.md`、`ARCHITECTURE.md`、`DECISIONS.md`、`AGENTS.md`、MIT `LICENSE`。
