/**
 * Full-screen prompt editor.
 *
 * On a portrait phone the keyboard eats half the screen, so editing a prompt
 * inline under six other cards means typing into a three-line slit. Here the
 * field is the page: it gets everything above the keyboard, and the chunk
 * library sits directly underneath, which is where tags actually come from.
 */
import {
  Button,
  FlowLayout,
  HStack,
  Image,
  NavigationStack,
  RoundedRectangle,
  ScrollView,
  Spacer,
  Text,
  TextField,
  VStack,
  useMemo,
  useState,
} from "scripting"

import { Chunk, searchChunks } from "./chunks"
import { PromptField } from "./workbench"
import { Chip, FieldLabel } from "./ui"
import { ACCENT, PAGE_BG, RADIUS_WELL, WELL_BG } from "./theme"

export function PromptEditor({
  field,
  value,
  chunks,
  onChanged,
  onClose,
}: {
  field: PromptField
  value: string
  chunks: Chunk[]
  onChanged: (value: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(value)
  const [query, setQuery] = useState("")

  const positive = field === "prompt"
  const results = useMemo(() => searchChunks(chunks, query), [chunks, query])

  const tags = draft
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)

  const append = (text: string) => {
    const existing = tags.map((tag) => tag.toLowerCase())
    const additions = text
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part && existing.indexOf(part.toLowerCase()) === -1)
    if (additions.length === 0) return
    setDraft(tags.concat(additions).join(", "))
  }

  const commit = () => {
    onChanged(draft)
    onClose()
  }

  return (
    <NavigationStack>
      <VStack
        navigationTitle={positive ? "提示词" : "负面提示词"}
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
        <VStack
          alignment="leading"
          spacing={6}
          padding={10}
          frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }}
          background={<RoundedRectangle cornerRadius={RADIUS_WELL} fill={WELL_BG} />}
        >
          <TextField
            title={positive ? "提示词" : "负面提示词"}
            value={draft}
            onChanged={setDraft}
            prompt={positive ? "1girl, looking at viewer, ..." : "额外不想要的内容"}
            axis="vertical"
            lineLimit={{ min: 6, max: 14 }}
            labelsHidden
            autofocus
            autocorrectionDisabled
            textInputAutocapitalization="never"
          />
        </VStack>

        <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={11} foregroundStyle="tertiaryLabel">
            {tags.length} 个 tag · {draft.length} 字符
          </Text>
          <Spacer />
          <Chip
            label="清空"
            selected={false}
            disabled={draft.length === 0}
            onTap={() => setDraft("")}
          />
          <Chip
            label="去重"
            selected={false}
            disabled={tags.length === 0}
            onTap={() => {
              const seen: Record<string, boolean> = {}
              const unique: string[] = []
              for (const tag of tags) {
                const key = tag.toLowerCase()
                if (seen[key]) continue
                seen[key] = true
                unique.push(tag)
              }
              setDraft(unique.join(", "))
            }}
          />
        </HStack>

        {chunks.filter((c) => !c.isCategory).length > 0 ? (
          <VStack
            alignment="leading"
            spacing={8}
            frame={{ maxWidth: "infinity", maxHeight: 260, alignment: "topLeading" }}
          >
            <HStack
              spacing={8}
              padding={{ horizontal: 10, vertical: 7 }}
              frame={{ maxWidth: "infinity" }}
              background={<RoundedRectangle cornerRadius={RADIUS_WELL} fill={WELL_BG} />}
            >
              <Image systemName="magnifyingglass" font={12} foregroundStyle={ACCENT} />
              <TextField
                title="搜索"
                value={query}
                onChanged={setQuery}
                prompt="搜 chunk"
                labelsHidden
                autocorrectionDisabled
                textInputAutocapitalization="never"
              />
            </HStack>
            <ScrollView>
              <FlowLayout spacing={8}>
                {results.slice(0, 80).map((chunk) => (
                  <Chip
                    label={chunk.label || chunk.id}
                    selected={false}
                    onTap={() => append(chunk.expansion || chunk.label)}
                  />
                ))}
              </FlowLayout>
            </ScrollView>
          </VStack>
        ) : (
          <FieldLabel text="词库是空的" hint="到「词库」标签页拉取" />
        )}
      </VStack>
    </NavigationStack>
  )
}
