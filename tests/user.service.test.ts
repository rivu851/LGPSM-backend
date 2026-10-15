import { userService } from '../src/services/user.service';
import { userRepository } from '../src/repositories/user.repository';
import { Role, User } from '../src/models/User';
import { Event } from '../src/models/Event';
import { SystemUserAssignment } from '../src/models/SystemUserAssignment';
import mongoose from 'mongoose';

jest.mock('../src/repositories/user.repository');
jest.mock('../src/models/Event');
jest.mock('../src/models/SystemUserAssignment');
jest.mock('../src/models/User', () => {
  const actual = jest.requireActual('../src/models/User');
  return { ...actual, User: { find: jest.fn() } };
});

describe('User Service — pagination and search', () => {
  const adminId = new mongoose.Types.ObjectId().toString();
  const organizerId = new mongoose.Types.ObjectId().toString();

  beforeEach(() => {
    jest.clearAllMocks();
    (userRepository.findPage as jest.Mock).mockResolvedValue([]);
    (userRepository.count as jest.Mock).mockResolvedValue(0);
  });

  it('defaults to page 1, limit 25', async () => {
    await userService.getUsers({ userId: adminId, role: Role.ADMIN });

    expect(userRepository.findPage).toHaveBeenCalledWith(expect.any(Object), 0, 25);
  });

  it('caps the requested limit at 100', async () => {
    await userService.getUsers({ userId: adminId, role: Role.ADMIN }, undefined, false, { limit: 5000 });

    expect(userRepository.findPage).toHaveBeenCalledWith(expect.any(Object), 0, 100);
  });

  it('never allows a limit below 1', async () => {
    await userService.getUsers({ userId: adminId, role: Role.ADMIN }, undefined, false, { limit: -5, page: -2 });

    expect(userRepository.findPage).toHaveBeenCalledWith(expect.any(Object), 0, 1);
  });

  it('computes skip from page and limit', async () => {
    await userService.getUsers({ userId: adminId, role: Role.ADMIN }, undefined, false, { page: 3, limit: 10 });

    expect(userRepository.findPage).toHaveBeenCalledWith(expect.any(Object), 20, 10);
  });

  it('builds a case-insensitive search filter across name, email and normalized phone', async () => {
    await userService.getUsers({ userId: adminId, role: Role.ADMIN }, undefined, false, { search: 'Jane' });

    const [query] = (userRepository.findPage as jest.Mock).mock.calls[0];
    expect(query.$or).toEqual(
      expect.arrayContaining([
        { fullName: expect.any(RegExp) },
        { email: expect.any(RegExp) },
      ])
    );
  });

  it('escapes regex metacharacters in the search term instead of letting them alter the match', async () => {
    await userService.getUsers({ userId: adminId, role: Role.ADMIN }, undefined, false, { search: 'a.b(c)' });

    const [query] = (userRepository.findPage as jest.Mock).mock.calls[0];
    const namePattern: RegExp = query.$or[0].fullName;
    expect(namePattern.source).toBe('a\\.b\\(c\\)');
  });

  it('scopes organizers to only their visible staff (SYSTEM_USER) accounts', async () => {
    (Event.find as jest.Mock).mockReturnValue({ distinct: jest.fn().mockResolvedValue([]) });
    (User.find as jest.Mock).mockReturnValue({ distinct: jest.fn().mockResolvedValue([]) });
    (SystemUserAssignment.find as jest.Mock).mockReturnValue({ distinct: jest.fn().mockResolvedValue([]) });

    await userService.getUsers({ userId: organizerId, role: Role.ORGANIZER });

    const [query] = (userRepository.findPage as jest.Mock).mock.calls[0];
    expect(query.role).toBe(Role.SYSTEM_USER);
    expect(query._id).toEqual({ $in: [] });
  });

  it('reports totalPages from total and limit', async () => {
    (userRepository.count as jest.Mock).mockResolvedValue(47);

    const result = await userService.getUsers({ userId: adminId, role: Role.ADMIN }, undefined, false, { limit: 20 });

    expect(result.total).toBe(47);
    expect(result.totalPages).toBe(3);
  });
});
