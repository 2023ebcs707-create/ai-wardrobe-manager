import type { Request, RequestHandler } from 'express';
import type { Config } from '../config';
import { ApiError } from '../http/errors';
import { verifyToken } from './tokens';

// Global augmentation so every protected route can read `req.userId` with no
// cast, instead of each one repeating `(req as AuthedRequest).userId`. This
// matters because Stages 2, 5, 6, and 8 all mount protected routes through
// this middleware.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

// Kept for any call site that still wants a type guaranteeing userId is
// present (e.g. after this middleware has already run). New route code
// should just read `req.userId` directly via the augmentation above.
export interface AuthedRequest extends Request {
  userId: string;
}

export function requireAuth(config: Config): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization;
    const [scheme, token] = header?.split(' ') ?? [];

    if (!token || scheme?.toLowerCase() !== 'bearer') {
      next(new ApiError(401, 'UNAUTHORIZED', 'Authentication required'));
      return;
    }

    try {
      req.userId = verifyToken(token, config).sub;
      next();
    } catch (err) {
      next(err);
    }
  };
}
