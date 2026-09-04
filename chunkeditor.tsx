/**
 * Create or edit one chunk, as a sheet.
 *
 * Shared by the library tab and by "save as chunk" in the prompt editor, so
 * that turning a phrase you just typed into a reusable chunk is one step from
 * where you typed it.
 */
import {
  Button,
  FlowLayout,
  HStack,
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

import { Chunk, ROOT_ID } from "./chunks"
import { Card, Chip, Well } from "./ui"
import { PAGE_BG, RADIUS_CHIP } from "./theme"

/** NovelAI's chunk colours are free-form hex; these are just handy defaults. */
const SWATCHES = [
  "#6B7280",
  "#7C5CFA",
  "#2563EB",
  "#0EA5E9",
  "#10B981",
  "#F59E0B",
  "#EF4444",
  "#EC4899",
]

export function ChunkEditorSheet({
  sessionKey,
  chunk,
  presetExpansion,
  categories,
  onSave,
  onDelete,
  onClose,
}: {
  /**
   * Changes every time the sheet is opened.
   *
   * Sheet content is not rebuilt between presentations, so seeding state from
   * props once would show the previously edited chunk when creating a new one.
   */
  sessionKey: string
  /** Set when editing; omitted when creating. */
  chunk?: Chunk | null
  /** Pre-filled content when creating from selected prompt text. */
  presetExpansion?: string
  categories: Chunk[]
  onSave: (draft: {
    label: string
    expansion: string
    color: string
    categoryId: string
  }) => void
  onDelete?: () => void
  onClose: () => void
}) {
  const editing = chunk != null
  const [label, setLabel] = useState(chunk?.label ?? "")
  const [expansion, setExpansion] = useState(chunk?.expansion ?? presetExpansion ?? "")
  const [color, setColor] = useState(chunk?.color || "#6B7280")
  const [categoryId, setCategoryId] = useState(ROOT_ID)

  useEffect(() => {
    setLabel(chunk?.label ?? "")
    setExpansion(chunk?.expansion ?? presetExpansion ?? "")
    setColor(chunk?.color || "#6B7280")
    setCategoryId(ROOT_ID)
  }, [sessionKey])

  const valid = label.trim().length > 0 && expansion.trim().length > 0

  return (
    <NavigationStack>
      <ScrollView
        navigationTitle={editing ? "编辑 chunk" : "新建 chunk"}
        navigationBarTitleDisplayMode="inline"
        background={PAGE_BG}
        scrollDismissesKeyboard="interactively"
        toolbar={{
          topBarLeading: [<Button title="取消" action={onClose} />],
          topBarTrailing: [
            <Button
              title="保存"
              disabled={!valid}
              action={() => {
                if (!valid) return
                onSave({ label: label.trim(), expansion: expansion.trim(), color, categoryId })
                onClose()
              }}
            />,
          ],
        }}
      >
        <VStack spacing={14} padding={{ horizontal: 14, top: 6, bottom: 20 }}>
          <Card title="名称" systemImage="tag">
            <Well padding={8}>
              <TextField
                title="名称"
                value={label}
                onChanged={setLabel}
                prompt="显示在标签上的名字"
                labelsHidden
                autocorrectionDisabled
              />
            </Well>
            <Text font={11} foregroundStyle="tertiaryLabel">
              只用于显示，不会进入提示词。
            </Text>
          </Card>

          <Card title="内容" systemImage="text.alignleft">
            <Well padding={8}>
              <TextField
                title="内容"
                value={expansion}
                onChanged={setExpansion}
                prompt="watercolor, soft edges"
                axis="vertical"
                lineLimit={{ min: 3, max: 8 }}
                labelsHidden
                autocorrectionDisabled
                textInputAutocapitalization="never"
              />
            </Well>
            <Text font={11} foregroundStyle="tertiaryLabel">
              这段才是真正插进提示词的文本。
            </Text>
          </Card>

          <Card title="颜色" systemImage="paintpalette">
            <FlowLayout spacing={8}>
              {SWATCHES.map((swatch) => (
                <Button buttonStyle="plain" action={() => setColor(swatch)}>
                  <RoundedRectangle
                    cornerRadius={RADIUS_CHIP}
                    fill={swatch as any}
                    stroke={
                      color === swatch
                        ? { shapeStyle: "label" as any, strokeStyle: { lineWidth: 2 } }
                        : undefined
                    }
                    frame={{ width: 36, height: 28 }}
                  />
                </Button>
              ))}
            </FlowLayout>
          </Card>

          {editing ? null : (
            <Card title="分类" systemImage="folder">
              <FlowLayout spacing={8}>
                <Chip
                  label="未分类"
                  selected={categoryId === ROOT_ID}
                  onTap={() => setCategoryId(ROOT_ID)}
                />
                {categories.map((category) => (
                  <Chip
                    label={category.label || category.id}
                    selected={categoryId === category.id}
                    onTap={() => setCategoryId(category.id)}
                  />
                ))}
              </FlowLayout>
            </Card>
          )}

          {editing && onDelete ? (
            <HStack frame={{ maxWidth: "infinity" }}>
              <Spacer />
              <Button
                title="删除这个 chunk"
                role="destructive"
                action={() => {
                  onDelete()
                  onClose()
                }}
                buttonStyle="bordered"
                controlSize="small"
              />
              <Spacer />
            </HStack>
          ) : null}

          <Text font={11} foregroundStyle="tertiaryLabel">
            改动先落在本机词库。要同步回 NovelAI 账户，去「词库」页用「推送到账户」——
            合并只加新的，更新会覆盖同名的。
          </Text>
        </VStack>
      </ScrollView>
    </NavigationStack>
  )
}
