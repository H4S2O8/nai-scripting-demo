/**
 * Tests multi-account storage and the one-time migration.
 *
 * The migration is the part worth guarding: getting it wrong loses the token
 * the user already had, and there is no way to get it back. Run:
 *
 *   node dev/test_accounts.mjs
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import crypto from "node:crypto"

const here = new URL(".", import.meta.url).pathname
const root = join(here, "..")
const out = mkdtempSync(join(tmpdir(), "nai-accounts-"))

globalThis.UUID = { string: () => crypto.randomUUID() }
const storage = {}
const keychain = {}
globalThis.Storage = {
  get: (k) => (k in storage ? storage[k] : null),
  set: (k, v) => {
    storage[k] = v
    return true
  },
}
globalThis.Keychain = {
  get: (k) => (k in keychain ? keychain[k] : null),
  set: (k, v) => {
    keychain[k] = v
    return true
  },
  remove: (k) => {
    delete keychain[k]
  },
}

function bundle(name) {
  const dest = join(out, name.replace(/\.ts$/, "") + "-" + Math.random().toString(36).slice(2) + ".mjs")
  execFileSync(
    "npx",
    ["--yes", "esbuild@0.24.0", join(root, name), "--format=esm", "--bundle", "--outfile=" + dest],
    { stdio: ["ignore", "ignore", "inherit"] },
  )
  return dest
}

const accountsPath = bundle("accounts.ts")

let failures = 0
function check(name, ok, detail = "") {
  if (ok) console.log("  ok   " + name)
  else {
    failures++
    console.log("  FAIL " + name + (detail ? " - " + detail : ""))
  }
}

function reset() {
  for (const key of Object.keys(storage)) delete storage[key]
  for (const key of Object.keys(keychain)) delete keychain[key]
}

console.log("migration from a single-account install")
{
  reset()
  keychain["nai_pst_token"] = "pst-abc123"
  keychain["nai_sync_token"] = "web-token"
  keychain["nai_encryption_key"] = "enc-key"

  const A = await import(accountsPath + "?1")
  const slots = A.loadAccounts()
  check("one account is created", slots.length === 1)
  check("the generation token is carried over", slots[0].token === "pst-abc123")
  check("so is the auth_token", slots[0].syncToken === "web-token")
  check("and the encryption key", slots[0].encryptionKey === "enc-key")
  check("it becomes active", A.activeId() === slots[0].id)
  check("active account resolves", A.activeAccount()?.token === "pst-abc123")
  // Left in place on purpose: a rollback to the previous version still finds them.
  check("legacy keys are not destroyed", keychain["nai_pst_token"] === "pst-abc123")
  check("migrating twice does not duplicate", A.loadAccounts().length === 1)
}

console.log("empty install")
{
  reset()
  const A = await import(accountsPath + "?2")
  check("no accounts", A.loadAccounts().length === 0)
  check("no active id", A.activeId() === "")
  check("no active account", A.activeAccount() === null)
}

console.log("add / switch / edit / remove")
{
  reset()
  const A = await import(accountsPath + "?3")
  let slots = A.addAccount([], "主号")
  slots = A.addAccount(slots, "小号")
  check("two accounts", slots.length === 2)
  check("ids are distinct", slots[0].id !== slots[1].id)
  check("labels are kept", slots[0].label === "主号" && slots[1].label === "小号")
  check("they persist", A.loadAccounts().length === 2)

  A.setActiveId(slots[1].id)
  check("switching sticks", A.activeId() === slots[1].id)
  check("active account follows", A.activeAccount()?.label === "小号")

  slots = A.updateAccount(slots, slots[1].id, { token: "pst-xyz", label: "改名了" })
  check("edit writes through", A.activeAccount()?.token === "pst-xyz")
  check("and renames", A.activeAccount()?.label === "改名了")
  check("edit leaves the other alone", A.loadAccounts()[0].label === "主号")
  check(
    "a blank label falls back to the old one",
    A.updateAccount(slots, slots[1].id, { label: "   " })[1].label === "改名了",
  )

  const remaining = A.removeAccount(slots, slots[1].id)
  check("removal drops it", remaining.length === 1)
  // Deleting whatever was selected must leave something selected, or every
  // credential read silently returns empty.
  check("active falls back to the survivor", A.activeId() === remaining[0].id)
  check("removing the last one clears active", A.removeAccount(remaining, remaining[0].id).length === 0 && A.activeId() === "")
}

console.log("chunk library is scoped per account")
{
  reset()
  const A = await import(accountsPath + "?4")
  const C = await import(bundle("chunks.ts"))
  let slots = A.addAccount([], "A")
  slots = A.addAccount(slots, "B")

  A.setActiveId(slots[0].id)
  C.saveCache([{ id: "a1", containerId: "c", label: "A only", expansion: "x", color: "#333", version: 1, isCategory: false }])
  check("account A sees its own library", C.loadCache().length === 1)

  A.setActiveId(slots[1].id)
  // Without this, a mirror push would delete the other account's chunks.
  check("account B starts empty", C.loadCache().length === 0)
  C.saveCache([{ id: "b1", containerId: "c", label: "B only", expansion: "y", color: "#333", version: 1, isCategory: false }])
  check("B saves its own", C.loadCache()[0].label === "B only")

  A.setActiveId(slots[0].id)
  check("switching back restores A's library", C.loadCache()[0].label === "A only")

  check("A's sync credentials are read from the slot", C.loadSyncToken() === "")
  A.updateAccount(A.loadAccounts(), slots[0].id, { syncToken: "tok-a", encryptionKey: "key-a" })
  check("after editing, the slot's values are used", C.loadSyncToken() === "tok-a" && C.loadEncryptionKey() === "key-a")
  A.setActiveId(slots[1].id)
  check("and the other account does not inherit them", C.loadSyncToken() === "")
}

console.log("corrupt storage")
{
  reset()
  keychain["nai_accounts"] = "not json"
  const A = await import(accountsPath + "?5")
  check("garbage yields no accounts rather than throwing", A.loadAccounts().length === 0)
  keychain["nai_accounts"] = JSON.stringify([{ nope: 1 }, { id: "x" }])
  check("entries without an id are dropped", A.loadAccounts().length === 1)
  check("missing fields default to empty", A.loadAccounts()[0].token === "")
}

console.log(failures === 0 ? "\n[ok] accounts hold" : "\n[fail] " + failures + " check(s) failed")
process.exit(failures === 0 ? 0 : 1)
