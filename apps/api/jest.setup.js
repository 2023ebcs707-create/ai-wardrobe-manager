// Node 19 turned on HTTP keep-alive by default for `http.globalAgent`, and
// this project runs on v26. Supertest binds a fresh ephemeral server per
// request and tears it down immediately afterwards, so a pooled keep-alive
// socket can be handed to a *different* server than the one it was opened
// against. When that happens the client reads a reply that belongs to another
// exchange: the observed symptoms were a concatenated-JSON parse failure and
// one test receiving another test's 404.
//
// It is rare -- twice in roughly twenty-five full runs -- which is precisely
// what makes it worth removing rather than tolerating. A suite that fails once
// in a dozen runs teaches everyone to re-run instead of read the failure, and
// this project's evidence standard depends on a red test meaning something.
//
// Disabling the pool costs a TCP handshake per request against localhost and
// nothing else; `--runInBand` already serialises these tests.
const http = require('node:http');
const https = require('node:https');

http.globalAgent.keepAlive = false;
https.globalAgent.keepAlive = false;

// ---------------------------------------------------------------------------
// The test database must never be the DEVELOPMENT database.
//
// Every integration suite in this package reaches Mongo one of two ways, and
// BOTH of them defaulted to `mongodb://localhost:27017/wardrobe` -- the exact
// database `pnpm dev:api` serves from:
//
//   * `loadConfig({ MONGO_URL: process.env.MONGO_URL })`, which falls back to
//     that URL in `src/config.ts`; and
//   * `process.env.MONGO_URL ?? 'mongodb://localhost:27017/wardrobe'`, written
//     out literally in `health.integration.test.ts` and
//     `models/ClothingItem.integration.test.ts`.
//
// Those suites then call `deleteMany({})` in `beforeEach`/`afterEach`. So with
// MONGO_URL unset -- the default for anyone who just runs the tests -- the
// suite silently empties the developer's own wardrobe. It is not hypothetical:
// during the Stage 7 device gate a test run wiped a seeded eight-item wardrobe
// mid-verification, and the app then correctly rendered its empty state, which
// read exactly like a UI defect. Ten minutes went into the wrong explanation.
//
// Setting it here rather than editing sixteen call sites means every present
// and future suite inherits the safe default, and an explicit MONGO_URL (CI,
// or a deliberate override) still wins.
process.env.MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/wardrobe_test';
