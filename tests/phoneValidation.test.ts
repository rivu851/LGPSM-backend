import { registerSchema, loginSchema } from '../src/validators/auth.validator';
import { manualCheckInSchema } from '../src/validators/checkIn.validator';
import { submitContactSchema } from '../src/validators/contact.validator';
import { createInviteeSchema, updateInviteeSchema } from '../src/validators/invitee.validator';
import { createUserSchema, updateProfileSchema, updateUserSchema } from '../src/validators/user.validator';
import { Role } from '../src/models/User';

const invalidNumber = '98765-43210';

describe('phone input validation', () => {
  it.each([
    ['registration', registerSchema, { fullName: 'Test User', email: 'test@example.com', password: 'password123', phone: invalidNumber }],
    ['login', loginSchema, { phone: invalidNumber, password: 'password123' }],
    ['profile update', updateProfileSchema, { phone: invalidNumber }],
    ['user creation', createUserSchema, { fullName: 'Test User', email: 'test@example.com', role: Role.SYSTEM_USER, phone: invalidNumber }],
    ['user update', updateUserSchema, { phone: invalidNumber }],
    ['invitee creation', createInviteeSchema, { body: { name: 'Test Guest', email: 'test@example.com', mobile: invalidNumber } }],
    ['invitee update', updateInviteeSchema, { body: { mobile: invalidNumber } }],
    ['manual check-in', manualCheckInSchema, { body: { eventId: '0123456789abcdef01234567', mobile: invalidNumber } }],
    ['contact form', submitContactSchema, { body: { name: 'Test User', email: 'test@example.com', phone: invalidNumber, message: 'A sufficiently long message.' } }],
  ])('rejects non-digit phone characters in %s input', (_name, schema, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });

  it('accepts digit-only phone numbers', () => {
    expect(registerSchema.safeParse({
      fullName: 'Test User',
      email: 'test@example.com',
      password: 'password123',
      phone: '9876543210',
    }).success).toBe(true);
  });
});
