import { getRequiredScopesForTool } from '@/auth/scopeUtils.js';
import { isReadOnlyTool } from '@/mcp/readOnlyFilter.js';
import { toolCategories } from '@/tools/categories/index.js';
import { getToolDefinitions } from '@/tools/index.js';
import { describe, expect, it } from 'vitest';

const POST_ORDER_TOOLS = [
  'ebay_search_post_order_returns',
  'ebay_get_post_order_return',
  'ebay_search_post_order_inquiries',
  'ebay_get_post_order_inquiry',
  'ebay_search_post_order_cases',
  'ebay_get_post_order_case',
] as const;

const PAYMENT_DISPUTE_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.payment.dispute';
const POST_ORDER_WRITE_NAME = /post_order.*(respond|refund|escalate|decide|appeal)/;

describe('Post-Order read tools', () => {
  const definitions = new Map(
    getToolDefinitions().map((definition) => [definition.name, definition]),
  );
  const fulfillment = toolCategories.find((category) => category.key === 'fulfillment');

  it.each(POST_ORDER_TOOLS)('%s is a read-only fulfillment tool', (name) => {
    const definition = definitions.get(name);

    expect(definition?.annotations?.readOnlyHint).toBe(true);
    expect(definition && isReadOnlyTool(definition)).toBe(true);
    expect(fulfillment?.entries.some((entry) => entry.definition.name === name)).toBe(true);
    expect(definition?.description).toContain('IAF');
    expect(getRequiredScopesForTool(name)).toBeNull();
  });

  it('keeps ebay_get_order JSON next to the visual card', () => {
    const orderTool = fulfillment?.entries.find(
      (entry) => entry.definition.name === 'ebay_get_order',
    );

    expect(orderTool?.ui?.includeHandlerJson).toBe(true);
  });

  it('does not register Post-Order write tools', () => {
    const names = [...definitions.keys()];
    expect(names.some((name) => POST_ORDER_WRITE_NAME.test(name))).toBe(false);
  });
});

describe('payment dispute scope', () => {
  it.each([
    'ebay_get_payment_dispute_summaries',
    'ebay_get_payment_dispute',
    'ebay_accept_payment_dispute',
  ])('%s requires sell.payment.dispute', (name) => {
    expect(getRequiredScopesForTool(name)).toMatchObject({
      requiredScopes: [PAYMENT_DISPUTE_SCOPE],
      minimumScope: PAYMENT_DISPUTE_SCOPE,
    });
  });
});
