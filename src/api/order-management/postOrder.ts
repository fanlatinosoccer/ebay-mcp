import type { EbayApiClient } from '@/api/client/ebayApiClient.js';
import {
  buildEndpointParams,
  decodeEndpointInputEffect,
  EbayApiError,
  type EndpointInputError,
  type QueryParams,
} from '@/api/shared/request.js';
import {
  getPostOrderCaseInputSchema,
  getPostOrderInquiryInputSchema,
  getPostOrderReturnInputSchema,
  searchPostOrderCasesInputSchema,
  searchPostOrderInquiriesInputSchema,
  searchPostOrderReturnsInputSchema,
} from '@/schemas/fulfillment/postOrder.js';
import type { z } from 'zod';
import { Effect } from 'effect';

const BASE_PATH = '/post-order/v2';

/**
 * Post-Order OAuth prefix. Auth'n'Auth tokens use `TOKEN `; this client mints
 * an OAuth user access token, which eBay requires as `IAF <token>`.
 *
 * @see https://developer.ebay.com/api-docs/static/oauth-trad-apis.html
 * @see https://developer.ebay.com/Devzone/post-order/concepts/makingacall.html
 */
const POST_ORDER_AUTHORIZATION_SCHEME = 'IAF' as const;

type SearchReturnsInput = z.infer<typeof searchPostOrderReturnsInputSchema>;
type GetReturnInput = z.infer<typeof getPostOrderReturnInputSchema>;
type SearchInquiriesInput = z.infer<typeof searchPostOrderInquiriesInputSchema>;
type GetInquiryInput = z.infer<typeof getPostOrderInquiryInputSchema>;
type SearchCasesInput = z.infer<typeof searchPostOrderCasesInputSchema>;
type GetCaseInput = z.infer<typeof getPostOrderCaseInputSchema>;

/**
 * JSON object returned by a Post-Order read. Field sets vary by resource;
 * return payloads include `state` and response deadlines such as
 * `sellerResponseDue` / `buyerResponseDue`.
 */
export type PostOrderDocument = Record<string, unknown>;

const toQuery = (fields: Record<string, string | number | undefined>): QueryParams | undefined =>
  buildEndpointParams(
    Object.fromEntries(
      Object.entries(fields).map(([wireName, value]) => [wireName, { wireName, value }]),
    ),
  );

/**
 * GET a Post-Order path on the REST host (`api.ebay.com` / `api.sandbox.ebay.com`)
 * with the OAuth `IAF` scheme and a marketplace header.
 */
const postOrderGet = <T>(
  client: EbayApiClient,
  path: string,
  params: QueryParams | undefined,
  marketplaceId: string | undefined,
): Effect.Effect<T, EbayApiError> =>
  Effect.tryPromise({
    try: () => {
      const configured = client.getConfig().marketplaceId?.trim();
      const marketplace = marketplaceId?.trim() || configured || 'EBAY_US';
      return client.get<T>(path, params, {
        authorizationScheme: POST_ORDER_AUTHORIZATION_SCHEME,
        headers: { 'X-EBAY-C-MARKETPLACE-ID': marketplace },
      });
    },
    catch: (cause) => new EbayApiError({ method: 'GET', path, cause }),
  });

const returnSearchQuery = (input: SearchReturnsInput): QueryParams | undefined =>
  toQuery({
    creation_date_range_from: input.creationDateRangeFrom,
    creation_date_range_to: input.creationDateRangeTo,
    item_id: input.itemId,
    limit: input.limit,
    offset: input.offset,
    order_id: input.orderId,
    return_id: input.returnId,
    return_state: input.returnState,
    role: input.role,
    sort: input.sort,
    states: input.states,
    transaction_id: input.transactionId,
  });

const inquirySearchQuery = (input: SearchInquiriesInput): QueryParams | undefined =>
  toQuery({
    fieldgroups: input.fieldgroups,
    inquiry_creation_date_range_from: input.inquiryCreationDateRangeFrom,
    inquiry_creation_date_range_to: input.inquiryCreationDateRangeTo,
    inquiry_status: input.inquiryStatus,
    item_id: input.itemId,
    limit: input.limit,
    offset: input.offset,
    order_id: input.orderId,
    sort: input.sort,
    transaction_id: input.transactionId,
  });

const caseSearchQuery = (input: SearchCasesInput): QueryParams | undefined =>
  toQuery({
    case_creation_date_range_from: input.caseCreationDateRangeFrom,
    case_creation_date_range_to: input.caseCreationDateRangeTo,
    case_status_filter: input.caseStatusFilter,
    fieldgroups: input.fieldgroups,
    item_id: input.itemId,
    limit: input.limit,
    offset: input.offset,
    order_id: input.orderId,
    return_id: input.returnId,
    sort: input.sort,
    transaction_id: input.transactionId,
  });

/**
 * Read-only Post-Order v2 calls: return search/get, inquiry search/get, and
 * case-management search/get. No respond, refund, or escalate methods.
 */
export class PostOrderApi {
  public constructor(private readonly client: EbayApiClient) {}

  /**
   * Searches return requests, including state and seller/buyer response deadlines.
   *
   * @param input - Optional return filters and pagination.
   * @returns An Effect that succeeds with eBay's return search document.
   *
   * @see https://developer.ebay.com/devzone/post-order/post-order_v2_return_search__get.html
   */
  public searchReturns = (
    input: SearchReturnsInput = {},
  ): Effect.Effect<PostOrderDocument, EbayApiError | EndpointInputError> => {
    const client = this.client;

    return Effect.gen(function* () {
      const validated = yield* decodeEndpointInputEffect(searchPostOrderReturnsInputSchema, input);
      return yield* postOrderGet<PostOrderDocument>(
        client,
        `${BASE_PATH}/return/search`,
        returnSearchQuery(validated),
        validated.marketplaceId,
      );
    });
  };

  /**
   * Retrieves one return, including state and response deadlines.
   *
   * @param input - Return ID and optional marketplace override.
   * @returns An Effect that succeeds with eBay's return document.
   *
   * @see https://developer.ebay.com/devzone/post-order/post-order_v2_return-returnId__get.html
   */
  public getReturn = (
    input: GetReturnInput,
  ): Effect.Effect<PostOrderDocument, EbayApiError | EndpointInputError> => {
    const client = this.client;

    return Effect.gen(function* () {
      const validated = yield* decodeEndpointInputEffect(getPostOrderReturnInputSchema, input);
      const path = `${BASE_PATH}/return/${encodeURIComponent(validated.returnId)}`;
      return yield* postOrderGet<PostOrderDocument>(
        client,
        path,
        undefined,
        validated.marketplaceId,
      );
    });
  };

  /**
   * Searches INR and SNAD inquiries.
   *
   * @param input - Optional inquiry filters and pagination.
   * @returns An Effect that succeeds with eBay's inquiry search document.
   *
   * @see https://developer.ebay.com/devzone/post-order/post-order_v2_inquiry_search__get.html
   */
  public searchInquiries = (
    input: SearchInquiriesInput = {},
  ): Effect.Effect<PostOrderDocument, EbayApiError | EndpointInputError> => {
    const client = this.client;

    return Effect.gen(function* () {
      const validated = yield* decodeEndpointInputEffect(
        searchPostOrderInquiriesInputSchema,
        input,
      );
      return yield* postOrderGet<PostOrderDocument>(
        client,
        `${BASE_PATH}/inquiry/search`,
        inquirySearchQuery(validated),
        validated.marketplaceId,
      );
    });
  };

  /**
   * Retrieves one INR or SNAD inquiry.
   *
   * @param input - Inquiry ID and optional marketplace override.
   * @returns An Effect that succeeds with eBay's inquiry document.
   *
   * @see https://developer.ebay.com/devzone/post-order/post-order_v2_inquiry-inquiryId__get.html
   */
  public getInquiry = (
    input: GetInquiryInput,
  ): Effect.Effect<PostOrderDocument, EbayApiError | EndpointInputError> => {
    const client = this.client;

    return Effect.gen(function* () {
      const validated = yield* decodeEndpointInputEffect(getPostOrderInquiryInputSchema, input);
      const path = `${BASE_PATH}/inquiry/${encodeURIComponent(validated.inquiryId)}`;
      return yield* postOrderGet<PostOrderDocument>(
        client,
        path,
        undefined,
        validated.marketplaceId,
      );
    });
  };

  /**
   * Searches cases escalated from returns or INR inquiries.
   *
   * @param input - Optional case filters and pagination.
   * @returns An Effect that succeeds with eBay's case search document.
   *
   * @see https://developer.ebay.com/devzone/post-order/post-order_v2_casemanagement_search__get.html
   */
  public searchCases = (
    input: SearchCasesInput = {},
  ): Effect.Effect<PostOrderDocument, EbayApiError | EndpointInputError> => {
    const client = this.client;

    return Effect.gen(function* () {
      const validated = yield* decodeEndpointInputEffect(searchPostOrderCasesInputSchema, input);
      return yield* postOrderGet<PostOrderDocument>(
        client,
        `${BASE_PATH}/casemanagement/search`,
        caseSearchQuery(validated),
        validated.marketplaceId,
      );
    });
  };

  /**
   * Retrieves one case.
   *
   * @param input - Case ID and optional marketplace override.
   * @returns An Effect that succeeds with eBay's case document.
   *
   * @see https://developer.ebay.com/devzone/post-order/post-order_v2_casemanagement-caseId__get.html
   */
  public getCase = (
    input: GetCaseInput,
  ): Effect.Effect<PostOrderDocument, EbayApiError | EndpointInputError> => {
    const client = this.client;

    return Effect.gen(function* () {
      const validated = yield* decodeEndpointInputEffect(getPostOrderCaseInputSchema, input);
      const path = `${BASE_PATH}/casemanagement/${encodeURIComponent(validated.caseId)}`;
      return yield* postOrderGet<PostOrderDocument>(
        client,
        path,
        undefined,
        validated.marketplaceId,
      );
    });
  };
}
