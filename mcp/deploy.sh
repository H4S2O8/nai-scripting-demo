#!/usr/bin/env bash
#
# Deploy the MCP server to a remote host over SSH.
#
#   ./mcp/deploy.sh <ssh-host>
#
# Idempotent: safe to re-run after changing the code.
#
# Two deliberate choices about secrets:
#
#   * MCP_AUTH_TOKEN is generated ON THE SERVER and never printed. Read it back
#     yourself with:  ssh <host> 'sudo grep MCP_AUTH_TOKEN /etc/novelai-mcp.env'
#   * NOVELAI_TOKENS is left as a placeholder. Fill it in on the server so the
#     pst- tokens never pass through a shell history or a terminal log here.
#
# The service starts bound to 127.0.0.1. Exposing it is a separate, deliberate
# step — see mcp/README.md for the TLS reverse proxy.
set -euo pipefail

HOST="${1:-}"
if [ -z "$HOST" ]; then
  echo "用法: ./mcp/deploy.sh <ssh-host>" >&2
  exit 2
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE=/opt/novelai-mcp
SERVICE=novelai-mcp

echo "==> 检查远端环境"
ssh "$HOST" 'command -v node >/dev/null || { echo "远端没有 node"; exit 1; }
             command -v npm  >/dev/null || { echo "远端没有 npm"; exit 1; }
             node -v'

echo "==> 建目录和服务用户"
ssh "$HOST" "set -e
  id -u $SERVICE >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin $SERVICE
  mkdir -p $REMOTE/mcp /var/lib/$SERVICE
  chown $SERVICE:$SERVICE /var/lib/$SERVICE"

echo "==> 同步代码"
# Only the files the bundle actually needs, plus the ones it might grow into.
# Nothing that imports \"scripting\" — that package does not exist off-device.
rsync -az --delete \
  --exclude node_modules --exclude dist \
  "$REPO/mcp/" "$HOST:$REMOTE/mcp/"
rsync -az \
  "$REPO/accounts.ts" "$REPO/blake2b.ts" "$REPO/chunks.ts" "$REPO/inflate.ts" \
  "$REPO/nacl.ts" "$REPO/nai.ts" "$REPO/prompttokens.ts" "$REPO/store.ts" \
  "$HOST:$REMOTE/"

echo "==> 安装依赖并构建"
ssh "$HOST" "set -e
  cd $REMOTE/mcp
  npm ci --silent
  npm run --silent build
  test -s dist/http.mjs"

echo "==> 写配置（首次生成密钥，重跑时保留）"
ssh "$HOST" "set -e
  if [ ! -f /etc/$SERVICE.env ]; then
    # Generated here so the secret never crosses the deploying machine.
    printf '# 多个账户用逗号或换行分隔，可写成 label=pst-xxx；生图会按剩余额度自动选号。\nNOVELAI_TOKENS=REPLACE_ME\nMCP_AUTH_TOKEN=%s\nNOVELAI_OUTPUT_DIR=/var/lib/$SERVICE\nPORT=8787\nHOST=127.0.0.1\n' \"\$(openssl rand -hex 32)\" > /etc/$SERVICE.env
    echo '   已生成新的 MCP_AUTH_TOKEN'
  else
    echo '   /etc/$SERVICE.env 已存在，保持不变'
  fi
  chown root:root /etc/$SERVICE.env
  chmod 600 /etc/$SERVICE.env
  chown -R root:root $REMOTE"

echo "==> 安装 systemd unit"
ssh "$HOST" "cat > /etc/systemd/system/$SERVICE.service <<'UNIT'
[Unit]
Description=NovelAI MCP server
After=network-online.target

[Service]
Type=simple
User=$SERVICE
Group=$SERVICE
WorkingDirectory=$REMOTE/mcp
ExecStart=/usr/bin/env node $REMOTE/mcp/dist/http.mjs
Restart=on-failure
RestartSec=3
EnvironmentFile=/etc/$SERVICE.env

# Reads its own code, writes only the image directory.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
ReadWritePaths=/var/lib/$SERVICE

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable $SERVICE
  # restart, not 'enable --now': --now is a no-op on an already-running unit,
  # so redeploying silently kept serving the old build.
  # Note the single quotes: this whole block is inside a double-quoted string,
  # so backticks here would be run by the LOCAL shell, comment or not.
  systemctl restart $SERVICE
  sleep 2
  systemctl is-active $SERVICE"

echo "==> 健康检查"
ssh "$HOST" "curl -fsS localhost:8787/health && echo"

echo
echo "部署完成。服务在 127.0.0.1:8787，还没有对外暴露。"
echo
echo "还差两步（都在服务器上做，密钥不经过本机）："
echo "  1. 填 NovelAI 令牌（多个用逗号分隔，可加 label=）:"
echo "     ssh $HOST   # 然后在服务器上编辑 /etc/$SERVICE.env 的 NOVELAI_TOKENS= 那行"
echo "     # 例: NOVELAI_TOKENS=main=pst-xxx,alt=pst-yyy"
echo "     # 改完: systemctl restart $SERVICE"
echo "  2. 取访问密钥（配到手机上）:"
echo "     ssh $HOST 'grep MCP_AUTH_TOKEN /etc/$SERVICE.env'"
