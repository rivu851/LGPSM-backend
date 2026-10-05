import { sessionService } from '../src/services/session.service';
import { sessionRepository } from '../src/repositories/session.repository';
import { Event } from '../src/models/Event';
import mongoose from 'mongoose';

jest.mock('../src/repositories/session.repository');
jest.mock('../src/models/Event');
// Event access resolves the caller's role from the user record
jest.mock('../src/models/User', () => {
  const actual = jest.requireActual('../src/models/User');
  return { ...actual, User: { findById: jest.fn(() => ({ select: () => ({ lean: async () => ({ role: 'ORGANIZER' }) }) })) } };
});

describe('Session Service', () => {
  const mockOrganizerId = new mongoose.Types.ObjectId().toString();
  const mockEventId = new mongoose.Types.ObjectId().toString();
  const mockSessionId = new mongoose.Types.ObjectId().toString();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should successfully create a session', async () => {
    const sessionData = {
      name: 'Morning Keynote',
      schedule: { start: new Date('2026-01-01T10:00:00Z'), end: new Date('2026-01-01T11:00:00Z') }
    };

    (Event.findOne as jest.Mock).mockResolvedValue({ 
      _id: mockEventId, 
      organizerId: mockOrganizerId,
      schedule: { start: new Date('2026-01-01T08:00:00Z'), end: new Date('2026-01-01T18:00:00Z') }
    });
    
    (sessionRepository.create as jest.Mock).mockResolvedValue({ ...sessionData, _id: mockSessionId });

    const result = await sessionService.createSession(mockEventId, mockOrganizerId, sessionData);

    expect(Event.findOne).toHaveBeenCalled();
    expect(sessionRepository.create).toHaveBeenCalled();
    expect(result._id).toBe(mockSessionId);
  });

  it('should fail if event does not exist', async () => {
    (Event.findOne as jest.Mock).mockResolvedValue(null);

    await expect(sessionService.createSession(mockEventId, mockOrganizerId, {}))
      .rejects
      .toThrow('EVENT_NOT_FOUND');
  });

  it('should get sessions for event', async () => {
    (Event.findOne as jest.Mock).mockResolvedValue({ _id: mockEventId });
    (sessionRepository.findByEventId as jest.Mock).mockResolvedValue([{ _id: mockSessionId }]);
    (sessionRepository.countByEventId as jest.Mock).mockResolvedValue(1);

    const result = await sessionService.getSessions(mockEventId, mockOrganizerId);
    
    expect(result.sessions.length).toBe(1);
    expect(result.total).toBe(1);
  });
});
