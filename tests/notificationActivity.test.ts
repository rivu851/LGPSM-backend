import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { User, Role } from '../src/models/User';
import { Notification } from '../src/models/Notification';
import { alertService } from '../src/services/alert.service';
import { categoryService } from '../src/services/category.service';
import { announceTemplate } from '../src/services/template.service';

jest.setTimeout(60000);

describe('informative notifications', () => {
  let mongo: MongoMemoryServer; let admin: any; let orgA: any; let orgB: any; let inactive: any;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Notification.deleteMany({})]);
    admin = await User.create({ fullName: 'Admin', email: 'admin@x.com', role: Role.ADMIN, isActive: true });
    orgA = await User.create({ fullName: 'A', email: 'a@x.com', role: Role.ORGANIZER, isActive: true });
    orgB = await User.create({ fullName: 'B', email: 'b@x.com', role: Role.ORGANIZER, isActive: true });
    inactive = await User.create({ fullName: 'C', email: 'c@x.com', role: Role.ORGANIZER, isActive: false });
  });

  it('check-ins roll up into one running count for the organizer and the admin, not one notice per scan', async () => {
    const event = { _id: new mongoose.Types.ObjectId(), title: 'Gala', organizerId: orgA._id };
    for (let i = 0; i < 3; i += 1) await alertService.guestCheckedIn(event, 'Sam');
    const mine = await Notification.find({ userId: orgA._id, type: 'GUEST_CHECK_IN' }).lean();
    const theirs = await Notification.find({ userId: admin._id, type: 'GUEST_CHECK_IN' }).lean();
    expect(mine).toHaveLength(1);
    expect(mine[0].count).toBe(3);
    expect(mine[0].message).toMatch(/3 guests have checked in to "Gala"/);
    expect(theirs).toHaveLength(1);
    expect(await Notification.countDocuments({ userId: orgB._id })).toBe(0); // another organizer hears nothing
  });

  it('a new category, subcategory or template is announced to every active organizer (and only them)', async () => {
    const category = await categoryService.createCategory({ name: 'Concerts' } as any);
    await categoryService.addSubcategory(String((category as any)._id), 'Rock night');
    await announceTemplate({ _id: new mongoose.Types.ObjectId(), name: 'Neon', isPublished: true, isSystemTemplate: true } as any);
    for (const org of [orgA, orgB]) {
      const titles = (await Notification.find({ userId: org._id }).lean()).map((n) => n.title).sort();
      expect(titles).toEqual(['New event category', 'New event subcategory', 'New invitation template']);
    }
    expect(await Notification.countDocuments({ userId: { $in: [admin._id, inactive._id] } })).toBe(0);
    // a draft is not announced
    await announceTemplate({ _id: new mongoose.Types.ObjectId(), name: 'Draft', isPublished: false } as any);
    expect(await Notification.countDocuments({ userId: orgA._id })).toBe(3);
  });
});
