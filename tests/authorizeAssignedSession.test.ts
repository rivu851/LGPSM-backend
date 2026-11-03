import { authorizeAssignedSession } from '../src/middlewares/authorizeStaff';
import { Role } from '../src/models/User';

// "All sessions" is stored as an empty list; limited staff have a list of session ids.
const run = async (assignment: any, sessionId?: string) => {
  const req: any = { user: { role: Role.SYSTEM_USER }, params: sessionId ? { sessionId } : {}, body: {}, assignment };
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await authorizeAssignedSession(req, res, next);
  return { res, next };
};

describe('authorizeAssignedSession', () => {
  it('lets staff assigned to all sessions (empty list) into any session', async () => {
    const { next, res } = await run({ sessionIds: [] }, 'aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('lets limited staff into their own sessions only', async () => {
    const own = { toString: () => 'aaaaaaaaaaaaaaaaaaaaaaaa' };
    expect((await run({ sessionIds: [own] }, 'aaaaaaaaaaaaaaaaaaaaaaaa')).next).toHaveBeenCalled();
    const denied = await run({ sessionIds: [own] }, 'bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(denied.next).not.toHaveBeenCalled();
    expect(denied.res.status).toHaveBeenCalledWith(403);
  });
});
