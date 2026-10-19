# AGENTS.md — pi-bili-scroll 开发约定

本目录是**独立 git 仓库**（与 `pi-project-architect`、`pi-web-ui` 等兄弟项目一致），
不是 `/workspace` 那一个仓的子目录。本地开发，暂无远端。

## 改完必须做

```bash
npm run check      # typecheck + 28 个测试，必须全绿
```

然后 `git commit`。提交信息用 `<type>: <一句话>`，`type` 取 `feat` / `fix` / `docs` / `test` / `chore`，
正文说清**为什么**改（这个仓库的提交历史是决策证据，不只是流水账）。

## 三个容易踩的坑

1. **`node_modules` 是指向持久卷的符号链接**（`~/.local/share/pi-bili-scroll-dev/node_modules`）。
   `.gitignore` 里写的是 `node_modules`（**不能带尾斜杠** —— 带斜杠只匹配目录，符号链接会被漏过去，
   提交后换机器就是死链）。提交前可以自查：
   ```bash
   git diff --cached --raw | grep 120000   # 应无输出
   ```

2. **`mcp.json` 里是本机绝对路径**（`~/.local/share/bili-scroll/mcp/.../dist/cli.js`）。
   换机器或换家目录要跟着改。**不要改回 `npx`** —— 该包 `cli.js` 用
   `fileURLToPath(import.meta.url) === process.argv[1]` 判定主入口，经 `npx`/`.bin` 启动时
   `process.argv[1]` 是符号链接路径，主入口不执行、静默退出 0（`DECISIONS.md` 13、测试里也有断言守着）。

3. **凭证与运行数据不在仓库里**：B 站凭证在 `~/.bilibili-mcp/config.json`（外部服务器所有），
   配置与日报在 `~/.local/share/bili-scroll/`。两者都不提交，也不要复制进仓库。

## 边界（改动前先确认没有越界）

- **只读**：所用 MCP 服务器是 read-first，12 个工具全部只读，没有发评论/私信/上传。
  「刷完 @ 你」不属本版，要做得换实现，见 `DECISIONS.md` 2。
- **不常驻、不定时**：Pi 是按次启动的，定时只能靠外部 cron，见 `DECISIONS.md` 6。
- **不自动跑**：`session_start` 只提示，绝不自动发起模型轮次，见 `DECISIONS.md` 7。
- 新增/修改提示词逻辑请放进 `src/prompt.ts`，等待逻辑放 `src/round.ts` —— 这两块是
  「错了不报错、只静默做错」的类型，必须可测，见 `DECISIONS.md` 12。

## 架构约束

`src/extension.ts` 是唯一碰 Pi 类型的文件（组合根，只注册、不做 IO）。
`home.ts` / `config.ts` / `prompt.ts` / `round.ts` 不 import Pi，因此能脱开宿主单测。
