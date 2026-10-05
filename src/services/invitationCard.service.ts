import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import QRCode from 'qrcode';

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
  };
  sessions: CardSessionData[];
  qrDataUrl?: string;
  invitationUrl?: string;
}

// Helper to encode local logo to base64
function getLogoBase64(): string {
  try {
    const possiblePaths = [
      path.join(__dirname, '../../../Frontend/public/images/branding/Logo.png'),
      path.join(process.cwd(), '../Frontend/public/images/branding/Logo.png'),
      path.join(process.cwd(), 'public/images/branding/Logo.png'),
      '/home/subrata-saha/INTERNSHIP/Project/Frontend/public/images/branding/Logo.png'
    ];

    for (const logoPath of possiblePaths) {
      if (fs.existsSync(logoPath)) {
        const fileBuffer = fs.readFileSync(logoPath);
        return `data:image/png;base64,${fileBuffer.toString('base64')}`;
      }
    }
  } catch (err) {
    console.warn('Could not load LGPSM Logo.png from disk:', err);
  }
  return '';
}

function escapeXml(unsafe: string = ''): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const invitationCardService = {
  async generateInvitationCardSVG(data: InvitationCardData): Promise<string> {
    const width = 1536;
    const height = 2048;

    // 1. Process QR Code
    let qrImageHref = data.qrDataUrl || '';
    if (!qrImageHref && data.invitationUrl) {
      qrImageHref = await QRCode.toDataURL(data.invitationUrl, {
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
  },

  async generateInvitationCardPNG(data: InvitationCardData): Promise<Buffer> {
    const svgString = await this.generateInvitationCardSVG(data);
    const pngBuffer = await sharp(Buffer.from(svgString))
      .png({ quality: 100 })
      .toBuffer();
    return pngBuffer;
  }
};
