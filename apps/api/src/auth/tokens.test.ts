import jwt from 'jsonwebtoken';
import { signToken, verifyToken } from './tokens';
import { loadConfig } from '../config';
import { ApiError } from '../http/errors';

const config = loadConfig({ JWT_SECRET: 'token-test-secret' });
const other = loadConfig({ JWT_SECRET: 'a-different-secret' });

describe('tokens', () => {
  it('round-trips a user id', () => {
    const token = signToken('user-123', config);
    expect(verifyToken(token, config).sub).toBe('user-123');
  });

  it('rejects a token signed with a different secret', () => {
    const token = signToken('user-123', other);
    expect(() => verifyToken(token, config)).toThrow(ApiError);
  });

  it('rejects a tampered token', () => {
    const token = signToken('user-123', config);
    const tampered = token.slice(0, -3) + 'aaa';
    expect(() => verifyToken(tampered, config)).toThrow(ApiError);
  });

  it('rejects a structurally invalid token', () => {
    expect(() => verifyToken('not.a.jwt', config)).toThrow(ApiError);
  });

  it('rejects an expired token', () => {
    const shortLived = loadConfig({ JWT_SECRET: 'token-test-secret', JWT_EXPIRES_IN: '-1s' });
    const token = signToken('user-123', shortLived);
    expect(() => verifyToken(token, shortLived)).toThrow(ApiError);
  });

  it('throws ApiError with UNAUTHORIZED rather than leaking the jwt library error', () => {
    try {
      verifyToken('not.a.jwt', config);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('UNAUTHORIZED');
      expect((err as ApiError).status).toBe(401);
    }
  });

  it('rejects a validly signed token whose payload has no sub', () => {
    // Bypasses signToken to sign a payload lacking `sub` directly, so the
    // malformed-payload guard in verifyToken (not just signature checking)
    // is what's under test.
    const malformed = jwt.sign({ notSub: 'user-123' }, config.jwtSecret, { expiresIn: '1h' });
    try {
      verifyToken(malformed, config);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('UNAUTHORIZED');
      expect((err as ApiError).status).toBe(401);
    }
  });
});
