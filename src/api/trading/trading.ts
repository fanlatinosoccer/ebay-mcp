import type { TradingApiClient } from '@/api/client/tradingApiClient.js';
import {
  type EbayApiError,
  EndpointInputError,
  optionalPositiveNumberEffect,
  optionalStringEffect,
  requireObjectEffect,
  requireStringEffect,
} from '@/api/shared/request.js';
import type {
  createListingSchema,
  endListingSchema,
  getActiveListingsSchema,
  getBestOffersSchema,
  getListingSchema,
  relistItemSchema,
  respondToBestOfferSchema,
  reviseListingSchema,
} from '@/utils/trading/trading.js';
import { FormatType } from '@/types/ebayEnums.js';
import { isRecord } from '@/utils/typeGuards.js';
import { Effect } from 'effect';
import type { z } from 'zod';
import {
  TRADING_AUCTION_LISTING_TYPE,
  type TradingItemFields,
  resolveTradingFormat,
  tradingCallName,
  validateTradingEndingReasonEffect,
  validateTradingListingFormatEffect,
} from './listingFormat.js';

/** Input accepted by getActiveListings. */
type GetActiveListingsInput = z.infer<typeof getActiveListingsSchema>;
/** Input accepted by getListing. */
type GetListingInput = z.infer<typeof getListingSchema>;
/** Input accepted by createListing. */
type CreateListingInput = z.infer<typeof createListingSchema>;
/** Input accepted by reviseListing. */
type ReviseListingInput = z.infer<typeof reviseListingSchema>;
/** Input accepted by endListing. */
type EndListingInput = z.infer<typeof endListingSchema>;
/** Input accepted by relistItem. */
type RelistItemInput = z.infer<typeof relistItemSchema>;

/** Input accepted by getBestOffers. */
type GetBestOffersInput = z.infer<typeof getBestOffersSchema>;
/** Input accepted by respondToBestOffer. */
type RespondToBestOfferInput = z.infer<typeof respondToBestOfferSchema>;

/** Normalized Best Offer returned by getBestOffers. */
export interface NormalizedBestOffer {
  itemId?: string;
  title?: string;
  listPrice?: number;
  listCurrency?: string;
  bestOfferId?: string;
  buyerUserId?: string;
  buyerFeedbackScore?: number;
  price?: number;
  currency?: string;
  quantity?: number;
  expirationTime?: string;
  status?: string;
  bestOfferCodeType?: string;
  buyerMessage?: string;
  sellerMessage?: string;
}

const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
};

const firstRecord = (value: unknown): Record<string, unknown> | undefined =>
  toArray(value).find(isRecord);

const textOf = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return;
  if (isRecord(value)) return textOf(value['#text']);
  return String(value);
};

const numberOf = (value: unknown): number | undefined => {
  const text = textOf(value);
  if (text === undefined || text === '') return;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const currencyOf = (value: unknown): string | undefined =>
  isRecord(value) ? textOf(value['@_currencyID']) : undefined;

const compact = <T extends object>(record: T): T =>
  Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined)) as T;

const normalizeBestOffers = (
  item: Record<string, unknown> | undefined,
  bestOfferArray: unknown,
): NormalizedBestOffer[] => {
  const container = firstRecord(bestOfferArray);
  const offers = container === undefined ? [] : toArray(container.BestOffer).filter(isRecord);
  const sellingStatus = item === undefined ? undefined : firstRecord(item.SellingStatus);
  const listPriceSource =
    item === undefined
      ? undefined
      : (item.BuyItNowPrice ?? item.StartPrice ?? sellingStatus?.CurrentPrice);

  return offers.map((offer) => {
    const buyer = firstRecord(offer.Buyer);
    return compact<NormalizedBestOffer>({
      itemId: item === undefined ? undefined : textOf(item.ItemID),
      title: item === undefined ? undefined : textOf(item.Title),
      listPrice: numberOf(listPriceSource),
      listCurrency: currencyOf(listPriceSource),
      bestOfferId: textOf(offer.BestOfferID),
      buyerUserId: buyer === undefined ? undefined : textOf(buyer.UserID),
      buyerFeedbackScore: buyer === undefined ? undefined : numberOf(buyer.FeedbackScore),
      price: numberOf(offer.Price),
      currency: currencyOf(offer.Price),
      quantity: numberOf(offer.Quantity),
      expirationTime: textOf(offer.ExpirationTime),
      status: textOf(offer.Status),
      bestOfferCodeType: textOf(offer.BestOfferCodeType),
      buyerMessage: textOf(offer.BuyerMessage),
      sellerMessage: textOf(offer.SellerMessage),
    });
  });
};

const BEST_OFFERS_NOT_FOUND_CODE = '20140';

/** True when a Trading failure is eBay's "Best Offers Not Found" (20140), i.e. an empty result. */
const isBestOffersNotFound = (error: EbayApiError | EndpointInputError): boolean => {
  if (error._tag !== 'EbayApiError') return false;
  const failure: unknown = error.cause;
  if (!isRecord(failure)) return false;
  return toArray(failure.cause).some(
    (entry) => isRecord(entry) && textOf(entry.ErrorCode) === BEST_OFFERS_NOT_FOUND_CODE,
  );
};

const asRecordArray = (rawField: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(rawField)) {
    return [];
  }

  return rawField.filter(isRecord);
};

/**
 * Parsed Trading API object payload returned unchanged from XML calls.
 *
 * @see https://developer.ebay.com/devzone/xml/docs/reference/ebay/index.html
 */
export type TradingRecordResponse = Record<string, unknown>;

/**
 * High-level wrapper for seller listing operations backed by eBay Trading API calls.
 */
export class TradingApi {
  private readonly client: TradingApiClient;

  constructor(client: TradingApiClient) {
    this.client = client;
  }

  /**
   * Fetches active seller listings with Trading API pagination metadata.
   *
   * @param input - Optional page number and entries-per-page values.
   * @returns An Effect that succeeds with the parsed GetMyeBaySelling response payload.
   *
   * @example
   * ```ts
   * const tradingRecord = await Effect.runPromise(
   *   tradingApi.getActiveListings({ page: 2, entriesPerPage: 25 }),
   * );
   * ```
   *
   * @see https://developer.ebay.com/devzone/xml/docs/reference/ebay/getmyebayselling.html
   */
  getActiveListings = (
    input: GetActiveListingsInput = {},
  ): Effect.Effect<TradingRecordResponse, EbayApiError | EndpointInputError> => {
    const tradingClient = this.client;

    return Effect.gen(function* () {
      const validatedInput = yield* requireObjectEffect<GetActiveListingsInput>(input, 'input');
      const inputPage = yield* optionalPositiveNumberEffect(validatedInput.page, 'page');
      const inputEntriesPerPage = yield* optionalPositiveNumberEffect(
        validatedInput.entriesPerPage,
        'entriesPerPage',
      );
      const page = inputPage === undefined ? 1 : inputPage;
      const entriesPerPage = inputEntriesPerPage === undefined ? 50 : inputEntriesPerPage;

      return yield* tradingClient.execute('GetMyeBaySelling', {
        ActiveList: {
          Sort: 'TimeLeft',
          Pagination: {
            EntriesPerPage: entriesPerPage,
            PageNumber: page,
          },
        },
      });
    });
  };

  /**
   * Fetches a single listing by eBay item ID with full Trading API detail.
   *
   * @param input - eBay item identifier.
   * @returns An Effect that succeeds with the parsed Trading API item payload.
   *
   * @example
   * ```ts
   * const listing = await Effect.runPromise(tradingApi.getListing({ itemId: '12345' }));
   * ```
   *
   * @see https://developer.ebay.com/devzone/xml/docs/reference/ebay/getitem.html
   */
  getListing = (
    input: GetListingInput,
  ): Effect.Effect<TradingRecordResponse, EbayApiError | EndpointInputError> => {
    const tradingClient = this.client;

    return Effect.gen(function* () {
      const validatedInput = yield* requireObjectEffect<GetListingInput>(input, 'input');
      const itemId = yield* requireStringEffect(validatedInput.itemId, 'itemId');
      const getItemResponse = yield* tradingClient.execute('GetItem', {
        ItemID: itemId,
        DetailLevel: 'ReturnAll',
      });
      const items = asRecordArray(getItemResponse.Item);

      return items.length > 0 ? items[0] : getItemResponse;
    });
  };

  /**
   * Creates a listing using the supplied Trading API item payload.
   *
   * Fixed-price listings go through AddFixedPriceItem (with `ListingDuration` GTC
   * when supplied). Auctions go through AddItem with `ListingType` Chinese added to
   * the item, after the auction rules pass: a day-count `ListingDuration`, a
   * `StartPrice` opening bid, a single unit, a reserve above the opening bid, a Buy
   * It Now price at least 30% above it, and Best Offer only without Buy It Now.
   *
   * @param input - Trading API Item payload nested under `item`, plus the optional listing format.
   * @returns An Effect that succeeds with the parsed AddFixedPriceItem or AddItem response.
   *
   * @example
   * ```ts
   * const auction = await Effect.runPromise(
   *   tradingApi.createListing({
   *     format: FormatType.AUCTION,
   *     item: { Title: 'Rare coin', StartPrice: 9.99, ListingDuration: 'Days_7' },
   *   }),
   * );
   * ```
   *
   * @see https://developer.ebay.com/devzone/xml/docs/reference/ebay/AddFixedPriceItem.html
   * @see https://developer.ebay.com/devzone/xml/docs/reference/ebay/AddItem.html
   */
  createListing = (
    input: CreateListingInput,
  ): Effect.Effect<TradingRecordResponse, EbayApiError | EndpointInputError> => {
    const tradingClient = this.client;

    return Effect.gen(function* () {
      const validatedInput = yield* requireObjectEffect<CreateListingInput>(input, 'input');
      const format = resolveTradingFormat(validatedInput.format);
      const tradingItem = yield* requireObjectEffect<TradingItemFields>(
        validatedInput.item,
        'item',
      );
      yield* validateTradingListingFormatEffect({
        item: tradingItem,
        format,
        parameter: 'item',
        isCreate: true,
      });
      const listingItem =
        format === FormatType.AUCTION
          ? { ...tradingItem, ListingType: TRADING_AUCTION_LISTING_TYPE }
          : tradingItem;

      return yield* tradingClient.execute(tradingCallName('create', format), { Item: listingItem });
    });
  };

  /**
   * Revises a listing by merging changes with the eBay item ID.
   *
   * Fixed-price listings go through ReviseFixedPriceItem; auctions go through
   * ReviseItem after the auction field rules pass.
   *
   * @param input - eBay item identifier plus Trading API Item fields to update and the optional listing format.
   * @returns An Effect that succeeds with the parsed ReviseFixedPriceItem or ReviseItem response.
   *
   * @example
   * ```ts
   * const listing = await Effect.runPromise(
   *   tradingApi.reviseListing({ itemId: '12345', fields: { Quantity: 10 } }),
   * );
   * ```
   *
   * @see https://developer.ebay.com/devzone/xml/docs/reference/ebay/ReviseFixedPriceItem.html
   * @see https://developer.ebay.com/devzone/xml/docs/reference/ebay/ReviseItem.html
   */
  reviseListing = (
    input: ReviseListingInput,
  ): Effect.Effect<TradingRecordResponse, EbayApiError | EndpointInputError> => {
    const tradingClient = this.client;

    return Effect.gen(function* () {
      const validatedInput = yield* requireObjectEffect<ReviseListingInput>(input, 'input');
      const format = resolveTradingFormat(validatedInput.format);
      const itemId = yield* requireStringEffect(validatedInput.itemId, 'itemId');
      const fields = yield* requireObjectEffect<TradingItemFields>(validatedInput.fields, 'fields');
      yield* validateTradingListingFormatEffect({
        item: fields,
        format,
        parameter: 'fields',
        isCreate: false,
      });

      return yield* tradingClient.execute(tradingCallName('revise', format), {
        Item: { ...fields, ItemID: itemId },
      });
    });
  };

  /**
   * Ends a listing with the provided Trading API ending reason.
   *
   * Fixed-price listings go through EndFixedPriceItem; auctions go through EndItem,
   * the only call that accepts the SellToHighBidder reason.
   *
   * @param input - eBay item identifier plus optional Trading API ending reason and listing format.
   * @returns An Effect that succeeds with the parsed EndFixedPriceItem or EndItem response.
   *
   * @example
   * ```ts
   * await Effect.runPromise(
   *   tradingApi.endListing({ itemId: '12345', reason: 'NotAvailable' }),
   * );
   * ```
   *
   * @see https://developer.ebay.com/devzone/xml/docs/reference/ebay/endfixedpriceitem.html
   * @see https://developer.ebay.com/devzone/xml/docs/reference/ebay/EndItem.html
   */
  endListing = (
    input: EndListingInput,
  ): Effect.Effect<TradingRecordResponse, EbayApiError | EndpointInputError> => {
    const tradingClient = this.client;

    return Effect.gen(function* () {
      const validatedInput = yield* requireObjectEffect<EndListingInput>(input, 'input');
      const format = resolveTradingFormat(validatedInput.format);
      const itemId = yield* requireStringEffect(validatedInput.itemId, 'itemId');
      const inputReason = yield* optionalStringEffect(validatedInput.reason, 'reason');
      yield* validateTradingEndingReasonEffect(inputReason, format, 'reason');
      const reason = inputReason === undefined ? 'NotAvailable' : inputReason;

      return yield* tradingClient.execute(tradingCallName('end', format), {
        ItemID: itemId,
        EndingReason: reason,
      });
    });
  };

  /**
   * Relists an ended item with optional listing modifications.
   *
   * Fixed-price listings go through RelistFixedPriceItem; auctions go through
   * RelistItem after the auction field rules pass on the modifications.
   *
   * @param input - eBay item identifier plus optional Trading API Item modifications and listing format.
   * @returns An Effect that succeeds with the parsed RelistFixedPriceItem or RelistItem response.
   *
   * @example
   * ```ts
   * const listing = await Effect.runPromise(
   *   tradingApi.relistItem({ itemId: '12345', modifications: { Quantity: 20 } }),
   * );
   * ```
   *
   * @see https://developer.ebay.com/devzone/xml/docs/reference/ebay/relistfixedpriceitem.html
   * @see https://developer.ebay.com/devzone/xml/docs/reference/ebay/RelistItem.html
   */
  relistItem = (
    input: RelistItemInput,
  ): Effect.Effect<TradingRecordResponse, EbayApiError | EndpointInputError> => {
    const tradingClient = this.client;

    return Effect.gen(function* () {
      const validatedInput = yield* requireObjectEffect<RelistItemInput>(input, 'input');
      const format = resolveTradingFormat(validatedInput.format);
      const itemId = yield* requireStringEffect(validatedInput.itemId, 'itemId');
      let modifications: TradingItemFields = {};

      if (validatedInput.modifications !== undefined) {
        modifications = yield* requireObjectEffect<TradingItemFields>(
          validatedInput.modifications,
          'modifications',
        );
      }
      yield* validateTradingListingFormatEffect({
        item: modifications,
        format,
        parameter: 'modifications',
        isCreate: false,
      });

      return yield* tradingClient.execute(tradingCallName('relist', format), {
        Item: { ...modifications, ItemID: itemId },
      });
    });
  };

  /**
   * Lists Best Offers received on the seller's listings.
   *
   * With an itemId, returns offers for that listing; without one, returns offers
   * across all listings (ItemBestOffersArray). Offers are normalized into a flat
   * list with item, buyer, price, quantity, expiration, status, and messages.
   *
   * @param input - Optional item ID, Best Offer ID, status filter (default Active), and pagination.
   * @returns An Effect that succeeds with normalized offers plus pagination metadata.
   *
   * @see https://developer.ebay.com/devzone/xml/docs/reference/ebay/GetBestOffers.html
   */
  getBestOffers = (
    input: GetBestOffersInput = {},
  ): Effect.Effect<TradingRecordResponse, EbayApiError | EndpointInputError> => {
    const tradingClient = this.client;

    return Effect.gen(function* () {
      const validatedInput = yield* requireObjectEffect<GetBestOffersInput>(input, 'input');
      const itemId = yield* optionalStringEffect(validatedInput.itemId, 'itemId');
      const bestOfferId = yield* optionalStringEffect(validatedInput.bestOfferId, 'bestOfferId');
      const inputPage = yield* optionalPositiveNumberEffect(validatedInput.page, 'page');
      const inputEntries = yield* optionalPositiveNumberEffect(
        validatedInput.entriesPerPage,
        'entriesPerPage',
      );
      if (bestOfferId !== undefined && itemId === undefined) {
        return yield* Effect.fail(
          new EndpointInputError({
            parameter: 'bestOfferId',
            message: 'bestOfferId requires itemId',
          }),
        );
      }
      const status = validatedInput.bestOfferStatus ?? 'Active';
      const page = inputPage ?? 1;
      const entriesPerPage = Math.min(inputEntries ?? 25, 25);

      const response: Record<string, unknown> = yield* tradingClient
        .execute('GetBestOffers', {
          ...(itemId === undefined ? {} : { ItemID: itemId }),
          ...(bestOfferId === undefined ? {} : { BestOfferID: bestOfferId }),
          BestOfferStatus: status,
          DetailLevel: 'ReturnAll',
          Pagination: { EntriesPerPage: entriesPerPage, PageNumber: page },
        })
        .pipe(
          // eBay answers an item-scoped query with no offers as a Failure (20140); treat as empty.
          Effect.catchIf(isBestOffersNotFound, () =>
            Effect.succeed<Record<string, unknown>>({ Ack: 'Success', NoOffersFound: true }),
          ),
        );

      const offers: NormalizedBestOffer[] = [];
      if (response.BestOfferArray !== undefined) {
        offers.push(...normalizeBestOffers(firstRecord(response.Item), response.BestOfferArray));
      }
      const itemGroups = firstRecord(response.ItemBestOffersArray);
      if (itemGroups !== undefined) {
        for (const group of toArray(itemGroups.ItemBestOffers).filter(isRecord)) {
          offers.push(...normalizeBestOffers(firstRecord(group.Item), group.BestOfferArray));
        }
      }
      const pagination = firstRecord(response.PaginationResult);

      return {
        ack: response.Ack,
        bestOfferStatus: status,
        count: offers.length,
        offers,
        page: numberOf(response.PageNumber) ?? page,
        totalPages: pagination === undefined ? undefined : numberOf(pagination.TotalNumberOfPages),
        totalEntries:
          pagination === undefined ? undefined : numberOf(pagination.TotalNumberOfEntries),
        ...(response.Errors === undefined ? {} : { warnings: response.Errors }),
        ...(validatedInput.includeRaw === true ? { raw: response } : {}),
      };
    });
  };

  /**
   * Accepts, declines, or counters Best Offers on a listing.
   *
   * The action is required and has no default. Counter requires counterOfferPrice
   * and exactly one Best Offer ID; Accept/Decline reject counter fields.
   *
   * @param input - Item ID, Best Offer IDs, action, optional counter price/quantity and seller message.
   * @returns An Effect that succeeds with the parsed RespondToBestOffer response.
   *
   * @see https://developer.ebay.com/devzone/xml/docs/reference/ebay/RespondToBestOffer.html
   */
  respondToBestOffer = (
    input: RespondToBestOfferInput,
  ): Effect.Effect<TradingRecordResponse, EbayApiError | EndpointInputError> => {
    const tradingClient = this.client;

    return Effect.gen(function* () {
      const validatedInput = yield* requireObjectEffect<RespondToBestOfferInput>(input, 'input');
      const itemId = yield* requireStringEffect(validatedInput.itemId, 'itemId');
      const action = validatedInput.action;
      if (action !== 'Accept' && action !== 'Decline' && action !== 'Counter') {
        return yield* Effect.fail(
          new EndpointInputError({
            parameter: 'action',
            message: 'action is required and must be Accept, Decline, or Counter',
          }),
        );
      }
      const ids = Array.isArray(validatedInput.bestOfferIds)
        ? validatedInput.bestOfferIds.filter((id) => typeof id === 'string' && id.trim() !== '')
        : [];
      if (ids.length === 0) {
        return yield* Effect.fail(
          new EndpointInputError({
            parameter: 'bestOfferIds',
            message: 'bestOfferIds must contain at least one Best Offer ID',
          }),
        );
      }
      const { counterOfferPrice, counterOfferQuantity } = validatedInput;
      if (action === 'Counter') {
        if (ids.length !== 1) {
          return yield* Effect.fail(
            new EndpointInputError({
              parameter: 'bestOfferIds',
              message: 'Counter accepts exactly one Best Offer ID',
            }),
          );
        }
        if (typeof counterOfferPrice !== 'number' || !(counterOfferPrice > 0)) {
          return yield* Effect.fail(
            new EndpointInputError({
              parameter: 'counterOfferPrice',
              message: 'counterOfferPrice (> 0) is required when action is Counter',
            }),
          );
        }
      } else if (counterOfferPrice !== undefined || counterOfferQuantity !== undefined) {
        return yield* Effect.fail(
          new EndpointInputError({
            parameter: 'counterOfferPrice',
            message: 'counterOfferPrice/counterOfferQuantity are only valid when action is Counter',
          }),
        );
      }
      const sellerResponse = yield* optionalStringEffect(
        validatedInput.sellerResponse,
        'sellerResponse',
      );
      const currency = validatedInput.currency ?? 'USD';

      return yield* tradingClient.execute('RespondToBestOffer', {
        ItemID: itemId,
        BestOfferID: ids,
        Action: action,
        ...(action === 'Counter'
          ? {
              CounterOfferPrice: {
                '#text': Number(counterOfferPrice).toFixed(2),
                '@_currencyID': currency,
              },
              ...(counterOfferQuantity === undefined
                ? {}
                : { CounterOfferQuantity: counterOfferQuantity }),
            }
          : {}),
        ...(sellerResponse === undefined || sellerResponse === ''
          ? {}
          : { SellerResponse: sellerResponse }),
      });
    });
  };
}
