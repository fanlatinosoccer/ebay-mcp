import { describe, expect, it } from 'vitest';
import {
  applyToolListFilter,
  getToolListConfig,
  TOKEN_MANAGEMENT_TOOL_NAMES,
} from '@/mcp/toolListFilter.js';
import { toolCategories } from '@/tools/categories/index.js';

const entries = (...names: string[]) => names.map((name) => ({ definition: { name } }));
const names = (list: { definition: { name: string } }[]) => list.map((e) => e.definition.name);

describe('getToolListConfig', () => {
  it('is a no-op when nothing is set', () => {
    const config = getToolListConfig({});
    expect(config.allow).toBeUndefined();
    expect(config.deny.size).toBe(0);
    expect(config.forbidTokenTools).toBe(false);
  });

  it('parses comma-separated lists with whitespace and empty items', () => {
    const config = getToolListConfig({
      EBAY_TOOL_ALLOWLIST: ' ebay_get_orders , ,ebay_revise_listing',
      EBAY_TOOL_DENYLIST: 'ebay_issue_refund',
      EBAY_FORBID_TOKEN_TOOLS: 'TRUE',
    });
    expect([...(config.allow ?? [])]).toEqual(['ebay_get_orders', 'ebay_revise_listing']);
    expect([...config.deny]).toEqual(['ebay_issue_refund']);
    expect(config.forbidTokenTools).toBe(true);
  });

  it('treats a blank allowlist as unset', () => {
    expect(getToolListConfig({ EBAY_TOOL_ALLOWLIST: '  ' }).allow).toBeUndefined();
  });
});

describe('applyToolListFilter', () => {
  const all = entries(
    'ebay_get_orders',
    'ebay_revise_listing',
    'ebay_issue_refund',
    'ebay_clear_tokens',
  );

  it('keeps only allowlisted tools and reports unknown names', () => {
    const result = applyToolListFilter(
      all,
      getToolListConfig({ EBAY_TOOL_ALLOWLIST: 'ebay_get_orders,ebay_typo' }),
    );
    expect(names(result.entries)).toEqual(['ebay_get_orders']);
    expect(result.unknownAllowed).toEqual(['ebay_typo']);
  });

  it('removes denylisted tools, and deny wins over allow', () => {
    const result = applyToolListFilter(
      all,
      getToolListConfig({
        EBAY_TOOL_ALLOWLIST: 'ebay_get_orders,ebay_issue_refund',
        EBAY_TOOL_DENYLIST: 'ebay_issue_refund',
      }),
    );
    expect(names(result.entries)).toEqual(['ebay_get_orders']);
  });

  it('refuses to start when a token tool would load with EBAY_FORBID_TOKEN_TOOLS', () => {
    expect(() =>
      applyToolListFilter(all, getToolListConfig({ EBAY_FORBID_TOKEN_TOOLS: 'true' })),
    ).toThrow(/ebay_clear_tokens/);
  });

  it('starts when the token tools are filtered out', () => {
    const result = applyToolListFilter(
      all,
      getToolListConfig({
        EBAY_FORBID_TOKEN_TOOLS: 'true',
        EBAY_TOOL_DENYLIST: 'ebay_clear_tokens',
      }),
    );
    expect(names(result.entries)).not.toContain('ebay_clear_tokens');
  });
});

describe('TOKEN_MANAGEMENT_TOOL_NAMES', () => {
  it('matches every tool in the token-management family', () => {
    const family = toolCategories.find((c) => c.key === 'token-management');
    expect(family).toBeDefined();
    const familyNames = new Set(family!.entries.map((e) => e.definition.name));
    expect(familyNames).toEqual(new Set(TOKEN_MANAGEMENT_TOOL_NAMES));
  });
});
