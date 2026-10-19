# 架构

## 边界

这个包只拥有三件事：

1. **什么时候刷**（一条命令、一次启动提示）
2. **按什么判据挑**（值班章程 skill）
3. **日报写到哪**（家目录 + 报告路径）

B 站的数据读取**不属于本包** —— 它由 `mcp.json` 声明的外部 MCP 服务器提供。
本包不解析 B 站 API、不管凭证、不管分页。

```
        ┌─────────────────────────────┐
        │  Pi 会话（模型）             │
        └───┬─────────────────────┬───┘
            │ /bili-scroll        │ bili_scroll_status
            │ （注入章程 + 参数）   │ （只读状态）
┌───────────▼──────────┐   ┌──────▼─────────────┐
│ src/extension.ts     │   │ 日报文件            │
│  组合根：只注册       │──▶│ ~/.local/share/    │
└───┬───┬───┬───┬─────┘   │   bili-scroll/out/ │
    │   │   │   │          └────────────────────┘
    │   │   │   └────────────▶ round.ts（等这一轮跑完）
    │   │   └────────────────▶ prompt.ts（构造注入请求）
    │   └────────────────────▶ charter.ts（读 skill）
    └────────────────────────▶ config.ts / home.ts
                                 ┌──────────────────────────┐
   模型用工具 ──────────────────▶│ @xzxzzx/bilibili-mcp      │
   （由 adapter 连）              │ 搜索 / 字幕 / 评论 / 元数据 │
                                 └──────────────────────────┘
```

## 依赖方向

- `extension.ts`（Pi 适配层）→ `prompt.ts` / `round.ts` / `config.ts` / `charter.ts` / `home.ts`
- **`home.ts` / `config.ts` / `prompt.ts` / `round.ts` 都不 import Pi 的类型**，所以它们能脱开宿主单独测；只有 `extension.ts` 碰 `ExtensionAPI`
- `prompt.ts` 与 `round.ts` 是被专门抽出来的两个「容易静默出错」的模块：前者决定要不要写日报，后者决定命令是否等这一轮跑完。留在 `extension.ts` 里就没法测，事实上也正是它们出过缺陷

## 状态归属

| 状态 | 归属 | 为什么 |
|---|---|---|
| 今天刷过没有 | **日报文件是否存在** | 不另存状态文件：日报本身就是产物，用它当判据不会有"状态说刷了但报告没了"这种不一致 |
| 用户配置 | `~/.local/share/bili-scroll/config.json` | 家目录在 pi-runtime 持久卷上，容器重建不丢 |
| 凭证 | `~/.bilibili-mcp/config.json`（**外部服务器所有**） | 本包不碰凭证，一个字都不读 |
| 章程 | `resources/skills/bili-scroll/SKILL.md` | 单一真源：skill 分发与命令注入用同一个文件 |

## 生命周期

- 扩展工厂**只注册**，不做 IO、不起进程、不设定时器 —— Pi 有些调用只加载扩展而不开会话
- 本包**不持有需要清理的长期资源**（配置与章程按需读、读完即弃），因此没有 `session_shutdown` 处理器
- `session_start` 只读一次状态并提示，**不自动跑**任何模型轮次

## 与宿主的三条约定（都踩过坑）

| 场景 | 做法 | 不这么做会怎样 |
|---|---|---|
| 模型正在回复时敲 `/bili-scroll` | `sendUserMessage(..., { deliverAs: "followUp" })` | `prompt()` 抛 `Agent is already processing`，本轮被丢弃 |
| print / JSON 模式跑 `/bili-scroll` | `await waitForRound(ctx)`（`!ctx.hasUI` 时才等） | 输入路径一返回就 dispose，巡检被拦腰截断 |
| 无 UI 模式下要回话 | `say()` 在 `!ctx.hasUI` 时退回 **stderr** | `noOpUIContext.notify` 是空实现，用户看不到任何状态与中止原因 |

`waitForRound` 不能写成「`sendUserMessage` 后直接 `waitForIdle()`」：`sendUserMessage` 是**异步生效**的，它内部 `prompt()` 在第一个 `await` 处就让出，此刻 `isIdle()` 仍为真，`waitForIdle()` 会立即返回。必须先轮询等它进入运行状态（上界 2s 兜底），再等结束。

## 与外部 MCP 的契约

`mcp.json` 声明 `bilibili` 服务器（`npx -y @xzxzzx/bilibili-mcp@1.14.3`）：

- 版本**钉死**：不用 `@latest`，避免升级时漂移
- 服务器名会被 adapter 加包名前缀（如 `pi_bili_scroll__bilibili`），所以章程里描述能力时**说的是工具语义，不是工具全名**
- 该服务器是 **read-first** 的：本包因此不能提供"发评论 @ 你"；章程里也明确禁止模型试图绕过
