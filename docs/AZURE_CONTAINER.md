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
| Identity | User-assigned managed identity `fls-ebay-mcp-id` with Key Vault **Get** on the secrets below |

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
| `ebay-mcp-bearer` | `ebay-mcp-bearer` | `MCP_AUTH_TOKEN` |
| `ebay-client-id` | `ebay-client-id` | `EBAY_CLIENT_ID` |
| `ebay-client-secret` | `ebay-client-secret` | `EBAY_CLIENT_SECRET` |
| `ebay-user-refresh-token` | `ebay-user-refresh-token` | `EBAY_USER_REFRESH_TOKEN` |

Example shape (names only, vault host is a placeholder):

```yaml
identity: fls-ebay-mcp-id
secrets:
  - name: ebay-mcp-bearer
    keyVaultUrl: https://<vault-name>.vault.azure.net/secrets/ebay-mcp-bearer
    identity: fls-ebay-mcp-id
  - name: ebay-client-id
    keyVaultUrl: https://<vault-name>.vault.azure.net/secrets/ebay-client-id
    identity: fls-ebay-mcp-id
  - name: ebay-client-secret
    keyVaultUrl: https://<vault-name>.vault.azure.net/secrets/ebay-client-secret
    identity: fls-ebay-mcp-id
  - name: ebay-user-refresh-token
    keyVaultUrl: https://<vault-name>.vault.azure.net/secrets/ebay-user-refresh-token
    identity: fls-ebay-mcp-id
containers:
  - name: ebay-mcp
    image: ebay-mcp:azure
    env:
      - name: MCP_AUTH_TOKEN
        secretRef: ebay-mcp-bearer
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

## Tool gating (allowlist, denylist, token guard)

Applied after `EBAY_MCP_TOOLS` (families) and `EBAY_READ_ONLY`, in this order:

| Name | Example | Purpose |
| --- | --- | --- |
| `EBAY_TOOL_ALLOWLIST` | `ebay_get_orders,ebay_revise_listing` | When set, only these tool names load. Unknown names are logged as warnings. |
| `EBAY_TOOL_DENYLIST` | `ebay_issue_refund` | These tool names never load. Deny wins over allow. |
| `EBAY_FORBID_TOKEN_TOOLS` | `true` | Startup fails if any `token-management` tool (`ebay_set_user_tokens`, `ebay_clear_tokens`, `ebay_display_credentials`, `ebay_refresh_access_token`, …) would load. |
| `EBAY_MCP_REMOTE_MEDIA` | `true` (default) | Media tools accept `https://` URLs and `data:<mime>;base64,` URIs. Set `false` to allow local files only. |

The startup log reports how many tools each gate kept. The HTTP server runs these
gates while the app is created, before it listens, so `EBAY_FORBID_TOKEN_TOOLS`
exits the process instead of failing the first session. The stdio entrypoint
does the same before the transport connects.

### Media in a container

`ebay_upload_images`, `ebay_upload_video`, `ebay_attach_media_to_inventory_item`,
`ebay_upload_document` and `ebay_upload_post_order_document` accept, besides local
paths, an `https://` URL (downloaded by the server; plain http, embedded
credentials, localhost, and private or link-local addresses are refused, including
hostnames that resolve to those addresses, and redirects are not followed) or a
base64 `data:` URI. Both go through the same size limits and content-signature
checks as local files, so no `EBAY_MCP_MEDIA_DIRS` is needed. Query strings are
sent on the download and then dropped from the value returned to the caller.

### Write instance: PROPOSAL, pending Charlie's confirmation

> **Not approved yet.** This list is a proposal. Nothing below is deployed until
> Charlie confirms the exact tool list, the spend cap and the Azure changes.

A second Container App (proposed name `fls-ebay-mcp-write`) with its own identity
(`fls-ebay-mcp-write-id`) and its own bearer secret (`ebay-mcp-write-bearer`), one
replica (min 1, max 1). Settings that differ from the read-only app:

| Name | Value |
| --- | --- |
| `EBAY_READ_ONLY` | `false` |
| `EBAY_FORBID_TOKEN_TOOLS` | `true` |
| `EBAY_TOOL_ALLOWLIST` | see below |
| `MCP_AUTH_TOKEN` | secretRef `ebay-mcp-write-bearer` |

Proposed write tools (used by FLS agents today):

- `ebay_revise_listing`
- `ebay_upload_images`
- `ebay_send_offer_to_interested_buyers`
- `ebay_send_message`
- `ebay_publish_offer`
- `ebay_create_or_replace_inventory_item`
- `ebay_create_listing`
- `ebay_create_offer`
- `ebay_respond_to_best_offer`
- `ebay_update_conversation`

Proposed supporting tools (reads, plus one image create the listing flow needs):

- `ebay_create_image_from_url` (creates an EPS image; not a read)
- `ebay_get_listing`
- `ebay_get_active_listings`
- `ebay_get_best_offers`
- `ebay_get_orders`
- `ebay_get_order`
- `ebay_get_inventory_item`
- `ebay_get_inventory_items`
- `ebay_get_offers`
- `ebay_get_offer`
- `ebay_get_conversations`
- `ebay_get_conversation`
- `ebay_find_eligible_items`
- `ebay_get_category_suggestions`
- `ebay_get_item_aspects_for_category`
- `ebay_get_fulfillment_policies`
- `ebay_get_payment_policies`
- `ebay_get_return_policies`
- `ebay_get_inventory_locations`
- `ebay_get_listing_fees`
- `ebay_get_store_categories`

Excluded on purpose (not in the allowlist): every token-management tool, refunds
(`ebay_issue_refund`), postage purchase (`ebay_create_shipment_from_shipping_quote`),
payout settings (`ebay_update_payout_percentage`), signing keys, `ebay_register_client`,
business-policy create/update/delete, and marketing campaign writes.

Value for `EBAY_TOOL_ALLOWLIST` (one line):

```text
ebay_revise_listing,ebay_upload_images,ebay_send_offer_to_interested_buyers,ebay_send_message,ebay_publish_offer,ebay_create_or_replace_inventory_item,ebay_create_listing,ebay_create_offer,ebay_respond_to_best_offer,ebay_update_conversation,ebay_create_image_from_url,ebay_get_listing,ebay_get_active_listings,ebay_get_best_offers,ebay_get_orders,ebay_get_order,ebay_get_inventory_item,ebay_get_inventory_items,ebay_get_offers,ebay_get_offer,ebay_get_conversations,ebay_get_conversation,ebay_find_eligible_items,ebay_get_category_suggestions,ebay_get_item_aspects_for_category,ebay_get_fulfillment_policies,ebay_get_payment_policies,ebay_get_return_policies,ebay_get_inventory_locations,ebay_get_listing_fees,ebay_get_store_categories
```

## Token lifetime

`EBAY_USER_REFRESH_TOKEN` from Key Vault is the durable credential. The process
mints an access token in memory and does not write it back. A new replica
loads the same Key Vault refresh token. eBay usually omits a replacement
refresh token on refresh. If a response ever rotates it, that new value stays
in memory until the replica stops and is not written to Key Vault.
