#!/bin/sh
# Everything that can be checked without a phone.
set -e
cd "$(dirname "$0")/.."
echo "== static check =="
python3 dev/check.py .
echo
echo "== crypto vs reference implementations =="
node dev/test_crypto.mjs
echo
echo "== chunk protocol vs the userscript =="
node dev/test_chunks.mjs
