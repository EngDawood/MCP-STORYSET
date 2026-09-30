# mcp-storyset

Remote MCP server on Cloudflare Workers (`worker/index.ts`, `worker/lib.ts`), served at `storyset-mcp.engdawood.com` over `/sse` and `/mcp`.

## Cloudflare

- Worker `mcp-storyset` lives in the Engdawood account (`c53938b50ea00b247dcd72dd2e9eada3`). Zone `engdawood.com` is on the Free plan.

## Rate limiting

- **Edge (WAF):** rule `f3c35b9877c6460090fa8a37e631891d` in the `http_ratelimit` phase. 50 requests per 10s per IP (per colo), block for 10s. Free plan limits: 1 rule, 10s window, no header matching, so the bypass token does not apply here.
- **Worker:** `RATE_LIMITER` binding in `wrangler.jsonc`, 60 requests per 60s per `cf-connecting-ip`. Covers every path except `/`. Counts are per location, so approximate.
- **Bypass:** a request with header `x-bypass-token` equal to the `BYPASS_TOKEN` secret skips the Worker limiter only.
- `BYPASS_TOKEN` must be set after deploy with `npx wrangler secret put BYPASS_TOKEN`. Until then nothing can bypass. Never commit the token.
- Cloudflare has no hard spend cap. Use billing and usage notifications as the safeguard.
