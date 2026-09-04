'use strict';

/**
 * MongoDB access for the harness.
 *
 * The harness deliberately uses the RAW driver rather than Mongoose. Mongoose
 * adds document hydration, casting and middleware to every query, and this
 * module's job is to time what MongoDB does, not what Mongoose does on top of
 * it. Hydration cost is real and belongs in the API-latency number (where it
 * is measured end to end through the running server); it does not belong in
 * the query number.
 *
 * `mongodb` is not a direct dependency of this repo -- it arrives as
 * Mongoose's own dependency, and pnpm's strict layout means it is not
 * resolvable from the workspace root. It is resolved through Mongoose's real
 * location so the harness needs no `pnpm add` of its own, i.e. so building the
 * instrument does not alter the thing being measured.
 */

const path = require('node:path');

function resolveDriver() {
  const mongoosePkg = require.resolve('mongoose/package.json', {
    paths: [path.join(__dirname, '..', '..', '..', 'apps', 'api')],
  });
  const driverPath = require.resolve('mongodb', { paths: [path.dirname(mongoosePkg)] });
  return require(driverPath);
}

const { MongoClient } = resolveDriver();

async function getMongoClient(uri) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  return client;
}

function driverVersion() {
  const mongoosePkg = require.resolve('mongoose/package.json', {
    paths: [path.join(__dirname, '..', '..', '..', 'apps', 'api')],
  });
  const pkgPath = require.resolve('mongodb/package.json', { paths: [path.dirname(mongoosePkg)] });
  return require(pkgPath).version;
}

module.exports = { MongoClient, getMongoClient, driverVersion };
