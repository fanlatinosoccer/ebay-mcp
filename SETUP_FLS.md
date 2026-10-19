# FLS eBay MCP setup (Fan Latino Soccer / fanlatinosoccer)

Installed on the Grok Bot box for Charlie’s seller account. **No Production secrets are stored yet.**

## What was installed

| Item | Value |
| --- | --- |
| Repo | https://github.com/YosefHayim/ebay-mcp (v1.18.0) |
| Path | `/workspace/fls/ebay-mcp` |
| Runtime | Node.js ≥ 20 (box has v20.19.2) |
| Package manager | pnpm 9.x (`$HOME/.local/bin/pnpm`) |
| Build | `pnpm install` → `build/` ready |
| Transport | **STDIO** by default (`node build/index.js`); optional HTTP via `build/serverHttp.js` + `MCP_PORT` |
| Smoke test | `node build/index.js diagnose` (reports missing env); start without `.env` **exits with ERROR** listing missing `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` |

## Start command

```bash
cd /workspace/fls/ebay-mcp
export PATH="$HOME/.local/bin:$PATH"
node build/index.js
# or: pnpm start
```

Diagnostics (safe, read-only check):

```bash
cd /workspace/fls/ebay-mcp && node build/index.js diagnose
```

Do **not** run interactive `npm run setup` / `pnpm run setup` on this box unless Charlie is at a browser for OAuth — prefer writing `.env` from secrets.

## Required env vars (secrets — parent must request)

Create `/workspace/fls/ebay-mcp/.env` (gitignored) with:

| Env name | What it is | FLS note |
| --- | --- | --- |
| `EBAY_CLIENT_ID` | Production **App ID (Client ID)** | Format like `CarlosSi-FanLatin-PRD-…` |
| `EBAY_CLIENT_SECRET` | Production **Cert ID (Client Secret)** | From Developer Portal → Production keyset |
| `EBAY_REDIRECT_URI` | RuName (not a URL) | `Carlos_Sierra-CarlosSi-FanLat-zbojxpaa` (OAuth Enabled) |
| `EBAY_ENVIRONMENT` | `production` or `sandbox` | Use **`production`** for live FLS inventory |
| `EBAY_USER_REFRESH_TOKEN` | OAuth **refresh** token | Needed for Sell APIs at 10k–50k req/day |

Recommended for FLS:

| Env name | Suggested value |
| --- | --- |
| `EBAY_MARKETPLACE_ID` | `EBAY_US` |
| `EBAY_CONTENT_LANGUAGE` | `en-US` |
| `EBAY_READ_ONLY` | `true` until mutating tools are intentional |
| `EBAY_MCP_TOOLS` | `inventory,fulfillment,marketing,analytics,account,developer,token-management` (or `all`) |

Optional / auto-managed: `EBAY_USER_ACCESS_TOKEN`, `EBAY_APP_ACCESS_TOKEN` (server refreshes these).

See also `.env.example` in this directory (placeholders only).

### Token caveat for parent

Charlie previously generated a **User Token** in the Developer Portal (string starting `v^1.1#…`). That format is typically an **Auth'n'Auth / portal user token**, not necessarily an OAuth2 **refresh** token.

**ebay-mcp expects `EBAY_USER_REFRESH_TOKEN` from the OAuth consent flow** (wizard or `ebay_get_oauth_url` → exchange code). If the pasted token is not a refresh token, Put Client ID + Secret + RuName in `.env` first, then complete OAuth once to obtain a proper refresh token.

## How Grok Bot / Cursor would register it

STDIO MCP entry (example for host `mcp.json`):

```json
{
  "mcpServers": {
    "ebay-fls": {
      "command": "node",
      "args": ["/workspace/fls/ebay-mcp/build/index.js"],
      "cwd": "/workspace/fls/ebay-mcp",
      "env": {
        "EBAY_CLIENT_ID": "(from secret)",
        "EBAY_CLIENT_SECRET": "(from secret)",
        "EBAY_REDIRECT_URI": "Carlos_Sierra-CarlosSi-FanLat-zbojxpaa",
        "EBAY_ENVIRONMENT": "production",
        "EBAY_USER_REFRESH_TOKEN": "(from secret)",
        "EBAY_MARKETPLACE_ID": "EBAY_US",
        "EBAY_CONTENT_LANGUAGE": "en-US",
        "EBAY_READ_ONLY": "true"
      }
    }
  }
}
```

Prefer loading secrets into `.env` at the package root rather than embedding them in chat or committed configs. Credentials never leave this machine except to eBay’s APIs.

## Next step for parent agent

1. **Secret-request** from Charlie (do not invent; do not paste into chat):  
   - Production App ID (`EBAY_CLIENT_ID`)  
   - Production Cert ID (`EBAY_CLIENT_SECRET`)  
   - OAuth refresh token (`EBAY_USER_REFRESH_TOKEN`) — or schedule OAuth after Client ID/Secret/RuName are in `.env`
2. Write `/workspace/fls/ebay-mcp/.env` with the table above + RuName + `EBAY_ENVIRONMENT=production`.
3. Run `node build/index.js diagnose` then a read-only call (e.g. rate limits / inventory list).
4. Wire the MCP namespace for the main agent if the host supports dynamic MCP registration.

## Smoke test result (2026-10-06 ET)

- `diagnose` without `.env`: clearly reports Client ID / Secret / Redirect URI / Environment / Refresh Token **not configured**.
- `node build/index.js` without `.env`: exits with  
  `EBAY_CLIENT_ID is not set` / `EBAY_CLIENT_SECRET is not set` / “Please fix the configuration errors and restart” — **does not hang**.

## Blockers

- **Credentials not on disk yet** — parent must secret-request and populate `.env`.
- Possible **token-type mismatch** if only the portal `v^1.1#…` user token is available; may need one OAuth consent pass for a refresh token.
- This is a **local** MCP process on the box; it must be running (or spawned by the MCP host) when inventory tools are used — not a cloud relay.
