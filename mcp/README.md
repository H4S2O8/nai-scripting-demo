# NovelAI 生图 MCP Server

把这个仓库里那套已经验证过的请求构造（`../nai.ts`）包成 MCP server，让 Claude Code、
Claude Desktop 或任何 MCP 客户端直接出图。发出去的 payload 和手机 App 完全一致——
质量词、UC 预设、V5 强制 Karras、Variety+ 的 sigma、人物 caption 都走同一份代码。

## 安装

```bash
cd mcp
npm install
npm run build
```

产出 `mcp/dist/server.mjs`。

## 接进 Claude Code

```bash
claude mcp add novelai --env NOVELAI_TOKEN=pst-你的令牌 -- node /绝对路径/nai-scripting-demo/mcp/dist/server.mjs
```

或者写进 `~/.claude.json` / `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "novelai": {
      "command": "node",
      "args": ["/绝对路径/nai-scripting-demo/mcp/dist/server.mjs"],
      "env": {
        "NOVELAI_TOKEN": "pst-你的令牌",
        "NOVELAI_OUTPUT_DIR": "/Users/你/Pictures/NovelAI"
      }
    }
  }
}
```

| 环境变量 | 说明 |
| --- | --- |
| `NOVELAI_TOKEN` | 必填。网页 设置 → Account → Get Persistent API Token |
| `NOVELAI_OUTPUT_DIR` | 可选，默认 `~/Pictures/NovelAI` |

这里只用 `pst-` 生图令牌。词库同步要的 `auth_token` / `encryption_key` 是 App 那边的事，
MCP 用不到。

## 工具

**`novelai_generate_image`** —— 出图，存 PNG，返回路径、seed、Anlas 估算，以及**实际发送的
提示词**（质量词合并后的结果，方便核对）。

参数：`prompt`（必填）、`negative`、`model`、`width` / `height`、`steps`、`guidance`、
`sampler`、`seed`、`ucPreset`、`qualityPreset`、`count`（1–8）、`characters`、`returnImage`。

- 尺寸自动按 64 取整并限制在 3 MP 以内
- `seed` 留空或 0 表示每张随机
- `characters` 是 V4+/V5 的角色 caption；给了 `x` / `y` 就是钉位置，不给就交给模型安排
- `returnImage` 默认**关**：整张 PNG 转 base64 是几 MB，会把上下文吃掉。想让模型看图再打开

**`novelai_list_options`** —— 模型、采样器、画幅预设、UC 预设、质量词预设和默认值。
让模型先查一次，好过把所有合法值塞进参数描述里。

**`novelai_account`** —— 等级、Anlas 余额、Opus 剩余额度。

## 测试

```bash
npm run build && node test_server.mjs
```

用真的 MCP client 通过 stdio 连上去，检查工具清单、schema、选项内容和各种错误路径；
ZIP 解包拿系统 `zip` 生成的真实归档验证（deflate 和 stored 两种）。**不需要令牌，也不会
花 Anlas**——生成那一步验的是"没有凭据时必须给出清楚的报错"。

## 为什么不直接调 API

`buildPayload` 里有一堆不查就会错的东西：V5 必须强制 `noise_schedule: "karras"`（按采样器
推导会让 DPM++ 静默变成 Exponential）、Variety+ 是 `skip_cfg_above_sigma: 58` 而不是布尔
字段、质量词和 UC 预设文本按模型分支、角色 caption 的 `centers` 数组即使不指定位置也不能为空
（否则接口直接 500）。这些都是对着官方客户端的真实请求逐字段核对出来的，仓库里有 200 多项
测试守着。
