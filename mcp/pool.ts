/**
 * A pool of NovelAI accounts, and the policy for choosing one per generation.
 *
 * Round-robin would be the wrong balancer here. The scarce resource is not
 * request capacity — it is the Opus free-tier allowance, which applies only
 * below 1 MP and 28 steps and is metered per account. So the choice depends on
 * what the request costs *on that particular account*: a free request should
 * land on whoever has the most allowance left, a paid one on whoever has the
 * Anlas to cover it.
 *
 * State lives at module scope, which in http.ts means it survives across
 * requests even though a fresh server is built for each one.
 *
 * Configuration — one of:
 *
 *   NOVELAI_TOKENS   several tokens, separated by commas, semicolons or
 *                    newlines. Each may be labelled:  main=pst-xxx
 *   NOVELAI_TOKEN    a single token; still works, and is folded into the pool.
 *
 * Tokens are never logged, never returned by a tool, and never put in an error
 * message. Accounts are identified by their label and a short fingerprint.
 */
import { createHash } from "node:crypto"

import { Account, GenerateParams, estimateAnlas, fetchAccount, isOpus } from "../nai"

/** How long a fetched subscription state is trusted. */
const STATE_TTL_MS = 120_000
/** Backoff after a failure, by kind. A bad token is not worth retrying soon. */
const COOLDOWN_BAD_TOKEN_MS = 600_000
const COOLDOWN_NO_QUOTA_MS = 300_000
const COOLDOWN_RATE_LIMIT_MS = 60_000
const COOLDOWN_UNKNOWN_MS = 30_000

export type PoolAccount = {
  label: string
  /** Short, non-reversible id for logs and tool output. */
  fingerprint: string
  /** Never leaves this module except as an Authorization header. */
  token: string
  state: Account | null
  stateFetchedAt: number
  stateError: string
  cooldownUntil: number
  lastError: string
  /** Generations served, for the tie-break and for status output. */
  used: number
  inFlight: number
}

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8)
}

function parseTokens(): { label: string; token: string }[] {
  const raw = [process.env.NOVELAI_TOKENS ?? "", process.env.NOVELAI_TOKEN ?? ""]
    .join("\n")
    .split(/[\n,;]+/)
  const out: { label: string; token: string }[] = []
  const seen = new Set<string>()
  let index = 0
  for (const entry of raw) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    // "label=token" or bare token. Split on the first = only: the token itself
    // is base64-ish and may well contain one.
    const eq = trimmed.indexOf("=")
    const label = eq > 0 ? trimmed.slice(0, eq).trim() : ""
    const token = (eq > 0 ? trimmed.slice(eq + 1) : trimmed).trim()
    if (!token) continue
    // The same token given twice would double its apparent capacity and make
    // the balancer send it twice the traffic.
    if (seen.has(token)) continue
    seen.add(token)
    index++
    out.push({ label: label || `账户${index}`, token })
  }
  return out
}

let POOL: PoolAccount[] | null = null

export function pool(): PoolAccount[] {
  if (POOL) return POOL
  POOL = parseTokens().map(({ label, token }) => ({
    label,
    fingerprint: fingerprint(token),
    token,
    state: null,
    stateFetchedAt: 0,
    stateError: "",
    cooldownUntil: 0,
    lastError: "",
    used: 0,
    inFlight: 0,
  }))
  return POOL
}

/** Test seam: re-read the environment. */
export function resetPool() {
  POOL = null
}

export function poolSize(): number {
  return pool().length
}

async function refresh(account: PoolAccount, now: number): Promise<void> {
  if (account.state && now - account.stateFetchedAt < STATE_TTL_MS) return
  try {
    account.state = await fetchAccount(account.token)
    account.stateFetchedAt = now
    account.stateError = ""
  } catch (error) {
    account.state = null
    account.stateFetchedAt = now
    account.stateError = error instanceof Error ? error.message : String(error)
  }
}

/** Refresh every account at once; one slow account should not serialize the rest. */
export async function refreshAll(force = false): Promise<PoolAccount[]> {
  const now = Date.now()
  const list = pool()
  if (force) for (const account of list) account.stateFetchedAt = 0
  await Promise.all(list.map((account) => refresh(account, now)))
  return list
}

export type Candidate = {
  account: PoolAccount
  /** What this request costs on this account. */
  cost: number
  free: boolean
  /** Higher is better. */
  score: number
}

/**
 * Rank the accounts that could serve this request, best first.
 *
 * Exported for the status tool and for tests: the ordering is the whole policy,
 * and it is much easier to assert on than on which token a generation used.
 */
export function rank(params: GenerateParams, now = Date.now()): Candidate[] {
  const out: Candidate[] = []
  for (const account of pool()) {
    if (account.cooldownUntil > now) continue
    if (!account.state) continue
    if (!account.state.active) continue

    const quote = estimateAnlas(params, account.state)
    const anlas = account.state.anlas ?? 0
    const percent = account.state.opusPercent ?? 0

    let score: number
    if (quote.free) {
      // Free on this account: spread across whoever has the most allowance
      // left, so no single account is exhausted while others sit idle.
      if (!isOpus(account.state)) continue
      score = 10_000 + percent
    } else {
      // Paid: it has to be able to afford the whole batch, and among those
      // that can, the richest keeps the others in reserve.
      if (anlas < quote.total) continue
      score = Math.min(9_999, anlas)
    }

    // Tie-break on load, then on how much each has already served, so equal
    // accounts alternate instead of one always winning.
    score = score * 1000 - account.inFlight * 100 - Math.min(99, account.used)
    out.push({ account, cost: quote.total, free: quote.free, score })
  }
  return out.sort((a, b) => b.score - a.score)
}

/** Why nothing could serve the request — the pool's state, without tokens. */
export function explainEmpty(params: GenerateParams, now = Date.now()): string {
  const list = pool()
  if (list.length === 0) {
    return (
      "没有配置任何 NovelAI 账户。设置 NOVELAI_TOKENS（多个用逗号或换行分隔，" +
      "可写成 label=pst-xxx），或 NOVELAI_TOKEN（单个）。"
    )
  }
  const reasons = list.map((account) => {
    const name = `${account.label}(${account.fingerprint})`
    if (account.cooldownUntil > now) {
      const seconds = Math.ceil((account.cooldownUntil - now) / 1000)
      return `${name}：冷却中 ${seconds}s — ${account.lastError || "上次失败"}`
    }
    if (!account.state) return `${name}：状态获取失败 — ${account.stateError || "未知"}`
    if (!account.state.active) return `${name}：订阅未激活`
    const quote = estimateAnlas(params, account.state)
    if (quote.free) return `${name}：可用（应当被选中）`
    const anlas = account.state.anlas ?? 0
    return `${name}：需要 ${quote.total} Anlas，只有 ${anlas}`
  })
  return "没有可用账户：\n  " + reasons.join("\n  ")
}

export type Lease = { account: PoolAccount; cost: number; free: boolean }

/** The best account for this request, with its state already refreshed. */
export async function acquire(params: GenerateParams): Promise<Lease> {
  await refreshAll()
  const ranked = rank(params)
  if (ranked.length === 0) throw new Error(explainEmpty(params))
  const best = ranked[0]
  best.account.inFlight++
  return { account: best.account, cost: best.cost, free: best.free }
}

/** How long to sideline an account, given what its request did. */
function cooldownFor(message: string): number {
  if (/401|令牌无效|Unauthorized/i.test(message)) return COOLDOWN_BAD_TOKEN_MS
  if (/402|额度不足|Anlas|insufficient/i.test(message)) return COOLDOWN_NO_QUOTA_MS
  if (/429|过于频繁|rate limit/i.test(message)) return COOLDOWN_RATE_LIMIT_MS
  return COOLDOWN_UNKNOWN_MS
}

export function succeed(lease: Lease) {
  lease.account.inFlight = Math.max(0, lease.account.inFlight - 1)
  lease.account.used++
  lease.account.lastError = ""
  // A paid generation just changed the balance, so the cached state is stale.
  if (!lease.free) lease.account.stateFetchedAt = 0
}

/**
 * Record a failure and decide whether another account should try.
 *
 * Only account-specific failures are worth failing over: a bad prompt fails
 * identically everywhere, and retrying it would burn the whole pool's quota on
 * the same error.
 */
export function fail(lease: Lease, error: unknown): { retryable: boolean } {
  const message = error instanceof Error ? error.message : String(error)
  lease.account.inFlight = Math.max(0, lease.account.inFlight - 1)
  lease.account.lastError = message.slice(0, 200)

  const accountSpecific =
    /401|402|429|令牌无效|额度不足|Anlas|insufficient|Unauthorized|rate limit/i.test(message)
  if (!accountSpecific) return { retryable: false }

  lease.account.cooldownUntil = Date.now() + cooldownFor(message)
  // Its quota is not what we thought it was.
  lease.account.stateFetchedAt = 0
  return { retryable: true }
}

export type AccountStatus = {
  label: string
  fingerprint: string
  tier: string | null
  active: boolean
  anlas: number | null
  opusPercentRemaining: number | null
  expiresAt: string | null
  served: number
  inFlight: number
  cooldownSeconds: number
  error: string
}

/** Pool state for the status tool. Contains no tokens. */
export function status(now = Date.now()): AccountStatus[] {
  return pool().map((account) => ({
    label: account.label,
    fingerprint: account.fingerprint,
    tier: account.state?.tierName ?? null,
    active: account.state?.active ?? false,
    anlas: account.state?.anlas ?? null,
    opusPercentRemaining: account.state?.opusPercent ?? null,
    expiresAt: account.state?.expiresAt ?? null,
    served: account.used,
    inFlight: account.inFlight,
    cooldownSeconds:
      account.cooldownUntil > now ? Math.ceil((account.cooldownUntil - now) / 1000) : 0,
    error: account.lastError || account.stateError || "",
  }))
}
