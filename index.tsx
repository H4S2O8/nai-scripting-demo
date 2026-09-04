import {
  Button,
  Form,
  Image,
  Navigation,
  NavigationStack,
  Picker,
  ProgressView,
  Script,
  Section,
  SecureField,
  Text,
  TextField,
  VStack,
  useEffect,
  useState,
} from "scripting"

import {
  fetchSubscription,
  generateImage,
  loadToken,
  saveToken,
  type ModelId,
} from "./nai"

const DEFAULT_PROMPT = "1girl, looking at viewer, smile, masterpiece, best quality"
const DEFAULT_NEGATIVE = "lowres, worst quality, bad anatomy"

function MainView() {
  const [token, setToken] = useState("")
  const [model, setModel] = useState<ModelId>("nai-diffusion-5-full")
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [negative, setNegative] = useState(DEFAULT_NEGATIVE)
  const [status, setStatus] = useState("Token 存在本机 Keychain，不会写入脚本文件。")
  const [busy, setBusy] = useState(false)
  const [imagePath, setImagePath] = useState("")

  useEffect(() => {
    const saved = loadToken()
    if (saved) {
      setToken(saved)
      setStatus("已从 Keychain 读到 token。")
    }
  }, [])

  const persistToken = () => {
    const ok = saveToken(token)
    setStatus(ok ? "Token 已保存到 Keychain。" : "Token 保存失败。")
  }

  const checkAccount = async () => {
    const t = token.trim()
    if (!t.startsWith("pst-")) {
      setStatus("请先填写以 pst- 开头的 Persistent API Token。")
      return
    }
    setBusy(true)
    setStatus("正在查询订阅…")
    try {
      const info = await fetchSubscription(t)
      const usage =
        info.usagePercent != null ? ` · V5 用量 ${info.usagePercent}%` : ""
      setStatus(
        `订阅 ${info.active ? "有效" : "无效"} · tier ${info.tier} · Anlas ${info.anlas ?? "?"}${usage}`,
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const generate = async () => {
    const t = token.trim()
    if (!t.startsWith("pst-")) {
      setStatus("请先填写以 pst- 开头的 Persistent API Token。")
      return
    }
    if (!prompt.trim()) {
      setStatus("提示词不能为空。")
      return
    }
    saveToken(t)
    setBusy(true)
    setImagePath("")
    setStatus("正在生成（可能要 30–120 秒）…")
    try {
      const result = await generateImage(t, model, prompt, negative)
      setImagePath(result.pngPath)
      setStatus("完成。图片已保存到脚本 Documents/NAI-Demo。")
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <NavigationStack>
      <Form navigationTitle="NAI 生图 Demo">
        <Section
          header={<Text>账号</Text>}
          footer={<Text>NovelAI 网页 → 设置 → Account → Get Persistent API Token</Text>}
        >
          <SecureField
            title="Token"
            value={token}
            onChanged={setToken}
            prompt="pst-..."
          />
          <Button title="保存 Token" action={persistToken} />
          <Button title="检查订阅" action={() => { void checkAccount() }} />
        </Section>

        <Section header={<Text>生成</Text>}>
          <Picker
            title="模型"
            value={model}
            onChanged={(value) => setModel(value as ModelId)}
          >
            <Text tag="nai-diffusion-5-full">V5 Full</Text>
            <Text tag="nai-diffusion-5-curated">V5 Curated</Text>
            <Text tag="nai-diffusion-4-5-full">V4.5 Full</Text>
          </Picker>
          <TextField
            title="提示词"
            value={prompt}
            onChanged={setPrompt}
            prompt="1girl, ..."
            axis="vertical"
            lineLimit={{ min: 3, max: 8 }}
          />
          <TextField
            title="负面"
            value={negative}
            onChanged={setNegative}
            axis="vertical"
            lineLimit={{ min: 2, max: 5 }}
          />
          <Button
            title={busy ? "生成中…" : "生成 832×1216"}
            action={() => { if (!busy) void generate() }}
          />
        </Section>

        <Section header={<Text>状态</Text>}>
          <Text>{status}</Text>
          {busy ? (
            <VStack>
              <ProgressView progressViewStyle="circular" title="生成中" />
            </VStack>
          ) : null}
        </Section>

        {imagePath ? (
          <Section header={<Text>结果</Text>} footer={<Text>{imagePath}</Text>}>
            <Image filePath={imagePath} resizable scaleToFit />
          </Section>
        ) : null}
      </Form>
    </NavigationStack>
  )
}

async function run() {
  await Navigation.present({ element: <MainView /> })
  Script.exit()
}

run()
