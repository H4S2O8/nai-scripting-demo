/**
 * Multiple NovelAI accounts.
 *
 * An account is three credentials that have to travel together: the `pst-`
 * generation token, the web session `auth_token` the user-object endpoints
 * require, and the `encryption_key` that opens that account's keystore. Mixing
 * them across accounts is the failure this module exists to prevent — a
 * keystore opened with the wrong key decrypts nothing, and it looks exactly
 * like a broken client.
 *
 * All three live in the Keychain as one JSON blob. Which one is active is an
 * ordinary preference, so it sits in Storage.
 *
 * The chunk library is scoped by account id (see chunks.ts). It has to be:
 * pushing in mirror mode with another account's library loaded would delete
 * that account's chunks.
 */
const SLOTS_KEY = "nai_accounts"
const ACTIVE_KEY = "nai.account.active"

/** Pre-multi-account keys, migrated once and then left alone. */
const LEGACY_TOKEN = "nai_pst_token"
const LEGACY_SYNC = "nai_sync_token"
const LEGACY_ENC = "nai_encryption_key"

export type AccountSlot = {
  id: string
  label: string
  /** Generation token, `pst-…`. */
  token: string
  /** Web session auth_token, for /user/keystore and /user/objects. */
  syncToken: string
  /** Derived at web login; opens the keystore. Never leaves the device. */
  encryptionKey: string
}

function readSlots(): AccountSlot[] {
  const raw = Keychain.get(SLOTS_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item: any) => item && typeof item.id === "string")
      .map((item: any) => ({
        id: String(item.id),
        label: typeof item.label === "string" ? item.label : "账户",
        token: typeof item.token === "string" ? item.token : "",
        syncToken: typeof item.syncToken === "string" ? item.syncToken : "",
        encryptionKey:
          typeof item.encryptionKey === "string" ? item.encryptionKey : "",
      }))
  } catch {
    return []
  }
}

function writeSlots(slots: AccountSlot[]): AccountSlot[] {
  Keychain.set(SLOTS_KEY, JSON.stringify(slots))
  return slots
}

export function newSlot(label: string): AccountSlot {
  return {
    id: UUID.string(),
    label: label.trim() || "新账户",
    token: "",
    syncToken: "",
    encryptionKey: "",
  }
}

/**
 * Load every account, migrating a single-account install on first run.
 *
 * The legacy keys are left in place rather than deleted — if this version is
 * rolled back, the old one still finds its token.
 */
export function loadAccounts(): AccountSlot[] {
  const existing = readSlots()
  if (existing.length > 0) return existing

  const token = (Keychain.get(LEGACY_TOKEN) ?? "").trim()
  const syncToken = (Keychain.get(LEGACY_SYNC) ?? "").trim()
  const encryptionKey = (Keychain.get(LEGACY_ENC) ?? "").trim()
  if (!token && !syncToken && !encryptionKey) return []

  const migrated: AccountSlot = {
    ...newSlot("我的账户"),
    token,
    syncToken,
    encryptionKey,
  }
  writeSlots([migrated])
  Storage.set(ACTIVE_KEY, migrated.id)
  return [migrated]
}

export function saveAccounts(slots: AccountSlot[]): AccountSlot[] {
  return writeSlots(slots)
}

export function activeId(): string {
  const stored = Storage.get<string>(ACTIVE_KEY)
  const slots = loadAccounts()
  if (stored && slots.some((slot) => slot.id === stored)) return stored
  return slots.length > 0 ? slots[0].id : ""
}

export function setActiveId(id: string): void {
  Storage.set(ACTIVE_KEY, id)
}

export function activeAccount(): AccountSlot | null {
  const id = activeId()
  if (!id) return null
  return loadAccounts().find((slot) => slot.id === id) ?? null
}

export function addAccount(slots: AccountSlot[], label: string): AccountSlot[] {
  return writeSlots(slots.concat([newSlot(label)]))
}

export function updateAccount(
  slots: AccountSlot[],
  id: string,
  next: Partial<AccountSlot>,
): AccountSlot[] {
  return writeSlots(
    slots.map((slot) =>
      slot.id === id
        ? {
            ...slot,
            ...next,
            id: slot.id,
            label: (next.label ?? slot.label).trim() || slot.label,
          }
        : slot,
    ),
  )
}

/** Remove an account. The caller decides what becomes active afterwards. */
export function removeAccount(slots: AccountSlot[], id: string): AccountSlot[] {
  const kept = writeSlots(slots.filter((slot) => slot.id !== id))
  if (activeId() === id) setActiveId(kept.length > 0 ? kept[0].id : "")
  return kept
}

/** Short, non-secret fingerprint, so two accounts can be told apart in a list. */
export function fingerprint(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return "未填"
  if (trimmed.length <= 12) return trimmed.slice(0, 4) + "…"
  return trimmed.slice(0, 6) + "…" + trimmed.slice(-4)
}
