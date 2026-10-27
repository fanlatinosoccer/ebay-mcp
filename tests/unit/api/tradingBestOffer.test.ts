import { beforeEach, expect, it, vi } from 'vitest';
import type { TradingApiClient } from '@/api/client/tradingApiClient.js';
import { TradingApi } from '@/api/trading/trading.js';
import { Effect, Exit } from 'effect';

let api: TradingApi;
let mockClient: { execute: ReturnType<typeof vi.fn> };

beforeEach(() => {
  mockClient = { execute: vi.fn() };
  api = new TradingApi(mockClient as unknown as TradingApiClient);
});

it('normalizes GetBestOffers across all listings with Active default', async () => {
  mockClient.execute.mockReturnValue(
    Effect.succeed({
      Ack: 'Success',
      ItemBestOffersArray: {
        ItemBestOffers: [
          {
            Item: [
              {
                ItemID: '111',
                Title: 'Signed jersey',
                BuyItNowPrice: { '#text': 545, '@_currencyID': 'USD' },
              },
            ],
            BestOfferArray: {
              BestOffer: {
                BestOfferID: 999,
                Buyer: { UserID: 'buyer1', FeedbackScore: 42 },
                Price: { '#text': 470, '@_currencyID': 'USD' },
                Quantity: 1,
                ExpirationTime: '2026-10-11T05:00:00.000Z',
                Status: 'Pending',
                BuyerMessage: 'Hi',
              },
            },
          },
        ],
      },
    }),
  );

  const result = await Effect.runPromise(api.getBestOffers());

  expect(mockClient.execute).toHaveBeenCalledWith('GetBestOffers', {
    BestOfferStatus: 'Active',
    DetailLevel: 'ReturnAll',
    Pagination: { EntriesPerPage: 25, PageNumber: 1 },
  });
  expect(result.offers).toEqual([
    {
      itemId: '111',
      title: 'Signed jersey',
      listPrice: 545,
      listCurrency: 'USD',
      bestOfferId: '999',
      buyerUserId: 'buyer1',
      buyerFeedbackScore: 42,
      price: 470,
      currency: 'USD',
      quantity: 1,
      expirationTime: '2026-10-11T05:00:00.000Z',
      status: 'Pending',
      buyerMessage: 'Hi',
    },
  ]);
});

it('returns empty offers when none are pending', async () => {
  mockClient.execute.mockReturnValue(Effect.succeed({ Ack: 'Success' }));
  const result = await Effect.runPromise(api.getBestOffers({ itemId: '111' }));
  expect(result.count).toBe(0);
  expect(mockClient.execute.mock.calls[0][1].ItemID).toBe('111');
});

it('sends RespondToBestOffer accept with multiple IDs and seller message', async () => {
  mockClient.execute.mockReturnValue(Effect.succeed({ Ack: 'Success' }));
  await Effect.runPromise(
    api.respondToBestOffer({
      itemId: '111',
      bestOfferIds: ['1', '2'],
      action: 'Accept',
      sellerResponse: 'Thanks & enjoy <3',
    }),
  );
  expect(mockClient.execute).toHaveBeenCalledWith('RespondToBestOffer', {
    ItemID: '111',
    BestOfferID: ['1', '2'],
    Action: 'Accept',
    SellerResponse: 'Thanks & enjoy <3',
  });
});

it('requires counterOfferPrice and a single ID for Counter', async () => {
  const missingPrice = await Effect.runPromiseExit(
    api.respondToBestOffer({ itemId: '111', bestOfferIds: ['1'], action: 'Counter' }),
  );
  expect(Exit.isFailure(missingPrice)).toBe(true);
  const multi = await Effect.runPromiseExit(
    api.respondToBestOffer({
      itemId: '111',
      bestOfferIds: ['1', '2'],
      action: 'Counter',
      counterOfferPrice: 500,
    }),
  );
  expect(Exit.isFailure(multi)).toBe(true);
  expect(mockClient.execute).not.toHaveBeenCalled();
});

it('rejects a missing action', async () => {
  const exit = await Effect.runPromiseExit(
    api.respondToBestOffer({ itemId: '111', bestOfferIds: ['1'] } as never),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  expect(mockClient.execute).not.toHaveBeenCalled();
});

it('formats counter price with currency attribute', async () => {
  mockClient.execute.mockReturnValue(Effect.succeed({ Ack: 'Success' }));
  await Effect.runPromise(
    api.respondToBestOffer({
      itemId: '111',
      bestOfferIds: ['1'],
      action: 'Counter',
      counterOfferPrice: 495,
    }),
  );
  expect(mockClient.execute.mock.calls[0][1].CounterOfferPrice).toEqual({
    '#text': '495.00',
    '@_currencyID': 'USD',
  });
});

it('treats eBay 20140 Best Offers Not Found as an empty result', async () => {
  const { EbayApiError } = await import('@/api/shared/request.js');
  const { TradingApiFailure } = await import('@/api/client/tradingApiFailure.js');
  mockClient.execute.mockReturnValue(
    Effect.fail(
      new EbayApiError({
        method: 'POST',
        path: '/ws/api.dll',
        cause: new TradingApiFailure({
          callName: 'GetBestOffers',
          path: '/ws/api.dll',
          message: 'Best Offers Not Found.',
          cause: [{ ErrorCode: 20_140, ShortMessage: 'Best Offers Not Found.' }],
        }),
      }),
    ),
  );
  const result = await Effect.runPromise(api.getBestOffers({ itemId: '111' }));
  expect(result.count).toBe(0);
});
