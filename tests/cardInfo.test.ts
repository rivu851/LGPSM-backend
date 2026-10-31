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
  it('previews print the organizer\'s own title instead of "Employee ID"', () => {
    expect(cardGuestLines(null, { primary: 'INVITEE_NAME', secondary: 'PROFESSIONAL_IDENTITY', identityLabel: 'Designation' }).companyName).toBe('Designation');
    expect(cardGuestLines(null, { primary: 'INVITEE_NAME', secondary: 'PROFESSIONAL_IDENTITY' }).companyName).toBe('Employee ID');
  });
});
