/**
 * Draw a random prompt from a category of 所长色色 (suozhang_r18) on
 * novelai.quicktagcloud.com, and hand it to the prompt editor as a temporary
 * chunk.
 *
 * The layout mirrors the site's own: a horizontal rail of chips, one per
 * category, single-select. Picking a category that has children opens a
 * second rail beneath it, and so on down. "全部" on a rail means the whole
 * level. One button draws from everything under the current selection.
 *
 * Temporary means: the chunk carries its own expansion inside the prompt's
 * marker, so it displays and expands like any library chunk without ever
 * being written to the library or the account.
 */
import {
  Button,
  HStack,
  NavigationStack,
  ScrollView,
  Spacer,
  Text,
  VStack,
  useEffect,
  useState,
} from "scripting"

import {
  Codex,
  CodexEntry,
  CodexMeta,
  CodexNode,
  DEFAULT_CODEX,
  childrenAt,
  clearCodexCache,
  entriesUnder,
  loadCodex,
  loadCodexList,
  randomEntry,
} from "./codex"
import { Card, Chip } from "./ui"
import { ACCENT, PAGE_BG } from "./theme"

const PATH_KEY = "nai.codex.lastpath.v1"

export type CodexPick = {
  entry: CodexEntry
  codexId: string
  path: string[]
}

function loadLastPath(): string[] {
  const raw = Storage.get<string[]>(PATH_KEY)
  return Array.isArray(raw) ? raw.filter((seg) => typeof seg === "string") : []
}

/** One rail: the children of `at`, with "全部" meaning `at` itself. */
function Rail({
  nodes,
  selected,
  onSelect,
  disabled,
}: {
  nodes: CodexNode[]
  /** The chosen child's name, or "" for the whole level. */
  selected: string
  onSelect: (name: string) => void
  disabled: boolean
}) {
  return (
    <ScrollView axes="horizontal" scrollIndicator="hidden">
      <HStack spacing={8}>
        <Chip label="全部" selected={selected === ""} disabled={disabled} onTap={() => onSelect("")} />
        {nodes.map((node) => (
          <Chip
            key={node.name}
            label={`${node.name} ${node.count}`}
            selected={selected === node.name}
            disabled={disabled}
            onTap={() => onSelect(node.name)}
          />
        ))}
      </HStack>
    </ScrollView>
  )
}

export function CodexPickerSheet({
  sessionKey,
  onPick,
  onClose,
}: {
  /** Changes on every open: sheet content is not rebuilt between presentations. */
  sessionKey: string
  /**
   * Called for every draw. `replacing` is the previous pick from this session,
   * so "换一个" swaps the chunk in place instead of stacking a second one.
   */
  onPick: (pick: CodexPick, replacing: CodexPick | null) => void
  onClose: () => void
}) {
  const [codex, setCodex] = useState<Codex | null>(null)
  const [meta, setMeta] = useState<CodexMeta | null>(null)
  const [path, setPath] = useState<string[]>([])
  const [status, setStatus] = useState("")
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState<CodexPick | null>(null)

  const say = (line: string) => setStatus(line)

  const open = async (target: CodexMeta) => {
    setBusy(true)
    say("正在读取…")
    try {
      const loaded = await loadCodex(target, say)
      setCodex(loaded.codex)
      setMeta(target)
      // Land where the user left off, if that category still exists.
      const remembered = loadLastPath()
      const valid = remembered.every((_, i) =>
        childrenAt(loaded.codex.tree, remembered.slice(0, i)).some((n) => n.name === remembered[i]),
      )
      setPath(valid ? remembered : [])
      say(
        `${loaded.codex.title} · ${loaded.codex.entries.length} 条` +
          (loaded.fromCache ? " · 本地缓存" : " · 已更新到最新"),
      )
    } catch (error) {
      say("❌ " + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    setLast(null)
    setCodex(null)
    setBusy(true)
    say("正在读取词典列表…")
    loadCodexList()
      .then((list) => {
        const found = list.find((c) => c.id === DEFAULT_CODEX)
        if (!found) {
          say("网站上找不到 " + DEFAULT_CODEX)
          setBusy(false)
          return
        }
        return open(found)
      })
      .catch((error) => {
        say("❌ " + (error instanceof Error ? error.message : String(error)))
        setBusy(false)
      })
  }, [sessionKey])

  const choose = (depth: number, name: string) => {
    // Selecting at a level discards anything chosen below it.
    const next = name ? path.slice(0, depth).concat(name) : path.slice(0, depth)
    setPath(next)
    Storage.set(PATH_KEY, next)
  }

  // One rail per level: the root, then the children of each chosen node.
  const rails: { depth: number; nodes: CodexNode[]; selected: string }[] = []
  if (codex) {
    for (let depth = 0; depth <= path.length; depth++) {
      const nodes = childrenAt(codex.tree, path.slice(0, depth))
      if (nodes.length === 0) break
      rails.push({ depth, nodes, selected: path[depth] ?? "" })
    }
  }

  const pool = codex ? entriesUnder(codex.entries, path) : []
  const scope = path.length ? path.join(" › ") : codex?.title ?? ""

  const draw = (stack: boolean) => {
    if (!codex) return
    const entry = randomEntry(pool)
    if (!entry) {
      say("这个分类下没有可用的 prompt")
      return
    }
    const pick: CodexPick = { entry, codexId: codex.id, path }
    onPick(pick, stack ? null : last)
    setLast(pick)
    say(`${stack ? "再填入" : "已填入"}「${entry.title}」`)
  }

  return (
    <NavigationStack>
      <VStack
        navigationTitle="所长色色 · 随机"
        navigationBarTitleDisplayMode="inline"
        background={PAGE_BG}
        spacing={10}
        padding={{ horizontal: 14, top: 8, bottom: 8 }}
        frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}
        toolbar={{
          topBarTrailing: [<Button title="完成" action={onClose} />],
        }}
      >
        {rails.map((rail) => (
          <Rail
            key={String(rail.depth)}
            nodes={rail.nodes}
            selected={rail.selected}
            disabled={busy}
            onSelect={(name) => choose(rail.depth, name)}
          />
        ))}

        <Card
          title={scope || "…"}
          systemImage="dice"
          trailing={
            <Text font={11} foregroundStyle="tertiaryLabel">
              {pool.length} 条
            </Text>
          }
        >
          <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Chip
              label={last ? "换一个" : "随机一个"}
              selected={true}
              disabled={busy || pool.length === 0}
              onTap={() => draw(false)}
            />
            {last ? (
              <Chip
                label="再加一个"
                selected={false}
                disabled={busy || pool.length === 0}
                onTap={() => draw(true)}
              />
            ) : null}
            <Spacer />
          </HStack>
          {last ? (
            <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text font={12} fontWeight="semibold" foregroundStyle={ACCENT}>
                {last.entry.title}
              </Text>
              <Text font={11} foregroundStyle="tertiaryLabel">
                {last.entry.path.join(" › ")}
              </Text>
              <Text font={11} foregroundStyle="secondaryLabel" lineLimit={4}>
                {last.entry.tags}
              </Text>
            </VStack>
          ) : null}
        </Card>

        <Text font={11} foregroundStyle="tertiaryLabel">
          {status}
        </Text>

        <Spacer />

        <HStack>
          <Spacer />
          <Chip
            label="清缓存重新下载"
            selected={false}
            disabled={busy || !codex || !meta}
            onTap={() => {
              if (!codex || !meta) return
              clearCodexCache(codex.id)
              void open(meta)
            }}
          />
        </HStack>
      </VStack>
    </NavigationStack>
  )
}
