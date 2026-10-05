import { systemUserAssignmentService } from '../src/services/systemUserAssignment.service';
import { systemUserAssignmentRepository } from '../src/repositories/systemUserAssignment.repository';
import { Event } from '../src/models/Event';
import { User, Role } from '../src/models/User';
import mongoose from 'mongoose';

jest.mock('../src/repositories/systemUserAssignment.repository');
jest.mock('../src/models/Event');
jest.mock('../src/models/User');
jest.mock('../src/models/Session');
jest.mock('../src/utils/eventAccess', () => ({
  findManageableEvent: jest.fn(async (eventId: string) => ({ _id: eventId })),
  getUserRole: jest.fn(async () => 'ORGANIZER')
}));
jest.mock('../src/services/user.service', () => ({
  // The organizer created/owns the staff account used in these tests
  staffVisibleToOrganizer: jest.fn(async () => [])
}));
import { staffVisibleToOrganizer } from '../src/services/user.service';

describe('SystemUserAssignment Service', () => {
  const mockOrganizerId = new mongoose.Types.ObjectId().toString();
  const mockEventId = new mongoose.Types.ObjectId().toString();
  const mockUserId = new mongoose.Types.ObjectId().toString();

  beforeEach(() => {
    jest.clearAllMocks();
    (staffVisibleToOrganizer as jest.Mock).mockResolvedValue([new mongoose.Types.ObjectId(mockUserId)]);
  });

  it('should create an assignment successfully', async () => {
    (Event.findOne as jest.Mock).mockResolvedValue({ _id: mockEventId });
    (User.findById as jest.Mock).mockResolvedValue({ _id: mockUserId, isActive: true, role: Role.SYSTEM_USER });
    (systemUserAssignmentRepository.findByUserAndEvent as jest.Mock).mockResolvedValue(null);
    (systemUserAssignmentRepository.create as jest.Mock).mockResolvedValue({ _id: 'assignment123' });

    const result = await systemUserAssignmentService.createAssignment(mockEventId, mockOrganizerId, { userId: mockUserId, sessionIds: [] });
    
    expect(systemUserAssignmentRepository.create).toHaveBeenCalled();
    expect(result._id).toBe('assignment123');
  });

  it('should prevent duplicate assignment', async () => {
    (Event.findOne as jest.Mock).mockResolvedValue({ _id: mockEventId });
    (User.findById as jest.Mock).mockResolvedValue({ _id: mockUserId, isActive: true, role: Role.SYSTEM_USER });
    (systemUserAssignmentRepository.findByUserAndEvent as jest.Mock).mockResolvedValue({ _id: 'existing' });

    await expect(systemUserAssignmentService.createAssignment(mockEventId, mockOrganizerId, { userId: mockUserId, sessionIds: [] }))
      .rejects
      .toThrow('DUPLICATE_ASSIGNMENT');
  });
});
