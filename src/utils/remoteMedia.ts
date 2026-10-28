import { isIP } from 'node:net';
import { Effect } from 'effect';
import {
  type LocalMediaFile,
  type LocalMediaKind,
  LocalMediaError,
  loadLocalMedia,
  MEDIA_POLICIES,
  mediaSignatureProblem,
} from './localMedia.js';
import type { MediaAccessConfig } from '@/config/mediaAccess.js';
import process from 'node:process';

/**
 * Remote media for containerised deployments that have no local files.
 *
 * Media tools accept, in addition to local paths / media:// references:
 * - `https://...` URLs (downloaded by the server; plain http, credentials in the URL,
 *   localhost and private/link-local IP literals are refused; redirects are not followed)
 * - `data:<mime>;base64,<payload>` URIs
 *
 * Both are validated with the same size limits and content-signature checks as
 * local files. Remote media is enabled by default and can be turned off with
 * `EBAY_MCP_REMOTE_MEDIA=false`.
 */

/** Environment variable that disables URL / data URI media when set to false/0/no. */
export const REMOTE_MEDIA_ENV = 'EBAY_MCP_REMOTE_MEDIA';

const DATA_URI = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.*)$/is;

const fail = (source: string, message: string) =>
  new LocalMediaError({ source: redact(source), message });

/** Keeps errors short and never echoes a whole base64 payload. */
const redact = (source: string): string =>
  source.startsWith('data:') ? `${source.slice(0, 40)}…` : source;

/** Whether remote media references are enabled. */
export const isRemoteMediaEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const raw = env[REMOTE_MEDIA_ENV]?.trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'no');
};

/** Whether a reference is a URL or data URI rather than a local path. */
export const isRemoteMediaReference = (source: string): boolean =>
  /^https?:\/\//i.test(source) || /^data:/i.test(source);

const isPrivateHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    return true;
  const family = isIP(host);
  if (family === 4) {
    const [a, b] = host.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (family === 6) {
    return (
      host === '::1' ||
      host === '::' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80') ||
      host.startsWith('::ffff:')
    );
  }
  return false;
};

const fileNameFor = (source: string, mimeType: string, index: number): string => {
  const ext = mimeType.split('/')[1]?.replace('quicktime', 'mov').replace('jpeg', 'jpg') ?? 'bin';
  if (source.startsWith('data:')) return `upload-${index}.${ext}`;
  try {
    const last = new URL(source).pathname.split('/').filter(Boolean).pop();
    return last && last.includes('.') ? decodeURIComponent(last) : `upload-${index}.${ext}`;
  } catch {
    return `upload-${index}.${ext}`;
  }
};

/** Maps a content type onto the MIME types the kind's policy accepts. */
const acceptedMime = (kind: LocalMediaKind, mimeType: string): string | undefined => {
  const allowed = new Set(Object.values(MEDIA_POLICIES[kind].types as Record<string, string>));
  const normalized = mimeType.toLowerCase().split(';')[0].trim();
  return allowed.has(normalized) ? normalized : undefined;
};

const finish = (
  source: string,
  kind: LocalMediaKind,
  declaredMime: string | undefined,
  bytes: Buffer,
  index: number,
): Effect.Effect<LocalMediaFile, LocalMediaError> => {
  const limit = MEDIA_POLICIES[kind].limit;
  if (bytes.length === 0) return Effect.fail(fail(source, 'media is empty'));
  if (bytes.length > limit) {
    return Effect.fail(
      fail(source, `${bytes.length} bytes exceeds eBay's ${kind} limit of ${limit} bytes`),
    );
  }
  const mimeType = declaredMime ? acceptedMime(kind, declaredMime) : undefined;
  if (!mimeType) {
    return Effect.fail(
      fail(source, `unsupported ${kind} content type "${declaredMime ?? 'unknown'}"`),
    );
  }
  const problem = mediaSignatureProblem(bytes, mimeType);
  if (problem) return Effect.fail(fail(source, problem));
  return Effect.succeed({
    source: redact(source),
    path: redact(source),
    fileName: fileNameFor(source, mimeType, index),
    mimeType,
    size: bytes.length,
    kind,
    bytes,
  });
};

/** Injectable fetch, for tests. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const loadRemote = (
  source: string,
  kind: LocalMediaKind,
  index: number,
  fetchImpl: FetchLike,
): Effect.Effect<LocalMediaFile, LocalMediaError> =>
  Effect.gen(function* () {
    const dataMatch = DATA_URI.exec(source);
    if (dataMatch) {
      const bytes = Buffer.from(dataMatch[2].replace(/\s+/g, ''), 'base64');
      return yield* finish(source, kind, dataMatch[1], bytes, index);
    }
    if (/^data:/i.test(source)) {
      return yield* Effect.fail(fail(source, 'data URIs must be data:<mime>;base64,<payload>'));
    }
    const url = yield* Effect.try({
      try: () => new URL(source),
      catch: () => fail(source, 'invalid URL'),
    });
    if (url.protocol !== 'https:')
      return yield* Effect.fail(fail(source, 'only https:// URLs are allowed'));
    if (url.username || url.password) {
      return yield* Effect.fail(fail(source, 'URLs with embedded credentials are not allowed'));
    }
    if (isPrivateHost(url.hostname)) {
      return yield* Effect.fail(
        fail(source, 'private, loopback and link-local hosts are not allowed'),
      );
    }
    const limit = MEDIA_POLICIES[kind].limit;
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(url.toString(), { redirect: 'error', signal: AbortSignal.timeout(60_000) }),
      catch: (error) =>
        fail(source, `download failed: ${error instanceof Error ? error.message : String(error)}`),
    });
    if (!response.ok)
      return yield* Effect.fail(fail(source, `download failed: HTTP ${response.status}`));
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > limit) {
      return yield* Effect.fail(
        fail(source, `${declaredLength} bytes exceeds eBay's ${kind} limit of ${limit} bytes`),
      );
    }
    const bytes = yield* Effect.tryPromise({
      try: async () => Buffer.from(await response.arrayBuffer()),
      catch: () => fail(source, 'download failed while reading the body'),
    });
    return yield* finish(
      source,
      kind,
      response.headers.get('content-type') ?? undefined,
      bytes,
      index,
    );
  });

/**
 * Loads one media reference: a local path / media:// (via {@link loadLocalMedia}),
 * an https:// URL, or a base64 data URI.
 *
 * @example
 * ```ts
 * await Effect.runPromise(loadMediaReference('https://cdn.example.com/front.jpg', 'image', access));
 * ```
 */
export const loadMediaReference = (
  source: string,
  kind: LocalMediaKind,
  access: MediaAccessConfig,
  options: { index?: number; fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Effect.Effect<LocalMediaFile, LocalMediaError> => {
  if (!isRemoteMediaReference(source)) return loadLocalMedia(source, kind, access);
  if (!isRemoteMediaEnabled(options.env)) {
    return Effect.fail(fail(source, `remote media is disabled (${REMOTE_MEDIA_ENV}=false)`));
  }
  return loadRemote(
    source,
    kind,
    options.index ?? 1,
    options.fetchImpl ?? (globalThis.fetch as FetchLike),
  );
};

/** Loads several references in order, failing on the first invalid one. */
export const loadMediaReferenceList = (
  sources: readonly string[],
  kind: LocalMediaKind,
  access: MediaAccessConfig,
  options: { fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Effect.Effect<LocalMediaFile[], LocalMediaError> =>
  Effect.forEach(sources, (source, i) =>
    loadMediaReference(source, kind, access, { ...options, index: i + 1 }),
  );
