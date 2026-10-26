import { env } from '../../config/env';
import { fetchBounded, BoundedFetchError } from '../../utils/safeFetchBounded';

// The only place that talks to Google Stitch. It uses the installed @google/stitch-sdk (0.3.x): a Stitch project holds
// "screens"; `project.generate(prompt)` creates one, `screen.edit(prompt)` revises it and `screen.variants(...)` makes
// alternatives. Each screen exposes download URLs for its generated HTML and screenshot, which are fetched here
// (host allow-listed, size and time bounded) and returned as bytes. Nothing returned by Stitch is trusted or executed.
//
// The credential is read from STITCH_API_KEY on the server and never logged or returned.

export type StitchErrorKind = 'NOT_CONFIGURED' | 'AUTH' | 'QUOTA' | 'NETWORK' | 'TIMEOUT' | 'MALFORMED' | 'PROVIDER';

export class StitchProviderError extends Error {
  constructor(public readonly kind: StitchErrorKind, message: string) {
    super(message);
    this.name = 'StitchProviderError';
  }
}

export type StitchDevice = 'MOBILE' | 'TABLET' | 'DESKTOP';

export interface StitchScreenRef {
  projectId: string;
  screenId: string;
}

export interface StitchScreenArtifacts extends StitchScreenRef {
  html: string;
  screenshot: Buffer;
}

export interface StitchVariantOptions {
  count: number;
  creativeRange: 'REFINE' | 'EXPLORE' | 'REIMAGINE';
  aspects?: Array<'LAYOUT' | 'COLOR_SCHEME' | 'IMAGES' | 'TEXT_FONT' | 'TEXT_CONTENT'>;
}

export interface StitchProvider {
  isConfigured(): boolean;
  generate(input: { title: string; prompt: string; device: StitchDevice }): Promise<StitchScreenArtifacts>;
  edit(input: StitchScreenRef & { prompt: string; device: StitchDevice }): Promise<StitchScreenArtifacts>;
  variants(input: StitchScreenRef & { prompt: string; device: StitchDevice; options: StitchVariantOptions }): Promise<StitchScreenArtifacts[]>;
}

const ARTIFACT_HOSTS = ['google.com', 'googleusercontent.com', 'googleapis.com', 'gstatic.com'];
const MAX_HTML_BYTES = 1_500_000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

type SdkModule = { Stitch: new (client: any) => any; StitchToolClient: new (config: Record<string, unknown>) => any };
let sdkLoader: () => Promise<SdkModule> = () => (new Function('m', 'return import(m)') as (m: string) => Promise<SdkModule>)('@google/stitch-sdk'); // the SDK is ESM-only; this backend compiles to CommonJS
/** Test hook: supply a fake SDK module. */
export function setStitchSdkLoader(loader: (() => Promise<SdkModule>) | null) {
  sdkLoader = loader || (() => (new Function('m', 'return import(m)') as (m: string) => Promise<SdkModule>)('@google/stitch-sdk'));
}

/** What the SDK said, for the server log only: truncated, and with the credential redacted if it ever appears. */
function describeForLog(err: unknown): string {
  const code = String((err as any)?.code || '');
  let message = err instanceof Error ? err.message : String(err);
  if (env.STITCH_API_KEY) message = message.split(env.STITCH_API_KEY).join('[redacted]');
  return `${code ? code + ': ' : ''}${message.replace(/\s+/g, ' ').slice(0, 240)}`;
}

function classify(err: unknown): StitchProviderError {
  if (err instanceof StitchProviderError) return err;
  if (!(err instanceof BoundedFetchError)) console.error('[stitch] Provider call failed:', describeForLog(err));
  if (err instanceof BoundedFetchError) {
    return new StitchProviderError(err.code === 'TIMEOUT' ? 'TIMEOUT' : err.code === 'NETWORK' ? 'NETWORK' : 'MALFORMED', `Generated artifact could not be downloaded (${err.code}${err.code === 'BAD_STATUS' ? ': ' + err.message : ''})`);
  }
  const code = String((err as any)?.code || '');
  const text = `${code} ${err instanceof Error ? err.message : ''}`.toLowerCase();
  if (code === 'AUTH_FAILED' || code === 'PERMISSION_DENIED' || /api key|unauthenticated|permission denied|401|403|invalid.*credential/.test(text)) return new StitchProviderError('AUTH', 'The design provider rejected the server credentials');
  if (code === 'RATE_LIMITED' || /rate limit|quota|resource_exhausted|429|too many requests/.test(text)) return new StitchProviderError('QUOTA', 'The design provider quota or rate limit was reached');
  if (/timed? ?out|timeout|etimedout|aborted/.test(text)) return new StitchProviderError('TIMEOUT', 'The design provider took too long to respond');
  if (code === 'NETWORK_ERROR' || /econn|enotfound|network|fetch failed|socket|eai_again/.test(text)) return new StitchProviderError('NETWORK', 'The design provider could not be reached');
  return new StitchProviderError('PROVIDER', 'The design provider failed to generate a design');
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StitchProviderError('TIMEOUT', 'The design provider took too long to respond')), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

async function artifactsOf(screen: any): Promise<StitchScreenArtifacts> {
  const [htmlUrl, imageUrl] = await Promise.all([screen.getHtml(), screen.getImage()]);
  if (typeof htmlUrl !== 'string' || !htmlUrl || typeof imageUrl !== 'string' || !imageUrl || typeof screen.id !== 'string' || typeof screen.projectId !== 'string') {
    throw new StitchProviderError('MALFORMED', 'The design provider returned an incomplete design');
  }
  const getHtml = () => fetchBounded(htmlUrl, { hostSuffixes: ARTIFACT_HOSTS, maxBytes: MAX_HTML_BYTES });
  // the provider answers with an HTML page, or sometimes with an SVG drawing; both are read as text only
  const looksLikeHtml = (t: string) => /<html[\s>]|<body[\s>]|<div[\s>]|<svg[\s>]/i.test(t);
  const [firstHtml, shot] = await Promise.all([getHtml(), fetchBounded(imageUrl, { hostSuffixes: ARTIFACT_HOSTS, maxBytes: MAX_IMAGE_BYTES })]);
  let text = firstHtml.buffer.toString('utf8');
  if (!looksLikeHtml(text)) {
    // The download link sometimes answers with something other than the page for a moment after generation: say what, then ask once more
    console.warn(`[stitch] Download was not a page or drawing (type ${firstHtml.contentType || 'unknown'}, ${firstHtml.buffer.length} bytes, starts: "${text.slice(0, 80).replace(/\s+/g, ' ')}")`);
    await new Promise((r) => setTimeout(r, 2000));
    text = (await getHtml()).buffer.toString('utf8');
    if (!looksLikeHtml(text)) throw new StitchProviderError('MALFORMED', 'The generated design was neither a page nor a drawing');
  }
  return { projectId: screen.projectId, screenId: screen.id, html: text, screenshot: shot.buffer };
}

async function withClient<T>(fn: (stitch: any) => Promise<T>): Promise<T> {
  if (!env.STITCH_API_KEY) throw new StitchProviderError('NOT_CONFIGURED', 'AI template generation is not configured on this server');
  let client: any;
  try {
    const sdk = await sdkLoader();
    client = new sdk.StitchToolClient({ apiKey: env.STITCH_API_KEY, timeout: env.STITCH_TIMEOUT_MS });
    return await withDeadline(fn(new sdk.Stitch(client)), env.STITCH_TIMEOUT_MS + 15000);
  } catch (err) {
    throw classify(err);
  } finally {
    try {
      await client?.close();
    } catch {
      /* nothing to do */
    }
  }
}

export const sdkStitchProvider: StitchProvider = {
  isConfigured: () => !!env.STITCH_API_KEY,

  generate: ({ title, prompt, device }) =>
    withClient(async (stitch) => {
      const project = await stitch.createProject(title.slice(0, 80));
      return artifactsOf(await project.generate(prompt, device));
    }),

  edit: ({ projectId, screenId, prompt, device }) =>
    withClient(async (stitch) => artifactsOf(await stitch.project(projectId).screen(screenId).edit(prompt, device))),

  variants: ({ projectId, screenId, prompt, device, options }) =>
    withClient(async (stitch) => {
      const screens = await stitch
        .project(projectId)
        .screen(screenId)
        .variants(prompt, { variantCount: options.count, creativeRange: options.creativeRange, ...(options.aspects?.length ? { aspects: options.aspects } : {}) }, device);
      if (!Array.isArray(screens) || screens.length === 0) throw new StitchProviderError('MALFORMED', 'The design provider returned no variants');
      // fetched one by one so a slow artifact does not open many connections at once
      const out: StitchScreenArtifacts[] = [];
      for (const s of screens.slice(0, options.count)) out.push(await artifactsOf(s));
      return out;
    })
};

let active: StitchProvider = sdkStitchProvider;
export const getStitchProvider = (): StitchProvider => active;
/** Test hook: replace the provider (null restores the real one). */
export function setStitchProvider(provider: StitchProvider | null) {
  active = provider || sdkStitchProvider;
}
