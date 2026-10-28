import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import { EbaySellerApi } from '@/api/ebaySellerApi.js';
import { getEbayConfig, mcpConfig } from '@/config/environment.js';
import { resolveToolGatingMode } from '@/config/toolFamilies.js';
import { isReadOnlyModeEnabled, isReadOnlyTool } from '@/mcp/readOnlyFilter.js';
import { applyToolListFilter, getToolListConfig } from '@/mcp/toolListFilter.js';
import {
  createToolGatingController,
  DYNAMIC_MODE_INSTRUCTIONS,
  registerMetaTools,
  toolNamesInFamilies,
} from '@/mcp/toolGating.js';
import { buildUiToolResult, createUiBridge, type UiBridge } from '@/mcp/uiBridge.js';
import { getToolEntries, type ToolEntry } from '@/tools/registry.js';
import { getEbayErrorDetails } from '@/utils/errors.js';
import { serverLogger, toolLogger } from '@/utils/logger.js';
import { Effect } from 'effect';

type ToolArgs = Record<string, unknown>;

/**
 * Optional dependencies and metadata for constructing the eBay MCP runtime.
 */
export interface EbayMcpRuntimeOptions {
  /** Optional prebuilt API facade, mainly for tests. */
  api?: EbaySellerApi;
  /** Optional MCP implementation metadata advertised during initialize. */
  serverConfig?: Implementation;
  /** Enables debug/error logs for each tool call when true. */
  logToolExecution?: boolean;
}

/**
 * Initialized MCP server runtime and eBay API facade.
 */
export interface EbayMcpRuntime {
  /** eBay API facade shared by every registered tool handler. */
  api: EbaySellerApi;
  /** MCP server instance with eBay tools registered. */
  server: McpServer;
  /** Initializes credentials/token state before the server accepts real calls. */
  initializeApi(): Promise<void>;
}

function formatToolSuccess(handlerOutput: unknown) {
  // JSON.stringify(undefined) returns undefined (not a string), which produces an
  // invalid MCP content block and triggers client -32602 on empty-body 201/204s.
  const successDocument =
    handlerOutput === undefined || handlerOutput === null ? { status: 'success' } : handlerOutput;

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(successDocument, null, 2),
      },
    ],
  };
}

function formatToolFailure(error: unknown) {
  const { message, status, errors } = getEbayErrorDetails(error);
  const failureDocument: Record<string, unknown> = { error: message };
  if (status !== undefined) {
    failureDocument.status = status;
  }
  if (errors !== undefined) {
    failureDocument.details = errors;
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(failureDocument, null, 2),
      },
    ],
    isError: true,
  };
}

function registerTool(
  server: McpServer,
  api: EbaySellerApi,
  entry: ToolEntry,
  logToolExecution: boolean,
  ui: UiBridge,
): RegisteredTool {
  const { definition, handler } = entry;

  // Registered plainly (no UI `_meta`) so every host gets a working text tool by
  // default; the capability gate later flips `_meta.ui` on for UI-capable clients.
  const registered = server.registerTool(
    definition.name,
    {
      description: definition.description,
      inputSchema: definition.inputSchema,
      annotations: definition.annotations,
    },
    async (args: ToolArgs) => {
      if (logToolExecution) {
        toolLogger.debug(`Executing tool: ${definition.name}`, { args });
      }

      return await Effect.runPromise(
        Effect.tryPromise({
          try: async () => handler(api, args),
          catch: (error) => error,
        }).pipe(
          Effect.map((handlerOutput) => {
            if (logToolExecution) {
              toolLogger.debug(`Tool ${definition.name} completed successfully`);
            }

            if (entry.formatResult) {
              return entry.formatResult(handlerOutput, args);
            }

            return ui.shouldRender(entry)
              ? buildUiToolResult(entry.ui, handlerOutput)
              : formatToolSuccess(handlerOutput);
          }),
          Effect.catchAll((error) => {
            if (logToolExecution) {
              toolLogger.error(`Tool ${definition.name} failed`, {
                error: getEbayErrorDetails(error).message,
              });
            }

            return Effect.succeed(formatToolFailure(error));
          }),
        ),
      );
    },
  );

  ui.register(entry, registered);
  return registered;
}

/**
 * Resolves the tool catalogue after family, read-only, and name-level gates.
 *
 * Throws when `EBAY_FORBID_TOKEN_TOOLS` is set and a token-management tool would
 * still be registered. The HTTP app calls this before it listens so a bad
 * allowlist exits the process instead of failing the first session.
 *
 * @returns Tool entries that should be registered for this process.
 * @example
 * ```ts
 * const entries = selectToolEntries();
 * ```
 */
export const selectToolEntries = (): ToolEntry[] => {
  const mode = resolveToolGatingMode();
  const allEntries = getToolEntries();
  const familyNames = mode.kind === 'static' ? toolNamesInFamilies(mode.families) : undefined;
  let entries = familyNames
    ? allEntries.filter((entry) => familyNames.has(entry.definition.name))
    : allEntries;

  if (isReadOnlyModeEnabled()) {
    entries = entries.filter((entry) => isReadOnlyTool(entry.definition));
    serverLogger.info(`EBAY_READ_ONLY: filtered to ${entries.length} read-only tools`);
  }

  const listConfig = getToolListConfig();
  const before = entries.length;
  const result = applyToolListFilter(entries, listConfig);
  if (listConfig.allow || listConfig.deny.size > 0) {
    const allowSize = listConfig.allow ? listConfig.allow.size : 'unset';
    serverLogger.info(
      `EBAY_TOOL_ALLOWLIST/DENYLIST: ${result.entries.length} of ${before} tools kept (allowlist ${allowSize}, denylist ${listConfig.deny.size})`,
    );
  }
  if (result.unknownAllowed.length > 0) {
    serverLogger.warn(
      `EBAY_TOOL_ALLOWLIST names no loaded tool: ${result.unknownAllowed.join(', ')}`,
    );
  }
  if (result.unknownDenied.length > 0) {
    serverLogger.warn(
      `EBAY_TOOL_DENYLIST names no loaded tool: ${result.unknownDenied.join(', ')}`,
    );
  }
  if (listConfig.forbidTokenTools) {
    serverLogger.info('EBAY_FORBID_TOKEN_TOOLS: verified no token-management tools are loaded');
  }
  return result.entries;
};

/**
 * Create an MCP server runtime and register all eBay tool handlers.
 *
 * @param options - Optional runtime dependencies and metadata overrides.
 * @returns Initialized runtime wrapper containing the MCP server and API facade.
 *
 * @example
 * ```ts
 * const runtime = createEbayMcpRuntime({ logToolExecution: true });
 * await runtime.initializeApi();
 * ```
 */
export const createEbayMcpRuntime = (options: EbayMcpRuntimeOptions = {}): EbayMcpRuntime => {
  const api = options.api ?? new EbaySellerApi(getEbayConfig());
  const serverInfo = options.serverConfig ?? mcpConfig;
  const mode = resolveToolGatingMode();

  // Instructions are set only in dynamic mode so the agent knows the catalogue is
  // hidden behind the discovery tools; default/static modes keep the handshake
  // byte-for-byte unchanged (a bare single-arg construction).
  const server =
    mode.kind === 'dynamic'
      ? new McpServer(serverInfo, { instructions: DYNAMIC_MODE_INSTRUCTIONS })
      : new McpServer(serverInfo);

  const ui = createUiBridge(server, import.meta.url);

  // Family selection, EBAY_READ_ONLY, then the name-level allow/deny list.
  // Dynamic mode still registers the (possibly filtered) catalogue and disables
  // it below, before the transport connects.
  const entries = selectToolEntries();

  const handles = new Map<string, RegisteredTool>();
  for (const entry of entries) {
    handles.set(
      entry.definition.name,
      registerTool(server, api, entry, options.logToolExecution ?? false, ui),
    );
  }

  if (mode.kind === 'dynamic') {
    // Disable before `connect`: the SDK only emits `tools/listChanged` once the
    // transport is connected, so these flips are silent. The agent re-enables the
    // tools it needs via the meta-tools, which fire `listChanged` post-connect.
    for (const handle of handles.values()) {
      handle.disable();
    }
    registerMetaTools(server, createToolGatingController(handles));
    serverLogger.info(
      `Dynamic tool mode: ${handles.size} eBay tools hidden behind 3 discovery tools`,
    );
  } else if (mode.kind === 'static') {
    serverLogger.info(
      `Static tool mode: registered ${handles.size} tools from families: ${mode.families.join(', ')}`,
    );
  } else {
    serverLogger.info(`Registering ${handles.size} tools`);
  }

  // Install after registration so every UI-eligible tool is captured before the
  // gate can flip their metadata on a UI-capable client's `initialize`.
  ui.installCapabilityGate();

  return {
    api,
    server,
    async initializeApi() {
      await Effect.runPromise(api.initialize());
    },
  };
};
