/**
 * Account manager: switch between NovelAI accounts, and hold each one's
 * credentials in one place.
 *
 * All three credentials belong to the same account and are useless mixed —
 * an auth_token paired with another account's encryption_key opens nothing —
 * so they are edited together here rather than scattered across pages.
 */
import {
  Button,
  Group,
  HStack,
  Image,
  NavigationStack,
  RoundedRectangle,
  ScrollView,
  Script,
  SecureField,
  Spacer,
  Text,
  TextField,
  VStack,
  useEffect,
  useState,
} from "scripting"

import {
  AccountSlot,
  activeId,
  addAccount,
  fingerprint,
  loadAccounts,
  removeAccount,
  setActiveId,
  updateAccount,
} from "./accounts"
import { Account, fetchAccount, looksLikeToken, outputDir } from "./nai"
import { parseSession } from "./chunks"
import { Card, Chip, FieldLabel, StatPill, Well } from "./ui"
import { ACCENT, ACCENT_GRADIENT, CHIP_ON_BG, PAGE_BG, RADIUS_WELL } from "./theme"

function appVersion(): string {
  try {
    return Script.metadata?.version ?? "?"
  } catch {
    return "?"
  }
}

export function AccountSheet({
  sessionKey,
  account,
  onAccountChanged,
  onSwitched,
  onClose,
}: {
  /** Changes on every open; sheet content is not rebuilt between presentations. */
  sessionKey: string
  account: Account | null
  onAccountChanged: (account: Account | null) => void
  /** Credentials or the active account changed; the app should reload. */
  onSwitched: () => void
  onClose: () => void
}) {
  const [slots, setSlots] = useState<AccountSlot[]>([])
  const [current, setCurrent] = useState("")
  const [status, setStatus] = useState("凭据存在本机 Keychain，不写进脚本文件。")
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    const loaded = loadAccounts()
    setSlots(loaded)
    setCurrent(activeId())
    setBusy(false)
    setConfirmDelete(false)
  }, [sessionKey])

  const slot = slots.find((item) => item.id === current) ?? null

  const patchSlot = (next: Partial<AccountSlot>) => {
    if (!slot) return
    setSlots(updateAccount(slots, slot.id, next))
    onSwitched()
  }

  const switchTo = (id: string) => {
    setActiveId(id)
    setCurrent(id)
    onAccountChanged(null)
    onSwitched()
    setStatus("已切换。词库和凭据都跟着这个账户走。")
  }

  const create = () => {
    const next = addAccount(slots, `账户 ${slots.length + 1}`)
    setSlots(next)
    switchTo(next[next.length - 1].id)
  }

  const pasteSession = async () => {
    if (!slot) return
    try {
      const text = await Pasteboard.getString()
      if (!text) {
        setStatus("剪贴板里没有文本。")
        return
      }
      const session = parseSession(text)
      patchSlot({
        syncToken: session.authToken || slot.syncToken,
        encryptionKey: session.encryptionKey || slot.encryptionKey,
      })
      setStatus("已从网页会话读到 auth_token 和 encryption_key。")
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  const verify = async () => {
    if (!slot) return
    const value = slot.token.trim()
    if (!looksLikeToken(value)) {
      setStatus("生图 Token 需要以 pst- 开头。")
      return
    }
    setBusy(true)
    setStatus("正在查询账号…")
    try {
      const info = await fetchAccount(value)
      onAccountChanged(info)
      setStatus(
        `${info.tierName} · ${info.active ? "订阅有效" : "订阅无效"}` +
          (info.anlas != null ? ` · Anlas ${info.anlas}` : ""),
      )
    } catch (error) {
      onAccountChanged(null)
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <NavigationStack>
      <ScrollView
        navigationTitle="账号"
        navigationBarTitleDisplayMode="inline"
        background={PAGE_BG}
        scrollDismissesKeyboard="interactively"
        toolbar={{
          topBarLeading: [<Button title="添加" systemImage="plus" action={create} />],
          topBarTrailing: [<Button title="完成" action={onClose} />],
        }}
        alert={{
          title: "删除账户",
          isPresented: confirmDelete,
          onChanged: setConfirmDelete,
          message: (
            <Text>
              {slot
                ? `「${slot.label}」的三个凭据会从 Keychain 清掉，这个账户的本机词库也不再关联。已生成的图片不受影响。`
                : ""}
            </Text>
          ),
          actions: (
            <Group>
              <Button
                title="删除"
                role="destructive"
                action={() => {
                  setConfirmDelete(false)
                  if (!slot) return
                  const next = removeAccount(slots, slot.id)
                  setSlots(next)
                  setCurrent(activeId())
                  onAccountChanged(null)
                  onSwitched()
                  setStatus("已删除。凭据一并从 Keychain 清掉了。")
                }}
              />
              <Button title="取消" role="cancel" action={() => setConfirmDelete(false)} />
            </Group>
          ),
        }}
      >
        <VStack spacing={14} padding={{ horizontal: 14, top: 8, bottom: 20 }}>
          <Card title="账户" systemImage="person.2">
            {slots.length === 0 ? (
              <Text font={13} foregroundStyle="secondaryLabel">
                还没有账户，点右上角「添加」。
              </Text>
            ) : (
              <VStack
                alignment="leading"
                spacing={7}
                frame={{ maxWidth: "infinity", alignment: "leading" }}
              >
                {slots.map((item) => (
                  <Button
                    key={item.id}
                    buttonStyle="plain"
                    action={() => switchTo(item.id)}
                  >
                    <HStack
                      spacing={9}
                      padding={{ horizontal: 11, vertical: 9 }}
                      frame={{ maxWidth: "infinity", alignment: "leading" }}
                      background={
                        <RoundedRectangle
                          cornerRadius={RADIUS_WELL}
                          fill={item.id === current ? CHIP_ON_BG : "secondarySystemBackground"}
                        />
                      }
                    >
                      <Image
                        systemName={
                          item.id === current ? "checkmark.circle.fill" : "circle"
                        }
                        font={13}
                        foregroundStyle={item.id === current ? ACCENT : "tertiaryLabel"}
                      />
                      <VStack alignment="leading" spacing={1}>
                        <Text font={13} fontWeight="medium" foregroundStyle="label">
                          {item.label}
                        </Text>
                        <Text font={10} fontDesign="monospaced" foregroundStyle="tertiaryLabel">
                          {fingerprint(item.token)}
                        </Text>
                      </VStack>
                      <Spacer />
                      {item.id === current && account ? (
                        <Text font={11} foregroundStyle="secondaryLabel">
                          {account.tierName}
                          {account.anlas != null ? ` · ${account.anlas}` : ""}
                        </Text>
                      ) : null}
                    </HStack>
                  </Button>
                ))}
              </VStack>
            )}
            <Text font={11} foregroundStyle="tertiaryLabel">
              切换账户会同时切换本机词库——不然用「镜像」推送会拿这个账户的词库覆盖另一个。
            </Text>
          </Card>

          {slot ? (
            <Card title="当前账户" systemImage="key.fill">
              <FieldLabel text="名称" />
              <Well padding={8}>
                <TextField
                  title="名称"
                  value={slot.label}
                  onChanged={(value) => patchSlot({ label: value })}
                  prompt="给这个账户起个名字"
                  labelsHidden
                />
              </Well>

              <FieldLabel text="生图 Token" hint={slot.token ? "已保存" : "必填"} />
              <Well padding={8}>
                <SecureField
                  title="生图 Token"
                  value={slot.token}
                  onChanged={(value) => patchSlot({ token: value })}
                  prompt="pst-..."
                  labelsHidden
                />
              </Well>

              <HStack spacing={10} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <Chip
                  label="粘贴网页会话"
                  selected={false}
                  disabled={busy}
                  onTap={() => {
                    void pasteSession()
                  }}
                />
                <Button
                  title={busy ? "查询中…" : "验证并刷新"}
                  action={() => {
                    if (!busy) void verify()
                  }}
                  buttonStyle="borderedProminent"
                  controlSize="small"
                  tint={ACCENT}
                  disabled={busy}
                />
                <Spacer />
              </HStack>

              <FieldLabel
                text="auth_token"
                hint={slot.syncToken ? "已保存" : "词库同步需要"}
              />
              <Well padding={8}>
                <SecureField
                  title="auth_token"
                  value={slot.syncToken}
                  onChanged={(value) => patchSlot({ syncToken: value })}
                  prompt="网页会话的 auth_token"
                  labelsHidden
                />
              </Well>

              <FieldLabel
                text="encryption_key"
                hint={slot.encryptionKey ? "已保存" : "词库同步需要"}
              />
              <Well padding={8}>
                <SecureField
                  title="encryption_key"
                  value={slot.encryptionKey}
                  onChanged={(value) => patchSlot({ encryptionKey: value })}
                  prompt="网页会话的 encryption_key"
                  labelsHidden
                />
              </Well>

              <Text font={12} foregroundStyle="secondaryLabel">
                {status}
              </Text>

              <HStack frame={{ maxWidth: "infinity" }}>
                <Spacer />
                <Button
                  title="删除这个账户"
                  role="destructive"
                  buttonStyle="bordered"
                  controlSize="small"
                  action={() => setConfirmDelete(true)}
                />
                <Spacer />
              </HStack>
            </Card>
          ) : null}

          <Card title="订阅" systemImage="creditcard.fill">
            {account ? (
              <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <StatPill label="等级" value={account.tierName} systemImage="crown.fill" />
                <StatPill
                  label="Anlas"
                  value={account.anlas != null ? String(account.anlas) : "—"}
                  systemImage="bolt.fill"
                />
                <StatPill
                  label="Opus"
                  value={
                    account.opusPercent != null
                      ? Math.round(account.opusPercent) + "%"
                      : "—"
                  }
                  systemImage="gauge.medium"
                />
                <Spacer />
              </HStack>
            ) : (
              <Text font={13} foregroundStyle="secondaryLabel">
                还没有账号信息，点上面的「验证并刷新」。
              </Text>
            )}
            {account && account.expiresAt ? (
              <Text font={12} foregroundStyle="tertiaryLabel">
                订阅到期：{account.expiresAt}
              </Text>
            ) : null}
          </Card>

          <Card title="怎么拿这些凭据" systemImage="questionmark.circle.fill">
            <VStack alignment="leading" spacing={6}>
              <Text font={13} foregroundStyle="secondaryLabel">
                生图 Token：网页右上角齿轮 → Account → Get Persistent API Token。
              </Text>
              <Text font={13} foregroundStyle="secondaryLabel">
                另外两个：浏览器控制台执行 localStorage.session，复制整段 JSON，
                回来点「粘贴网页会话」，两个会一起填好。
              </Text>
              <Text font={12} foregroundStyle="tertiaryLabel">
                词库接口不收 pst- 令牌，会直接回「usage of persistent access tokens is
                not allowed for this endpoint」，所以必须另外给 auth_token。
              </Text>
            </VStack>
          </Card>

          <Card title="关于" systemImage="info.circle.fill">
            <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <StatPill label="版本" value={appVersion()} systemImage="number" />
              <Spacer />
            </HStack>
            <Well>
              <Text font={11} fontDesign="monospaced" foregroundStyle="secondaryLabel">
                {outputDir()}
              </Text>
            </Well>
            <Text font={11} foregroundStyle="tertiaryLabel">
              用远程资源自动更新时，版本号要等一个同步周期才会变。
            </Text>
          </Card>

          <HStack
            spacing={8}
            padding={12}
            frame={{ maxWidth: "infinity" }}
            background={
              <RoundedRectangle cornerRadius={RADIUS_WELL} fill={ACCENT_GRADIENT} />
            }
          >
            <Image systemName="lock.shield.fill" font={13} foregroundStyle="white" />
            <Text font={12} foregroundStyle="white">
              凭据只发往 image.novelai.net；encryption_key 完全不出设备。
            </Text>
            <Spacer />
          </HStack>
        </VStack>
      </ScrollView>
    </NavigationStack>
  )
}
