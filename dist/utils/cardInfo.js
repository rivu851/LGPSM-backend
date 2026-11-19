"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CARD_INFO_FIELDS = void 0;
exports.cardGuestLines = cardGuestLines;
const columnMeaning_1 = require("./columnMeaning");
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
    const valueOf = (field) => {
        if (field === 'INVITEE_NAME')
            return guest ? (guest.name || '').trim() : SAMPLE.INVITEE_NAME;
        return guest ? labelled(detailOf(guest, field, cardInfo), field, cardInfo) : sampleOf(field, cardInfo);
    };
    const slots = [cardInfo?.primary, cardInfo?.secondary];
    // The name is chosen in one of the two slots: the primary slot prints as the large line and the secondary slot as the smaller line under it.
    if (showName && slots.includes('INVITEE_NAME')) {
        return { name: slots[0] ? valueOf(slots[0]) : '', companyName: slots[1] ? valueOf(slots[1]) : '' };
    }
    // Older events (the name ticked on its own, not chosen in a slot): the name first, then the chosen details in order
    const values = [];
    if (showName)
        values.push(valueOf('INVITEE_NAME'));
    for (const field of slots) {
        if (!field || field === 'INVITEE_NAME')
            continue;
        const v = valueOf(field);
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
    // the second custom detail with no title typed yet has nothing to stand in for it: the line stays empty rather than showing another detail's name
    if (field === 'SECONDARY_IDENTITY')
        return title;
    return title || SAMPLE[field];
};
/** A custom title that only renames a column the Excel already has ("Ph No" for Mobile) prints that guest value, not a column of its own */
const standardValueFor = (guest, field, cardInfo) => {
    const title = field === 'PROFESSIONAL_IDENTITY' ? cardInfo?.identityLabel : field === 'SECONDARY_IDENTITY' ? cardInfo?.secondaryIdentityLabel : null;
    const meaning = (0, columnMeaning_1.meaningOf)(title);
    if (meaning === 'name')
        return (guest.name || '').trim();
    if (meaning === 'email')
        return (guest.email || '').trim();
    if (meaning === 'mobile')
        return (guest.mobile || '').trim();
    return null;
};
const detailOf = (guest, field, cardInfo) => {
    const standard = standardValueFor(guest, field, cardInfo);
    if (standard !== null)
        return standard;
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
        return labelled(detailOf(guest, field, cardInfo), field, cardInfo);
    };
    return { name: value(cardInfo.primary), companyName: value(cardInfo.secondary) };
}
