# mcp-storyset

MCP server for [storyset.com](https://storyset.com) — search, download, and recolor free illustrations from any MCP client.

Runs as a **remote MCP server on Cloudflare Workers** (McpAgent + Durable Objects, [`agents`](https://www.npmjs.com/package/agents) SDK).

## Try it

It's already deployed and **free to use — no install, no signup, no API key**:

```
https://storyset-mcp.engdawood.com/mcp
```

**Claude Code:**

```bash
claude mcp add --transport http storyset https://storyset-mcp.engdawood.com/mcp
```

**Claude Desktop / Cursor / Windsurf** — add to your MCP config (`claude_desktop_config.json`, `.cursor/mcp.json`, …):

```json
{
  "mcpServers": {
    "storyset": {
      "type": "http",
      "url": "https://storyset-mcp.engdawood.com/mcp"
    }
  }
}
```

**Just poke at it** — no client setup:

```bash
npx @modelcontextprotocol/inspector https://storyset-mcp.engdawood.com/mcp
```

Then ask: *"Find storyset illustrations about developers and give me the top 3 SVGs."*

Transports: `/mcp` (Streamable HTTP, modern clients) and `/sse` (legacy clients). Prefer to run your own copy? See [Deploy your own instance](#deploy-your-own-instance).

## Tools

| Tool | Purpose |
|------|---------|
| `search(query, limit=20)` | Search illustrations. Returns `{query, count, results[]}`, each result `{title, slug, style, page_url, preview_url}`. `limit` 1–60. |
| `get_illustration(slug, style="amico")` | Resolve one illustration's canonical PNG + SVG asset URLs. Returns `{slug, style, page_url, png_url, svg_url}`. |
| `download(asset_url, recolor?, inline=false)` | Resolve an asset and return `{filename, content_type, bytes, encoding, url}`. Optional `recolor` map rewrites SVG hex colors — the returned `url` then regenerates that recolored SVG on demand. Only accepts `stories.freepiklabs.com` URLs. |
| `extract_palette(source, top=12)` | List dominant hex colors in an SVG, sorted by frequency. Returns `{source, unique_colors, palette[]}`. `top` 1–64. |
| `recolor_svg(source, mapping, inline=false)` | Rewrite hex colors in an SVG. Returns `{source, bytes, recolor_stats, url}` — `recolor_stats` is a per-color replacement count. |
| `search_and_download(query, limit=5, style?, format="svg", recolor?, inline=false)` | One-shot: search → resolve → fetch top N. Returns `{query, format, saved[], errors[]}`. `limit` 1–20. |

Styles: `amico`, `bro`, `cuate`, `pana`, `rafiki`.

`source` (on `extract_palette` / `recolor_svg`) accepts either a `stories.freepiklabs.com` SVG URL **or** raw SVG markup. There is no filesystem on Workers, so local file paths are not supported.

### How assets come back

**Tools return a `url`, not the file bytes.** Illustrations routinely run past 100 KB, and dumping that into a model's context is wasteful — so `download`, `recolor_svg`, and `search_and_download` hand back a fetchable URL plus metadata (`filename`, `bytes`, `content_type`, `encoding`).

Pass `inline: true` only when you actually need to read or transform the markup:

- SVGs come back as text (`encoding: "utf-8"`), PNGs as base64 (`encoding: "base64"`).
- Anything over **64,000 bytes** is dropped regardless, and the result carries `content_omitted: "too_large"` with `max_inline_bytes`. The `url` still works.
- `recolor_svg` on **raw markup** is the one exception — there's no source URL to regenerate from, so it always returns inline.

For a recolored SVG, `url` points back at this Worker (`/f/recolor.svg`), which re-fetches the original and re-applies the mapping on each request. Same inputs always produce the same bytes, so responses are cached for 24h.

## Usage examples

Once connected, ask your MCP client things like:

- *"Find storyset illustrations about developers and give me the top 3 SVGs."*
- *"Get the rafiki style of the 'finance' illustration as PNG."*
- *"Show the color palette of this SVG and swap the primary color to `#2196F3`."*
- *"Get 'programmer / amico' SVG but recolor `#ba68c8` → `#10b981`."*

### Recolor cheatsheet

Storyset SVGs store colors as inline `style="fill:#xxxxxx"`. The primary brand color is usually the most-frequent hex in the palette (often `#ba68c8` purple). Workflow:

1. `extract_palette(source=svg_url)` → see colors + counts.
2. `recolor_svg(source=svg_url, mapping={"#ba68c8": "#2196f3"})` → get a URL serving the remapped SVG.
3. Or skip step 2 and pass `recolor={...}` directly to `download` / `search_and_download`.

Mappings take 3- or 6-digit hex, case-insensitive. Recolor is SVG-only — it's rejected on PNG (`error: "recolor_unsupported"`) and silently skipped by `search_and_download` when `format="png"`.

## HTTP endpoints

| Path | Purpose |
|------|---------|
| `/mcp` | Streamable HTTP transport (modern MCP clients) |
| `/sse` | SSE transport (legacy MCP clients) |
| `/f/recolor.svg?src=<asset_url>&map=<json>` | Serves a recolored SVG. Generated for you by `download` / `recolor_svg` — no need to build it by hand. |
| `/` | Server info JSON (`name`, `version`, `endpoints`) |

Any other path returns 404 by design: a catch-all 200 would make `/.well-known/oauth-*` probes look like valid discovery documents and send clients into a client-registration flow that can't succeed. This server has no OAuth.

## Requirements

Only for local development or self-hosting — the public instance needs none of this.

- Node.js 18+ and `pnpm`
- Outbound HTTPS to `storyset.com` and `stories.freepiklabs.com`
- A Cloudflare account (only for `pnpm deploy`)

## Run locally

```bash
pnpm install
pnpm dev        # wrangler dev → http://127.0.0.1:8787
```

Point a client at `http://127.0.0.1:8787/mcp` (or `/sse`):

```bash
claude mcp add --transport http storyset-local http://127.0.0.1:8787/mcp
npx @modelcontextprotocol/inspector http://127.0.0.1:8787/mcp
```

Other commands:

```bash
pnpm typecheck  # tsc --noEmit
pnpm smoke      # MCP client smoke test against a running `pnpm dev`
```

## Deploy your own instance

The public instance is already live, so this is only for self-hosting. Set your own hostname in `wrangler.jsonc` (the `routes` pattern and `PUBLIC_ORIGIN`) first — `PUBLIC_ORIGIN` is what recolor URLs are built from, so a stale value yields URLs pointing at someone else's Worker.

```bash
pnpm wrangler login
pnpm deploy
```

Wrangler provisions the Durable Objects namespace (`MCP_OBJECT`, class `StorysetMCP`) automatically from `wrangler.jsonc` on first deploy, and creates the DNS record and certificate for the custom domain.

## Project layout

```
worker/
  index.ts      # Worker entry: StorysetMCP (McpAgent) + tool registration + routing
  lib.ts        # storyset.com scraping + SVG palette/recolor logic
scripts/
  smoke.mjs     # MCP client smoke test (tools/list + live search)
wrangler.jsonc  # Worker config: custom domain, Durable Objects binding, migration
```

## Notes

- Storyset content is free under their license — **credit is required** for free-tier use. See <https://storyset.com/terms>.
- This server scrapes public HTML. No API key, no authentication.
- Asset downloads are restricted to `stories.freepiklabs.com`; any other host is rejected with `error: "invalid_url"`.
