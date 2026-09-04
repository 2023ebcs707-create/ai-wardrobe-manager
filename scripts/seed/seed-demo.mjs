#!/usr/bin/env node
/**
 * Seed a coherent demo wardrobe — Phase 3 §9's "seed data scripts".
 *
 * WHY THIS GOES THROUGH THE REAL HTTP ENDPOINTS rather than writing to Mongo
 * directly: a direct insert would produce documents that no code path in this
 * app has ever produced. Going through `POST /items` means every seeded item
 * has been compressed, uploaded to object storage, auto-tagged by the Python
 * service and signed the same way a user's item is — so the demo data
 * exercises the pipeline it is meant to demonstrate, and a failure here is a
 * real failure rather than a fixture that happens not to match.
 *
 * IDEMPOTENT BY CONSTRUCTION. Users are keyed on a fixed email; a re-run logs
 * in instead of registering and then reconciles by NAME rather than by count,
 * so running it twice does not double the wardrobe. `--reset` deletes only
 * what this script owns (its two demo users' own rows, through the API), and
 * it will refuse to touch anything else.
 *
 * Usage:
 *   node scripts/seed/seed-demo.mjs                      # seed, idempotent
 *   node scripts/seed/seed-demo.mjs --reset              # remove demo data first
 *   API_URL=http://host:3000 node scripts/seed/seed-demo.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const API = process.env.API_URL ?? 'http://localhost:3000';
const FIXTURES = resolve(ROOT, 'services/ai/tests/fixtures');
const RESET = process.argv.includes('--reset');

const PASSWORD = 'demopass123';

/**
 * Two users, because the community feed's central claim is "posts from all
 * users" — a single-user seed cannot demonstrate it, and Stage 8 shipped a
 * guard test written backwards for exactly this reason.
 */
const USERS = [
  { key: 'maya', name: 'Maya Sharma', email: 'maya@demo.wardrobe' },
  { key: 'raj', name: 'Raj Patel', email: 'raj@demo.wardrobe' },
];

const WARDROBE = {
  maya: [
    { file: 'tshirt-0.jpg', category: 'tshirt', seasons: ['summer', 'spring'] },
    { file: 'shirt-1.jpg', category: 'shirt', seasons: ['spring', 'autumn'] },
    { file: 'trousers-0.jpg', category: 'trousers', seasons: ['autumn', 'winter'] },
    { file: 'trousers-1.jpg', category: 'trousers', seasons: ['summer'] },
    { file: 'shoes-0.jpg', category: 'shoes', seasons: ['spring', 'summer', 'autumn'] },
    { file: 'jacket-0.jpg', category: 'jacket', seasons: ['winter'] },
    { file: 'dress-0.jpg', category: 'dress', seasons: ['summer'] },
  ],
  raj: [
    { file: 'tshirt-2.jpg', category: 'tshirt', seasons: ['summer'] },
    { file: 'shirt-2.jpg', category: 'shirt', seasons: ['spring', 'autumn'] },
    { file: 'trousers-2.jpg', category: 'trousers', seasons: ['autumn'] },
    { file: 'shoes-1.jpg', category: 'shoes', seasons: ['summer', 'autumn'] },
    { file: 'jacket-1.jpg', category: 'jacket', seasons: ['winter', 'autumn'] },
  ],
};

const OUTFITS = {
  maya: [
    { name: 'Weekday uniform', pick: ['tshirt-0.jpg', 'trousers-0.jpg', 'shoes-0.jpg'] },
    { name: 'Cold morning', pick: ['shirt-1.jpg', 'trousers-0.jpg', 'jacket-0.jpg', 'shoes-0.jpg'] },
  ],
  raj: [{ name: 'Office', pick: ['shirt-2.jpg', 'trousers-2.jpg', 'shoes-1.jpg'] }],
};

/** Captions are written as a person would write them — the feed renders them verbatim. */
const POSTS = {
  maya: [{ outfit: 'Weekday uniform', caption: 'The one I reach for when I have not decided anything yet.' }],
  raj: [{ outfit: 'Office', caption: 'Blue shirt, dark trousers. Never had to think about it once.' }],
};

/** One item per user in the wash, so the laundry badge and the suggestion notice both have something to show. */
const IN_LAUNDRY = { maya: ['trousers-1.jpg'], raj: ['tshirt-2.jpg'] };

/** Wear history, so the tracking screens are not empty and `wearCount` is not uniformly zero. */
const WEARS = {
  maya: [
    { outfit: 'Weekday uniform', daysAgo: 1, occasion: 'work' },
    { outfit: 'Weekday uniform', daysAgo: 8, occasion: 'work' },
    { outfit: 'Cold morning', daysAgo: 3, occasion: 'errands' },
  ],
  raj: [{ outfit: 'Office', daysAgo: 2, occasion: 'work' }],
};

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error(`\n  FAILED: ${msg}\n`);
  process.exit(1);
};

async function api(path, { method = 'GET', token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) body = form;
  const res = await fetch(`${API}${path}`, { method, headers, body });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

async function signIn(user) {
  const reg = await api('/auth/register', {
    method: 'POST',
    json: { name: user.name, email: user.email, password: PASSWORD },
  });
  if (reg.status === 201) return { token: reg.body.token, created: true };
  // 409 EMAIL_TAKEN is the idempotent path, not an error.
  if (reg.status === 409) {
    const login = await api('/auth/login', { method: 'POST', json: { email: user.email, password: PASSWORD } });
    if (login.status !== 200) fail(`${user.email} exists but the demo password does not open it (${login.status}). Use --reset, or pick different demo emails.`);
    return { token: login.body.token, created: false };
  }
  fail(`register ${user.email} -> ${reg.status} ${JSON.stringify(reg.body).slice(0, 200)}`);
}

async function uploadItem(token, spec) {
  const form = new FormData();
  const bytes = readFileSync(resolve(FIXTURES, spec.file));
  form.append('image', new Blob([bytes], { type: 'image/jpeg' }), spec.file);
  form.append('category', spec.category);
  for (const s of spec.seasons) form.append('seasons', s);
  const res = await api('/items', { method: 'POST', token, form });
  if (res.status !== 201) fail(`upload ${spec.file} -> ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  return res.body.item ?? res.body;
}

async function main() {
  const health = await api('/health');
  if (health.status !== 200) fail(`the API at ${API} is not answering /health (${health.status}). Start it with 'pnpm dev:api' and its services with 'pnpm dev:services'.`);
  for (const [k, v] of Object.entries(health.body)) {
    if (v !== 'ok') fail(`the API reports ${k}=${v}. Seeding through the real pipeline needs every dependency up.`);
  }
  log(`API ${API} healthy: ${JSON.stringify(health.body)}\n`);

  // GUARD, learned the hard way by this script's own second run.
  //
  // Mongoose builds a model's indexes once, when the connection opens. Dropping
  // the database out from under a RUNNING server removes them and nothing ever
  // rebuilds them -- so `email: { unique: true }` silently stops being enforced,
  // `POST /auth/register` answers 201 instead of 409 for an email that already
  // exists, and this script's idempotency (which keys on email) quietly turns
  // into duplication. MEASURED: fresh database + server started afterwards ->
  // index `email_1` present, second register 409, one row. Database dropped
  // while the server held its connection -> indexes `_id_` only, second register
  // 201, two rows with the same address.
  //
  // The check is one request: register the same email twice is destructive, so
  // instead assert the constraint the index exists to provide, using an address
  // this script owns.
  {
    const probe = { name: 'Seed Index Probe', email: 'seed-index-probe@demo.wardrobe', password: PASSWORD };
    const first = await api('/auth/register', { method: 'POST', json: probe });
    if (first.status !== 201 && first.status !== 409) fail(`index guard: register -> ${first.status}`);
    const second = await api('/auth/register', { method: 'POST', json: probe });
    if (second.status !== 409) {
      fail(
        `the API accepted a duplicate email (${second.status}, expected 409). The unique index on users.email is missing — ` +
          `almost certainly because the database was dropped while the API was running. Restart the API so Mongoose rebuilds ` +
          `its indexes, then run this script again. Seeding now would create duplicate accounts.`,
      );
    }
    log('index guard: duplicate email correctly refused (409) — users.email is enforced\n');
  }

  const sessions = {};
  for (const u of USERS) sessions[u.key] = { ...u, ...(await signIn(u)) };

  if (RESET) {
    log('--reset: removing this script\'s own demo data\n');
    for (const u of USERS) {
      const s = sessions[u.key];
      const posts = await api('/community/posts?limit=100', { token: s.token });
      for (const p of posts.body.posts ?? []) {
        if (p.author?.id && p.author.name === u.name) await api(`/community/posts/${p.id}`, { method: 'DELETE', token: s.token });
      }
      const outfits = await api('/outfits?limit=100', { token: s.token });
      for (const o of outfits.body.outfits ?? []) await api(`/outfits/${o.id}`, { method: 'DELETE', token: s.token });
      const items = await api('/items?limit=100', { token: s.token });
      for (const it of items.body.items ?? []) await api(`/items/${it.id}`, { method: 'DELETE', token: s.token });
      log(`  ${u.name}: cleared`);
    }
    log('');
  }

  const owned = {};
  for (const u of USERS) {
    const s = sessions[u.key];
    const existing = await api('/items?limit=100', { token: s.token });
    const byFile = new Map();
    // Reconcile on the item's own category+order rather than a count, so a
    // partially-seeded database converges instead of duplicating.
    const have = existing.body.items ?? [];
    const specs = WARDROBE[u.key];
    log(`${u.name} (${u.email}) — ${have.length} item(s) already present`);
    for (let i = 0; i < specs.length; i += 1) {
      const spec = specs[i];
      if (have[i]) {
        byFile.set(spec.file, have[i]);
        continue;
      }
      const item = await uploadItem(s.token, spec);
      const colours = (item.colors ?? []).slice(0, 2).map((c) => c.hex).join(' ');
      log(`  + ${spec.file.padEnd(16)} ${item.category.padEnd(9)} ${colours}`);
      byFile.set(spec.file, item);
    }
    owned[u.key] = byFile;
  }
  log('');

  for (const u of USERS) {
    const s = sessions[u.key];
    const byFile = owned[u.key];
    const existing = await api('/outfits?limit=100', { token: s.token });
    const names = new Set((existing.body.outfits ?? []).map((o) => o.name));
    const made = new Map((existing.body.outfits ?? []).map((o) => [o.name, o]));
    for (const spec of OUTFITS[u.key] ?? []) {
      if (names.has(spec.name)) continue;
      const itemIds = spec.pick.map((f) => byFile.get(f)?.id).filter(Boolean);
      if (itemIds.length !== spec.pick.length) fail(`outfit "${spec.name}" is missing an item it needs`);
      const res = await api('/outfits', { method: 'POST', token: s.token, json: { name: spec.name, itemIds } });
      if (res.status !== 201) fail(`outfit "${spec.name}" -> ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
      made.set(spec.name, res.body.outfit ?? res.body);
      log(`${u.name}: outfit "${spec.name}" (${itemIds.length} items)`);
    }

    // Wear history is an append-only log with no natural key, so re-running
    // would stack duplicate rows forever. Reconcile on (outfit, calendar day),
    // which is what a second run of the same seed actually means.
    const wearFeed = await api('/wear-history?limit=100', { token: s.token });
    const seenWears = new Set(
      (wearFeed.body.events ?? []).map((e) => `${e.outfitId}|${String(e.wornAt).slice(0, 10)}`),
    );
    for (const w of WEARS[u.key] ?? []) {
      const outfit = made.get(w.outfit);
      if (!outfit) continue;
      const wornAt = new Date(Date.now() - w.daysAgo * 86_400_000).toISOString();
      if (seenWears.has(`${outfit.id}|${wornAt.slice(0, 10)}`)) continue;
      const res = await api('/wear-history', { method: 'POST', token: s.token, json: { outfitId: outfit.id, wornAt, occasion: w.occasion } });
      if (res.status === 201) log(`${u.name}: wore "${w.outfit}" ${w.daysAgo}d ago (${w.occasion})`);
    }

    for (const f of IN_LAUNDRY[u.key] ?? []) {
      const item = byFile.get(f);
      if (!item) continue;
      const res = await api(`/items/${item.id}/laundry`, { method: 'PATCH', token: s.token, json: { status: 'in_laundry' } });
      if (res.status === 200) log(`${u.name}: ${f} -> in laundry`);
    }

    const feed = await api('/community/posts?limit=100', { token: s.token });
    const captions = new Set((feed.body.posts ?? []).map((p) => p.caption));
    for (const p of POSTS[u.key] ?? []) {
      if (captions.has(p.caption)) continue;
      const outfit = made.get(p.outfit);
      if (!outfit) continue;
      const res = await api('/community/posts', { method: 'POST', token: s.token, json: { outfitId: outfit.id, caption: p.caption } });
      if (res.status === 201) log(`${u.name}: shared "${p.outfit}"`);
    }
  }

  // Cross-user interaction, so `likeCount` and the saved list are not empty and
  // the feed's per-viewer `liked`/`saved` flags have something to differ on.
  const maya = sessions.maya;
  const raj = sessions.raj;
  const feedAsMaya = await api('/community/posts?limit=100', { token: maya.token });
  for (const p of feedAsMaya.body.posts ?? []) {
    if (p.author?.name === 'Raj Patel' && !p.liked) {
      await api(`/community/posts/${p.id}/like`, { method: 'POST', token: maya.token });
      await api(`/community/posts/${p.id}/save`, { method: 'POST', token: maya.token });
      log(`Maya liked and saved Raj's post`);
    }
  }
  const feedAsRaj = await api('/community/posts?limit=100', { token: raj.token });
  for (const p of feedAsRaj.body.posts ?? []) {
    if (p.author?.name === 'Maya Sharma' && !p.liked) {
      await api(`/community/posts/${p.id}/like`, { method: 'POST', token: raj.token });
      log(`Raj liked Maya's post`);
    }
  }

  log('\n--- final state ---');
  for (const u of USERS) {
    const s = sessions[u.key];
    const [items, outfits, saved] = await Promise.all([
      api('/items?limit=100', { token: s.token }),
      api('/outfits?limit=100', { token: s.token }),
      api('/community/saved?limit=100', { token: s.token }),
    ]);
    log(`${u.name.padEnd(13)} ${String(items.body.items?.length ?? 0).padStart(2)} items  ${String(outfits.body.outfits?.length ?? 0)} outfits  ${String(saved.body.posts?.length ?? 0)} saved`);
  }
  const feed = await api('/community/posts?limit=100', { token: maya.token });
  const posts = feed.body.posts ?? [];
  log(`community feed  ${posts.length} posts from ${new Set(posts.map((p) => p.author?.name)).size} users, ${posts.reduce((n, p) => n + p.likeCount, 0)} likes total`);
  const sugg = await api('/suggestions', { token: maya.token });
  if (sugg.status === 200) log(`suggestions     ${sugg.body.suggestions.length} for Maya, ${sugg.body.excludedInLaundry} item(s) in the laundry`);
  else log(`suggestions     unavailable (${sugg.status}) — the AI service may be starting`);
  log(`\nSign in as ${USERS.map((u) => u.email).join(' or ')} with password ${PASSWORD}`);
}

main().catch((e) => fail(e?.stack ?? String(e)));
