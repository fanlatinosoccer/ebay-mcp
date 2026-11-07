import { clientRequestError } from '@/api/client/ebayClientRequestError.js';
import { EbayApiError, EndpointInputError } from '@/api/shared/request.js';
import { ToolInputError } from '@/tools/defineTool.js';
import {
  buildSellerOfferFailureDiagnostic,
  formatSellerOfferToolFailure,
  sanitizeSellerOfferRequest,
} from '@/utils/communication/sellerOfferFailureDiagnostic.js';
import { HttpError } from '@/utils/http.js';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

const sellerMessage = 'Hello mmam3866, reach me at seller@example.com or 555-867-5309';
const buyerName = 'mmam3866';
const offerUrl = 'https://api.sandbox.ebay.com/sell/negotiation/v1/send_offer_to_interested_buyers';

const offerRequest = {
  message: sellerMessage,
  buyer: { username: buyerName, email: 'buyer@example.com', phone: '555-111-2222' },
  authorization: 'Bearer request-token',
  allowCounterOffer: false,
  marketplaceId: 'EBAY_US',
  offerDuration: { unit: 'DAY', value: 4, note: sellerMessage },
  offeredItems: [
    {
      listingId: '318323716479',
      quantity: 1,
      discountPercentage: 'contact mmam3866',
      price: { currency: 'USD', value: '200.00', token: 'price-token' },
      message: sellerMessage,
    },
  ],
};

const conflictBody = {
  errors: [
    {
      errorId: 25_002,
      domain: 'API_NEGOTIATION',
      category: 'REQUEST',
      message: `Offer already sent to ${buyerName}. Bearer body-token`,
      longMessage: `Buyer ${buyerName} already has this offer. ${sellerMessage}`,
      parameters: [
        { name: 'buyer', value: buyerName },
        { name: 'offerDuration', value: '4' },
        { name: 'accessToken', value: 'parameter-token' },
      ],
      subdomain: 'should-not-be-copied',
    },
  ],
  access_token: 'body-access-token',
  debug: { password: 'nested-password', buyer: buyerName },
};

const httpConflict = new HttpError('Request failed with status 409', {
  url: offerUrl,
  status: 409,
  statusText: 'Conflict',
  data: conflictBody,
  headers: {
    rlogid: 'rlog%7Eid-safe',
    'X-EBAY-C-REQUEST-ID': 'req-conflict',
    authorization: 'Bearer header-token',
    'set-cookie': 'sid=cookie-secret',
    'x-ebay-api-iaf-token': 'iaf-secret',
    'x-ebay-c-ratelimit-remaining': '99',
  },
});

const wrappedConflict = new EbayApiError({
  method: 'POST',
  path: '/sell/negotiation/v1/send_offer_to_interested_buyers',
  cause: clientRequestError({
    kind: 'httpStatus',
    method: 'POST',
    url: offerUrl,
    status: 409,
    message: `eBay API Error: conflict | response: ${JSON.stringify(conflictBody)}`,
    cause: httpConflict,
  }),
});

const forbidden = [
  sellerMessage,
  buyerName,
  'seller@example.com',
  'buyer@example.com',
  '555-867-5309',
  '555-111-2222',
  'request-token',
  'body-token',
  'parameter-token',
  'body-access-token',
  'nested-password',
  'header-token',
  'cookie-secret',
  'iaf-secret',
  'price-token',
  'should-not-be-copied',
  '| response:',
];

const assertPrivate = (value: unknown) => {
  const serialized = JSON.stringify(value);
  for (const secret of forbidden) {
    expect(serialized).not.toContain(secret);
  }
};

const asFiberFailure = async (error: unknown): Promise<unknown> => {
  try {
    await Effect.runPromise(Effect.fail(error));
  } catch (caught) {
    return caught;
  }
  throw new Error('expected Effect failure');
};

describe('seller-offer failure diagnostic', () => {
  it('retains a 409 identity, correlation ids, and the safe request', async () => {
    const caught = await asFiberFailure(wrappedConflict);
    const diagnostic = buildSellerOfferFailureDiagnostic(caught, offerRequest);

    expect(diagnostic).toMatchObject({
      origin: 'upstream',
      failureKind: 'httpStatus',
      status: 409,
      errors: [
        {
          errorId: 25_002,
          domain: 'API_NEGOTIATION',
          category: 'REQUEST',
          parameterNames: ['buyer', 'offerDuration'],
        },
      ],
      requestIds: {
        rlogid: 'rlog%7Eid-safe',
        'x-ebay-c-request-id': 'req-conflict',
      },
      request: {
        marketplaceId: 'EBAY_US',
        allowCounterOffer: false,
        duration: { unit: 'DAY', value: 4 },
        offeredItems: [
          {
            listingId: '318323716479',
            quantity: 1,
            price: { currency: 'USD', value: '200.00' },
          },
        ],
      },
    });
    expect(diagnostic.summary).toBe('Seller offer failed with HTTP 409');
    expect(diagnostic.upstreamMessage).toBe('omitted');
    expect(diagnostic.errors?.[0]).not.toHaveProperty('message');
    expect(diagnostic.request?.duration?.value).toBe(4);
    expect(JSON.stringify(diagnostic)).not.toContain('"details"');
    assertPrivate(diagnostic);
  });

  it('exposes the diagnostic from the tool formatter without a raw details dump', async () => {
    const caught = await asFiberFailure(wrappedConflict);
    const failure = formatSellerOfferToolFailure(caught, offerRequest);
    const text = failure.result.content[0]?.text ?? '';
    const parsed = JSON.parse(text) as {
      error: string;
      status: number;
      details?: unknown;
      diagnostic: { status: number };
    };

    expect(failure.result.isError).toBe(true);
    expect(parsed.status).toBe(409);
    expect(parsed.diagnostic.status).toBe(409);
    expect(parsed.details).toBeUndefined();
    expect(parsed.error).toBe(failure.log.diagnostic.summary);
    assertPrivate(text);
    assertPrivate(failure.log);
  });

  it('records other upstream statuses and drops unsafe duration text', () => {
    const badRequest = buildSellerOfferFailureDiagnostic(
      new HttpError('Request failed with status 400', {
        url: offerUrl,
        status: 400,
        data: {
          errors: [
            {
              errorId: 25_001,
              domain: 'API_NEGOTIATION',
              category: 'REQUEST',
              message: 'Listing 318323716479 is not eligible',
            },
          ],
        },
        headers: { rlogid: 'rlog-400' },
      }),
      {
        offerDuration: { unit: 'please email seller@example.com', value: '4' },
        offeredItems: [{ listingId: 'not-a-listing', price: { currency: 'usd', value: 'free' } }],
      },
    );
    const serverError = buildSellerOfferFailureDiagnostic(
      clientRequestError({
        kind: 'httpStatus',
        method: 'POST',
        url: offerUrl,
        status: 500,
        message: 'eBay API Error: unavailable',
        cause: new HttpError('Request failed with status 500', {
          url: offerUrl,
          status: 500,
          data: {
            errors: [{ errorId: 25_000, domain: 'API_NEGOTIATION', message: 'Unavailable' }],
          },
          headers: {},
        }),
      }),
      offerRequest,
    );

    expect(badRequest).toMatchObject({
      origin: 'upstream',
      status: 400,
      summary: 'Seller offer failed with HTTP 400',
      upstreamMessage: 'omitted',
      errors: [{ errorId: 25_001 }],
      requestIds: { rlogid: 'rlog-400' },
    });
    expect(badRequest.request?.duration).toBeUndefined();
    expect(badRequest.request?.offeredItems).toBeUndefined();
    expect(JSON.stringify(badRequest)).not.toContain('318323716479');
    expect(JSON.stringify(badRequest)).not.toContain('not eligible');
    expect(JSON.stringify(serverError).toLowerCase()).not.toContain('unavailable');
    expect(serverError).toMatchObject({
      origin: 'upstream',
      failureKind: 'httpStatus',
      status: 500,
      summary: 'Seller offer failed with HTTP 500',
      upstreamMessage: 'omitted',
      errors: [{ errorId: 25_000 }],
    });
    assertPrivate(badRequest);
    assertPrivate(serverError);
  });

  it('omits unstructured bodies instead of copying them', () => {
    const html = buildSellerOfferFailureDiagnostic(
      new HttpError('Request failed with status 409', {
        url: offerUrl,
        status: 409,
        data: `<html>${sellerMessage} bearer html-token</html>`,
        headers: { 'x-request-id': 'req-html' },
      }),
      offerRequest,
    );
    const unrecognized = buildSellerOfferFailureDiagnostic(
      new HttpError('Request failed with status 409', {
        url: offerUrl,
        status: 409,
        data: {
          error: 'invalid_token',
          access_token: 'oauth-secret',
          error_description: sellerMessage,
        },
        headers: { 'x-correlation-id': 'corr-1' },
      }),
      offerRequest,
    );

    expect(html.unstructuredBody).toBe('non-object');
    expect(html.errors).toBeUndefined();
    expect(html.requestIds).toEqual({ 'x-request-id': 'req-html' });
    expect(unrecognized.unstructuredBody).toBe('unrecognized');
    expect(JSON.stringify(unrecognized)).not.toContain('oauth-secret');
    assertPrivate(html);
    assertPrivate(unrecognized);
  });

  it('marks validation and transport failures as internal and does not invent a status', () => {
    const validation = buildSellerOfferFailureDiagnostic(
      new EndpointInputError({ parameter: 'input', message: `input is required ${sellerMessage}` }),
      offerRequest,
    );
    const toolInput = buildSellerOfferFailureDiagnostic(
      new ToolInputError({
        toolName: 'ebay_send_offer_to_interested_buyers',
        message: 'Invalid arguments',
      }),
      offerRequest,
    );
    const transport = buildSellerOfferFailureDiagnostic(
      clientRequestError({
        kind: 'transport',
        method: 'POST',
        url: offerUrl,
        message: 'Request timed out',
        cause: new HttpError('timed out', { url: offerUrl, headers: {}, isTimeout: true }),
      }),
      offerRequest,
    );
    const refresh = buildSellerOfferFailureDiagnostic(
      clientRequestError({
        kind: 'tokenRefresh',
        method: 'POST',
        url: offerUrl,
        status: 401,
        message: 'Invalid access token. Token refresh failed.',
        cause: new HttpError('Request failed with status 401', {
          url: offerUrl,
          status: 401,
          data: {
            errors: [
              {
                message: `token rejected for ${buyerName}`,
                parameters: [{ name: 'buyer', value: buyerName }],
              },
            ],
          },
          headers: { rlogid: 'rlog-401' },
        }),
      }),
      offerRequest,
    );
    const proseOnly = buildSellerOfferFailureDiagnostic(
      { message: 'seller-offer API 409' },
      offerRequest,
    );

    expect(validation.origin).toBe('internal');
    expect(validation.status).toBeUndefined();
    expect(validation.summary).toBe('Seller offer failed before the request was sent');
    expect(validation.upstreamMessage).toBe('omitted');
    expect(toolInput).toMatchObject({
      origin: 'internal',
      summary: 'Seller offer failed before the request was sent',
      upstreamMessage: 'omitted',
    });
    expect(transport).toMatchObject({
      origin: 'internal',
      failureKind: 'transport',
      summary: 'Seller offer failed before a response was received',
    });
    expect(transport.status).toBeUndefined();
    expect(refresh).toMatchObject({
      origin: 'internal',
      failureKind: 'tokenRefresh',
      status: 401,
      summary: 'Seller offer failed with HTTP 401',
    });
    expect(proseOnly.status).toBeUndefined();
    expect(proseOnly.origin).toBeUndefined();
    expect(proseOnly.summary).toBe('Seller offer failed');
    expect(JSON.stringify(proseOnly)).not.toContain('seller-offer API 409');
    assertPrivate(validation);
    assertPrivate(refresh);
  });

  it('bounds nested, repeated, and circular payloads', () => {
    const parameters = [
      { name: 'listingId', value: '318323716479' },
      { name: 'api_key', value: 'super-secret-key' },
      ...Array.from({ length: 20 }, (_, index) => ({
        name: `extra${index}`,
        value: `secret-value-${index}-${buyerName}`,
      })),
    ];
    let nested: Record<string, unknown> = { password: 'deep-secret', message: sellerMessage };
    for (let depth = 0; depth < 20; depth += 1) {
      nested = { child: nested };
    }
    const circular: Record<string, unknown> = { listingId: '318323716479' };
    circular.self = circular;
    const offeredItems = Array.from({ length: 20 }, () => circular);
    const diagnostic = buildSellerOfferFailureDiagnostic(
      new HttpError('Request failed with status 409', {
        url: offerUrl,
        status: 409,
        data: {
          errors: [
            { errorId: 1, message: 'x'.repeat(10_000), parameters, nested },
            ...Array.from({ length: 20 }, (_, index) => ({ errorId: index + 2, message: 'extra' })),
          ],
        },
        headers: {
          rlogid: `Bearer ${'a'.repeat(80)}`,
          'x-ebay-c-request-id': 'req-bounded',
          'x-ebay-request-id': 'second-id',
          'x-correlation-id': 'third-id',
          'x-request-id': 'fourth-id',
          'x-ebay-correlation-id': 'fifth-id-not-kept',
        },
      }),
      { message: sellerMessage, offeredItems, offerDuration: { unit: 'DAY', value: 4 } },
    );

    expect(diagnostic.errors).toHaveLength(5);
    expect(diagnostic.errors?.[0]?.parameterNames).toEqual([
      'listingId',
      'extra0',
      'extra1',
      'extra2',
      'extra3',
      'extra4',
      'extra5',
    ]);
    expect(diagnostic.errors?.[0]).not.toHaveProperty('message');
    expect(diagnostic.summary).toBe('Seller offer failed with HTTP 409');
    expect(diagnostic.requestIds).toEqual({
      'x-ebay-c-request-id': 'req-bounded',
      'x-ebay-request-id': 'second-id',
      'x-ebay-correlation-id': 'fifth-id-not-kept',
      'x-correlation-id': 'third-id',
    });
    expect(diagnostic.request?.offeredItems).toHaveLength(4);
    expect(diagnostic.request?.duration).toEqual({ unit: 'DAY', value: 4 });
    assertPrivate(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toContain('deep-secret');
    expect(JSON.stringify(diagnostic)).not.toContain('secret-value-1');
    expect(JSON.stringify(diagnostic)).not.toContain('super-secret-key');
  });

  it('omits a buyer handle that appears only in upstream prose and nested values', async () => {
    const novelHandle = 'qx7novelhandle';
    const nestedToken = 'nested-malicious-token';
    let nested: Record<string, unknown> = { handle: novelHandle, token: nestedToken };
    for (let depth = 0; depth < 8; depth += 1) {
      nested = { buyer: nested, message: `${novelHandle} at depth ${depth}` };
    }
    const httpError = new HttpError('Request failed with status 409', {
      url: offerUrl,
      status: 409,
      statusText: `Conflict ${novelHandle}`,
      data: {
        errors: [
          {
            errorId: 25_002,
            domain: 'API_NEGOTIATION',
            category: 'REQUEST',
            message: `Buyer ${novelHandle} cannot receive this offer`,
            longMessage: `Handle ${novelHandle} is not eligible`,
            parameters: [{ name: 'offerDuration', value: '4' }],
            nested,
          },
        ],
        leaked: nested,
      },
      headers: { rlogid: 'rlog-novel', 'x-ebay-c-request-id': 'req-novel' },
    });
    const request = {
      message: 'ordinary seller note',
      offerDuration: { unit: 'DAY', value: 4 },
      offeredItems: [{ listingId: '318323716479', price: { currency: 'USD', value: '200.00' } }],
    };
    const caught = await asFiberFailure(
      new EbayApiError({
        method: 'POST',
        path: '/sell/negotiation/v1/send_offer_to_interested_buyers',
        cause: clientRequestError({
          kind: 'httpStatus',
          method: 'POST',
          url: offerUrl,
          status: 409,
          message: `eBay API Error: Handle ${novelHandle} is not eligible | response: ${JSON.stringify(httpError.data)}`,
          cause: httpError,
        }),
      }),
    );
    const diagnostic = buildSellerOfferFailureDiagnostic(caught, request);
    const failure = formatSellerOfferToolFailure(caught, request);
    const serialized = JSON.stringify({
      diagnostic,
      result: failure.result,
      log: failure.log,
    });

    expect(diagnostic).toMatchObject({
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
          parameterNames: ['offerDuration'],
        },
      ],
      requestIds: { rlogid: 'rlog-novel', 'x-ebay-c-request-id': 'req-novel' },
      request: {
        duration: { unit: 'DAY', value: 4 },
        offeredItems: [{ listingId: '318323716479', price: { currency: 'USD', value: '200.00' } }],
      },
    });
    expect(serialized).not.toContain(novelHandle);
    expect(serialized).not.toContain(nestedToken);
    expect(serialized).not.toContain('ordinary seller note');
    expect(serialized).not.toContain('| response:');
    expect(failure.result.content[0]?.text).toContain('Seller offer failed with HTTP 409');
  });

  it('keeps a numeric discount and drops a non-scalar one', () => {
    expect(
      sanitizeSellerOfferRequest({
        offeredItems: [{ listingId: '318323716479', discountPercentage: '5' }],
      })?.offeredItems?.[0],
    ).toEqual({ listingId: '318323716479', discountPercentage: '5' });
    expect(
      sanitizeSellerOfferRequest({
        message: sellerMessage,
        offeredItems: [{ discountPercentage: '5 percent off for mmam3866' }],
      }),
    ).toBeUndefined();
  });
});
