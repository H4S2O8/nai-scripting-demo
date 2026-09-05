/**
 * The 素材 tab: every result as a grid.
 *
 * A horizontal strip on the generation screen is fine for the last few, but
 * comparing a session's worth of images needs a grid, and a grid needs the
 * whole screen.
 */
import {
  Button,
  ContentUnavailableView,
  Group,
  HStack,
  Image,
  LazyVGrid,
  NavigationStack,
  ScrollView,
  Spacer,
  Text,
  VStack,
  useEffect,
  useState,
} from "scripting"

import { modelLabel } from "./nai"
import { ArchiveState, archiveAll, archiveState, isArchived, pruneArchived } from "./archive"
import { Workbench } from "./workbench"
import { Card, StatPill } from "./ui"
import { ACCENT, PAGE_BG } from "./theme"

function dayLabel(ms: number): string {
  const date = new Date(ms)
  const today = new Date()
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  return sameDay ? "今天 " + time : `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

export function GalleryTab({ wb }: { wb: Workbench }) {
  const { history, current } = wb
  const [archive, setArchive] = useState<ArchiveState>({ available: false, dir: "", reason: "" })
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    setArchive(archiveState())
  }, [])

  const archivedCount = history.filter((item) => {
    void tick // recount after an archive run
    return isArchived(item, archive)
  }).length

  const runArchive = async () => {
    setBusy(true)
    try {
      const result = await archiveAll(history, archive)
      setTick((n) => n + 1)
      wb.toast(
        result.failed > 0
          ? `归档 ${result.copied} 张，${result.failed} 张失败：${result.lastError}`
          : `归档 ${result.copied} 张，已有 ${result.skipped} 张`,
      )
    } catch (error) {
      wb.toast(error instanceof Error ? error.message : "归档失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <NavigationStack>
      <ScrollView
        navigationTitle="素材"
        navigationBarTitleDisplayMode="inline"
        background={PAGE_BG}
        toolbar={{
          topBarTrailing:
            history.length > 0
              ? [
                  <Button
                    title="清空"
                    role="destructive"
                    action={wb.clearImages}
                  />,
                ]
              : [],
        }}
      >
        <VStack spacing={14} padding={{ horizontal: 14, top: 6, bottom: 20 }}>
          <Card title="归档到 iCloud" systemImage="icloud.and.arrow.up">
            {archive.available ? (
              <VStack alignment="leading" spacing={10} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <StatPill label="已归档" value={`${archivedCount}/${history.length}`} systemImage="checkmark.icloud" />
                  <Spacer />
                </HStack>
                <HStack spacing={10} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <Button
                    title={busy ? "归档中…" : "归档全部"}
                    action={() => {
                      if (!busy) void runArchive()
                    }}
                    buttonStyle="borderedProminent"
                    controlSize="small"
                    tint={ACCENT}
                    disabled={busy || history.length === 0}
                  />
                  <Button
                    title="删除已归档的本地副本"
                    role="destructive"
                    action={() => {
                      const { removed } = pruneArchived(history, archive)
                      setTick((n) => n + 1)
                      wb.toast(removed > 0 ? `已删除 ${removed} 个本地副本` : "没有可删的")
                    }}
                    buttonStyle="bordered"
                    controlSize="small"
                    disabled={busy || archivedCount === 0}
                  />
                  <Spacer />
                </HStack>
                <Text font={11} foregroundStyle="tertiaryLabel">
                  复制到 iCloud 云盘的 {"NAI-Studio"} 文件夹，在「文件」App 里能看到，也会同步到你其他设备。
                  只有确认云端副本存在的图片才会被删本地。
                </Text>
              </VStack>
            ) : (
              <Text font={12} foregroundStyle="secondaryLabel">
                {archive.reason}
              </Text>
            )}
          </Card>

          {history.length === 0 ? (
            <Card>
              <ContentUnavailableView
                title="还没有生成记录"
                systemImage="photo.on.rectangle.angled"
                description="生成的图片会保存在脚本的 Documents/NAI-Studio 下"
              />
            </Card>
          ) : (
            <VStack alignment="leading" spacing={10} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <StatPill label="共" value={String(history.length)} systemImage="photo.stack" />
                <Spacer />
                <Text font={11} foregroundStyle="tertiaryLabel">
                  点开查看 · 长按删除或复用参数
                </Text>
              </HStack>
              <LazyVGrid
                spacing={8}
                columns={[{ size: 110 }, { size: 110 }, { size: 110 }]}
              >
                {history.map((item) => (
                  <VStack key={item.path} spacing={4}>
                    <Image
                      filePath={item.path}
                      resizable
                      scaleToFill
                      frame={{ width: 108, height: 108 }}
                      clipShape={{ type: "rect", cornerRadius: 12 }}
                      opacity={current && current.path === item.path ? 1 : 0.85}
                      onTapGesture={() => wb.showImage(item)}
                      contextMenu={{
                        menuItems: (
                          <Group>
                            <Button
                              title="存相册"
                              systemImage="square.and.arrow.down"
                              action={() => wb.saveImage(item)}
                            />
                            <Button
                              title="分享"
                              systemImage="square.and.arrow.up"
                              action={() => wb.shareImage(item)}
                            />
                            <Button
                              title="复用参数"
                              systemImage="arrow.uturn.backward"
                              action={() => wb.reuse(item)}
                            />
                            <Button
                              title="删除"
                              role="destructive"
                              action={() => wb.removeImage(item.path)}
                            />
                          </Group>
                        ),
                      }}
                    />
                    <HStack spacing={3}>
                      {isArchived(item, archive) ? (
                        <Image systemName="checkmark.icloud" font={8} foregroundStyle={ACCENT} />
                      ) : null}
                      <Text font={9} foregroundStyle="tertiaryLabel" lineLimit={1}>
                        {dayLabel(item.createdAt)}
                      </Text>
                    </HStack>
                  </VStack>
                ))}
              </LazyVGrid>
            </VStack>
          )}

          {current ? (
            <Card title="当前选中" systemImage="checkmark.circle">
              <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <StatPill label="模型" value={modelLabel(current.model)} />
                <StatPill label="seed" value={String(current.seed)} />
                <Spacer />
              </HStack>
              <Text font={12} foregroundStyle="secondaryLabel" lineLimit={3}>
                {current.prompt || "—"}
              </Text>
              <HStack spacing={10} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <Button
                  title="查看大图"
                  action={wb.openViewer}
                  buttonStyle="bordered"
                  controlSize="small"
                  tint={ACCENT}
                />
                <Button
                  title="复用参数"
                  action={() => wb.reuse(current)}
                  buttonStyle="bordered"
                  controlSize="small"
                  tint={ACCENT}
                />
                <Button
                  title="存相册"
                  action={() => wb.saveImage(current)}
                  buttonStyle="bordered"
                  controlSize="small"
                  tint={ACCENT}
                />
                <Button
                  title="分享"
                  action={() => wb.shareImage(current)}
                  buttonStyle="bordered"
                  controlSize="small"
                  tint={ACCENT}
                />
                <Spacer />
              </HStack>
            </Card>
          ) : null}
        </VStack>
      </ScrollView>
    </NavigationStack>
  )
}
