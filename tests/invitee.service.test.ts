import { inviteeService } from '../src/services/invitee.service';
import { inviteeRepository } from '../src/repositories/invitee.repository';
import { Event } from '../src/models/Event';
import mongoose from 'mongoose';

jest.mock('../src/repositories/invitee.repository');
jest.mock('../src/models/Event');
// Event access resolves the caller's role from the user record
jest.mock('../src/models/User', () => {
  const actual = jest.requireActual('../src/models/User');
  return { ...actual, User: { findById: jest.fn(() => ({ select: () => ({ lean: async () => ({ role: 'ORGANIZER' }) }) })) } };
});
jest.mock('../src/models/Session');

describe('Invitee Service', () => {
  const mockOrganizerId = new mongoose.Types.ObjectId().toString();
  const mockEventId = new mongoose.Types.ObjectId().toString();
  const mockInviteeId = new mongoose.Types.ObjectId().toString();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should successfully create an invitee', async () => {
    const inviteeData = {
      name: 'John Doe',
      email: 'john@example.com'
    };

    (Event.findOne as jest.Mock).mockResolvedValue({ _id: mockEventId, organizerId: mockOrganizerId });
    (inviteeRepository.findByEmailOrMobile as jest.Mock).mockResolvedValue([]);
    (inviteeRepository.create as jest.Mock).mockResolvedValue({ ...inviteeData, _id: mockInviteeId });

    const result = await inviteeService.createInvitee(mockEventId, mockOrganizerId, inviteeData);

    expect(inviteeRepository.findByEmailOrMobile).toHaveBeenCalled();
    expect(inviteeRepository.create).toHaveBeenCalled();
    expect(result._id).toBe(mockInviteeId);
  });

  it('should prevent duplicate invitee creation', async () => {
    (Event.findOne as jest.Mock).mockResolvedValue({ _id: mockEventId });
    (inviteeRepository.findByEmailOrMobile as jest.Mock).mockResolvedValue([{ _id: 'someotherid' }]);

    await expect(inviteeService.createInvitee(mockEventId, mockOrganizerId, { email: 'john@example.com' }))
      .rejects
      .toThrow('DUPLICATE_INVITEE');
  });

  it('should update session access', async () => {
    const sessionId = new mongoose.Types.ObjectId().toString();
    (inviteeRepository.findById as jest.Mock).mockResolvedValue({ _id: mockInviteeId, eventId: mockEventId, sessionAccess: [] });
    (Event.findOne as jest.Mock).mockResolvedValue({ _id: mockEventId });
    
    // Have to mock the Session model for find
    const { Session } = require('../src/models/Session');
    Session.find.mockResolvedValue([{ _id: sessionId }]);

    (inviteeRepository.update as jest.Mock).mockResolvedValue({ _id: mockInviteeId, sessionAccess: [{ sessionId, allowed: true }] });

    const result = await inviteeService.updateSessionAccess(mockInviteeId, mockOrganizerId, [{ sessionId, allowed: true }]);
    
    expect(inviteeRepository.update).toHaveBeenCalled();
    expect(result.sessionAccess[0].allowed).toBe(true);
  });
});
