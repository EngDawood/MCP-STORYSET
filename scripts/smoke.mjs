/**
 * Full smoke test for the mcp-storyset worker.
 * Expects `wrangler dev` to be running (default http://127.0.0.1:8787).
 * Exercises all 6 tools against live storyset.com.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8787/mcp");
let failures = 0;

function check(name, cond, extra = "") {
  if (cond) {
    console.log(`ok   ${name}${extra ? " — " + extra : ""}`);
  } else {
    console.error(`FAIL ${name}${extra ? " — " + extra : ""}`);
    failures++;
  }
}

const client = new Client({ name: "mcp-storyset-smoke", version: "0.2.0" });
await client.connect(new StreamableHTTPClientTransport(url));

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} returned isError: ${res.content?.[0]?.text}`);
  return JSON.parse(res.content?.[0]?.text ?? "{}");
}

// --- tools/list -------------------------------------------------------------
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const expected = [
  "download",
  "extract_palette",
  "get_illustration",
  "recolor_svg",
  "search",
  "search_and_download",
];
check("tools/list has exactly the 6 tools", JSON.stringify(names) === JSON.stringify(expected), names.join(","));

// --- search -------------------------------------------------------------------
const s = await call("search", { query: "developer", limit: 3 });
check("search returns parsed results", s.count > 0 && s.results.length > 0, `count=${s.count}`);
const first = s.results[0] ?? {};
check(
  "search result fields",
  ["title", "slug", "style", "page_url", "preview_url"].every((k) => k in first),
  `${first.slug}/${first.style}`,
);

// --- get_illustration -----------------------------------------------------------
const gi = await call("get_illustration", { slug: first.slug, style: first.style });
check("get_illustration returns png_url", typeof gi.png_url === "string" && gi.png_url.length > 0);
check("get_illustration returns svg_url", typeof gi.svg_url === "string" && gi.svg_url.length > 0);

// --- extract_palette ------------------------------------------------------------
const ep = await call("extract_palette", { source: gi.svg_url, top: 5 });
check(
  "extract_palette returns colors",
  ep.unique_colors > 0 && Array.isArray(ep.palette) && ep.palette.length > 0,
  `top=${ep.palette?.[0]?.color} x${ep.palette?.[0]?.count}`,
);
const primary = ep.palette[0].color;

// --- download (svg + recolor) ----------------------------------------------------
const dl = await call("download", {
  asset_url: gi.svg_url,
  recolor: { [primary]: "#2196f3" },
});
check("download returns inline svg", dl.encoding === "utf-8" && dl.content.includes("<svg"), `${dl.bytes} bytes`);
check(
  "download recolor applied",
  dl.recolor_stats?.[primary] > 0 && dl.content.includes("#2196f3"),
  `${primary} replaced ${dl.recolor_stats?.[primary]}x`,
);

// --- recolor_svg (raw inline svg) -------------------------------------------------
const rawSvg = `<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:#BA68C8"/><circle fill="#ba68c8"/><path style="fill: #455a64"/></svg>`;
const rc = await call("recolor_svg", { source: rawSvg, mapping: { "#ba68c8": "#10b981" } });
check(
  "recolor_svg rewrites all case variants",
  rc.recolor_stats?.["#ba68c8"] === 2 && rc.svg.includes("#10b981") && !rc.svg.toLowerCase().includes("#ba68c8"),
  `stats=${JSON.stringify(rc.recolor_stats)}`,
);

// --- search_and_download ----------------------------------------------------------
const sad = await call("search_and_download", { query: "developer", limit: 1, format: "svg" });
check(
  "search_and_download saves inline",
  Array.isArray(sad.saved) && sad.saved.length === 1 && sad.saved[0].encoding === "utf-8" && sad.saved[0].content.includes("<svg"),
  `errors=${sad.errors?.length ?? 0}`,
);

await client.close();
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
