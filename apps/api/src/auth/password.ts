import bcrypt from 'bcrypt';

const COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    // bcrypt throws on a malformed hash; treat that as "does not match"
    // rather than surfacing a 500 on a corrupted record.
    return false;
  }
}
