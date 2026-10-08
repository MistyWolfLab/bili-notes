# bili-notes · 把 B 站视频读成文字

输入 BV 号，输出 markdown：标题/简介/分P/CC或AI字幕（如有）/弹幕（去重采样）/热评（按点赞）。
零依赖，匿名可用（buvid3 cookie 流 + wbi 签名搜索），无需登录。

```bash
node bili-notes.mjs BV1xxxx [-o out.md] [--danmaku 500] [--replies 20]
node bili-notes.mjs --search "AI拟人" [--n 10]
```

## 设计说明

- **字幕覆盖率诚实报告**：多数视频未开启 CC/AI 字幕（热门区实测 20/20 无字幕），此时弹幕与热评是主文本源——玩梗密度最高的地方本来就是评论区和弹幕。
- **弹幕采样**：全量拉取后去重，超过上限时等距采样，保留梗的多样性。
- **反爬**：B 站对裸请求返 412；本工具先取首页种 buvid3 cookie 再调 API，搜索走 wbi 签名。

## 用途

给 AI 当"视频阅读器"：人设调研、舆论分析、内容摘要的素材入口。
配合 [ai-girls-report](https://github.com/) 使用：bili-notes 采集素材 → 写进 draft.json → 出对话报告。

## 许可

MIT。
