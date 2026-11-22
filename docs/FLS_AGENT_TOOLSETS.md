# FLS per-agent eBay MCP toolsets

Charlie approved (21 Nov 2026, 8:03 PM ET) that each FLS agent should load only the eBay tools it actually uses. This file is the opt-in list. **Nothing here is applied yet.**

The live box connector `user-ebay-fls` is a single STDIO process (`node build/index.js`, cwd `/workspace/fls/ebay-mcp`, started by the box at boot). Every FLS agent on this box shares it. Default (env unset) = all **386** tools.

## How to opt an agent in

Do **not** set `EBAY_MCP_TOOLS`, `EBAY_MCP_TOOL_ALLOWLIST`, or `EBAY_MCP_TOOL_DENYLIST` in the shared `.env` or in `start-mcp.sh`. That would filter every agent at once.

1. Register a **dedicated** MCP server entry (example name `ebay-fls-lucia`) with the same command/cwd/secrets as `user-ebay-fls`, plus one of:
   - Family filter: `"EBAY_MCP_TOOLS": "fulfillment,logistics,account,communication,inventory,analytics,trading"`
   - Name filter (tighter, recommended): `"EBAY_MCP_TOOL_ALLOWLIST": "ebay_get_orders,ebay_get_order,..."` (the lists below).
2. Attach that connector to the agent and leave the unfiltered `user-ebay-fls` connector for Natalia (and as rollback).
3. If the host cannot assign connectors per agent, stop and do not put a filter on the shared process. The only shared-process option that shrinks context for everyone is `EBAY_MCP_TOOLS=dynamic`, which changes behavior for all agents and needs a separate approval.

A typo in `EBAY_MCP_TOOL_ALLOWLIST` fails fast at startup (server will not come up). An unknown family in `EBAY_MCP_TOOLS` also fails fast.

## How to revert

Remove the dedicated server entry (or unset the env on it) and keep using `user-ebay-fls` with no filter. The shared process stays at 386 tools as long as those vars are absent from its environment. To roll back the code: restore the build tarball under `/workspace/fls/backups/` and/or `git revert` the allowlist commit on `fls/custom`. Do not kill other agents' MCP processes to apply or revert; wait for a natural box/MCP restart, or start only the new dedicated process.

## Evidence and limits

Transcripts on this host omit tool results, so this inventory is **not** a complete call log. It combines:

- Exact `ebay_*` tool **names mentioned in chat** in the last ~30 days (search index through 21 Nov 2026 ET).
- The agent's documented job (listings, labels, comps, disputes, payouts) as margin for tools used but not named in text.

Mention counts are therefore a lower bound. Name lists include margin; they do not change write rules or decision cards.

Catalogue size used for estimates: 386 tools, about 80k tokens of name + description + input schema (roughly 100k with JSON wrapping). Azure `user-ebay-fls-azure` advertises ~211 tools; the current read-only classifier on this fork yields **205** tools. Same env vars apply there once the container image includes this commit; do not change the Azure app in this step.

## Proposed lists

| Agent | Before | Family opt-in (count) | Recommended name allowlist (count) | Est. token savings (name list) | Notes |
| --- | ---: | --- | ---: | ---: | --- |
| LucIA | 386 | fulfillment,logistics,account,communication,inventory,analytics,trading (168) | 36 | ~71k | Orders, labels, packing, buyer shipping messages. |
| Matias | 386 | inventory,communication,trading,account,fulfillment,browse,metadata,taxonomy,stores,analytics,logistics,marketing (297) | 79 | ~58k | Family list is still huge because marketing=83 and account=51. Prefer the name list. |
| Paola | 386 | browse,analytics,inventory,fulfillment,marketing (156) | 16 | ~76k | Comps and weekly aggregates. Keep inventory/order reads. |
| Mariana | 386 | finances,fulfillment,account (79) | 15 | ~75k | Payouts, transactions, order earnings. |
| TanIA | 386 | inventory,metadata,taxonomy,stores,account (143) | 143 (families) or inventory+taxonomy+metadata+stores (92) | ~50–61k | Low chat volume; inventory is her job. Start with families. |
| FanIA | 386 | inventory,browse,communication,trading (93) | 16 | ~75k | Stock checks for social replies; no writes in the observed month. |
| AlexIA | 386 | fulfillment,communication,other,account (137) | 22 | ~74k | Payment disputes and case reads. |
| Natalia | 386 | *(leave unfiltered)* 386 | 386 | 0 | Must debug any tool. Keep shared `user-ebay-fls`. |
| ValerIA, DanIA, SilvIA, SofIA, CynthIA | 386 | no opt-in yet | — | — | Almost no named eBay MCP use in 30 days. Leave on the shared unfiltered connector. SofIA may later want inventory locations. |

### LucIA (36)

Observed in chat: `ebay_get_orders`, `ebay_get_order`.

```
ebay_get_orders,ebay_get_order,ebay_create_shipping_fulfillment,ebay_get_shipping_fulfillments,ebay_get_shipping_fulfillment,ebay_issue_refund,ebay_get_cancellation_requests,ebay_get_refunded_orders,ebay_get_payment_dispute_summaries,ebay_get_payment_dispute,ebay_get_payment_dispute_activities,ebay_fetch_payment_dispute_evidence_content,ebay_create_shipping_quote,ebay_get_shipping_quote,ebay_create_shipment_from_shipping_quote,ebay_get_shipment,ebay_cancel_shipment,ebay_download_shipping_label_file,ebay_get_listing,ebay_get_active_listings,ebay_get_inventory_item,ebay_get_offer,ebay_get_offers,ebay_get_conversations,ebay_get_conversation,ebay_send_message,ebay_get_fulfillment_policies,ebay_get_fulfillment_policy,ebay_get_return_policies,ebay_get_return_policy,ebay_get_payment_policies,ebay_get_payment_policy,ebay_get_user,ebay_get_customer_service_metric,ebay_get_feedback,ebay_leave_feedback_for_buyer
```

### Matias (79)

Observed in chat: `ebay_get_token_status`, `ebay_refresh_access_token`, `ebay_get_conversations`, `ebay_get_conversation`, `ebay_send_offer_to_interested_buyers`, `ebay_update_offer`, `ebay_cancel_shipment`, `ebay_issue_refund`. Publishing, price edits, Best Offer, media, unpaid orders, Promoted 3%, and policy reads are in the margin from his daily work (those calls rarely appear as tool names in chat).

```
ebay_get_inventory_items,ebay_get_inventory_item,ebay_create_or_replace_inventory_item,ebay_delete_inventory_item,ebay_bulk_update_price_quantity,ebay_get_inventory_item_group,ebay_create_or_replace_inventory_item_group,ebay_get_inventory_locations,ebay_get_inventory_location,ebay_get_offers,ebay_get_offers_by_skus,ebay_get_offer,ebay_create_offer,ebay_update_offer,ebay_delete_offer,ebay_publish_offer,ebay_withdraw_offer,ebay_get_listing_fees,ebay_create_image_from_url,ebay_upload_images,ebay_upload_video,ebay_get_video,ebay_attach_media_to_inventory_item,ebay_get_active_listings,ebay_get_listing,ebay_create_listing,ebay_revise_listing,ebay_end_listing,ebay_relist_item,ebay_get_best_offers,ebay_respond_to_best_offer,ebay_find_eligible_items,ebay_send_offer_to_interested_buyers,ebay_get_conversations,ebay_get_conversation,ebay_send_message,ebay_update_conversation,ebay_get_feedback,ebay_get_awaiting_feedback,ebay_leave_feedback_for_buyer,ebay_get_orders,ebay_get_order,ebay_issue_refund,ebay_get_cancellation_requests,ebay_get_fulfillment_policies,ebay_get_fulfillment_policy,ebay_get_payment_policies,ebay_get_payment_policy,ebay_get_return_policies,ebay_get_return_policy,ebay_get_privileges,ebay_get_advertising_eligibility,ebay_find_active_items,ebay_get_item_details,ebay_find_completed_items,ebay_get_store,ebay_get_store_categories,ebay_add_store_category,ebay_get_category_suggestions,ebay_get_item_aspects_for_category,ebay_get_default_category_tree_id,ebay_get_category_tree,ebay_get_item_condition_policies,ebay_get_shipping_services,ebay_get_handling_times,ebay_get_category_policies,ebay_get_traffic_report,ebay_find_seller_standards_profiles,ebay_get_campaigns,ebay_get_campaign,ebay_get_ads,ebay_get_ad,ebay_create_ad_by_listing_id,ebay_create_ads_by_inventory_reference,ebay_bulk_create_ads_by_listing_id,ebay_find_campaign_by_ad_reference,ebay_get_campaign_by_name,ebay_get_token_status,ebay_cancel_shipment
```

Token-management writes (`ebay_set_user_tokens`, `ebay_clear_tokens`, …) stay off this list on purpose.

### Paola (16)

Observed in chat: `ebay_find_active_items`, `ebay_find_completed_items`, `ebay_get_item_details`.

```
ebay_find_active_items,ebay_find_completed_items,ebay_get_item_details,ebay_get_traffic_report,ebay_find_seller_standards_profiles,ebay_get_seller_standards_profile,ebay_get_customer_service_metric,ebay_get_inventory_items,ebay_get_inventory_item,ebay_get_offers,ebay_get_offer,ebay_get_active_listings,ebay_get_listing,ebay_get_orders,ebay_get_promotions,ebay_get_promotion_summary_report
```

### Mariana (15)

No `ebay_*` MCP names in 30 days of chat (she mostly uses the finance app). Margin from her job:

```
ebay_get_payouts,ebay_get_payout,ebay_get_payout_summary,ebay_get_seller_funds_summary,ebay_get_transactions,ebay_get_transaction_summary,ebay_get_order_earnings,ebay_get_order_earnings_by_id,ebay_get_order_earnings_summary,ebay_get_transfer,ebay_get_billing_activities,ebay_get_orders,ebay_get_order,ebay_get_payout_settings,ebay_get_refunded_orders
```

### FanIA (16)

```
ebay_get_inventory_items,ebay_get_inventory_item,ebay_get_offers,ebay_get_offer,ebay_get_active_listings,ebay_get_listing,ebay_find_active_items,ebay_get_item_details,ebay_find_completed_items,ebay_get_conversations,ebay_get_conversation,ebay_get_store,ebay_get_store_categories,ebay_get_best_offers,ebay_get_orders,ebay_get_order
```

### AlexIA (22)

```
ebay_get_orders,ebay_get_order,ebay_get_payment_dispute_summaries,ebay_get_payment_dispute,ebay_get_payment_dispute_activities,ebay_accept_payment_dispute,ebay_contest_payment_dispute,ebay_add_payment_dispute_evidence,ebay_update_payment_dispute_evidence,ebay_upload_payment_dispute_evidence_file,ebay_fetch_payment_dispute_evidence_content,ebay_get_cancellation_requests,ebay_get_refunded_orders,ebay_get_conversations,ebay_get_conversation,ebay_send_message,ebay_get_user,ebay_get_listing_violations,ebay_get_listing_violations_summary,ebay_get_feedback,ebay_get_listing,ebay_issue_refund
```

## Azure (`user-ebay-fls-azure`)

Container App `fls-ebay-mcp` serves the HTTP MCP (read-only image from the `fls/azure-container` line, which is **not** merged into `fls/custom`). It already supports `EBAY_MCP_TOOLS` and `EBAY_READ_ONLY` if that image is current enough. After this commit is in the image it will also honor `EBAY_MCP_TOOL_ALLOWLIST`. No Azure setting is changed in this step ($0). To use it later: set the env on that Container App or a dedicated revision, then restart only that app — not the box STDIO process.
