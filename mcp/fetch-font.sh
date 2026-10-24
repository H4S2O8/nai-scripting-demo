#!/usr/bin/env bash
#
# Download the CJK font the page composer renders with, and verify it.
#
#   ./fetch-font.sh            (run from mcp/, or anywhere: it resolves its own dir)
#
# Noto Sans SC (Source Han Sans) DemiLight, pinned to the Sans2.004 tag of
# github.com/notofonts/noto-cjk: a neutral, restrained 黑体 one step lighter
# than Regular, which reads heavy as light text on a dark page and stays
# clear down to the smallest size the layout uses. 8.3 MB, so it is fetched rather than
# committed. A checksum mismatch deletes the file and fails: the composer
# refuses to start without the exact font rather than rendering in a
# substitute.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)/fonts"
FILE="$DIR/NotoSansSC-DemiLight.otf"
URL="https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/SubsetOTF/SC/NotoSansSC-DemiLight.otf"
SHA256="63a895a808a155fe69d67f742e60ee708fe0eaaef0650904bb4eead3941e98dc"

sum() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

mkdir -p "$DIR"
if [ -f "$FILE" ] && [ "$(sum "$FILE")" = "$SHA256" ]; then
  echo "字体已就绪: $FILE"
  exit 0
fi
curl -fsSL -o "$FILE.part" "$URL"
if [ "$(sum "$FILE.part")" != "$SHA256" ]; then
  rm -f "$FILE.part"
  echo "字体校验失败：下载到的文件和预期的 SHA-256 不一致" >&2
  exit 1
fi
mv "$FILE.part" "$FILE"
echo "字体已下载: $FILE"
