#!/usr/bin/env bash
#
# Generate the fill-in sheet for wiring novelai-mcp into Claude Code cloud sessions.
#
#   ./mcp/cloud-setup-doc.sh [ssh-host] [output-path]
#   ./mcp/cloud-setup-doc.sh --with-token          # inline the token, 0600
#
# The claude.ai side is a web form, so the only thing a script can do is hand
# you exact values to paste. It reads the live token from the server rather
# than from a local copy, so a rotated token can never make the sheet stale.
#
# By default the token is NOT written to the document: the sheet carries a
# pbcopy one-liner instead, so a 64-character secret goes server -> clipboard
# -> browser without ever touching the disk or the screen. --with-token inlines
# it for pure copy-paste, and then the file is written 0600 and the sheet says
# to delete it afterwards.
set -euo pipefail

WITH_TOKEN=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --with-token) WITH_TOKEN=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done

HOST="${ARGS[0]:-HK}"
OUT="${ARGS[1]:-$HOME/nai-cloud-setup.md}"
MCP_HOST="nai.huryzhrft.xyz"
IMG_HOST="preview.asylum.icu"

echo "==> 从 $HOST 确认服务在线"
ssh -o ConnectTimeout=15 "$HOST" 'systemctl is-active --quiet novelai-mcp' \
  || { echo "    $HOST 上的 novelai-mcp 没在跑，先修服务再生成文档。" >&2; exit 1; }
echo "    在线"

# Read once, into a variable, never echoed. Same discipline as link-clients.sh:
# an argv would be visible in `ps`, and a here-doc would land in the shell log.
TOKEN="$(ssh -o ConnectTimeout=15 "$HOST" \
  'grep "^MCP_AUTH_TOKEN=" /etc/novelai-mcp.env | cut -d= -f2-')"
[ -n "$TOKEN" ] || { echo "    没读到 MCP_AUTH_TOKEN" >&2; exit 1; }
echo "==> 取到令牌（${#TOKEN} 字符，不显示）"

if [ "$WITH_TOKEN" = 1 ]; then
  TOKEN_CELL="\`$TOKEN\`"
  TOKEN_NOTE="> ⚠️ 这份文件里有明文令牌，已设为 0600。填完删掉：\`rm $OUT\`"
else
  TOKEN_CELL="见下面第 3 步，令牌不写进本文件"
  TOKEN_NOTE=""
fi

umask 077
cat > "$OUT" <<SHEET
# NovelAI MCP → Claude Code 云端会话

生成于 $(date "+%Y-%m-%d %H:%M")，来源 \`$HOST\`。令牌轮换后重跑 \`./mcp/cloud-setup-doc.sh\` 重新生成。

$TOKEN_NOTE

## 为什么走 API credential

凭据由 Anthropic 的 agent proxy 在请求**离开沙箱之后**附加，官方文档原话是令牌
"never reaches Claude, the commands it runs, or the session's environment variables"。
连带的好处：这类 host **不需要**加进网络白名单，因为它绕开了 allowlist。

代价是有一条我没能从文档证实——MCP 客户端的请求是否也经 agent proxy。排除列表里
没有 MCP，按文档推断应该走，但要实测。第 5 步就是验证，失败了看第 6 步。

## 1. 打开环境编辑器

[claude.ai/code](https://claude.ai/code) → 左下角环境选择器的云图标 → 悬停在环境上
点右侧齿轮（**不是** "Add cloud environment"，新建环境的弹窗里没有凭据这一项，必须是
已存在的环境）。

在 **Update cloud environment** 弹窗里，**API credentials** 在 **Environment variables** 下面。

## 2. Add credential，按这张表填

| 字段 | 填什么 |
| --- | --- |
| Credential type | \`Bearer\`（默认值，不用动） |
| Name | \`NovelAI MCP\` |
| Allowed websites | \`$MCP_HOST\` |
| Custom headers → Name | \`Authorization\`（默认值） |
| Custom headers → Prefix | \`Bearer\`（默认值） |
| Custom headers → Value | $TOKEN_CELL |

点 **Connect**。凭据独立保存，不走弹窗的 Save changes 按钮；**存完就看不到值了**，
要改只能删掉重加。

## 3. 令牌进剪贴板

SHEET

if [ "$WITH_TOKEN" = 1 ]; then
  cat >> "$OUT" <<'SHEET'
令牌已经在上面表格里，直接复制。
SHEET
else
  cat >> "$OUT" <<SHEET
跑这一条，令牌直接进剪贴板，不落盘也不显示：

\`\`\`bash
ssh $HOST 'grep "^MCP_AUTH_TOKEN=" /etc/novelai-mcp.env | cut -d= -f2-' | tr -d '\\n' | pbcopy
\`\`\`

然后在 **Value** 里 ⌘V。
SHEET
fi

cat >> "$OUT" <<SHEET

## 4. 仓库里要有 \`.mcp.json\`

云端只认**单仓库会话**里那一份 \`.mcp.json\`（多仓库会话起在 clone 之上，读不到）。
本仓库已经有了，内容是：

\`\`\`json
{
  "mcpServers": {
    "novelai": {
      "type": "http",
      "url": "https://$MCP_HOST/mcp"
    }
  }
}
\`\`\`

**没有 auth 头是故意的**——头由 agent proxy 加。要在别的仓库也用，把这份复制过去，
并且那个仓库得有 GitHub remote。

## 5. 验证

起一个云会话，让它调 \`novelai_account\`。

- 返回账户和额度 → 成了，令牌没进过沙箱
- **401** → agent proxy 没覆盖 MCP 流量，走第 6 步
- 工具根本不存在 → \`.mcp.json\` 没被读到：确认是单仓库会话，且改动已 push

## 6. 退路：环境变量 + 白名单

凭据路线失败就改用这个，一定能通，代价是令牌明文存在环境配置里
（文档警告 "Anyone who uses the environment can read the values"，个人账号下就是你自己）。

同一个弹窗里：

| 字段 | 填什么 |
| --- | --- |
| Network access | 选 **Custom** |
| Allowed domains | \`$MCP_HOST\` |
| | 勾上 **Also include default list of common package managers** |
| Environment variables | \`NAI_MCP_TOKEN=<令牌>\` |

然后把 \`.mcp.json\` 改回带头的形式：

\`\`\`json
{
  "mcpServers": {
    "novelai": {
      "type": "http",
      "url": "https://$MCP_HOST/mcp",
      "headers": { "Authorization": "Bearer \\\${NAI_MCP_TOKEN}" }
    }
  }
}
\`\`\`

## 坑

**本地不会被仓库里这份无头配置搞坏。** Project scope 压过 User scope，而且
"the entire server entry from that source is used; fields are not merged"——
所以无头的 \`.mcp.json\` 本来会让你本地 401。已经在 \`~/.claude.json\` 的
**local scope**（\`projects["<仓库路径>"].mcpServers\`）里放了一份带令牌的，
local 压过 project，本地照常能用。换机器或重建配置时记得这条。

**Skill 不会跟着走。** \`nai-character-library\` 和 \`novel-illustration\` 在
\`~/.claude/skills/\`，属于"lives on your machine, not in the repo"，云端没有。
要用就复制进仓库的 \`.claude/skills/\`。

**图片链接要额外白名单。** \`imageSize\` 默认 \`none\` 只回链接，云端 Claude 想看图
得去 fetch \`$IMG_HOST\`，那是另一个域名。更省事的是云端显式传
\`imageSize: "preview"\`，图以 base64 走 MCP 响应回来，不额外发网络请求。
SHEET

[ "$WITH_TOKEN" = 1 ] && chmod 600 "$OUT"

echo "==> 写好了：$OUT"
if [ "$WITH_TOKEN" = 1 ]; then
  echo "    含明文令牌，已设 0600，填完请删除"
else
  echo "    不含令牌；文档第 3 步有取令牌进剪贴板的命令"
fi
