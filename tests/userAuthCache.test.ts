import { createUserAuthCache } from '../src/utils/userAuthCache';

describe('userAuthCache', () => {
  it('serves a stored account until the TTL passes, then asks again', () => {
    let t = 1_000;
    const cache = createUserAuthCache(10_000, () => t);
    cache.set('u1', { role: 'ORGANIZER', isActive: true });
    expect(cache.get('u1')).toEqual({ role: 'ORGANIZER', isActive: true });
    t += 9_999;
    expect(cache.get('u1')).toBeDefined();
    t += 2;
    expect(cache.get('u1')).toBeUndefined();
  });

  it('forgets everything when cleared, so a role or active-flag change applies at once', () => {
    const cache = createUserAuthCache(10_000);
    cache.set('u1', { role: 'ADMIN', isActive: true });
    cache.set('u2', { role: 'SYSTEM_USER', isActive: true });
    cache.clear();
    expect(cache.get('u1')).toBeUndefined();
    expect(cache.get('u2')).toBeUndefined();
  });

  it('with a zero TTL never caches', () => {
    const cache = createUserAuthCache(0);
    cache.set('u1', { role: 'ADMIN', isActive: true });
    expect(cache.get('u1')).toBeUndefined();
  });
});
