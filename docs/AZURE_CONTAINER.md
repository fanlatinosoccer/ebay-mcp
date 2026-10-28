# Azure Container Apps (stage 1)

Read-only remote MCP for the eBay seller account. The process listens on
`build/serverHttp.js`. It does not run the OAuth consent flow and it does not
write tokens to a `.env` file.

Build with `Dockerfile.azure`. Do not put secret values in the image, in build
args, or in this repository.

```bash
docker build -f Dockerfile.azure -t ebay-mcp:azure .
```

`pnpm run build` (the image's build step) is `tsc`, `tsc-alias`, then
`build:mcp-apps`. The HTTP server starts from `build/serverHttp.js` without the
UI HTML files. Missing views log a warning and stay disabled. The image still
runs the full build so the interactive views are present.

## Container App settings

| Setting | Value |
| --- | --- |
| Ingress | HTTP, target port `3000` |
| Health probe | `GET /health` (no `Authorization` header) |
| MCP endpoint | `POST` / `GET` / `DELETE` `/` |
| Identity | System-assigned managed identity with Key Vault **Get** on the secrets below |

`/health` stays open so the probe can succeed. Every MCP request must send
`Authorization: Bearer <MCP_AUTH_TOKEN>`. A missing or wrong token is `401`
with `WWW-Authenticate: Bearer`.

Startup logs `Authorization is DISABLED` when `OAUTH_ENABLED=false`. That line
is the OAuth verifier. With `MCP_AUTH_TOKEN` set, an earlier line says
`Static bearer auth enabled via MCP_AUTH_TOKEN`, and `/` still requires it.

## Environment variables

Plain values (not secrets):

| Name | Value | Purpose |
| --- | --- | --- |
| `OAUTH_ENABLED` | `false` | Skip the OAuth token verifier. `MCP_AUTH_TOKEN` is the HTTP credential. |
| `EBAY_READ_ONLY` | `true` | Register only read tools (gets, lists, searches). |
| `EBAY_CREDENTIAL_STORE` | `memory` | Keep refreshed access tokens in process memory. `write` does not touch disk, and a persist step cannot fail the eBay call. Unset keeps the `.env` store used by local installs. |
| `EBAY_ENVIRONMENT` | `production` | Production keyset. The process accepts only lowercase `production` or `sandbox`. |
| `PORT` | `3000` | Listen port. When `PORT` is set and `MCP_HOST` is unset, the server binds `0.0.0.0`. |

Secrets. Container App secret **names** only. The values live in Key Vault and
are referenced from the Container App; do not copy them into env files or the
image.

| Container App secret name | Key Vault secret name | Env var |
| --- | --- | --- |
| `mcp-auth-token` | `mcp-auth-token` | `MCP_AUTH_TOKEN` |
| `ebay-client-id` | `ebay-client-id` | `EBAY_CLIENT_ID` |
| `ebay-client-secret` | `ebay-client-secret` | `EBAY_CLIENT_SECRET` |
| `ebay-user-refresh-token` | `ebay-user-refresh-token` | `EBAY_USER_REFRESH_TOKEN` |

Example shape (names only, vault host is a placeholder):

```yaml
identity: system
secrets:
  - name: mcp-auth-token
    keyVaultUrl: https://<vault-name>.vault.azure.net/secrets/mcp-auth-token
    identity: system
  - name: ebay-client-id
    keyVaultUrl: https://<vault-name>.vault.azure.net/secrets/ebay-client-id
    identity: system
  - name: ebay-client-secret
    keyVaultUrl: https://<vault-name>.vault.azure.net/secrets/ebay-client-secret
    identity: system
  - name: ebay-user-refresh-token
    keyVaultUrl: https://<vault-name>.vault.azure.net/secrets/ebay-user-refresh-token
    identity: system
containers:
  - name: ebay-mcp
    image: ebay-mcp:azure
    env:
      - name: MCP_AUTH_TOKEN
        secretRef: mcp-auth-token
      - name: OAUTH_ENABLED
        value: "false"
      - name: EBAY_READ_ONLY
        value: "true"
      - name: EBAY_CREDENTIAL_STORE
        value: memory
      - name: EBAY_ENVIRONMENT
        value: production
      - name: EBAY_CLIENT_ID
        secretRef: ebay-client-id
      - name: EBAY_CLIENT_SECRET
        secretRef: ebay-client-secret
      - name: EBAY_USER_REFRESH_TOKEN
        secretRef: ebay-user-refresh-token
      - name: PORT
        value: "3000"
```

## Token lifetime

`EBAY_USER_REFRESH_TOKEN` from Key Vault is the durable credential. The process
mints an access token in memory and does not write it back. A new replica
loads the same Key Vault refresh token. eBay usually omits a replacement
refresh token on refresh. If a response ever rotates it, that new value stays
in memory until the replica stops and is not written to Key Vault.
