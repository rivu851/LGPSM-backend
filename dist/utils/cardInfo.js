"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CARD_INFO_FIELDS = void 0;
exports.cardGuestLines = cardGuestLines;
// "Additional Info" on the invitation card (Figma Event_Add event-5 / Event_Edit event-4: "Customize Information"):
// the organiser picks which guest detail goes on the card's two guest lines. Every card design already prints a
// main guest line and a smaller line under it, so the choice is applied by filling those two lines.
exports.CARD_INFO_FIELDS = ['INVITEE_NAME', 'COMPANY_NAME', 'PROFESSIONAL_IDENTITY', 'SECONDARY_IDENTITY'];
// What the previews print before there is a real guest (the labels the design shows)
const SAMPLE = {
    INVITEE_NAME: 'Invitee Name',
    COMPANY_NAME: 'Company Name',
    PROFESSIONAL_IDENTITY: 'Employee ID',
    SECONDARY_IDENTITY: 'Employee ID',
};
/**
 * The two guest lines for a card. Without a saved choice the card keeps its long-standing content (guest name, then
 * company). With a choice, each line carries the chosen detail, or stays empty when unticked or when the guest has no
 * value for it — nothing is invented. `guest` null means a preview with no real guest: the design's sample labels.
 */
function cardGuestLines(guest, cardInfo, cardDisplay) {
    const legacy = cardDisplay?.inviteeName === undefined;
    if (!legacy)
        return guestLinesWithNameChoice(guest, cardInfo, cardDisplay.inviteeName !== false);
    return legacyGuestLines(guest, cardInfo);
}
/**
 * Events made after "Invitee name" became a checkbox of its own (Settings > Select data to show on card): the name is printed when it is
 * ticked, and "Additional Information" supplies the other details. The card has two guest lines, so the values fill them in order
 * (name first, then the primary and secondary details); a third value is joined onto the second line with a dot.
 */
function guestLinesWithNameChoice(guest, cardInfo, showName) {
    const values = [];
    if (showName)
        values.push(guest ? (guest.name || '').trim() : SAMPLE.INVITEE_NAME);
    for (const field of [cardInfo?.primary, cardInfo?.secondary]) {
        if (!field || field === 'INVITEE_NAME')
            continue; // the name is its own checkbox now, never repeated here
        const v = guest ? labelled(detailOf(guest, field), field, cardInfo) : sampleOf(field, cardInfo);
        if (v)
            values.push(v);
    }
    return { name: values[0] || '', companyName: values.slice(1).join(' · ') };
}
/** The custom detail's title and whether it is printed in front of the value */
const labelOf = (field, cardInfo) => {
    if (field === 'PROFESSIONAL_IDENTITY')
        return { title: (cardInfo?.identityLabel || '').trim(), show: cardInfo?.showIdentityLabel === true };
    if (field === 'SECONDARY_IDENTITY')
        return { title: (cardInfo?.secondaryIdentityLabel || '').trim(), show: cardInfo?.showSecondaryIdentityLabel === true };
    return { title: '', show: false };
};
/** A guest's value for a detail, with the custom detail's title in front when the organizer chose to show it */
const labelled = (value, field, cardInfo) => {
    const { title, show } = labelOf(field, cardInfo);
    return value && show && title ? `${title}: ${value}` : value;
};
const sampleOf = (field, cardInfo) => {
    const { title, show } = labelOf(field, cardInfo);
    // the sample stands in for a value: the title itself, or "Title: Sample" when the title is printed in front of it
    if (show && title)
        return `${title}: Sample`;
    return title || SAMPLE[field];
};
const detailOf = (guest, field) => {
    if (field === 'COMPANY_NAME')
        return (guest.companyName || guest.company || '').trim();
    if (field === 'SECONDARY_IDENTITY')
        return (guest.secondaryIdentity || '').trim();
    if (field === 'INVITEE_NAME')
        return (guest.name || '').trim();
    return (guest.professionalIdentity || '').trim();
};
function legacyGuestLines(guest, cardInfo) {
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
            return sampleOf(field, cardInfo);
        return labelled(detailOf(guest, field), field, cardInfo);
    };
    return { name: value(cardInfo.primary), companyName: value(cardInfo.secondary) };
}
