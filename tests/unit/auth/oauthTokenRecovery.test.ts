import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Effect } from 'effect';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CredentialStoreError,
  DotEnvCredentialStore,
  type CredentialStore,
} from '@/auth/credentialSession.js';
import {
  EbayOAuthClient,
  EbayOAuthError,
  STORE_RELOAD_MIN_INTERVAL_MS,
  summarizeOAuthFailure,
} from '@/auth/oauth.js';
import type { EbayConfig } from '@/types/ebay.js';
import { HttpError } from '@/utils/http.js';
import { authLogger } from '@/utils/logger.js';

/**
 * Regression tests for the "403 forever" incident: a failed app-token mint at
 * startup wiped valid user tokens from memory and nothing ever reloaded them
 * from .env, so the process reported hasUserToken:false until restarted.
 */

const SANDBOX = 'https://api.sandbox.ebay.com';
const TOKEN_PATH = '/identity/v1/oauth2/token';

// Recognizable fake secrets; the log test asserts none of them leak.
const CLIENT_SECRET = 'SECRET-client-secret-value-9f2c';
const CONFIG_REFRESH = 'SECRET-config-refresh-v1-ab12';
const CONFIG_ACCESS = 'SECRET-config-access-v1-cd34';
const STORED_REFRESH = 'SECRET-stored-refresh-v2-ef56';
const STORED_ACCESS = 'SECRET-stored-access-v2-gh78';
const REFRESHED_ACCESS = 'SECRET-refreshed-access-ij90';
const RECOVERED_ACCESS = 'SECRET-recovered-access-kl12';
const APP_ACCESS = 'SECRET-app-access-mn34';
const BASIC_CREDENTIALS = Buffer.from(`test_client_id:${CLIENT_SECRET}`).toString('base64');
const ALL_SECRETS = [
  CLIENT_SECRET,
  CONFIG_REFRESH,
  CONFIG_ACCESS,
  STORED_REFRESH,
  STORED_ACCESS,
  REFRESHED_ACCESS,
  RECOVERED_ACCESS,
  APP_ACCESS,
  BASIC_CREDENTIALS,
];

const baseConfig: EbayConfig = {
  clientId: 'test_client_id',
  clientSecret: CLIENT_SECRET,
  environment: 'sandbox',
  redirectUri: 'https://localhost/callback',
};

type TokenBody = Record<string, string>;

const userTokenResponse = (accessToken: string, refreshToken?: string) => ({
  access_token: accessToken,
  token_type: 'Bearer',
  expires_in: 7200,
  ...(refreshToken ? { refresh_token: refreshToken, refresh_token_expires_in: 47_304_000 } : {}),
});

/** Mock the token endpoint for a refresh_token grant using a specific refresh token. */
const mockRefreshGrant = (refreshToken: string, status: number, body: object) =>
  nock(SANDBOX)
    .post(
      TOKEN_PATH,
      (b: TokenBody) => b.grant_type === 'refresh_token' && b.refresh_token === refreshToken,
    )
    .reply(status, body);

/** Mock the token endpoint for the client_credentials (app token) grant. */
const mockAppGrant = (status: number, body: object) =>
  nock(SANDBOX)
    .post(TOKEN_PATH, (b: TokenBody) => b.grant_type === 'client_credentials')
    .reply(status, body);

/** In-memory credential store standing in for .env. */
const createMemoryStore = (initial: Record<string, string> = {}) => {
  const data: Record<string, string> = { ...initial };
  const read = vi.fn(() => Effect.succeed({ ...data }));
  const write = vi.fn((updates: Record<string, string>) =>
    Effect.sync(() => {
      Object.assign(data, updates);
    }),
  );
  const store: CredentialStore = { read, write };
  return { store, data, read, write };
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe('EbayOAuthClient token recovery', () => {
  beforeEach(() => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    nock.cleanAll();
    nock.disableNetConnect();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  describe('initialize: app-token failure must not wipe user tokens', () => {
    it('keeps refreshed user tokens when the app token endpoint returns 500', async () => {
      const { store } = createMemoryStore();
      const client = new EbayOAuthClient({ ...baseConfig, refreshToken: CONFIG_REFRESH }, store);
      mockRefreshGrant(CONFIG_REFRESH, 200, userTokenResponse(REFRESHED_ACCESS, CONFIG_REFRESH));
      mockAppGrant(500, { error: 'server_error' });

      await run(client.initialize());

      expect(client.hasUserTokens()).toBe(true);
      expect(client.getTokenInfo().hasUserToken).toBe(true);
      expect(client.getTokenInfo().hasAppAccessToken).toBe(false);
      await expect(run(client.getAccessToken())).resolves.toBe(REFRESHED_ACCESS);
      expect(nock.isDone()).toBe(true);
    });

    it('keeps refreshed user tokens when the app token request has a network failure', async () => {
      const { store } = createMemoryStore();
      const client = new EbayOAuthClient({ ...baseConfig, refreshToken: CONFIG_REFRESH }, store);
      mockRefreshGrant(CONFIG_REFRESH, 200, userTokenResponse(REFRESHED_ACCESS, CONFIG_REFRESH));
      nock(SANDBOX)
        .post(TOKEN_PATH, (b: TokenBody) => b.grant_type === 'client_credentials')
        .replyWithError('socket hang up');

      await run(client.initialize());

      expect(client.getTokenInfo().hasUserToken).toBe(true);
      await expect(run(client.getAccessToken())).resolves.toBe(REFRESHED_ACCESS);
    });

    it('keeps refreshed user tokens when persisting the app token fails', async () => {
      const store: CredentialStore = {
        read: () => Effect.succeed({}),
        write: (updates) =>
          'EBAY_APP_ACCESS_TOKEN' in updates
            ? Effect.fail(
                new CredentialStoreError({
                  envPath: '/read-only/.env',
                  message: 'Failed to write',
                  cause: new Error('EACCES'),
                }),
              )
            : Effect.void,
      };
      const client = new EbayOAuthClient({ ...baseConfig, refreshToken: CONFIG_REFRESH }, store);
      mockRefreshGrant(CONFIG_REFRESH, 200, userTokenResponse(REFRESHED_ACCESS, CONFIG_REFRESH));
      mockAppGrant(200, { access_token: APP_ACCESS, token_type: 'Bearer', expires_in: 7200 });

      await run(client.initialize());

      expect(client.getTokenInfo().hasUserToken).toBe(true);
      await expect(run(client.getAccessToken())).resolves.toBe(REFRESHED_ACCESS);
    });
  });

  describe('reload from the credential store when user tokens are null or unusable', () => {
    it('reloads and refreshes user tokens from the store when none are in memory', async () => {
      const { store, read, data } = createMemoryStore({
        EBAY_USER_REFRESH_TOKEN: STORED_REFRESH,
        EBAY_USER_ACCESS_TOKEN: STORED_ACCESS,
      });
      const client = new EbayOAuthClient(baseConfig, store);
      expect(client.getTokenInfo().hasUserToken).toBe(false);
      mockRefreshGrant(STORED_REFRESH, 200, userTokenResponse(RECOVERED_ACCESS, STORED_REFRESH));

      await expect(run(client.getAccessToken())).resolves.toBe(RECOVERED_ACCESS);

      expect(read).toHaveBeenCalledTimes(1);
      expect(client.getTokenInfo().hasUserToken).toBe(true);
      expect(data.EBAY_USER_ACCESS_TOKEN).toBe(RECOVERED_ACCESS);
      expect(nock.isDone()).toBe(true);
    });

    it('recovers after a transient startup refresh failure cleared user tokens', async () => {
      const { store } = createMemoryStore({ EBAY_USER_REFRESH_TOKEN: CONFIG_REFRESH });
      const client = new EbayOAuthClient({ ...baseConfig, refreshToken: CONFIG_REFRESH }, store);
      mockRefreshGrant(CONFIG_REFRESH, 503, { error: 'temporarily_unavailable' });

      await run(client.initialize());
      expect(client.hasUserTokens()).toBe(false);

      mockRefreshGrant(CONFIG_REFRESH, 200, userTokenResponse(RECOVERED_ACCESS, CONFIG_REFRESH));
      await expect(run(client.getAccessToken())).resolves.toBe(RECOVERED_ACCESS);
      expect(client.getTokenInfo().hasUserToken).toBe(true);
    });

    it('picks up a refresh token rotated in the store by another process', async () => {
      const { store } = createMemoryStore({ EBAY_USER_REFRESH_TOKEN: STORED_REFRESH });
      const client = new EbayOAuthClient(baseConfig, store);
      // In-memory token is expired, and its refresh token was revoked.
      await run(
        client.setUserTokens(CONFIG_ACCESS, CONFIG_REFRESH, Date.now() - 1000, Date.now() + 1e9),
      );
      // setUserTokens persisted the old values; simulate another process rotating them.
      await run(store.write({ EBAY_USER_REFRESH_TOKEN: STORED_REFRESH }));
      mockRefreshGrant(CONFIG_REFRESH, 400, { error: 'invalid_grant' });
      mockRefreshGrant(STORED_REFRESH, 200, userTokenResponse(RECOVERED_ACCESS, STORED_REFRESH));

      await expect(run(client.getAccessToken())).resolves.toBe(RECOVERED_ACCESS);
      expect(nock.isDone()).toBe(true);
    });

    it('reloads when the in-memory refresh token is expired, and asks to re-authorize if the store cannot help', async () => {
      const { store } = createMemoryStore({ EBAY_USER_REFRESH_TOKEN: STORED_REFRESH });
      const client = new EbayOAuthClient(baseConfig, store);
      await run(
        client.setUserTokens(CONFIG_ACCESS, CONFIG_REFRESH, Date.now() - 1, Date.now() - 1),
      );
      await run(store.write({ EBAY_USER_REFRESH_TOKEN: STORED_REFRESH }));
      mockRefreshGrant(STORED_REFRESH, 200, userTokenResponse(RECOVERED_ACCESS, STORED_REFRESH));

      await expect(run(client.getAccessToken())).resolves.toBe(RECOVERED_ACCESS);

      const empty = createMemoryStore();
      const stale = new EbayOAuthClient(baseConfig, empty.store);
      await run(stale.setUserTokens(CONFIG_ACCESS, CONFIG_REFRESH, Date.now() - 1, Date.now() - 1));
      empty.read.mockImplementation(() => Effect.succeed({}));
      const error = await run(Effect.flip(stale.getAccessToken()));
      expect(error.message).toContain('User authorization expired');
    });

    it('falls back to the app token when the stored refresh token is also rejected', async () => {
      const { store } = createMemoryStore({ EBAY_USER_REFRESH_TOKEN: STORED_REFRESH });
      const client = new EbayOAuthClient(baseConfig, store);
      mockRefreshGrant(STORED_REFRESH, 400, { error: 'invalid_grant' });
      mockAppGrant(200, { access_token: APP_ACCESS, token_type: 'Bearer', expires_in: 7200 });

      await expect(run(client.getAccessToken())).resolves.toBe(APP_ACCESS);
      expect(client.getTokenInfo().hasUserToken).toBe(false);
    });

    it('rate limits store reloads so a revoked token cannot hammer the token endpoint', async () => {
      let now = 1_800_000_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const { store, read } = createMemoryStore({ EBAY_USER_REFRESH_TOKEN: STORED_REFRESH });
      const client = new EbayOAuthClient(baseConfig, store);
      const refreshAttempts = mockRefreshGrant(STORED_REFRESH, 400, { error: 'invalid_grant' });
      mockAppGrant(200, { access_token: APP_ACCESS, token_type: 'Bearer', expires_in: 7200 });

      await run(client.getAccessToken());
      await run(client.getAccessToken());
      await run(client.getAccessToken());
      expect(read).toHaveBeenCalledTimes(1);
      expect(refreshAttempts.isDone()).toBe(true);

      now += STORE_RELOAD_MIN_INTERVAL_MS + 1;
      mockRefreshGrant(STORED_REFRESH, 200, userTokenResponse(RECOVERED_ACCESS, STORED_REFRESH));
      await expect(run(client.getAccessToken())).resolves.toBe(RECOVERED_ACCESS);
      expect(read).toHaveBeenCalledTimes(2);
    });

    it('does not reload after an explicit clearAllTokens until new tokens are set', async () => {
      const { store, read } = createMemoryStore({ EBAY_USER_REFRESH_TOKEN: STORED_REFRESH });
      const client = new EbayOAuthClient(baseConfig, store);
      client.clearAllTokens();
      mockAppGrant(200, { access_token: APP_ACCESS, token_type: 'Bearer', expires_in: 7200 });

      await expect(run(client.getAccessToken())).resolves.toBe(APP_ACCESS);
      await expect(run(client.reloadUserTokensFromStore('manual'))).resolves.toBe(false);
      expect(read).not.toHaveBeenCalled();

      await run(client.setUserTokens(CONFIG_ACCESS, CONFIG_REFRESH));
      expect(client.getTokenInfo().hasUserToken).toBe(true);
    });

    it('treats a store without read() as non-recoverable (no crash)', async () => {
      const store: CredentialStore = { write: () => Effect.void };
      const client = new EbayOAuthClient(baseConfig, store);
      await expect(run(client.reloadUserTokensFromStore('manual'))).resolves.toBe(false);
    });

    it('returns false without network calls when the store has no refresh token', async () => {
      const { store } = createMemoryStore({});
      const client = new EbayOAuthClient(baseConfig, store);
      await expect(run(client.reloadUserTokensFromStore('manual'))).resolves.toBe(false);
      expect(nock.pendingMocks()).toEqual([]);
    });
  });

  describe('sanitized auth-state logging', () => {
    it('logs state transitions with booleans, expiries and error codes but never secret values', async () => {
      const calls: Array<{ level: string; message: string; meta: unknown }> = [];
      for (const level of ['info', 'warn', 'error', 'debug'] as const) {
        vi.spyOn(authLogger, level).mockImplementation((message, meta) => {
          calls.push({ level, message, meta });
        });
      }

      // 1) Startup: user refresh OK, app token fails (the incident path).
      const { store, data } = createMemoryStore({ EBAY_USER_REFRESH_TOKEN: STORED_REFRESH });
      const client = new EbayOAuthClient({ ...baseConfig, refreshToken: CONFIG_REFRESH }, store);
      mockRefreshGrant(CONFIG_REFRESH, 200, userTokenResponse(REFRESHED_ACCESS, CONFIG_REFRESH));
      mockAppGrant(500, { error: 'server_error', error_description: `bad ${APP_ACCESS}` });
      await run(client.initialize());

      // 2) Clear in-memory state, then a revoked refresh followed by store recovery.
      client.clearAllTokens();
      await run(
        client.setUserTokens(CONFIG_ACCESS, CONFIG_REFRESH, Date.now() - 1000, Date.now() + 1e9),
      );
      data.EBAY_USER_REFRESH_TOKEN = STORED_REFRESH;
      mockRefreshGrant(CONFIG_REFRESH, 400, {
        error: 'invalid_grant',
        error_description: `token ${CONFIG_REFRESH} revoked`,
      });
      mockRefreshGrant(STORED_REFRESH, 200, userTokenResponse(RECOVERED_ACCESS, STORED_REFRESH));
      await expect(run(client.getAccessToken())).resolves.toBe(RECOVERED_ACCESS);

      const serialized = JSON.stringify(calls);
      for (const secret of ALL_SECRETS) {
        expect(serialized).not.toContain(secret);
      }

      const events = calls
        .map((call) => (call.meta as { event?: string } | undefined)?.event)
        .filter(Boolean);
      expect(events).toEqual(
        expect.arrayContaining([
          'startup_user_loaded_from_config',
          'startup_user_refreshed',
          'startup_app_token_failed_user_tokens_kept',
          'tokens_cleared',
          'user_cleared_after_refresh_failure',
          'store_reload_recovered',
        ]),
      );

      const appFailure = calls.find(
        (call) =>
          (call.meta as { event?: string })?.event === 'startup_app_token_failed_user_tokens_kept',
      );
      expect(appFailure?.level).toBe('warn');
      expect(appFailure?.meta).toMatchObject({
        userLoaded: true,
        userAccessValid: true,
        appAccessValid: false,
        failure: { operation: 'getOrRefreshAppAccessToken', kind: 'http', httpStatus: 500 },
      });
      expect((appFailure?.meta as { userAccessExpiresAt: string }).userAccessExpiresAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T/,
      );

      const refreshFailure = calls.find(
        (call) => (call.meta as { event?: string })?.event === 'user_cleared_after_refresh_failure',
      );
      expect(refreshFailure?.meta).toMatchObject({
        failure: { kind: 'http', httpStatus: 400, oauthError: 'invalid_grant' },
      });

      // Meta keys must not contain "token"/"secret", otherwise the generic redactor
      // would blank them and the log would be useless for diagnosis.
      for (const call of calls) {
        if (call.meta && typeof call.meta === 'object' && 'event' in call.meta) {
          for (const key of Object.keys(call.meta)) {
            expect(key).not.toMatch(/token|secret/i);
          }
        }
      }
    });

    it('summarizeOAuthFailure keeps only operation, kind, status and a well-formed error code', () => {
      const httpFailure = new EbayOAuthError({
        operation: 'refreshUserToken',
        message: 'Failed',
        cause: new HttpError('Request failed', {
          url: `${SANDBOX}${TOKEN_PATH}`,
          status: 401,
          data: { error: `Bearer ${STORED_ACCESS}`, error_description: STORED_REFRESH },
        }),
      });
      expect(summarizeOAuthFailure(httpFailure)).toEqual({
        operation: 'refreshUserToken',
        kind: 'http',
        httpStatus: 401,
      });

      const timeout = new EbayOAuthError({
        operation: 'getOrRefreshAppAccessToken',
        message: 'Failed',
        cause: new HttpError('timeout', { url: SANDBOX, isTimeout: true }),
      });
      expect(summarizeOAuthFailure(timeout)).toEqual({
        operation: 'getOrRefreshAppAccessToken',
        kind: 'timeout',
      });

      const persistence = new EbayOAuthError({
        operation: 'refreshUserToken',
        message: 'Failed',
        cause: new CredentialStoreError({ envPath: '/x/.env', message: 'nope', cause: null }),
      });
      expect(summarizeOAuthFailure(persistence)).toEqual({
        operation: 'refreshUserToken',
        kind: 'persistence',
      });
    });
  });

  describe('DotEnvCredentialStore.read', () => {
    it('reads the configured .env fresh from disk and returns {} when it is missing', async () => {
      // The global test setup stubs read() so tests never see a real .env; use the real one here.
      vi.mocked(DotEnvCredentialStore.prototype.read).mockRestore();
      const dir = mkdtempSync(path.join(tmpdir(), 'ebay-store-read-'));
      try {
        const envPath = path.join(dir, '.env');
        const reader = new DotEnvCredentialStore(() => envPath);
        await expect(run(reader.read())).resolves.toEqual({});

        writeFileSync(envPath, 'EBAY_USER_REFRESH_TOKEN="v1#hash"\nOTHER=1\n', 'utf-8');
        await expect(run(reader.read())).resolves.toEqual({
          EBAY_USER_REFRESH_TOKEN: 'v1#hash',
          OTHER: '1',
        });

        writeFileSync(envPath, 'EBAY_USER_REFRESH_TOKEN="v2"\n', 'utf-8');
        await expect(run(reader.read())).resolves.toEqual({ EBAY_USER_REFRESH_TOKEN: 'v2' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
