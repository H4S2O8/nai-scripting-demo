/**
 * Full-screen prompt editor.
 *
 * Two things drive the layout. The keyboard eats half a portrait phone, so the
 * prompt gets its own page rather than a three-line slit under six cards. And
 * the prompt is free text with chunk references embedded in it: text runs are
 * ordinary editable fields, a chunk is one indivisible pill showing the name
 * you picked it by. Double-tapping a pill turns it back into text, merged into
 * whatever is around it — expanding used to scatter a chunk into a row of
 * separate chips with nowhere to type between them.
 */
import {
  Button,
  FlowLayout,
  Group,
  HStack,
  Image,
  NavigationStack,
  RoundedRectangle,
  ScrollView,
  Spacer,
  Text,
  TextField,
  VStack,
  useEffect,
  useState,
} from "scripting"

import { Chunk, categoriesOf, createChunk, saveCache } from "./chunks"
import {
  PromptToken,
  addTags,
  expandPrompt,
  expandToken,
  parsePrompt,
  removeToken,
  serializePrompt,
  setText,
  chunkStateIn,
  tidy,
  toggleChunkIn,
  withTrailingText,
} from "./prompttokens"
import { ChunkGrid } from "./chunkgrid"
import { ChunkEditorSheet } from "./chunkeditor"
import { Chip } from "./ui"
import { ACCENT, PAGE_BG, RADIUS_CHIP, RADIUS_WELL, WELL_BG } from "./theme"

/** Consecutive chunks share one row; a text run gets a row of its own. */
type Row =
  | { kind: "text"; index: number; token: PromptToken }
  | { kind: "chunks"; entries: { index: number; token: PromptToken }[] }

function layoutRows(tokens: PromptToken[]): Row[] {
  const rows: Row[] = []
  tokens.forEach((token, index) => {
    if (token.kind === "text") {
      rows.push({ kind: "text", index, token })
      return
    }
    const last = rows[rows.length - 1]
    if (last && last.kind === "chunks") last.entries.push({ index, token })
    else rows.push({ kind: "chunks", entries: [{ index, token }] })
  })
  return rows
}

function ChunkPill({
  token,
  onExpand,
  onRemove,
}: {
  token: PromptToken
  onExpand: () => void
  onRemove: () => void
}) {
  if (token.kind !== "chunk") return <Text>—</Text>
  return (
    <HStack
      spacing={5}
      padding={{ horizontal: 10, vertical: 6 }}
      background={
        <RoundedRectangle
          cornerRadius={RADIUS_CHIP}
          fill={{ color: ACCENT, opacity: 0.9 }}
        />
      }
      // Double tap is the shortcut; the context menu is the discoverable path.
      onTapGesture={{ count: 2, perform: onExpand }}
      contextMenu={{
        menuItems: (
          <Group>
            <Button
              title="展开为文本"
              systemImage="arrow.up.left.and.arrow.down.right"
              action={onExpand}
            />
            <Button title="删除" role="destructive" action={onRemove} />
          </Group>
        ),
      }}
    >
      <Image systemName="square.stack.3d.up.fill" font={10} foregroundStyle="white" />
      <Text font={13} fontWeight="semibold" foregroundStyle="white">
        {token.label}
      </Text>
    </HStack>
  )
}

export function PromptEditor({
  title,
  scope,
  editorKey,
  value,
  chunks,
  onChanged,
  onChunksChanged,
  onClose,
}: {
  title: string
  /** Storage scope for the chunk picker's collapsed categories. */
  scope: string
  /**
   * Changes on every open, and whenever the target changes.
   *
   * The editor is the content of a fullScreenCover, which is not torn down
   * between presentations, so `useState(value)` keeps whatever the *previous*
   * open left behind: opening 人物 right after 艺术风格 showed the style text
   * and then saved it over the character block. State is reset from this key
   * rather than trusting a remount.
   */
  editorKey: string
  value: string
  chunks: Chunk[]
  onChanged: (value: string) => void
  onChunksChanged: (chunks: Chunk[]) => void
  onClose: () => void
}) {
  /*
   * The draft is held as tokens, not as a serialized string.
   *
   * Round-tripping through serialize on every keystroke would trim the run and
   * strip its trailing comma, so typing "1girl, " ate the comma as you typed
   * it. Serialization happens once, on commit.
   */
  const [tokens, setTokens] = useState<PromptToken[]>([])
  const [raw, setRaw] = useState(false)
  const [rawText, setRawText] = useState("")
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    setTokens(withTrailingText(parsePrompt(value)))
    setRaw(false)
    setRawText("")
    setSaving(null)
  }, [editorKey])

  const rows = layoutRows(tokens)
  const chunkCount = tokens.filter((token) => token.kind === "chunk").length
  // Only for the picker's on/off state; never fed back into the draft.
  const serialized = serializePrompt(tokens)

  const enterRaw = () => {
    // Raw editing has to show real text, so references expand on the way in and
    // do not come back — the button says so.
    setRawText(expandPrompt(serialized))
    setRaw(true)
  }

  const leaveRaw = () => {
    setTokens(withTrailingText(parsePrompt(addTags("", rawText))))
    setRaw(false)
  }

  const commit = () => {
    onChanged(raw ? addTags("", rawText) : serialized)
    onClose()
  }

  return (
    <NavigationStack>
      <VStack
        navigationTitle={title}
        navigationBarTitleDisplayMode="inline"
        background={PAGE_BG}
        spacing={10}
        padding={{ horizontal: 14, top: 8, bottom: 8 }}
        frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}
        toolbar={{
          topBarLeading: [<Button title="取消" action={onClose} />],
          topBarTrailing: [<Button title="完成" action={commit} />],
        }}
        sheet={{
          isPresented: saving != null,
          onChanged: (shown: boolean) => {
            if (!shown) setSaving(null)
          },
          content: (
            <ChunkEditorSheet
              sessionKey={editorKey + "|" + (saving ?? "")}
              presetExpansion={saving ?? ""}
              categories={categoriesOf(chunks)}
              onSave={(chunkDraft) => {
                onChunksChanged(saveCache(createChunk(chunks, chunkDraft)))
              }}
              onClose={() => setSaving(null)}
            />
          ),
        }}
      >
        {raw ? (
          <VStack
            alignment="leading"
            spacing={6}
            padding={10}
            frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }}
            background={<RoundedRectangle cornerRadius={RADIUS_WELL} fill={WELL_BG} />}
          >
            <TextField
              title={title}
              value={rawText}
              onChanged={setRawText}
              prompt="逗号分隔的 tag，或任意文字"
              axis="vertical"
              lineLimit={{ min: 6, max: 16 }}
              labelsHidden
              autofocus
              autocorrectionDisabled
              textInputAutocapitalization="never"
            />
          </VStack>
        ) : (
          <VStack
            alignment="leading"
            spacing={8}
            padding={10}
            frame={{ maxWidth: "infinity", maxHeight: 260, alignment: "topLeading" }}
            background={<RoundedRectangle cornerRadius={RADIUS_WELL} fill={WELL_BG} />}
          >
            <ScrollView>
              <VStack
                alignment="leading"
                spacing={7}
                frame={{ maxWidth: "infinity", alignment: "leading" }}
              >
                {rows.map((row) =>
                  row.kind === "text" ? (
                    <TextField
                      key={"t" + row.index}
                      title="提示词"
                      value={row.token.kind === "text" ? row.token.text : ""}
                      onChanged={(next) => setTokens(setText(tokens, row.index, next))}
                      prompt="随便写，逗号分隔的 tag 或整句都行"
                      axis="vertical"
                      lineLimit={{ min: 1, max: 8 }}
                      labelsHidden
                      autocorrectionDisabled
                      textInputAutocapitalization="never"
                      contextMenu={{
                        menuItems: (
                          <Group>
                            <Button
                              title="存为 chunk"
                              systemImage="square.stack.3d.up"
                              action={() => {
                                const text =
                                  row.token.kind === "text" ? row.token.text.trim() : ""
                                if (text) setSaving(text)
                              }}
                            />
                          </Group>
                        ),
                      }}
                    />
                  ) : (
                    <FlowLayout key={"c" + row.entries[0].index} spacing={7}>
                      {row.entries.map((entry) => (
                        <ChunkPill
                          key={"p" + entry.index}
                          token={entry.token}
                          onExpand={() =>
                            setTokens(withTrailingText(tidy(expandToken(tokens, entry.index))))
                          }
                          onRemove={() =>
                            setTokens(withTrailingText(tidy(removeToken(tokens, entry.index))))
                          }
                        />
                      ))}
                    </FlowLayout>
                  ),
                )}
              </VStack>
            </ScrollView>
          </VStack>
        )}

        <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={11} foregroundStyle="tertiaryLabel">
            {raw
              ? "chunk 已展开为文本，返回后不会还原"
              : `${chunkCount} 个 chunk · 双击展开 · 长按文本可存为 chunk`}
          </Text>
          <Spacer />
          <Chip
            label={raw ? "返回标签" : "原文"}
            selected={raw}
            onTap={() => (raw ? leaveRaw() : enterRaw())}
          />
          <Chip
            label="清空"
            selected={false}
            disabled={raw ? rawText.length === 0 : serialized.length === 0}
            onTap={() => (raw ? setRawText("") : setTokens([{ kind: "text", text: "" }]))}
          />
        </HStack>

        {raw ? null : (
          <ScrollView>
            <ChunkGrid
              chunks={chunks}
              text={serialized}
              scope={scope}
              onToggle={(chunk) =>
                setTokens(withTrailingText(tidy(toggleChunkIn(tokens, chunk))))
              }
            />
          </ScrollView>
        )}
      </VStack>
    </NavigationStack>
  )
}
