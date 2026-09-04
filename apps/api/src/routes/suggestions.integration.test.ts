import request from 'supertest';
import mongoose from 'mongoose';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SUGGESTION_LIMIT, MAX_SUGGESTION_LIMIT } from '@wardrobe/shared';
import { createApp } from '../app';
import { loadConfig } from '../config';
import { connectDatabase } from '../db';
import { User } from '../models/User';
import { ClothingItem, type ClothingItemDoc } from '../models/ClothingItem';
import { createStorageProvider } from '../storage/MinioStorageProvider';

const config = loadConfig({
  JWT_SECRET: 'suggestions-test-secret',
  MONGO_URL: process.env.MONGO_URL,
});
const storage = createStorageProvider(config);
const okChecks = {
  database: async () => 'ok' as const,
  storage: async () => 'ok' as const,
  ai: async () => 'ok' as const,
};
const app = createApp(okChecks, config, storage);

/**
 * A second app whose AI service is genuinely not there.
 *
 * Port 1 on loopback refuses instantly, so this is an unreachable AI service
 * and nothing else — no container is stopped, nothing outside this process is
 * touched, and no other suite can be affected by it. `items.integration`'s
 * fail-soft test has to stop the real container because it exercises the
 * upload path's own client; here the dependency is reached by URL, so
 * changing the URL is the whole experiment.
 */
const deadAiConfig = { ...config, aiServiceUrl: 'http://127.0.0.1:1' };
const deadAiApp = createApp(okChecks, deadAiConfig, storage);

/**
 * One HTTP server per app for the whole file, instead of one per request.
 *
 * `request(server)` makes supertest create a fresh `http.createServer` and
 * `app.listen(0)` it for EVERY request, closing it immediately afterwards.
 * That churn is what made the outfits suite flaky — a torn-down ephemeral
 * port can be recycled by the OS and a socket held open against the old
 * server then carries a reply belonging to another exchange. Handing
 * supertest an already-listening server removes the per-request listen/close
 * entirely.
 */
let server: Server;
let deadAiServer: Server;

let token = '';
let ownerId = '';

beforeAll(async () => {
  server = app.listen(0);
  deadAiServer = deadAiApp.listen(0);
  await connectDatabase(config.mongoUrl);
  await User.init();
  await ClothingItem.init();
}, 30000);

async function clean(): Promise<void> {
  await User.deleteMany({});
  await ClothingItem.deleteMany({});
}

beforeEach(async () => {
  await clean();
  const res = await request(server)
    .post('/auth/register')
    .send({ name: 'Owner', email: 'owner@example.com', password: 'password123' });
  token = res.body.token;
  ownerId = res.body.user.id;
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  await clean();
  await mongoose.disconnect();
  for (const s of [server, deadAiServer]) {
    // closeAllConnections first: `close()` alone waits for live sockets and
    // would hang this hook rather than fail it.
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

const RED = { hex: '#cc0000', name: 'red', share: 1 };
// Hue 30 — within the engine's 40 degree analogous band of red's hue 0.
const ORANGE = { hex: '#cc6600', name: 'orange', share: 1 };

async function seedItem(
  owner: string,
  overrides: Record<string, unknown> = {},
): Promise<ClothingItemDoc> {
  const id = randomUUID();
  return (await ClothingItem.create({
    userId: owner,
    imageKey: `items/${owner}/${id}.jpg`,
    thumbnailKey: `items/${owner}/${id}-thumb.jpg`,
    category: 'tshirt',
    source: 'manual',
    ...overrides,
  })) as ClothingItemDoc;
}

/** A top and a bottom the engine can compose into exactly one outfit. */
async function seedPair(owner: string): Promise<{ top: ClothingItemDoc; bottom: ClothingItemDoc }> {
  // Sequential, so the ObjectIds ascend with creation order — that is what
  // lets an ordering assertion tell the engine's order from Mongo's.
  const top = await seedItem(owner, { category: 'shirt', colors: [RED] });
  const bottom = await seedItem(owner, { category: 'trousers', colors: [ORANGE] });
  return { top, bottom };
}

function suggestions(query = '', as = token) {
  return request(server).get(`/suggestions${query}`).set('Authorization', `Bearer ${as}`);
}

async function registerOther(email: string): Promise<{ token: string; id: string }> {
  const res = await request(server)
    .post('/auth/register')
    .send({ name: 'Other', email, password: 'password123' });
  return { token: res.body.token, id: res.body.user.id };
}

/** Stand in for the AI service so a response shape can be dictated exactly. */
function stubEngine(body: unknown): jest.SpyInstance {
  return jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
}

interface EngineRequestBody {
  items: { id: string; category: string; colours: unknown[]; seasons: string[] }[];
  season?: string;
  occasion?: string;
  limit: number;
}

function engineRequest(spy: jest.SpyInstance): EngineRequestBody {
  expect(spy).toHaveBeenCalledTimes(1);
  const init = spy.mock.calls[0][1] as RequestInit;
  return JSON.parse(init.body as string) as EngineRequestBody;
}

describe('GET /suggestions', () => {
  it('requires authentication', async () => {
    const res = await request(server).get('/suggestions');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  // FR8 / TC-10, end to end against the REAL rule engine: no stub anywhere in
  // this test, so it fails if the AI service, the request mapping, the
  // response mapping or the signing is wrong.
  it('returns outfit suggestions composed from the wardrobe, with signed image URLs', async () => {
    const { top, bottom } = await seedPair(ownerId);

    const res = await suggestions();
    expect(res.status).toBe(200);
    expect(res.body.suggestions.length).toBeGreaterThan(0);
    expect(res.body.excludedInLaundry).toBe(0);

    const [first] = res.body.suggestions;
    expect(first.itemIds).toEqual([top.id, bottom.id]);
    expect(first.items.map((i: { id: string }) => i.id)).toEqual([top.id, bottom.id]);
    expect(typeof first.score).toBe('number');
    expect(first.score).toBeGreaterThan(0);
    expect(typeof first.rationale).toBe('string');
    expect(first.rationale.length).toBeGreaterThan(0);

    // The whole PublicClothingItem, with the same signed URLs GET /items
    // hands out — this is what lets the suggestion screen reuse the wardrobe
    // grid's renderer instead of needing its own.
    for (const item of first.items) {
      expect(item.imageUrl).toMatch(/^https?:\/\//);
      expect(item.thumbnailUrl).toMatch(/^https?:\/\//);
      expect(item.userId).toBe(ownerId);
      expect(item.category).toEqual(expect.any(String));
    }
  }, 20000);

  // THE SECURITY BOUNDARY. A missing `userId` on the item query does not
  // degrade the answer — it sends a stranger's wardrobe to the AI service and
  // returns working signed URLs for their photographs. Same shape as Stage
  // 5's `resolveOwnedItems` and Stage 6's fan-out `updateMany`: nobody omits
  // the check outright, they write the query and forget the scope. The other
  // user here owns a COMPLETE wardrobe and the caller owns nothing, so an
  // unscoped query produces a confident, plausible, entirely wrong 200.
  it('never composes a suggestion from another user\'s wardrobe', async () => {
    const other = await registerOther('other@example.com');
    await seedPair(other.id);

    const spy = stubEngine({ suggestions: [] });
    const res = await suggestions();

    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
    expect(res.body.excludedInLaundry).toBe(0);
    // Asserted at the outgoing request, not only at the response: the leak
    // has already happened once the ids are on the wire to another service.
    expect(engineRequest(spy).items).toEqual([]);
  });

  it('does not leak another user\'s items into the caller\'s own suggestions', async () => {
    const other = await registerOther('other@example.com');
    const foreign = await seedPair(other.id);
    const mine = await seedPair(ownerId);

    const res = await suggestions();
    expect(res.status).toBe(200);

    const foreignIds = [foreign.top.id, foreign.bottom.id];
    const mineIds = [mine.top.id, mine.bottom.id];
    const returned = res.body.suggestions.flatMap((s: { itemIds: string[] }) => s.itemIds);
    expect(returned.length).toBeGreaterThan(0);
    expect(returned).toEqual(expect.arrayContaining(mineIds));
    for (const id of foreignIds) {
      expect(returned).not.toContain(id);
    }
    for (const s of res.body.suggestions) {
      for (const item of s.items) {
        expect(item.userId).toBe(ownerId);
      }
    }
  }, 20000);

  // --- Ruling 3: in-laundry items are the SYSTEM's to withhold ---------------
  //
  // Stage 6 ruled the composer must SHOW in-laundry items, because hiding
  // them removes a choice the user is entitled to make. A suggestion is the
  // system choosing, and a system that proposes a garment sitting in the wash
  // is unhelpful. The AI service carries no `laundryStatus` at all and says
  // so in `suggest.py` rather than silently ignoring it, so this filter is
  // the only thing standing between a user and a suggestion they cannot wear.

  it('withholds in-laundry items from the engine entirely', async () => {
    const { top, bottom } = await seedPair(ownerId);
    const washing = await seedItem(ownerId, {
      category: 'trousers',
      colors: [ORANGE],
      laundryStatus: 'in_laundry',
    });

    const spy = stubEngine({ suggestions: [] });
    await suggestions().expect(200);

    const sent = engineRequest(spy).items.map((i) => i.id);
    expect(sent).toEqual([top.id, bottom.id]);
    expect(sent).not.toContain(washing.id);
  });

  it('never returns an in-laundry item in a suggestion', async () => {
    const { top, bottom } = await seedPair(ownerId);
    const washing = await seedItem(ownerId, {
      category: 'trousers',
      colors: [ORANGE],
      laundryStatus: 'in_laundry',
    });

    const res = await suggestions();
    expect(res.status).toBe(200);
    const returned = res.body.suggestions.flatMap((s: { itemIds: string[] }) => s.itemIds);
    expect(returned).toEqual(expect.arrayContaining([top.id, bottom.id]));
    expect(returned).not.toContain(washing.id);
  }, 20000);

  // The decisive version, against the real engine: the only bottom is in the
  // wash, so NO outfit exists at all. A filter that leaked would produce a
  // suggestion here, and no assertion about ids could be mistaken for it.
  it('returns nothing when the only bottom is in the laundry', async () => {
    await seedItem(ownerId, { category: 'shirt', colors: [RED] });
    await seedItem(ownerId, {
      category: 'trousers',
      colors: [ORANGE],
      laundryStatus: 'in_laundry',
    });

    const res = await suggestions();
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
    // …and the response SAYS why, which is the other half of ruling 3: a UI
    // that cannot distinguish "nothing matches" from "everything is in the
    // wash" shows an empty screen that reads as a broken feature.
    expect(res.body.excludedInLaundry).toBe(1);
  }, 20000);

  it('counts every in-laundry item in excludedInLaundry', async () => {
    await seedPair(ownerId);
    await seedItem(ownerId, { category: 'shirt', laundryStatus: 'in_laundry' });
    await seedItem(ownerId, { category: 'shoes', laundryStatus: 'in_laundry' });
    await seedItem(ownerId, { category: 'jacket', laundryStatus: 'in_laundry' });

    stubEngine({ suggestions: [] });
    const res = await suggestions();
    expect(res.status).toBe(200);
    expect(res.body.excludedInLaundry).toBe(3);
  });

  it('counts only the caller\'s in-laundry items', async () => {
    const other = await registerOther('other@example.com');
    await seedItem(other.id, { category: 'shirt', laundryStatus: 'in_laundry' });
    await seedItem(other.id, { category: 'trousers', laundryStatus: 'in_laundry' });
    await seedItem(ownerId, { category: 'shirt', laundryStatus: 'in_laundry' });

    stubEngine({ suggestions: [] });
    const res = await suggestions();
    expect(res.status).toBe(200);
    expect(res.body.excludedInLaundry).toBe(1);
  });

  // --- Ordering ---------------------------------------------------------------

  // The engine composes "top, bottom, shoes", and that order is the outfit.
  // Mongo hands its documents back in index order, which is ascending `_id`
  // — creation order here — so an implementation that filtered its own list
  // instead of mapping over `itemIds` would silently re-sort every outfit.
  // The stub returns the exact reverse of creation order so the two cannot
  // coincide.
  it('returns items in the engine\'s itemIds order, not the order Mongo returns them', async () => {
    const top = await seedItem(ownerId, { category: 'shirt', colors: [RED] });
    const bottom = await seedItem(ownerId, { category: 'trousers', colors: [ORANGE] });
    const shoes = await seedItem(ownerId, { category: 'shoes', colors: [RED] });

    const engineOrder = [shoes.id, bottom.id, top.id];
    stubEngine({
      suggestions: [{ itemIds: engineOrder, score: 0.9, rationale: 'top with bottom' }],
    });

    const res = await suggestions();
    expect(res.status).toBe(200);
    expect(res.body.suggestions[0].itemIds).toEqual(engineOrder);
    expect(res.body.suggestions[0].items.map((i: { id: string }) => i.id)).toEqual(engineOrder);
  });

  // An ObjectId's hex form is case-insensitive, so '507F…' and '507f…' are
  // the SAME id. Stage 5 shipped a bug where a map keyed on `String(doc._id)`
  // missed an uppercase request id and yielded `undefined` where a document
  // belonged. Nothing stops a future engine (or a proxy, or a rewrite of the
  // Python side) from echoing ids in a different case, and the failure would
  // be a suggestion with `itemIds` and NO items — an outfit of nothing.
  it('resolves item ids case-insensitively', async () => {
    const { top, bottom } = await seedPair(ownerId);
    stubEngine({
      suggestions: [
        {
          itemIds: [top.id.toUpperCase(), bottom.id.toUpperCase()],
          score: 0.9,
          rationale: 'top with bottom',
        },
      ],
    });

    const res = await suggestions();
    expect(res.status).toBe(200);
    expect(res.body.suggestions[0].items.map((i: { id: string }) => i.id)).toEqual([
      top.id,
      bottom.id,
    ]);
    // Canonical lowercase on the way out too, so a client can compare these
    // against ids from any other endpoint.
    expect(res.body.suggestions[0].itemIds).toEqual([top.id, bottom.id]);
  });

  // --- The deliberate contrast with tagImage ---------------------------------

  it('returns 503 AI_UNAVAILABLE, not an empty list, when the AI service is unreachable', async () => {
    // The client logs before it throws; silence it so this suite stays
    // pristine, and assert it actually fired so deleting the log is caught
    // here rather than in production.
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await seedPair(ownerId);

    const res = await request(deadAiServer)
      .get('/suggestions')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AI_UNAVAILABLE');
    // "Suggestions are unavailable" and "you have no suggestions" are
    // different sentences and only one of them is true. A body carrying an
    // empty list here would make the client say the false one.
    expect(res.body).not.toHaveProperty('suggestions');
    expect(consoleWarn).toHaveBeenCalledWith(
      'requestSuggestions: request to the AI service failed',
      expect.anything(),
    );
  }, 20000);

  // --- Query parameters -------------------------------------------------------

  it.each(['spimg', 'SUMMER', '', 'all'])('rejects season=%p with 400', async (season) => {
    const res = await suggestions(`?season=${encodeURIComponent(season)}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.fields).toEqual([
      { path: 'season', message: expect.stringContaining('spring') },
    ]);
  });

  it('honours the requested season', async () => {
    await seedItem(ownerId, { category: 'shirt', colors: [RED], seasons: ['summer', 'winter'] });
    const summerBottom = await seedItem(ownerId, {
      category: 'trousers',
      colors: [ORANGE],
      seasons: ['summer'],
    });
    const winterBottom = await seedItem(ownerId, {
      category: 'skirt',
      colors: [ORANGE],
      seasons: ['winter'],
    });

    const summer = await suggestions('?season=summer');
    expect(summer.status).toBe(200);
    const summerIds = summer.body.suggestions.flatMap((s: { itemIds: string[] }) => s.itemIds);
    expect(summerIds).toContain(summerBottom.id);
    expect(summerIds).not.toContain(winterBottom.id);

    const winter = await suggestions('?season=winter');
    expect(winter.status).toBe(200);
    const winterIds = winter.body.suggestions.flatMap((s: { itemIds: string[] }) => s.itemIds);
    expect(winterIds).toContain(winterBottom.id);
    expect(winterIds).not.toContain(summerBottom.id);
  }, 20000);

  it('forwards a valid season to the engine', async () => {
    await seedPair(ownerId);
    const spy = stubEngine({ suggestions: [] });
    await suggestions('?season=autumn').expect(200);
    expect(engineRequest(spy).season).toBe('autumn');
  });

  it.each(['0', '51', 'abc', '-1', '1.5'])('rejects limit=%p with 400', async (limit) => {
    const res = await suggestions(`?limit=${limit}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.fields?.[0].path).toBe('limit');
  });

  it('defaults the limit and forwards the caller\'s when given', async () => {
    await seedPair(ownerId);

    const defaulted = stubEngine({ suggestions: [] });
    await suggestions().expect(200);
    expect(engineRequest(defaulted).limit).toBe(DEFAULT_SUGGESTION_LIMIT);
    jest.restoreAllMocks();

    const explicit = stubEngine({ suggestions: [] });
    await suggestions(`?limit=${MAX_SUGGESTION_LIMIT}`).expect(200);
    expect(engineRequest(explicit).limit).toBe(MAX_SUGGESTION_LIMIT);
  });

  // The engine rejects a limit above its own MAX_SUGGESTION_LIMIT with a 422,
  // which this API can only report as a 503 — a permanent failure dressed as
  // an outage. Proving the shared maximum is actually accepted is what keeps
  // the two numbers honest, and it is a REAL engine call, not a stub.
  it('accepts the maximum limit end to end', async () => {
    await seedPair(ownerId);
    const res = await suggestions(`?limit=${MAX_SUGGESTION_LIMIT}`);
    expect(res.status).toBe(200);
    expect(res.body.suggestions.length).toBeGreaterThan(0);
  }, 20000);

  it('caps the number of suggestions at the requested limit', async () => {
    // Four tops and four bottoms compose sixteen candidate outfits.
    for (const colour of [RED, ORANGE, RED, ORANGE]) {
      await seedItem(ownerId, { category: 'shirt', colors: [colour] });
      await seedItem(ownerId, { category: 'trousers', colors: [colour] });
    }
    const res = await suggestions('?limit=3');
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toHaveLength(3);
  }, 20000);

  it('returns an empty list, not an error, for an empty wardrobe', async () => {
    const res = await suggestions();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ suggestions: [], excludedInLaundry: 0 });
  }, 20000);

  // Nothing downstream bounds this: the engine accepts any string and ignores
  // it, so without a bound here an unbounded query parameter is a free way to
  // put arbitrary bytes into another service's request body.
  it.each([
    ['empty', ''],
    ['over 64 characters', 'x'.repeat(65)],
  ])('rejects an occasion that is %s with 400', async (_why, occasion) => {
    const res = await suggestions(`?occasion=${encodeURIComponent(occasion)}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.fields?.[0].path).toBe('occasion');
  });

  it('accepts an occasion of exactly the maximum length', async () => {
    const spy = stubEngine({ suggestions: [] });
    await suggestions(`?occasion=${'x'.repeat(64)}`).expect(200);
    expect(engineRequest(spy).occasion).toBe('x'.repeat(64));
  });

  it('accepts an occasion and discloses that it was ignored', async () => {
    await seedPair(ownerId);
    const res = await suggestions('?occasion=formal');
    expect(res.status).toBe(200);
    expect(res.body.ignored).toEqual(['occasion']);
    // Absent — not present-and-empty — for a caller who sent no occasion, so
    // the documented two-field shape is unchanged for everyone else.
    const without = await suggestions();
    expect(without.body).not.toHaveProperty('ignored');
  }, 20000);

  // --- The request mapping ----------------------------------------------------

  // Mongo stores `colors`; the AI service reads `colours`. A mapping that
  // dropped them would return suggestions that still LOOK fine — same
  // outfits, plausible scores — while the entire colour rule family, the only
  // one that ranks, silently never fires. The rationale is where that shows:
  // the engine says "no colour rule matched" when it has nothing to work
  // with, and names the relation when it does.
  it('sends each item\'s colours, so the colour rules actually fire', async () => {
    await seedPair(ownerId);
    const res = await suggestions();
    expect(res.status).toBe(200);
    expect(res.body.suggestions[0].rationale).toContain('analogous colours');
    expect(res.body.suggestions[0].rationale).not.toContain('no colour rule matched');
    expect(res.body.suggestions[0].score).toBe(1);
  }, 20000);

  it('sends each item\'s seasons, so the season rule can be applied', async () => {
    await seedItem(ownerId, { category: 'shirt', colors: [RED], seasons: ['summer'] });
    await seedItem(ownerId, { category: 'trousers', colors: [ORANGE], seasons: ['summer'] });
    const spy = stubEngine({ suggestions: [] });
    await suggestions().expect(200);
    expect(engineRequest(spy).items.map((i) => i.seasons)).toEqual([['summer'], ['summer']]);
  });

  // `tagImage` validates that a colour's `hex` is a STRING and never that it
  // is `#rrggbb`, so a drifted AI response can persist 'navy' or '#fff' on a
  // real item. The engine validates the pattern and 422s the whole wardrobe
  // for one bad field — which this API can only report as "suggestions are
  // unavailable". One unparseable colour on one garment must not take the
  // feature down for the user's entire wardrobe.
  it('drops a colour the engine would reject rather than failing the request', async () => {
    await seedItem(ownerId, {
      category: 'shirt',
      colors: [{ hex: 'navy', name: 'navy', share: 1 }, RED],
    });
    await seedItem(ownerId, { category: 'trousers', colors: [{ hex: '#fff', name: 'white' }] });

    const spy = stubEngine({ suggestions: [] });
    await suggestions().expect(200);
    expect(engineRequest(spy).items.map((i) => i.colours)).toEqual([[RED], []]);
  });

  // Reachable only by a direct database write today (`tagImage` bounds
  // `share` before storing), but the engine bounds it too and would 422 the
  // whole wardrobe. `share` means "fraction of the image this colour covers";
  // a value that is not a fraction is not measured, which is the state an
  // absent `share` already describes.
  it('drops a share the engine would reject, keeping the colour', async () => {
    await seedItem(ownerId, {
      category: 'shirt',
      colors: [{ hex: '#cc0000', name: 'red', share: 5 }],
    });
    await seedItem(ownerId, {
      category: 'trousers',
      colors: [{ hex: '#cc6600', name: 'orange', share: -1 }],
    });

    const spy = stubEngine({ suggestions: [] });
    await suggestions().expect(200);
    expect(engineRequest(spy).items.map((i) => i.colours)).toEqual([
      [{ hex: '#cc0000', name: 'red' }],
      [{ hex: '#cc6600', name: 'orange' }],
    ]);
  });

  // --- An engine that names something this route did not send ----------------
  //
  // Unreachable through the real engine, which only ever echoes ids from the
  // wardrobe this route just handed it — which is exactly why it is worth
  // pinning: "the other service only ever returns what I sent" is a guarantee
  // nothing enforces. What must NOT happen is a signed URL for an item this
  // request never sent, or a 500. `items` shorter than `itemIds` is the
  // honest answer, and it is the same tolerance `GET /outfits/:id` applies to
  // a stale reference.
  it('skips an id the wardrobe it sent does not contain', async () => {
    const other = await registerOther('other@example.com');
    const foreign = await seedItem(other.id, { category: 'shirt', colors: [RED] });
    const { top, bottom } = await seedPair(ownerId);
    const washing = await seedItem(ownerId, {
      category: 'trousers',
      colors: [ORANGE],
      laundryStatus: 'in_laundry',
    });

    stubEngine({
      suggestions: [
        {
          itemIds: [top.id, foreign.id, washing.id, 'not-an-object-id', bottom.id],
          score: 0.9,
          rationale: 'top with bottom',
        },
      ],
    });

    const res = await suggestions();
    expect(res.status).toBe(200);
    expect(res.body.suggestions[0].items.map((i: { id: string }) => i.id)).toEqual([
      top.id,
      bottom.id,
    ]);
    // itemIds still reports everything the engine named, so a client can see
    // the gap rather than being told a five-item outfit had two items.
    expect(res.body.suggestions[0].itemIds).toHaveLength(5);
  });

  it('survives a wardrobe whose colours the engine would all reject, end to end', async () => {
    await seedItem(ownerId, { category: 'shirt', colors: [{ hex: 'navy', name: 'navy' }] });
    await seedItem(ownerId, { category: 'trousers', colors: [{ hex: '#fff', name: 'white' }] });

    const res = await suggestions();
    expect(res.status).toBe(200);
    expect(res.body.suggestions.length).toBeGreaterThan(0);
    expect(res.body.suggestions[0].rationale).toContain('no colour rule matched');
  }, 20000);
});
