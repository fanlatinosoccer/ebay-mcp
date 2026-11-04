import { z } from 'zod';

/**
 * Read-only Post-Order v2 inputs.
 *
 * Search filters keep eBay's query names as optional strings so new enum values
 * are not rejected locally. Status and response deadlines are fields on the
 * return, inquiry, and case payloads; they are not separate endpoints.
 *
 * @see https://developer.ebay.com/devzone/post-order/post-order_v2_return_search__get.html
 * @see https://developer.ebay.com/devzone/post-order/post-order_v2_inquiry_search__get.html
 * @see https://developer.ebay.com/devzone/post-order/post-order_v2_casemanagement_search__get.html
 */

const nonempty = z.string().min(1).regex(/\S/, 'Must contain a non-whitespace character');

const marketplaceId = z
  .string()
  .min(1)
  .optional()
  .describe(
    'X-EBAY-C-MARKETPLACE-ID for this call, e.g. EBAY_US. Defaults to EBAY_MARKETPLACE_ID, then EBAY_US.',
  );

const limit = z
  .number()
  .int()
  .min(1)
  .max(200)
  .optional()
  .describe('Page size from 1 to 200. eBay defaults to 25.');

const offset = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Zero-based number of entries to skip. eBay defaults to 0.');

const itemId = nonempty
  .optional()
  .describe('Listing item ID. Required together with transactionId when that filter is set.');

const transactionId = nonempty.optional().describe('Transaction ID. Must be paired with itemId.');

const orderId = nonempty.optional().describe('eBay order ID.');

/** Shared search fields for returns, inquiries, and cases. */
const searchFields = {
  marketplaceId,
  itemId,
  transactionId,
  orderId,
  limit,
  offset,
};

/** Input for GET /post-order/v2/return/search. */
export const searchPostOrderReturnsInputSchema = z.object({
  ...searchFields,
  creationDateRangeFrom: nonempty
    .optional()
    .describe('ISO-8601 creation_date_range_from. Not more than 18 months ago.'),
  creationDateRangeTo: nonempty.optional().describe('ISO-8601 creation_date_range_to.'),
  returnId: nonempty.optional().describe('Return ID. When set, other filters are ignored.'),
  returnState: nonempty
    .optional()
    .describe(
      'ReturnCountFilterEnum, e.g. ALL_OPEN, RETURN_STARTED, SELLER_ACTION_DUE, ITEM_SHIPPED, ITEM_DELIVERED, CLOSED.',
    ),
  role: nonempty.optional().describe('UserRoleFilterEnum. Sellers pass SELLER.'),
  sort: nonempty.optional().describe('ReturnSortField, e.g. FILING_DATE or ESTIMATED_REFUND.'),
  states: nonempty
    .optional()
    .describe('ReturnStateEnum, e.g. RETURN_REQUESTED, ITEM_SHIPPED, CLOSED.'),
});

/** Input for GET /post-order/v2/return/{returnId}. */
export const getPostOrderReturnInputSchema = z.object({
  marketplaceId,
  returnId: nonempty.describe('Return ID from ebay_search_post_order_returns.'),
});

/** Input for GET /post-order/v2/inquiry/search. */
export const searchPostOrderInquiriesInputSchema = z.object({
  ...searchFields,
  fieldgroups: nonempty
    .optional()
    .describe('InquirySearchFieldGroupEnum. DEFAULT is the only value.'),
  inquiryCreationDateRangeFrom: nonempty
    .optional()
    .describe('ISO-8601 inquiry_creation_date_range_from.'),
  inquiryCreationDateRangeTo: nonempty
    .optional()
    .describe('ISO-8601 inquiry_creation_date_range_to.'),
  inquiryStatus: nonempty
    .optional()
    .describe(
      'InquiryStatusFilter, e.g. WAITING_SELLER_RESPONSE, WAITING_BUYER_RESPONSE, OPEN, CLOSED, CLOSED_WITH_ESCALATION.',
    ),
  sort: nonempty.optional().describe('Inquiry sort field.'),
});

/** Input for GET /post-order/v2/inquiry/{inquiryId}. */
export const getPostOrderInquiryInputSchema = z.object({
  marketplaceId,
  inquiryId: nonempty.describe('Inquiry ID from ebay_search_post_order_inquiries. INR or SNAD.'),
});

/** Input for GET /post-order/v2/casemanagement/search. */
export const searchPostOrderCasesInputSchema = z.object({
  ...searchFields,
  caseCreationDateRangeFrom: nonempty
    .optional()
    .describe('ISO-8601 case_creation_date_range_from.'),
  caseCreationDateRangeTo: nonempty.optional().describe('ISO-8601 case_creation_date_range_to.'),
  caseStatusFilter: nonempty
    .optional()
    .describe(
      'CaseStatusFilter, e.g. OPEN, CLOSED, CLOSED_WITH_ESCALATION, ON_HOLD, WAITING_CS, WAITING_DELIVERY.',
    ),
  fieldgroups: nonempty.optional().describe('CaseSearchFieldGroupEnum. DEFAULT is the only value.'),
  returnId: nonempty.optional().describe('Return ID that was escalated to a case.'),
  sort: nonempty.optional().describe('Case sort field.'),
});

/** Input for GET /post-order/v2/casemanagement/{caseId}. */
export const getPostOrderCaseInputSchema = z.object({
  marketplaceId,
  caseId: nonempty.describe('Case ID from ebay_search_post_order_cases.'),
});
