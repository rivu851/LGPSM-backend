// "Select data to show on card" (Add Event > Settings): which of the event's own details are printed on every guest's card.
// Everything is shown unless the organizer unticks it. Hiding the QR is allowed: the guest's pass is then only on their invitation page.
export interface CardDisplay {
  title: boolean;
  qr: boolean;
  dateTime: boolean;
  location: boolean;
}

export const CARD_DISPLAY_DEFAULTS: CardDisplay = { title: true, qr: true, dateTime: true, location: true };

export function cardDisplayOf(raw?: Partial<CardDisplay> | null): CardDisplay {
  const r = raw || {};
  return {
    title: r.title !== false,
    qr: r.qr !== false,
    dateTime: r.dateTime !== false,
    location: r.location !== false,
  };
}

/** The text slots of the fixed designs and the text roles of custom designs, by the detail they print */
export const TITLE_SLOTS = ['title', 'names', 'honoree'];
export const DATE_SLOTS = ['datePill', 'timeLine', 'day', 'month', 'year', 'weekday', 'time', 'date', 'dateTime'];
export const LOCATION_SLOTS = ['address', 'venue'];
export const QR_SLOTS = ['scanLabel'];

/** The texts a card should print, with the hidden details removed */
export function withoutHidden(texts: Record<string, string>, show: CardDisplay): Record<string, string> {
  const drop = new Set([...(show.title ? [] : TITLE_SLOTS), ...(show.dateTime ? [] : DATE_SLOTS), ...(show.location ? [] : LOCATION_SLOTS), ...(show.qr ? [] : QR_SLOTS)]);
  return Object.fromEntries(Object.entries(texts).filter(([k]) => !drop.has(k)));
}
