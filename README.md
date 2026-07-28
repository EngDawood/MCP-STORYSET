# mcp-storyset (Cloudflare Workers / TypeScript)

MCP server for [storyset.com](https://storyset.com) — search, download, and recolor free illustrations from any MCP client.

TypeScript port of [`py-MCP-STORYSET`](py-MCP-STORYSET/), built to run as a **remote MCP server on Cloudflare Workers** (McpAgent + Durable Objects, [`agents`](https://www.npmjs.com/package/agents) SDK). The original Python stdio server still lives in `py-MCP-STORYSET/` and is untouched.

## Tools

Same 6 tools as the Python version:

| Tool | Purpose |
|------|---------|
| `search(query, limit=20)` | Search illustrations. Returns `{title, slug, style, page_url, preview_url}` per result. |
| `get_illustration(slug, style="amico")` | Resolve canonical PNG + SVG asset URLs for one illustration. |
| `download(asset_url, recolor?)` | Fetch an asset and return it **inline** (SVG as utf-8 text, PNG as base64). Optional SVG recolor map. Only accepts `stories.freepiklabs.com` URLs. |
| `extract_palette(source, top=12)` | List dominant hex colors in an SVG (asset URL or raw SVG markup), sorted by frequency. |
| `recolor_svg(source, mapping)` | Rewrite hex colors inside an SVG and return the modified copy **inline**. |
| `search_and_download(query, limit=5, style?, format="svg", recolor?)` | One-shot: search → resolve → fetch top N **inline** (with optional recolor). |

Styles: `amico`, `bro`, `cuate`, `pana`, `rafiki`.

### Differences from the Python version

Cloudflare Workers have no filesystem, so save-to-disk semantics were adapted:

- `download` / `search_and_download` / `recolor_svg` **return content inline** instead of writing files — SVGs come back as text (`encoding: "utf-8"`), PNGs as base64 (`encoding: "base64"`). Save them client-side if needed.
- `extract_palette` / `recolor_svg` accept an asset URL **or raw SVG markup** as `source` (no local file paths).
- `output_dir` / `output_path` / `filename` parameters and the `STORYSET_DOWNLOAD_DIR` env var are gone.

Everything else — tool names, scraping logic, recolor behavior — is a faithful port.

## Requirements

- Node.js 18+ and `pnpm`
- Outbound HTTPS to `storyset.com` and `stories.freepiklabs.com`
- A Cloudflare account (only for `pnpm deploy`)

## Install & run locally

```bash
pnpm install
pnpm dev        # wrangler dev → http://127.0.0.1:8787
```

MCP endpoints:

- `http://127.0.0.1:8787/mcp` — Streamable HTTP (modern clients)
- `http://127.0.0.1:8787/sse` — SSE (legacy clients)

Other useful commands:

```bash
pnpm typecheck  # tsc --noEmit
pnpm smoke      # MCP client smoke test against a running `pnpm dev`
```

## Connect an MCP client

Point any remote-MCP-capable client at the `/mcp` endpoint. For example, with Claude Code:

```bash
# local dev
claude mcp add --transport http storyset http://127.0.0.1:8787/mcp

# after deploy
claude mcp add --transport http storyset https://mcp-storyset.<your-subdomain>.workers.dev/mcp
```

Or test interactively with the MCP inspector:

```bash
npx @modelcontextprotocol/inspector http://127.0.0.1:8787/mcp
```

## Deploy to Cloudflare

One-time auth, then deploy:

```bash
pnpm wrangler login
pnpm deploy
```

Wrangler provisions the Durable Objects namespace (`MCP_OBJECT`, class `StorysetMCP`) automatically from `wrangler.jsonc` on first deploy. After deploy, the server is live at `https://mcp-storyset.<your-subdomain>.workers.dev` (`/mcp` and `/sse`).

## Usage examples

Once connected, ask your MCP client things like:

- *"Find storyset illustrations about developers and fetch the top 3 SVGs."*
- *"Get the rafiki style of the 'finance' illustration as PNG."*
- *"Show the color palette of this SVG and swap the primary color to `#2196F3`."*
- *"Fetch 'programmer / amico' SVG but recolor `#ba68c8` → `#10b981`."*

### Recolor cheatsheet

Storyset SVGs store colors as inline `style="fill:#xxxxxx"`. The primary brand color is usually the most-frequent hex in the palette (often `#ba68c8` purple). Workflow:

1. `extract_palette(source=svg_url)` → see colors + counts.
2. `recolor_svg(source=svg_url, mapping={"#ba68c8": "#2196f3"})` → get the remapped SVG back.
3. Or skip step 2 and pass `recolor={...}` directly to `download` / `search_and_download`.

## Project layout

```
worker/
  index.ts      # Worker entry: StorysetMCP (McpAgent) + tool registration + routing
  lib.ts        # storyset.com scraping + SVG palette/recolor logic (port of server.py)
scripts/
  smoke.mjs     # MCP client smoke test (tools/list + live search)
wrangler.jsonc  # Worker config: Durable Objects binding + migration
```

## Notes

- Storyset content is free under their license — credit required for free-tier use. See <https://storyset.com/terms>.
- This server scrapes public HTML. No API key.
