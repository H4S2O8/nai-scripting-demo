/**
 * Full-screen prompt editor.
 *
 * Two things drive the layout. The keyboard eats half a portrait phone, so the
 * prompt gets its own page rather than a three-line slit under six cards. And a
 * chunk stays one token here instead of spilling nine tags into the field —
 * you see the name you chose it by, and double-tapping expands it if you
 * actually want to edit what is inside.
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
  useState,
} from "scripting"

import { Chunk } from "./chunks"
import {
  PromptToken,
  addTags,
  expandPrompt,
  expandToken,
  parsePrompt,
  removeToken,
  serializePrompt,
  toggleChunk,
} from "./prompttokens"
import { ChunkGrid } from "./chunkgrid"
import { Chip } from "./ui"
import { ACCENT, CHIP_BG, PAGE_BG, RADIUS_CHIP, RADIUS_WELL, WELL_BG } from "./theme"

function TokenChip({
  token,
  onExpand,
  onRemove,
}: {
  token: PromptToken
  onExpand: () => void
  onRemove: () => void
}) {
  if (token.kind === "text") {
    return (
      <HStack
        spacing={4}
        padding={{ horizontal: 10, vertical: 6 }}
        background={<RoundedRectangle cornerRadius={RADIUS_CHIP} fill={CHIP_BG} />}
        contextMenu={{
          menuItems: (
            <Group>
              <Button title="删除" role="destructive" action={onRemove} />
            </Group>
          ),
        }}
      >
        <Text font={13} foregroundStyle="label">
          {token.text}
        </Text>
      </HStack>
    )
  }

  return (
    <HStack
      spacing={5}
      padding={{ horizontal: 10, vertical: 6 }}
      background={
        <RoundedRectangle cornerRadius={RADIUS_CHIP} fill={{ color: ACCENT, opacity: 0.9 }} />
      }
      // Double tap is the shortcut; the context menu is the discoverable path.
      onTapGesture={{ count: 2, perform: onExpand }}
      contextMenu={{
        menuItems: (
          <Group>
            <Button title="展开为原文" systemImage="arrow.up.left.and.arrow.down.right" action={onExpand} />
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
  value,
  chunks,
  onChanged,
  onClose,
}: {
  title: string
  /** Storage scope for the chunk picker's collapsed categories. */
  scope: string
  value: string
  chunks: Chunk[]
  onChanged: (value: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(value)
  const [raw, setRaw] = useState(false)
  const [rawText, setRawText] = useState("")
  const [entry, setEntry] = useState("")

  const tokens = parsePrompt(draft)
  const chunkCount = tokens.filter((token) => token.kind === "chunk").length

  const enterRaw = () => {
    // Raw editing has to show real text, so references expand on the way in and
    // do not come back — the button says so.
    setRawText(expandPrompt(draft))
    setRaw(true)
  }

  const leaveRaw = () => {
    setDraft(addTags("", rawText))
    setRaw(false)
  }

  const commit = () => {
    onChanged(raw ? addTags("", rawText) : draft)
    onClose()
  }

  const submitEntry = () => {
    if (!entry.trim()) return
    setDraft(addTags(draft, entry))
    setEntry("")
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
              prompt="逗号分隔的 tag"
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
            frame={{ maxWidth: "infinity", maxHeight: 240, alignment: "topLeading" }}
            background={<RoundedRectangle cornerRadius={RADIUS_WELL} fill={WELL_BG} />}
          >
            {tokens.length === 0 ? (
              <Text font={13} foregroundStyle="tertiaryLabel">
                还是空的。下面输入 tag，或从词库里点选。
              </Text>
            ) : (
              <ScrollView>
                <FlowLayout spacing={7}>
                  {tokens.map((token, index) => (
                    <TokenChip
                      key={String(index) + (token.kind === "chunk" ? token.label : token.text)}
                      token={token}
                      onExpand={() =>
                        setDraft(serializePrompt(expandToken(tokens, index)))
                      }
                      onRemove={() => setDraft(serializePrompt(removeToken(tokens, index)))}
                    />
                  ))}
                </FlowLayout>
              </ScrollView>
            )}
          </VStack>
        )}

        <HStack
          spacing={8}
          padding={{ horizontal: 10, vertical: 7 }}
          frame={{ maxWidth: "infinity" }}
          background={<RoundedRectangle cornerRadius={RADIUS_WELL} fill={WELL_BG} />}
        >
          <Image systemName="plus" font={12} foregroundStyle={ACCENT} />
          <TextField
            title="添加"
            value={entry}
            onChanged={setEntry}
            onSubmit={submitEntry}
            prompt={raw ? "原文模式下直接在上面编辑" : "输入 tag，回车加入"}
            labelsHidden
            autocorrectionDisabled
            textInputAutocapitalization="never"
          />
        </HStack>

        <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={11} foregroundStyle="tertiaryLabel">
            {raw
              ? "chunk 已展开为文本，返回后不会还原"
              : `${tokens.length} 项 · ${chunkCount} 个 chunk · 双击 chunk 展开原文`}
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
            disabled={raw ? rawText.length === 0 : tokens.length === 0}
            onTap={() => (raw ? setRawText("") : setDraft(""))}
          />
        </HStack>

        {raw ? null : (
          <ScrollView>
            <ChunkGrid
              chunks={chunks}
              text={draft}
              scope={scope}
              onToggle={(chunk) => setDraft(toggleChunk(draft, chunk))}
            />
          </ScrollView>
        )}
      </VStack>
    </NavigationStack>
  )
}
