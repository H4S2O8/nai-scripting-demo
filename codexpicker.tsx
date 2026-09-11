/**
 * Draw a random prompt from a codex category on novelai.quicktagcloud.com,
 * and hand it to the prompt editor as a temporary chunk.
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
  TextField,
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
  encodePathCode,
  entriesUnder,
  loadCodex,
  loadCodexList,
  nodeAt,
  parseSiteLink,
  pathFromCode,
  randomEntry,
} from "./codex"
import { Card, Chip, Well } from "./ui"
import { ACCENT, PAGE_BG } from "./theme"

export type CodexPick = {
  entry: CodexEntry
  codexId: string
  path: string[]
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
  const [codexes, setCodexes] = useState<CodexMeta[]>([])
  const [codexId, setCodexId] = useState(DEFAULT_CODEX)
  const [codex, setCodex] = useState<Codex | null>(null)
  const [path, setPath] = useState<string[]>([])
  const [status, setStatus] = useState("")
  const [busy, setBusy] = useState(false)
  const [link, setLink] = useState("")
  const [last, setLast] = useState<CodexPick | null>(null)

  const say = (line: string) => setStatus(line)

  const open = async (meta: CodexMeta, jumpTo?: string) => {
    setBusy(true)
    setCodex(null)
    setPath([])
    say("正在读取 " + meta.name + "…")
    try {
      const loaded = await loadCodex(meta, say)
      setCodex(loaded.codex)
      setCodexId(meta.id)
      const target = jumpTo ? pathFromCode(loaded.codex.tree, jumpTo) : []
      setPath(target)
      say(
        `${loaded.codex.title} · ${loaded.codex.entries.length} 条` +
          (loaded.fromCache ? " · 本地缓存" : " · 已更新") +
          (jumpTo && target.length === 0 ? " · 链接里的分类没找到，已回到根目录" : ""),
      )
    } catch (error) {
      say("❌ " + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(false)
    }
  }

  // The list and the default codex, once per open.
  useEffect(() => {
    setLast(null)
    setLink("")
    setPath([])
    setCodex(null)
    setBusy(true)
    say("正在读取词典列表…")
    loadCodexList()
      .then((list) => {
        setCodexes(list)
        const meta = list.find((c) => c.id === DEFAULT_CODEX) ?? list[0]
        if (!meta) {
          say("网站上没有任何词典")
          setBusy(false)
          return
        }
        return open(meta)
      })
      .catch((error) => {
        say("❌ " + (error instanceof Error ? error.message : String(error)))
        setBusy(false)
      })
  }, [sessionKey])

  const here = codex ? nodeAt(codex.tree, path) : null
  const children: CodexNode[] = codex ? childrenAt(codex.tree, path) : []
  const pool = codex ? entriesUnder(codex.entries, path) : []

  const draw = (at: string[]) => {
    if (!codex) return
    const entry = randomEntry(entriesUnder(codex.entries, at))
    if (!entry) {
      say("这个分类下没有可用的 prompt")
      return
    }
    const pick: CodexPick = { entry, codexId: codex.id, path: at }
    onPick(pick, last)
    setLast(pick)
    say(`已填入「${entry.title}」`)
  }

  const jump = () => {
    const parsed = parseSiteLink(link)
    if (!parsed) {
      say("看不懂这个链接。要 ?c=…&p=… 的形式，或者只贴 p= 后面那段。")
      return
    }
    const meta =
      (parsed.codex ? codexes.find((c) => c.id === parsed.codex) : null) ??
      codexes.find((c) => c.id === codexId) ??
      null
    if (!meta) {
      say("链接里的词典 " + parsed.codex + " 不在列表里")
      return
    }
    if (meta.id === codexId && codex) {
      // Same codex: no reload, just move.
      const target = pathFromCode(codex.tree, parsed.code)
      setPath(target)
      say(target.length ? "已跳到 " + target.join(" / ") : "链接里的分类没找到")
      return
    }
    void open(meta, parsed.code)
  }

  return (
    <NavigationStack>
      <VStack
        navigationTitle="词典随机"
        navigationBarTitleDisplayMode="inline"
        background={PAGE_BG}
        spacing={10}
        padding={{ horizontal: 14, top: 8, bottom: 8 }}
        frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}
        toolbar={{
          topBarTrailing: [<Button title="完成" action={onClose} />],
        }}
      >
        {/* Which codex */}
        <ScrollView axes="horizontal" scrollIndicator="hidden">
          <HStack spacing={8}>
            {codexes.map((meta) => (
              <Chip
                key={meta.id}
                label={meta.name + (meta.nsfw ? " ·18" : "")}
                selected={meta.id === codexId}
                disabled={busy}
                onTap={() => {
                  if (meta.id !== codexId) void open(meta)
                }}
              />
            ))}
          </HStack>
        </ScrollView>

        {/* Paste a link from the site */}
        <Well padding={8}>
          <HStack spacing={8}>
            <TextField
              title="链接"
              value={link}
              onChanged={setLink}
              prompt="粘贴网站链接或 p= 短码后跳转"
              labelsHidden
              autocorrectionDisabled
            />
            <Chip label="跳转" selected={false} disabled={busy || !link.trim()} onTap={jump} />
          </HStack>
        </Well>

        {/* Where we are */}
        <HStack spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Chip
            label={codex ? codex.title : "…"}
            selected={path.length === 0}
            disabled={!codex}
            onTap={() => setPath([])}
          />
          {path.map((name, index) => (
            <Chip
              key={String(index) + name}
              label={name}
              selected={index === path.length - 1}
              onTap={() => setPath(path.slice(0, index + 1))}
            />
          ))}
        </HStack>

        {/* The draw — the whole point of the sheet */}
        <Card
          title={path.length ? path[path.length - 1] : "整个词典"}
          systemImage="dice"
          trailing={
            <Text font={11} foregroundStyle="tertiaryLabel">
              {pool.length} 条可抽 · p={encodePathCode(path) || "根"}
            </Text>
          }
        >
          <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Chip
              label={last ? "换一个" : "随机一个"}
              selected={true}
              disabled={busy || pool.length === 0}
              onTap={() => draw(path)}
            />
            {last ? (
              <Chip
                label="再加一个"
                selected={false}
                disabled={busy || pool.length === 0}
                onTap={() => {
                  // Forget the previous pick so the next draw stacks.
                  setLast(null)
                  const entry = randomEntry(pool)
                  if (!entry || !codex) return
                  const pick: CodexPick = { entry, codexId: codex.id, path }
                  onPick(pick, null)
                  setLast(pick)
                  say(`已再填入「${entry.title}」`)
                }}
              />
            ) : null}
            <Spacer />
          </HStack>
          {last ? (
            <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text font={12} fontWeight="semibold" foregroundStyle={ACCENT}>
                {last.entry.title}
              </Text>
              <Text font={11} foregroundStyle="secondaryLabel" lineLimit={3}>
                {last.entry.tags}
              </Text>
            </VStack>
          ) : null}
        </Card>

        <Text font={11} foregroundStyle="tertiaryLabel">
          {status}
        </Text>

        {/* Subcategories */}
        <ScrollView>
          <VStack spacing={6} frame={{ maxWidth: "infinity" }}>
            {children.map((node) => (
              <HStack key={node.name} spacing={8} frame={{ maxWidth: "infinity" }}>
                <Button
                  buttonStyle="plain"
                  action={() => setPath(path.concat(node.name))}
                  disabled={node.children.length === 0}
                >
                  <HStack spacing={6}>
                    <Text font={13}>{node.name}</Text>
                    <Text font={11} foregroundStyle="tertiaryLabel">
                      {node.count}
                    </Text>
                    {node.children.length ? (
                      <Text font={11} foregroundStyle="tertiaryLabel">
                        ›
                      </Text>
                    ) : null}
                  </HStack>
                </Button>
                <Spacer />
                <Chip
                  label="随机"
                  selected={false}
                  disabled={busy}
                  onTap={() => draw(path.concat(node.name))}
                />
              </HStack>
            ))}
            {codex && children.length === 0 ? (
              <Text font={11} foregroundStyle="tertiaryLabel">
                已经是最底层分类
              </Text>
            ) : null}
          </VStack>
        </ScrollView>

        {codex && here === null && path.length > 0 ? null : (
          <HStack>
            <Spacer />
            <Chip
              label="清缓存重新下载"
              selected={false}
              disabled={busy || !codex}
              onTap={() => {
                if (!codex) return
                clearCodexCache(codex.id)
                const meta = codexes.find((c) => c.id === codex.id)
                if (meta) void open(meta)
              }}
            />
          </HStack>
        )}
      </VStack>
    </NavigationStack>
  )
}
