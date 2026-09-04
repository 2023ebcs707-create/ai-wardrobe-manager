import { Router } from 'express';
import type { AuthResponse, MeResponse } from '@wardrobe/shared';
import type { Config } from '../config';
import { ApiError } from '../http/errors';
import { parseBody } from '../http/validate';
import { registerSchema, loginSchema } from '../auth/schemas';
import { hashPassword, verifyPassword } from '../auth/password';
import { signToken } from '../auth/tokens';
import { requireAuth } from '../auth/requireAuth';
import { User, toPublicUser, type UserDoc } from '../models/User';

// A real bcrypt hash of a value nobody can log in with. Comparing against it
// when the email is unknown keeps login timing roughly constant, so response
// time cannot be used to discover which emails are registered.
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEeO1oQ0d0Vy1uYRQnTeQmZbHVdXbQyfXpO';

export function createAuthRouter(config: Config): Router {
  const router = Router();

  router.post('/register', async (req, res) => {
    const input = parseBody(registerSchema, req.body);

    const passwordHash = await hashPassword(input.password);

    let doc: UserDoc;
    try {
      doc = (await User.create({
        name: input.name,
        email: input.email,
        passwordHash,
      })) as UserDoc;
    } catch (err) {
      // 11000 is MongoDB's duplicate-key error. Relying on the unique index
      // rather than a find-then-insert check keeps this correct under
      // concurrent registrations, where a check-first approach races.
      if ((err as { code?: number }).code === 11000) {
        throw new ApiError(409, 'EMAIL_TAKEN', 'That email is already registered');
      }
      throw err;
    }

    const body: AuthResponse = { token: signToken(String(doc._id), config), user: toPublicUser(doc) };
    res.status(201).json(body);
  });

  router.post('/login', async (req, res) => {
    const input = parseBody(loginSchema, req.body);

    const doc = (await User.findOne({ email: input.email.toLowerCase() })) as UserDoc | null;

    // Always run a comparison, even when no user exists, so the response time
    // does not reveal whether the email is registered.
    const hash = doc?.passwordHash ?? DUMMY_HASH;
    const matches = await verifyPassword(input.password, hash);

    if (!doc || !matches) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }

    const body: AuthResponse = { token: signToken(String(doc._id), config), user: toPublicUser(doc) };
    res.status(200).json(body);
  });

  router.get('/me', requireAuth(config), async (req, res) => {
    const doc = (await User.findById(req.userId)) as UserDoc | null;
    if (!doc) {
      // The token is validly signed but its user is gone (deleted account).
      throw new ApiError(401, 'UNAUTHORIZED', 'Your session is invalid or has expired');
    }
    const body: MeResponse = { user: toPublicUser(doc) };
    res.json(body);
  });

  return router;
}
