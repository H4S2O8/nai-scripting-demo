/**
 * Local entry point: one MCP server on stdio, for a desktop client.
 *
 * Nothing is authenticated here because nothing is exposed — the client
 * launches the process and owns both ends of the pipe. The network entry
 * (http.ts) is where credentials matter.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { buildServer } from "./tools"

await buildServer().connect(new StdioServerTransport())
