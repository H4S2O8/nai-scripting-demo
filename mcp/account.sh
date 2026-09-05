#!/usr/bin/env bash
#
# Manage the server's NovelAI account pool, and the access token clients use.
#
#   ./mcp/account.sh list                what the running server sees
#   ./mcp/account.sh add <label>         add, or replace an existing label
#   ./mcp/account.sh remove <label>      drop one
#   ./mcp/account.sh rotate-auth         new MCP_AUTH_TOKEN, then re-link clients
#
#   NAI_SSH_HOST=other-host ./mcp/account.sh list
#
# WHERE THE TOKEN GOES. `add` prompts ON THE SERVER and reads the pst- token
# with `read -rs`. So it is never:
#   - typed on this machine, so never in this terminal's scrollback
#   - in any shell history: `read` is a builtin, and nothing is echoed
#   - in argv, so invisible to `ps` on a shared box
#   - anywhere on disk except the 0600 env file
#
# Every change restarts the service and then asks the RUNNING SERVER what it
# sees. An env file that parses is not the same thing as a pool that works.
set -euo pipefail

HOST="${NAI_SSH_HOST:-JDCloud-4c16g}"
SERVICE=novelai-mcp
ENV_FILE=/etc/$SERVICE.env
REPO="$(cd "$(dirname "$0")/.." && pwd)"
EDITOR_SRC="$REPO/mcp/editenv.py"
EDITOR_DST=/usr/local/lib/novelai-mcp-editenv.py

usage() {
  sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

# Ship the editor rather than inlining it. A python program pasted into a
# double-quoted ssh argument is one stray backtick away from running on the
# wrong machine — which is exactly the bug this script's sibling had.
push_editor() {
  scp -q "$EDITOR_SRC" "$HOST:$EDITOR_DST"
  ssh "$HOST" "chown root:root $EDITOR_DST && chmod 700 $EDITOR_DST"
}

pool_status() {
  echo "==> 问运行中的服务"
  ssh "$HOST" "curl -s --max-time 40 -X POST localhost:8787/mcp \
      -H \"Authorization: Bearer \$(sed -n 's/^MCP_AUTH_TOKEN=//p' $ENV_FILE)\" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"novelai_account\",\"arguments\":{}}}'" \
    | sed 's/^data: //' \
    | python3 -c '
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"):
        continue
    payload = json.loads(line)
    for chunk in ((payload.get("result") or {}).get("content") or []):
        print(chunk.get("text", ""))
'
}

restart() {
  echo "==> 重启"
  ssh "$HOST" "systemctl restart $SERVICE && sleep 2 && systemctl is-active $SERVICE"
}

case "${1:-}" in
  list)
    pool_status
    ;;

  add)
    LABEL="${2:-}"
    [ -n "$LABEL" ] || usage
    push_editor
    echo "==> 在服务器上输入 “$LABEL” 的 pst- 令牌（不回显）"
    # One remote shell does everything: prompt, then run the editor with the
    # token in its environment. Two sessions cannot work — the variable would
    # not survive the first one ending.
    ssh -t "$HOST" "
      read -rsp '令牌: ' NEWTOKEN; echo
      if [ -z \"\$NEWTOKEN\" ]; then echo '空令牌，取消。'; exit 1; fi
      case \"\$NEWTOKEN\" in
        pst-*) ;;
        *) echo '注意: 不是 pst- 开头。持久令牌通常是 pst-，仍然继续。' ;;
      esac
      OP=add LABEL='$LABEL' NEWTOKEN=\"\$NEWTOKEN\" ENVFILE=$ENV_FILE python3 $EDITOR_DST
    "
    restart
    pool_status
    ;;

  remove)
    LABEL="${2:-}"
    [ -n "$LABEL" ] || usage
    push_editor
    ssh "$HOST" "OP=remove LABEL='$LABEL' ENVFILE=$ENV_FILE python3 $EDITOR_DST"
    restart
    pool_status
    ;;

  rotate-auth)
    echo "==> 生成新的 MCP_AUTH_TOKEN（在服务器上，不打印）"
    ssh "$HOST" "set -e
      sed -i \"s|^MCP_AUTH_TOKEN=.*|MCP_AUTH_TOKEN=\$(openssl rand -hex 32)|\" $ENV_FILE
      chmod 600 $ENV_FILE
      systemctl restart $SERVICE
      sleep 2
      systemctl is-active $SERVICE"
    echo "==> 同步到本机的三个客户端"
    "$REPO/mcp/link-clients.sh" "$HOST"
    echo
    echo "旧密钥已作废。Claude Code 需要重开一次才会用上新的。"
    ;;

  *)
    usage
    ;;
esac
