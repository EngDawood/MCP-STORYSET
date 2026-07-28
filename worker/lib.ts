/**
 * Scraping + SVG helpers for storyset.com.
 * Ported from py-MCP-STORYSET (src/mcp_storyset/server.py).
 * Pure logic plus fetch — no Worker-specific APIs, no filesystem.
 */

export const BASE = "https://storyset.com";
export const ASSET_HOST = "stories.freepiklabs.com";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const FETCH_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
};

const TIMEOUT_MS = 30_000;

async function fetchPage(url: string): Promise<{ status: number; html: string }> {
  const res = await fetch(url, {
    headers: FETCH_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: res.status, html: await res.text() };
}

// ---------------------------------------------------------------------------
// search page parsing
// ---------------------------------------------------------------------------

const CARD_RE =
  /<a href="(?<href>\/illustration\/(?<slug>[^/"]+)\/(?<style>[^"]+))"\s+title="(?<title>[^"]+)"[^>]*data-testid="vector-illustration">(?<body>.*?)<\/a>/gs;
const IMG_RE =
  /<img[^>]+(?:src|data-src)="(?<url>https:\/\/stories\.freepiklabs\.com\/[^"]+)"/;

export interface SearchResult {
  title: string;
  slug: string;
  style: string;
  page_url: string;
  preview_url: string | null;
}

export function parseSearch(html: string, limit: number): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(CARD_RE)) {
    const g = m.groups!;
    if (seen.has(g.href)) continue;
    seen.add(g.href);
    const img = IMG_RE.exec(g.body);
    out.push({
      title: g.title,
      slug: g.slug,
      style: g.style,
      page_url: `${BASE}${g.href}`,
      preview_url: img?.groups?.url ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// illustration page parsing
// ---------------------------------------------------------------------------

const OG_IMAGE_RE = /<meta[^>]+(?:property|name)="og:image"[^>]+content="([^"]+)"/;
const OG_IMAGE_ALT_RE = /<meta[^>]+content="([^"]+)"[^>]+(?:property|name)="og:image"/;
const ASSET_RE = /https:\/\/stories\.freepiklabs\.com\/storage\/\d+\/[^\s"'<>]+/g;

export function pickMainAsset(
  html: string,
  slug: string,
  style: string,
): { png_url: string | null; svg_url: string | null } {
  const og = OG_IMAGE_RE.exec(html) ?? OG_IMAGE_ALT_RE.exec(html);
  const pngUrl = og?.[1] ?? null;
  let svgUrl: string | null = null;
  const slugNorm = slug.replace(/-/g, "").toLowerCase();
  const styleNorm = style.toLowerCase();
  const urls = [...html.matchAll(ASSET_RE)].map((m) => m[0]);
  for (const url of urls) {
    if (!url.toLowerCase().endsWith(".svg")) continue;
    const name = url.split("/").pop()!.toLowerCase();
    const nameNorm = name.replace(/[^a-z0-9]/g, "");
    if (nameNorm.includes(slugNorm)) {
      svgUrl = url;
      break;
    }
  }
  if (svgUrl === null) {
    for (const url of urls) {
      if (url.toLowerCase().endsWith(".svg") && url.toLowerCase().includes(styleNorm)) {
        svgUrl = url;
        break;
      }
    }
  }
  return { png_url: pngUrl, svg_url: svgUrl };
}

// ---------------------------------------------------------------------------
// svg color helpers
// ---------------------------------------------------------------------------

const HEX_RE = /#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})\b/g;

export function normalizeHex(h: string): string {
  let s = h.startsWith("#") ? h.slice(1) : h;
  if (s.length === 3) s = [...s].map((c) => c + c).join("");
  return `#${s.toLowerCase()}`;
}

export interface PaletteEntry {
  color: string;
  count: number;
}

export function extractPaletteFromSvg(svg: string): PaletteEntry[] {
  const counts = new Map<string, number>();
  for (const m of svg.matchAll(HEX_RE)) {
    const color = normalizeHex(m[1]);
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([color, count]) => ({ color, count }))
    .sort((a, b) => b.count - a.count);
}

export function applyRecolor(
  svg: string,
  mapping: Record<string, string>,
): { svg: string; stats: Record<string, number> } {
  const normMap = new Map<string, string>();
  for (const [src, dst] of Object.entries(mapping)) {
    normMap.set(normalizeHex(src), normalizeHex(dst));
  }
  const stats: Record<string, number> = {};
  for (const key of normMap.keys()) stats[key] = 0;
  const out = svg.replace(HEX_RE, (raw) => {
    const norm = normalizeHex(raw);
    const dst = normMap.get(norm);
    if (dst === undefined) return raw;
    stats[norm] += 1;
    return dst;
  });
  return { svg: out, stats };
}

// ---------------------------------------------------------------------------
// misc helpers
// ---------------------------------------------------------------------------

export function safeFilename(url: string): string {
  const name = new URL(url).pathname.split("/").pop() || "asset";
  return name.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function isAssetUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && u.host === ASSET_HOST;
  } catch {
    return false;
  }
}

function isSvgUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".svg");
  } catch {
    return url.toLowerCase().endsWith(".svg");
  }
}

interface SourceError {
  error: string;
  detail?: string;
}

/**
 * Resolve an SVG source to its markup. `source` is either an asset URL on
 * stories.freepiklabs.com or raw SVG markup (there is no filesystem on
 * Workers, so local file paths from the Python version are not supported).
 */
async function loadSvgSource(source: string): Promise<string | SourceError> {
  if (/^https?:\/\//i.test(source)) {
    if (!isAssetUrl(source)) {
      return { error: "invalid_url", detail: `Only ${ASSET_HOST} URLs allowed` };
    }
    if (!isSvgUrl(source)) {
      return { error: "not_svg" };
    }
    const { status, html } = await fetchPage(source);
    if (status >= 400) throw new Error(`SVG fetch failed with HTTP ${status}`);
    return html;
  }
  if (source.trimStart().startsWith("<")) {
    return source;
  }
  return {
    error: "invalid_source",
    detail: `Pass a ${ASSET_HOST} SVG URL or raw SVG markup`,
  };
}

function echoSource(source: string): string {
  return /^https?:\/\//i.test(source) ? source : "<inline svg>";
}

// ---------------------------------------------------------------------------
// tool operations
// ---------------------------------------------------------------------------

export async function searchStoryset(query: string, limit: number) {
  const url = `${BASE}/search?q=${encodeURIComponent(query)}`;
  const { status, html } = await fetchPage(url);
  if (status >= 400) throw new Error(`storyset search failed with HTTP ${status}`);
  const results = parseSearch(html, limit);
  return { query, count: results.length, results };
}

export async function getIllustration(slug: string, style: string) {
  const url = `${BASE}/illustration/${slug}/${style}`;
  const { status, html } = await fetchPage(url);
  if (status === 404) {
    return { error: "not_found" as const, page_url: url, png_url: null, svg_url: null };
  }
  if (status >= 400) throw new Error(`storyset page fetch failed with HTTP ${status}`);
  const assets = pickMainAsset(html, slug, style);
  return { slug, style, page_url: url, ...assets };
}

export async function downloadAsset(assetUrl: string, recolor?: Record<string, string>) {
  if (!isAssetUrl(assetUrl)) {
    return { error: "invalid_url" as const, detail: `Only ${ASSET_HOST} URLs allowed` };
  }
  if (recolor && !isSvgUrl(assetUrl)) {
    return { error: "recolor_unsupported" as const, detail: "recolor only works for SVG" };
  }
  const res = await fetch(assetUrl, {
    headers: FETCH_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`asset download failed with HTTP ${res.status}`);
  const base = {
    filename: safeFilename(assetUrl),
    content_type: res.headers.get("content-type"),
    source_url: assetUrl,
  };
  const buf = await res.arrayBuffer();

  if (isSvgUrl(assetUrl)) {
    let svg = new TextDecoder().decode(buf);
    let stats: Record<string, number> | undefined;
    if (recolor) {
      const r = applyRecolor(svg, recolor);
      svg = r.svg;
      stats = r.stats;
    }
    return {
      ...base,
      bytes: new TextEncoder().encode(svg).length,
      encoding: "utf-8" as const,
      content: svg,
      ...(stats ? { recolor_stats: stats } : {}),
    };
  }
  return {
    ...base,
    bytes: buf.byteLength,
    encoding: "base64" as const,
    content: toBase64(buf),
  };
}

export async function extractPalette(source: string, top: number) {
  const svg = await loadSvgSource(source);
  if (typeof svg !== "string") return svg;
  const palette = extractPaletteFromSvg(svg);
  return {
    source: echoSource(source),
    unique_colors: palette.length,
    palette: palette.slice(0, top),
  };
}

export async function recolorSvg(source: string, mapping: Record<string, string>) {
  const svg = await loadSvgSource(source);
  if (typeof svg !== "string") return svg;
  const { svg: out, stats } = applyRecolor(svg, mapping);
  return {
    source: echoSource(source),
    bytes: new TextEncoder().encode(out).length,
    recolor_stats: stats,
    svg: out,
  };
}

export async function searchAndDownload(
  query: string,
  limit: number,
  style: string | undefined,
  format: "svg" | "png",
  recolor?: Record<string, string>,
) {
  const s = await searchStoryset(query, Math.max(limit * 5, limit));
  let results = s.results;
  if (style) results = results.filter((r) => r.style === style);
  results = results.slice(0, limit);
  const saved: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];
  for (const r of results) {
    const detail = await getIllustration(r.slug, r.style);
    const asset = format === "svg" ? detail.svg_url : detail.png_url;
    if (!asset) {
      errors.push({ slug: r.slug, style: r.style, reason: `no_${format}` });
      continue;
    }
    try {
      const d = await downloadAsset(asset, format === "svg" ? recolor : undefined);
      if ("error" in d) {
        errors.push({ slug: r.slug, style: r.style, reason: d.error });
        continue;
      }
      saved.push({ ...r, ...d, format });
    } catch (e) {
      errors.push({
        slug: r.slug,
        style: r.style,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { query, format, saved, errors };
}
