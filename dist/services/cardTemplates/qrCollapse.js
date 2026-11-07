"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.qrCollapsePlan = qrCollapsePlan;
function boxOf(e) {
    switch (e.type) {
        case 'qr': return { top: e.y, bottom: e.y + e.size, left: e.x, right: e.x + e.size };
        case 'line': return { top: Math.min(e.y1, e.y2), bottom: Math.max(e.y1, e.y2), left: Math.min(e.x1, e.x2), right: Math.max(e.x1, e.x2) };
        default: return { top: e.y, bottom: e.y + e.h, left: e.x, right: e.x + e.w };
    }
}
const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const isScanCaption = (e) => e.type === 'text' && e.role === 'label' && /scan/i.test(String(e.label || ''));
function moved(e, d) {
    if (e.type === 'line')
        return { ...e, y1: e.y1 - d, y2: e.y2 - d };
    return { ...e, y: e.y - d };
}
function qrCollapsePlan(spec) {
    const height = spec.canvas.height;
    const qr = spec.elements.find((e) => e.type === 'qr');
    if (!qr || qr.type !== 'qr')
        return { elements: spec.elements.filter((e) => !isScanCaption(e)), height, shift: 0 };
    const q = boxOf(qr);
    const near = (b) => b.top < q.bottom + qr.size * 0.6 && b.bottom > q.top - qr.size * 0.6;
    const group = new Set([qr]);
    for (const e of spec.elements) {
        if (e === qr)
            continue;
        const b = boxOf(e);
        // a frame: encloses the code and is at most about twice its size
        const encloses = (e.type === 'rect' || e.type === 'ellipse') && b.left <= q.left + 1 && b.top <= q.top + 1 && b.right >= q.right - 1 && b.bottom >= q.bottom - 1;
        if (encloses && b.right - b.left <= qr.size * 2.2 && b.bottom - b.top <= qr.size * 2.2)
            group.add(e);
        else if (isScanCaption(e) && near(b))
            group.add(e);
    }
    const kept = spec.elements.filter((e) => !group.has(e) && !isScanCaption(e));
    const asIs = { elements: kept, height, shift: 0 };
    if (spec.backgroundMedia)
        return asIs;
    const g = [...group].map(boxOf);
    const groupTop = Math.min(...g.map((b) => b.top));
    const groupBottom = Math.max(...g.map((b) => b.bottom));
    const kinds = new Map();
    for (const e of kept) {
        const b = boxOf(e);
        if (b.bottom <= groupTop + 0.5)
            kinds.set(e, 'above');
        else if (b.top < groupTop - 0.5 && b.bottom >= q.bottom - 0.5)
            kinds.set(e, 'spans'); // a panel / border around the code
        else if (b.top >= groupBottom - 0.5)
            kinds.set(e, 'moves');
        else if (e.type === 'line' && b.top >= groupTop - 0.5)
            kinds.set(e, 'moves'); // a thin line that starts beside the QR
        else
            return asIs; // something sits beside the QR (or reaches into it from above): leave the layout alone
    }
    const above = kept.filter((e) => kinds.get(e) === 'above').map(boxOf);
    const movers = kept.filter((e) => kinds.get(e) === 'moves').map(boxOf);
    const aboveBottom = above.length ? Math.max(...above.map((b) => b.bottom)) : 0;
    // the first thing that moves (the next element below, or a line that started beside the QR) lands where the group started
    const nextBelow = movers.length ? Math.min(...movers.map((b) => b.top)) : height;
    const d = Math.round((nextBelow - groupTop) * 100) / 100;
    if (d < 8)
        return asIs;
    // the content above the QR moves down by half the freed room, the content below it moves up by the other half
    const down = Math.round((d / 2) * 100) / 100;
    const elements = kept.map((e) => (kinds.get(e) === 'moves' ? moved(e, d - down) : kinds.get(e) === 'above' ? moved(e, -down) : e));
    // nothing may end up outside the canvas
    if (elements.some((e) => boxOf(e).bottom > height + 1 || boxOf(e).top < -1))
        return asIs;
    // nothing that moved may now overlap something that stayed in place (panels around the card excepted)
    const stayed = elements.filter((e, i) => kinds.get(kept[i]) === 'above').map(boxOf);
    const movedBoxes = elements.filter((e, i) => kinds.get(kept[i]) === 'moves').map(boxOf);
    if (movedBoxes.some((m) => stayed.some((s) => overlaps(m, s))))
        return asIs;
    return { elements, height, shift: d };
}
