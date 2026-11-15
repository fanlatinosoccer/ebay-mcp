import { Effect } from 'effect';
import { beforeEach, vi } from 'vitest';

/**
 * Test-wide guard: the OAuth client can reload user tokens from the project
 * `.env` (DotEnvCredentialStore.read). Tests must never pick up a developer's
 * real credentials, so every test starts with `read()` returning an empty store.
 * Tests that exercise the real reader restore the spy explicitly.
 *
 * The module is imported lazily inside the hook so a test file's own
 * `vi.mock(...)` calls (for example of `fs`) are already registered.
 */
beforeEach(async () => {
  const { DotEnvCredentialStore } = await import('@/auth/credentialSession.js');
  vi.spyOn(DotEnvCredentialStore.prototype, 'read').mockImplementation(() => Effect.succeed({}));
});
