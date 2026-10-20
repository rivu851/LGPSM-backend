# Invitation card templates

The cards guests receive (email attachment, WhatsApp, the preview in the Add Event form) are drawn from the designers'
Figma file. The artwork is **fixed images**; this event's content (names, dates, venue, QR, photo) is placed on top.

## How an event gets its card

1. **Design choice** (`src/services/cardTemplates/designs.ts`): the organizer's template wins. Without one, the design
   follows the event type (subcategory, then category, then title keywords):

   | Event type | Design |
   |---|---|
   | birthday | `BIRTHDAY` |
   | rice ceremony, annaprasan | `RICE_CEREMONY` |
   | wedding, reception, engagement, anniversary, sangeet... | `WEDDING` |
   | awards, recognition | `CORPORATE_V1` |
   | anything else (conference, summit, technology, general) | `CORPORATE_V2` |

   `CLASSIC` (the older generic card) is used only when a template explicitly asks for it.
2. **Wording** (`src/services/cardTemplates/content.ts`): the text for every slot is generated from the event. A birthday
   card names the guest of honour (taken from the title: "Moloy Birthday Celebration!!!" becomes "Moloy"), a wedding card
   uses wording that fits (wedding, reception, engagement), a corporate card shows the guest's name and company. All the
   wording lives in that one file.
3. **Drawing** (`src/services/cardTemplates/renderer.ts`): text is fitted to its slot (wrapped, then shrunk to a minimum,
   then shortened with an ellipsis), so nothing overflows the artwork. Bengali and Devanagari names are supported.

## Where the files are

| What | Where | Committed? |
|---|---|---|
| Fixed artwork (one PNG per design) | `src/assets/cardTemplates/<design>/background.png` | yes (generated) |
| Slot positions, fonts, sizes, colours | `src/services/cardTemplates/layouts.generated.ts` | yes (generated) |
| Fonts + licences (SIL OFL) | `src/assets/cardTemplates/fonts/` | yes |
| LGPSM logo | `src/assets/branding/lgpsm-logo.png` | yes |
| The designers' `.fig` file | **not in the repository** | no |

**The server never reads the `.fig` file.** It is only an input to the build script below. Everything the running server
needs is in the repository, so a deployment does not need the `.fig` or any path on a developer's machine.

## Deployment

Render runs the compiled code (`node dist/server.js`) and deploys the whole repository. TypeScript does not copy images
or fonts, so `src/utils/assetPath.ts` looks for assets next to the running code and falls back to `<repo>/src/assets`.
`npm run build` also copies them to `dist/assets`, which is git-ignored because the fallback makes it unnecessary.

`npm run check:deployed-layout` proves this: it renders every design with `dist/assets` removed and the process started
from an unrelated directory. CI runs it on every push.

## Changing or adding a design

1. Update the Figma file. Keep the layer names the build script maps (see `CARDS` in `scripts/figma-templates/build.js`);
   a text layer it cannot find is reported as a warning.
2. Regenerate (needs Node 22.15 or newer and `npm install` for the dev dependency `kiwi-schema`):

   ```
   node scripts/figma-templates/build.js "<path to the unzipped Event_Management_Invitation_Card.fig folder>"
   ```
3. Look at the result: `npx tsx scripts/preview-cards.ts` renders every design with sample text into `card-previews/`.
4. `npm test` (the card tests check text lands in its slot and never crosses the margins), then commit the regenerated
   `src/assets/cardTemplates/**` and `layouts.generated.ts`.

A new design also needs an entry in `CARD_DESIGNS` (`src/models/Template.ts`), a rule in `designs.ts`, a case in
`content.ts`, and (for the admin screen) the frontend label in `services/templateService.ts`.

## Making the templates appear in the app

Templates are database records. An admin installs the designers' set from **Settings > Template settings > Add default
templates** (API: `GET /api/v1/templates/defaults` previews, `POST` installs). It creates any missing templates, the
categories and subcategories they need (matched by name, ignoring case), and a preview image for each. It never changes
or removes anything that exists, and running it again creates nothing twice.

The Add Event form pre-selects the template made for the chosen category/subcategory and shows the real card live
(`POST /api/v1/templates/:id/preview`, which saves nothing).
