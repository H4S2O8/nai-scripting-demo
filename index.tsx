/**
 * NovelAI generation workbench for the Scripting app.
 *
 * Structured around what a portrait phone actually does with it: the result and
 * the prompt each get a whole screen, because they are 90% of the time and want
 * opposite layouts; everything tuned less than once per generation moves to its
 * own tab. This file owns the shared state and the pages that float above the
 * tabs (prompt editor, viewer, account).
 */
import {
  Button,
  HStack,
  Image,
  Navigation,
  NavigationStack,
  RoundedRectangle,
  ScrollView,
  Script,
  Spacer,
  Tab,
  TabView,
  Text,
  VStack,
  useEffect,
  useMemo,
  useObservable,
  useState,
} from "scripting"

import {
  Account,
  GeneratedImage,
  GenerateParams,
  estimateAnlas,
  fetchAccount,
  generateOne,
  loadToken,
  looksLikeToken,
  modelLabel,
  rollSeed,
} from "./nai"
import { Chunk, loadCache } from "./chunks"
import { clearHistory, loadHistory, loadParams, pushHistory, removeHistory, saveParams } from "./store"
import { PromptField, Workbench } from "./workbench"
import { AccountSheet } from "./settings"
import { ChunksPage } from "./chunkspage"
import { GenerateTab } from "./generate"
import { ParamsTab } from "./params"
import { GalleryTab } from "./gallery"
import { PromptEditor } from "./prompteditor"
import { StatPill } from "./ui"
import { CARD_BG, CARD_STROKE, PAGE_BG, RADIUS_CARD } from "./theme"

/** Read once at import: useState's lazy-initializer form is not relied on. */
const INITIAL_PARAMS = loadParams()

const TAB_GENERATE = 0
const TAB_PARAMS = 1
const TAB_GALLERY = 2
const TAB_CHUNKS = 3

function MainView() {
  const selection = useObservable<number>(TAB_GENERATE)

  const [token, setToken] = useState("")
  const [account, setAccount] = useState<Account | null>(null)
  const [params, setParams] = useState<GenerateParams>(INITIAL_PARAMS)
  const [history, setHistory] = useState<GeneratedImage[]>([])
  const [current, setCurrent] = useState<GeneratedImage | null>(null)
  const [chunks, setChunks] = useState<Chunk[]>([])

  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [status, setStatus] = useState("准备就绪")

  const [accountOpen, setAccountOpen] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [editing, setEditing] = useState<PromptField | null>(null)

  const [toastText, setToastText] = useState("")
  const [toastOn, setToastOn] = useState(false)

  useEffect(() => {
    const saved = loadToken()
    if (saved) setToken(saved)
    setHistory(loadHistory())
    setChunks(loadCache())
    if (saved && looksLikeToken(saved)) {
      fetchAccount(saved)
        .then(setAccount)
        .catch(() => {
          /* the account chip just stays empty */
        })
    }
    // Coming back from minimized: files may have been deleted from the Files
    // app, and the chunk library may have changed elsewhere.
    return Script.onResume(() => {
      setHistory(loadHistory())
      setChunks(loadCache())
    })
  }, [])

  const quote = useMemo(() => estimateAnlas(params, account), [params, account])

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

  const generate = async () => {
    const key = token.trim()
    if (!looksLikeToken(key)) {
      setAccountOpen(true)
      toast("请先配置 API Token")
      return
    }
    if (!params.prompt.trim()) {
      setEditing("prompt")
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
      fetchAccount(key)
        .then(setAccount)
        .catch(() => {
          /* keep the previous reading */
        })
    }
  }

  /** Append a chunk's tags to one of the two prompts, skipping duplicates. */
  const insertChunk = (chunk: Chunk, field: PromptField) => {
    const tag = (chunk.expansion || chunk.label || "").trim()
    if (!tag) {
      toast("这个 chunk 是空的")
      return
    }
    const target = field === "prompt" ? params.prompt : params.negative
    const existing = target
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)
    const additions = tag
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part && existing.indexOf(part.toLowerCase()) === -1)
    if (additions.length === 0) {
      toast("已经在提示词里了")
      return
    }
    const merged = target.trim()
      ? target.trim() + ", " + additions.join(", ")
      : additions.join(", ")
    patch(field === "prompt" ? { prompt: merged } : { negative: merged })
    toast("已加入「" + (chunk.label || chunk.id) + "」")
  }

  const wb: Workbench = {
    params,
    patch,
    token,
    account,
    quote,
    history,
    current,
    showImage: (image) => {
      setCurrent(image)
      selection.setValue(TAB_GENERATE)
    },
    removeImage: (path) => {
      setHistory(removeHistory(history, path))
      if (current && current.path === path) setCurrent(null)
    },
    clearImages: () => {
      setHistory(clearHistory(history))
      setCurrent(null)
      toast("已清空")
    },
    chunks,
    insertChunk,
    busy,
    progress,
    status,
    generate: () => {
      if (!busy) void generate()
    },
    editPrompt: setEditing,
    openViewer: () => setViewerOpen(true),
    openAccount: () => setAccountOpen(true),
    reuse: (image) => {
      patch({
        prompt: image.prompt,
        seed: image.seed,
        width: image.width,
        height: image.height,
        model: image.model,
      })
      selection.setValue(TAB_GENERATE)
      toast("已复用参数 · seed " + image.seed)
    },
    toast,
  }

  // The modal modifiers hang on a plain container rather than on TabView:
  // stacks with sheet / toast are the documented combination, and a modifier
  // this platform does not wire up fails silently rather than erroring.
  return (
    <VStack
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      toast={{
        isPresented: toastOn,
        onChanged: setToastOn,
        message: toastText,
        position: "top",
      }}
      fullScreenCover={{
        isPresented: editing != null,
        onChanged: (value: boolean) => {
          if (!value) setEditing(null)
        },
        content: (
          <PromptEditor
            field={editing ?? "prompt"}
            value={editing === "negative" ? params.negative : params.prompt}
            chunks={chunks}
            onChanged={(value) =>
              patch(editing === "negative" ? { negative: value } : { prompt: value })
            }
            onClose={() => setEditing(null)}
          />
        ),
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
          isPresented: viewerOpen,
          onChanged: setViewerOpen,
          content: <ViewerSheet image={current} onClose={() => setViewerOpen(false)} />,
        },
      ]}
    >
      <TabView selection={selection}>
        <Tab title="生成" systemImage="sparkles" value={TAB_GENERATE}>
          <GenerateTab wb={wb} />
        </Tab>
        <Tab title="参数" systemImage="slider.horizontal.3" value={TAB_PARAMS}>
          <ParamsTab wb={wb} />
        </Tab>
        <Tab title="素材" systemImage="photo.on.rectangle.angled" value={TAB_GALLERY}>
          <GalleryTab wb={wb} />
        </Tab>
        <Tab title="词库" systemImage="square.grid.2x2" value={TAB_CHUNKS}>
          <ChunksPage onInsert={(chunk) => insertChunk(chunk, "prompt")} />
        </Tab>
      </TabView>
    </VStack>
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
  // Keep the instance alive if the root page is ever dismissed by a swipe (it
  // is presented full screen, where that gesture does not exist, but the
  // setting costs nothing and covers a fallback presentation).
  Script.enableMinimize()

  await Navigation.present({
    element: <MainView />,
    modalPresentationStyle: "fullScreen",
  })

  Script.exit()
}

run()
