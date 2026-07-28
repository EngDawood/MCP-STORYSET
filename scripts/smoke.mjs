/**
 * Smoke test for the mcp-storyset worker.
 * Expects `wrangler dev` to be running (default http://127.0.0.1:8787).
 * Verifies: initialize + tools/list returns the 6 tools, and a live
 * `search` call against storyset.com returns parsed results.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8787/mcp");

const client = new Client({ name: "mcp-storyset-smoke", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(url);
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log("tools:", JSON.stringify(names));

const expected = [
  "search",
  "get_illustration",
  "download",
  "extract_palette",
  "recolor_svg",
  "search_and_download",
].sort();
const missing = expected.filter((n) => !names.includes(n));
if (missing.length > 0) {
  console.error("MISSING TOOLS:", missing);
  process.exit(1);
}

const res = await client.callTool({
  name: "search",
  arguments: { query: "developer", limit: 3 },
});
const text = res.content?.[0]?.text ?? "";
console.log("search result (truncated):", text.slice(0, 600));
const parsed = JSON.parse(text);
if (!Array.isArray(parsed.results) || parsed.results.length === 0) {
  console.error("SEARCH RETURNED NO RESULTS");
  process.exit(1);
}
const first = parsed.results[0];
for (const key of ["title", "slug", "style", "page_url", "preview_url"]) {
  if (!(key in first)) {
    console.error("RESULT MISSING FIELD:", key);
    process.exit(1);
  }
}

console.log("SMOKE OK");
await client.close();
process.exit(0);
