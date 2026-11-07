import bcrypt from 'bcrypt';

// 10 rounds in production; the test suite hashes hundreds of passwords, so it uses the cheapest setting
const SALT_ROUNDS = process.env.NODE_ENV === 'test' ? 4 : 10;

export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(SALT_ROUNDS);
  return bcrypt.hash(password, salt);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
