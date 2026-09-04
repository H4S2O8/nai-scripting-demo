/**
 * Prompt Chunks page: local library, account sync, file import / export.
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
  SecureField,
  Spacer,
  Text,
  TextField,
  VStack,
  useEffect,
  useMemo,
  useState,
} from "scripting"

import {
  Chunk,
  SyncAccount,
  SyncMode,
  groupChunks,
  loadCache,
  loadEncryptionKey,
  loadSyncToken,
  makeExport,
  parseImport,
  parseSession,
  pullChunks,
  pushChunks,
  saveCache,
  saveEncryptionKey,
  saveSyncToken,
  searchChunks,
  selfTestCodec,
} from "./chunks"
import { outputDir } from "./nai"
import { Card, Chip, FieldLabel, StatPill, Well } from "./ui"
import { ACCENT, PAGE_BG, RADIUS_WELL, WELL_BG } from "./theme"

const MODES: { id: SyncMode; label: string; note: string }[] = [
  { id: "merge", label: "合并", note: "只新增账户里没有的" },
  { id: "update", label: "更新", note: "新增 + 覆盖同名" },
  { id: "mirror", label: "镜像", note: "覆盖 + 删除多余" },
]

export function ChunksPage({
  onInsert,
  onClose,
}: {
  onInsert: (chunk: Chunk) => void
  /** Only set when shown as a sheet; as a tab there is nothing to close. */
  onClose?: () => void
}) {
  const [syncToken, setSyncToken] = useState("")
  const [encKey, setEncKey] = useState("")
  const [cache, setCache] = useState<Chunk[]>([])
  const [query, setQuery] = useState("")
  const [mode, setMode] = useState<SyncMode>("merge")
  const [busy, setBusy] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [confirmPush, setConfirmPush] = useState(false)

  // Read once. A useState initializer function is not a form this platform
  // documents, and re-reading Storage on every render would parse the whole
  // library each time.
  useEffect(() => {
    setSyncToken(loadSyncToken())
    setEncKey(loadEncryptionKey())
    setCache(loadCache())
  }, [])

  const log = (line: string) => setLines((prev) => [...prev, line].slice(-200))

  const results = useMemo(() => searchChunks(cache, query), [cache, query])
  const groups = useMemo(() => groupChunks(cache), [cache])

  // No fallback to the generation token: these endpoints answer a pst- token
  // with "usage of persistent access tokens is not allowed for this endpoint".
  const account: SyncAccount = {
    authToken: syncToken.trim(),
    encryptionKey: encKey.trim(),
  }
  const ready = account.authToken.length > 0 && account.encryptionKey.length > 0

  const guard = async (label: string, work: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    log("— " + label)
    try {
      await work()
    } catch (error) {
      log("❌ " + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(false)
    }
  }

  const persistCredentials = () => {
    saveSyncToken(syncToken)
    saveEncryptionKey(encKey)
    log("✔ 已存入 Keychain。")
  }

  const pasteSession = () =>
    guard("粘贴网页会话", async () => {
      const text = await Pasteboard.getString()
      if (!text) {
        log("剪贴板里没有文本。")
        return
      }
      const session = parseSession(text)
      if (session.authToken) {
        setSyncToken(session.authToken)
        saveSyncToken(session.authToken)
      }
      if (session.encryptionKey) {
        setEncKey(session.encryptionKey)
        saveEncryptionKey(session.encryptionKey)
      }
      log(
        `✔ 读到 ${session.authToken ? "auth_token" : ""}` +
          `${session.authToken && session.encryptionKey ? " 和 " : ""}` +
          `${session.encryptionKey ? "encryption_key" : ""}，已存入 Keychain。`,
      )
    })

  const runSelfTest = () => {
    try {
      log("✔ 编解码自检通过 · " + selfTestCodec())
    } catch (error) {
      log("❌ " + (error instanceof Error ? error.message : String(error)))
    }
  }

  const pull = () =>
    guard("从账户拉取", async () => {
      const chunks = await pullChunks(account, log)
      setCache(saveCache(chunks))
    })

  const push = () =>
    guard("推送到账户（" + mode + "）", async () => {
      await pushChunks(account, cache, mode, log)
      const refreshed = await pullChunks(account, log)
      setCache(saveCache(refreshed))
    })

  const exportFile = () =>
    guard("导出", async () => {
      if (cache.length === 0) {
        log("本地库是空的，先拉取或导入。")
        return
      }
      const payload = makeExport(cache)
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
      const path = outputDir() + "/prompt-chunks-" + stamp + ".json"
      if (!FileManager.existsSync(outputDir())) {
        FileManager.createDirectorySync(outputDir(), true)
      }
      FileManager.writeAsStringSync(path, JSON.stringify(payload, null, 2))
      log("✔ 已写入 " + path)
      try {
        await ShareSheet.present([path])
      } catch {
        log("（分享面板未打开，文件已经存好了）")
      }
    })

  const importFile = () =>
    guard("从文件导入", async () => {
      const picked = await DocumentPicker.pickFiles({ types: ["public.json"] })
      if (!picked || picked.length === 0) {
        log("已取消。")
        return
      }
      const text = FileManager.readAsStringSync(picked[0])
      const chunks = parseImport(text)
      setCache(saveCache(chunks))
      log(`✔ 导入 ${chunks.length} 个对象到本地库。`)
      log("这一步只写本地；要同步到账户请用下面的推送。")
    })

  const importClipboard = () =>
    guard("从剪贴板导入", async () => {
      const text = await Pasteboard.getString()
      if (!text) {
        log("剪贴板里没有文本。")
        return
      }
      const chunks = parseImport(text)
      setCache(saveCache(chunks))
      log(`✔ 导入 ${chunks.length} 个对象到本地库。`)
    })

  return (
    <NavigationStack>
      <ScrollView
        navigationTitle="词库"
        navigationBarTitleDisplayMode="inline"
        background={PAGE_BG}
        scrollDismissesKeyboard="interactively"
        toolbar={{
          topBarTrailing: onClose ? [<Button title="完成" action={onClose} />] : [],
        }}
        alert={{
          title: mode === "mirror" ? "镜像会删除数据" : "推送到账户",
          isPresented: confirmPush,
          onChanged: setConfirmPush,
          message: (
            <Text>
              {mode === "mirror"
                ? `本地 ${cache.length} 个对象将覆盖账户内容，账户里多出来的 chunk 会被删除，且无法撤销。`
                : `将把本地 ${cache.length} 个对象按「${MODES.find((m) => m.id === mode)?.label}」写入账户。实际的新增 / 更新数量会在拉取账户现状后写进日志。`}
            </Text>
          ),
          actions: (
            <Group>
              <Button
                title={mode === "mirror" ? "仍然镜像" : "推送"}
                role={mode === "mirror" ? "destructive" : undefined}
                action={() => {
                  setConfirmPush(false)
                  void push()
                }}
              />
              <Button title="取消" role="cancel" action={() => setConfirmPush(false)} />
            </Group>
          ),
        }}
      >
        <VStack spacing={14} padding={{ horizontal: 14, top: 6, bottom: 20 }}>
          {/* ------------------------------------------------ credentials */}
          <Card
            title="连接"
            systemImage="link"
            trailing={
              <Button
                title="自检"
                action={runSelfTest}
                buttonStyle="borderless"
                controlSize="small"
                tint={ACCENT}
              />
            }
          >
            <HStack spacing={10} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Chip
                label="粘贴网页会话"
                selected={false}
                disabled={busy}
                onTap={() => void pasteSession()}
              />
              <Spacer />
            </HStack>
            <Text font={11} foregroundStyle="tertiaryLabel">
              在 novelai.net 控制台执行 localStorage.session，复制整个 JSON 后点上面这个键，
              auth_token 和 encryption_key 会一起填好。
            </Text>
            <FieldLabel
              text="encryption_key"
              hint={encKey ? "已保存" : "必填"}
            />
            <Well padding={8}>
              <SecureField
                title="encryption_key"
                value={encKey}
                onChanged={setEncKey}
                prompt="从网页会话里复制"
                labelsHidden
              />
            </Well>
            <FieldLabel text="auth_token" hint={syncToken ? "已保存" : "必填"} />
            <Well padding={8}>
              <SecureField
                title="auth_token"
                value={syncToken}
                onChanged={setSyncToken}
                prompt="网页会话的 auth_token"
                labelsHidden
              />
            </Well>
            <HStack spacing={10} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Button
                title="保存"
                action={persistCredentials}
                buttonStyle="bordered"
                controlSize="small"
                tint={ACCENT}
              />
              <StatPill
                label="状态"
                value={ready ? "可同步" : "缺凭据"}
                systemImage={ready ? "checkmark.seal.fill" : "exclamationmark.triangle.fill"}
              />
              <Spacer />
            </HStack>
            <Text font={11} foregroundStyle="tertiaryLabel">
              这两项都只在网页登录会话里，生图用的 pst- Token 在这里用不了——那些接口会直接回
              「usage of persistent access tokens is not allowed for this endpoint」。
              两者都只留在本机 Keychain；encryption_key 不出设备，仅用于本地解开 keystore。
            </Text>
          </Card>

          {/* ----------------------------------------------------- library */}
          <Card
            title="本地库"
            systemImage="books.vertical.fill"
            trailing={
              <Text font={11} fontDesign="monospaced" foregroundStyle="tertiaryLabel">
                {cache.filter((c) => !c.isCategory).length} chunk ·{" "}
                {cache.filter((c) => c.isCategory && c.id !== "default").length} 分类
              </Text>
            }
          >
            <Well padding={8}>
              <TextField
                title="搜索"
                value={query}
                onChanged={setQuery}
                prompt="按名称或内容搜索"
                labelsHidden
                autocorrectionDisabled
                textInputAutocapitalization="never"
              />
            </Well>
            {cache.length === 0 ? (
              <Text font={12} foregroundStyle="tertiaryLabel">
                还没有 chunk。从账户拉取，或导入 userscript 导出的 JSON。
              </Text>
            ) : query.trim() ? (
              <VStack alignment="leading" spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <FieldLabel text="搜索结果" hint={results.length + " 项"} />
                <FlowLayout spacing={8}>
                  {results.slice(0, 60).map((chunk) => (
                    <Chip label={chunk.label || chunk.id} selected={false} onTap={() => onInsert(chunk)} />
                  ))}
                </FlowLayout>
              </VStack>
            ) : (
              <VStack alignment="leading" spacing={12} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                {groups.map((group) => (
                  <VStack
                    alignment="leading"
                    spacing={6}
                    frame={{ maxWidth: "infinity", alignment: "leading" }}
                  >
                    <FieldLabel
                      text={group.category ? group.category.label || group.category.id : "未分类"}
                      hint={group.items.length + " 项"}
                    />
                    {group.items.length === 0 ? (
                      <Text font={11} foregroundStyle="tertiaryLabel">
                        （空分类）
                      </Text>
                    ) : (
                      <FlowLayout spacing={8}>
                        {group.items.map((chunk) => (
                          <Chip
                            label={chunk.label || chunk.id}
                            selected={false}
                            onTap={() => onInsert(chunk)}
                          />
                        ))}
                      </FlowLayout>
                    )}
                  </VStack>
                ))}
              </VStack>
            )}
            <Text font={11} foregroundStyle="tertiaryLabel">
              点一下把该 chunk 的内容追加到提示词。管理（新建 / 改名 / 重排）请回网页做。
            </Text>
          </Card>

          {/* -------------------------------------------------------- sync */}
          <Card title="账户同步" systemImage="arrow.triangle.2.circlepath">
            <HStack spacing={10} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Button
                title={busy ? "进行中…" : "从账户拉取"}
                action={() => {
                  if (ready) void pull()
                  else log("❌ 先填 auth_token 和 encryption_key。")
                }}
                buttonStyle="borderedProminent"
                controlSize="small"
                tint={ACCENT}
                disabled={busy}
              />
              <Spacer />
            </HStack>
            <FieldLabel text="推送模式" />
            <FlowLayout spacing={8}>
              {MODES.map((item) => (
                <Chip
                  label={item.label}
                  selected={mode === item.id}
                  onTap={() => setMode(item.id)}
                />
              ))}
            </FlowLayout>
            <Text font={11} foregroundStyle="tertiaryLabel">
              {MODES.find((item) => item.id === mode)?.note}
            </Text>
            <Button
              title="推送到账户"
              action={() => {
                if (!ready) {
                  log("❌ 先填 auth_token 和 encryption_key。")
                  return
                }
                if (cache.length === 0) {
                  log("❌ 本地库是空的。")
                  return
                }
                setConfirmPush(true)
              }}
              buttonStyle="bordered"
              controlSize="small"
              role={mode === "mirror" ? "destructive" : undefined}
              disabled={busy}
            />
          </Card>

          {/* -------------------------------------------------------- files */}
          <Card title="文件" systemImage="doc.badge.arrow.up">
            <HStack spacing={10} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Chip label="导出 JSON" selected={false} disabled={busy} onTap={() => void exportFile()} />
              <Chip label="导入文件" selected={false} disabled={busy} onTap={() => void importFile()} />
              <Chip label="粘贴导入" selected={false} disabled={busy} onTap={() => void importClipboard()} />
              <Spacer />
            </HStack>
            <Text font={11} foregroundStyle="tertiaryLabel">
              和油猴脚本 novelai-prompt-chunks-sync 用的是同一种 JSON，两边可以互导。
            </Text>
          </Card>

          {/* ---------------------------------------------------------- log */}
          <Card title="日志" systemImage="text.alignleft">
            <VStack
              alignment="leading"
              spacing={2}
              padding={10}
              frame={{ maxWidth: "infinity", height: 180, alignment: "topLeading" }}
              background={<RoundedRectangle cornerRadius={RADIUS_WELL} fill={WELL_BG} />}
            >
              <ScrollView defaultScrollAnchor="bottom">
                <VStack alignment="leading" spacing={2}>
                  {lines.length === 0 ? (
                    <Text font={11} foregroundStyle="tertiaryLabel">
                      操作记录会显示在这里。
                    </Text>
                  ) : (
                    lines.map((line) => (
                      <Text font={11} fontDesign="monospaced" foregroundStyle="secondaryLabel">
                        {line}
                      </Text>
                    ))
                  )}
                </VStack>
              </ScrollView>
            </VStack>
            <HStack spacing={10} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Chip label="清空日志" selected={false} onTap={() => setLines([])} />
              <Spacer />
              <Image
                systemName={busy ? "hourglass" : "checkmark.circle"}
                font={12}
                foregroundStyle={busy ? ACCENT : "tertiaryLabel"}
              />
            </HStack>
          </Card>
        </VStack>
      </ScrollView>
    </NavigationStack>
  )
}
