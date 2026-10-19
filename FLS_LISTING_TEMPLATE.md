# FLS Club América FAN Jersey Listing Template

**Seller:** fanlatinosoccer · **Marketplace:** EBAY_US · **Template:** `fls_fan_template.json`  
**Built from live GetItem:** `860011639202` (Brian FAN L), `318857894114` (Zendejas FAN L) · **Dump:** `active_live_2026-10-06.json`  
**Updated:** 2026-10-06 ET

---

## Recommendation: draft path

| Path | MCP tools | Result | Use for FLS drafts? |
| --- | --- | --- | --- |
| **Inventory REST (preferred)** | `ebay_create_or_replace_inventory_item` → `ebay_create_offer` → (later) `ebay_publish_offer` | Offer stays **UNPUBLISHED** until publish | **Yes — this is the draft path** |
| Trading XML | `ebay_create_listing` → `AddFixedPriceItem` | **Goes live immediately** | **No** for drafts |

**Why not only Trading?** All ~525 active listings (and these FAN L comps) were created via Seller Hub / Trading — Inventory API currently returns **0 SKUs** and **0 inventory locations**. That does **not** block new Inventory drafts; it means we need a one-time `ebay_create_inventory_location`, then create SKUs going forward. Do **not** mix Trading revise and Inventory for the same SKU/item.

Machine-readable copy of IDs and payloads: [`fls_fan_template.json`](./fls_fan_template.json).

---

## Fixed defaults (from live FAN LARGE comps)

| Field | Value |
| --- | --- |
| CategoryID | `2887` (Soccer-International Clubs fan apparel) |
| ConditionID | `1000` (New) |
| ListingType | FixedPriceItem |
| ListingDuration | GTC |
| Currency / Country | USD / US |
| Location / PostalCode | Fort Lauderdale, Florida / `33308` |
| DispatchTimeMax | `0` (same business day) |
| Quantity | `1` |
| Best Offer | enabled |
| AutoPay | true |
| PictureSource | EPS |
| StoreCategoryID | `4017709719` |
| ShippingProfileID | `257269369024` — *Trading Cards & Others 2026 Calculated Shipping* |
| ReturnProfileID | `197981466024` — *No returns accepted* |
| PaymentProfileID | `188273655024` — *eBay Payments:Immediate pay* |
| Package | 15×12×1 in, PackageThickEnvelope, **8 oz** |
| Default price (Home FAN L) | **$115.00** |

**Optional jersey shipping policies** (account has them; live FAN L comps above used the calculated cards policy):

- `246232238024` — Jerseys \| 2026 Soccer Jersey Flat Rate  
- `255930873024` — PROMO Jerseys \| 2026 Soccer Jersey UPS Ground Shipping  

---

## Title pattern

```text
{Player} #{N} Mens LARGE {Brand} Club America {Kit} FAN Jersey Liga Mx
```

Examples from live stock:

- `Brian Rodriguez #7 Mens LARGE Adidas Club America Home FAN Jersey Liga Mx`
- `Alex Zendejas #10 Mens LARGE Adidas Club America Home FAN Jersey Liga Mx`

Max **80** characters. Swap Brand (`Nike`), Kit (`Away`, `Autism`, `Pac-Man`, …), or drop/add `Liga Mx` to match the physical jersey.

---

## Item specifics (defaults)

| Name | Default |
| --- | --- |
| Brand | adidas |
| Sport | Soccer |
| Officially Licensed | Yes |
| Size | L |
| Color | Yellow (Home FAN; override for Away/special) |
| Product | Jersey |
| Team | América |
| Gender | Men |
| Country of Origin | Mexico |
| Player | **per listing** (use eBay aspect value, e.g. `Alejandro Zendejas`) |

Category 2887 aspects are recommended/optional (none strictly required), but FLS always fills the set above.

**QA note:** Brian listing `860011639202` has Player aspect wrongly set to `Henry Martin`. Never copy that; match Player to the jersey on the photos.

---

## Description HTML (boilerplate from live)

Live FAN L listings use this short authenticity block only (no tables, no images in HTML — photos are separate EPS URLs):

```html
<p>Authenticity Guaranteed – 100% Official Merchandise!</p><br />
<p>We take immense pride in offering only 100% authentic, official soccer merchandise. As a trusted business seller, we do not sell fakes or knock-offs—ever. Each listing includes detailed photos, including close-ups of internal and external serial tag numbers, so you can buy with total confidence.</p><br />
<p>Don’t just take our word for it—check out our stellar buyer feedback to see why fans and collectors trust us for their soccer jersey needs.</p><br />
<p>If you have any questions, feel free to send us a message. We’re here to help!</p><br />
<p>Only the real deal. No exceptions.</p>
```

---

## Photos

Live comps ship **~13–16** EPS images. Suggested shot list:

1. Front  
2. Back (name + number)  
3–5. Sleeves / crest / sponsor  
6. Collar / neck label  
7. Size tag  
8+. Authenticity / serial / care tags (close-ups)  
Fill remaining slots with clean angles.

MCP helpers: `ebay_upload_images` → EPS URLs; or `ebay_attach_media_to_inventory_item` (sku + local paths under `EBAY_MCP_MEDIA_DIRS`).

---

## MCP draft workflow (unpublished)

**Do not call** `ebay_publish_offer`, `ebay_bulk_publish_offer`, or `ebay_create_listing` until Charlie explicitly approves go-live.

### One-time

1. Confirm write tools are exposed (`EBAY_READ_ONLY=false` + MCP restart).  
2. `ebay_create_inventory_location`  
   - Suggested key: `fls-ftlauderdale-33308`  
   - City/ZIP/state from live listings; **street line still needed from Charlie**  
   - Status `ENABLED`, type `WAREHOUSE`

### Per jersey (draft only)

1. Upload photos → EPS URLs.  
2. **`ebay_create_or_replace_inventory_item`**  
   - Required: `sku`, `body.condition` (`NEW`), `body.availability.shipToLocationAvailability.quantity` (`1`), `body.product.title`, `body.product.description`, `body.product.aspects`, `body.product.imageUrls`, package weight/size.  
3. **`ebay_create_offer`** ← **this is the unpublished draft**  
   - Required: `body.sku`, `body.marketplaceId` (`EBAY_US`), `body.format` (`FIXED_PRICE`), `body.categoryId` (`2887`), `body.listingDuration` (`GTC`), `body.merchantLocationKey`, `body.pricingSummary.price`, `body.listingPolicies` (fulfillment / payment / return IDs above), `body.availableQuantity` (`1`), Best Offer on.  
   - Returns `offerId` with status **UNPUBLISHED**.  
4. Optional: `ebay_get_listing_fees`.  
5. Only after approval: `ebay_publish_offer` `{ offerId }` → live `listingId`.

### Trading tools (reference only)

| Tool | eBay call | Draft? |
| --- | --- | --- |
| `ebay_create_listing` | AddFixedPriceItem / AddItem | **No — live** |
| `ebay_get_listing` | GetItem | Read |
| `ebay_get_active_listings` | GetMyeBaySelling | Read |
| `ebay_revise_listing` / `ebay_end_listing` / `ebay_relist_item` | Revise*/End*/Relist* | Live mutations |

---

## What Charlie must still provide (each listing)

1. **Photos** (front/back/tags; enough for the shot list).  
2. **Player** (display name for title + correct eBay Player aspect).  
3. **Number** and kit/version confirmation (Home FAN Liga Mx vs special).  
4. **Price** if not the $115 Home FAN L default.  
5. **Street address** once for the inventory location (33308 / Fort Lauderdale already known).

No live listing is created by building this template alone.


---

## Charlie iOS template (locked 2026-10-06)

Source: iOS Listing summary screenshots (Mateo Chávez signed México Away) + pasted description.

- Category: Soccer-International Clubs (`2887`); store cat México when applicable
- Condition: New
- Specifics always: Product, Team, Size, Gender, Brand, Color, Player, Officially Licensed, Country of Origin, Event/Tournament, Sport
- Shipping policy: Trading Cards & Others 2026 Calculated Shipping; package **8 oz, 10×8×4 in**; eBay International Shipping
- Preferences: Immediate pay; handling same business day; ZIP **33308**; No returns accepted
- Promoted Listings: **ON at 3.0%** ad rate; charity OFF
- Description: authenticity block verbatim (see `fls_ios_listing_template.json`)

Machine copy: `fls_ios_listing_template.json`
