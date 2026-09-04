/**
 * The 生成 tab: canvas first, controls compressed to one row.
 *
 * This is the screen you sit on while iterating, so the result gets all the
 * height that is left over and everything else is a single tap away. The
 * prompt is a preview that opens the full-screen editor; anything you tune
 * less than once per generation lives in the 参数 tab.
 */
import {
  Button,
  HStack,
  Image,
  Menu,
  Navigation,
  NavigationStack,
  ProgressView,
  RoundedRectangle,
  ScrollView,
  Script,
  Spacer,
  Text,
  VStack,
} from "scripting"

import { SIZE_PRESETS, maxCharacterPrompts, modelLabel, rollSeed } from "./nai"
import { summarizePrompt } from "./prompttokens"
import { CAN_MINIMIZE, VERSION, Workbench } from "./workbench"
import { Chip, IconButton, PrimaryButton } from "./ui"
import {
  ACCENT,
  CANVAS_GRADIENT,
  CARD_BG,
  CARD_STROKE,
  PAGE_BG,
  RADIUS_CARD,
  RADIUS_WELL,
  WELL_BG,
} from "./theme"

/** One line of prompt, tappable into the full-screen editor. */
function PromptRow({
  icon,
  label,
  text,
  placeholder,
  onTap,
  emphasis,
}: {
  icon: string
  label: string
  text: string
  placeholder: string
  onTap: () => void
  emphasis?: boolean
}) {
  const filled = text.trim().length > 0
  return (
    <HStack
      spacing={8}
      padding={{ horizontal: 11, vertical: 9 }}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      background={
        <RoundedRectangle
          cornerRadius={RADIUS_WELL}
          fill={CARD_BG}
          stroke={{
            shapeStyle: emphasis === true ? { color: ACCENT, opacity: 0.35 } : CARD_STROKE,
            strokeStyle: { lineWidth: 1 },
          }}
        />
      }
      onTapGesture={onTap}
    >
      <Image systemName={icon} font={11} foregroundStyle={ACCENT} />
      <Text font={11} fontWeight="medium" foregroundStyle="secondaryLabel">
        {label}
      </Text>
      <Text
        font={12}
        foregroundStyle={filled ? "label" : "tertiaryLabel"}
        lineLimit={1}
      >
        {filled ? summarizePrompt(text) : placeholder}
      </Text>
      <Spacer />
      <Image systemName="chevron.right" font={9} foregroundStyle="tertiaryLabel" />
    </HStack>
  )
}

export function GenerateTab({ wb }: { wb: Workbench }) {
  const dismiss = Navigation.useDismiss()
  const { params, current, history, busy, progress, quote, account } = wb

  const sizeLabel =
    SIZE_PRESETS.find((p) => p.width === params.width && p.height === params.height)
      ?.label ?? `${params.width}×${params.height}`

  const characterCount = (params.characters ?? []).filter((c) => c.prompt.trim()).length

  const canvas = current ? (
    <VStack
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      background={<RoundedRectangle cornerRadius={RADIUS_CARD} fill={WELL_BG} />}
      onTapGesture={wb.openViewer}
    >
      <Image
        filePath={current.path}
        resizable
        scaleToFit
        clipShape={{ type: "rect", cornerRadius: RADIUS_CARD }}
      />
    </VStack>
  ) : (
    <RoundedRectangle
      cornerRadius={RADIUS_CARD}
      fill={CANVAS_GRADIENT}
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      overlay={
        <VStack spacing={8}>
          <Image systemName="photo.artframe" font={32} foregroundStyle={ACCENT} />
          <Text font={15} fontWeight="semibold" foregroundStyle="label">
            准备开始创作
          </Text>
          <Text font={12} foregroundStyle="secondaryLabel">
            写好提示词，点下面的生成
          </Text>
        </VStack>
      }
    />
  )

  return (
    <NavigationStack>
      <VStack
        navigationTitle={"NovelAI · v" + VERSION}
        navigationBarTitleDisplayMode="inline"
        background={PAGE_BG}
        spacing={10}
        padding={{ horizontal: 12, top: 6, bottom: 4 }}
        frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}
        toolbar={{
          // Full-screen presentation has no swipe-down, so both exits are here.
          topBarLeading: CAN_MINIMIZE
            ? [
                <Button
                  systemImage="arrow.down.right.and.arrow.up.left"
                  title="最小化"
                  action={() => {
                    void Script.minimize()
                  }}
                />,
                <Button systemImage="xmark" title="关闭" action={() => dismiss()} />,
              ]
            : [<Button systemImage="xmark" title="关闭" action={() => dismiss()} />],
          topBarTrailing: [
            <Button
              systemImage="person.crop.circle"
              title="账号"
              action={wb.openAccount}
            />,
          ],
        }}
        safeAreaInset={{
          bottom: {
            alignment: "center",
            spacing: 0,
            content: (
              <VStack
                spacing={7}
                padding={{ horizontal: 12, top: 8, bottom: 6 }}
                frame={{ maxWidth: "infinity" }}
                background={CARD_BG}
              >
                <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <Image
                    systemName={quote.free ? "infinity" : "bolt.fill"}
                    font={11}
                    foregroundStyle={ACCENT}
                  />
                  <Text font={12} foregroundStyle="secondaryLabel">
                    {quote.free ? "Opus 免费额度内" : `预计 ${quote.total} Anlas`}
                  </Text>
                  <Spacer />
                  <Text font={12} foregroundStyle="tertiaryLabel">
                    {busy
                      ? wb.status
                      : account && account.anlas != null
                        ? `余额 ${account.anlas}`
                        : wb.status}
                  </Text>
                </HStack>
                <PrimaryButton
                  title={
                    busy
                      ? `生成中 ${progress.done + 1}/${progress.total}`
                      : params.batch > 1
                        ? `生成 ${params.batch} 张`
                        : "生成图片"
                  }
                  disabled={busy}
                  onTap={wb.generate}
                  leading={
                    busy ? (
                      <ProgressView progressViewStyle="circular" tint="white" />
                    ) : (
                      <Image systemName="sparkles" font={15} foregroundStyle="white" />
                    )
                  }
                />
              </VStack>
            ),
          },
        }}
      >
        {canvas}

        {current ? (
          <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font={11} fontDesign="monospaced" foregroundStyle="tertiaryLabel">
              {modelLabel(current.model)} · {current.width}×{current.height} · seed{" "}
              {current.seed}
            </Text>
            <Spacer />
            <IconButton
              systemImage="square.and.arrow.down"
              title=""
              onTap={() => wb.reuse(current)}
              active={params.seed === current.seed}
            />
          </HStack>
        ) : null}

        {history.length > 1 ? (
          <ScrollView axes="horizontal" scrollIndicator="hidden">
            <HStack spacing={7}>
              {history.slice(0, 12).map((item) => (
                <Image
                  key={item.path}
                  filePath={item.path}
                  resizable
                  scaleToFill
                  frame={{ width: 46, height: 46 }}
                  clipShape={{ type: "rect", cornerRadius: 8 }}
                  opacity={current && current.path === item.path ? 1 : 0.55}
                  onTapGesture={() => wb.showImage(item)}
                />
              ))}
            </HStack>
          </ScrollView>
        ) : null}

        {/* Three blocks, because they change on different cadences: the art
            style and the character usually stay put while the specific prompt
            is rewritten every generation. Each opens the same page editor. */}
        <VStack spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <PromptRow
            icon="paintpalette"
            label="艺术风格"
            text={params.stylePrompt}
            placeholder="画风、画师、媒介"
            onTap={() => wb.editPrompt({ kind: "style" })}
          />
          <PromptRow
            icon="person"
            label="人物"
            text={params.characterPrompt}
            placeholder="角色、外貌、服装"
            onTap={() => wb.editPrompt({ kind: "character" })}
          />
          <PromptRow
            icon="text.alignleft"
            label="特定"
            text={params.prompt}
            placeholder="这一张的动作、构图、场景"
            onTap={() => wb.editPrompt({ kind: "specific" })}
            emphasis
          />
        </VStack>

        {/* One row for the things that change between two generations. */}
        <ScrollView axes="horizontal" scrollIndicator="hidden">
          <HStack spacing={8}>
            <Menu
              label={
                <HStack
                  spacing={5}
                  padding={{ horizontal: 11, vertical: 8 }}
                  background={<RoundedRectangle cornerRadius={10} fill={WELL_BG} />}
                >
                  <Image systemName="aspectratio" font={12} foregroundStyle={ACCENT} />
                  <Text font={12} foregroundStyle="label">
                    {sizeLabel}
                  </Text>
                </HStack>
              }
            >
              {SIZE_PRESETS.map((preset) => (
                <Button
                  key={preset.label}
                  title={`${preset.label} · ${preset.width}×${preset.height}`}
                  action={() => wb.patch({ width: preset.width, height: preset.height })}
                />
              ))}
            </Menu>

            <Menu
              label={
                <HStack
                  spacing={5}
                  padding={{ horizontal: 11, vertical: 8 }}
                  background={<RoundedRectangle cornerRadius={10} fill={WELL_BG} />}
                >
                  <Image systemName="square.stack" font={12} foregroundStyle={ACCENT} />
                  <Text font={12} foregroundStyle="label">
                    {params.batch} 张
                  </Text>
                </HStack>
              }
            >
              {[1, 2, 3, 4, 6, 8].map((count) => (
                <Button
                  key={String(count)}
                  title={`${count} 张`}
                  action={() => wb.patch({ batch: count })}
                />
              ))}
            </Menu>

            <IconButton
              systemImage={params.seed > 0 ? "lock.fill" : "dice"}
              title={params.seed > 0 ? String(params.seed) : "随机 seed"}
              active={params.seed > 0}
              onTap={() => wb.patch({ seed: params.seed > 0 ? 0 : rollSeed() })}
            />
            {params.seed > 0 ? (
              <IconButton
                systemImage="arrow.clockwise"
                title="换一个"
                onTap={() => wb.patch({ seed: rollSeed() })}
              />
            ) : null}
            <Chip
              label={params.negative.trim() ? "负面 ✓" : "负面"}
              selected={params.negative.trim().length > 0}
              onTap={() => wb.editPrompt({ kind: "negative" })}
            />
            {maxCharacterPrompts(params.model) > 0 ? (
              <Chip
                label={
                  characterCount > 0 ? `角色 ${characterCount}` : "角色"
                }
                selected={characterCount > 0}
                onTap={wb.openCharacters}
              />
            ) : null}
          </HStack>
        </ScrollView>
      </VStack>
    </NavigationStack>
  )
}
