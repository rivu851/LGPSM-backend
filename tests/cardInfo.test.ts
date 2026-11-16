import { cardGuestLines } from '../src/utils/cardInfo';

// "Additional Info" (Figma Event_Add event-5): which guest details the card prints on its two guest lines
describe('card guest lines', () => {
  const guest = { name: 'Moloy Roy', companyName: 'PWT', professionalIdentity: 'Employee ID: 4521' };

  it('keeps the long-standing name-then-company lines when nothing was chosen', () => {
    expect(cardGuestLines(guest, undefined)).toEqual({ name: 'Moloy Roy', companyName: 'PWT' });
    expect(cardGuestLines(null, undefined)).toEqual({ name: 'Guest Name', companyName: '' });
  });

  it('prints the chosen details, in the chosen order', () => {
    expect(cardGuestLines(guest, { primary: 'INVITEE_NAME', secondary: 'PROFESSIONAL_IDENTITY' })).toEqual({ name: 'Moloy Roy', companyName: 'Employee ID: 4521' });
    expect(cardGuestLines(guest, { primary: 'COMPANY_NAME', secondary: 'INVITEE_NAME' })).toEqual({ name: 'PWT', companyName: 'Moloy Roy' });
  });

  it('leaves an unticked line, or a detail the guest does not have, empty instead of inventing it', () => {
    expect(cardGuestLines(guest, { primary: 'INVITEE_NAME', secondary: null })).toEqual({ name: 'Moloy Roy', companyName: '' });
    expect(cardGuestLines({ name: 'No Id' }, { primary: 'INVITEE_NAME', secondary: 'PROFESSIONAL_IDENTITY' })).toEqual({ name: 'No Id', companyName: '' });
  });

  it('shows the design’s sample labels in previews without a real guest', () => {
    expect(cardGuestLines(null, { primary: 'INVITEE_NAME', secondary: 'PROFESSIONAL_IDENTITY' })).toEqual({ name: 'Invitee Name', companyName: 'Employee ID' });
  });
});

describe('custom detail title', () => {
  it('a second custom detail with no title typed yet leaves its preview line empty (not "Employee ID")', () => {
    expect(cardGuestLines(null, { primary: 'INVITEE_NAME', secondary: 'SECONDARY_IDENTITY' }).companyName).toBe('');
  });

  it('previews print the organizer\'s own title instead of "Employee ID"', () => {
    expect(cardGuestLines(null, { primary: 'INVITEE_NAME', secondary: 'PROFESSIONAL_IDENTITY', identityLabel: 'Designation' }).companyName).toBe('Designation');
    expect(cardGuestLines(null, { primary: 'INVITEE_NAME', secondary: 'PROFESSIONAL_IDENTITY' }).companyName).toBe('Employee ID');
  });

  it('prints the second custom detail on its own line, and its own title on previews', () => {
    const info: any = { primary: 'PROFESSIONAL_IDENTITY', secondary: 'SECONDARY_IDENTITY', identityLabel: 'Badge', secondaryIdentityLabel: 'Table' };
    expect(cardGuestLines({ professionalIdentity: 'B1', secondaryIdentity: 'T9' }, info)).toEqual({ name: 'B1', companyName: 'T9' });
    expect(cardGuestLines(null, info)).toEqual({ name: 'Badge', companyName: 'Table' });
  });
});

describe('a custom title that only renames a standard column', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { cardGuestLines } = require('../src/utils/cardInfo');
  const guest = { name: 'Asha Rao', email: 'asha@example.com', mobile: '+919876543210', professionalIdentity: '' };
  it('prints that guest value under the organizer\'s own title (no column of its own)', () => {
    const info = { primary: 'PROFESSIONAL_IDENTITY', secondary: 'SECONDARY_IDENTITY', identityLabel: 'Ph No', secondaryIdentityLabel: 'Mail ID', showIdentityLabel: true, showSecondaryIdentityLabel: false };
    expect(cardGuestLines(guest, info, { inviteeName: true })).toEqual({ name: 'Asha Rao', companyName: 'Ph No: +919876543210 · asha@example.com' });
  });
  it('a title that is a detail of its own still reads the extra column', () => {
    const info = { primary: 'PROFESSIONAL_IDENTITY', secondary: null, identityLabel: 'Badge No.', showIdentityLabel: false };
    expect(cardGuestLines({ ...guest, professionalIdentity: 'B-17' }, info, { inviteeName: true }).companyName).toBe('B-17');
  });
});
