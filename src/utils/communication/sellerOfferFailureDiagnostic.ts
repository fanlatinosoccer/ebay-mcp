import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { EbayClientRequestErrorKind } from '@/api/client/ebayClientRequestError.js';
import { Cause, Runtime } from 'effect';

/**
 * Sanitized failure record for `ebay_send_offer_to_interested_buyers`.
 *
 * The Negotiation call still cannot target a buyer. This module only retains
 * allow-listed request fields and eBay error identity so a later 409 can be
 * diagnosed without storing the seller message, credentials, or raw body.
 */
export const SELLER_OFFER_TOOL_NAME = 'ebay_send_offer_to_interested_buyers';

const SELLER_OFFER_PATH = '/sell/negotiation/v1/send_offer_to_interested_buyers';
const REDACTED = '[REDACTED]';
const MAX_ERRORS = 5;
const MAX_PARAMETER_NAMES = 8;
const MAX_OFFERED_ITEMS = 4;
const MAX_MESSAGE = 160;
const MAX_TEXT = 4000;
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
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}/g;
const BEARER = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const URL_CREDENTIALS = /\/\/[^\s/@]+@/g;
const SECRET_ASSIGNMENT =
  /\b(?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password|authorization|cookie)\b\s*[:=]\s*\S+/gi;
const EMBEDDED_JSON = /[[{][\s\S]*[\]}]/g;

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

/** One allow-listed eBay error entry. Parameter values are never retained. */
export interface SellerOfferErrorDiagnostic {
  readonly errorId?: number;
  readonly domain?: string;
  readonly category?: string;
  readonly message?: string;
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
  readonly summary: string;
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

const isSafeScalar = (value: string): boolean =>
  /^\d{1,12}(\.\d{1,4})?$/.test(value) ||
  CURRENCY.test(value) ||
  /^(YEAR|MONTH|DAY|HOUR|MINUTE|SECOND)$/.test(value) ||
  MARKETPLACE_ID.test(value) ||
  /^(true|false)$/i.test(value);

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

const collectLiterals = (errorBody: unknown, request: unknown): string[] => {
  const literals: string[] = [];
  const requestRecord = plainRecord(request);
  const sellerMessage = requestRecord ? readString(requestRecord, 'message') : undefined;
  if (sellerMessage && sellerMessage.length >= 4 && sellerMessage.length <= 2000) {
    literals.push(sellerMessage);
  }

  const body = plainRecord(errorBody);
  const errors = body && Array.isArray(body.errors) ? body.errors : [];
  const errorLimit = Math.min(errors.length, MAX_ERRORS);
  for (let index = 0; index < errorLimit; index += 1) {
    const entry = plainRecord(errors[index]);
    const parameters = entry && Array.isArray(entry.parameters) ? entry.parameters : [];
    const parameterLimit = Math.min(parameters.length, MAX_PARAMETER_NAMES);
    for (let parameterIndex = 0; parameterIndex < parameterLimit; parameterIndex += 1) {
      const parameter = plainRecord(parameters[parameterIndex]);
      const value = parameter ? readString(parameter, 'value') : undefined;
      if (value && value.length >= 4 && value.length <= 500 && !isSafeScalar(value)) {
        literals.push(value);
      }
    }
  }

  return literals.slice(0, 24);
};

const scrubText = (value: string, literals: readonly string[]): string => {
  let text = value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
  const responseMarker = text.indexOf('| response:');
  if (responseMarker >= 0) {
    text = text.slice(0, responseMarker);
  }
  text = text.replace(EMBEDDED_JSON, '[omitted]');
  for (const literal of literals) {
    if (literal.length >= 4 && text.includes(literal)) {
      text = text.split(literal).join(REDACTED);
    }
  }
  text = text
    .replace(URL_CREDENTIALS, `//${REDACTED}@`)
    .replace(BEARER, REDACTED)
    .replace(JWT, REDACTED)
    .replace(EMAIL, REDACTED)
    .replace(PHONE, REDACTED)
    .replace(SECRET_ASSIGNMENT, REDACTED)
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}...` : text;
};

/**
 * Scrubs a seller-offer HTTP status message so the thrown error text does not
 * carry the raw response body, seller message, or sensitive parameter values.
 */
export const scrubSellerOfferFailureText = (
  text: string,
  errorBody: unknown,
  request: unknown,
): string => {
  const scrubbed = scrubText(text, collectLiterals(errorBody, request));
  return scrubbed.length > 0 ? scrubbed : 'Seller offer failed';
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

const sanitizeError = (
  entry: Record<string, unknown>,
  literals: readonly string[],
): SellerOfferErrorDiagnostic | undefined => {
  const messageSource = readString(entry, 'message') ?? readString(entry, 'longMessage');
  const diagnostic: {
    errorId?: number;
    domain?: string;
    category?: string;
    message?: string;
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
  if (messageSource) {
    const message = scrubText(messageSource, literals);
    if (message.length > 0) {
      diagnostic.message = message;
    }
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
  messages: string[];
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
  if (typeof node.message === 'string' && node.message.length > 0 && facts.messages.length < 4) {
    facts.messages.push(node.message);
  }
};

const walkErrorChain = (error: unknown): ChainFacts => {
  const facts: ChainFacts = { internalTag: false, messages: [] };
  const seen = new Set<unknown>();
  let current: unknown = error;
  let hops = 0;
  while (current != null && hops < MAX_HOPS && !seen.has(current)) {
    hops += 1;
    seen.add(current);
    const node = asRecord(current);
    if (!node) {
      if (typeof current === 'string' && facts.messages.length === 0) {
        facts.messages.push(current);
      }
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

const summaryFor = (
  facts: ChainFacts,
  errors: readonly SellerOfferErrorDiagnostic[],
  literals: readonly string[],
): string => {
  const errorMessage = errors.find((entry) => entry.message)?.message;
  if (errorMessage) {
    return errorMessage;
  }
  for (const message of facts.messages) {
    const scrubbed = scrubText(message, literals);
    if (scrubbed.length > 0) {
      return scrubbed;
    }
  }
  return facts.status === undefined
    ? 'Seller offer failed'
    : `Seller offer failed with HTTP ${facts.status}`;
};

const omitRawLiterals = (
  diagnostic: SellerOfferFailureDiagnostic,
  literals: readonly string[],
): SellerOfferFailureDiagnostic => {
  const sensitive = literals.filter((literal) => literal.length >= 4 && !isSafeScalar(literal));
  if (sensitive.length === 0) {
    return diagnostic;
  }
  let serialized = JSON.stringify(diagnostic);
  let changed = false;
  for (const literal of sensitive) {
    if (serialized.includes(literal)) {
      serialized = serialized.split(literal).join(REDACTED);
      changed = true;
    }
  }
  if (!changed) {
    return diagnostic;
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    const record = plainRecord(parsed);
    return record && typeof record.summary === 'string'
      ? (parsed as SellerOfferFailureDiagnostic)
      : { summary: 'Seller offer failed', unstructuredBody: 'unrecognized' };
  } catch {
    return { summary: 'Seller offer failed', unstructuredBody: 'unrecognized' };
  }
};

/**
 * Builds the seller-offer failure diagnostic from an unknown thrown value and
 * the original tool or HTTP request. Unknown body shapes are not copied.
 */
export const buildSellerOfferFailureDiagnostic = (
  error: unknown,
  request: unknown,
  headers?: Record<string, string>,
): SellerOfferFailureDiagnostic => {
  const facts = walkErrorChain(error);
  const literals = collectLiterals(facts.data, request);
  const extracted = readErrorEntries(facts.data);
  const errors = extracted.records.flatMap((entry) => {
    const diagnostic = sanitizeError(entry, literals);
    return diagnostic ? [diagnostic] : [];
  });
  const safeRequest = sanitizeSellerOfferRequest(request, headers);
  const requestIds = readRequestIds(facts.headers);
  const origin = resolveOrigin(facts);
  const unstructuredBody = unstructuredBodyReason(facts, errors.length, extracted.reason, origin);
  const diagnostic: SellerOfferFailureDiagnostic = {
    ...(origin ? { origin } : {}),
    ...(facts.failureKind ? { failureKind: facts.failureKind } : {}),
    ...(facts.status === undefined ? {} : { status: facts.status }),
    summary: summaryFor(facts, errors, literals),
    ...(errors.length > 0 ? { errors } : {}),
    ...(requestIds ? { requestIds } : {}),
    ...(safeRequest ? { request: safeRequest } : {}),
    ...(unstructuredBody ? { unstructuredBody } : {}),
  };
  return omitRawLiterals(diagnostic, literals);
};

/**
 * MCP text result for a seller-offer failure. `error` and `status` stay at the
 * top level; the raw eBay body is not placed in `details`.
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
