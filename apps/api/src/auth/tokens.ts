import jwt from 'jsonwebtoken';
import type { Config } from '../config';
import { ApiError } from '../http/errors';

export function signToken(userId: string, config: Config): string {
  return jwt.sign({ sub: userId }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
}

export function verifyToken(token: string, config: Config): { sub: string } {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (typeof payload === 'string' || typeof payload.sub !== 'string') {
      throw new Error('malformed payload');
    }
    return { sub: payload.sub };
  } catch {
    // Collapse every jwt failure mode - bad signature, expired, malformed -
    // into one opaque 401. Distinguishing them tells an attacker whether a
    // token was ever valid.
    throw new ApiError(401, 'UNAUTHORIZED', 'Your session is invalid or has expired');
  }
}
