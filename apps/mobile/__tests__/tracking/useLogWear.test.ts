import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PublicWearEvent } from '@wardrobe/shared';
// The real `ApiClientError` — not a mock. Automocking a class that extends
// Error yields something that cannot be constructed, which is why
// `src/api/client` is never `jest.mock`ed anywhere in this repo.
import { ApiClientError } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { logWear } from '../../src/tracking/api';
import { useLogWear, type LogWearInput } from '../../src/tracking/useLogWear';

jest.mock('../../src/tracking/api', () => ({
  logWear: jest.fn(),
  fetchWearHistory: jest.fn(),
  setLaundryStatus: jest.fn(),
  fetchUsageAnalytics: jest.fn(),
}));

jest.mock('../../src/auth/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockedLogWear = jest.mocked(logWear);
const mockedUseAuth = jest.mocked(useAuth);

const TOKEN = 'tok-abc';

function authValue(token: string | null) {
  return {
    status: token ? ('authenticated' as const) : ('anonymous' as const),
    user: null,
    token,
    signIn: jest.fn(),
    signUp: jest.fn(),
    signOut: jest.fn(),
  };
}

const event: PublicWearEvent = {
  id: 'wear-1',
  userId: 'user-1',
  outfitId: 'outfit-1',
  outfitName: 'Rainy Monday',
  itemIds: ['item-1'],
  wornAt: '2026-08-22T18:00:00.000Z',
  createdAt: '2026-08-22T18:00:01.000Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function stallSurplusRequests() {
  mockedLogWear.mockImplementation(() => new Promise(() => {}));
}

beforeEach(() => {
  mockedUseAuth.mockReturnValue(authValue(TOKEN));
});

afterEach(() => {
  jest.resetAllMocks();
  // `restoreAllMocks` as well, because one test below spies on `global.fetch`
  // to run the REAL api module. `resetAllMocks` would clear that spy's
  // implementation but leave the spy installed over `fetch` for every
  // subsequent test in this file. Factory mocks from `jest.mock` are not
  // spies, so restoring does not disturb them.
  jest.restoreAllMocks();
});

describe('useLogWear', () => {
  it('logs a wear and resolves the created event', async () => {
    mockedLogWear.mockResolvedValueOnce(event);
    const { result } = await renderHook(() => useLogWear());

    let logged: PublicWearEvent | null = null;
    await act(async () => {
      logged = await result.current.logWear({ outfitId: 'outfit-1' });
    });

    expect(logged).toEqual(event);
    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBe(false);
  });

  it('omits wornAt for a wear happening now', async () => {
    // THE CLIENT CONTRACT, pinned at the layer a screen actually calls.
    //
    // `POST /wear-history` rejects a future `wornAt` against a `now` it takes
    // after the request lands, with no skew tolerance at all — so a handset
    // whose clock is a few milliseconds fast gets a 400 on every "Log wear"
    // tap. It is invisible on a dev machine, where the emulator and the API
    // share one clock. The hook must therefore never manufacture a timestamp
    // on the caller's behalf: the key is simply not there.
    mockedLogWear.mockResolvedValueOnce(event);
    const { result } = await renderHook(() => useLogWear());

    await act(async () => {
      await result.current.logWear({ outfitId: 'outfit-1' });
    });

    expect(mockedLogWear).toHaveBeenCalledWith({ token: TOKEN, outfitId: 'outfit-1' });
    // `toHaveBeenCalledWith` treats an explicit `wornAt: undefined` as absent,
    // so the key is checked directly as well: a hook that filled the field in
    // from the device clock has to be caught here and not only downstream.
    expect('wornAt' in mockedLogWear.mock.calls[0][0]).toBe(false);
  });

  it('forwards a back-dated wornAt and an occasion the user chose', async () => {
    mockedLogWear.mockResolvedValueOnce(event);
    const { result } = await renderHook(() => useLogWear());

    await act(async () => {
      await result.current.logWear({
        outfitId: 'outfit-1',
        wornAt: '2026-08-20T17:30:00.000Z',
        occasion: 'Work',
      });
    });

    expect(mockedLogWear).toHaveBeenCalledWith({
      token: TOKEN,
      outfitId: 'outfit-1',
      wornAt: '2026-08-20T17:30:00.000Z',
      occasion: 'Work',
    });
  });

  it('ignores a token carried on the caller\'s input', async () => {
    // A screen builds the argument from state — a draft object, a form model
    // reused from somewhere else — and that object can carry a `token` field
    // nobody meant as an auth token. `LogWearInput` declares no `token`, but
    // TypeScript's excess-property check fires only on an object LITERAL
    // passed inline: a variable, a widened type or an `as` walks straight
    // past it, which is exactly how a screen passes a draft.
    //
    // So the session's token has to win at runtime, which is what the
    // `{ ...input, token }` order in the hook enforces. Written the other way
    // round the caller's value would be the one used.
    mockedLogWear.mockResolvedValueOnce(event);
    const { result } = await renderHook(() => useLogWear());

    const draft = { outfitId: 'outfit-1', token: 'HIJACKED' } as unknown as LogWearInput;
    await act(async () => {
      await result.current.logWear(draft);
    });

    expect(mockedLogWear).toHaveBeenCalledWith({ token: TOKEN, outfitId: 'outfit-1' });
  });

  it('sends the session token on the wire even when the input carries one', async () => {
    // The same property proved end to end rather than inferred across two
    // suites. The REAL `api.ts` runs here — `jest.requireActual`, with `fetch`
    // as the seam — so this asserts the Authorization header that actually
    // goes out, not just the argument the hook handed to a mock.
    //
    // `src/api/client` is still never `jest.mock`ed: only `tracking/api` is
    // faked in this file, and this test un-fakes exactly that one function.
    const realLogWear = jest.requireActual<typeof import('../../src/tracking/api')>(
      '../../src/tracking/api',
    ).logWear;
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ event }), { status: 201 }));
    mockedLogWear.mockImplementationOnce(realLogWear);

    const { result } = await renderHook(() => useLogWear());

    const draft = { outfitId: 'outfit-1', token: 'HIJACKED' } as unknown as LogWearInput;
    await act(async () => {
      await result.current.logWear(draft);
    });

    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers.Authorization).not.toContain('HIJACKED');
    // And the stray key never reaches the body either — `logWear` builds the
    // body from named fields rather than spreading its options.
    expect(JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body))).toEqual({
      outfitId: 'outfit-1',
    });
  });

  it('issues ONE request for two synchronous calls', async () => {
    // Stage 5 shipped a same-frame double tap that created two identical
    // outfits, and the same bug was live on the item-upload path. A wear is
    // worse: `POST /wear-history` is not idempotent in any sense, so a second
    // request writes a second event AND increments every member item's
    // wearCount a second time — silently corrupting the exact number the
    // "most worn" analytics rank on. Nothing in the app can undo it: no
    // endpoint deletes or edits a wear event.
    //
    // The guard has to be a ref. A `pending` state flag is committed by React
    // on the next render, which is strictly after both handlers in one frame
    // have already run — so the second call reads `pending === false` and the
    // guard does nothing at all.
    const pending = deferred<PublicWearEvent>();
    stallSurplusRequests();
    mockedLogWear.mockReturnValueOnce(pending.promise);

    const { result } = await renderHook(() => useLogWear());

    let firstCall!: Promise<PublicWearEvent | null>;
    let secondCall!: Promise<PublicWearEvent | null>;
    await act(async () => {
      firstCall = result.current.logWear({ outfitId: 'outfit-1' });
      secondCall = result.current.logWear({ outfitId: 'outfit-1' });
    });

    expect(mockedLogWear).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(event);
    });

    // Both callers observe the same outcome rather than the second being told
    // its wear failed.
    await expect(firstCall).resolves.toEqual(event);
    await expect(secondCall).resolves.toEqual(event);
  });

  it('allows a genuine second wear once the first has settled', async () => {
    // The guard is per in-flight request, not per outfit forever. Wearing the
    // same outfit twice is ordinary, and so is retrying one that failed.
    mockedLogWear.mockResolvedValueOnce(event).mockResolvedValueOnce(event);
    const { result } = await renderHook(() => useLogWear());

    await act(async () => {
      await result.current.logWear({ outfitId: 'outfit-1' });
    });
    await act(async () => {
      await result.current.logWear({ outfitId: 'outfit-1' });
    });

    expect(mockedLogWear).toHaveBeenCalledTimes(2);
  });

  it('does not collapse concurrent wears of different outfits', async () => {
    // The guard is keyed by outfit, not a single flag: logging two different
    // outfits at once is two different intents and both must reach the server.
    stallSurplusRequests();
    const { result } = await renderHook(() => useLogWear());

    await act(async () => {
      void result.current.logWear({ outfitId: 'outfit-1' });
      void result.current.logWear({ outfitId: 'outfit-2' });
    });

    expect(mockedLogWear).toHaveBeenCalledTimes(2);
  });

  it('reports pending while a wear is in flight', async () => {
    const pending = deferred<PublicWearEvent>();
    stallSurplusRequests();
    mockedLogWear.mockReturnValueOnce(pending.promise);
    const { result } = await renderHook(() => useLogWear());

    expect(result.current.pending).toBe(false);

    await act(async () => {
      void result.current.logWear({ outfitId: 'outfit-1' });
    });
    expect(result.current.pending).toBe(true);

    await act(async () => {
      pending.resolve(event);
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });

  it('resolves null and surfaces the message when the wear is rejected', async () => {
    // Resolves rather than rejects, deliberately: a screen that writes
    // `onPress={() => logWear({ outfitId })}` cannot then produce an unhandled
    // rejection, and one that wants to navigate away only on success can
    // `await` it.
    mockedLogWear.mockRejectedValueOnce(
      new ApiClientError('VALIDATION_FAILED', 'Unknown outfit', 400),
    );
    const { result } = await renderHook(() => useLogWear());

    let logged: PublicWearEvent | null = event;
    await act(async () => {
      logged = await result.current.logWear({ outfitId: 'outfit-1' });
    });

    expect(logged).toBeNull();
    expect(result.current.error).toBe('Unknown outfit');
    expect(result.current.pending).toBe(false);
  });

  it('falls back to a readable message for a non-ApiClientError', async () => {
    mockedLogWear.mockRejectedValueOnce(new TypeError('boom'));
    const { result } = await renderHook(() => useLogWear());

    await act(async () => {
      await result.current.logWear({ outfitId: 'outfit-1' });
    });

    expect(result.current.error).toBe('Something went wrong logging that wear.');
  });

  it('clears a previous error when a new wear starts', async () => {
    mockedLogWear.mockRejectedValueOnce(new ApiClientError('NETWORK', 'offline'));
    const { result } = await renderHook(() => useLogWear());

    await act(async () => {
      await result.current.logWear({ outfitId: 'outfit-1' });
    });
    expect(result.current.error).toBe('offline');

    const retry = deferred<PublicWearEvent>();
    stallSurplusRequests();
    mockedLogWear.mockReturnValueOnce(retry.promise);

    await act(async () => {
      void result.current.logWear({ outfitId: 'outfit-1' });
    });

    // Mid-flight: the retry has started and has not answered.
    expect(result.current.pending).toBe(true);
    expect(result.current.error).toBeNull();

    await act(async () => {
      retry.resolve(event);
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });
});
