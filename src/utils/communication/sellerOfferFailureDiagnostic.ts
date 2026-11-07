import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { EbayClientRequestErrorKind } from '@/api/client/ebayClientRequestError.js';
import { Cause, Runtime } from 'effect';

/**
 * Sanitized failure record for `ebay_send_offer_to_interested_buyers`.
 *
 * The Negotiation call still cannot target a buyer. Upstream `message` and
 * `longMessage` strings are omitted on every seller-offer diagnostic, tool
 * result, and log. They are arbitrary prose and can name a buyer who appears
 * in neither the request nor the error parameters. The summary is a fixed
 * sentence chosen from the HTTP status or an internal failure kind.
 *
 * Retained fidelity is status, origin, failure kind, `errorId`, `domain`,
 * `category`, parameter names, allow-listed correlation ids, and the
 * allow-listed request. The raw body is not copied.
 */
export const SELLER_OFFER_TOOL_NAME = 'ebay_send_offer_to_interested_buyers';

const SELLER_OFFER_PATH = '/sell/negotiation/v1/send_offer_to_interested_buyers';
const MAX_ERRORS = 5;
const MAX_PARAMETER_NAMES = 8;
const MAX_OFFERED_ITEMS = 4;
const MAX_HOPS = 12;

const REQUEST_ID_HEADERS = [
  'rlogid',
  'x-ebay-c-request-id',
  'x-ebay-request-id',
  'x-ebay-c-correlation-id',
  'x-ebay-correlation-id',
  'x-correlation-id',
  'x-request-id',
] as const;

const REQUEST_ID_VALUE = /^[\x21-\x7E]{6,256}$/;
const UNSAFE_REQUEST_ID = /bearer|token|cookie|secret|password|authorization|@/i;
const LISTING_ID = /^[0-9]{1,19}$/;
const CURRENCY = /^[A-Z]{3}$/;
const PRICE_VALUE = /^\d{1,10}(\.\d{1,4})?$/;
const DURATION_UNIT = /^[A-Z_]{1,16}$/;
const MARKETPLACE_ID = /^EBAY_[A-Z0-9_]{1,24}$/;
const DISCOUNT = /^\d{1,3}(\.\d{1,2})?$/;
const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/;
const UNSAFE_PARAMETER_NAME = /token|password|secret|authorization|cookie|api[-_]?key/i;

const UPSTREAM_KINDS = new Set<EbayClientRequestErrorKind>(['httpStatus', 'remoteRateLimit']);
const INTERNAL_KINDS = new Set<EbayClientRequestErrorKind>([
  'missingCredentials',
  'localRateLimit',
  'tokenAcquisition',
  'missingAccessToken',
  'tokenRefresh',
  'transport',
]);
const KNOWN_KINDS = new Set<string>([...UPSTREAM_KINDS, ...INTERNAL_KINDS]);
const INTERNAL_TAGS = new Set(['EndpointInputError', 'ToolInputError']);

/** Why an unstructured eBay body was not copied into the diagnostic. */
export type UnstructuredBodyReason = 'absent' | 'non-object' | 'unrecognized';

/**
 * One allow-listed eBay error entry.
 * Parameter values and upstream prose (`message`, `longMessage`) are omitted.
 */
export interface SellerOfferErrorDiagnostic {
  readonly errorId?: number;
  readonly domain?: string;
  readonly category?: string;
  readonly parameterNames?: readonly string[];
}

/** Price fields the seller-offer request is allowed to retain. */
export interface SellerOfferPriceDiagnostic {
  readonly currency?: string;
  readonly value?: string;
}

/** One offered listing, limited to scalar offer settings. */
export interface SellerOfferItemDiagnostic {
  readonly listingId?: string;
  readonly quantity?: number;
  readonly discountPercentage?: string;
  readonly price?: SellerOfferPriceDiagnostic;
}

/** Allow-listed view of the seller-offer request. `message` is never included. */
export interface SellerOfferRequestDiagnostic {
  readonly marketplaceId?: string;
  readonly allowCounterOffer?: boolean;
  readonly duration?: { readonly unit?: string; readonly value?: number };
  readonly offeredItems?: readonly SellerOfferItemDiagnostic[];
}

/** Structured diagnostic returned to the caller and written to the failure log. */
export interface SellerOfferFailureDiagnostic {
  readonly origin?: 'upstream' | 'internal';
  readonly failureKind?: EbayClientRequestErrorKind;
  readonly status?: number;
  /**
   * Fixed sentence from HTTP status or an internal failure kind.
   * This is not the eBay error message.
   */
  readonly summary: string;
  /** Upstream prose is intentionally omitted rather than scrubbed or copied. */
  readonly upstreamMessage: 'omitted';
  readonly errors?: readonly SellerOfferErrorDiagnostic[];
  readonly requestIds?: Readonly<Record<string, string>>;
  readonly request?: SellerOfferRequestDiagnostic;
  readonly unstructuredBody?: UnstructuredBodyReason;
}

/** MCP failure payload plus the log record for this tool. */
export interface SellerOfferToolFailure {
  readonly result: CallToolResult;
  readonly log: { readonly diagnostic: SellerOfferFailureDiagnostic };
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const plainRecord = (value: unknown): Record<string, unknown> | undefined => {
  const record = asRecord(value);
  if (!record) {
    return;
  }
  const prototype = Object.getPrototypeOf(record);
  return prototype === Object.prototype || prototype === null ? record : undefined;
};

const own = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = own(record, key);
  return typeof value === 'string' ? value : undefined;
};

const readInteger = (
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined => {
  const value = own(record, key);
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
};

/**
 * True when `url` is the Negotiation send-offer endpoint on any eBay host.
 */
export const isSellerOfferRequestUrl = (url: string): boolean => {
  try {
    return new URL(url).pathname.replace(/\/$/, '') === SELLER_OFFER_PATH;
  } catch {
    return url
      .replace(/[?#].*$/, '')
      .replace(/\/$/, '')
      .endsWith(SELLER_OFFER_PATH);
  }
};

const headerValue = (headers: Record<string, unknown> | undefined, name: string): unknown => {
  if (!headers) {
    return;
  }
  if (Object.hasOwn(headers, name)) {
    return headers[name];
  }
  const keys = Object.keys(headers);
  const limit = Math.min(keys.length, 64);
  for (let index = 0; index < limit; index += 1) {
    const key = keys[index];
    if (key !== undefined && key.toLowerCase() === name) {
      return headers[key];
    }
  }
};

const httpStatus = (status: number | undefined): number | undefined =>
  typeof status === 'number' && status >= 100 && status <= 599 ? status : undefined;

/**
 * Summary used for seller-offer failures. The sentence comes from the status
 * or failure kind, never from upstream or caller-supplied prose.
 */
export const sellerOfferCuratedSummary = (input: {
  readonly status?: number;
  readonly failureKind?: EbayClientRequestErrorKind;
  readonly internal?: boolean;
}): string => {
  const status = httpStatus(input.status);
  if (status !== undefined) {
    return `Seller offer failed with HTTP ${status}`;
  }
  if (input.failureKind === 'transport') {
    return 'Seller offer failed before a response was received';
  }
  if (
    input.internal === true ||
    (input.failureKind !== undefined && INTERNAL_KINDS.has(input.failureKind))
  ) {
    return 'Seller offer failed before the request was sent';
  }
  return 'Seller offer failed';
};

const sanitizePrice = (value: unknown): SellerOfferPriceDiagnostic | undefined => {
  const record = plainRecord(value);
  if (!record) {
    return;
  }
  const currency = readString(record, 'currency');
  const amount = readString(record, 'value');
  const price: { currency?: string; value?: string } = {};
  if (currency && CURRENCY.test(currency)) {
    price.currency = currency;
  }
  if (amount && PRICE_VALUE.test(amount)) {
    price.value = amount;
  }
  return price.currency || price.value ? price : undefined;
};

const sanitizeOfferedItem = (value: unknown): SellerOfferItemDiagnostic | undefined => {
  const record = plainRecord(value);
  if (!record) {
    return;
  }
  const item: {
    listingId?: string;
    quantity?: number;
    discountPercentage?: string;
    price?: SellerOfferPriceDiagnostic;
  } = {};
  const listingId = readString(record, 'listingId');
  if (listingId && LISTING_ID.test(listingId)) {
    item.listingId = listingId;
  }
  const quantity = readInteger(record, 'quantity', 1, 10_000);
  if (quantity !== undefined) {
    item.quantity = quantity;
  }
  const discountPercentage = readString(record, 'discountPercentage');
  if (discountPercentage && DISCOUNT.test(discountPercentage)) {
    item.discountPercentage = discountPercentage;
  }
  const price = sanitizePrice(own(record, 'price'));
  if (price) {
    item.price = price;
  }
  return Object.keys(item).length > 0 ? item : undefined;
};

const sanitizeDuration = (value: unknown): { unit?: string; value?: number } | undefined => {
  const record = plainRecord(value);
  if (!record) {
    return;
  }
  const unit = readString(record, 'unit');
  const duration: { unit?: string; value?: number } = {};
  if (unit && DURATION_UNIT.test(unit)) {
    duration.unit = unit;
  }
  const amount = readInteger(record, 'value', 0, 100_000);
  if (amount !== undefined) {
    duration.value = amount;
  }
  return duration.unit || duration.value !== undefined ? duration : undefined;
};

/**
 * Copies only the seller-offer fields approved for diagnostics.
 * Duration is recorded as submitted; this does not coerce it to 2 days.
 */
export const sanitizeSellerOfferRequest = (
  request: unknown,
  headers?: Record<string, string>,
): SellerOfferRequestDiagnostic | undefined => {
  const record = plainRecord(request);
  const diagnostic: {
    marketplaceId?: string;
    allowCounterOffer?: boolean;
    duration?: { unit?: string; value?: number };
    offeredItems?: SellerOfferItemDiagnostic[];
  } = {};
  const marketplaceSource = record ? readString(record, 'marketplaceId') : undefined;
  const headerMarketplace = headerValue(
    headers ? plainRecord(headers) : undefined,
    'x-ebay-c-marketplace-id',
  );
  const marketplaceId =
    marketplaceSource ?? (typeof headerMarketplace === 'string' ? headerMarketplace : undefined);
  if (marketplaceId && MARKETPLACE_ID.test(marketplaceId)) {
    diagnostic.marketplaceId = marketplaceId;
  }
  if (record && typeof own(record, 'allowCounterOffer') === 'boolean') {
    diagnostic.allowCounterOffer = own(record, 'allowCounterOffer') === true;
  }
  const duration = record ? sanitizeDuration(own(record, 'offerDuration')) : undefined;
  if (duration) {
    diagnostic.duration = duration;
  }
  const offeredItems = record ? own(record, 'offeredItems') : undefined;
  if (Array.isArray(offeredItems)) {
    const items: SellerOfferItemDiagnostic[] = [];
    const limit = Math.min(offeredItems.length, MAX_OFFERED_ITEMS);
    for (let index = 0; index < limit; index += 1) {
      const item = sanitizeOfferedItem(offeredItems[index]);
      if (item) {
        items.push(item);
      }
    }
    if (items.length > 0) {
      diagnostic.offeredItems = items;
    }
  }
  return Object.keys(diagnostic).length > 0 ? diagnostic : undefined;
};

const isSafeRequestId = (value: string): boolean =>
  REQUEST_ID_VALUE.test(value) && !UNSAFE_REQUEST_ID.test(value);

const readRequestIds = (headers: unknown): Record<string, string> | undefined => {
  const record = plainRecord(headers);
  if (!record) {
    return;
  }
  const requestIds: Record<string, string> = {};
  for (const name of REQUEST_ID_HEADERS) {
    if (Object.keys(requestIds).length >= 4) {
      break;
    }
    const value = headerValue(record, name);
    if (typeof value === 'string' && isSafeRequestId(value)) {
      requestIds[name] = value;
    }
  }
  return Object.keys(requestIds).length > 0 ? requestIds : undefined;
};

const readErrorEntries = (
  data: unknown,
): {
  readonly records: readonly Record<string, unknown>[];
  readonly reason?: UnstructuredBodyReason;
} => {
  if (data == null) {
    return { records: [], reason: 'absent' };
  }
  const record = plainRecord(data);
  if (!record) {
    return { records: [], reason: 'non-object' };
  }
  const errors = own(record, 'errors');
  if (Array.isArray(errors)) {
    const records: Record<string, unknown>[] = [];
    const limit = Math.min(errors.length, MAX_ERRORS);
    for (let index = 0; index < limit; index += 1) {
      const entry = plainRecord(errors[index]);
      if (entry) {
        records.push(entry);
      }
    }
    return records.length > 0 ? { records } : { records, reason: 'unrecognized' };
  }
  if (typeof own(record, 'errorId') === 'number' || typeof own(record, 'message') === 'string') {
    return { records: [record] };
  }
  return { records: [], reason: 'unrecognized' };
};

const parameterNames = (entry: Record<string, unknown>): string[] | undefined => {
  const parameters = own(entry, 'parameters');
  if (!Array.isArray(parameters)) {
    return;
  }
  const names: string[] = [];
  const limit = Math.min(parameters.length, MAX_PARAMETER_NAMES);
  for (let index = 0; index < limit; index += 1) {
    const parameter = plainRecord(parameters[index]);
    const name = parameter ? readString(parameter, 'name') : undefined;
    if (name && PARAMETER_NAME.test(name) && !UNSAFE_PARAMETER_NAME.test(name)) {
      names.push(name);
    }
  }
  return names.length > 0 ? names : undefined;
};

const errorIdOf = (entry: Record<string, unknown>): number | undefined => {
  const errorId = own(entry, 'errorId');
  return typeof errorId === 'number' &&
    Number.isSafeInteger(errorId) &&
    errorId >= 0 &&
    errorId <= 2_147_483_647
    ? errorId
    : undefined;
};

const enumText = (
  entry: Record<string, unknown>,
  key: 'domain' | 'category',
): string | undefined => {
  const value = readString(entry, key);
  return value && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
};

const sanitizeError = (entry: Record<string, unknown>): SellerOfferErrorDiagnostic | undefined => {
  const diagnostic: {
    errorId?: number;
    domain?: string;
    category?: string;
    parameterNames?: string[];
  } = {};
  const errorId = errorIdOf(entry);
  if (errorId !== undefined) {
    diagnostic.errorId = errorId;
  }
  const domain = enumText(entry, 'domain');
  if (domain) {
    diagnostic.domain = domain;
  }
  const category = enumText(entry, 'category');
  if (category) {
    diagnostic.category = category;
  }
  const names = parameterNames(entry);
  if (names) {
    diagnostic.parameterNames = names;
  }
  return Object.keys(diagnostic).length > 0 ? diagnostic : undefined;
};

interface ChainFacts {
  status?: number;
  failureKind?: EbayClientRequestErrorKind;
  internalTag: boolean;
  headers?: unknown;
  data?: unknown;
}

const nextErrorNode = (node: Record<string, unknown>): unknown => {
  const fiberCause = (node as Record<symbol, unknown>)[Runtime.FiberFailureCauseId];
  if (fiberCause !== undefined) {
    return Cause.squash(fiberCause as Cause.Cause<unknown>);
  }
  return node.cause;
};

const absorbErrorNode = (node: Record<string, unknown>, facts: ChainFacts): void => {
  if (
    facts.status === undefined &&
    typeof node.status === 'number' &&
    node.status >= 100 &&
    node.status <= 599
  ) {
    facts.status = node.status;
  }
  if (
    facts.failureKind === undefined &&
    typeof node.kind === 'string' &&
    KNOWN_KINDS.has(node.kind)
  ) {
    facts.failureKind = node.kind as EbayClientRequestErrorKind;
  }
  if (typeof node._tag === 'string' && INTERNAL_TAGS.has(node._tag)) {
    facts.internalTag = true;
  }
  if (facts.headers === undefined && node.headers !== undefined) {
    facts.headers = node.headers;
  }
  if (facts.data === undefined && node.data !== undefined) {
    facts.data = node.data;
  }
};

const walkErrorChain = (error: unknown): ChainFacts => {
  const facts: ChainFacts = { internalTag: false };
  const seen = new Set<unknown>();
  let current: unknown = error;
  let hops = 0;
  while (current != null && hops < MAX_HOPS && !seen.has(current)) {
    hops += 1;
    seen.add(current);
    const node = asRecord(current);
    if (!node) {
      break;
    }
    absorbErrorNode(node, facts);
    current = nextErrorNode(node);
  }
  return facts;
};

const resolveOrigin = (facts: ChainFacts): 'upstream' | 'internal' | undefined => {
  if (facts.failureKind && UPSTREAM_KINDS.has(facts.failureKind)) {
    return 'upstream';
  }
  if (facts.failureKind && INTERNAL_KINDS.has(facts.failureKind)) {
    return 'internal';
  }
  if (facts.internalTag) {
    return 'internal';
  }
  if (facts.status !== undefined) {
    return 'upstream';
  }
};

const unstructuredBodyReason = (
  facts: ChainFacts,
  errorCount: number,
  reason: UnstructuredBodyReason | undefined,
  origin: 'upstream' | 'internal' | undefined,
): UnstructuredBodyReason | undefined => {
  if (errorCount > 0) {
    return;
  }
  if (facts.data !== undefined) {
    return reason;
  }
  return origin === 'upstream' || facts.status !== undefined ? 'absent' : undefined;
};

/**
 * Builds the seller-offer failure diagnostic from an unknown thrown value and
 * the original tool or HTTP request. Unknown body shapes and upstream prose
 * are not copied.
 */
export const buildSellerOfferFailureDiagnostic = (
  error: unknown,
  request: unknown,
  headers?: Record<string, string>,
): SellerOfferFailureDiagnostic => {
  const facts = walkErrorChain(error);
  const extracted = readErrorEntries(facts.data);
  const errors = extracted.records.flatMap((entry) => {
    const diagnostic = sanitizeError(entry);
    return diagnostic ? [diagnostic] : [];
  });
  const safeRequest = sanitizeSellerOfferRequest(request, headers);
  const requestIds = readRequestIds(facts.headers);
  const origin = resolveOrigin(facts);
  const unstructuredBody = unstructuredBodyReason(facts, errors.length, extracted.reason, origin);
  return {
    ...(origin ? { origin } : {}),
    ...(facts.failureKind ? { failureKind: facts.failureKind } : {}),
    ...(facts.status === undefined ? {} : { status: facts.status }),
    summary: sellerOfferCuratedSummary({
      status: facts.status,
      failureKind: facts.failureKind,
      internal: facts.internalTag,
    }),
    upstreamMessage: 'omitted',
    ...(errors.length > 0 ? { errors } : {}),
    ...(requestIds ? { requestIds } : {}),
    ...(safeRequest ? { request: safeRequest } : {}),
    ...(unstructuredBody ? { unstructuredBody } : {}),
  };
};

/**
 * MCP text result for a seller-offer failure. `error` is the curated summary
 * and `status` stays at the top level. The raw eBay body and upstream prose
 * are not placed in `details` or `diagnostic`.
 */
export const formatSellerOfferToolFailure = (
  error: unknown,
  request: unknown,
): SellerOfferToolFailure => {
  const diagnostic = buildSellerOfferFailureDiagnostic(error, request);
  const failureDocument: Record<string, unknown> = {
    error: diagnostic.summary,
    ...(diagnostic.status === undefined ? {} : { status: diagnostic.status }),
    diagnostic,
  };
  return {
    result: {
      content: [{ type: 'text', text: JSON.stringify(failureDocument, null, 2) }],
      isError: true,
    },
    log: { diagnostic },
  };
};
