# AI template generation (Google Stitch)

Organizers and admins describe an invitation or poster; the backend asks Google Stitch for a design concept and
converts it into a **DesignSpec**, a closed, validated, versioned format that the LGPSM renderer draws. The result is a
normal `Template` (`cardDesign: 'CUSTOM'`) used by the existing invitation workflow.

## Flow
1. `POST /api/v1/template-generations` creates a persistent job (`TemplateGenerationJob`) and answers `202`.
2. The job runs in-process (bounded by `STITCH_MAX_CONCURRENT_JOBS`): `stitch.provider.ts` calls the SDK
   (`createProject` → `project.generate`, `screen.edit`, `screen.variants`) and downloads the generated HTML and
   screenshot from allow-listed Google hosts (`utils/safeFetchBounded.ts`: https only, connect-time private-address check,
   size/time limits, redirects only within the allow-list).
3. `stitch.converter.ts` reads the HTML **as text** (never executed) for colours and font names, samples the screenshot,
   and rebuilds the layout on fixed arrangements that fit real event text and a scannable QR code. A quality gate checks
   contrast, QR module size, and renders sample text; a concept that fails stays **concept-only** and cannot be saved.
4. Clients poll `GET /template-generations/:id`, show `previewImageKey` (the converted template) and `conceptImageKey`
   (what the provider drew), then `POST .../variants/:i/save` creates the template (draft or published).
5. `loadCardContext` hands the spec to `invitationCardService`, which renders it per attendee with that guest's own QR.

## API
| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/template-generations/options` | sizes, moods, limits, `available` |
| POST | `/api/v1/template-generations` | `{kind, preset, prompt, style?, variantCount?, idempotencyKey?}` |
| GET | `/api/v1/template-generations`, `/:id` | own jobs (admin: any) |
| DELETE | `/api/v1/template-generations/:id` | removes the job and its images |
| POST | `/:id/variants/:i/edit` · `/variations` · `/save` | `save` is idempotent |
| GET | `/api/v1/templates?scope=mine&kind=` | own templates incl. drafts |
| PATCH/DELETE | `/api/v1/templates/:id` | organizers: own AI templates only, narrow body |
| POST | `/api/v1/templates/:id/preview` | sample details, sample QR (marked `X-Invitation-Qr: SAMPLE`) |
| POST | `/api/v1/templates/:id/render` | real event, PNG/JPEG; posters take `registrationUrl` |

Error codes: `PROVIDER_UNAVAILABLE` (503), `QUOTA_EXCEEDED` (429 + `Retry-After`), `RATE_LIMITED`, `JOB_ACTIVE` (409),
`NOT_CONVERTIBLE` (409), `INVALID_REQUEST` (400), and job failures `PROVIDER_AUTH|QUOTA|TIMEOUT|NETWORK|FAILED`,
`BAD_PROVIDER_RESPONSE`, `INTERRUPTED`, `EXPIRED`.

## Safety properties
- Stored specs contain no markup, scripts, CSS, URLs, event details or QR images (see `designSpec.ts`).
- Rendering uses bundled fonts only; no Google Fonts/Tailwind CDN is ever loaded.
- Ownership: an AI template is visible/usable only by its owner (admins see all; an admin-published one is global).
  `loadCardContext` re-checks ownership at render time and falls back to the type-based design.
- Limits: 800-char prompt, 10 starts/hour (rate limit), `STITCH_DAILY_QUOTA_PER_USER`/day, one active job per user.

## Operations
- Configure `STITCH_API_KEY` on the server (never in the web or mobile bundle). Without it the feature reports unavailable.
- Jobs expire after 7 days (TTL); interrupted jobs fail on restart (`recoverOnStartup`) or when their lease runs out.
- Genuine provider check (uses quota): `npx tsx scripts/stitch-live-check.ts [outDir]`. Unit/integration tests mock Stitch.
- The SDK is ESM-only; `stitch.provider.ts` loads it with a native `import()` so the CommonJS build can use it.
