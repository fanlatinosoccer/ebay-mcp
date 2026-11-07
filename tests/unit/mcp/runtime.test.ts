import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { getToolDefinitions } from '@/tools/index.js';

const mcpMock = vi.hoisted(() => ({
  close: vi.fn(),
  connect: vi.fn(),
  constructor: vi.fn(),
  registerTool: vi.fn(() => ({ update: vi.fn() })),
  registerResource: vi.fn(),
  getClientCapabilities: vi.fn(() => ({})),
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn(function (this: unknown, config) {
    mcpMock.constructor(config);
    // Mirror the McpServer surface the UI bridge touches: `registerResource` for
    // `ui://` views and the underlying `.server` for the capability gate.
    return {
      close: mcpMock.close,
      connect: mcpMock.connect,
      registerTool: mcpMock.registerTool,
      registerResource: mcpMock.registerResource,
      server: {
        oninitialized: undefined,
        getClientCapabilities: mcpMock.getClientCapabilities,
      },
    };
  }),
}));

describe('MCP runtime', () => {
  beforeEach(() => {
    mcpMock.constructor.mockClear();
    mcpMock.registerTool.mockClear();
    mcpMock.close.mockClear();
    mcpMock.connect.mockClear();
    mcpMock.registerResource.mockClear();
    mcpMock.getClientCapabilities.mockClear();
  });

  it('registers the shared tool registry on server construction', async () => {
    const { createEbayMcpRuntime } = await import('@/mcp/runtime.js');
    const api = {
      initialize: vi.fn(() => Effect.succeed(undefined)),
    };

    const runtime = createEbayMcpRuntime({
      api: api as never,
      serverConfig: { name: 'test-mcp', version: '0.0.0' },
    });

    expect(runtime.api).toBe(api);
    expect(mcpMock.constructor).toHaveBeenCalledWith({ name: 'test-mcp', version: '0.0.0' });
    expect(mcpMock.registerTool).toHaveBeenCalledTimes(getToolDefinitions().length);

    await runtime.initializeApi();
    expect(api.initialize).toHaveBeenCalledOnce();
  });

  it('formats empty-body success as non-empty MCP text (issue #151)', async () => {
    // JSON.stringify(undefined) is not a string; MCP clients reject that content block.
    expect(JSON.stringify(undefined, null, 2)).toBeUndefined();

    const { createEbayMcpRuntime } = await import('@/mcp/runtime.js');
    const createInventoryLocation = vi.fn(() => Effect.succeed(undefined));
    const api = {
      initialize: vi.fn(() => Effect.succeed(undefined)),
      inventory: { createInventoryLocation },
    };

    createEbayMcpRuntime({
      api: api as never,
      serverConfig: { name: 'test-mcp', version: '0.0.0' },
    });

    const createLocationCall = [...mcpMock.registerTool.mock.calls]
      .reverse()
      .find(([name]) => name === 'ebay_create_inventory_location');
    expect(createLocationCall).toBeDefined();
    const handler = createLocationCall?.[2] as (args: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;

    const createLocationResult = await handler({
      merchantLocationKey: 'WH1',
      body: {
        location: {
          address: {
            addressLine1: '1 Main',
            city: 'San Jose',
            stateOrProvince: 'CA',
            postalCode: '95125',
            country: 'US',
          },
        },
      },
    });

    expect(createLocationResult.content).toHaveLength(1);
    expect(createLocationResult.content[0]?.type).toBe('text');
    expect(typeof createLocationResult.content[0]?.text).toBe('string');
    expect(createLocationResult).not.toMatchObject({ isError: true });
    expect(JSON.parse(createLocationResult.content[0]!.text)).toEqual({ status: 'success' });
  });

  it('preserves structured eBay details for a failed registered tool call', async () => {
    const { createEbayMcpRuntime } = await import('@/mcp/runtime.js');
    const { EbayApiError } = await import('@/api/shared/request.js');
    const eBayErrors = [
      {
        errorId: 25_709,
        message: 'Invalid header',
        longMessage: 'Invalid value for header Accept-Language',
        parameters: [{ name: 'Accept-Language', value: '*' }],
      },
    ];
    const createInventoryLocation = vi.fn(() =>
      Effect.fail(
        new EbayApiError({
          method: 'POST',
          path: '/sell/inventory/v1/location/WH1',
          cause: { status: 400, data: { errors: eBayErrors } },
        }),
      ),
    );
    const api = {
      initialize: vi.fn(() => Effect.succeed(undefined)),
      inventory: { createInventoryLocation },
    };

    createEbayMcpRuntime({
      api: api as never,
      serverConfig: { name: 'test-mcp', version: '0.0.0' },
    });

    const createLocationCall = [...mcpMock.registerTool.mock.calls]
      .reverse()
      .find(([name]) => name === 'ebay_create_inventory_location');
    const handler = createLocationCall?.[2] as (args: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>;
    const failedCallResult = await handler({ merchantLocationKey: 'WH1', body: {} });
    const parsedError = JSON.parse(failedCallResult.content[0]?.text ?? '{}');

    expect(failedCallResult.isError).toBe(true);
    expect(parsedError).toEqual({
      error: 'Invalid value for header Accept-Language',
      status: 400,
      details: eBayErrors,
    });
  });

  it('returns a sanitized seller-offer diagnostic without the raw body', async () => {
    const { createEbayMcpRuntime } = await import('@/mcp/runtime.js');
    const { EbayApiError } = await import('@/api/shared/request.js');
    const { clientRequestError } = await import('@/api/client/ebayClientRequestError.js');
    const { HttpError } = await import('@/utils/http.js');
    const { toolLogger } = await import('@/utils/logger.js');
    const sellerMessage = 'Please contact mmam3866 at buyer@example.com';
    const novelHandle = 'qx7novelhandle';
    const httpError = new HttpError('Request failed with status 409', {
      url: 'https://api.sandbox.ebay.com/sell/negotiation/v1/send_offer_to_interested_buyers',
      status: 409,
      statusText: 'Conflict',
      data: {
        errors: [
          {
            errorId: 25_002,
            domain: 'API_NEGOTIATION',
            category: 'REQUEST',
            message: `Offer already sent to buyer ${novelHandle}`,
            longMessage: `Handle ${novelHandle} is nested in prose only`,
            parameters: [
              { name: novelHandle, value: 'mmam3866' },
              { name: 'accessToken', value: 'secret' },
            ],
          },
          {
            errorId: novelHandle,
            domain: novelHandle,
            category: novelHandle,
            parameters: [{ name: novelHandle, value: novelHandle }],
          },
        ],
        nested: { buyer: { handle: novelHandle, token: 'nested-secret-token' } },
      },
      headers: {
        rlogid: 'rlogid-runtime',
        'x-ebay-c-request-id': 'req-runtime',
        'x-request-id': 'x'.repeat(300),
        'x-buyer-handle': novelHandle,
        authorization: 'Bearer runtime-token',
        'set-cookie': 'sid=runtime-cookie',
      },
    });
    const sendOfferToInterestedBuyers = vi.fn(() =>
      Effect.fail(
        new EbayApiError({
          method: 'POST',
          path: '/sell/negotiation/v1/send_offer_to_interested_buyers',
          cause: clientRequestError({
            kind: 'httpStatus',
            method: 'POST',
            url: httpError.url,
            status: 409,
            message: `eBay API Error: conflict | response: ${JSON.stringify(httpError.data)}`,
            cause: httpError,
          }),
        }),
      ),
    );
    const errorSpy = vi.spyOn(toolLogger, 'error').mockImplementation(() => {});
    const debugSpy = vi.spyOn(toolLogger, 'debug').mockImplementation(() => {});

    createEbayMcpRuntime({
      api: {
        initialize: vi.fn(() => Effect.succeed(undefined)),
        negotiation: { sendOfferToInterestedBuyers },
      } as never,
      serverConfig: { name: 'test-mcp', version: '0.0.0' },
      logToolExecution: true,
    });

    const offerCall = [...mcpMock.registerTool.mock.calls]
      .reverse()
      .find(([name]) => name === 'ebay_send_offer_to_interested_buyers');
    const handler = offerCall?.[2] as (args: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>;
    const args = {
      message: sellerMessage,
      buyer: { username: 'mmam3866', email: 'buyer@example.com' },
      authorization: 'Bearer args-token',
      allowCounterOffer: false,
      marketplaceId: 'EBAY_US',
      offerDuration: { unit: 'DAY', value: 4 },
      offeredItems: [
        {
          listingId: '318323716479',
          quantity: 1,
          price: { currency: 'USD', value: '200.00', token: 'price-token' },
        },
      ],
    };
    const failedCallResult = await handler(args);
    const text = failedCallResult.content[0]?.text ?? '';
    const parsedError = JSON.parse(text);

    expect(failedCallResult.isError).toBe(true);
    expect(parsedError).toMatchObject({
      status: 409,
      diagnostic: {
        origin: 'upstream',
        failureKind: 'httpStatus',
        status: 409,
        summary: 'Seller offer failed with HTTP 409',
        upstreamMessage: 'omitted',
        errors: [
          {
            errorId: 25_002,
            domain: 'API_NEGOTIATION',
            category: 'REQUEST',
            parameterNames: ['unrecognized'],
          },
          {
            domain: 'unrecognized',
            category: 'unrecognized',
            parameterNames: ['unrecognized'],
          },
        ],
        requestIds: { rlogid: 'rlogid-runtime', 'x-ebay-c-request-id': 'req-runtime' },
        request: {
          marketplaceId: 'EBAY_US',
          allowCounterOffer: false,
          duration: { unit: 'DAY', value: 4 },
          offeredItems: [
            { listingId: '318323716479', quantity: 1, price: { currency: 'USD', value: '200.00' } },
          ],
        },
      },
    });
    expect(parsedError.details).toBeUndefined();
    expect(parsedError.error).toBe('Seller offer failed with HTTP 409');
    expect(parsedError.diagnostic.errors[0]).not.toHaveProperty('message');
    expect(text).not.toContain(sellerMessage);
    expect(text).not.toContain(novelHandle);
    expect(text).not.toContain('x'.repeat(80));
    expect(text).not.toContain('mmam3866');
    expect(text).not.toContain('buyer@example.com');
    expect(text).not.toContain('runtime-token');
    expect(text).not.toContain('args-token');
    expect(text).not.toContain('price-token');
    expect(text).not.toContain('nested-secret-token');
    expect(text).not.toContain('runtime-cookie');
    expect(text).not.toContain('| response:');
    expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(sellerMessage);
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain('rlogid-runtime');
    expect(logged).not.toContain('mmam3866');
    expect(logged).not.toContain(novelHandle);
    expect(logged).not.toContain('x'.repeat(80));
    expect(logged).toContain('unrecognized');
    expect(logged).not.toContain('nested-secret-token');
    expect(logged).not.toContain('| response:');

    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });
});
