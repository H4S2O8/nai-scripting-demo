/**
 * Draw a random entry from a codex on novelai.quicktagcloud.com.
 *
 * Two uses, one sheet. The scene draw (所长色色) goes into the request's own
 * codex slot, whole, and is merged at build time. The artist draw (v5 画师
 * 词典) is one style string, so it lands in the user's 艺术风格 block as a
 * tagged chunk — the block they already have for exactly this.
 *
 * The layout mirrors the site's own: a horizontal rail of chips, one per
 * category, single-select. Picking a category that has children opens a
 * second rail beneath it, and so on down. "全部" on a rail means the whole
 * level. One button draws from everything under the current selection.
 *
 * The slot holds one whole entry — base prompt and per-character prompts —
 * and nai.ts merges it in at build time. Nothing the user typed is edited,
 * and the draw is never written to the chunk library or the account.
 */
import {
  Button,
  HStack,
  Image,
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
  childrenAt,
  clearCodexCache,
  entriesUnder,
  inBatch,
  loadCodex,
  loadCodexList,
  loadDrawn,
  markDrawn,
  randomEntry,
  resetDrawn,
  undrawn,
} from "./codex"
import { CodexDraw } from "./nai"
import { Card, Chip } from "./ui"
import { ACCENT, PAGE_BG } from "./theme"

const PATH_KEY = "nai.codex.lastpath.v1."
const BATCH_KEY = "nai.codex.lastbatch.v1."

/** What a picker instance draws from, and what it is called. */
export type CodexSpec = {
  codexId: string
  title: string
  /** Start on the newest batch rather than on all of them. */
  preferLatestBatch: boolean
}

export const SCENE_SPEC: CodexSpec = {
  codexId: "suozhang_r18",
  title: "所长色色 · 随机",
  preferLatestBatch: false,
}

export const ARTIST_SPEC: CodexSpec = {
  codexId: "artist_nai5_personal",
  title: "随机画师",
  // Every entry here is batched, and the newest batch is the one that was
  // just tested against the current model.
  preferLatestBatch: true,
}

export type CodexPick = {
  entry: CodexEntry
  codexId: string
  path: string[]
}

function loadLastPath(codexId: string): string[] {
  const raw = Storage.get<string[]>(PATH_KEY + codexId)
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
  spec,
  current,
  onPick,
  onClose,
}: {
  /** Changes on every open: sheet content is not rebuilt between presentations. */
  sessionKey: string
  spec: CodexSpec
  /** What the slot holds now, so the sheet can show it and re-roll from it. */
  current: CodexDraw | null
  /** Every draw replaces the slot; there is only ever one. */
  onPick: (pick: CodexPick) => void
  onClose: () => void
}) {
  const [codex, setCodex] = useState<Codex | null>(null)
  const [meta, setMeta] = useState<CodexMeta | null>(null)
  const [path, setPath] = useState<string[]>([])
  const [status, setStatus] = useState("")
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState<CodexPick | null>(null)
  const [drawn, setDrawn] = useState<Record<string, boolean>>({})
  // An update batch id, or "" for all. The site's own "8.31更新" buttons.
  const [batch, setBatch] = useState("")

  const say = (line: string) => setStatus(line)

  const open = async (target: CodexMeta) => {
    setBusy(true)
    say("正在读取…")
    try {
      const loaded = await loadCodex(target, say)
      setCodex(loaded.codex)
      setMeta(target)
      setDrawn(loadDrawn(loaded.codex.id))
      // Land where the user left off, if that category still exists.
      const remembered = loadLastPath(target.id)
      const valid = remembered.every((_, i) =>
        childrenAt(loaded.codex.tree, remembered.slice(0, i)).some((n) => n.name === remembered[i]),
      )
      setPath(valid ? remembered : [])
      const rememberedBatch = Storage.get<string>(BATCH_KEY + target.id)
      const latest = target.updateFilters.find((f) => f.latest)?.id ?? ""
      setBatch(
        typeof rememberedBatch === "string" &&
          target.updateFilters.some((f) => f.id === rememberedBatch)
          ? rememberedBatch
          : spec.preferLatestBatch
            ? latest
            : "",
      )
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
        const found = list.find((c) => c.id === spec.codexId)
        if (!found) {
          say("网站上找不到 " + spec.codexId)
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
    if (codex) Storage.set(PATH_KEY + codex.id, next)
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

  // Category first, then batch: the count on each batch chip is for the
  // current category, which is the number the user is about to draw from.
  const inScope = codex ? entriesUnder(codex.entries, path) : []
  const pool = inBatch(inScope, batch)
  const batchCount = (id: string) => inBatch(inScope, id).length
  // Once drawn, an entry stays out until the user resets — the point of a
  // random draw is to see something new.
  const fresh = undrawn(pool, drawn)
  const exhausted = pool.length > 0 && fresh.length === 0
  const batchLabel = batch ? meta?.updateFilters.find((f) => f.id === batch)?.label ?? batch : ""
  const scope =
    (path.length ? path.join(" › ") : codex?.title ?? "") + (batchLabel ? ` · ${batchLabel}` : "")

  const draw = () => {
    if (!codex) return
    const entry = randomEntry(fresh)
    if (!entry) {
      say(pool.length ? "这个分类抽完了，重置后可以再来" : "这个分类下没有可用的 prompt")
      return
    }
    setDrawn(markDrawn(codex.id, entry.id))
    const pick: CodexPick = { entry, codexId: codex.id, path }
    onPick(pick)
    setLast(pick)
    say(`已抽到「${entry.title}」 · 这一类还剩 ${fresh.length - 1} 条没抽过`)
  }

  // What to show in the result card: this session's draw, or what the slot
  // already held when the sheet opened.
  const shown = last
    ? { title: last.entry.title, path: last.entry.path, base: last.entry.tags, characters: last.entry.characters, identity: last.entry.identity }
    : current

  const reset = () => {
    if (!codex) return
    // Only this scope: resetting 基础涩涩 must not forget what was drawn from
    // 涩涩服饰.
    setDrawn(resetDrawn(codex.id, pool.map((entry) => entry.id)))
    say(`已重置「${scope}」的抽取记录`)
  }

  return (
    <NavigationStack>
      <VStack
        navigationTitle={spec.title}
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

        {/* Update batches, as on the site. Counts are within the chosen
            category, so a batch that has nothing here reads as 0. */}
        {meta && meta.updateFilters.length > 0 ? (
          <ScrollView axes="horizontal" scrollIndicator="hidden">
            <HStack spacing={8}>
              <Image systemName="calendar" font={11} foregroundStyle="tertiaryLabel" />
              <Chip
                label="全部批次"
                selected={batch === ""}
                disabled={busy}
                onTap={() => {
                  setBatch("")
                  if (codex) Storage.set(BATCH_KEY + codex.id, "")
                }}
              />
              {meta.updateFilters.map((filter) => (
                <Chip
                  key={filter.id}
                  label={`${filter.latest ? "NEW " : ""}${filter.label} ${batchCount(filter.id)}`}
                  selected={batch === filter.id}
                  disabled={busy || batchCount(filter.id) === 0}
                  onTap={() => {
                    setBatch(filter.id)
                    if (codex) Storage.set(BATCH_KEY + codex.id, filter.id)
                  }}
                />
              ))}
            </HStack>
          </ScrollView>
        ) : null}

        <Card
          title={scope || "…"}
          systemImage="dice"
          trailing={
            <Text font={11} foregroundStyle={exhausted ? ("systemOrange" as any) : "tertiaryLabel"}>
              {exhausted ? `${pool.length} 条已全部抽过` : `未抽 ${fresh.length} / 共 ${pool.length}`}
            </Text>
          }
        >
          <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Chip
              label={shown ? "换一个" : "随机一个"}
              selected={true}
              disabled={busy || fresh.length === 0}
              onTap={draw}
            />
            <Spacer />
            {pool.length > fresh.length ? (
              <Chip label="重置已抽" selected={false} disabled={busy} onTap={reset} />
            ) : null}
          </HStack>
          {shown ? (
            <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text font={12} fontWeight="semibold" foregroundStyle={ACCENT}>
                {shown.title}
              </Text>
              <Text font={11} foregroundStyle="tertiaryLabel">
                {shown.path.join(" › ")}
              </Text>
              {shown.base.trim() ? (
                <Text font={11} foregroundStyle="secondaryLabel" lineLimit={3}>
                  {shown.base}
                </Text>
              ) : null}
              {shown.characters.map((prompt, index) => (
                <Text key={String(index)} font={11} foregroundStyle="secondaryLabel" lineLimit={2}>
                  {`角色 ${index + 1} → 人物槽位 ${index + 1}：${prompt}`}
                </Text>
              ))}
              {shown.identity ? (
                <Text font={11} foregroundStyle={"systemOrange" as any}>
                  ⚠ 这条的角色 prompt 含发色/瞳色等外貌词，可能盖过你写的角色
                </Text>
              ) : null}
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
