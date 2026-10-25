/**
 * A client for the E-Hentai publisher MCP running on the same host.
 *
 * The review page publishes through it rather than talking to E-Hentai
 * itself: that service already owns the site login, the upload adapter, the
 * AI and GURO title rules and the cover renderer, and drawing covers in one
 * place is what makes a preview here match what gets uploaded.
 *
 *   EH_MCP_URL    e.g. http://127.0.0.1:8791/eh-mcp
 *   EH_MCP_TOKEN  that service's bearer key; it never reaches the browser
 *
 * Each call opens a fresh connection: the service is stateless, like ours.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

export type EhResult = { json: any; image: Buffer | null }

export class EhClient {
  constructor(
    private url: string,
    private token: string,
  ) {}

  /** The configured client, or null when this server has no E-Hentai service. */
  static fromEnv(): EhClient | null {
    const url = process.env.EH_MCP_URL?.trim()
    const token = process.env.EH_MCP_TOKEN?.trim()
    return url && token ? new EhClient(url, token) : null
  }

  async call(name: string, args: Record<string, unknown>): Promise<EhResult> {
    const client = new Client({ name: "novelai-studio", version: "1.0.0" })
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { Authorization: `Bearer ${this.token}` } },
    })
    try {
      await client.connect(transport)
      const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as {
        isError?: boolean
        content?: { type: string; text?: string; data?: string }[]
        structuredContent?: any
      }
      const content = result.content ?? []
      const texts = content.filter((c) => c.type === "text").map((c) => c.text ?? "")
      if (result.isError) throw new Error(texts.join("\n") || `E-Hentai 服务的 ${name} 调用失败`)
      const imagePart = content.find((c) => c.type === "image")
      let json: any = result.structuredContent ?? null
      if (json && typeof json === "object" && "result" in json && Object.keys(json).length === 1) json = json.result
      if (json === null && texts.length) {
        try {
          json = texts.length === 1 ? JSON.parse(texts[0]) : texts.map((t) => JSON.parse(t))
        } catch {
          json = texts.join("\n")
        }
      }
      return { json, image: imagePart?.data ? Buffer.from(imagePart.data, "base64") : null }
    } finally {
      await client.close().catch(() => {})
    }
  }
}
