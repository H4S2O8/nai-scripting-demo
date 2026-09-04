/**
 * The chunk picker: categories you can collapse, chunks that toggle.
 *
 * Both behaviours are how the official client works, and both matter on a
 * phone. A flat list of every chunk is unusable at 200 entries, and a one-way
 * "insert" button means the only way to undo a tap is to go hunting in the
 * prompt for whatever it added.
 *
 * The collapsed set is stored per scope, so the art-style picker and the
 * character picker each remember their own shape.
 */
import {
  Button,
  FlowLayout,
  Group,
  HStack,
  Image,
  RoundedRectangle,
  Spacer,
  Text,
  VStack,
  useEffect,
  useState,
} from "scripting"

import { Chunk, ROOT_ID, groupChunks, loadCollapsed, saveCollapsed } from "./chunks"
import { chunkState } from "./prompttokens"
import { ACCENT, CHIP_BG, RADIUS_CHIP, RADIUS_WELL, WELL_BG } from "./theme"

/** A chunk's own colour, dimmed when it is not in the prompt. */
function ChunkChip({
  chunk,
  on,
  onTap,
  onEdit,
}: {
  chunk: Chunk
  on: boolean
  onTap: () => void
  onEdit?: () => void
}) {
  const empty = !(chunk.expansion ?? "").trim()
  const color = (chunk.color || "#6B7280") as any
  return (
    <Button
      buttonStyle="plain"
      disabled={empty}
      action={() => {
        if (!empty) onTap()
      }}
    >
      <HStack
        spacing={5}
        padding={{ horizontal: 11, vertical: 7 }}
        contextMenu={
          onEdit
            ? {
                menuItems: (
                  <Group>
                    <Button title="编辑" systemImage="pencil" action={onEdit} />
                  </Group>
                ),
              }
            : undefined
        }
        background={
          <RoundedRectangle
            cornerRadius={RADIUS_CHIP}
            fill={on ? { color, opacity: 0.9 } : CHIP_BG}
            stroke={
              on
                ? undefined
                : { shapeStyle: { color, opacity: 0.45 }, strokeStyle: { lineWidth: 1 } }
            }
          />
        }
      >
        {on ? (
          <Image systemName="checkmark" font={10} foregroundStyle="white" />
        ) : null}
        <Text
          font={13}
          fontWeight={on ? "semibold" : "regular"}
          foregroundStyle={empty ? "tertiaryLabel" : on ? "white" : "label"}
        >
          {chunk.label || chunk.id}
        </Text>
      </HStack>
    </Button>
  )
}

export function ChunkGrid({
  chunks,
  text,
  scope,
  onToggle,
  onEdit,
}: {
  chunks: Chunk[]
  /** The prompt these chunks toggle in and out of. */
  text: string
  /** Storage scope for the collapsed set. */
  scope: string
  onToggle: (chunk: Chunk) => void
  /** Long-press to edit. Only the library tab offers this. */
  onEdit?: (chunk: Chunk) => void
}) {
  const [collapsed, setCollapsed] = useState<string[]>([])

  useEffect(() => {
    setCollapsed(loadCollapsed(scope))
  }, [scope])

  const groups = groupChunks(chunks)

  const keyOf = (group: { category: Chunk | null }) =>
    group.category ? group.category.id : ROOT_ID

  const toggleGroup = (id: string) => {
    const next =
      collapsed.indexOf(id) === -1
        ? collapsed.concat(id)
        : collapsed.filter((item) => item !== id)
    setCollapsed(saveCollapsed(scope, next))
  }

  if (chunks.filter((c) => !c.isCategory).length === 0) {
    return (
      <Text font={12} foregroundStyle="tertiaryLabel">
        词库是空的。到「词库」标签页从账户拉取，或导入 JSON。
      </Text>
    )
  }

  return (
    <VStack
      alignment="leading"
      spacing={8}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
    >
      {groups.map((group) => {
        const id = keyOf(group)
        const shut = collapsed.indexOf(id) !== -1
        const activeCount = group.items.filter(
          (chunk) => chunkState(text, chunk) === "on",
        ).length
        const color = (group.category?.color || "#6B7280") as any

        return (
          <VStack
            key={id}
            alignment="leading"
            spacing={7}
            padding={9}
            frame={{ maxWidth: "infinity", alignment: "leading" }}
            background={<RoundedRectangle cornerRadius={RADIUS_WELL} fill={WELL_BG} />}
          >
            <Button buttonStyle="plain" action={() => toggleGroup(id)}>
              <HStack spacing={7} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <RoundedRectangle
                  cornerRadius={3}
                  fill={color}
                  frame={{ width: 10, height: 10 }}
                />
                <Text font={12} fontWeight="semibold" foregroundStyle="label">
                  {group.category ? group.category.label || group.category.id : "未分类"}
                </Text>
                <Text font={11} foregroundStyle="tertiaryLabel">
                  {activeCount > 0
                    ? `${activeCount}/${group.items.length}`
                    : String(group.items.length)}
                </Text>
                <Spacer />
                <Image
                  systemName={shut ? "chevron.right" : "chevron.down"}
                  font={10}
                  foregroundStyle={activeCount > 0 ? ACCENT : "tertiaryLabel"}
                />
              </HStack>
            </Button>

            {shut ? null : (
              <FlowLayout spacing={7}>
                {group.items.map((chunk) => (
                  <ChunkChip
                    key={chunk.id}
                    chunk={chunk}
                    on={chunkState(text, chunk) === "on"}
                    onTap={() => onToggle(chunk)}
                    onEdit={onEdit ? () => onEdit(chunk) : undefined}
                  />
                ))}
              </FlowLayout>
            )}
          </VStack>
        )
      })}
    </VStack>
  )
}
