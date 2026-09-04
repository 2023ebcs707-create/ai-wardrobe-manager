import mongoose from 'mongoose';
import { connectDatabase } from '../db';
import { User, toPublicUser, type UserDoc } from './User';
import { hashPassword } from '../auth/password';

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017/wardrobe_test_users';

describe('User model against live MongoDB', () => {
  beforeAll(async () => {
    await connectDatabase(MONGO_URL);
    // Build the unique index before any test runs. Without this the first
    // duplicate insert can succeed, because mongoose's autoIndex is
    // asynchronous and races the test. Verified: the duplicate slipped
    // through intermittently without it.
    await User.init();
  }, 30000);

  beforeEach(async () => {
    await User.deleteMany({});
  });

  afterAll(async () => {
    await User.deleteMany({});
    await mongoose.disconnect();
  });

  it('stores a user and exposes it without the password hash', async () => {
    const doc = (await User.create({
      name: 'Zaid',
      email: 'zaid@example.com',
      passwordHash: await hashPassword('password123'),
    })) as UserDoc;

    const pub = toPublicUser(doc);
    expect(pub.name).toBe('Zaid');
    expect(pub.email).toBe('zaid@example.com');
    expect(typeof pub.createdAt).toBe('string');
    expect(JSON.stringify(pub)).not.toContain('$2b$');
    expect(Object.keys(pub)).not.toContain('passwordHash');
  });

  it('lowercases and trims the email on save', async () => {
    const doc = (await User.create({
      name: 'Case Test',
      email: '  MiXeD@Example.COM  ',
      passwordHash: await hashPassword('password123'),
    })) as UserDoc;
    expect(doc.email).toBe('mixed@example.com');
  });

  it('rejects a duplicate email with error code 11000', async () => {
    const hash = await hashPassword('password123');
    await User.create({ name: 'First', email: 'dup@example.com', passwordHash: hash });
    await expect(
      User.create({ name: 'Second', email: 'dup@example.com', passwordHash: hash }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('treats differently-cased duplicates as the same email', async () => {
    const hash = await hashPassword('password123');
    await User.create({ name: 'First', email: 'case@example.com', passwordHash: hash });
    await expect(
      User.create({ name: 'Second', email: 'CASE@EXAMPLE.COM', passwordHash: hash }),
    ).rejects.toMatchObject({ code: 11000 });
  });
});
