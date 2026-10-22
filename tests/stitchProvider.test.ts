// MOCKED: the Stitch SDK and the artifact download are faked here. Nothing in this file reaches Google.
// The one genuine provider check lives in tests/stitch.live.test.ts and only runs when STITCH_LIVE_TEST=1.
import { env } from '../src/config/env';
import { sdkStitchProvider, setStitchSdkLoader, StitchProviderError } from '../src/services/stitch/stitch.provider';
import { fetchBounded, BoundedFetchError, hostAllowed } from '../src/utils/safeFetchBounded';

jest.mock('../src/utils/safeFetchBounded', () => {
  const actual = jest.requireActual('../src/utils/safeFetchBounded');
  return { ...actual, fetchBounded: jest.fn() };
});
const download = fetchBounded as jest.Mock;

const HTML = '<html><body><div>concept</div></body></html>';
const PNG = Buffer.from('png-bytes');

function fakeScreen(overrides: Record<string, unknown> = {}) {
  return { id: 'screen-1', projectId: 'project-1', getHtml: async () => 'https://contribution.usercontent.google.com/html', getImage: async () => 'https://lh3.googleusercontent.com/shot', edit: jest.fn(), variants: jest.fn(), ...overrides };
}
function fakeSdk(opts: { generate?: () => Promise<any>; edit?: () => Promise<any>; variants?: () => Promise<any[]>; createProject?: () => Promise<any>; close?: jest.Mock } = {}) {
  const close = opts.close || jest.fn(async () => undefined);
  const screen = { ...fakeScreen(), edit: opts.edit || (async () => fakeScreen({ id: 'screen-2' })), variants: opts.variants || (async () => [fakeScreen({ id: 'v1' }), fakeScreen({ id: 'v2' })]) };
  const project = { generate: opts.generate || (async () => fakeScreen()), screen: () => screen };
  class StitchToolClient {
    config: any;
    constructor(config: any) {
      this.config = config;
      (StitchToolClient as any).last = config;
    }
    close = close;
  }
  class Stitch {
    createProject = opts.createProject || (async () => project);
    project = () => project;
  }
  return { sdk: { Stitch, StitchToolClient } as any, close, ToolClient: StitchToolClient };
}
const use = (sdk: any) => setStitchSdkLoader(async () => sdk);
const generate = () => sdkStitchProvider.generate({ title: 't', prompt: 'a gold invitation', device: 'MOBILE' });
const kindOf = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof StitchProviderError ? e.kind : `other:${e?.message}`));

beforeEach(() => {
  (env as any).STITCH_API_KEY = 'test-key-not-real';
  download.mockReset();
  download.mockImplementation(async (url: string) => (url.includes('/html') ? { buffer: Buffer.from(HTML), contentType: 'text/html' } : { buffer: PNG, contentType: 'image/png' }));
});
afterAll(() => setStitchSdkLoader(null));

describe('Stitch provider adapter (mocked SDK)', () => {
  it('generates a design and returns its HTML and screenshot as bytes', async () => {
    const { sdk, close, ToolClient } = fakeSdk();
    use(sdk);
    const out = await generate();
    expect(out).toMatchObject({ projectId: 'project-1', screenId: 'screen-1', html: HTML });
    expect(out.screenshot.equals(PNG)).toBe(true);
    expect((ToolClient as any).last).toMatchObject({ apiKey: 'test-key-not-real', timeout: env.STITCH_TIMEOUT_MS });
    expect(close).toHaveBeenCalled(); // the connection is always released
    // artifacts are only fetched from Google hosts
    expect(download.mock.calls[0][1].hostSuffixes).toEqual(expect.arrayContaining(['googleusercontent.com']));
    expect(download.mock.calls[0][1].maxBytes).toBeLessThanOrEqual(2_000_000);
  });

  it('supports edit and variants exactly as the installed SDK offers them', async () => {
    const edit = jest.fn(async () => fakeScreen({ id: 'screen-2' }));
    const variants = jest.fn(async () => [fakeScreen({ id: 'v1' }), fakeScreen({ id: 'v2' }), fakeScreen({ id: 'v3' })]);
    use(fakeSdk({ edit, variants }).sdk);
    expect((await sdkStitchProvider.edit({ projectId: 'p', screenId: 's', prompt: 'make it blue', device: 'MOBILE' })).screenId).toBe('screen-2');
    expect(edit).toHaveBeenCalledWith('make it blue', 'MOBILE');
    const out = await sdkStitchProvider.variants({ projectId: 'p', screenId: 's', prompt: 'explore', device: 'TABLET', options: { count: 2, creativeRange: 'EXPLORE' } });
    expect(out.map((o) => o.screenId)).toEqual(['v1', 'v2']); // bounded to the requested count
    expect(variants).toHaveBeenCalledWith('explore', { variantCount: 2, creativeRange: 'EXPLORE' }, 'TABLET');
  });

  it('reports a missing credential without calling the provider', async () => {
    (env as any).STITCH_API_KEY = undefined;
    const loader = jest.fn();
    setStitchSdkLoader(loader as any);
    expect(await kindOf(generate())).toBe('NOT_CONFIGURED');
    expect(loader).not.toHaveBeenCalled();
    expect(sdkStitchProvider.isConfigured()).toBe(false);
  });

  it.each([
    ['rejected credentials', { code: 'AUTH_FAILED', message: 'API key not valid' }, 'AUTH'],
    ['permission denied', { code: 'PERMISSION_DENIED', message: 'nope' }, 'AUTH'],
    ['quota', { code: 'RATE_LIMITED', message: 'RESOURCE_EXHAUSTED quota' }, 'QUOTA'],
    ['network', { code: 'NETWORK_ERROR', message: 'fetch failed' }, 'NETWORK'],
    ['an SDK timeout', { code: 'UNKNOWN_ERROR', message: 'Request timed out' }, 'TIMEOUT'],
    ['anything else', { code: 'UNKNOWN_ERROR', message: 'boom with details that must not leak' }, 'PROVIDER']
  ])('classifies %s', async (_n, err, kind) => {
    use(fakeSdk({ generate: async () => Promise.reject(Object.assign(new Error(err.message), { code: err.code })) }).sdk);
    expect(await kindOf(generate())).toBe(kind);
  });

  it('never puts the credential or provider detail in the error it throws', async () => {
    use(fakeSdk({ generate: async () => Promise.reject(new Error('401 for key test-key-not-real at https://stitch.example/secret')) }).sdk);
    const err: any = await generate().catch((e) => e);
    expect(err).toBeInstanceOf(StitchProviderError);
    expect(String(err.message)).not.toMatch(/test-key-not-real|stitch\.example/);
  });

  it('gives up on a provider call that never returns', async () => {
    const original = env.STITCH_TIMEOUT_MS;
    (env as any).STITCH_TIMEOUT_MS = 5000;
    jest.useFakeTimers();
    use(fakeSdk({ generate: () => new Promise(() => undefined) }).sdk);
    const pending = kindOf(generate());
    await jest.advanceTimersByTimeAsync(5000 + 15000 + 100);
    expect(await pending).toBe('TIMEOUT');
    jest.useRealTimers();
    (env as any).STITCH_TIMEOUT_MS = original;
  });

  it.each([
    ['no screenshot url', fakeScreen({ getImage: async () => '' })],
    ['no html url', fakeScreen({ getHtml: async () => undefined })],
    ['no id', fakeScreen({ id: undefined })]
  ])('rejects a malformed result (%s)', async (_n, screen) => {
    use(fakeSdk({ generate: async () => screen }).sdk);
    expect(await kindOf(generate())).toBe('MALFORMED');
  });

  it('rejects an HTML download that is not HTML, and a download that fails', async () => {
    use(fakeSdk().sdk);
    download.mockImplementation(async (url: string) => (url.includes('/html') ? { buffer: Buffer.from('{"json":true}'), contentType: 'application/json' } : { buffer: PNG, contentType: 'image/png' }));
    expect(await kindOf(generate())).toBe('MALFORMED');
    download.mockRejectedValue(new BoundedFetchError('TIMEOUT', 'Request timed out'));
    expect(await kindOf(generate())).toBe('TIMEOUT');
    download.mockRejectedValue(new BoundedFetchError('URL_NOT_ALLOWED', 'URL is not allowed'));
    expect(await kindOf(generate())).toBe('MALFORMED');
  });

  it('rejects an empty variants answer', async () => {
    use(fakeSdk({ variants: async () => [] }).sdk);
    expect(await kindOf(sdkStitchProvider.variants({ projectId: 'p', screenId: 's', prompt: 'x', device: 'MOBILE', options: { count: 2, creativeRange: 'EXPLORE' } }))).toBe('MALFORMED');
  });
});

describe('artifact download guard', () => {
  const actual = jest.requireActual('../src/utils/safeFetchBounded') as { fetchBounded: typeof fetchBounded };
  const opts = { hostSuffixes: ['googleusercontent.com'], maxBytes: 1000 };

  it('only allows https downloads from allow-listed hosts', async () => {
    for (const url of ['http://lh3.googleusercontent.com/a', 'https://evil.example/a', 'https://googleusercontent.com.evil.example/a', 'https://user:pw@lh3.googleusercontent.com/a', 'https://lh3.googleusercontent.com:8443/a', 'https://127.0.0.1/a', 'https://169.254.169.254/latest', 'file:///etc/passwd', 'not a url']) {
      await expect(actual.fetchBounded(url, opts)).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
    }
    expect(hostAllowed('lh3.googleusercontent.com', ['googleusercontent.com'])).toBe(true);
    expect(hostAllowed('evilgoogleusercontent.com', ['googleusercontent.com'])).toBe(false);
  });
});
