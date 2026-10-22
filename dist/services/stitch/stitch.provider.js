"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStitchProvider = exports.sdkStitchProvider = exports.StitchProviderError = void 0;
exports.setStitchSdkLoader = setStitchSdkLoader;
exports.setStitchProvider = setStitchProvider;
const env_1 = require("../../config/env");
const safeFetchBounded_1 = require("../../utils/safeFetchBounded");
class StitchProviderError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.kind = kind;
        this.name = 'StitchProviderError';
    }
}
exports.StitchProviderError = StitchProviderError;
const ARTIFACT_HOSTS = ['google.com', 'googleusercontent.com', 'googleapis.com', 'gstatic.com'];
const MAX_HTML_BYTES = 1_500_000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
let sdkLoader = () => new Function('m', 'return import(m)')('@google/stitch-sdk'); // the SDK is ESM-only; this backend compiles to CommonJS
/** Test hook: supply a fake SDK module. */
function setStitchSdkLoader(loader) {
    sdkLoader = loader || (() => new Function('m', 'return import(m)')('@google/stitch-sdk'));
}
function classify(err) {
    if (err instanceof StitchProviderError)
        return err;
    if (err instanceof safeFetchBounded_1.BoundedFetchError) {
        return new StitchProviderError(err.code === 'TIMEOUT' ? 'TIMEOUT' : err.code === 'NETWORK' ? 'NETWORK' : 'MALFORMED', `Generated artifact could not be downloaded (${err.code})`);
    }
    const code = String(err?.code || '');
    const text = `${code} ${err instanceof Error ? err.message : ''}`.toLowerCase();
    if (code === 'AUTH_FAILED' || code === 'PERMISSION_DENIED' || /api key|unauthenticated|permission denied|401|403|invalid.*credential/.test(text))
        return new StitchProviderError('AUTH', 'The design provider rejected the server credentials');
    if (code === 'RATE_LIMITED' || /rate limit|quota|resource_exhausted|429|too many requests/.test(text))
        return new StitchProviderError('QUOTA', 'The design provider quota or rate limit was reached');
    if (/timed? ?out|timeout|etimedout|aborted/.test(text))
        return new StitchProviderError('TIMEOUT', 'The design provider took too long to respond');
    if (code === 'NETWORK_ERROR' || /econn|enotfound|network|fetch failed|socket|eai_again/.test(text))
        return new StitchProviderError('NETWORK', 'The design provider could not be reached');
    return new StitchProviderError('PROVIDER', 'The design provider failed to generate a design');
}
function withDeadline(work, ms) {
    let timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new StitchProviderError('TIMEOUT', 'The design provider took too long to respond')), ms);
    });
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
async function artifactsOf(screen) {
    const [htmlUrl, imageUrl] = await Promise.all([screen.getHtml(), screen.getImage()]);
    if (typeof htmlUrl !== 'string' || !htmlUrl || typeof imageUrl !== 'string' || !imageUrl || typeof screen.id !== 'string' || typeof screen.projectId !== 'string') {
        throw new StitchProviderError('MALFORMED', 'The design provider returned an incomplete design');
    }
    const [html, shot] = await Promise.all([
        (0, safeFetchBounded_1.fetchBounded)(htmlUrl, { hostSuffixes: ARTIFACT_HOSTS, maxBytes: MAX_HTML_BYTES }),
        (0, safeFetchBounded_1.fetchBounded)(imageUrl, { hostSuffixes: ARTIFACT_HOSTS, maxBytes: MAX_IMAGE_BYTES })
    ]);
    const text = html.buffer.toString('utf8');
    if (!/<html[\s>]|<body[\s>]|<div[\s>]/i.test(text))
        throw new StitchProviderError('MALFORMED', 'The generated design was not HTML');
    return { projectId: screen.projectId, screenId: screen.id, html: text, screenshot: shot.buffer };
}
async function withClient(fn) {
    if (!env_1.env.STITCH_API_KEY)
        throw new StitchProviderError('NOT_CONFIGURED', 'AI template generation is not configured on this server');
    let client;
    try {
        const sdk = await sdkLoader();
        client = new sdk.StitchToolClient({ apiKey: env_1.env.STITCH_API_KEY, timeout: env_1.env.STITCH_TIMEOUT_MS });
        return await withDeadline(fn(new sdk.Stitch(client)), env_1.env.STITCH_TIMEOUT_MS + 15000);
    }
    catch (err) {
        throw classify(err);
    }
    finally {
        try {
            await client?.close();
        }
        catch {
            /* nothing to do */
        }
    }
}
exports.sdkStitchProvider = {
    isConfigured: () => !!env_1.env.STITCH_API_KEY,
    generate: ({ title, prompt, device }) => withClient(async (stitch) => {
        const project = await stitch.createProject(title.slice(0, 80));
        return artifactsOf(await project.generate(prompt, device));
    }),
    edit: ({ projectId, screenId, prompt, device }) => withClient(async (stitch) => artifactsOf(await stitch.project(projectId).screen(screenId).edit(prompt, device))),
    variants: ({ projectId, screenId, prompt, device, options }) => withClient(async (stitch) => {
        const screens = await stitch
            .project(projectId)
            .screen(screenId)
            .variants(prompt, { variantCount: options.count, creativeRange: options.creativeRange, ...(options.aspects?.length ? { aspects: options.aspects } : {}) }, device);
        if (!Array.isArray(screens) || screens.length === 0)
            throw new StitchProviderError('MALFORMED', 'The design provider returned no variants');
        // fetched one by one so a slow artifact does not open many connections at once
        const out = [];
        for (const s of screens.slice(0, options.count))
            out.push(await artifactsOf(s));
        return out;
    })
};
let active = exports.sdkStitchProvider;
const getStitchProvider = () => active;
exports.getStitchProvider = getStitchProvider;
/** Test hook: replace the provider (null restores the real one). */
function setStitchProvider(provider) {
    active = provider || exports.sdkStitchProvider;
}
