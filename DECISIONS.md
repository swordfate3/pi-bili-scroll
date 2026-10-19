# 决策记录

## 1. 不移植 dsh-bili-scroll，而是按 Pi 机制重做

**状态：** 已采纳（2026-10-19）

**背景：** 目标功能来自 DSH 插件 `dsh-bili-scroll`。它建在 cordis 上，用
`apply(ctx, config)` + schemastery `Config` + 注入 DSH **web 客户端**的设置页 +
`spawn` 一个 headless DSH 会话。Pi 这边**这四个都没有对应物**。

**决定：** 不移植宿主适配层，只重建「什么时候刷 / 按什么判据 / 日报写哪」这一层，
B 站能力改为声明一个外部 MCP 服务器。

**备选与未选原因：**
- *完整移植*（重写 `index.js` 86KB + `client.js` 34KB）→ 等于长期维护一个 fork，收益不匹配
- *不改，直接用 DSH*→ 用户要在 Pi 里用

## 2. B 站能力用 `@xzxzzx/bilibili-mcp`，且由包清单声明

**状态：** 已采纳

**背景：** 三个候选：
| 候选 | 结论 |
|---|---|
| `AGI_Ananas/bilibili-mcp`（插件 vendored 的那份） | 27 工具、**含写操作**，但有 5 处安全加固 + `BILI_MCP_TOOLS` 白名单闸门。**裸脚本、无发行版** |
| PyPI 上的 `bilibili-mcp` | **不是它**：summary 是脚手架默认文案、无作者无主页、依赖与上游不符 → 同名占位/抢注，避开 |
| `@xzxzzx/bilibili-mcp` | Apache-2.0、活跃维护、npm 有明确 bin、**read-first**、自带本地 ASR |

**决定：** 用 `@xzxzzx/bilibili-mcp`，版本钉死 `1.14.3`，在包清单里用
`"pi": { "mcp": "./mcp.json" }` 声明 —— 装包即得能力，不需要另外写 MCP 配置。

**代价（明确接受）：** 它是 read-first，**没有发评论能力**，所以"刷完 @ 你一下"这一步
本版做不到；且 `pi.mcp` 需要 `pi-mcp-adapter` 在场才生效。

## 3. 不导入 `pi-mcp-installer`

**状态：** 已采纳

installer 的 Python/npm 通道要求**精确发行版 + 明确 bin/console script**，其价值是每实例隔离
env、`--ignore-scripts`、审计与回滚。本包选的是"包清单自带 MCP"，两者都算合规路径但**不能同时
做同一个服务器的所有者**（否则两个名字、两份生命周期）。既然目标是"一个包搞定"，选包清单。

若要改走 installer（想要隔离与审计），需要把 `mcp.json` 撤掉、README 写明"先装一次"。

## 4. 「今天刷过没有」不存状态文件，用日报是否落盘判定

**状态：** 已采纳

**原因：** 少一个所有者。存状态文件会引入"状态说刷了、但报告不存在"的不一致；
日报本身就是产物，它的存在是最直接的证据。代价是无法区分"刷了但没写日报"
（`reportDetail: none` 时就是这样）—— 这种配置下提示会重复出现，属可接受的取舍。

## 5. 配置逐字段做类型校验，坏字段回退而不是整体失效

**状态：** 已采纳

**教训来源：** dsh-bili-scroll 2026-10-14 的事故 —— 宿主传进来的配置值**不保证是标量**
（对象/非数组），而对象是"真值"，使 `if (!cfg.flag) return` 这类守卫全部失效，
最终把宿主整个炸掉。所以这里**不用真值判断**，逐字段查 `typeof`，
坏字段回退默认值并记一条 notice 给用户看。

## 6. 不做定时器

**状态：** 已采纳

Pi 是按次启动的 CLI/TUI，**没有常驻宿主**；在扩展里起 `setInterval` 既没有存活的宿主，
也违反扩展规则（不在工厂里起长期资源）。因此"每天自动跑"只能由**外部 cron** 承担，
本包只保证"一条命令跑一轮"和"启动时提示没刷"。这条必须在 README 里写清楚，
不能让用户以为它会自己跑。

## 7. 只有提示，不自动跑

**状态：** 已采纳

`session_start` 发现今天没刷时**只提示**。自动跑会在一轮里发起搜索与多个模型调用、
消耗用户额度，而用户当时可能在做别的事。要自动必须由用户显式安排（cron），
不由扩展替他决定。

## 8. 发消息一律带 `deliverAs: "followUp"`

**状态：** 已采纳（复审发现，2026-10-19）

**背景：** Pi 让扩展命令在 streaming 期间也立即可执行，但 `prompt()` 在忙碌且没有
`streamingBehavior` 时直接抛 `Agent is already processing. Specify streamingBehavior
('steer' or 'followUp') to queue the message.`；原来的调用没带这个字段，
于是「模型正在回复时敲 `/bili-scroll`」会被静默丢掉。

**决定：** 固定用 `followUp`—— 一次完整巡检是独立任务，插到当前回复之后是对的；
用 `steer` 会把它当成对当前回合的插入指令，语义不对。空闲时该字段被 Pi 忽略。

## 9. 非交互模式要等这一轮真的跑完

**状态：** 已采纳（复审发现）

**背景：** `runPrintMode` 在 `await session.prompt(...)` 返回后就读取末条 assistant 消息并
`dispose()`。扩展命令的 `handler` 若提前返回，这一轮会被拦腰截断。

**决定：** `!ctx.hasUI` 时 `await waitForRound(ctx)`；交互/RPC 模式不等（否则会阻塞输入）。
**不能用「先 sleep 一下」代替**：`sendUserMessage` 是异步生效的，紧接着调 `waitForIdle()`
会因为「此刻还空闲」直接返回，所以先轮询等它进入运行态（上界 2s 兜底），再等结束。

## 10. 无 UI 模式的回话走 stderr

**状态：** 已采纳（复审发现）

**背景：** `noOpUIContext.notify` 是 `() => { }`，空实现。print / JSON 模式下只靠
`ctx.ui.notify` 等于什么都没输出 —— status 查不到东西、中止了也看不到原因。

**决定：** `say()` 在 `ctx.hasUI` 为真时用 `ui.notify`，否则写 **stderr**。
**不写 stdout**：JSON 模式下 stdout 是机器可读通道，混进一行中文说明会破坏它。
启动提示这类纯提醒可以不需要输出，但 status / help / 错误原因必须有去处。

## 11. `reportDetail: none` 必须让整段请求自洽

**状态：** 已采纳（复审发现的真缺陷）

**背景：** 原来 `none` 只写在参数字段里，而注入请求又无条件带一句
「写日报用 write 工具写到上面那个路径」，章程第 5 步也写着「写日报到指定路径」——
同一段请求里同时存在「不写日报」和「写到某路径」，模型收到的是矛盾指令。

**决定：** 把请求构造抽成 `src/prompt.ts`，按 `reportDetail` 分支：`none` 时
**不出现日报路径、不出现写文件指令**，并明确写「本轮不写任何日报文件」；
章程第 5 步与红线同步改成条件式。抽出模块的直接收益是这条路径终于**可测**
（`tests/unit/prompt.test.ts` 里对 `none` 断言连路径都不出现）。

## 12. 提示词构造与「等一轮结束」抽成独立模块

**状态：** 已采纳

**原因：** 这两块都属「错了不会报错、只会静默做错」的类型（少写日报 / 巡检被截断），
留在 `extension.ts` 里既测不了也容易被动改坏。抽成 `prompt.ts` / `round.ts` 后不 import
任何 Pi 类型，能用假 ctx 做确定性测试（`round.test.ts` 覆盖三种情形：先空后忙、
已在运行、始终没起来时按超时兜底）。

## 13. 用 `node` + 绝对路径启动 MCP，不用 `npx`

**状态：** 已采纳（实测发现，2026-10-19）

**背景：** 最初 `mcp.json` 写的是 `command: "npx"`、`args: ["-y","@xzxzzx/bilibili-mcp@1.14.3"]`
（看起来最省事，也不用预装）。实测发现它**完全不工作且不报错**：

```
$ npx -y @xzxzzx/bilibili-mcp@1.14.3 --version
（无输出，exit 0）

$ node .../node_modules/@xzxzzx/bilibili-mcp/dist/cli.js --version
1.14.3
```

**根因**（包内 `dist/cli.js:654`）：

```js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
```

Node 把 `import.meta.url` 解析成**真实路径**，而经 `npx` / `.bin` 启动时 `process.argv[1]`
是**符号链接路径**，两者永不相等 ⇒ 主入口整个不执行 ⇒ 静默退出 0。
`--preserve-symlinks` 也救不回来（实测同样无输出）。

**决定：** 一次性把包装到 `~/.local/share/bili-scroll/mcp/`（持久卷，`--save-exact --ignore-scripts`），
`mcp.json` 写 `command: "node"` + `dist/cli.js` 的绝对路径。

**代价（明确接受）：** 需要一次「准备服务器」的安装步骤，不再是一条 `npx` 自动搞定；
换机器时路径要跟着改。收益是不会静默失效 —— 这类"连不上但没有任何报错"最耗排查时间。

**验证：** 用将要写进清单的确切命令做完整 MCP 握手，返回 `serverInfo.version=1.14.3` 与
**12 个工具**（全部只读，确认无发评论/私信/上传）。测试里加了回归断言：清单不得出现 `npx`、
入口必须是绝对路径且以 `/@xzxzzx/bilibili-mcp/dist/cli.js` 结尾、必须位于持久卷家目录下。

## 14. 登录自己做，不调用 `bilibili-mcp setup`

**状态：** 已采纳（2026-10-19，v1.0.0）

**背景：** 用户要求把登录流程做进扩展：二维码存到 `downloads/`、输出路径、登录完成后删图。
而 `bilibili-mcp setup` 是**交互式**的，实测在无 TTY 环境直接拒绝：

```
二维码需要可交互的输入和输出，并有足够空间；请放大终端后重试，或选择手动 Cookie。
```

扩大伪终端窗口能画出来，但扩展里没有终端，也没法把"半块字符二维码"稳定交付给用户。

**决定：** 自己走 B站官方扫码接口（`passport.bilibili.com` 的 generate/poll），用 `qrcode`
渲染成 PNG 落到文件，凭证按既有格式写入 `~/.bilibili-mcp/config.json`
（`sessdata` / `bili_jct` / `dedeuserid` / `expiresAt`，其中 `expiresAt` 是**毫秒**，约 30 天）。

**代价与风险：** 多维护一条登录实现，B站改接口时要跟。缓解方式是**只依赖两个公开端点**，
且写完凭证后可用 MCP 自己的 `check_bilibili_credentials` 交叉验证（实测 `configured: true`
+ `logged_in: true`）。另外 `qrcode` 成为本项目唯一运行时依赖（纯 JS，无原生编译）。

## 15. 二维码"用完即删"，失效也删

**状态：** 已采纳

**原因：** 二维码图片虽然不等于凭证，但它就是一次性登录入口；留在 `downloads/` 里既是垃圾，
也容易被截图外传。所以 `bili_login_status` 在 **confirmed** 和 **expired** 两种终态都删除图片，
并在返回值里如实报告 `qrDeleted`。正常扫码过程中不删（还要给用户扫）。

文件名带时间戳（`bili-login-qr-YYYYMMDD-HHmmss.png`），避免重试时覆盖正在展示的那张。

## 16. 开发目录的 peer 软链必须用脚本重建

**状态：** 已采纳（事故后）

**背景：** 2026-10-19 我在开发目录跑 `npm install qrcode`，npm 把指向全局 pi 的两个软链
（`@earendil-works`、`typebox`）当作多余包清理，并**顺着软链删掉了目标内容** ——
`/home/node/.local/lib/node_modules/@earendil-works/` 被清空，`pi` 命令随之不可用，
只能 `npm i -g @earendil-works/pi-coding-agent@1.3.0` 重装恢复（版本由 `lastChangelogVersion` 与
npm `latest` 双向确认）。

**决定：** 加 `scripts/dev-links.mjs`（`npm run devlinks`）：重建前先检查全局安装是否存在，
并用 `rmSync` 删掉可能残留的空目录再建软链，避免 `ln` 插到目录内部。
规矩写进 `AGENTS.md`：**跑过 npm install 就立刻 devlinks**。
