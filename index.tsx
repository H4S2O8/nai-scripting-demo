/**
 * NovelAI generation workbench for the Scripting app.
 *
 * A phone-shaped rebuild of NovelAI's basic image page: prompt / undesired
 * content, model, size, and the sampling parameters, with the result canvas and
 * a local history. The request payload lives in nai.ts.
 */
import {
  Button,
  FlowLayout,
  Group,
  HStack,
  Image,
  Menu,
  Navigation,
  NavigationStack,
  ProgressView,
  RoundedRectangle,
  Script,
  ScrollView,
  Spacer,
  Stepper,
  Text,
  TextField,
  VStack,
  useEffect,
  useMemo,
  useState,
} from "scripting"

import {
  Account,
  DIM_STEP,
  GeneratedImage,
  GenerateParams,
  MAX_PIXELS,
  MODELS,
  NOISE_SCHEDULES,
  QUALITY_PRESETS,
  SAMPLERS,
  SIZE_PRESETS,
  UC_PRESETS,
  effectiveNegative,
  effectivePrompt,
  estimateAnlas,
  fetchAccount,
  fitSize,
  generateOne,
  isOpus,
  loadToken,
  looksLikeToken,
  maxDimensionFor,
  modelLabel,
  rollSeed,
  saveToPhotos,
  snapDimension,
  supportsLightQuality,
  supportsNoiseSchedule,
  supportsSmea,
  supportsTransparent,
  supportsVariety,
} from "./nai"
import {
  clearHistory,
  loadHistory,
  loadParams,
  pushHistory,
  removeHistory,
  saveParams,
} from "./store"
import { AccountSheet } from "./settings"
import { ChunksPage } from "./chunkspage"
import { Chunk, loadCache } from "./chunks"
import { Card, Chip, FieldLabel, SliderRow, StatPill, SwitchRow, Well } from "./ui"
import {
  ACCENT,
  ACCENT_GRADIENT,
  CANVAS_GRADIENT,
  CARD_BG,
  CARD_STROKE,
  PAGE_BG,
  RADIUS_CARD,
  RADIUS_WELL,
  WELL_BG,
} from "./theme"

const CANVAS_HEIGHT = 330

/** Read once at import: useState's lazy-initializer form is not relied on. */
const INITIAL_PARAMS = loadParams()

function ratioLabel(width: number, height: number): string {
  const divisor = (a: number, b: number): number => (b === 0 ? a : divisor(b, a % b))
  const g = divisor(width, height) || 1
  return `${width / g}:${height / g}`
}

function megapixels(width: number, height: number): string {
  return ((width * height) / 1048576).toFixed(2) + " MP"
}

/** A tappable row that opens a menu — used for model / sampler / schedule. */
function MenuField({
  value,
  options,
  onChanged,
}: {
  value: string
  options: { id: string; label: string; note?: string }[]
  onChanged: (id: string) => void
}) {
  const current = options.find((item) => item.id === value)
  return (
    <Menu
      label={
        <HStack
          spacing={8}
          padding={{ horizontal: 12, vertical: 10 }}
          frame={{ maxWidth: "infinity" }}
          background={<RoundedRectangle cornerRadius={RADIUS_WELL} fill={WELL_BG} />}
        >
          <Text font={14} fontWeight="medium" foregroundStyle="label">
            {current ? current.label : value}
          </Text>
          {current && current.note ? (
            <Text font={12} foregroundStyle="tertiaryLabel">
              {current.note}
            </Text>
          ) : null}
          <Spacer />
          <Image systemName="chevron.up.chevron.down" font={11} foregroundStyle={ACCENT} />
        </HStack>
      }
    >
      {options.map((item) => (
        <Button
          key={item.id}
          title={item.note ? `${item.label} · ${item.note}` : item.label}
          action={() => onChanged(item.id)}
        />
      ))}
    </Menu>
  )
}

function MainView() {
  const [token, setToken] = useState("")
  const [account, setAccount] = useState<Account | null>(null)
  const [params, setParams] = useState<GenerateParams>(INITIAL_PARAMS)
  const [history, setHistory] = useState<GeneratedImage[]>([])
  const [current, setCurrent] = useState<GeneratedImage | null>(null)

  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [status, setStatus] = useState("准备就绪")

  const [accountOpen, setAccountOpen] = useState(false)
  const [chunksOpen, setChunksOpen] = useState(false)
  const [chunkCache, setChunkCache] = useState<Chunk[]>([])
  const [viewerOpen, setViewerOpen] = useState(false)
  const [advanced, setAdvanced] = useState(false)

  const [toastText, setToastText] = useState("")
  const [toastOn, setToastOn] = useState(false)

  // Committed on blur, not per keystroke — snapping mid-edit fights the user.
  const [widthText, setWidthText] = useState(String(params.width))
  const [heightText, setHeightText] = useState(String(params.height))
  const [seedText, setSeedText] = useState(params.seed > 0 ? String(params.seed) : "")

  useEffect(() => {
    const saved = loadToken()
    if (saved) setToken(saved)
    setHistory(loadHistory())
    setChunkCache(loadCache())
    if (saved && looksLikeToken(saved)) {
      fetchAccount(saved)
        .then(setAccount)
        .catch(() => {
          /* the account chip just stays empty */
        })
    }
  }, [])

  const quote = useMemo(() => estimateAnlas(params, account), [params, account])
  const promptPreview = useMemo(() => effectivePrompt(params), [params])
  const negativePreview = useMemo(() => effectiveNegative(params), [params])

  const patch = (next: Partial<GenerateParams>) => {
    setParams((prev) => {
      const merged = { ...prev, ...next }
      saveParams(merged)
      return merged
    })
  }

  const toast = (message: string) => {
    setToastText(message)
    setToastOn(true)
  }

  /** Append a chunk's expansion to the prompt, skipping tags already present. */
  const insertChunk = (chunk: Chunk) => {
    const tag = (chunk.expansion || chunk.label || "").trim()
    if (!tag) {
      toast("这个 chunk 是空的")
      return
    }
    const current = params.prompt.trim()
    const present = current
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)
    const additions = tag
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part && present.indexOf(part.toLowerCase()) === -1)
    if (additions.length === 0) {
      toast("已经在提示词里了")
      return
    }
    const merged = additions.join(", ")
    patch({ prompt: current ? current + ", " + merged : merged })
    toast("已加入「" + (chunk.label || chunk.id) + "」")
  }

  const applySize = (width: number, height: number) => {
    const fitted = fitSize(width, height)
    setWidthText(String(fitted.width))
    setHeightText(String(fitted.height))
    patch({ width: fitted.width, height: fitted.height })
  }

  const commitWidth = () => {
    const value = Math.min(
      snapDimension(Number(widthText), params.width),
      maxDimensionFor(params.height),
    )
    setWidthText(String(value))
    patch({ width: value })
  }

  const commitHeight = () => {
    const value = Math.min(
      snapDimension(Number(heightText), params.height),
      maxDimensionFor(params.width),
    )
    setHeightText(String(value))
    patch({ height: value })
  }

  const commitSeed = () => {
    const parsed = Math.floor(Number(seedText))
    const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
    setSeedText(value > 0 ? String(value) : "")
    patch({ seed: value })
  }

  const generate = async () => {
    const key = token.trim()
    if (!looksLikeToken(key)) {
      setAccountOpen(true)
      toast("请先配置 API Token")
      return
    }
    if (!params.prompt.trim()) {
      toast("提示词不能为空")
      return
    }

    saveParams(params)
    setBusy(true)
    let items = history
    let produced = 0

    for (let index = 0; index < params.batch; index++) {
      setProgress({ done: index, total: params.batch })
      setStatus(`正在生成 ${index + 1}/${params.batch}…`)
      try {
        const seed = params.seed > 0 ? params.seed : rollSeed()
        const image = await generateOne(key, params, seed)
        items = pushHistory(items, image)
        setHistory(items)
        setCurrent(image)
        produced += 1
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error))
        setBusy(false)
        setProgress({ done: 0, total: 0 })
        toast(produced > 0 ? `已完成 ${produced} 张后中断` : "生成失败")
        return
      }
    }

    setBusy(false)
    setProgress({ done: 0, total: 0 })
    setStatus(`完成 ${produced} 张`)
    if (!quote.free && quote.total > 0) {
      // Refresh the balance so the next estimate is compared against real Anlas.
      fetchAccount(key)
        .then(setAccount)
        .catch(() => {
          /* keep the previous reading */
        })
    }
  }

  const saveToAlbum = async () => {
    if (!current) return
    try {
      const ok = await saveToPhotos(current)
      toast(ok ? "已保存到相册" : "保存被取消")
    } catch (error) {
      toast(error instanceof Error ? error.message : "保存失败")
    }
  }

  const share = async () => {
    if (!current) return
    try {
      await ShareSheet.present([current.path])
    } catch (error) {
      toast(error instanceof Error ? error.message : "分享失败")
    }
  }

  const canvas = current ? (
    <VStack
      frame={{ maxWidth: "infinity", height: CANVAS_HEIGHT }}
      background={<RoundedRectangle cornerRadius={RADIUS_WELL} fill={WELL_BG} />}
      onTapGesture={() => setViewerOpen(true)}
    >
      <Image
        filePath={current.path}
        resizable
        scaleToFit
        clipShape={{ type: "rect", cornerRadius: RADIUS_WELL }}
      />
    </VStack>
  ) : (
    <RoundedRectangle
      cornerRadius={RADIUS_WELL}
      fill={CANVAS_GRADIENT}
      frame={{ maxWidth: "infinity", height: CANVAS_HEIGHT }}
      overlay={
        <VStack spacing={8}>
          <Image systemName="photo.artframe" font={30} foregroundStyle={ACCENT} />
          <Text font={15} fontWeight="semibold" foregroundStyle="label">
            准备开始创作
          </Text>
          <Text font={12} foregroundStyle="secondaryLabel">
            写好提示词，选参数，结果会显示在这里
          </Text>
        </VStack>
      }
    />
  )

  return (
    <NavigationStack>
      <ScrollView
        navigationTitle="NovelAI"
        navigationBarTitleDisplayMode="inline"
        background={PAGE_BG}
        scrollDismissesKeyboard="interactively"
        toolbar={{
          topBarTrailing: [
            <Button
              systemImage="square.grid.2x2"
              title="Chunks"
              action={() => setChunksOpen(true)}
            />,
            <Button
              systemImage="person.crop.circle"
              title="账号"
              action={() => setAccountOpen(true)}
            />,
          ],
        }}
        toast={{
          isPresented: toastOn,
          onChanged: setToastOn,
          message: toastText,
          position: "top",
        }}
        sheet={[
          {
            isPresented: accountOpen,
            onChanged: setAccountOpen,
            content: (
              <AccountSheet
                token={token}
                account={account}
                onTokenChanged={setToken}
                onAccountChanged={setAccount}
                onClose={() => setAccountOpen(false)}
              />
            ),
          },
          {
            isPresented: chunksOpen,
            onChanged: (value: boolean) => {
              setChunksOpen(value)
              // The page writes the local library; pick up whatever it left.
              if (!value) setChunkCache(loadCache())
            },
            content: (
              <ChunksPage
                generationToken={token}
                onInsert={insertChunk}
                onClose={() => {
                  setChunksOpen(false)
                  setChunkCache(loadCache())
                }}
              />
            ),
          },
          {
            isPresented: viewerOpen,
            onChanged: setViewerOpen,
            content: (
              <ViewerSheet image={current} onClose={() => setViewerOpen(false)} />
            ),
          },
        ]}
        safeAreaInset={{
          bottom: {
            alignment: "center",
            spacing: 0,
            content: (
              <VStack
                spacing={8}
                padding={{ horizontal: 14, top: 10, bottom: 8 }}
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
                    {quote.free
                      ? "Opus 免费额度内"
                      : `预计扣费 ${quote.total} Anlas`}
                  </Text>
                  <Spacer />
                  <Text font={12} foregroundStyle="tertiaryLabel">
                    {account && account.anlas != null
                      ? `余额 ${account.anlas}`
                      : status}
                  </Text>
                </HStack>
                <Button
                  buttonStyle="plain"
                  disabled={busy}
                  action={() => {
                    if (!busy) void generate()
                  }}
                >
                  <HStack
                    spacing={8}
                    padding={{ vertical: 14 }}
                    frame={{ maxWidth: "infinity" }}
                    background={
                      <RoundedRectangle cornerRadius={16} fill={ACCENT_GRADIENT} />
                    }
                    opacity={busy ? 0.6 : 1}
                  >
                    <Spacer />
                    {busy ? (
                      <ProgressView progressViewStyle="circular" tint="white" />
                    ) : (
                      <Image systemName="sparkles" font={15} foregroundStyle="white" />
                    )}
                    <Text font={16} fontWeight="semibold" foregroundStyle="white">
                      {busy
                        ? `生成中 ${progress.done + 1}/${progress.total}`
                        : params.batch > 1
                          ? `生成 ${params.batch} 张`
                          : "生成图片"}
                    </Text>
                    <Spacer />
                  </HStack>
                </Button>
              </VStack>
            ),
          },
        }}
      >
        <VStack spacing={14} padding={{ horizontal: 14, top: 6, bottom: 16 }}>
          {/* ---------------------------------------------------- canvas */}
          <Card>
            {canvas}
            {current ? (
              <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <StatPill label="seed" value={String(current.seed)} />
                <StatPill
                  label=""
                  value={`${current.width}×${current.height}`}
                  systemImage="aspectratio"
                />
                <Spacer />
                <Text font={11} foregroundStyle="tertiaryLabel">
                  {modelLabel(current.model)}
                </Text>
              </HStack>
            ) : null}
            {current ? (
              <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <Chip
                  label="存相册"
                  selected={false}
                  onTap={() => {
                    void saveToAlbum()
                  }}
                />
                <Chip
                  label="分享"
                  selected={false}
                  onTap={() => {
                    void share()
                  }}
                />
                <Chip
                  label="锁定 seed"
                  selected={params.seed === current.seed}
                  onTap={() => {
                    setSeedText(String(current.seed))
                    patch({ seed: current.seed })
                    toast("已锁定 seed " + current.seed)
                  }}
                />
                <Spacer />
              </HStack>
            ) : null}
          </Card>

          {/* ---------------------------------------------------- prompt */}
          <Card
            title="提示词"
            systemImage="text.alignleft"
            trailing={
              <Button
                title="Chunks"
                action={() => setChunksOpen(true)}
                buttonStyle="borderless"
                controlSize="small"
                tint={ACCENT}
              />
            }
          >
            <Well>
              <TextField
                title="提示词"
                value={params.prompt}
                onChanged={(value) => patch({ prompt: value })}
                prompt="1girl, looking at viewer, ..."
                axis="vertical"
                lineLimit={{ min: 4, max: 10 }}
                labelsHidden
                autocorrectionDisabled
                textInputAutocapitalization="never"
              />
            </Well>
            {chunkCache.filter((c) => !c.isCategory).length > 0 ? (
              <ScrollView axes="horizontal" scrollIndicator="hidden">
                <HStack spacing={8}>
                  {chunkCache
                    .filter((c) => !c.isCategory)
                    .slice(0, 24)
                    .map((chunk) => (
                      <Chip
                        label={chunk.label || chunk.id}
                        selected={false}
                        onTap={() => insertChunk(chunk)}
                      />
                    ))}
                </HStack>
              </ScrollView>
            ) : null}
            <FieldLabel
              text="实际发送"
              hint={promptPreview.length + " 字符"}
            />
            <Text font={11} foregroundStyle="tertiaryLabel" lineLimit={2}>
              {promptPreview || "—"}
            </Text>
          </Card>

          {/* --------------------------------------------------- negative */}
          <Card title="负面提示词" systemImage="nosign">
            <Well>
              <TextField
                title="负面提示词"
                value={params.negative}
                onChanged={(value) => patch({ negative: value })}
                prompt="额外不想要的内容"
                axis="vertical"
                lineLimit={{ min: 2, max: 6 }}
                labelsHidden
                autocorrectionDisabled
                textInputAutocapitalization="never"
              />
            </Well>
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
              {negativePreview || "—"}
            </Text>
          </Card>

          {/* ------------------------------------------------------ model */}
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

          {/* ------------------------------------------------------- size */}
          <Card
            title="尺寸"
            systemImage="aspectratio"
            trailing={
              <Text font={11} fontDesign="monospaced" foregroundStyle="tertiaryLabel">
                {ratioLabel(params.width, params.height)} · {megapixels(params.width, params.height)}
              </Text>
            }
          >
            <FlowLayout spacing={8}>
              {SIZE_PRESETS.map((preset) => (
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
            <Text font={11} foregroundStyle="tertiaryLabel">
              失焦后按 {DIM_STEP} 的倍数校准，总像素上限 {(MAX_PIXELS / 1048576).toFixed(0)} MP。
            </Text>
          </Card>

          {/* ----------------------------------------------------- params */}
          <Card
            title="参数"
            systemImage="slider.horizontal.3"
            trailing={
              <Button
                title={advanced ? "收起" : "高级"}
                action={() => setAdvanced(!advanced)}
                buttonStyle="borderless"
                controlSize="small"
                tint={ACCENT}
              />
            }
          >
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
            <FieldLabel text="Seed" hint={params.seed > 0 ? "已锁定" : "每张随机"} />
            <HStack spacing={10} frame={{ maxWidth: "infinity" }}>
              <Well padding={8}>
                <TextField
                  title="Seed"
                  value={seedText}
                  onChanged={setSeedText}
                  onBlur={commitSeed}
                  onSubmit={commitSeed}
                  prompt="留空=随机"
                  keyboardType="numberPad"
                  labelsHidden
                />
              </Well>
              <Chip
                label="掷一次"
                selected={false}
                onTap={() => {
                  const seed = rollSeed()
                  setSeedText(String(seed))
                  patch({ seed })
                }}
              />
              <Chip
                label="随机"
                selected={params.seed === 0}
                onTap={() => {
                  setSeedText("")
                  patch({ seed: 0 })
                }}
              />
            </HStack>
            <Stepper
              title={`一次生成 ${params.batch} 张`}
              onIncrement={() => patch({ batch: Math.min(8, params.batch + 1) })}
              onDecrement={() => patch({ batch: Math.max(1, params.batch - 1) })}
            />

            {advanced ? (
              <VStack alignment="leading" spacing={12} frame={{ maxWidth: "infinity", alignment: "leading" }}>
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
                  value={supportsNoiseSchedule(params.model) ? params.noiseSchedule : "karras"}
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
            ) : null}
          </Card>

          {/* ---------------------------------------------------- history */}
          <Card
            title="历史"
            systemImage="clock.arrow.circlepath"
            trailing={
              history.length > 0 ? (
                <Button
                  title="清空"
                  role="destructive"
                  action={() => {
                    setHistory(clearHistory(history))
                    setCurrent(null)
                    toast("已清空历史")
                  }}
                  buttonStyle="borderless"
                  controlSize="small"
                />
              ) : null
            }
          >
            {history.length === 0 ? (
              <Text font={12} foregroundStyle="tertiaryLabel">
                还没有生成记录。图片保存在脚本的 Documents/NAI-Studio 下。
              </Text>
            ) : (
              <ScrollView axes="horizontal" scrollIndicator="hidden">
                <HStack spacing={8}>
                  {history.map((item) => (
                    <Image
                      key={item.path}
                      filePath={item.path}
                      resizable
                      scaleToFill
                      frame={{ width: 66, height: 66 }}
                      clipShape={{ type: "rect", cornerRadius: 10 }}
                      onTapGesture={() => setCurrent(item)}
                      contextMenu={{
                        menuItems: (
                          <Group>
                            <Button
                              title="删除"
                              role="destructive"
                              action={() => {
                                setHistory(removeHistory(history, item.path))
                                if (current && current.path === item.path) setCurrent(null)
                              }}
                            />
                          </Group>
                        ),
                      }}
                    />
                  ))}
                </HStack>
              </ScrollView>
            )}
          </Card>

          <Text font={11} foregroundStyle="tertiaryLabel" multilineTextAlignment="center">
            {isOpus(account)
              ? "Opus 订阅：1 MP 以内、28 步以内的文生图不扣 Anlas。"
              : "非 Opus 账户每张都会扣 Anlas，估算按官方前端公式计算。"}
          </Text>
        </VStack>
      </ScrollView>
    </NavigationStack>
  )
}

/** Full-bleed viewer for the current result. */
function ViewerSheet({
  image,
  onClose,
}: {
  image: GeneratedImage | null
  onClose: () => void
}) {
  return (
    <NavigationStack>
      <ScrollView
        navigationTitle={image ? `seed ${image.seed}` : "预览"}
        navigationBarTitleDisplayMode="inline"
        background={PAGE_BG}
        toolbar={{ topBarTrailing: [<Button title="完成" action={onClose} />] }}
      >
        <VStack spacing={12} padding={14}>
          {image ? (
            <Image
              filePath={image.path}
              resizable
              scaleToFit
              frame={{ maxWidth: "infinity" }}
              clipShape={{ type: "rect", cornerRadius: RADIUS_CARD }}
            />
          ) : (
            <Text font={13} foregroundStyle="secondaryLabel">
              没有可预览的图片。
            </Text>
          )}
          {image ? (
            <VStack
              alignment="leading"
              spacing={8}
              padding={14}
              frame={{ maxWidth: "infinity", alignment: "leading" }}
              background={
                <RoundedRectangle
                  cornerRadius={RADIUS_CARD}
                  fill={CARD_BG}
                  stroke={{ shapeStyle: CARD_STROKE, strokeStyle: { lineWidth: 1 } }}
                />
              }
            >
              <HStack spacing={8}>
                <StatPill label="模型" value={modelLabel(image.model)} />
                <StatPill label="" value={`${image.width}×${image.height}`} />
                <Spacer />
              </HStack>
              <Text font={12} foregroundStyle="secondaryLabel">
                {image.prompt || "—"}
              </Text>
              <Text font={11} fontDesign="monospaced" foregroundStyle="tertiaryLabel">
                {image.path}
              </Text>
            </VStack>
          ) : null}
        </VStack>
      </ScrollView>
    </NavigationStack>
  )
}

async function run() {
  await Navigation.present({ element: <MainView /> })
  Script.exit()
}

run()
