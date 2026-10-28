import { Effect, Exit } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import {
  isRemoteMediaReference,
  loadMediaReference,
  loadMediaReferenceList,
  type FetchLike,
} from '@/utils/remoteMedia.js';

const access = { allowedDirs: [], errors: [] };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const pngDataUri = `data:image/png;base64,${PNG.toString('base64')}`;

const okFetch = (body: Buffer, type: string): FetchLike =>
  vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': type } }));

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);
const message = (exit: Exit.Exit<unknown, unknown>) => JSON.stringify(exit);

describe('isRemoteMediaReference', () => {
  it('detects URLs and data URIs', () => {
    expect(isRemoteMediaReference('https://x.test/a.jpg')).toBe(true);
    expect(isRemoteMediaReference(pngDataUri)).toBe(true);
    expect(isRemoteMediaReference('/srv/media/a.jpg')).toBe(false);
    expect(isRemoteMediaReference('media://a.jpg')).toBe(false);
  });
});

describe('loadMediaReference', () => {
  it('decodes a base64 data URI', async () => {
    const file = await Effect.runPromise(loadMediaReference(pngDataUri, 'image', access));
    expect(file.mimeType).toBe('image/png');
    expect(file.bytes.equals(PNG)).toBe(true);
    expect(file.fileName).toBe('upload-1.png');
    expect(file.source.length).toBeLessThan(45);
  });

  it('rejects a data URI whose bytes do not match its type', async () => {
    const exit = await run(
      loadMediaReference(`data:image/png;base64,${JPEG.toString('base64')}`, 'image', access),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it('downloads an https URL and keeps its file name', async () => {
    const fetchImpl = okFetch(JPEG, 'image/jpeg');
    const file = await Effect.runPromise(
      loadMediaReference('https://cdn.example.com/p/front.jpg', 'image', access, { fetchImpl }),
    );
    expect(file.fileName).toBe('front.jpg');
    expect(file.mimeType).toBe('image/jpeg');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cdn.example.com/p/front.jpg',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it.each([
    'http://cdn.example.com/a.jpg',
    'https://localhost/a.jpg',
    'https://127.0.0.1/a.jpg',
    'https://169.254.169.254/latest',
    'https://10.0.0.5/a.jpg',
    'https://[::1]/a.jpg',
    'https://user:pw@cdn.example.com/a.jpg',
  ])('refuses %s without fetching', async (url) => {
    const fetchImpl = okFetch(JPEG, 'image/jpeg');
    const exit = await run(loadMediaReference(url, 'image', access, { fetchImpl }));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects HTTP errors and oversize downloads', async () => {
    const notFound: FetchLike = async () => new Response('', { status: 404 });
    expect(
      Exit.isFailure(
        await run(
          loadMediaReference('https://x.test/a.jpg', 'image', access, { fetchImpl: notFound }),
        ),
      ),
    ).toBe(true);
    const huge: FetchLike = async () =>
      new Response(JPEG, {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(13 * 1024 * 1024) },
      });
    const exit = await run(
      loadMediaReference('https://x.test/a.jpg', 'image', access, { fetchImpl: huge }),
    );
    expect(message(exit)).toMatch(/exceeds/);
  });

  it('rejects a content type the kind does not accept', async () => {
    const exit = await run(
      loadMediaReference('https://x.test/a.pdf', 'image', access, {
        fetchImpl: okFetch(Buffer.from('%PDF-1.4'), 'application/pdf'),
      }),
    );
    expect(message(exit)).toMatch(/unsupported image content type/);
  });

  it('can be disabled with EBAY_MCP_REMOTE_MEDIA=false', async () => {
    const exit = await run(
      loadMediaReference(pngDataUri, 'image', access, { env: { EBAY_MCP_REMOTE_MEDIA: 'false' } }),
    );
    expect(message(exit)).toMatch(/remote media is disabled/);
  });

  it('still routes local paths to the local loader (disabled without media dirs)', async () => {
    const exit = await run(loadMediaReference('/srv/media/a.jpg', 'image', access));
    expect(message(exit)).toMatch(/local media access is disabled/);
  });

  it('loads a list in order with numbered names', async () => {
    const files = await Effect.runPromise(
      loadMediaReferenceList([pngDataUri, pngDataUri], 'image', access),
    );
    expect(files.map((f) => f.fileName)).toEqual(['upload-1.png', 'upload-2.png']);
  });
});
