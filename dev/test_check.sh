#!/bin/sh
# Proves the static checker still fires on the thing it exists to catch.
#
# check.py's hooks rule was loosened once already (indentation -> brace depth)
# to stop it flagging useEffect cleanups. A loosened check that no longer
# catches the real bug is worse than no check, so both directions are asserted.
set -e
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/bad.tsx" <<'TSX'
import { Text, useState, useMemo } from "scripting"
function Bad({ items }: { items: string[] }) {
  const [n, setN] = useState(0)
  if (items.length === 0) return <Text>empty</Text>
  const total = useMemo(() => items.length + n, [items, n])
  return <Text>{total}</Text>
}
TSX

cat > "$tmp/good.tsx" <<'TSX'
import { Text, useState, useEffect, useMemo } from "scripting"
function Good({ items }: { items: string[] }) {
  const [n, setN] = useState(0)
  useEffect(() => {
    const remove = Script.onResume(() => setN(0))
    return remove
  }, [])
  const guard = (x: number) => {
    if (x < 0) return 0
    return x
  }
  const label = "{bad}, {worse}"
  const total = useMemo(() => items.length + n + guard(n), [items, n])
  return <Text>{total}{label}</Text>
}
TSX

fail=0

if python3 dev/check.py "$tmp" 2>&1 | grep -q "违反 Hooks 规则"; then
  echo "  ok   catches a real early return before a hook"
else
  echo "  FAIL missed a real early return before a hook"
  fail=1
fi

cat > "$tmp/dead.ts" <<'TS'
export function usedInternally(n: number) {
  return n + 1
}
export function alsoUsed() {
  return usedInternally(1)
}
export function strandedExport() {
  return "nobody calls me"
}
TS

# The regression this rule exists for: restructuring dropped the only caller of
# saveToPhotos, so "save to album" quietly had no entry point while the function
# still compiled and still exported.
out=$(python3 dev/check.py "$tmp" 2>&1 || true)
if echo "$out" | grep -q "strandedExport"; then
  echo "  ok   catches an export nothing calls"
else
  echo "  FAIL missed an export nothing calls"
  fail=1
fi
if echo "$out" | grep -q "usedInternally"; then
  echo "  FAIL false positive on an export used inside its own file"
  fail=1
else
  echo "  ok   no false positive on internal use"
fi
rm "$tmp/dead.ts"

rm "$tmp/bad.tsx"
if python3 dev/check.py "$tmp" 2>&1 | grep -q "违反 Hooks 规则"; then
  echo "  FAIL false positive on useEffect cleanup / nested returns / braces in strings"
  python3 dev/check.py "$tmp" 2>&1 | grep "违反"
  fail=1
else
  echo "  ok   no false positive on cleanup returns, nested returns, braces in strings"
fi

[ "$fail" = 0 ] && echo "\n✓ checker behaves in both directions" || echo "\n✗ checker is wrong"
exit $fail
