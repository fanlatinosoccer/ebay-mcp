import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import type { MediaAccessConfig } from '@/config/mediaAccess.js';
import { Effect } from 'effect';
import {
  type LocalMediaFile,
  type LocalMediaKind,
  LocalMediaError,
  loadLocalMedia,
  MEDIA_POLICIES,
  mediaSignatureProblem,
  sniffMediaType,
} from './localMedia.js';

/**
 * Remote media for containerised deployments that have no local files.
 *
 * Media tools accept, in addition to local paths / media:// references:
 * - `https://...` URLs (downloaded by the server; plain http, credentials in the URL,
 *   localhost, and private/link-local addresses are refused, including hostnames that
 *   resolve to those addresses; redirects are not followed)
 * - `data:<mime>;base64,<payload>` URIs
 *
 * Both are validated with the same size limits and content-signature checks as
 * local files. Stored references drop userinfo and query strings so a signed URL
 * is not echoed back. Remote media is enabled by default and can be turned off
 * with `EBAY_MCP_REMOTE_MEDIA=false`.
 */

/** Environment variable that disables URL / data URI media when set to false/0/no. */
export const REMOTE_MEDIA_ENV = 'EBAY_MCP_REMOTE_MEDIA';

const DATA_URI = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.*)$/is;
const DNS_TIMEOUT_MS = 5000;

const MIME_ALIASES: Readonly<Record<string, string>> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
};

const GENERIC_CONTENT_TYPES = new Set([
  'application/octet-stream',
  'binary/octet-stream',
  'application/binary',
]);

/** Keeps errors short and never echoes a payload, userinfo, or query string. */
const redact = (source: string): string => {
  if (/^data:/i.test(source)) return `${source.slice(0, 40)}…`;
  if (!/^https?:\/\//i.test(source)) return source;
  try {
    const url = new URL(source);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return 'https://redacted';
  }
};

const fail = (source: string, message: string): LocalMediaError =>
  new LocalMediaError({ source: redact(source), message });

/** Whether remote media references are enabled. */
export const isRemoteMediaEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const raw = env[REMOTE_MEDIA_ENV]?.trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'no');
};

/** Whether a reference is a URL or data URI rather than a local path. */
export const isRemoteMediaReference = (source: string): boolean =>
  /^https?:\/\//i.test(source) || /^data:/i.test(source);

const normalizeHost = (hostname: string): string =>
  hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/g, '')
    .toLowerCase();

const isBlockedName = (host: string): boolean =>
  host === 'localhost' ||
  host === 'localhost.localdomain' ||
  host.endsWith('.localhost') ||
  host.endsWith('.local') ||
  host.endsWith('.internal');

const isPrivateIpv4 = (host: string): boolean => {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [a, b] = octets;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
};

/** First hextet of an IPv6 address, or `undefined` when the address starts with `::`. */
const firstHextet = (host: string): number | undefined => {
  if (host.startsWith('::')) return;
  const first = host.split(':')[0] ?? '';
  if (first.length === 0) return;
  const value = Number.parseInt(first, 16);
  return Number.isInteger(value) ? value : undefined;
};

/**
 * Private, loopback, link-local, and IPv4-mapped addresses.
 * Link-local is `fe80::/10` (fe80–febf), not only the `fe80` prefix.
 * Every `::ffff:` form is refused: Node rewrites dotted mapped addresses to hex.
 */
const isPrivateIp = (address: string): boolean => {
  const host = normalizeHost(address);
  if (host === '::1' || host === '::' || host.startsWith('::ffff:')) return true;
  const family = isIP(host);
  if (family === 4) return isPrivateIpv4(host);
  if (family === 6) {
    const first = firstHextet(host);
    if (first === undefined) return false;
    const uniqueLocal = first >= 0xfc_00 && first <= 0xfd_ff;
    const linkLocal = first >= 0xfe_80 && first <= 0xfe_bf;
    return uniqueLocal || linkLocal;
  }
  return false;
};

const isPrivateHost = (hostname: string): boolean => {
  const host = normalizeHost(hostname);
  return isBlockedName(host) || isPrivateIp(host);
};

const fileNameFor = (source: string, mimeType: string, index: number): string => {
  const ext = mimeType.split('/')[1]?.replace('quicktime', 'mov').replace('jpeg', 'jpg') ?? 'bin';
  const fallback = `upload-${index}.${ext}`;
  if (source.startsWith('data:')) return fallback;
  try {
    const last = new URL(source).pathname.split('/').filter(Boolean).pop();
    if (!last) return fallback;
    const base = decodeURIComponent(last).split(/[/\\]/).pop() ?? '';
    const cleaned = base.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '');
    return cleaned.includes('.') ? cleaned : fallback;
  } catch {
    return fallback;
  }
};

/** Maps a content type onto the MIME types the kind's policy accepts. */
const acceptedMime = (kind: LocalMediaKind, mimeType: string): string | undefined => {
  const allowed = new Set(
    Object.values(MEDIA_POLICIES[kind].types as Readonly<Record<string, string>>),
  );
  const normalized = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  const canonical = MIME_ALIASES[normalized] ?? normalized;
  return allowed.has(canonical) ? canonical : undefined;
};

/**
 * Prefers a specific Content-Type. Missing or generic types fall back to the
 * sniffed signature so a CDN that sends `application/octet-stream` still works.
 */
const chooseMime = (
  kind: LocalMediaKind,
  declared: string | undefined,
  bytes: Buffer,
): string | undefined => {
  const normalized = declared?.toLowerCase().split(';')[0]?.trim() ?? '';
  if (normalized.length > 0 && !GENERIC_CONTENT_TYPES.has(normalized)) {
    return acceptedMime(kind, normalized);
  }
  const sniffed = sniffMediaType(bytes);
  return sniffed ? acceptedMime(kind, sniffed) : undefined;
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
  const mimeType = chooseMime(kind, declaredMime, bytes);
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

/** Injectable DNS lookup. Returns every address the name resolves to. */
export type ResolveLike = (hostname: string) => Promise<readonly string[]>;

const defaultResolve: ResolveLike = async (hostname) => {
  const records = await Promise.race([
    lookup(hostname, { all: true, verbatim: true }),
    delay(DNS_TIMEOUT_MS, undefined, { ref: false }).then(() => {
      throw new Error('DNS lookup timed out');
    }),
  ]);
  return records.map((record) => record.address);
};

const asMediaError = (source: string, error: unknown, fallback: string): LocalMediaError =>
  error instanceof LocalMediaError ? error : fail(source, fallback);

const REDIRECT_ERROR = /redirect/i;

const downloadFailure = (source: string, error: unknown): LocalMediaError => {
  const text = error instanceof Error ? error.message : String(error);
  const fallback = REDIRECT_ERROR.test(text)
    ? 'download failed: redirects are not allowed'
    : 'download failed: request failed';
  return asMediaError(source, error, fallback);
};

const readLimitedBody = async (
  response: Response,
  source: string,
  kind: LocalMediaKind,
): Promise<Buffer> => {
  const limit = MEDIA_POLICIES[kind].limit;
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) {
      throw fail(source, `${bytes.length} bytes exceeds eBay's ${kind} limit of ${limit} bytes`);
    }
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    let next = await reader.read();
    while (!next.done) {
      const value = next.value;
      if (value) {
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel().catch(() => undefined);
          throw fail(source, `${total} bytes exceeds eBay's ${kind} limit of ${limit} bytes`);
        }
        chunks.push(value);
      }
      next = await reader.read();
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // cancel() may already have released the lock
    }
  }
  return Buffer.concat(chunks);
};

const rejectPrivateHost = (source: string): LocalMediaError =>
  fail(source, 'private, loopback and link-local hosts are not allowed');

const assertPublicDns = (
  source: string,
  hostname: string,
  resolveImpl: ResolveLike,
): Effect.Effect<void, LocalMediaError> => {
  const host = normalizeHost(hostname);
  if (isIP(host) !== 0) return Effect.void;
  return Effect.tryPromise({
    try: () => resolveImpl(host),
    catch: () => fail(source, 'download failed: could not resolve host'),
  }).pipe(
    Effect.flatMap((addresses) =>
      addresses.length > 0 && addresses.every((address) => !isPrivateIp(address))
        ? Effect.void
        : Effect.fail(rejectPrivateHost(source)),
    ),
  );
};

const loadDataUri = (
  source: string,
  kind: LocalMediaKind,
  index: number,
  mimeType: string,
  payload: string,
): Effect.Effect<LocalMediaFile, LocalMediaError> => {
  const compact = payload.replace(/\s+/g, '');
  let padding = 0;
  if (compact.endsWith('==')) padding = 2;
  else if (compact.endsWith('=')) padding = 1;
  const estimated = Math.floor((compact.length * 3) / 4) - padding;
  const limit = MEDIA_POLICIES[kind].limit;
  if (estimated > limit) {
    return Effect.fail(
      fail(source, `${estimated} bytes exceeds eBay's ${kind} limit of ${limit} bytes`),
    );
  }
  return finish(source, kind, mimeType, Buffer.from(compact, 'base64'), index);
};

const loadHttps = (
  source: string,
  kind: LocalMediaKind,
  index: number,
  fetchImpl: FetchLike,
  resolveImpl: ResolveLike,
): Effect.Effect<LocalMediaFile, LocalMediaError> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(source),
      catch: () => fail(source, 'invalid URL'),
    });
    if (url.protocol !== 'https:') {
      return yield* Effect.fail(fail(source, 'only https:// URLs are allowed'));
    }
    if (url.username || url.password) {
      return yield* Effect.fail(fail(source, 'URLs with embedded credentials are not allowed'));
    }
    if (isPrivateHost(url.hostname)) return yield* Effect.fail(rejectPrivateHost(source));
    yield* assertPublicDns(source, url.hostname, resolveImpl);
    const limit = MEDIA_POLICIES[kind].limit;
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(url.toString(), { redirect: 'error', signal: AbortSignal.timeout(60_000) }),
      catch: (error) => downloadFailure(source, error),
    });
    if (!response.ok) {
      return yield* Effect.fail(fail(source, `download failed: HTTP ${response.status}`));
    }
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      return yield* Effect.fail(
        fail(source, `${declaredLength} bytes exceeds eBay's ${kind} limit of ${limit} bytes`),
      );
    }
    const bytes = yield* Effect.tryPromise({
      try: () => readLimitedBody(response, source, kind),
      catch: (error) => asMediaError(source, error, 'download failed while reading the body'),
    });
    return yield* finish(
      source,
      kind,
      response.headers.get('content-type') ?? undefined,
      bytes,
      index,
    );
  });

const loadRemote = (
  source: string,
  kind: LocalMediaKind,
  index: number,
  fetchImpl: FetchLike,
  resolveImpl: ResolveLike,
): Effect.Effect<LocalMediaFile, LocalMediaError> => {
  const dataMatch = DATA_URI.exec(source);
  if (dataMatch?.[1] && dataMatch[2] !== undefined) {
    return loadDataUri(source, kind, index, dataMatch[1], dataMatch[2]);
  }
  if (/^data:/i.test(source)) {
    return Effect.fail(fail(source, 'data URIs must be data:<mime>;base64,<payload>'));
  }
  return loadHttps(source, kind, index, fetchImpl, resolveImpl);
};

/** Options for {@link loadMediaReference}. `fetchImpl` and `resolveImpl` are for tests. */
export interface RemoteMediaOptions {
  readonly index?: number;
  readonly fetchImpl?: FetchLike;
  readonly resolveImpl?: ResolveLike;
  readonly env?: NodeJS.ProcessEnv;
}

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
  options: RemoteMediaOptions = {},
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
    options.resolveImpl ?? defaultResolve,
  );
};

/** Loads several references in order, failing on the first invalid one. */
export const loadMediaReferenceList = (
  sources: readonly string[],
  kind: LocalMediaKind,
  access: MediaAccessConfig,
  options: RemoteMediaOptions = {},
): Effect.Effect<LocalMediaFile[], LocalMediaError> =>
  Effect.forEach(sources, (source, index) =>
    loadMediaReference(source, kind, access, { ...options, index: index + 1 }),
  );
