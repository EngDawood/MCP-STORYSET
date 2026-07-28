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
  downloadAsset,
  extractPalette,
  getIllustration,
  recolorSvg,
  searchAndDownload,
  searchStoryset,
} from "./lib.js";

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
}

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
          "Fetch an asset URL and return its content inline (SVG as utf-8 text, PNG as base64). " +
          "Optional `recolor` map rewrites hex colors inside an SVG before returning " +
          "(handy for changing the primary brand color of a Storyset illustration).",
        inputSchema: {
          asset_url: z.string().describe(`Direct asset URL from ${ASSET_HOST} (svg/png)`),
          recolor: z
            .record(z.string(), z.string())
            .optional()
            .describe(
              "Optional SVG-only color remap, e.g. {'#BA68C8': '#2196F3'}. " +
                "Keys = colors currently in SVG, values = target colors. Ignored for PNG.",
            ),
        },
      },
      async ({ asset_url, recolor }) => json(await downloadAsset(asset_url, recolor)),
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
          "Recolor an SVG and return the modified copy inline. " +
          "Use `extract_palette` first to see colors.",
        inputSchema: {
          source: z.string().describe(`SVG asset URL (${ASSET_HOST}) or raw SVG markup`),
          mapping: z
            .record(z.string(), z.string())
            .describe(
              "Color remap, e.g. {'#BA68C8': '#2196F3', '#455a64': '#1a237e'}. " +
                "Hex 3-digit or 6-digit, case insensitive.",
            ),
        },
      },
      async ({ source, mapping }) => json(await recolorSvg(source, mapping)),
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
        },
      },
      async ({ query, limit, style, format, recolor }) =>
        json(await searchAndDownload(query, limit, style, format, recolor)),
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/sse")) {
      return StorysetMCP.serveSSE("/sse").fetch(request, env, ctx);
    }
    if (pathname.startsWith("/mcp")) {
      return StorysetMCP.serve("/mcp").fetch(request, env, ctx);
    }
    return new Response(
      JSON.stringify({
        name: "mcp-storyset",
        version: "0.1.0",
        endpoints: { sse: "/sse", mcp: "/mcp" },
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
} satisfies ExportedHandler<Env>;
