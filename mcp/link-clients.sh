#!/usr/bin/env bash
#
# Point the local MCP clients at a deployed novelai-mcp.
#
#   ./mcp/link-clients.sh [ssh-host] [public-url]
#
# Idempotent: safe to re-run after rotating the token.
#
# The token is read over SSH and written straight into the config files. It is
# never echoed, never put on the clipboard, and never passed as an argv (which
# would show up in `ps`). Two clients take it by reference and one cannot:
#
#   Codex        ~/.codex/config.toml    bearer_token_env_var
#   Claude Code  ~/.claude.json          literal
#   Grok         ~/.grok/config.toml     literal
#
# Claude Code used to get ${NAI_MCP_TOKEN} here, and failed with a 401 that
# explained nothing: launched from the desktop app rather than from a shell, it
# never reads ~/.zshrc, so the variable was simply not in its environment.
# Codex keeps the by-reference form because it is run from a terminal that has
# the variable; Grok's MCP headers do not expand variables at all.
set -euo pipefail

HOST="${1:-JDCloud-4c16g}"
URL="${2:-https://www.asylum.icu/nai/mcp}"
ENV_FILE="$HOME/.config/nai-mcp.env"
GROK_CONFIG="$HOME/.grok/config.toml"

echo "==> 从 $HOST 取令牌"
TOKEN="$(ssh -o ConnectTimeout=15 "$HOST" \
  'sed -n "s/^MCP_AUTH_TOKEN=//p" /etc/novelai-mcp.env' | tr -d "\r\n")"
if [ -z "$TOKEN" ]; then
  echo "服务器上没有 MCP_AUTH_TOKEN，先跑 mcp/deploy.sh。" >&2
  exit 1
fi
echo "    拿到了（${#TOKEN} 字符，不显示）"

echo "==> 写 $ENV_FILE"
mkdir -p "$(dirname "$ENV_FILE")"
# umask before the redirect: creating it 0644 and chmod-ing after leaves a
# window where the token is world-readable.
( umask 077; printf 'export NAI_MCP_TOKEN=%s\n' "$TOKEN" > "$ENV_FILE" )

for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
  [ -f "$rc" ] || continue
  if grep -q 'nai-mcp.env' "$rc"; then
    echo "    $rc 已经 source 过了"
  else
    printf '\n[ -f ~/.config/nai-mcp.env ] && . ~/.config/nai-mcp.env\n' >> "$rc"
    echo "    已加进 $rc"
  fi
done

echo "==> 写 Claude Code 的字面令牌"
CLAUDE_CONFIG="$HOME/.claude.json"
if [ -f "$CLAUDE_CONFIG" ]; then
  NAI_TOKEN="$TOKEN" CLAUDE_CONFIG="$CLAUDE_CONFIG" MCP_URL="$URL" python3 - <<'CLAUDEPY'
import io, json, os

path = os.environ["CLAUDE_CONFIG"]
config = json.load(io.open(path, encoding="utf-8"))
config.setdefault("mcpServers", {})["novelai"] = {
    "type": "http",
    "url": os.environ["MCP_URL"],
    "headers": {"Authorization": "Bearer " + os.environ["NAI_TOKEN"]},
}

tmp = path + ".tmp"
# 0600 before the move: this file now carries a bearer token.
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    json.dump(config, handle, ensure_ascii=False, indent=2)
os.replace(tmp, path)
print("    已写入（重开 Claude Code 生效）")
CLAUDEPY
else
  echo "    没有 $CLAUDE_CONFIG，跳过"
fi

echo "==> 写 Grok 的字面令牌"
if [ -f "$GROK_CONFIG" ]; then
  # Passed by env, not argv: an argument would be visible in `ps` while it runs.
  NAI_TOKEN="$TOKEN" GROK_CONFIG="$GROK_CONFIG" GROK_URL="$URL" python3 - <<'PY'
import io, os, re
path = os.environ["GROK_CONFIG"]
token = os.environ["NAI_TOKEN"]
url = os.environ["GROK_URL"]
text = io.open(path, encoding="utf-8").read()

block = (
    "# NovelAI 生图。写入自 mcp/link-clients.sh；轮换令牌就重跑它。\n"
    "# 字面值是必须的：Grok 的 MCP headers 不展开环境变量。\n"
    "[mcp_servers.novelai]\n"
    f'url = "{url}"\n'
    f'headers = {{ Authorization = "Bearer {token}" }}\n'
    "enabled = true\n"
    "tool_timeout_sec = 300\n"
)
# Replaces the whole block, plus any comment lines sitting directly above it,
# rather than just a placeholder: re-running after a rotation has to work once
# REPLACE_ME is long gone, and leaving the old comments behind would have the
# file describing a setup step that already happened.
pattern = re.compile(
    r"(?:^[ \t]*#[^\n]*\n)*\[mcp_servers\.novelai\]\n(?:(?!\n\[).)*",
    re.S | re.M,
)
if pattern.search(text):
    text = pattern.sub(block, text)
    print("    已更新现有配置")
else:
    text = text.rstrip("\n") + "\n\n" + block
    print("    已追加配置")

with io.open(path, "w", encoding="utf-8") as f:
    f.write(text)
os.chmod(path, 0o600)
PY
else
  echo "    没有 $GROK_CONFIG，跳过"
fi

unset TOKEN

echo
echo "完成。三个客户端都指向 $URL"
echo
echo "接下来："
echo "  1. 让当前这个终端也生效：  . ~/.config/nai-mcp.env"
echo "  2. 看 Codex 认不认：       codex mcp list"
echo "  3. Claude Code 要重开一次才会加载新配置"
echo
echo "~/.claude.json 和 ~/.grok/config.toml 里是字面令牌，都已设为 0600。"
echo "轮换后重跑本脚本，两处一起更新。"
