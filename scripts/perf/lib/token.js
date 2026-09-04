'use strict';

/**
 * Mints the bearer token the harness uses, with the same secret and the same
 * `{ sub: userId }` payload `apps/api/src/auth/tokens.ts` signs.
 *
 * WHY NOT LOG IN OVER HTTP. `POST /auth/login` verifies a bcrypt hash, which
 * on this machine costs on the order of a hundred milliseconds by design. That
 * cost belongs to the login claim, not to the wardrobe-read claim, and paying
 * it once per measured run would put a bcrypt round inside the warm-up window
 * of every other number. Minting the token directly keeps each measurement
 * about the endpoint it names.
 *
 * The token is a REAL one: it is verified by the API's own `requireAuth`
 * middleware on every measured request, signature and expiry included.
 */

const path = require('node:path');
const { readDotEnv } = require('./api-instance');

const jwt = require(require.resolve('jsonwebtoken', {
  paths: [path.join(__dirname, '..', '..', '..', 'apps', 'api')],
}));

function mintToken(userId, options = {}) {
  const env = { ...readDotEnv(), ...process.env };
  const secret = options.secret || env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set (checked .env and the environment)');
  return jwt.sign({ sub: String(userId) }, secret, { expiresIn: options.expiresIn || '7d' });
}

module.exports = { mintToken };
