import { requestSuggestions, SUGGEST_TIMEOUT_MS, type SuggestEngineItem } from './suggestClient';
import { ApiError } from '../http/errors';
import { loadConfig } from '../config';

const config = loadConfig({ JWT_SECRET: 'suggest-test-secret' });

const WARDROBE: SuggestEngineItem[] = [
  { id: 'a1', category: 'shirt', colours: [{ hex: '#cc0000', name: 'red', share: 1 }], seasons: ['summer'] },
  { id: 'b1', category: 'trousers', colours: [{ hex: '#cc6600', name: 'orange' }], seasons: [] },
];

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

const ENGINE_OK = {
  suggestions: [{ itemIds: ['a1', 'b1'], score: 1, rationale: 'red shirt and orange trousers — top with bottom, analogous colours' }],
};

/**
 * `requestSuggestions` NEVER returns a value for a failure — that is the whole
 * contract, and the deliberate contrast with `tagImage`.
 *
 * A rejected promise is easy to assert loosely ("it throws"), which would pass
 * for a `TypeError` from a typo just as happily as for the intended 503. Every
 * failure test below therefore asserts the STATUS and the CODE, because the
 * code is what Task 3's hook branches on to say "suggestions are unavailable"
 * rather than "you have no suggestions".
 */
async function expectUnavailable(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    (value) => {
      throw new Error(`expected a rejection, got ${JSON.stringify(value)}`);
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  const apiError = err as ApiError;
  expect(apiError.status).toBe(503);
  expect(apiError.code).toBe('AI_UNAVAILABLE');
  return apiError;
}

describe('requestSuggestions', () => {
  // Every failure branch logs before it throws, for the same reason
  // tagClient's do: an unreachable service, a timeout and a malformed body
  // are one 503 from the caller's side, and without a trace the feature can
  // stop working in production while every test stays green.
  let consoleWarn: jest.SpyInstance;

  beforeEach(() => {
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns the engine suggestions on success', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(ok(ENGINE_OK));
    await expect(requestSuggestions(WARDROBE, { limit: 5 }, config)).resolves.toEqual({
      suggestions: [
        {
          itemIds: ['a1', 'b1'],
          score: 1,
          rationale: 'red shirt and orange trousers — top with bottom, analogous colours',
        },
      ],
    });
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('POSTs the wardrobe to the AI service /suggest endpoint as JSON', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(ok(ENGINE_OK));
    await requestSuggestions(WARDROBE, { season: 'summer', limit: 7 }, config);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${config.aiServiceUrl}/suggest`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      items: [
        { id: 'a1', category: 'shirt', colours: [{ hex: '#cc0000', name: 'red', share: 1 }], seasons: ['summer'] },
        { id: 'b1', category: 'trousers', colours: [{ hex: '#cc6600', name: 'orange' }], seasons: [] },
      ],
      season: 'summer',
      limit: 7,
    });
  });

  // The engine's `season` is `str | None`, and its `limit` is the thing that
  // decides how much work it does. Sending the caller's limit rather than
  // letting the engine default it is what makes `?limit=` mean anything at
  // all — a client asking for 1 must not pay for 5.
  it('omits season and occasion entirely when the caller sent neither', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(ok(ENGINE_OK));
    await requestSuggestions(WARDROBE, { limit: 5 }, config);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect('season' in body).toBe(false);
    expect('occasion' in body).toBe(false);
  });

  it('forwards an occasion and returns what the engine says it ignored', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(ok({ ...ENGINE_OK, ignored: ['occasion'] }));
    const result = await requestSuggestions(WARDROBE, { occasion: 'formal', limit: 5 }, config);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.occasion).toBe('formal');
    expect(result.ignored).toEqual(['occasion']);
  });

  // --- The deliberate contrast with tagImage ---------------------------------
  //
  // tagImage returns null on every failure so an upload can proceed; that is
  // right, because tagging is best-effort and storing the item untagged is a
  // real fallback. A failed suggestion request has NO fallback, so each of
  // these must surface as a 503 the client can name — never as an empty list,
  // which the client would render as "you have no suggestions".

  it('throws 503 AI_UNAVAILABLE when the service is unreachable', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expectUnavailable(requestSuggestions(WARDROBE, { limit: 5 }, config));
    expect(consoleWarn).toHaveBeenCalledWith(
      'requestSuggestions: request to the AI service failed',
      expect.objectContaining({ message: 'ECONNREFUSED' }),
    );
  });

  it('throws 503 AI_UNAVAILABLE on a 500', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    await expectUnavailable(requestSuggestions(WARDROBE, { limit: 5 }, config));
    // The status has to be in the log or an operator cannot tell a crashed
    // service from a rejected request.
    expect(consoleWarn).toHaveBeenCalledWith(
      'requestSuggestions: AI service responded with status 500',
    );
  });

  // A 422 is OUR bug, not an outage — it means this API sent the engine
  // something it validates against (a bad hex, an unknown category, a limit
  // over its own maximum). It still reaches the client as 503, because the
  // client has the same two sentences available either way; the status in the
  // log is what tells an operator which of the two happened.
  it('throws 503 AI_UNAVAILABLE on a 422, and logs the status', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{"detail":[]}', { status: 422 }));
    await expectUnavailable(requestSuggestions(WARDROBE, { limit: 5 }, config));
    expect(consoleWarn).toHaveBeenCalledWith(
      'requestSuggestions: AI service responded with status 422',
    );
  });

  it('throws 503 AI_UNAVAILABLE when the body is not JSON', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>502</html>', { status: 200 }));
    await expectUnavailable(requestSuggestions(WARDROBE, { limit: 5 }, config));
    // A 200 carrying HTML is a proxy or gateway answering instead of the
    // engine — indistinguishable from every other 503 at the caller, so the
    // log is the only place that says which. Asserted like every other
    // failure branch, so deleting the warn cannot pass unnoticed.
    expect(consoleWarn).toHaveBeenCalledWith(
      'requestSuggestions: AI service returned a body that is not JSON',
      expect.anything(),
    );
  });

  it('throws 503 AI_UNAVAILABLE when suggestions is not an array', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(ok({ suggestions: 'lots' }));
    await expectUnavailable(requestSuggestions(WARDROBE, { limit: 5 }, config));
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining('suggestions is not an array'),
    );
  });

  // A malformed entry rejects the WHOLE response rather than being filtered
  // out, for the reason tagClient gives: a partially-correct list is a drift
  // signal between two services, not something to silently repair.
  it.each([
    ['a suggestion is not an object', { suggestions: ['nope'] }],
    ['itemIds is not an array', { suggestions: [{ itemIds: 'a1', score: 1, rationale: 'x' }] }],
    ['an itemId is not a string', { suggestions: [{ itemIds: [1], score: 1, rationale: 'x' }] }],
    ['itemIds is empty', { suggestions: [{ itemIds: [], score: 1, rationale: 'x' }] }],
    ['score is not a number', { suggestions: [{ itemIds: ['a1'], score: 'high', rationale: 'x' }] }],
    ['score is outside [0,1]', { suggestions: [{ itemIds: ['a1'], score: 1.5, rationale: 'x' }] }],
    ['rationale is not a string', { suggestions: [{ itemIds: ['a1'], score: 1, rationale: 7 }] }],
    ['ignored is not an array of strings', { suggestions: [], ignored: [7] }],
  ])('throws 503 AI_UNAVAILABLE when %s', async (_why, body) => {
    jest.spyOn(global, 'fetch').mockResolvedValue(ok(body));
    await expectUnavailable(requestSuggestions(WARDROBE, { limit: 5 }, config));
  });

  it('gives up rather than hanging when the service is slow', async () => {
    jest.spyOn(global, 'fetch').mockImplementation((_u, init) => new Promise((_res, rej) => {
      (init as RequestInit).signal?.addEventListener('abort', () => rej(new Error('aborted')));
    }));
    await expectUnavailable(requestSuggestions(WARDROBE, { limit: 5 }, config));
    expect(consoleWarn).toHaveBeenCalledWith(
      'requestSuggestions: request to the AI service failed',
      expect.anything(),
    );
  }, 20000);

  // The slow-path test above proves the real constant fires but never pins
  // its value, exactly as tagClient's does. Pinned here so the number cannot
  // drift to 500ms or 60s unnoticed. Stage 9 owns the 1-2s target and will
  // change this deliberately, which is a different thing from it moving on
  // its own.
  it('sets the request timeout to exactly 5 seconds', () => {
    expect(SUGGEST_TIMEOUT_MS).toBe(5_000);
  });

  // An empty wardrobe is still a real question with a real answer ("nothing
  // can be composed"), and the engine is what decides that — so it is asked,
  // rather than short-circuited here. Short-circuiting would also make a
  // down AI service answer 200 for one caller and 503 for another, which is
  // the inconsistency this endpoint exists to avoid.
  it('asks the engine even when the wardrobe is empty', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(ok({ suggestions: [] }));
    await expect(requestSuggestions([], { limit: 5 }, config)).resolves.toEqual({ suggestions: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string).items).toEqual([]);
  });
});
