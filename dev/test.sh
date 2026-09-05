#!/bin/sh
# Everything that can be checked without a phone.
set -e
cd "$(dirname "$0")/.."
echo "== static check =="
python3 dev/check.py .
echo
echo "== the static checker itself =="
./dev/test_check.sh
echo
echo "== crypto vs reference implementations =="
node dev/test_crypto.mjs
echo
echo "== mcp server (skipped unless mcp/node_modules exists) =="
if [ -d mcp/node_modules ]; then
  ( cd mcp && npm run --silent build && node test_server.mjs )
else
  echo "  -- skipped; run 'cd mcp && npm install' to include it"
fi
echo
echo "== accounts =="
node dev/test_accounts.mjs
echo
echo "== prompt token model =="
node dev/test_prompt.mjs
echo
echo "== history store =="
node dev/test_store.mjs
echo
echo "== raw DEFLATE vs node zlib =="
node dev/test_inflate.mjs
echo
echo "== chunk protocol vs the userscript =="
node dev/test_chunks.mjs
echo
echo "== mcp account pool =="
node dev/test_pool.mjs
echo
echo "== mcp v5 modes =="
node dev/test_modes.mjs
