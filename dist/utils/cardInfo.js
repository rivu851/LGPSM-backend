"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CARD_INFO_FIELDS = void 0;
exports.cardGuestLines = cardGuestLines;
// "Additional Info" on the invitation card (Figma Event_Add event-5 / Event_Edit event-4: "Customize Information"):
// the organiser picks which guest detail goes on the card's two guest lines. Every card design already prints a
// main guest line and a smaller line under it, so the choice is applied by filling those two lines.
exports.CARD_INFO_FIELDS = ['INVITEE_NAME', 'COMPANY_NAME', 'PROFESSIONAL_IDENTITY'];
// What the previews print before there is a real guest (the labels the design shows)
const SAMPLE = {
    INVITEE_NAME: 'Invitee Name',
    COMPANY_NAME: 'Company Name',
    PROFESSIONAL_IDENTITY: 'Employee ID',
};
/**
 * The two guest lines for a card. Without a saved choice the card keeps its long-standing content (guest name, then
 * company). With a choice, each line carries the chosen detail, or stays empty when unticked or when the guest has no
 * value for it — nothing is invented. `guest` null means a preview with no real guest: the design's sample labels.
 */
function cardGuestLines(guest, cardInfo) {
    const configured = !!cardInfo && (cardInfo.primary !== undefined || cardInfo.secondary !== undefined);
    if (!configured) {
        return guest
            ? { name: (guest.name || '').trim(), companyName: (guest.companyName || guest.company || '').trim() }
            : { name: 'Guest Name', companyName: '' };
    }
    const value = (field) => {
        if (!field)
            return '';
        if (!guest)
            return field === 'PROFESSIONAL_IDENTITY' && cardInfo?.identityLabel?.trim() ? cardInfo.identityLabel.trim() : SAMPLE[field];
        if (field === 'INVITEE_NAME')
            return (guest.name || '').trim();
        if (field === 'COMPANY_NAME')
            return (guest.companyName || guest.company || '').trim();
        return (guest.professionalIdentity || '').trim();
    };
    return { name: value(cardInfo.primary), companyName: value(cardInfo.secondary) };
}
