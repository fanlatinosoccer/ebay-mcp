import process from 'node:process';

/**
 * Name-level tool gating for deployments that need a precise tool surface
 * (e.g. a write-enabled Azure container that must never expose credential tools).
 *
 * Applied after `EBAY_MCP_TOOLS` (families) and `EBAY_READ_ONLY`:
 * - `EBAY_TOOL_ALLOWLIST`: comma-separated tool names; when set, only these load.
 * - `EBAY_TOOL_DENYLIST`: comma-separated tool names that never load.
 * - `EBAY_FORBID_TOKEN_TOOLS=true`: startup fails if any token-management tool
 *   survives the filters, so a misconfiguration can never expose them.
 */

/** Tools in the `token-management` family (credential and token handling). */
export const TOKEN_MANAGEMENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'ebay_get_oauth_url',
  'ebay_set_user_tokens',
  'ebay_set_user_tokens_with_expiry',
  'ebay_get_token_status',
  'ebay_clear_tokens',
  'ebay_validate_token_expiry',
  'ebay_convert_date_to_timestamp',
  'ebay_display_credentials',
  'ebay_refresh_access_token',
  'ebay_exchange_authorization_code',
]);

/** Parsed name-level gating configuration. */
export interface ToolListConfig {
  /** Allowed tool names, or `undefined` when no allowlist is set. */
  readonly allow?: ReadonlySet<string>;
  /** Denied tool names (empty when unset). */
  readonly deny: ReadonlySet<string>;
  /** Whether loading any token-management tool must abort startup. */
  readonly forbidTokenTools: boolean;
}

const parseList = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

const isTruthy = (raw: string | undefined): boolean => {
  const value = raw?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
};

/**
 * Reads `EBAY_TOOL_ALLOWLIST`, `EBAY_TOOL_DENYLIST` and `EBAY_FORBID_TOKEN_TOOLS`.
 *
 * @example
 * ```ts
 * getToolListConfig({ EBAY_TOOL_ALLOWLIST: 'ebay_get_orders, ebay_revise_listing' });
 * ```
 */
export const getToolListConfig = (env: NodeJS.ProcessEnv = process.env): ToolListConfig => {
  const allowRaw = env.EBAY_TOOL_ALLOWLIST;
  const allowNames = parseList(allowRaw);
  return {
    allow: allowRaw !== undefined && allowRaw.trim().length > 0 ? new Set(allowNames) : undefined,
    deny: new Set(parseList(env.EBAY_TOOL_DENYLIST)),
    forbidTokenTools: isTruthy(env.EBAY_FORBID_TOKEN_TOOLS),
  };
};

/** Result of {@link applyToolListFilter}. */
export interface ToolListFilterResult<T> {
  readonly entries: T[];
  /** Allowlisted names that matched no registered tool (likely typos). */
  readonly unknownAllowed: string[];
  /** Denylisted names that matched no registered tool. */
  readonly unknownDenied: string[];
}

/**
 * Filters tool entries by allowlist then denylist and enforces the token-tool guard.
 *
 * @throws Error when `forbidTokenTools` is set and a token-management tool remains.
 */
export const applyToolListFilter = <T extends { definition: { name: string } }>(
  entries: readonly T[],
  config: ToolListConfig,
): ToolListFilterResult<T> => {
  const present = new Set(entries.map((entry) => entry.definition.name));
  const filtered = entries.filter((entry) => {
    const name = entry.definition.name;
    if (config.allow && !config.allow.has(name)) return false;
    return !config.deny.has(name);
  });

  if (config.forbidTokenTools) {
    const leaked = filtered
      .map((entry) => entry.definition.name)
      .filter((name) => TOKEN_MANAGEMENT_TOOL_NAMES.has(name));
    if (leaked.length > 0) {
      throw new Error(
        `EBAY_FORBID_TOKEN_TOOLS is set but token-management tools would load: ${leaked.join(', ')}. Remove them from EBAY_TOOL_ALLOWLIST, add them to EBAY_TOOL_DENYLIST, or exclude the token-management family in EBAY_MCP_TOOLS.`,
      );
    }
  }

  return {
    entries: filtered,
    unknownAllowed: config.allow ? [...config.allow].filter((name) => !present.has(name)) : [],
    unknownDenied: [...config.deny].filter((name) => !present.has(name)),
  };
};
