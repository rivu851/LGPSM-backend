import fs from 'fs';
import sharp from 'sharp';
import QRCode from 'qrcode';
import type { CardDesign } from '../models/Template';
import { assetPath } from '../utils/assetPath';
import { renderTemplateCard, isTemplateDesign, TemplateDesign } from './cardTemplates/renderer';
import { buildTemplateTexts, photoInitials, buildSpecTexts, masterDateTime, addressLine } from './cardTemplates/content';
import { renderMasterCard } from './cardTemplates/masterCard';
import type { DesignSpec } from './cardTemplates/designSpec';
import { renderDesignSpec, outputSize } from './cardTemplates/specRenderer';
import { appendInfoFooter, footerHeightFor, insertGuestBand, FOOTER_STYLES, FooterStyle } from './cardTemplates/infoFooter';
import { CardDisplay, cardDisplayOf, withoutHidden } from '../utils/cardDisplay';
import { qrCollapsePlan } from './cardTemplates/qrCollapse';
import { coverageOfDesign, coverageOfSpec, Coverage, detailRows } from './cardTemplates/coverage';

export interface CardSessionData {
  id?: string;
  name: string;
  startTime: string;
  endTime?: string;
}

export interface InvitationCardData {
  invitee: {
    id?: string;
    name: string;
    companyName?: string;
    employeeId?: string;
  };
  event: {
    id?: string;
    title: string;
    subtitle?: string;
    date?: string;
    dayOfWeek?: string;
    startTime?: string;
    timeSub?: string;
    venue?: string;
    locationSub?: string;
    // Organizer's own uploaded event photo (Event.logoKey, resolved via resolveImageKeyBase64),
    // not Figma placeholder content — absent when the organizer hasn't uploaded one.
    photoBase64?: string;
    // Used by the template designs to write the card's wording for this kind of event
    startIso?: string | Date | null;
    endIso?: string | Date | null;
    categoryName?: string;
    subcategoryName?: string;
    isVirtual?: boolean;
    description?: string;
    organizerName?: string;
    /** The organizer's contact number: printed at the bottom of every card as "For more details contact …" */
    contactNumber?: string;
  };
  /** Which event details to print ("Select data to show on card"); absent = all */
  cardDisplay?: Partial<CardDisplay> | null;
  sessions: CardSessionData[];
  /** Preview of a template/event being set up: the designers' sample photo may stand in for a missing event image */
  isPreview?: boolean;
  qrDataUrl?: string;
  invitationUrl?: string;
  cardDesign?: CardDesign;
  /** A validated custom design (AI-generated template); when present it is drawn instead of a fixed design */
  designSpec?: DesignSpec;
}

const CARD_WIDTH = 1536;
const CARD_HEIGHT = 2048;

// The LGPSM logo ships with the app (src/assets/branding), so it is found wherever the server runs.
let logoCache: string | undefined;
function getLogoBase64(): string {
  if (logoCache !== undefined) return logoCache;
  logoCache = '';
  try {
    const file = assetPath('branding', 'lgpsm-logo.png');
    if (fs.existsSync(file)) logoCache = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  } catch (err) {
    console.warn('Could not load the LGPSM logo:', err);
  }
  return logoCache;
}

function escapeXml(unsafe: string = ''): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function buildClassicSVG(data: InvitationCardData): Promise<string> {
    const width = CARD_WIDTH;
    const height = CARD_HEIGHT;

    // 1. Process QR Code
    const show = cardDisplayOf(data.cardDisplay);
    let qrImageHref = show.qr ? data.qrDataUrl || '' : '';
    if (show.qr && !qrImageHref && data.invitationUrl) {
      qrImageHref = await QRCode.toDataURL(data.invitationUrl, {
        errorCorrectionLevel: 'H',
        margin: 1,
        color: { dark: '#000000', light: '#FFFFFF' }
      });
    }

    // 2. Process Logo
    const logoHref = show.logo ? getLogoBase64() : '';

    // 3. Process Event Title
    const fullTitle = show.title ? (data.event.title || '').trim() : '';
    const titleWords = fullTitle.split(' ');
    let mainTitlePart = fullTitle;
    let yearPart = '';
    if (titleWords.length > 1 && /^\d{4}$/.test(titleWords[titleWords.length - 1])) {
      yearPart = titleWords.pop() || '';
      mainTitlePart = titleWords.join(' ');
    }

    const subtitleText = data.event.subtitle || '';
    const dateMain = show.dateTime ? data.event.date || '' : '';
    const dateSub = show.dateTime ? data.event.dayOfWeek || '' : '';
    const timeMain = show.dateTime ? data.event.startTime || '' : '';
    const timeSub = show.dateTime ? data.event.timeSub || 'ONWARDS' : '';
    const venueMain = show.location ? data.event.venue || 'Venue to be announced' : '';
    const venueSub = show.location ? data.event.locationSub || '' : '';
    // with "Invitee Name" unticked the name line is never filled with a placeholder
    const inviteeName = show.inviteeName ? data.invitee.name || 'Guest' : data.invitee.name || '';
    const companyName = data.invitee.companyName || '';

    // 4. Process Sessions
    // Only the invitee's real sessions are printed; none means no session cards
    const sessions = data.sessions || [];

    // Session Cards rendering
    const sessionCount = sessions.length;
    const maxPerRow = sessionCount <= 3 ? sessionCount : sessionCount <= 4 ? 2 : 3;
    const cardWidth = maxPerRow === 1 ? 900 : maxPerRow === 2 ? 650 : 420;
    const cardHeight = 140;
    const gap = 30;
    const startY = 1680;
    const totalRowWidth = sessionCount <= 3
      ? sessionCount * cardWidth + (sessionCount - 1) * gap
      : Math.min(sessionCount, maxPerRow) * cardWidth + (Math.min(sessionCount, maxPerRow) - 1) * gap;
    const startX = (width - totalRowWidth) / 2;

    let sessionCardsSVG = '';
    sessions.slice(0, 6).forEach((sess, idx) => {
      const col = idx % maxPerRow;
      const row = Math.floor(idx / maxPerRow);
      const x = startX + col * (cardWidth + gap);
      const y = startY + row * (cardHeight + 20);

      const numStr = (idx + 1).toString().padStart(2, '0');
      const timeStr = sess.endTime ? `${sess.startTime} – ${sess.endTime}` : sess.startTime;

      sessionCardsSVG += `
        <g transform="translate(${x}, ${y})">
          <!-- Card Background -->
          <rect width="${cardWidth}" height="${cardHeight}" rx="20" fill="#1A1919" stroke="#CF5317" stroke-width="2.5" />
          <!-- Number Circle -->
          <circle cx="55" cy="${cardHeight / 2}" r="28" fill="#CF5317" />
          <text x="55" y="${cardHeight / 2 + 8}" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="800" font-size="22" fill="#FFFFFF" text-anchor="middle">${numStr}</text>
          
          <!-- Time & Name -->
          <text x="100" y="52" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="700" font-size="16" fill="#CF5317">${escapeXml(timeStr)}</text>
          <text x="100" y="88" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="700" font-size="20" fill="#FFFFFF">${escapeXml(sess.name)}</text>

          <!-- Bottom Accent Bar -->
          <line x1="100" y1="110" x2="${cardWidth - 40}" y2="110" stroke="#CF5317" stroke-width="2.5" opacity="0.8" />
        </g>
      `;
    });

    // Complete SVG string matching canonical visual design
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Background Gradients -->
    <linearGradient id="creamGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#FFFBF9"/>
      <stop offset="100%" stop-color="#F9F3EE"/>
    </linearGradient>

    <linearGradient id="darkGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#232222"/>
      <stop offset="100%" stop-color="#141414"/>
    </linearGradient>

    <linearGradient id="orangeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#E86221"/>
      <stop offset="100%" stop-color="#CF5317"/>
    </linearGradient>
  </defs>

  <!-- 1. TOP CREAM SECTION BACKGROUND -->
  <rect width="${width}" height="680" fill="url(#creamGrad)" />

  <!-- Top Left Geometric Diagonal Stripes -->
  <g opacity="0.9">
    <polygon points="0,0 220,0 120,160 0,160" fill="#CF5317" opacity="0.15" />
    <line x1="-20" y1="120" x2="220" y2="-40" stroke="#CF5317" stroke-width="12" />
    <line x1="10" y1="150" x2="250" y2="-10" stroke="#CF5317" stroke-width="12" />
    <line x1="40" y1="180" x2="280" y2="20" stroke="#CF5317" stroke-width="12" />
    <line x1="70" y1="210" x2="310" y2="50" stroke="#CF5317" stroke-width="12" />
  </g>

  <!-- Top Right Navigation Text -->
  <g font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-size="18" font-weight="700" fill="#232222" letter-spacing="4">
    <text x="1450" y="70" text-anchor="end">PEOPLE</text>
    <text x="1450" y="100" text-anchor="end">EVENTS</text>
    <text x="1450" y="130" text-anchor="end">IDEAS</text>
    <text x="1450" y="160" text-anchor="end">TOGETHER</text>
    <line x1="1350" y1="180" x2="1450" y2="180" stroke="#CF5317" stroke-width="3" />
  </g>

  <!-- CENTER LOGO -->
  ${logoHref ? `
    <image href="${logoHref}" x="${width / 2 - 220}" y="70" width="440" height="130" preserveAspectRatio="xMidYMid meet" />
  ` : `
    <g transform="translate(${width / 2 - 200}, 70)">
      <!-- SVG Fallback LGPSM Icon & Logo -->
      <path d="M0,70 L50,0 L110,0 L60,70 Z" fill="#CF5317" />
      <path d="M40,70 L90,0 L130,0 L80,70 Z" fill="#E86221" />
      <text x="150" y="55" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="900" font-size="54" fill="#CF5317" letter-spacing="2">LGPSM<tspan font-size="24" dy="-25">TM</tspan></text>
      <text x="152" y="85" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="700" font-size="16" fill="#232222" letter-spacing="6">EVENTS MADE SMARTER</text>
    </g>
  `}

  <!-- EVENT TITLE & SUBTITLE -->
  <text x="${width / 2}" y="320" text-anchor="middle" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="900" font-size="76" letter-spacing="2">
    <tspan fill="#232222">${escapeXml(mainTitlePart)} </tspan>
    ${yearPart ? `<tspan fill="#CF5317">${escapeXml(yearPart)}</tspan>` : ''}
  </text>

  <text x="${width / 2}" y="375" text-anchor="middle" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="700" font-size="22" fill="#232222" letter-spacing="6">${escapeXml(subtitleText)}</text>
  <line x1="${width / 2 - 250}" y1="400" x2="${width / 2 + 250}" y2="400" stroke="#CF5317" stroke-width="2" />

  <!-- EVENT DETAILS ROW (3 COLUMNS) -->
  <g transform="translate(0, 440)">
    <!-- Column 1: Date -->
    <g transform="translate(240, 0)">
      <rect x="0" y="0" width="56" height="56" rx="12" fill="#CF5317" />
      <!-- Calendar Icon SVG -->
      <path d="M16 12V20M40 12V20M12 24H44M14 16H42C44.2 16 46 17.8 46 20V42C46 44.2 44.2 46 42 46H14C11.8 46 10 44.2 10 42V20C10 17.8 11.8 16 14 16Z" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="75" y="26" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="800" font-size="22" fill="#232222">${escapeXml(dateMain)}</text>
      <text x="75" y="48" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="700" font-size="16" fill="#666666" letter-spacing="2">${escapeXml(dateSub)}</text>
    </g>

    <line x1="620" y1="5" x2="620" y2="55" stroke="#D1D1D1" stroke-width="2" />

    <!-- Column 2: Time -->
    <g transform="translate(670, 0)">
      <circle cx="28" cy="28" r="28" fill="#CF5317" />
      <!-- Clock Icon SVG -->
      <path d="M28 14V28L37 37M48 28C48 39.0457 39.0457 48 28 48C16.9543 48 8 39.0457 8 28C8 16.9543 16.9543 8 28 8C39.0457 8 48 16.9543 48 28Z" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="75" y="26" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="800" font-size="22" fill="#232222">${escapeXml(timeMain)}</text>
      <text x="75" y="48" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="700" font-size="16" fill="#666666" letter-spacing="2">${escapeXml(timeSub)}</text>
    </g>

    <line x1="1020" y1="5" x2="1020" y2="55" stroke="#D1D1D1" stroke-width="2" />

    <!-- Column 3: Venue -->
    <g transform="translate(1070, 0)">
      <path d="M28 6C17.5 6 9 14.5 9 25C9 38 28 54 28 54C28 54 47 38 47 25C47 14.5 38.5 6 28 6Z" fill="#CF5317" />
      <circle cx="28" cy="23" r="8" fill="#FFFFFF" />
      <text x="65" y="26" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="800" font-size="22" fill="#232222">${escapeXml(venueMain)}</text>
      <text x="65" y="48" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="700" font-size="16" fill="#666666" letter-spacing="2">${escapeXml(venueSub)}</text>
    </g>
  </g>

  <!-- 2. LARGE CURVED ORANGE & DARK SWOOSH TRANSITION -->
  <!-- Outer Orange Curve -->
  <path d="M -10,540 C 350,680 1150,470 1546,640 L 1546,740 C 1150,570 350,780 -10,640 Z" fill="#CF5317" />
  <!-- Main Dark Lower Body -->
  <path d="M -10,590 C 350,730 1150,520 1546,690 L 1546,2058 L -10,2058 Z" fill="url(#darkGrad)" />

  <!-- Subtle Technical Diagonal Texture Lines on Margins -->
  <g stroke="#CF5317" stroke-width="1.5" opacity="0.15">
    <line x1="-50" y1="750" x2="350" y2="1150" />
    <line x1="-50" y1="790" x2="310" y2="1150" />
    <line x1="-50" y1="830" x2="270" y2="1150" />
    <line x1="-50" y1="870" x2="230" y2="1150" />

    <line x1="1586" y1="750" x2="1186" y2="1150" />
    <line x1="1586" y1="790" x2="1226" y2="1150" />
    <line x1="1586" y1="830" x2="1266" y2="1150" />
  </g>

  <!-- 3. PERSONAL INVITATION SECTION -->
    <g transform="translate(0, 740)">
      <line x1="${width / 2 - 260}" y1="0" x2="${width / 2 - 130}" y2="0" stroke="#CF5317" stroke-width="2.5" />
      <text x="${width / 2}" y="7" text-anchor="middle" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="700" font-size="20" fill="#FFFFFF" letter-spacing="6">PERSONAL INVITATION FOR</text>
      <line x1="${width / 2 + 130}" y1="0" x2="${width / 2 + 260}" y2="0" stroke="#CF5317" stroke-width="2.5" />

      <!-- Invitee Name -->
      <text x="${width / 2}" y="75" text-anchor="middle" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="900" font-size="58" fill="#FFFFFF" letter-spacing="1">${escapeXml(inviteeName)}</text>
      <!-- Company Name -->
      <text x="${width / 2}" y="112" text-anchor="middle" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="700" font-size="20" fill="#CF5317" letter-spacing="3">${escapeXml(companyName.toUpperCase())}</text>

      <!-- Invitation Message -->
      <text x="${width / 2}" y="150" text-anchor="middle" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="500" font-size="22" fill="#E0E0E0">You are cordially invited to attend</text>
      <text x="${width / 2}" y="186" text-anchor="middle" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="800" font-size="28" fill="#CF5317">${escapeXml(fullTitle)}</text>
    </g>

  <!-- 4. QR CODE SECTION -->
  <g transform="translate(${width / 2 - 250}, 980)">
    <!-- QR Box Frame -->
    <rect x="0" y="0" width="500" height="500" rx="28" fill="#FFFFFF" stroke="#CF5317" stroke-width="8" />
    <!-- Embedded QR Image -->
    ${qrImageHref ? `<image href="${qrImageHref}" x="25" y="25" width="450" height="450" />` : ''}
  </g>

  <!-- QR Instruction -->
  <g transform="translate(0, 1530)">
    <line x1="${width / 2 - 240}" y1="0" x2="${width / 2 - 120}" y2="0" stroke="#CF5317" stroke-width="2.5" />
    <text x="${width / 2}" y="7" text-anchor="middle" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="800" font-size="22" fill="#FFFFFF" letter-spacing="4">SCAN THIS QR CODE</text>
    <line x1="${width / 2 + 120}" y1="0" x2="${width / 2 + 240}" y2="0" stroke="#CF5317" stroke-width="2.5" />
    <text x="${width / 2}" y="40" text-anchor="middle" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="600" font-size="18" fill="#AAAAAA" letter-spacing="3">AT THE EVENT ENTRANCE</text>
  </g>

  <!-- 5. YOUR SESSIONS SECTION -->
  <g transform="translate(0, 1620)">
    <line x1="${width / 2 - 250}" y1="0" x2="${width / 2 - 100}" y2="0" stroke="#CF5317" stroke-width="2.5" />
    <text x="${width / 2}" y="7" text-anchor="middle" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="800" font-size="22" fill="#FFFFFF" letter-spacing="6">YOUR SESSIONS</text>
    <line x1="${width / 2 + 100}" y1="0" x2="${width / 2 + 250}" y2="0" stroke="#CF5317" stroke-width="2.5" />
  </g>

  <!-- Dynamic Session Cards -->
  ${sessionCardsSVG}

  <!-- 6. FOOTER SECTION -->
  <g transform="translate(0, 1960)">
    <text x="${width / 2}" y="0" text-anchor="middle" font-family="'Inter', 'Helvetica Neue', Arial, sans-serif" font-weight="800" font-size="22" fill="#FFFFFF" letter-spacing="8">SEE YOU AT THE EVENT</text>
    <line x1="${width / 2 - 60}" y1="18" x2="${width / 2 + 60}" y2="18" stroke="#CF5317" stroke-width="3" />
  </g>

  <!-- Bottom Corner Orange Geometric Accents -->
  <polygon points="0,2048 240,2048 0,1880" fill="#CF5317" />
  <polygon points="1536,2048 1296,2048 1536,1880" fill="#CF5317" />
  <polygon points="0,2048 160,2048 0,1930" fill="#E86221" />
  <polygon points="1536,2048 1376,2048 1536,1930" fill="#E86221" />

</svg>
`;
}

/**
 * The details block under the artwork. Whatever the template's artwork already prints (its coverage) is left alone; everything
 * else the event has to say (dates, times, place, guest lines) is composed here, and the contact line always closes the card.
 */
function footerPlan(data: InvitationCardData, covered: Coverage) {
  // every kind of row this design can carry, found with a full set of sample details (whatever the event actually includes)
  const reserve = detailRows({ title: 'x', startIso: '2030-01-01T10:00:00.000Z', endIso: '2030-01-02T12:00:00.000Z', venue: 'x', locationSub: 'x', isVirtual: false, contactNumber: '9876543210', guestName: 'x', guestMeta: 'x' }, covered).map((r) => r.kind);
  const show = cardDisplayOf(data.cardDisplay);
  const hidden = new Set([...(show.title ? [] : ['title']), ...(show.dateTime ? [] : ['when']), ...(show.location ? [] : ['where'])]);
  const rows = detailRows({
    title: data.event.title,
    startIso: data.event.startIso,
    endIso: data.event.endIso,
    venue: data.event.venue,
    locationSub: data.event.locationSub,
    isVirtual: data.event.isVirtual,
    contactNumber: data.event.contactNumber,
    guestName: data.invitee.name,
    guestMeta: data.invitee.companyName
  }, covered).filter((row) => !hidden.has(row.kind));
  return { rows, reserve };
}

/**
 * The details block under the artwork. Whatever the template's artwork already prints (its coverage) is left alone; everything
 * else the event has to say (dates, times, place, guest lines) is composed here, and the contact line always closes the card.
 * `overlay` (an uploaded design): the block is printed over the picture's bottom with nothing behind it, instead of being added below.
 */
function withInfoFooter(png: Buffer, data: InvitationCardData, covered: Coverage, style: FooterStyle, overlay = false): Promise<Buffer> {
  const { rows, reserve } = footerPlan(data, covered);
  return appendInfoFooter(png, rows, style, reserve, overlay);
}

const dataUrlToBuffer = (dataUrl?: string): Buffer | undefined => {
  const match = dataUrl ? /^data:[^;]+;base64,(.+)$/.exec(dataUrl) : null;
  return match ? Buffer.from(match[1], 'base64') : undefined;
};

// The designers' templates (Figma): fixed artwork plus this event's content
async function renderFromTemplate(design: TemplateDesign, data: InvitationCardData): Promise<Buffer> {
  const allTexts = buildTemplateTexts({
    design,
    title: data.event.title || '',
    categoryName: data.event.categoryName,
    subcategoryName: data.event.subcategoryName,
    startIso: data.event.startIso,
    endIso: data.event.endIso,
    venue: data.event.venue,
    locationSub: data.event.locationSub,
    isVirtual: data.event.isVirtual,
    invitee: data.invitee
  });
  const show = cardDisplayOf(data.cardDisplay);
  const texts = withoutHidden(allTexts, show);

  let qr = show.qr ? dataUrlToBuffer(data.qrDataUrl) : undefined;
  if (show.qr && !qr && data.invitationUrl) {
    qr = await QRCode.toBuffer(data.invitationUrl, { errorCorrectionLevel: 'H', margin: 4, width: 480 });
  }
  const eventImage = dataUrlToBuffer(data.event.photoBase64);

  return renderTemplateCard({
    design,
    texts,
    qr,
    hideQr: !show.qr,
    hideImage: !show.logo,
    photo: eventImage,
    // corporate designs show the host's logo where personal designs show a photo; fall back to the LGPSM logo
    logo: eventImage || dataUrlToBuffer(getLogoBase64()),
    initials: photoInitials({ design, title: show.title ? data.event.title || '' : '' }, texts),
    useSamplePhoto: data.isPreview === true && !eventImage
  });
}

// A custom (AI-generated) design: the stored layout with this event's details and this guest's own QR code
async function renderFromSpec(fullSpec: DesignSpec, data: InvitationCardData, bottomInset = 0): Promise<Buffer> {
  const show = cardDisplayOf(data.cardDisplay);
  // a hidden QR takes its frame and its "scan" caption with it, and the card closes up where it was (see qrCollapse.ts)
  // An uploaded design's own empty QR box goes with the code: with the QR switched off the box (and its border) is painted out of the picture
  let source: DesignSpec = fullSpec;
  if (!show.qr && fullSpec.meta?.generator === 'UPLOAD') {
    const box = fullSpec.elements.find((e) => e.type === 'qr' && !!e.frameColor);
    if (box && box.type === 'qr') {
      const m = Math.round(box.size * 0.14); // past the box's own border (it sits just outside the code area)
      source = { ...fullSpec, elements: [{ type: 'patch', id: 'noqr', x: Math.max(0, box.x - m), y: Math.max(0, box.y - m), w: box.size + 2 * m, h: box.size + 2 * m }, ...fullSpec.elements.filter((e) => e.type !== 'qr')] } as DesignSpec;
    }
  }
  const collapse = show.qr ? null : qrCollapsePlan(source);
  const collapsed: DesignSpec = collapse ? ({ ...source, elements: collapse.elements } as DesignSpec) : source;
  // the event logo / picture turned off: the design's image slots are left out
  const spec: DesignSpec = show.logo ? collapsed : ({ ...collapsed, elements: collapsed.elements.filter((e) => e.type !== 'image') } as DesignSpec);
  const allTexts = buildSpecTexts({
    title: data.event.title || '',
    description: data.event.description,
    startIso: data.event.startIso,
    endIso: data.event.endIso,
    venue: data.event.venue,
    locationSub: data.event.locationSub,
    isVirtual: data.event.isVirtual,
    organizerName: data.event.organizerName,
    invitee: data.invitee
  });
  // A preview with nothing entered yet shows where each detail will go (the design's own wording is painted out, so it is never left reading as someone else's event)
  if (data.isPreview && spec.meta?.zones) {
    if (show.dateTime && !allTexts.dateTime && spec.elements.some((e) => e.type === 'text' && e.role === 'dateTime')) allTexts.dateTime = 'Date and time';
    if (show.location && !allTexts.venue && spec.elements.some((e) => e.type === 'text' && e.role === 'venue')) allTexts.venue = 'Event venue';
  }
  const texts = withoutHidden(allTexts, show);
  let qr = show.qr ? dataUrlToBuffer(data.qrDataUrl) : undefined;
  if (show.qr && !qr && data.invitationUrl) qr = await QRCode.toBuffer(data.invitationUrl, { errorCorrectionLevel: 'H', margin: 4, width: 480 });
  const eventImage = dataUrlToBuffer(data.event.photoBase64);
  const result = await renderDesignSpec({
    spec,
    texts,
    qr,
    photo: eventImage,
    logo: eventImage || dataUrlToBuffer(getLogoBase64()),
    showPlaceholders: data.isPreview === true,
    bottomInset
  });
  return result.png;
}

/**
 * The master card: its details are a column that closes up around whatever is switched off. The event's location is always printed
 * (it is mandatory); the guest's QR code, the logo, the title, the date and the additional information follow "Select data to show on card".
 * Nothing is added under or over it: no details block, no guest band.
 */
async function renderMasterFromData(data: InvitationCardData): Promise<Buffer> {
  const show = cardDisplayOf(data.cardDisplay);
  let qr = show.qr ? dataUrlToBuffer(data.qrDataUrl) : undefined;
  if (show.qr && !qr && data.invitationUrl) qr = await QRCode.toBuffer(data.invitationUrl, { errorCorrectionLevel: 'H', margin: 4, width: 480 });
  const logo = show.logo ? dataUrlToBuffer(data.event.photoBase64) : undefined;
  return renderMasterCard({
    title: show.title ? data.event.title || '' : '',
    primary: data.invitee?.name || '',
    secondary: data.invitee?.companyName || '',
    // (a preview with nothing entered yet shows where each detail will go)
    dateTime: show.dateTime ? masterDateTime(data.event.startIso, data.event.endIso) || (data.isPreview ? 'Event date and time' : '') : '',
    location: addressLine({ design: 'CORPORATE_V1', title: '', venue: data.event.venue, locationSub: data.event.locationSub, isVirtual: data.event.isVirtual }) || (data.isPreview ? 'Event location' : ''),
    logo,
    // the designers' placeholder logo only ever stands in on previews, never on a card that is sent
    useSampleLogo: show.logo && !logo && data.isPreview === true,
    qr
  });
}

export const invitationCardService = {
  /** SVG of the generic design. The template designs are drawn as images, see generateInvitationCardPNG. */
  async generateInvitationCardSVG(data: InvitationCardData): Promise<string> {
    return buildClassicSVG(data);
  },

  async generateInvitationCardPNG(data: InvitationCardData): Promise<Buffer> {
    if (data.cardDesign === 'MASTER' && !data.designSpec) return renderMasterFromData(data);
    if (data.designSpec) {
      const spec = data.designSpec;
      const covered = coverageOfSpec(spec);
      // an uploaded design is the card as it is: no details block is added under it or printed over it, and nothing is drawn behind the
      // guest's QR code and name
      if (spec.meta?.generator === 'UPLOAD') return renderFromSpec(spec, data);
      return withInfoFooter(await renderFromSpec(spec, data), data, covered, { ink: spec.palette.text, accent: spec.palette.primary });
    }
    if (isTemplateDesign(data.cardDesign)) {
      let png = await renderFromTemplate(data.cardDesign, data);
      let covered = coverageOfDesign(data.cardDesign);
      // a design with no place for the guest's name gets a band for it inside the card, in large type, rather than a line at the bottom
      if (!covered.guest) {
        const banded = await insertGuestBand(png, data.cardDesign, data.invitee.name, data.invitee.companyName, FOOTER_STYLES[data.cardDesign]);
        if (banded !== png) { png = banded; covered = { ...covered, guest: true, meta: true }; }
      }
      return withInfoFooter(png, data, covered, FOOTER_STYLES[data.cardDesign]);
    }
    const svgString = await this.generateInvitationCardSVG(data);
    return withInfoFooter(await sharp(Buffer.from(svgString)).png({ quality: 100 }).toBuffer(), data, coverageOfDesign('CLASSIC'), FOOTER_STYLES.CLASSIC);
  }
};
