/**
 * The account pool's selection policy.
 *
 * The policy is the feature, and it is far easier to assert on a ranking than
 * on which token a generation happened to use, so most of this drives rank()
 * directly with hand-set account state and never touches the network.
 *
 *   node dev/test_pool.mjs
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const here = new URL(".", import.meta.url).pathname
const root = join(here, "..")
const out = mkdtempSync(join(tmpdir(), "naipool-"))

function bundle(name) {
  const dest = join(out, name.replace(/[\/.]/g, "_") + ".mjs")
  execFileSync(
    "npx",
    ["--yes", "esbuild@0.24.0", join(root, name), "--format=esm", "--bundle",
     "--platform=node", "--outfile=" + dest],
    { stdio: ["ignore", "ignore", "inherit"] },
  )
  return dest
}

const modPath = bundle("mcp/pool.ts")

let failures = 0
function check(name, ok, detail = "") {
  if (ok) console.log("  ok   " + name)
  else {
    failures++
    console.log("  FAIL " + name + (detail ? " -- " + detail : ""))
  }
}

// Re-import with a fresh module registry so module-level pool state resets.
let seq = 0
async function load(env) {
  for (const k of ["NOVELAI_TOKEN", "NOVELAI_TOKENS"]) delete process.env[k]
  Object.assign(process.env, env)
  return await import(modPath + "?v=" + ++seq)
}

const PARAMS = {
  model: "nai-diffusion-4-5-full",
  prompt: "1girl",
  negative: "",
  width: 1024, height: 1024, steps: 28, batch: 1, seed: 0,
  sampler: "k_euler_ancestral", guidance: 6, rescale: 0,
  smea: false, smeaDyn: false, characters: [], ucPreset: 0, qualityToggle: true,
}
const opus = (percent, anlas) => ({ active: true, tier: 3, tierName: "Opus", anlas, opusPercent: percent })
const tablet = (anlas) => ({ active: true, tier: 1, tierName: "Tablet", anlas, opusPercent: undefined })

function seed(P, states) {
  const list = P.pool()
  list.forEach((a, i) => {
    a.state = states[i] ?? null
    a.stateFetchedAt = Date.now()
  })
  return list
}

console.log("parsing tokens")
{
  const P = await load({ NOVELAI_TOKENS: "a=pst-AAA, b=pst-BBB\npst-CCC" })
  const list = P.pool()
  check("splits on commas and newlines", list.length === 3, `got ${list.length}`)
  check("reads labels", list[0].label === "a" && list[1].label === "b")
  check("unlabelled entries get a default name", list[2].label === "账户3")
  check("keeps the token for use", list[0].token === "pst-AAA")
  check("fingerprints differ", new Set(list.map((a) => a.fingerprint)).size === 3)
}
{
  // Counting one token twice would make the balancer believe in twice the
  // quota and send it twice the traffic.
  const P = await load({ NOVELAI_TOKENS: "a=pst-SAME,b=pst-SAME" })
  check("a repeated token is pooled once", P.pool().length === 1)
}
{
  const P = await load({ NOVELAI_TOKEN: "pst-SOLO", NOVELAI_TOKENS: "x=pst-X" })
  check("NOVELAI_TOKEN is folded into the pool", P.pool().length === 2)
}
{
  const P = await load({})
  check("no config means an empty pool", P.pool().length === 0)
  check("the empty-pool message names the variables", /NOVELAI_TOKENS/.test(P.explainEmpty(PARAMS)))
}

console.log("free requests")
{
  const P = await load({ NOVELAI_TOKENS: "low=pst-1,high=pst-2,mid=pst-3" })
  seed(P, [opus(5, 0), opus(90, 0), opus(40, 0)])
  const ranked = P.rank(PARAMS)
  check("every Opus account can serve a free request", ranked.length === 3)
  check("all are priced free", ranked.every((c) => c.free && c.cost === 0))
  // The point of balancing: spread onto whoever has the most left, so no one
  // account is exhausted while the others sit idle.
  check("most allowance wins", ranked[0].account.label === "high")
  check("least allowance is last", ranked[2].account.label === "low")
}
{
  const P = await load({ NOVELAI_TOKENS: "opus=pst-1,tab=pst-2" })
  seed(P, [opus(50, 0), tablet(5000)])
  const ranked = P.rank(PARAMS)
  // A non-Opus account has no free tier, so this request costs Anlas there.
  check("a Tablet account is not free", ranked.find((c) => c.account.label === "tab").free === false)
  check("the Opus account is preferred", ranked[0].account.label === "opus" && ranked[0].free)
}

console.log("paid requests")
{
  // Over 1 MP, so nobody gets it free.
  const big = { ...PARAMS, width: 1216, height: 1216 }
  const P = await load({ NOVELAI_TOKENS: "poor=pst-1,rich=pst-2,broke=pst-3" })
  seed(P, [opus(80, 30), opus(10, 900), opus(99, 0)])
  const ranked = P.rank(big)
  check("an account that cannot pay is excluded", !ranked.some((c) => c.account.label === "broke"))
  check("the richest is chosen", ranked[0].account.label === "rich")
  check("free allowance does not decide a paid request", ranked[0].account.state.opusPercent === 10)
  check("the cost is reported", ranked[0].cost > 0)
  const why = P.explainEmpty(big)
  check("the explanation names the shortfall", /broke/.test(why) && /Anlas/.test(why))
}

console.log("exclusions")
{
  const P = await load({ NOVELAI_TOKENS: "ok=pst-1,cold=pst-2,off=pst-3,unknown=pst-4" })
  const list = seed(P, [opus(50, 0), opus(99, 0), { ...opus(99, 0), active: false }, null])
  list[1].cooldownUntil = Date.now() + 60_000
  list[1].lastError = "401 令牌无效"
  const ranked = P.rank(PARAMS)
  check("only the healthy account is ranked", ranked.length === 1 && ranked[0].account.label === "ok")
  const why = P.explainEmpty({ ...PARAMS, width: 4096, height: 4096 })
  check("cooldown is explained with a countdown", /cold.*冷却中/s.test(why))
  check("an inactive subscription is explained", /off.*未激活/s.test(why))
  check("a failed state fetch is explained", /unknown.*状态获取失败/s.test(why))
  check("the explanation never contains a token", !/pst-/.test(why))
}

console.log("leases and failover")
{
  const P = await load({ NOVELAI_TOKENS: "a=pst-1,b=pst-2" })
  const list = seed(P, [opus(50, 0), opus(50, 0)])
  const lease = { account: list[0], cost: 0, free: true }

  // Only account-specific failures are worth handing to another account: a bad
  // prompt fails identically everywhere, and retrying would burn the pool.
  check("a 401 fails over", P.fail(lease, new Error("401 令牌无效或已过期")).retryable === true)
  check("a 401 sidelines the account", list[0].cooldownUntil > Date.now() + 500_000)
  list[0].cooldownUntil = 0
  check("insufficient Anlas fails over", P.fail(lease, new Error("402 Anlas 或订阅额度不足")).retryable === true)
  list[0].cooldownUntil = 0
  check("a rate limit fails over briefly", P.fail(lease, new Error("429 请求过于频繁")).retryable === true)
  check("the rate-limit cooldown is short", list[0].cooldownUntil < Date.now() + 120_000)
  list[0].cooldownUntil = 0
  check("a prompt error does not fail over", P.fail(lease, new Error("prompt is too long")).retryable === false)
  check("a prompt error does not sideline the account", list[0].cooldownUntil === 0)
}
{
  const P = await load({ NOVELAI_TOKENS: "a=pst-1,b=pst-2" })
  const list = seed(P, [opus(50, 100), opus(50, 100)])
  const lease = { account: list[0], cost: 0, free: true }
  list[0].inFlight = 1
  P.succeed(lease)
  check("success clears the in-flight count", list[0].inFlight === 0)
  check("success counts the generation", list[0].used === 1)

  // Equal accounts must alternate, or one of them never gets used.
  check("the next free request goes to the other account", P.rank(PARAMS)[0].account.label === "b")

  const paid = { account: list[1], cost: 50, free: false }
  list[1].stateFetchedAt = Date.now()
  P.succeed(paid)
  // The balance just changed, so the cached figure is wrong.
  check("a paid generation invalidates the cached state", list[1].stateFetchedAt === 0)
}

console.log("status output")
{
  const P = await load({ NOVELAI_TOKENS: "a=pst-SECRET-VALUE" })
  seed(P, [opus(42, 7)])
  const rows = P.status()
  const text = JSON.stringify(rows)
  check("reports the account", rows.length === 1 && rows[0].label === "a")
  check("reports the figures", rows[0].anlas === 7 && rows[0].opusPercentRemaining === 42)
  // This is returned by a tool, so it reaches the model and the transcript.
  check("never contains the token", !text.includes("pst-SECRET-VALUE") && !text.includes("SECRET"))
  check("carries a fingerprint instead", /^[0-9a-f]{8}$/.test(rows[0].fingerprint))
}

console.log(failures === 0 ? "\n+ all pool checks passed" : `\n- ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
