/**
 * mcp-storyset — remote MCP server on Cloudflare Workers.
 * TypeScript port of py-MCP-STORYSET; same 6 tools, served over /sse and /mcp.
 */
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  ASSET_HOST,
  MAX_INLINE_BYTES,
  RECOLOR_PATH,
  downloadAsset,
  extractPalette,
  getIllustration,
  recolorSvg,
  regenerateRecolored,
  searchAndDownload,
  searchStoryset,
} from "./lib.js";

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  /** Public origin used to build asset URLs handed back to clients. */
  PUBLIC_ORIGIN?: string;
  /** Per-IP rate limiter (see `ratelimits` in wrangler.jsonc). Optional so local dev works without it. */
  RATE_LIMITER?: RateLimit;
  /** Secret. Requests sending it in `x-bypass-token` skip the rate limiter. */
  BYPASS_TOKEN?: string;
}

async function hasBypassToken(request: Request, env: Env): Promise<boolean> {
  const given = request.headers.get("x-bypass-token");
  if (!given || !env.BYPASS_TOKEN) return false;
  // Hash both sides so the comparison is constant-time and length-independent.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(env.BYPASS_TOKEN)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const INLINE_DESC =
  `Return the asset bytes in the result. Off by default: assets can exceed ${MAX_INLINE_BYTES} ` +
  "bytes and would flood the context. Use the returned `url` instead unless you need to read the markup.";

function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

const STYLE = z.enum(["amico", "bro", "cuate", "pana", "rafiki"]);

export class StorysetMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "mcp-storyset",
    version: "0.1.0",
  });

  async init() {
    this.server.registerTool(
      "search",
      {
        description:
          "Search storyset.com illustrations. Returns list of {title, slug, style, page_url, preview_url}.",
        inputSchema: {
          query: z.string().describe("Search keyword, e.g. 'developer', 'finance'"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(60)
            .default(20)
            .describe("Max results to return"),
        },
      },
      async ({ query, limit }) => json(await searchStoryset(query, limit)),
    );

    this.server.registerTool(
      "get_illustration",
      {
        description:
          "Fetch one illustration's page and return canonical PNG + SVG download URLs.",
        inputSchema: {
          slug: z.string().describe("Illustration slug, e.g. 'programmer'"),
          style: STYLE.default("amico").describe("Style variant"),
        },
      },
      async ({ slug, style }) => json(await getIllustration(slug, style)),
    );

    this.server.registerTool(
      "download",
      {
        description:
          "Resolve an asset URL and return its metadata plus a ready-to-use `url` " +
          "(filename, byte size, content type). Optional `recolor` map rewrites hex colors " +
          "inside an SVG (handy for changing the primary brand color of a Storyset " +
          "illustration); the returned `url` then regenerates that recolored SVG on demand.",
        inputSchema: {
          asset_url: z.string().describe(`Direct asset URL from ${ASSET_HOST} (svg/png)`),
          recolor: z
            .record(z.string(), z.string())
            .optional()
            .describe(
              "Optional SVG-only color remap, e.g. {'#BA68C8': '#2196F3'}. " +
                "Keys = colors currently in SVG, values = target colors. Ignored for PNG.",
            ),
          inline: z.boolean().default(false).describe(INLINE_DESC),
        },
      },
      async ({ asset_url, recolor, inline }) =>
        json(await downloadAsset(asset_url, { recolor, inline, origin: this.publicOrigin })),
    );

    this.server.registerTool(
      "extract_palette",
      {
        description:
          "Return the dominant hex colors in an SVG, sorted by frequency. " +
          "Use this to discover which color to feed into `recolor` / `download(recolor=...)`. " +
          "The top entry is usually the primary brand color (e.g. #ba68c8 on Storyset).",
        inputSchema: {
          source: z.string().describe(`SVG asset URL (${ASSET_HOST}) or raw SVG markup`),
          top: z
            .number()
            .int()
            .min(1)
            .max(64)
            .default(12)
            .describe("Max colors to return"),
        },
      },
      async ({ source, top }) => json(await extractPalette(source, top)),
    );

    this.server.registerTool(
      "recolor_svg",
      {
        description:
          "Recolor an SVG and return a `url` serving the modified copy, plus per-color " +
          "replacement counts. Use `extract_palette` first to see colors. Raw inline markup " +
          "has no source URL to regenerate from, so it is returned inline instead.",
        inputSchema: {
          source: z.string().describe(`SVG asset URL (${ASSET_HOST}) or raw SVG markup`),
          mapping: z
            .record(z.string(), z.string())
            .describe(
              "Color remap, e.g. {'#BA68C8': '#2196F3', '#455a64': '#1a237e'}. " +
                "Hex 3-digit or 6-digit, case insensitive.",
            ),
          inline: z.boolean().default(false).describe(INLINE_DESC),
        },
      },
      async ({ source, mapping, inline }) =>
        json(await recolorSvg(source, mapping, { inline, origin: this.publicOrigin })),
    );

    this.server.registerTool(
      "search_and_download",
      {
        description:
          "Search then download top N matching illustrations in chosen format. " +
          "Assets are returned inline (SVG as utf-8 text, PNG as base64).",
        inputSchema: {
          query: z.string().describe("Search keyword"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(20)
            .default(5)
            .describe("How many illustrations to fetch"),
          style: STYLE.optional().describe("Filter results to one style. Omit for all."),
          format: z.enum(["svg", "png"]).default("svg").describe("svg or png"),
          recolor: z
            .record(z.string(), z.string())
            .optional()
            .describe("SVG color remap applied to every downloaded SVG. Ignored for PNG."),
          inline: z.boolean().default(false).describe(INLINE_DESC),
        },
      },
      async ({ query, limit, style, format, recolor, inline }) =>
        json(
          await searchAndDownload(query, limit, style, format, {
            recolor,
            inline,
            origin: this.publicOrigin,
          }),
        ),
    );
  }

  private get publicOrigin(): string | undefined {
    return this.env.PUBLIC_ORIGIN;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname !== "/" && env.RATE_LIMITER && !(await hasBypassToken(request, env))) {
      const key = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key });
      if (!success) {
        return new Response(JSON.stringify({ error: "Too many requests" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "60" },
        });
      }
    }
    if (pathname.startsWith("/sse")) {
      return StorysetMCP.serveSSE("/sse").fetch(request, env, ctx);
    }
    if (pathname.startsWith("/mcp")) {
      return StorysetMCP.serve("/mcp").fetch(request, env, ctx);
    }
    if (pathname === RECOLOR_PATH) {
      const result = await regenerateRecolored(
        url.searchParams.get("src"),
        url.searchParams.get("map"),
      );
      if (!result.ok) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(result.svg, {
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          "content-disposition": `inline; filename="${result.filename}"`,
          // Same inputs always produce the same bytes, so this is safe to cache hard.
          "cache-control": "public, max-age=86400",
        },
      });
    }
    if (pathname === "/") {
      return new Response(
        JSON.stringify({
          name: "mcp-storyset",
          version: "0.1.0",
          endpoints: { sse: "/sse", mcp: "/mcp" },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    // This server has no OAuth. A catch-all 200 makes `/.well-known/oauth-*` probes
    // look like valid discovery documents, so clients start a client-registration
    // flow that cannot succeed. Unknown paths must 404.
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
