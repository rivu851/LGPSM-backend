import { cardGuestLines } from '../src/utils/cardInfo';

const guest = { name: 'Moloy Roy', companyName: 'Proper Bounce', professionalIdentity: 'EMP-7' };

describe('cardGuestLines with "Invitee name" as its own checkbox', () => {
  it('prints the name, then the chosen details', () => {
    expect(cardGuestLines(guest, { primary: 'COMPANY_NAME', secondary: null }, { inviteeName: true })).toEqual({ name: 'Moloy Roy', companyName: 'Proper Bounce' });
    // two details: the second line carries both, joined
    expect(cardGuestLines(guest, { primary: 'COMPANY_NAME', secondary: 'PROFESSIONAL_IDENTITY' }, { inviteeName: true })).toEqual({ name: 'Moloy Roy', companyName: 'Proper Bounce · EMP-7' });
  });
  it('leaves the name off when unticked: the details fill the lines', () => {
    expect(cardGuestLines(guest, { primary: 'COMPANY_NAME', secondary: null }, { inviteeName: false })).toEqual({ name: 'Proper Bounce', companyName: '' });
    expect(cardGuestLines(guest, { primary: null, secondary: null }, { inviteeName: false })).toEqual({ name: '', companyName: '' });
  });
  it('never repeats the name when an older choice still names it', () => {
    expect(cardGuestLines(guest, { primary: 'INVITEE_NAME', secondary: 'COMPANY_NAME' }, { inviteeName: true })).toEqual({ name: 'Moloy Roy', companyName: 'Proper Bounce' });
  });
  it('shows sample labels in a preview with no guest', () => {
    expect(cardGuestLines(null, { primary: 'COMPANY_NAME', secondary: null }, { inviteeName: true })).toEqual({ name: 'Invitee Name', companyName: 'Company Name' });
  });
  it('keeps the old behaviour for an event made before the checkbox existed', () => {
    expect(cardGuestLines(guest, { primary: 'COMPANY_NAME', secondary: 'INVITEE_NAME' })).toEqual({ name: 'Proper Bounce', companyName: 'Moloy Roy' });
    expect(cardGuestLines(guest, null)).toEqual({ name: 'Moloy Roy', companyName: 'Proper Bounce' });
  });
});

describe('primary / secondary slots decide the large and the smaller line', () => {
  const guest = { name: 'Asha Rao', companyName: 'Acme' } as any;
  it('name in the secondary slot prints as the smaller line under the primary detail', () => {
    const lines = cardGuestLines(guest, { primary: 'COMPANY_NAME', secondary: 'INVITEE_NAME' }, { inviteeName: true });
    expect(lines).toEqual({ name: 'Acme', companyName: 'Asha Rao' });
  });
  it('name in the primary slot prints as the large line', () => {
    const lines = cardGuestLines(guest, { primary: 'INVITEE_NAME', secondary: 'COMPANY_NAME' }, { inviteeName: true });
    expect(lines).toEqual({ name: 'Asha Rao', companyName: 'Acme' });
  });
  it('nothing chosen prints no guest lines', () => {
    expect(cardGuestLines(guest, { primary: null, secondary: null }, { inviteeName: false })).toEqual({ name: '', companyName: '' });
  });
});
