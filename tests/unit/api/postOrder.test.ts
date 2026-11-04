import type { EbayApiClient } from '@/api/client/ebayApiClient.js';
import { PostOrderApi } from '@/api/order-management/postOrder.js';
import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const iaf = (marketplaceId: string) => ({
  authorizationScheme: 'IAF',
  headers: { 'X-EBAY-C-MARKETPLACE-ID': marketplaceId },
});

describe('PostOrderApi', () => {
  const client = {
    get: vi.fn(),
    getConfig: vi.fn(),
  };
  const postOrder = new PostOrderApi(client as unknown as EbayApiClient);

  beforeEach(() => {
    vi.resetAllMocks();
    client.get.mockResolvedValue({ members: [] });
    client.getConfig.mockReturnValue({ environment: 'production', marketplaceId: 'EBAY_US' });
  });

  it('searches returns on the REST host with IAF auth and EBAY_US', async () => {
    const page = { members: [{ returnId: 'R-1', state: 'RETURN_REQUESTED' }], total: 1 };
    client.get.mockResolvedValue(page);

    expect(
      await Effect.runPromise(
        postOrder.searchReturns({
          returnState: 'RETURN_STARTED',
          role: 'SELLER',
          orderId: '12-345',
          limit: 25,
          offset: 0,
        }),
      ),
    ).toBe(page);

    expect(client.get).toHaveBeenCalledWith(
      '/post-order/v2/return/search',
      {
        return_state: 'RETURN_STARTED',
        role: 'SELLER',
        order_id: '12-345',
        limit: 25,
        offset: 0,
      },
      iaf('EBAY_US'),
    );
  });

  it('gets one return and encodes the id', async () => {
    await Effect.runPromise(postOrder.getReturn({ returnId: 'R/1' }));

    expect(client.get).toHaveBeenCalledWith(
      '/post-order/v2/return/R%2F1',
      undefined,
      iaf('EBAY_US'),
    );
  });

  it('searches INR and SNAD inquiries', async () => {
    await Effect.runPromise(
      postOrder.searchInquiries({
        inquiryStatus: 'WAITING_SELLER_RESPONSE',
        itemId: '123',
        transactionId: '456',
      }),
    );

    expect(client.get).toHaveBeenCalledWith(
      '/post-order/v2/inquiry/search',
      {
        inquiry_status: 'WAITING_SELLER_RESPONSE',
        item_id: '123',
        transaction_id: '456',
      },
      iaf('EBAY_US'),
    );
  });

  it('gets one inquiry', async () => {
    await Effect.runPromise(postOrder.getInquiry({ inquiryId: 'INQ-1' }));

    expect(client.get).toHaveBeenCalledWith(
      '/post-order/v2/inquiry/INQ-1',
      undefined,
      iaf('EBAY_US'),
    );
  });

  it('searches cases', async () => {
    await Effect.runPromise(
      postOrder.searchCases({
        caseStatusFilter: 'OPEN',
        returnId: 'R-9',
        caseCreationDateRangeFrom: '2025-01-01T00:00:00.000Z',
      }),
    );

    expect(client.get).toHaveBeenCalledWith(
      '/post-order/v2/casemanagement/search',
      {
        case_status_filter: 'OPEN',
        return_id: 'R-9',
        case_creation_date_range_from: '2025-01-01T00:00:00.000Z',
      },
      iaf('EBAY_US'),
    );
  });

  it('gets one case and encodes the id', async () => {
    await Effect.runPromise(postOrder.getCase({ caseId: 'C 1' }));

    expect(client.get).toHaveBeenCalledWith(
      '/post-order/v2/casemanagement/C%201',
      undefined,
      iaf('EBAY_US'),
    );
  });

  it('defaults the marketplace header to EBAY_US when none is configured', async () => {
    client.getConfig.mockReturnValue({ environment: 'sandbox' });

    await Effect.runPromise(postOrder.searchReturns());

    expect(client.get).toHaveBeenCalledWith(
      '/post-order/v2/return/search',
      undefined,
      iaf('EBAY_US'),
    );
  });

  it('prefers a per-call marketplace over the configured one', async () => {
    await Effect.runPromise(postOrder.getReturn({ returnId: 'R-1', marketplaceId: 'EBAY_DE' }));

    expect(client.get).toHaveBeenCalledWith('/post-order/v2/return/R-1', undefined, iaf('EBAY_DE'));
  });

  it('uses the configured marketplace when the call does not override it', async () => {
    client.getConfig.mockReturnValue({ environment: 'production', marketplaceId: 'EBAY_GB' });

    await Effect.runPromise(postOrder.getInquiry({ inquiryId: 'INQ-2' }));

    expect(client.get).toHaveBeenCalledWith(
      '/post-order/v2/inquiry/INQ-2',
      undefined,
      iaf('EBAY_GB'),
    );
  });

  it('fails with a tagged input error when the return id is blank', async () => {
    const error = await Effect.runPromise(Effect.flip(postOrder.getReturn({ returnId: ' ' })));

    expect(error._tag).toBe('EndpointInputError');
    expect(client.get).not.toHaveBeenCalled();
  });

  it('fails with EbayApiError carrying the relative path', async () => {
    client.get.mockRejectedValue(new Error('eBay API Error: Not found'));

    const error = await Effect.runPromise(Effect.flip(postOrder.getCase({ caseId: 'C-1' })));

    expect(error._tag).toBe('EbayApiError');
    expect(error).toMatchObject({ method: 'GET', path: '/post-order/v2/casemanagement/C-1' });
  });
});
