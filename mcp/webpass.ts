/**
 * Set the review page's login password.
 *
 *   printf '%s' "$PASSWORD" | node dist/webpass.mjs [env file]      (on the server, as root)
 *
 * The password is read from stdin — argv shows up in `ps` and shell history —
 * and only its scrypt hash is written, as NOVELAI_WEB_PASSWORD_HASH in the
 * service's env file (default /etc/novelai-mcp.env), replacing any earlier
 * one. The file is rewritten in place, keeping its owner and mode. Restart the
 * service afterwards; every existing web session is signed out by the change.
 */
import { readFileSync, statSync, writeFileSync, chmodSync, chownSync, renameSync } from "node:fs"

import { hashPassword } from "./webauth"

const file = process.argv[2] ?? "/etc/novelai-mcp.env"
const password = readFileSync(0, "utf8").replace(/\r?\n$/, "")
if (password.length < 12) {
  console.error("密码至少 12 个字符")
  process.exit(1)
}
if (/[\r\n]/.test(password)) {
  console.error("密码里不能有换行")
  process.exit(1)
}

const line = `NOVELAI_WEB_PASSWORD_HASH=${hashPassword(password)}`
const before = readFileSync(file, "utf8")
const lines = before.split("\n").filter((l) => !l.startsWith("NOVELAI_WEB_PASSWORD_HASH="))
while (lines.length && lines[lines.length - 1] === "") lines.pop()
const st = statSync(file)
const tmp = file + ".webpass.tmp"
writeFileSync(tmp, lines.concat(line, "").join("\n"), { mode: st.mode & 0o777 })
chownSync(tmp, st.uid, st.gid)
chmodSync(tmp, st.mode & 0o777)
renameSync(tmp, file)
console.log(`已写入 ${file}：NOVELAI_WEB_PASSWORD_HASH（scrypt）。重启服务生效，已登录的网页会话都会失效。`)
