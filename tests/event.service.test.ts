import { eventService } from '../src/services/event.service';
import { eventRepository } from '../src/repositories/event.repository';
import { Category } from '../src/models/Category';
import { Template } from '../src/models/Template';
import mongoose from 'mongoose';

jest.mock('../src/repositories/event.repository');
jest.mock('../src/models/Category');
jest.mock('../src/models/Template');
jest.mock('../src/services/platformSettings.service', () => ({
  platformSettingsService: {
    applyEventFeatureRules: jest.fn(async (data: unknown) => data),
    currentRateSnapshot: jest.fn(async () => ({ ratePerInvitee: 2, currency: 'USD', lockedAt: new Date() }))
  }
}));
jest.mock('../src/services/alert.service', () => ({ alertService: { notifyAdmins: jest.fn(), notifyUser: jest.fn() } }));
jest.mock('../src/utils/eventAccess', () => ({
  findManageableEvent: jest.fn(async (eventId: string) => ({ _id: eventId, organizerId: 'owner-id' }))
}));

describe('Event Service', () => {
  const mockOrganizerId = new mongoose.Types.ObjectId().toString();
  const mockCategoryId = new mongoose.Types.ObjectId().toString();
  
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should successfully create an event', async () => {
    const eventData = {
      title: 'Test Event',
      categoryId: mockCategoryId
    };

    (Category.findById as jest.Mock).mockResolvedValue({ _id: mockCategoryId });
    (eventRepository.create as jest.Mock).mockResolvedValue({ ...eventData, _id: 'event123', status: 'DRAFT' });

    const result = await eventService.createEvent(mockOrganizerId, eventData);

    expect(Category.findById).toHaveBeenCalledWith(mockCategoryId);
    expect(eventRepository.create).toHaveBeenCalled();
    expect(result.status).toBe('DRAFT');
  });

  it('should fail if category does not exist', async () => {
    (Category.findById as jest.Mock).mockResolvedValue(null);

    await expect(eventService.createEvent(mockOrganizerId, { categoryId: mockCategoryId }))
      .rejects
      .toThrow('CATEGORY_NOT_FOUND');
  });

  it('should deactivate an event (soft delete)', async () => {
    (eventRepository.findByIdAndOrganizer as jest.Mock).mockResolvedValue({ _id: 'event123' });
    (eventRepository.softDeleteByIdAndOrganizer as jest.Mock).mockResolvedValue({ _id: 'event123', status: 'CANCELLED' });

    const result = await eventService.deactivateEvent('event123', mockOrganizerId);
    
    expect(eventRepository.softDeleteByIdAndOrganizer).toHaveBeenCalledWith('event123', 'owner-id');
    expect(result.status).toBe('CANCELLED');
  });
});
