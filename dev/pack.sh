#!/bin/sh
# Rebuild the importable script package.
#
# Scripting only accepts a zip whose ROOT contains script.json — never GitHub's
# "Source code (zip)", which wraps everything in a repo-name folder.
set -e
cd "$(dirname "$0")/.."
OUT="NAI-Studio.scripting"
rm -f "$OUT"
zip -q -X "$OUT" script.json index.tsx nai.ts store.ts theme.ts ui.tsx \
  workbench.ts generate.tsx params.tsx gallery.tsx prompteditor.tsx \
  characters.tsx chunkgrid.tsx chunkeditor.tsx prompttokens.ts accounts.ts \
  settings.tsx chunks.ts chunkspage.tsx nacl.ts blake2b.ts inflate.ts
unzip -l "$OUT"
