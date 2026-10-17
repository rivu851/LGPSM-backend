"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.invitationCardService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const sharp_1 = __importDefault(require("sharp"));
const qrcode_1 = __importDefault(require("qrcode"));
const CARD_WIDTH = 1536;
const CARD_HEIGHT = 2048;
const MONTH_NUMBERS = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
    JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12'
};
const MONTH_NAMES = {
    JAN: 'January', FEB: 'February', MAR: 'March', APR: 'April', MAY: 'May', JUN: 'June',
    JUL: 'July', AUG: 'August', SEP: 'September', OCT: 'October', NOV: 'November', DEC: 'December'
};
// `formatCardDate` produces e.g. "DEC 25, 2026"; the decorative wedding/rice-ceremony/
// birthday layouts want the day, month and year broken out separately.
function parseCardDateParts(eventDate) {
    const match = (eventDate || '').match(/^([A-Z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
    if (!match)
        return { day: '--', month: '--', monthName: '', year: '--' };
    const [, mon, day, year] = match;
    return {
        day: day.padStart(2, '0'),
        month: MONTH_NUMBERS[mon] || '--',
        monthName: MONTH_NAMES[mon] || '',
        year: year.slice(-2)
    };
}
// Helper to encode local logo to base64
function getLogoBase64() {
    try {
        const possiblePaths = [
            path_1.default.join(__dirname, '../../../Frontend/public/images/branding/Logo.png'),
            path_1.default.join(process.cwd(), '../Frontend/public/images/branding/Logo.png'),
            path_1.default.join(process.cwd(), 'public/images/branding/Logo.png'),
            '/home/subrata-saha/INTERNSHIP/Project/Frontend/public/images/branding/Logo.png'
        ];
        for (const logoPath of possiblePaths) {
            if (fs_1.default.existsSync(logoPath)) {
                const fileBuffer = fs_1.default.readFileSync(logoPath);
                return `data:image/png;base64,${fileBuffer.toString('base64')}`;
            }
        }
    }
    catch (err) {
        console.warn('Could not load LGPSM Logo.png from disk:', err);
    }
    return '';
}
// Decorative card assets bundled with this repo (src/assets/cardDesigns) — cached after first
// read since the same files are re-embedded on every card render.
const cardAssetCache = new Map();
function getCardAssetBase64(fileName) {
    const cached = cardAssetCache.get(fileName);
    if (cached !== undefined)
        return cached;
    let result = '';
    try {
        const assetPath = path_1.default.join(__dirname, '../assets/cardDesigns', fileName);
        if (fs_1.default.existsSync(assetPath)) {
            const buffer = fs_1.default.readFileSync(assetPath);
            const ext = path_1.default.extname(fileName).slice(1);
            result = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buffer.toString('base64')}`;
        }
    }
    catch (err) {
        console.warn(`Could not load card asset ${fileName}:`, err);
    }
    cardAssetCache.set(fileName, result);
    return result;
}
function escapeXml(unsafe = '') {
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
async function buildClassicSVG(data) {
    const width = CARD_WIDTH;
    const height = CARD_HEIGHT;
    // 1. Process QR Code
    let qrImageHref = data.qrDataUrl || '';
    if (!qrImageHref && data.invitationUrl) {
        qrImageHref = await qrcode_1.default.toDataURL(data.invitationUrl, {
            errorCorrectionLevel: 'H',
            margin: 1,
            color: { dark: '#000000', light: '#FFFFFF' }
        });
    }
    // 2. Process Logo
    const logoHref = getLogoBase64();
    // 3. Process Event Title
    const fullTitle = (data.event.title || '').trim();
    const titleWords = fullTitle.split(' ');
    let mainTitlePart = fullTitle;
    let yearPart = '';
    if (titleWords.length > 1 && /^\d{4}$/.test(titleWords[titleWords.length - 1])) {
        yearPart = titleWords.pop() || '';
        mainTitlePart = titleWords.join(' ');
    }
    const subtitleText = data.event.subtitle || '';
    const dateMain = data.event.date || '';
    const dateSub = data.event.dayOfWeek || '';
    const timeMain = data.event.startTime || '';
    const timeSub = data.event.timeSub || 'ONWARDS';
    const venueMain = data.event.venue || 'Venue to be announced';
    const venueSub = data.event.locationSub || '';
    const inviteeName = data.invitee.name || 'Guest';
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
// Shared QR + logo resolution used by every design below.
async function resolveQrAndLogo(data) {
    let qrImageHref = data.qrDataUrl || '';
    if (!qrImageHref && data.invitationUrl) {
        qrImageHref = await qrcode_1.default.toDataURL(data.invitationUrl, {
            errorCorrectionLevel: 'H',
            margin: 1,
            color: { dark: '#000000', light: '#FFFFFF' }
        });
    }
    return { qrImageHref, logoHref: getLogoBase64() };
}
// "Ultra Clear Excellence Awards" style — a corporate award/ID-badge card.
async function buildCorporateV1SVG(data) {
    const width = CARD_WIDTH;
    const height = CARD_HEIGHT;
    const { qrImageHref, logoHref } = await resolveQrAndLogo(data);
    const title = (data.event.title || '').trim();
    const employeeId = data.invitee.employeeId;
    const dateParts = parseCardDateParts(data.event.date);
    const venue = data.event.venue || 'Venue to be announced';
    const locationSub = data.event.locationSub || '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="cv1Glow" cx="50%" cy="0%" r="75%">
      <stop offset="0%" stop-color="#BFD9F2" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#F2F2F2" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="#F2F2F2" />
  <rect width="${width}" height="900" fill="url(#cv1Glow)" />

  ${logoHref
        ? `<image href="${logoHref}" x="${width / 2 - 170}" y="90" width="340" height="150" preserveAspectRatio="xMidYMid meet" />`
        : `<text x="${width / 2}" y="190" text-anchor="middle" font-family="'Inter', Arial, sans-serif" font-weight="900" font-size="64" fill="#004387">LGPSM</text>`}

  <text x="${width / 2}" y="330" text-anchor="middle" font-family="'Inter', Arial, sans-serif" font-weight="800" font-size="56" fill="#004387">
    <tspan x="${width / 2}" dy="0">${escapeXml(title)}</tspan>
  </text>
  <line x1="${width / 2 - 120}" y1="380" x2="${width / 2 + 120}" y2="380" stroke="#004387" stroke-width="3" />

  <text x="${width / 2}" y="460" text-anchor="middle" font-family="'Inter', Arial, sans-serif" font-weight="800" font-size="46" fill="#004387">${escapeXml(data.invitee.name || 'Guest')}</text>
  ${employeeId
        ? `<text x="${width / 2}" y="510" text-anchor="middle" font-family="'Inter', Arial, sans-serif" font-weight="700" font-size="28" fill="#EF851A">Employee ID #${escapeXml(employeeId)}</text>`
        : ''}

  <!-- Photo/QR stamp frame -->
  <g transform="translate(${width / 2 - 320}, 600)">
    <rect width="640" height="640" rx="16" fill="#FFFFFF" stroke="#004387" stroke-width="6" stroke-dasharray="4 10" />
    ${qrImageHref ? `<image href="${qrImageHref}" x="40" y="40" width="560" height="560" />` : ''}
  </g>

  <!-- Event date bar -->
  <rect x="${width / 2 - 460}" y="1330" width="920" height="110" fill="#EF851A" rx="8" />
  <text x="${width / 2}" y="1398" text-anchor="middle" font-family="'Inter', Arial, sans-serif" font-weight="800" font-size="40" fill="#FFFFFF">Event Date: ${escapeXml(data.event.date || '')}</text>

  <!-- Footer location -->
  <g transform="translate(${width / 2 - 260}, 1540)">
    <path d="M28 6C17.5 6 9 14.5 9 25C9 38 28 54 28 54C28 54 47 38 47 25C47 14.5 38.5 6 28 6Z" fill="#EF851A" />
    <circle cx="28" cy="23" r="8" fill="#FFFFFF" />
    <text x="65" y="32" font-family="'Inter', Arial, sans-serif" font-weight="800" font-size="34" fill="#004387">${escapeXml(venue)}</text>
    <text x="65" y="68" font-family="'Inter', Arial, sans-serif" font-weight="600" font-size="24" fill="#555555">${escapeXml(locationSub)} ${escapeXml(dateParts.year !== '--' ? `· ${data.event.dayOfWeek || ''}` : '')}</text>
  </g>
</svg>`;
}
// "Leadership Summit" style — bold corporate conference card.
async function buildCorporateV2SVG(data) {
    const width = CARD_WIDTH;
    const height = CARD_HEIGHT;
    const { qrImageHref, logoHref } = await resolveQrAndLogo(data);
    const title = (data.event.title || '').trim().toUpperCase();
    const role = data.invitee.companyName || '';
    const venue = data.event.venue || 'Venue to be announced';
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#FFFFFF" />

  ${logoHref
        ? `<image href="${logoHref}" x="${width / 2 - 170}" y="80" width="340" height="150" preserveAspectRatio="xMidYMid meet" />`
        : `<text x="${width / 2}" y="180" text-anchor="middle" font-family="'Inter', Arial, sans-serif" font-weight="900" font-size="64" fill="#0E318C">LGPSM</text>`}

  <text x="${width / 2}" y="330" text-anchor="middle" font-family="'Inter', Arial, sans-serif" font-weight="800" font-size="52" letter-spacing="2" fill="#0E318C">${escapeXml(title)}</text>

  <!-- QR frame with arrow brackets -->
  <text x="${width / 2 - 340}" y="720" font-family="'Inter', Arial, sans-serif" font-weight="800" font-size="40" fill="#15191C">&gt;&gt;&gt;</text>
  <text x="${width / 2 + 220}" y="720" font-family="'Inter', Arial, sans-serif" font-weight="800" font-size="40" fill="#15191C">&lt;&lt;&lt;</text>
  <g transform="translate(${width / 2 - 260}, 480)">
    <path d="M0,0 H520 V460 L260,540 L0,460 Z" fill="none" stroke="#E2350F" stroke-width="10" stroke-linejoin="round" />
    ${qrImageHref ? `<image href="${qrImageHref}" x="40" y="40" width="440" height="440" />` : ''}
  </g>
  <text x="${width / 2}" y="1070" text-anchor="middle" font-family="'Inter', Arial, sans-serif" font-weight="500" font-size="26" fill="#000000">Scan the QR code</text>

  <text x="${width / 2}" y="1160" text-anchor="middle" font-family="'Inter', Arial, sans-serif" font-weight="700" font-size="48" fill="#0E318C">${escapeXml(data.invitee.name || 'Guest')}</text>
  ${role ? `<text x="${width / 2}" y="1205" text-anchor="middle" font-family="'Inter', Arial, sans-serif" font-weight="600" font-size="32" fill="#E2350F">${escapeXml(role)}</text>` : ''}

  <!-- Date bar -->
  <rect x="${width / 2 - 460}" y="1290" width="920" height="110" rx="12" fill="#E2350F" />
  <path d="M30 20V36M68 20V36M20 44H78M24 28H74C78.4 28 82 31.6 82 36V72C82 76.4 78.4 80 74 80H24C19.6 80 16 76.4 16 72V36C16 31.6 19.6 28 24 28Z" transform="translate(${width / 2 - 440}, 1308) scale(0.8)" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <text x="${width / 2}" y="1360" text-anchor="middle" font-family="'Inter', Arial, sans-serif" font-weight="800" font-size="44" fill="#FFFFFF">${escapeXml(data.event.date || '')}</text>

  <!-- Bottom location band -->
  <rect x="0" y="1760" width="${width}" height="288" fill="#0E318C" />
  <g transform="translate(${width / 2 - 280}, 1860)">
    <circle cx="36" cy="36" r="36" fill="none" />
    <path d="M36 4C21 4 9 16 9 31C9 50 36 72 36 72C36 72 63 50 63 31C63 16 51 4 36 4Z" fill="#FFFFFF" />
    <circle cx="36" cy="30" r="11" fill="#0E318C" />
    <text x="86" y="52" font-family="'Inter', Arial, sans-serif" font-weight="800" font-size="52" fill="#FFFFFF">${escapeXml(venue)}</text>
  </g>
</svg>`;
}
// "Getting married" wedding reception card — cream, serif, botanical.
async function buildWeddingSVG(data) {
    const width = CARD_WIDTH;
    const height = CARD_HEIGHT;
    const { qrImageHref } = await resolveQrAndLogo(data);
    const serif = `'Georgia', 'Times New Roman', serif`;
    const names = (data.event.title || '').trim();
    const dateParts = parseCardDateParts(data.event.date);
    const venue = data.event.venue || 'Venue to be announced';
    const locationSub = data.event.locationSub || '';
    const photoHref = data.event.photoBase64 || '';
    // Simple decorative wreath: a ring of small leaf-like ellipses.
    let wreathLeaves = '';
    const leafCount = 28;
    for (let i = 0; i < leafCount; i++) {
        const angle = (i / leafCount) * Math.PI * 2;
        const r = 180;
        const cx = Math.cos(angle) * r;
        const cy = Math.sin(angle) * r;
        const rot = (angle * 180) / Math.PI + 90;
        wreathLeaves += `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="10" ry="26" fill="none" stroke="#8B9A7D" stroke-width="2" transform="rotate(${rot.toFixed(1)} ${cx.toFixed(1)} ${cy.toFixed(1)})" />`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="weddingPhotoClip"><circle cx="${width / 2}" cy="430" r="160" /></clipPath>
  </defs>
  <rect width="${width}" height="${height}" fill="#FFFDF8" />

  ${photoHref ? `<image href="${photoHref}" x="${width / 2 - 160}" y="270" width="320" height="320" preserveAspectRatio="xMidYMid slice" clip-path="url(#weddingPhotoClip)" />` : ''}
  <g transform="translate(${width / 2}, 430)">${wreathLeaves}</g>

  <text x="${width / 2}" y="760" text-anchor="middle" font-family="${serif}" font-size="58" fill="#202020">${escapeXml(names)}</text>
  <text x="${width / 2}" y="825" text-anchor="middle" font-family="${serif}" font-size="30" letter-spacing="8" fill="#202020">ARE GETTING MARRIED</text>
  <text x="${width / 2}" y="900" text-anchor="middle" font-family="${serif}" font-size="48" fill="#202020">${escapeXml(data.event.dayOfWeek || '')}, ${escapeXml(data.event.startTime || '')}</text>

  <!-- Date triad -->
  <g transform="translate(0, 980)" font-family="${serif}" font-size="48" fill="#202020" text-anchor="middle">
    <text x="${width / 2 - 230}" y="0">${dateParts.day}</text>
    <line x1="${width / 2 - 130}" y1="-35" x2="${width / 2 - 130}" y2="15" stroke="#202020" stroke-width="2" />
    <text x="${width / 2}" y="0">${dateParts.month}</text>
    <line x1="${width / 2 + 130}" y1="-35" x2="${width / 2 + 130}" y2="15" stroke="#202020" stroke-width="2" />
    <text x="${width / 2 + 230}" y="0">${dateParts.year}</text>
  </g>

  <!-- Ornate QR frame -->
  <g transform="translate(${width / 2 - 320}, 1080)">
    <rect width="640" height="640" rx="10" fill="#FFFDF8" stroke="#202020" stroke-width="3" />
    <rect x="16" y="16" width="608" height="608" rx="6" fill="none" stroke="#202020" stroke-width="1.5" stroke-dasharray="2 10" stroke-linecap="round" />
    ${qrImageHref ? `<image href="${qrImageHref}" x="60" y="60" width="520" height="520" />` : ''}
  </g>

  <text x="${width / 2}" y="1810" text-anchor="middle" font-family="${serif}" font-size="26" letter-spacing="8" fill="#202020">SCAN THE QR CODE</text>

  <g transform="translate(${width / 2 - 210}, 1870)">
    <path d="M18 2C9 2 2 9 2 18C2 30 18 46 18 46C18 46 34 30 34 18C34 9 27 2 18 2Z" fill="#202020" />
    <circle cx="18" cy="16" r="6" fill="#FFFDF8" />
    <text x="48" y="38" font-family="${serif}" font-size="40" fill="#202020">${escapeXml(venue)}${locationSub ? `, ${escapeXml(locationSub)}` : ''}</text>
  </g>
</svg>`;
}
// Rice-ceremony (annaprashan) card — deep maroon with gold ornamentation.
async function buildRiceCeremonySVG(data) {
    const width = CARD_WIDTH;
    const height = CARD_HEIGHT;
    const { qrImageHref } = await resolveQrAndLogo(data);
    const serif = `'Georgia', 'Times New Roman', serif`;
    const childName = (data.event.title || '').trim();
    const dateParts = parseCardDateParts(data.event.date);
    const venue = data.event.venue || 'Venue to be announced';
    const locationSub = data.event.locationSub || '';
    const photoHref = data.event.photoBase64 || '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="riceCeremonyPhotoClip"><circle cx="${width / 2}" cy="200" r="100" /></clipPath>
  </defs>
  <rect width="${width}" height="${height}" fill="#660410" />
  <!-- Gold border frame -->
  <rect x="50" y="50" width="${width - 100}" height="${height - 100}" fill="none" stroke="#D4A24C" stroke-width="3" />
  <rect x="64" y="64" width="${width - 128}" height="${height - 128}" fill="none" stroke="#D4A24C" stroke-width="1" />

  ${photoHref
        ? `<image href="${photoHref}" x="${width / 2 - 100}" y="100" width="200" height="200" preserveAspectRatio="xMidYMid slice" clip-path="url(#riceCeremonyPhotoClip)" />
  <circle cx="${width / 2}" cy="200" r="100" fill="none" stroke="#D4A24C" stroke-width="3" />`
        : ''}

  <text x="${width / 2}" y="320" text-anchor="middle" font-family="${serif}" font-size="54" letter-spacing="4" fill="#F7ECD9">RICE CEREMONY</text>
  <text x="${width / 2}" y="370" text-anchor="middle" font-family="${serif}" font-size="24" letter-spacing="6" fill="#D4A24C">OF OUR BELOVED CHILD</text>
  <text x="${width / 2}" y="450" text-anchor="middle" font-family="${serif}" font-style="italic" font-size="64" fill="#F7ECD9">${escapeXml(childName)}</text>

  <!-- Cream panel with QR -->
  <rect x="${width / 2 - 330}" y="560" width="660" height="660" rx="40" fill="#F7ECD9" stroke="#D4A24C" stroke-width="6" />
  <g transform="translate(${width / 2 - 260}, 630)">
    ${qrImageHref ? `<image href="${qrImageHref}" x="0" y="0" width="520" height="520" />` : ''}
  </g>

  <text x="${width / 2}" y="1290" text-anchor="middle" font-family="${serif}" font-size="26" letter-spacing="8" fill="#D4A24C">SCAN THE QR CODE</text>
  <text x="${width / 2}" y="1360" text-anchor="middle" font-family="${serif}" font-size="42" letter-spacing="2" fill="#F7ECD9">${escapeXml(data.event.dayOfWeek || '')}, ${escapeXml(data.event.startTime || '')}</text>

  <g transform="translate(0, 1440)" font-family="${serif}" font-size="42" fill="#F7ECD9" text-anchor="middle">
    <text x="${width / 2 - 220}" y="0">${dateParts.day}</text>
    <line x1="${width / 2 - 120}" y1="-32" x2="${width / 2 - 120}" y2="12" stroke="#D4A24C" stroke-width="2" />
    <text x="${width / 2}" y="0">${dateParts.month}</text>
    <line x1="${width / 2 + 120}" y1="-32" x2="${width / 2 + 120}" y2="12" stroke="#D4A24C" stroke-width="2" />
    <text x="${width / 2 + 220}" y="0">${dateParts.year}</text>
  </g>

  <text x="${width / 2}" y="1540" text-anchor="middle" font-family="${serif}" font-size="30" fill="#F7ECD9">${escapeXml(venue)}${locationSub ? `, ${escapeXml(locationSub)}` : ''}</text>
</svg>`;
}
// Birthday party card — dark background with gold confetti and balloons.
async function buildBirthdaySVG(data) {
    const width = CARD_WIDTH;
    const height = CARD_HEIGHT;
    const { qrImageHref } = await resolveQrAndLogo(data);
    const honoreeName = (data.event.title || '').trim();
    const dateParts = parseCardDateParts(data.event.date);
    const venue = data.event.venue || 'Venue to be announced';
    const locationSub = data.event.locationSub || '';
    // Gold balloons/confetti/gift-box corner art (from the approved invitation card design file),
    // composited with its real alpha mask. Falls back to a plain procedural dot scatter if the
    // bundled asset is ever missing so the card never breaks.
    const balloonsHref = getCardAssetBase64('birthday-balloons-corner.png');
    const balloonsDecoration = balloonsHref
        ? `<image href="${balloonsHref}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none" opacity="0.92" />`
        : (() => {
            const confettiSeeds = [0.08, 0.2, 0.33, 0.41, 0.52, 0.63, 0.71, 0.82, 0.91, 0.15, 0.27, 0.58, 0.76, 0.95];
            const dots = (yBase) => confettiSeeds
                .map((s, i) => {
                const cx = s * width;
                const cy = yBase + ((i * 37) % 80);
                const r = 4 + ((i * 13) % 10);
                const colors = ['#D4A24C', '#F2C879', '#FFFFFF'];
                return `<circle cx="${cx.toFixed(0)}" cy="${cy}" r="${r}" fill="${colors[i % colors.length]}" opacity="0.85" />`;
            })
                .join('');
            return dots(40) + dots(height - 120);
        })();
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bdayBg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#1F1A23"/>
      <stop offset="100%" stop-color="#120F14"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bdayBg)" />

  ${balloonsDecoration}

  <text x="${width / 2}" y="310" text-anchor="middle" font-family="'Inter', Arial, sans-serif" font-weight="500" font-size="28" letter-spacing="4" fill="#F2C879">PLEASE JOIN US TO CELEBRATE</text>
  <text x="${width / 2}" y="420" text-anchor="middle" font-family="'Georgia', serif" font-weight="700" font-size="84" fill="#D4A24C">Birthday Party</text>
  <text x="${width / 2}" y="520" text-anchor="middle" font-family="'Georgia', serif" font-style="italic" font-size="68" fill="#FFFFFF">${escapeXml(honoreeName)}</text>

  <!-- QR frame with gold ring -->
  <g transform="translate(${width / 2 - 300}, 620)">
    <circle cx="300" cy="300" r="300" fill="none" stroke="#D4A24C" stroke-width="8" />
    <circle cx="300" cy="300" r="260" fill="#FFFFFF" />
    ${qrImageHref ? `<image href="${qrImageHref}" x="80" y="80" width="440" height="440" />` : ''}
  </g>

  <text x="${width / 2}" y="1300" text-anchor="middle" font-family="'Inter', Arial, sans-serif" font-weight="500" font-size="26" letter-spacing="4" fill="#E0E0E0">Scan the QR code</text>

  <g transform="translate(0, 1400)" font-family="'Inter', Arial, sans-serif" fill="#FFFFFF" text-anchor="middle">
    <text x="${width / 2 - 220}" y="0" font-weight="700" font-size="40">${escapeXml(data.event.dayOfWeek || '')}</text>
    <line x1="${width / 2 - 70}" y1="-32" x2="${width / 2 - 70}" y2="12" stroke="#D4A24C" stroke-width="2" />
    <text x="${width / 2 + 90}" y="0" font-weight="700" font-size="40">At ${escapeXml(data.event.startTime || '')}</text>
  </g>

  <text x="${width / 2}" y="1560" text-anchor="middle" font-family="'Inter', Arial, sans-serif" font-weight="900" font-size="90" fill="#D4A24C">${dateParts.day}</text>
  <text x="${width / 2}" y="1610" text-anchor="middle" font-family="'Inter', Arial, sans-serif" font-weight="600" font-size="32" fill="#FFFFFF">${dateParts.monthName}</text>

  <text x="${width / 2}" y="1700" text-anchor="middle" font-family="'Inter', Arial, sans-serif" font-weight="500" font-size="30" fill="#E0E0E0">${escapeXml(venue)}${locationSub ? `, ${escapeXml(locationSub)}` : ''}</text>
</svg>`;
}
exports.invitationCardService = {
    async generateInvitationCardSVG(data) {
        switch (data.cardDesign) {
            case 'CORPORATE_V1':
                return buildCorporateV1SVG(data);
            case 'CORPORATE_V2':
                return buildCorporateV2SVG(data);
            case 'WEDDING':
                return buildWeddingSVG(data);
            case 'RICE_CEREMONY':
                return buildRiceCeremonySVG(data);
            case 'BIRTHDAY':
                return buildBirthdaySVG(data);
            case 'CLASSIC':
            default:
                return buildClassicSVG(data);
        }
    },
    async generateInvitationCardPNG(data) {
        const svgString = await this.generateInvitationCardSVG(data);
        const pngBuffer = await (0, sharp_1.default)(Buffer.from(svgString))
            .png({ quality: 100 })
            .toBuffer();
        return pngBuffer;
    }
};
