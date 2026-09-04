/**
 * Account sheet: API token, subscription readout, output folder.
 */
import {
  Button,
  HStack,
  Image,
  NavigationStack,
  RoundedRectangle,
  Script,
  ScrollView,
  SecureField,
  Spacer,
  Text,
  VStack,
  useState,
} from "scripting"

import { Account, fetchAccount, looksLikeToken, outputDir, saveToken } from "./nai"
import { Card, StatPill, Well } from "./ui"
import { ACCENT, ACCENT_GRADIENT, PAGE_BG, RADIUS_WELL } from "./theme"

function appVersion(): string {
  try {
    return Script.metadata?.version ?? "?"
  } catch {
    return "?"
  }
}

export function AccountSheet({
  token,
  account,
  onTokenChanged,
  onAccountChanged,
  onClose,
}: {
  token: string
  account: Account | null
  onTokenChanged: (token: string) => void
  onAccountChanged: (account: Account | null) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(token)
  const [status, setStatus] = useState("Token 存在本机 Keychain，不写进脚本文件。")
  const [busy, setBusy] = useState(false)

  const persist = () => {
    const value = draft.trim()
    if (value && !looksLikeToken(value)) {
      setStatus("Token 需要以 pst- 开头。")
      return
    }
    const ok = saveToken(value)
    onTokenChanged(value)
    setStatus(ok ? "已保存到 Keychain。" : "保存失败。")
  }

  const verify = async () => {
    const value = draft.trim()
    if (!looksLikeToken(value)) {
      setStatus("请先填写以 pst- 开头的 Persistent API Token。")
      return
    }
    saveToken(value)
    onTokenChanged(value)
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
        toolbar={{
          topBarTrailing: [<Button title="完成" action={onClose} />],
        }}
      >
        <VStack spacing={14} padding={{ horizontal: 14, top: 8, bottom: 20 }}>
          <Card title="API Token" systemImage="key.fill">
            <SecureField
              title="Persistent API Token"
              value={draft}
              onChanged={setDraft}
              prompt="pst-..."
              textFieldStyle="roundedBorder"
              labelsHidden
            />
            <HStack spacing={10} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Button
                title="保存"
                action={persist}
                buttonStyle="bordered"
                controlSize="small"
                tint={ACCENT}
              />
              <Button
                title={busy ? "查询中…" : "验证并刷新"}
                action={() => {
                  if (!busy) void verify()
                }}
                buttonStyle="borderedProminent"
                controlSize="small"
                tint={ACCENT}
              />
              <Spacer />
            </HStack>
            <Text font={12} foregroundStyle="secondaryLabel">
              {status}
            </Text>
          </Card>

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

          <Card title="怎么拿 Token" systemImage="questionmark.circle.fill">
            <VStack alignment="leading" spacing={6}>
              <Text font={13} foregroundStyle="secondaryLabel">
                1. 浏览器打开 novelai.net 并登录。
              </Text>
              <Text font={13} foregroundStyle="secondaryLabel">
                2. 右上角齿轮 → Account → Get Persistent API Token。
              </Text>
              <Text font={13} foregroundStyle="secondaryLabel">
                3. 复制整串 pst- 开头的文本，粘贴到上面。
              </Text>
              <Text font={12} foregroundStyle="tertiaryLabel">
                国内网络需要系统级代理 / VPN，和访问官网一样。
              </Text>
            </VStack>
          </Card>

          <Card title="关于" systemImage="info.circle.fill">
            <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <StatPill label="版本" value={appVersion()} systemImage="number" />
              <Spacer />
            </HStack>
            <Text font={11} foregroundStyle="tertiaryLabel">
              用远程资源自动更新时，手机上看到的版本号要等一个同步周期才会变。
            </Text>
          </Card>

          <Card title="输出目录" systemImage="folder.fill">
            <Well>
              <Text font={11} fontDesign="monospaced" foregroundStyle="secondaryLabel">
                {outputDir()}
              </Text>
            </Well>
            <Text font={12} foregroundStyle="tertiaryLabel">
              生成的 PNG 保留 NovelAI 写入的元数据，可在「文件」App 里查看和导出。
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
              Token 只发往 image.novelai.net，不经过任何第三方。
            </Text>
            <Spacer />
          </HStack>
        </VStack>
      </ScrollView>
    </NavigationStack>
  )
}
