import { tagImage, TAG_TIMEOUT_MS } from './tagClient';
import { loadConfig } from '../config';

const config = loadConfig({ JWT_SECRET: 'tag-test-secret' });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('tagImage', () => {
  // Every failure branch logs via console.warn (fix round 1, finding 2): an
  // unreachable service, a timeout, and a benign restart all look identical
  // from the caller's side otherwise. Spy-and-silence keeps the suite
  // pristine (same pattern as the console.error spy in
  // items.integration.test.ts's orphan-cleanup test); each test below that
  // expects a warning asserts it actually fired, so deleting the logging
  // later would be caught here, not just in production.
  let consoleWarn: jest.SpyInstance;

  beforeEach(() => {
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns the parsed tag result on success', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      ok({ category: 'tshirt', confidence: 0.89, colours: [{ hex: '#1c2a5c', name: 'navy', share: 1 }] }),
    );
    await expect(tagImage(JPEG, 'image/jpeg', config)).resolves.toMatchObject({
      category: 'tshirt',
      confidence: 0.89,
    });
    // A success must never look like a failure in the logs.
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  // The brief's own success test above only checks category/confidence via
  // toMatchObject, which would pass even if `colours` (and the `share`
  // inside each one) were silently dropped on the way out of tagImage.
  // share is the TC-05 confidence signal (Phase 3 §3.2) — pin it explicitly
  // at this hop so a regression here is caught before it ever reaches the
  // database.
  it('preserves the `share` field on each colour through to the caller', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      ok({
        category: 'tshirt',
        confidence: 0.89,
        colours: [
          { hex: '#1c2a5c', name: 'navy', share: 0.55 },
          { hex: '#ffffff', name: 'white', share: 0.45 },
        ],
      }),
    );
    const result = await tagImage(JPEG, 'image/jpeg', config);
    expect(result?.colours).toEqual([
      { hex: '#1c2a5c', name: 'navy', share: 0.55 },
      { hex: '#ffffff', name: 'white', share: 0.45 },
    ]);
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('returns null when the service is unreachable', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(tagImage(JPEG, 'image/jpeg', config)).resolves.toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(
      'tagImage: request to the AI service failed',
      expect.objectContaining({ message: 'ECONNREFUSED' }),
    );
  });

  it('returns null on a 500', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    await expect(tagImage(JPEG, 'image/jpeg', config)).resolves.toBeNull();
    // The status must be in the log, not just "something failed" — that is
    // the difference between a log an operator can act on and noise.
    expect(consoleWarn).toHaveBeenCalledWith('tagImage: AI service responded with status 500');
  });

  it('returns null on a non-JSON body', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>502</html>', { status: 200 }));
    await expect(tagImage(JPEG, 'image/jpeg', config)).resolves.toBeNull();
    // `res.json()` throws on unparsable text, so this is caught by the
    // generic failure branch, not the "invalid shape" one.
    expect(consoleWarn).toHaveBeenCalledWith(
      'tagImage: request to the AI service failed',
      expect.anything(),
    );
  });

  it('returns null when the category is not one this API accepts', async () => {
    // The Python service and ITEM_CATEGORIES are two lists in two languages.
    // If they drift, we must reject rather than write a value Mongoose will
    // refuse AFTER the image is already in storage.
    jest.spyOn(global, 'fetch').mockResolvedValue(
      ok({ category: 'spacesuit', confidence: 0.9, colours: [] }),
    );
    await expect(tagImage(JPEG, 'image/jpeg', config)).resolves.toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining('category "spacesuit" is not recognised'),
    );
  });

  it('returns null when confidence is missing or out of range', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(ok({ category: 'tshirt', colours: [] }));
    await expect(tagImage(JPEG, 'image/jpeg', config)).resolves.toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('confidence is not a number'));

    jest.spyOn(global, 'fetch').mockResolvedValue(
      ok({ category: 'tshirt', confidence: 4.2, colours: [] }),
    );
    await expect(tagImage(JPEG, 'image/jpeg', config)).resolves.toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('confidence is outside [0,1]'));

    // Only the upper bound (4.2, above) was ever exercised before this fix
    // round — dropping the lower-bound check (`confidence < 0`) would have
    // survived every existing test.
    jest.spyOn(global, 'fetch').mockResolvedValue(
      ok({ category: 'tshirt', confidence: -0.1, colours: [] }),
    );
    await expect(tagImage(JPEG, 'image/jpeg', config)).resolves.toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('confidence is outside [0,1]'));
  });

  // `isValid` checked only that `colours` was an array, never that it
  // *contained* an array — this branch existed but nothing ever fed it an
  // actual non-array value, so it could be deleted without a test noticing.
  it('returns null when colours is present but not an array', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      ok({ category: 'tshirt', confidence: 0.8, colours: 'navy' }),
    );
    await expect(tagImage(JPEG, 'image/jpeg', config)).resolves.toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('colours is not an array'));
  });

  // Fix round 1, finding 1: `category` and `confidence` were validated
  // strictly, but `colours` was only checked for being an array — never that
  // its elements had the right shape. `colorSchema` REQUIRES `hex` and
  // `name`; a drifted response with one malformed colour would have passed
  // `isValid`, reached `ClothingItem.create`, thrown a Mongoose
  // ValidationError, and 500'd the user instead of falling back to null.
  it('returns null when a colour is missing hex', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      ok({ category: 'tshirt', confidence: 0.8, colours: [{ name: 'navy' }] }),
    );
    await expect(tagImage(JPEG, 'image/jpeg', config)).resolves.toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('colour is missing a string hex'));
  });

  it('returns null when a colour has a non-numeric share', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      ok({
        category: 'tshirt',
        confidence: 0.8,
        colours: [{ hex: '#1c2a5c', name: 'navy', share: 'a lot' }],
      }),
    );
    await expect(tagImage(JPEG, 'image/jpeg', config)).resolves.toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('share outside [0,1]'));
  });

  // A malformed colour rejects the WHOLE result, not just that one entry —
  // a partially-correct colour list is a drift signal, not something to
  // silently repair by filtering the bad entries out.
  it('rejects the entire result when only one colour among several is malformed', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      ok({
        category: 'tshirt',
        confidence: 0.8,
        colours: [
          { hex: '#1c2a5c', name: 'navy', share: 0.6 },
          { hex: '#ffffff' }, // missing name
        ],
      }),
    );
    await expect(tagImage(JPEG, 'image/jpeg', config)).resolves.toBeNull();
  });

  it('never throws, whatever the service does', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(() => { throw new Error('boom'); });
    await expect(tagImage(JPEG, 'image/jpeg', config)).resolves.toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(
      'tagImage: request to the AI service failed',
      expect.objectContaining({ message: 'boom' }),
    );
  });

  it('gives up rather than hanging when the service is slow', async () => {
    jest.spyOn(global, 'fetch').mockImplementation((_u, init) => new Promise((_res, rej) => {
      (init as RequestInit).signal?.addEventListener('abort', () => rej(new Error('aborted')));
    }));
    await expect(tagImage(JPEG, 'image/jpeg', config)).resolves.toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(
      'tagImage: request to the AI service failed',
      expect.anything(),
    );
  }, 20000);

  // Fix round 1, finding 4: the slow-path test above proves the real
  // constant fires (it waits out the actual timeout), but never pinned its
  // value — TAG_TIMEOUT_MS could change from 10s to 500ms or 19s and that
  // test would still pass. Asserting the constant directly is the
  // pragmatic choice here: it pins the exact value without adding another
  // multi-second wait to the suite.
  it('sets the request timeout to exactly 10 seconds', () => {
    expect(TAG_TIMEOUT_MS).toBe(10_000);
  });
});
