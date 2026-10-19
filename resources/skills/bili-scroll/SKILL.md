---
name: bili-scroll
description: 替用户刷一轮 B 站并写日报时使用。给定关注关键词，搜索近期视频、逐条读字幕原文与评论、按「值不值得占用你一次注意力」筛选，把结果写成 Markdown 日报（配置为 reportDetail=none 时只汇报不写文件）。当前能力为只读：可以搜索、读字幕、读评论、读元数据，不能发评论、私信或投稿。
---

# 刷 B 站

替用户跑一轮巡检：**搜 → 逐条读字幕原文 → 读评论 → 判断 → 写日报**。
判据只有一句话：**值不值得占用用户一次注意力。**

## 可用工具（全部只读）

服务器名是 `bilibili`，经 adapter 加载后带包名前缀，实际是 `pi-bili-scroll__bilibili`。
这些工具**不在默认工具列表里直接声明**（exposure 是 codemode），要通过 `mcp` 代理调：
`mcp({ tool: "<工具名>", args: {...} })`，或 `mcp({ search: "字幕" })` 先找。
按工具名后缀认即可：

| 用途 | 工具 |
|---|---|
| 搜视频 | `search_bilibili_videos` |
| 读字幕/转写 | `get_video_transcript` |
| 读评论 | `get_video_comments` |
| 视频概况 / 元数据 / 章节 | `get_video_info` / `get_video_metadata` / `get_video_chapters` |
| UP 主 | `search_bilibili_creators` / `get_bilibili_creator_content` |
| 收藏夹 | `list_bilibili_favorite_videos` |
| 登录状态 | `check_bilibili_credentials` |

读服务器本身没有发评论/私信/上传工具（read-first 设计）。

另有一个**写服务器** `pi-bili-scroll__bilibili-write`，但白名单只放了一个工具
`bili_reply`（发评论/回复楼中楼）。**默认不要用它**：只有当用户明确说"帮我在这个
视频下评论/回复"时才调用，而且扩展会在真正发出前弹窗让用户确认——用户点了取消，
就是不发，不要重试、不要换个说法再发。

## 流程

1. **搜索。** 用给定的关注关键词调 `search_bilibili_videos`。关键词为空时用内置几组（AI Agent / 编程 / 技术分享）。
   每个关键词取一页候选即可，不要为了凑数反复翻页。
2. **逐条读字幕原文再判断。** 用 `get_video_transcript` 读正文，不读摘要、不靠标题猜。
   **没有字幕的直接跳过**并计数，不要为了"看起来完整"去评论一个你没看过的视频。
3. **读评论（可选但推荐）。** `get_video_comments` 能看出真实价值与争议点；只取前面若干条。
4. **按数量上限筛。** 最多挑 `perDay` 条（默认 5）。宁少勿滥：**没挑满不算失败，硬凑才算**。
5. **写日报**（除非 `reportDetail` 是 `none`）到指定路径，并告知用户路径。
   `reportDetail: none` 时**不写任何文件**，只在会话里把结论说清楚。

## 日报格式

```markdown
# B站巡检 YYYY-MM-DD

刷了 N 条，挑出 M 条；因无字幕跳过 K 条。

### BV1xxxxxxxxx
**标题** — UP 主（时长）
- 为什么值得：一句话，说清它解决了什么问题或提供了什么事实
- 我的一句话：你自己的判断，可以带保留意见
```

`### BV号` 这一行是固定格式 —— 数日报里今天挑了几条，数的就是这些标题行。

详细程度按 `reportDetail`：
- `full` —— 每条多写一段，把关键信息摊开；
- `brief` —— 每条就上面那几行；
- `none` —— **不写日报文件**，只在会话里说结论。

> ⚠️ 指令一致性：本轮请求里如果没有给出"日报写到 <路径>"，就说明 `reportDetail` 是 `none`，
> 此时**不要**用 write 工具创建任何日报文件，也不要自行挑一个路径代替。

## 红线

- **不编。** 字幕没读到、评论拿不到、视频没看过，就如实写"没查到"或跳过。不许用标题推测内容。
- **不透露隐私。** 账号、机器路径、用户聊过的话，一个字都不进日报。
- **默认只读。** 巡检本身只读：不评论、不私信、不投稿、不发动态。
  用户明确要求发评论时才用 `bili_reply`，内容要按用户说的写，**不要自己发挥**，
  也不要把日报里的评价原样贴到评论区。写本地日报不属于这里说的写操作。
- **不刷屏。** 一轮就是一轮，不要反复搜索刷数量。

## 边界

- 字幕可能是 B 站 AI 识别字幕（返回里 `data_source: "ai_subtitle"`），可能不准；
  引用时说明来源，别当人工校对过的原文。想只要人工字幕可加 `exclude_ai_subtitles: true`。
- `search_bilibili_videos` 的关键词参数叫 **`query`**（不是 keyword），`limit` 最大 10。
- 视频没有字幕时，`@xzxzzx/bilibili-mcp` 可以用本机 ASR 转写，但**必须显式开启**
  （`get_video_transcript` 的 `fallback_to_asr`），并且要用户先装过模型。默认不做。
- 登录失效（凭证过期）时如实报告并让用户重新扫码，不要试图绕过。
