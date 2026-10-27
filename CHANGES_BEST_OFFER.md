# Best Offer support (Trading API) — FLS fork change log

Date: 2026-10-09 (ET)

## Why
The connector could manage listings and messages but could not see or answer inbound
Best Offers. Charlie wants to review/accept reasonable offers via the **official eBay
Trading API only** (no browser, no scraping).

## What was added

### Tools (category `trading`, `src/tools/categories/trading.ts`)
| Tool | Trading call | Hints |
| --- | --- | --- |
| `ebay_get_best_offers` | `GetBestOffers` | `readOnlyHint: true` |
| `ebay_respond_to_best_offer` | `RespondToBestOffer` | `readOnlyHint: false`, `destructiveHint: true` |

Total tool count: 384 → 386 (README / llms.txt / package.json updated so the
advertised-count tests stay green).

### `ebay_get_best_offers`
Input (`getBestOffersSchema`, `src/utils/trading/trading.ts`):
- `itemId?` — omit to query all of the seller's listings (`ItemBestOffersArray`).
- `bestOfferId?` — single offer (requires `itemId`).
- `bestOfferStatus?` — `Active` (default) | `All`. Note: eBay only honours `All`
  when `itemId` is given; seller-wide queries return Active only (warning 21916936).
- `page?` (default 1), `entriesPerPage?` (default/max 25).
- `includeRaw?` — attach the raw parsed XML response.

Output: `{ ack, bestOfferStatus, count, offers[], page, totalPages, totalEntries, warnings? }`
where each offer is normalized to: `itemId, title, listPrice, listCurrency, bestOfferId,
buyerUserId, buyerFeedbackScore, price, currency, quantity, expirationTime, status,
bestOfferCodeType, buyerMessage, sellerMessage` (fields omitted when eBay doesn't return them).

eBay's item-scoped "Best Offers Not Found" failure (ErrorCode **20140**) is mapped to an
empty result instead of an error.

### `ebay_respond_to_best_offer`
Input (`respondToBestOfferSchema`):
- `itemId` (required), `bestOfferIds: string[]` (required, ≥1)
- `action` — **required, no default**: `Accept` | `Decline` | `Counter`
- `counterOfferPrice` — required for `Counter`, rejected for Accept/Decline
- `counterOfferQuantity?` (Counter only), `currency?` (default `USD`)
- `sellerResponse?` (≤250 chars)

Guards (enforced before any eBay request): missing/invalid action, empty IDs,
Counter with ≠1 ID, Counter without a positive price, counter fields on Accept/Decline.
Counter price is sent as `<CounterOfferPrice currencyID="USD">495.00</CounterOfferPrice>`.

### API layer (`src/api/trading/trading.ts`)
`TradingApi.getBestOffers` and `TradingApi.respondToBestOffer`, both using the existing
`TradingApiClient.execute(...)` — same auth path as GetMyeBaySelling/GetItem (user OAuth
access token in `X-EBAY-API-IAF-TOKEN`, auto-refreshed). The global XML parser config was
not changed; single-vs-array normalization is done locally.

### XML escaping
All values go through `fast-xml-builder`, which escapes `& < > "` in text nodes
(verified: `a <b> & "c"` → `a &lt;b&gt; &amp; &quot;c&quot;`). Seller messages with
special characters are safe.

### Tests
`tests/unit/api/tradingBestOffer.test.ts` (7 tests): normalization, empty result, 20140
mapping, Accept with multiple IDs + escaped message payload, Counter guards, missing
action, counter price formatting.

### Box helper
`/workspace/fls/tools/ebay_api.py` read-only whitelist now includes `ebay_get_best_offers`
(the respond tool is intentionally NOT whitelisted there).

## Auth / scopes
Trading API calls use the same user OAuth token as the rest of the connector. Live test
on 2026-10-09 ~1:10 AM ET returned `Ack=Success` → the current token already has the
needed access; no new scope was required.

## Live test (read-only)
- `ebay_get_best_offers {}` → Success, 0 Active offers.
- `ebay_get_best_offers {bestOfferStatus:"All"}` → Warning 21916936 (Active-only for
  seller-wide), 0 offers.
- `ebay_get_best_offers {itemId:"860024869089", bestOfferStatus:"All"}` (Lira) → 0 offers.
- `ebay_respond_to_best_offer` was **not** called live.

## Deploy
`npm run build` → `build/`. Any client that spawns `start-mcp.sh` / `node build/index.js`
picks up the new tools on next start.
