'use strict';

/**
 * STAGE 9 TASK 3 — seed a 100+ item wardrobe for Claim 11, reversibly.
 *
 * Claim 11 says a wardrobe of 100+ items takes about four seconds to render.
 * The handset is signed in as `gate7@example.com` and there is no way to read
 * its password out of the device's SecureStore, so the choice was between
 * driving a sign-out/sign-in with credentials nobody has, and seeding the
 * account that is already signed in. This does the second and puts it back.
 *
 * ## Reversibility, done the way the harness's own README demands
 *
 * `kill -9` cannot run a `finally`. The manifest naming every document and every
 * object key this script will create is written and **fsynced BEFORE the first
 * POST**, and every created id is appended and fsynced as it is created. If this
 * process dies at any point, `task3-restore-gate7.js` can still undo exactly
 * what happened, because the record of it is already on disk.
 *
 * ## Every item goes through the real `POST /items`
 *
 * Not a direct Mongo insert. The route runs the AI tagger, writes to MinIO, and
 * builds the document — an inserted document would be a different object from
 * the one the app renders, and Claim 11 is about what the app renders.
 *
 * ## The two encoded parts reproduce the client's own parameters
 *
 * `apps/mobile/src/images/compress.ts`  : longest edge <= 1280, JPEG quality 0.7
 * `apps/mobile/src/images/thumbnail.ts` : longest edge <= 320,  JPEG quality 0.6
 *
 * reproduced here with ImageMagick. THIS IS NOT THE SAME ENCODER as
 * `expo-image-manipulator`, and the byte sizes it produces are therefore close
 * to but not identical to what the device would upload. The device's own figures
 * for the same pipeline are measured separately for Claims 2/9/14 and are the
 * ones quoted there.
 *
 * ## What the source photographs are, and the caveat that travels with them
 *
 * The 18 real garment photographs in `services/ai/tests/fixtures/`. They are
 * **640 px on the longest edge — below the 1280 px cap** — so the image part is
 * re-encoded without ever being downscaled, while a real phone capture is
 * downscaled TO 1280. Per-item bytes here are therefore a FLOOR, not the
 * production figure. Stage 4 recorded the same caveat about the same fixtures
 * and it has not stopped being true.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { mintToken } = require('./lib/token');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

const COUNT = Number(arg('--count', '120'));
const USER_ID = arg('--user', '6a8d2cf5c307bcaecdc57d3e');
const API = arg('--api', 'http://localhost:3000');
const MANIFEST = arg('--manifest');
const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'services', 'ai', 'tests', 'fixtures');

const CATEGORIES = ['tshirt', 'shirt', 'trousers', 'jacket', 'dress', 'skirt', 'shorts', 'shoes', 'accessory', 'other'];
const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

function fsyncWrite(file, text) {
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, text);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}
function fsyncAppend(file, text) {
  const fd = fs.openSync(file, 'a');
  fs.writeSync(fd, text);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}

const magick = (args) => execFileSync('/opt/homebrew/bin/magick', args, { encoding: 'utf8' });

function encodeParts(src, workDir, i) {
  const dims = magick(['identify', '-format', '%w %h', src]).split(' ').map(Number);
  const [w, h] = dims;
  const long = Math.max(w, h);
  const image = path.join(workDir, `img-${i}.jpg`);
  const thumb = path.join(workDir, `thumb-${i}.jpg`);
  const imgArgs = ['convert', src];
  if (long > 1280) imgArgs.push('-resize', w >= h ? '1280x' : 'x1280');
  imgArgs.push('-quality', '70', image);
  magick(imgArgs);
  const tLong = Math.min(long, 320);
  magick(['convert', src, '-resize', w >= h ? `${tLong}x` : `x${tLong}`, '-quality', '60', thumb]);
  return { image, thumb, sourceBytes: fs.statSync(src).size, imageBytes: fs.statSync(image).size, thumbBytes: fs.statSync(thumb).size, w, h };
}

(async () => {
  if (!MANIFEST) throw new Error('--manifest is required: nothing is created before the undo record exists');
  const token = mintToken(USER_ID);
  const sources = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.jpg')).sort();
  if (sources.length === 0) throw new Error('no fixtures');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task3-seed-'));

  // THE UNDO RECORD FIRST. Before a single byte is written to gate7.
  fsyncWrite(MANIFEST, JSON.stringify({
    createdBy: 'scripts/perf/task3-seed-gate7.js',
    at: new Date().toISOString(),
    database: 'wardrobe_gate7',
    userId: USER_ID,
    intendedCount: COUNT,
    undo: 'node scripts/perf/task3-restore-gate7.js --manifest <this file>',
  }) + '\n');

  const created = [];
  for (let i = 0; i < COUNT; i += 1) {
    const src = path.join(FIXTURES, sources[i % sources.length]);
    const parts = encodeParts(src, workDir, i);
    const category = CATEGORIES[i % CATEGORIES.length];
    const season = SEASONS[i % SEASONS.length];
    const out = execFileSync('/usr/bin/curl', [
      '-s', '-m', '60', '-X', 'POST',
      '-H', `Authorization: Bearer ${token}`,
      '-F', `image=@${parts.image};type=image/jpeg`,
      '-F', `thumbnail=@${parts.thumb};type=image/jpeg`,
      '-F', `category=${category}`,
      '-F', `seasons=${season}`,
      `${API}/items`,
    ], { encoding: 'utf8' });
    let body;
    try { body = JSON.parse(out); } catch { throw new Error(`non-JSON from POST /items: ${out.slice(0, 300)}`); }
    if (!body.item) throw new Error(`POST /items failed at i=${i}: ${out.slice(0, 300)}`);
    const rec = { id: body.item.id, source: path.basename(src), category, ...parts, image: undefined, thumb: undefined };
    created.push(rec);
    fsyncAppend(MANIFEST, JSON.stringify({ createdItemId: body.item.id }) + '\n');
    fs.rmSync(parts.image, { force: true });
    fs.rmSync(parts.thumb, { force: true });
    if ((i + 1) % 20 === 0) process.stderr.write(`  seeded ${i + 1}/${COUNT}\n`);
  }
  fs.rmSync(workDir, { recursive: true, force: true });
  fsyncAppend(MANIFEST, JSON.stringify({ done: true, count: created.length, at: new Date().toISOString() }) + '\n');
  const bytes = created.map((c) => c.imageBytes);
  const tbytes = created.map((c) => c.thumbBytes);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  console.log(JSON.stringify({
    count: created.length,
    imageBytes: { min: Math.min(...bytes), max: Math.max(...bytes), mean: Math.round(sum(bytes) / bytes.length) },
    thumbnailBytes: { min: Math.min(...tbytes), max: Math.max(...tbytes), mean: Math.round(sum(tbytes) / tbytes.length) },
    manifest: MANIFEST,
  }, null, 2));
})();
