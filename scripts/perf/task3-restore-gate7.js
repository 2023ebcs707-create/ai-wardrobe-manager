'use strict';

/**
 * STAGE 9 TASK 3 — undo everything Task 3 wrote to `wardrobe_gate7`.
 *
 * The gate7 database is Stage 7's device-gate fixture and the previous tasks
 * were told to leave it alone. Task 3 could not: the handset is signed in as
 * gate7@example.com and Claim 11 needs that account to hold 100+ items. So it
 * was seeded and this puts it back — the documents deleted by id, and their
 * MinIO objects deleted by key, so the fixture ends as it started.
 *
 * Ids come from the manifest, which was fsynced BEFORE each document was
 * created, so this works even against a seeding run that was killed. There is no
 * `DELETE /items/:id` in this API, so the deletion is direct: Mongo for the
 * documents, the MinIO S3 API for the objects.
 *
 *   node scripts/perf/task3-restore-gate7.js --manifest <f> [--also-ids a,b,c]
 *                                            [--dry-run]
 */

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const DRY = argv.includes('--dry-run');
const MANIFESTS = (arg('--manifest') || '').split(',').filter(Boolean);
const ALSO = (arg('--also-ids', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

const ids = new Set(ALSO);
for (const m of MANIFESTS) {
  for (const line of fs.readFileSync(m, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    if (rec.createdItemId) ids.add(rec.createdItemId);
  }
}
if (ids.size === 0) throw new Error('no ids to remove');

const idList = [...ids];
const mongoEval = `
const ids = ${JSON.stringify(idList)}.map((s) => ObjectId(s));
const docs = db.clothingitems.find({ _id: { $in: ids } }, { imageKey: 1, thumbnailKey: 1 }).toArray();
print(JSON.stringify(docs.map((d) => ({ id: String(d._id), imageKey: d.imageKey, thumbnailKey: d.thumbnailKey }))));
`;
const found = JSON.parse(
  execFileSync('/opt/podman/bin/podman',
    ['exec', 'ai-wardrobe-manager-mongo-1', 'mongosh', 'wardrobe_gate7', '--quiet', '--eval', mongoEval],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim());

console.log(`manifest ids: ${idList.length}; present in wardrobe_gate7: ${found.length}`);
if (DRY) { console.log(JSON.stringify(found.slice(0, 3), null, 2)); process.exit(0); }

// Objects first: a deleted document whose object survives is an orphan nobody
// can find again, whereas a surviving document whose object is gone is visible
// and fixable. Delete the harder-to-find thing while its name is still in hand.
const keys = [];
for (const d of found) { if (d.imageKey) keys.push(d.imageKey); if (d.thumbnailKey) keys.push(d.thumbnailKey); }

// Through MinIO's own S3 client, not `rm -rf` inside the container. Deleting an
// object's directory out from under a running MinIO leaves its own bookkeeping
// believing the object is still there; `removeObject` is the operation the
// server is expecting. The client is the one `apps/api` already depends on, so
// no dependency is added to the repo.
const path = require('node:path');
const Minio = require(require.resolve('minio', { paths: [path.join(__dirname, '..', '..', 'apps', 'api')] }));
const env = {};
for (const line of fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8').split('\n')) {
  const eq = line.indexOf('=');
  if (eq > 0 && !line.trim().startsWith('#')) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
}
const client = new Minio.Client({
  endPoint: env.MINIO_ENDPOINT, port: Number(env.MINIO_PORT), useSSL: false,
  accessKey: env.MINIO_ACCESS_KEY, secretKey: env.MINIO_SECRET_KEY,
});
let objectsDeleted = 0;
(async () => {
  for (const key of keys) {
    try { await client.removeObject(env.MINIO_BUCKET, key); objectsDeleted += 1; }
    catch (e) { console.error(`  could not remove ${key}: ${e.message}`); }
  }
  finish();
})();

function finish() {

const delEval = `
const ids = ${JSON.stringify(idList)}.map((s) => ObjectId(s));
const r = db.clothingitems.deleteMany({ _id: { $in: ids } });
print(JSON.stringify({ deleted: r.deletedCount, remainingForUser: db.clothingitems.countDocuments({}) }));
`;
const res = execFileSync('/opt/podman/bin/podman',
  ['exec', 'ai-wardrobe-manager-mongo-1', 'mongosh', 'wardrobe_gate7', '--quiet', '--eval', delEval],
  { encoding: 'utf8' }).trim();
console.log(`objects deleted: ${objectsDeleted} of ${keys.length}`);
console.log(`documents: ${res}`);
}
