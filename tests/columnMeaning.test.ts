import { meaningsOf, meaningOf } from '../src/utils/columnMeaning';

describe('what a column heading means', () => {
  it.each([
    'Mobile', 'Mobile No', 'mobile no.', 'Mobile Number', 'Phone', 'Phone No', 'phone number', 'Ph No', 'ph. no', 'Ph', 'Contact', 'Contact No', 'contact number', 'Contact Number',
    'Telephone', 'Telephone No', 'Tel', 'Tel No', 'Cell', 'Cell Phone', 'Cellphone number', 'Whatsapp', 'WhatsApp No', 'Whatsapp number', 'Landline', 'MobileNo', 'PhoneNo', 'phone_number',
    'Telphone', 'Mobil No', 'Phon', 'Moble', 'PHONE', '  mobile   no  ', 'Mobile Phone', 'Guest Mobile', 'Guest Phone Number', 'Your Contact Number', 'Mob No', 'Mob', 'Phone 1', 'Mobile #1', 'Contact No.',
  ])('%s means the mobile number', (t) => { expect(meaningOf(t)).toBe('mobile'); });

  it.each([
    'Email', 'E-mail', 'e mail', 'Email Address', 'Email ID', 'E-mail Address', 'Mail', 'Mail ID', 'EmailID', 'Gmail', 'Emial', 'Guest Email', 'Your Email Address', 'EMAIL',
  ])('%s means the email', (t) => { expect(meaningOf(t)).toBe('email'); });

  it.each([
    'Name', 'Invitee Name', 'Guest Name', 'Name of Guest', 'Name of Invitee', 'Full Name', 'Attendee Name', 'Participant Name', 'First Name', 'Last Name', 'Surname', 'Guest', 'Invitee', 'Attendee',
    'Visitor Name', 'Delegate Name', 'Person Name', 'Nme of guest', 'Invite Name', 'Contact Person', 'Contact Name', 'Naam', 'NAME', 'Name of the Invitee',
  ])('%s means the name', (t) => { expect(meaningOf(t)).toBe('name'); });

  it.each(['Company', 'Company Name', 'Organization', 'Organisation Name', 'Org', 'Employer', 'Firm Name', 'Business Name'])('%s means the company', (t) => { expect(meaningOf(t)).toBe('company'); });

  it.each([
    'Designation', 'Employee ID', 'Badge No.', 'Badge No', 'Department', 'Table No', 'Seat Number', 'Guest Type', 'Roll Number', 'Membership ID', 'Age', 'Gender', 'City', 'Reference Code', 'Number', 'No', 'ID', '', '   ', 'Role', 'Position', 'Pass Type',
  ])('%s is a detail of its own', (t) => { expect(meaningOf(t)).toBeNull(); });

  it('a heading about two columns needs a person to decide', () => {
    expect(meaningsOf('Email and Phone').sort()).toEqual(['email', 'mobile']);
    expect(meaningOf('Email and Phone')).toBeNull();
  });
  it('is not fooled by case, spacing, punctuation or accents', () => {
    expect(meaningOf('  MOBILE—No. ')).toBe('mobile');
    expect(meaningOf('Téléphone')).toBe('mobile');
  });
});
