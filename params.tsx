/**
 * The 参数 tab: everything you tune less often than once per generation.
 *
 * Pulled out of the generation screen so that screen can be the result plus one
 * row of controls. Ordered by how often it actually gets touched.
 */
import {
  Button,
  FlowLayout,
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
  DIM_STEP,
  GenerateParams,
  MAX_PIXELS,
  MODELS,
  NOISE_SCHEDULES,
  QUALITY_PRESETS,
  SAMPLERS,
  OPUS_FREE_PIXELS,
  SIZE_PRESETS_1MP,
  SIZE_PRESETS_LARGE,
  UC_PRESETS,
  effectiveNegative,
  fitSize,
  maxDimensionFor,
  partnerWithin,
  snapDimension,
  supportsLightQuality,
  supportsNoiseSchedule,
  supportsSmea,
  supportsTransparent,
  supportsVariety,
} from "./nai"
import { Workbench } from "./workbench"
import { Card, Chip, FieldLabel, MenuField, SliderRow, SwitchRow, Well } from "./ui"
import { ACCENT, PAGE_BG } from "./theme"

function ratioLabel(width: number, height: number): string {
  const divisor = (a: number, b: number): number => (b === 0 ? a : divisor(b, a % b))
  const g = divisor(width, height) || 1
  return `${width / g}:${height / g}`
}

export function ParamsTab({ wb }: { wb: Workbench }) {
  const { params, patch } = wb
  const [advanced, setAdvanced] = useState(false)
  // On by default: staying inside the free allowance is what most sessions want,
  // and it is the constraint people forget until the Anlas is gone.
  const [lockFree, setLockFree] = useState(true)
  // Committed on blur, not per keystroke — snapping mid-edit fights the user.
  const [widthText, setWidthText] = useState(String(params.width))
  const [heightText, setHeightText] = useState(String(params.height))

  // This tab stays mounted, so the fields would keep showing the old numbers
  // after a size preset or 复用参数 changed them somewhere else. Typing is
  // unaffected: nothing patches until blur, and blur commits the same value.
  useEffect(() => {
    setWidthText(String(params.width))
    setHeightText(String(params.height))
  }, [params.width, params.height])

  const applySize = (width: number, height: number) => {
    // A preset is an explicit choice; picking a large one turns the lock off
    // rather than silently shrinking what was just tapped.
    if (width * height > OPUS_FREE_PIXELS) setLockFree(false)
    const fitted = fitSize(width, height)
    setWidthText(String(fitted.width))
    setHeightText(String(fitted.height))
    patch({ width: fitted.width, height: fitted.height })
  }

  // With the 1 MP lock on, fixing one side pulls the other down to fit rather
  // than rejecting the edit — you asked for that width, so the height gives way.
  const commitWidth = () => {
    const width = Math.min(
      snapDimension(Number(widthText), params.width),
      maxDimensionFor(params.height),
    )
    const height = lockFree
      ? Math.min(params.height, partnerWithin(width))
      : params.height
    setWidthText(String(width))
    setHeightText(String(height))
    patch({ width, height })
  }

  const commitHeight = () => {
    const height = Math.min(
      snapDimension(Number(heightText), params.height),
      maxDimensionFor(params.width),
    )
    const width = lockFree ? Math.min(params.width, partnerWithin(height)) : params.width
    setHeightText(String(height))
    setWidthText(String(width))
    patch({ width, height })
  }

  return (
    <NavigationStack>
      <ScrollView
        navigationTitle="参数"
        navigationBarTitleDisplayMode="inline"
        background={PAGE_BG}
        scrollDismissesKeyboard="interactively"
      >
        <VStack spacing={14} padding={{ horizontal: 14, top: 6, bottom: 20 }}>
          <Card title="模型" systemImage="cpu">
            <MenuField
              value={params.model}
              options={MODELS}
              onChanged={(id) => patch({ model: id })}
            />
            <FieldLabel text="质量词" />
            <FlowLayout spacing={8}>
              {QUALITY_PRESETS.map((preset) => (
                <Chip
                  label={preset.label}
                  selected={params.qualityPreset === preset.id}
                  disabled={preset.id === "light" && !supportsLightQuality(params.model)}
                  onTap={() =>
                    patch({ qualityPreset: preset.id as GenerateParams["qualityPreset"] })
                  }
                />
              ))}
            </FlowLayout>
          </Card>

          <Card
            title="尺寸"
            systemImage="aspectratio"
            trailing={
              <Text font={11} fontDesign="monospaced" foregroundStyle="tertiaryLabel">
                {ratioLabel(params.width, params.height)} ·{" "}
                {((params.width * params.height) / 1048576).toFixed(2)} MP
              </Text>
            }
          >
            <FieldLabel text="1 MP 以内" hint="Opus 免费额度" />
            <FlowLayout spacing={8}>
              {SIZE_PRESETS_1MP.map((preset) => (
                <Chip
                  label={preset.label}
                  selected={
                    params.width === preset.width && params.height === preset.height
                  }
                  onTap={() => applySize(preset.width, preset.height)}
                />
              ))}
            </FlowLayout>
            <FieldLabel text="大图" hint="超出免费额度，按 Anlas 计费" />
            <FlowLayout spacing={8}>
              {SIZE_PRESETS_LARGE.map((preset) => (
                <Chip
                  label={preset.label}
                  selected={
                    params.width === preset.width && params.height === preset.height
                  }
                  onTap={() => applySize(preset.width, preset.height)}
                />
              ))}
            </FlowLayout>
            <HStack spacing={10} frame={{ maxWidth: "infinity" }}>
              <Well padding={8}>
                <FieldLabel text="宽" />
                <TextField
                  title="宽"
                  value={widthText}
                  onChanged={setWidthText}
                  onBlur={commitWidth}
                  onSubmit={commitWidth}
                  keyboardType="numberPad"
                  labelsHidden
                />
              </Well>
              <Well padding={8}>
                <FieldLabel text="高" />
                <TextField
                  title="高"
                  value={heightText}
                  onChanged={setHeightText}
                  onBlur={commitHeight}
                  onSubmit={commitHeight}
                  keyboardType="numberPad"
                  labelsHidden
                />
              </Well>
            </HStack>
            <SwitchRow
              title="限制在 1 MP 内"
              subtitle="改一边自动收另一边，保持在 Opus 免费额度内"
              value={lockFree}
              onChanged={setLockFree}
            />
            <Text font={11} foregroundStyle="tertiaryLabel">
              失焦后按 {DIM_STEP} 的倍数校准。总像素上限{" "}
              {(MAX_PIXELS / 1048576).toFixed(0)} MP；免费额度是 1 MP 且 ≤28 步。
            </Text>
          </Card>

          <Card title="采样" systemImage="slider.horizontal.3">
            <SliderRow
              title="Steps"
              value={params.steps}
              min={1}
              max={50}
              step={1}
              display={String(params.steps)}
              onChanged={(value) => patch({ steps: Math.round(value) })}
            />
            <SliderRow
              title="Prompt Guidance"
              value={params.guidance}
              min={0}
              max={10}
              step={0.1}
              display={params.guidance.toFixed(1)}
              onChanged={(value) => patch({ guidance: Math.round(value * 10) / 10 })}
            />
            <FieldLabel text="采样器" />
            <MenuField
              value={params.sampler}
              options={SAMPLERS}
              onChanged={(id) => patch({ sampler: id })}
            />
          </Card>

          <Card
            title="负面提示词"
            systemImage="nosign"
            trailing={
              <Button
                title="编辑"
                action={() => wb.editPrompt("negative")}
                buttonStyle="borderless"
                controlSize="small"
                tint={ACCENT}
              />
            }
          >
            <Text
              font={13}
              foregroundStyle={params.negative.trim() ? "label" : "tertiaryLabel"}
              lineLimit={3}
            >
              {params.negative.trim() || "（空）"}
            </Text>
            <FieldLabel text="Undesired Content 预设" />
            <FlowLayout spacing={8}>
              {UC_PRESETS.map((preset) => (
                <Chip
                  label={`${preset.label} · ${preset.note}`}
                  selected={params.ucPreset === preset.id}
                  onTap={() => patch({ ucPreset: preset.id })}
                />
              ))}
            </FlowLayout>
            <Text font={11} foregroundStyle="tertiaryLabel" lineLimit={2}>
              {effectiveNegative(params) || "—"}
            </Text>
          </Card>

          <Card
            title="高级"
            systemImage="gearshape.2"
            trailing={
              <Button
                title={advanced ? "收起" : "展开"}
                action={() => setAdvanced(!advanced)}
                buttonStyle="borderless"
                controlSize="small"
                tint={ACCENT}
              />
            }
          >
            {advanced ? (
              <VStack
                alignment="leading"
                spacing={12}
                frame={{ maxWidth: "infinity", alignment: "leading" }}
              >
                <SliderRow
                  title="Guidance Rescale"
                  value={params.rescale}
                  min={0}
                  max={1}
                  step={0.02}
                  display={params.rescale.toFixed(2)}
                  onChanged={(value) => patch({ rescale: Math.round(value * 50) / 50 })}
                />
                <FieldLabel
                  text="噪声调度"
                  hint={supportsNoiseSchedule(params.model) ? undefined : "V5 固定 Karras"}
                />
                <MenuField
                  value={
                    supportsNoiseSchedule(params.model) ? params.noiseSchedule : "karras"
                  }
                  options={NOISE_SCHEDULES}
                  onChanged={(id) => patch({ noiseSchedule: id })}
                />
                <SwitchRow
                  title="Variety+"
                  subtitle="跳过高 sigma 的 CFG，构图更发散"
                  value={params.variety}
                  disabled={!supportsVariety(params.model)}
                  onChanged={(value) => patch({ variety: value })}
                />
                <SwitchRow
                  title="透明背景"
                  subtitle="仅 V5 支持"
                  value={params.transparent}
                  disabled={!supportsTransparent(params.model)}
                  onChanged={(value) => patch({ transparent: value })}
                />
                <SwitchRow
                  title="SMEA"
                  subtitle="仅 V3 / Furry V3"
                  value={params.smea}
                  disabled={!supportsSmea(params.model)}
                  onChanged={(value) => patch({ smea: value })}
                />
                <SwitchRow
                  title="SMEA DYN"
                  subtitle="需要先开启 SMEA"
                  value={params.smeaDyn}
                  disabled={!supportsSmea(params.model) || !params.smea}
                  onChanged={(value) => patch({ smeaDyn: value })}
                />
              </VStack>
            ) : (
              <Text font={12} foregroundStyle="tertiaryLabel">
                Rescale、噪声调度、Variety+、透明背景、SMEA。默认值适用于大多数情况。
              </Text>
            )}
          </Card>

          <HStack frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Spacer />
            <Text font={11} foregroundStyle="tertiaryLabel">
              参数会自动保存
            </Text>
            <Spacer />
          </HStack>
        </VStack>
      </ScrollView>
    </NavigationStack>
  )
}
