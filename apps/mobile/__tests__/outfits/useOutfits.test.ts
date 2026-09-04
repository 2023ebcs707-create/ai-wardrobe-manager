import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PublicOutfit } from '@wardrobe/shared';
// The real `ApiClientError` — not a mock. Automocking a class that extends
// Error yields something that cannot be constructed, which is why
// `src/api/client` is never `jest.mock`ed anywhere in this repo.
import { ApiClientError } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { deleteOutfit, fetchOutfits } from '../../src/outfits/api';
import { useOutfits } from '../../src/outfits/useOutfits';

// `../../src/outfits/api` exports plain functions and (erased) interfaces — no
// class — so a factory mock here is safe in the way a mock of
// `../../src/api/client` would not be. Mocking at this boundary keeps these
// tests about state machinery rather than about URLs, which `api.test.ts`
// already pins down.
jest.mock('../../src/outfits/api', () => ({
  createOutfit: jest.fn(),
  fetchOutfits: jest.fn(),
  fetchOutfit: jest.fn(),
  updateOutfit: jest.fn(),
  deleteOutfit: jest.fn(),
}));

// Only `useAuth` is used here, so the real module (and its expo-secure-store
// dependency) is never loaded.
jest.mock('../../src/auth/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockedFetchOutfits = jest.mocked(fetchOutfits);
const mockedDeleteOutfit = jest.mocked(deleteOutfit);
const mockedUseAuth = jest.mocked(useAuth);

const TOKEN = 'tok-abc';

type Page = { outfits: PublicOutfit[]; nextCursor?: string };

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

function outfit(id: string, name?: string): PublicOutfit {
  return {
    id,
    userId: 'user-1',
    ...(name === undefined ? {} : { name }),
    itemIds: [`${id}-item-1`, `${id}-item-2`],
    itemCount: 2,
    coverUrl: `https://example.test/${id}-cover.jpg`,
    createdAt: '2026-08-02T10:00:00.000Z',
  };
}

/** A promise whose settlement this test controls, so request *ordering* can be
 *  written down explicitly instead of being left to the microtask queue. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // An unhandled rejection would be reported by Jest even though the hook does
  // handle it, because the handler is attached only once the hook awaits.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Any request beyond the ones a test queues up gets a promise that never
 *  settles. Without this a surplus request resolves to `undefined` and the
 *  test dies inside the mock — failing loudly, but for a reason that is not
 *  the one it is named for. With it, a surplus request shows up as the call
 *  count it is. */
function stallSurplusRequests() {
  mockedFetchOutfits.mockImplementation(() => new Promise(() => {}));
}

// Two RNTL 14 rules this file depends on, both inherited from Stage 4's
// `useWardrobe.test.ts`, where they were learned the hard way:
//
// 1. `renderHook` is async and must be awaited. Unawaited, `result` is a
//    promise and every `result.current` read throws "Cannot read properties of
//    undefined".
// 2. Every `act` must be `await act(async () => …)`. RNTL exposes the hook's
//    value through a ref assigned inside a `useEffect`, and the synchronous
//    `act(() => …)` form does not flush that effect — `result.current` stays on
//    the *previous* commit, so an assertion made right after a state change
//    silently reads the old value.
//
// Awaiting `act` does not weaken any assertion below, because every response
// this file wants to hold open is a `deferred` that only the test resolves.

const outfitA = outfit('a', 'Rainy Monday');
const outfitB = outfit('b');
const outfitC = outfit('c', 'Summer');

beforeEach(() => {
  mockedUseAuth.mockReturnValue(authValue(TOKEN));
});

afterEach(() => {
  // `reset`, not `clear`: some tests install a lasting `mockImplementation` on
  // `fetchOutfits`, and `clearAllMocks` wipes only the call log, so that
  // implementation would leak into every test after it. `useAuth`'s return
  // value is re-established in `beforeEach`, so resetting is safe.
  jest.resetAllMocks();
});

describe('useOutfits', () => {
  it('loads the first page on mount', async () => {
    const first = deferred<Page>();
    mockedFetchOutfits.mockReturnValueOnce(first.promise);

    const { result } = await renderHook(() => useOutfits());

    expect(result.current.activity).toBe('loading');
    expect(result.current.outfits).toEqual([]);
    // No `limit`, no `cursor`: `?limit=` is a 400, not the server default.
    expect(mockedFetchOutfits).toHaveBeenCalledWith({ token: TOKEN });

    await act(async () => {
      first.resolve({ outfits: [outfitA, outfitB], nextCursor: 'cursor-1' });
    });

    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(result.current.outfits).toEqual([outfitA, outfitB]);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('appends the next page on loadMore', async () => {
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const page2 = deferred<Page>();
    mockedFetchOutfits.mockReturnValueOnce(page2.promise);
    await act(async () => {
      result.current.loadMore();
    });

    // A page append is its own activity: the rows already on screen stay
    // valid, so this must not read as a first-page load.
    expect(result.current.activity).toBe('loadingMore');
    expect(result.current.outfits).toEqual([outfitA]);

    await act(async () => {
      page2.resolve({ outfits: [outfitB] });
    });

    await waitFor(() => expect(result.current.outfits).toEqual([outfitA, outfitB]));
    expect(mockedFetchOutfits).toHaveBeenLastCalledWith({ token: TOKEN, cursor: 'cursor-1' });
    // The last page omits nextCursor entirely, so paging stops here.
    expect(result.current.hasMore).toBe(false);
    expect(result.current.activity).toBe('idle');
  });

  it('does not issue a second request while one is in flight', async () => {
    // FlatList's onEndReached fires repeatedly through a single fling. Without
    // the in-flight guard, one scroll issues N overlapping requests for the
    // same cursor — N times the data over the wire, and N pages' worth of
    // cover-signing server-side, for one gesture.
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const second = deferred<Page>();
    stallSurplusRequests();
    mockedFetchOutfits.mockReturnValueOnce(second.promise);

    await act(async () => {
      result.current.loadMore();
      result.current.loadMore();
      result.current.loadMore();
    });

    // One for the mount, one for the first loadMore. Nothing else.
    expect(mockedFetchOutfits).toHaveBeenCalledTimes(2);
    expect(mockedFetchOutfits).toHaveBeenLastCalledWith({ token: TOKEN, cursor: 'cursor-1' });

    await act(async () => {
      second.resolve({ outfits: [outfitB] });
    });
    await waitFor(() => expect(result.current.outfits).toEqual([outfitA, outfitB]));
  });

  it('does not call loadMore when hasMore is false', async () => {
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA] });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      result.current.loadMore();
    });

    expect(mockedFetchOutfits).toHaveBeenCalledTimes(1);
  });

  it('treats a null nextCursor as the end of the list', async () => {
    // Nothing between the socket and the hook validates the response shape —
    // `apiRequest` ends in `return parsed as T`. The declared type says
    // `nextCursor` is `string | undefined`, but if the API ever sent `null`,
    // an `!== undefined` check would leave paging permanently on and send
    // `?cursor=null` — which the API rejects with a 400 — on every
    // onEndReached. The cast is the point of the test.
    mockedFetchOutfits.mockResolvedValueOnce({
      outfits: [outfitA],
      nextCursor: null,
    } as unknown as Page);
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      result.current.loadMore();
    });

    expect(mockedFetchOutfits).toHaveBeenCalledTimes(1);
  });

  it('does not issue a second refresh while one is in flight', async () => {
    // A "Try again" button double-tapped on a slow network. State stays
    // correct either way — the sequence guard discards the losers — so the
    // cost is duplicate round trips and duplicate cover signing server-side,
    // which is exactly what a guard is for.
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA] });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const refreshed = deferred<Page>();
    stallSurplusRequests();
    mockedFetchOutfits.mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      result.current.refresh();
      result.current.refresh();
      result.current.refresh();
    });

    expect(mockedFetchOutfits).toHaveBeenCalledTimes(2);
    expect(result.current.activity).toBe('refreshing');

    await act(async () => {
      refreshed.resolve({ outfits: [outfitC] });
    });
    await waitFor(() => expect(result.current.outfits).toEqual([outfitC]));
  });

  it('keeps loadMore closed while a newer request is still running', async () => {
    // A superseded request finishing first must not hand the in-flight flag
    // back: `refresh` is still running, and re-opening `loadMore` would let
    // onEndReached fire a page request against the cursor the refresh is about
    // to replace — which then supersedes the refresh and throws its result
    // away.
    //
    // The third call below also pins the deliberate asymmetry between the two
    // guards: `refresh` is allowed to start while a page append is in flight
    // (it supersedes it), where a second `loadMore` would not be. A pull-to-
    // refresh is an intentional gesture; an onEndReached is not. Tightening
    // refresh's guard to "anything in flight" makes this a 2-call test.
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const page2 = deferred<Page>();
    const refreshed = deferred<Page>();
    stallSurplusRequests();
    mockedFetchOutfits.mockReturnValueOnce(page2.promise).mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      result.current.loadMore();
    });
    await act(async () => {
      result.current.refresh();
    });
    expect(mockedFetchOutfits).toHaveBeenCalledTimes(3);
    expect(result.current.activity).toBe('refreshing');

    await act(async () => {
      page2.resolve({ outfits: [outfitB] });
    });
    await act(async () => {
      result.current.loadMore();
    });

    expect(mockedFetchOutfits).toHaveBeenCalledTimes(3);

    await act(async () => {
      refreshed.resolve({ outfits: [outfitC] });
    });
    await waitFor(() => expect(result.current.outfits).toEqual([outfitC]));
  });

  it('discards a stale response superseded by a refresh', async () => {
    // A page append is still in flight when the user pulls to refresh. The
    // refresh answers first; the append answers second. If the append wins,
    // the gallery shows page two of the list the refresh just replaced,
    // concatenated onto the refreshed page one — duplicated rows, and a cursor
    // pointing into a list that no longer exists.
    //
    // A sequence number rather than a value comparison, because a value
    // comparison admits an A → B → A race: two loads that happen to carry the
    // same cursor cannot be told apart by their arguments.
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const page2 = deferred<Page>();
    const refreshed = deferred<Page>();
    stallSurplusRequests();
    mockedFetchOutfits.mockReturnValueOnce(page2.promise).mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      result.current.loadMore();
    });
    await act(async () => {
      result.current.refresh();
    });

    await act(async () => {
      refreshed.resolve({ outfits: [outfitC] });
    });
    await waitFor(() => expect(result.current.outfits).toEqual([outfitC]));

    await act(async () => {
      page2.resolve({ outfits: [outfitB], nextCursor: 'stale-cursor' });
    });

    expect(result.current.outfits).toEqual([outfitC]);
    expect(result.current.outfits).not.toContainEqual(outfitB);
    // The stale page's cursor must be dropped as well, or loadMore would page
    // the old list into the refreshed one a screen later.
    expect(result.current.hasMore).toBe(false);
    expect(result.current.activity).toBe('idle');
  });

  it('discards a stale failure superseded by a refresh', async () => {
    // The mirror of the test above on the error path — the half that is easy
    // to leave unguarded, because the `catch` is written after the success
    // path is already working. A request the user has moved on from must not
    // be able to paint an error over a list that loaded fine.
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const page2 = deferred<Page>();
    const refreshed = deferred<Page>();
    stallSurplusRequests();
    mockedFetchOutfits.mockReturnValueOnce(page2.promise).mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      result.current.loadMore();
    });
    await act(async () => {
      result.current.refresh();
    });

    await act(async () => {
      refreshed.resolve({ outfits: [outfitC] });
    });
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    await act(async () => {
      page2.reject(new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'));
    });

    expect(result.current.error).toBeNull();
    expect(result.current.outfits).toEqual([outfitC]);
    expect(result.current.activity).toBe('idle');
  });

  it('keeps already-loaded outfits when a later page fails', async () => {
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    mockedFetchOutfits.mockRejectedValueOnce(
      new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'),
    );
    await act(async () => {
      result.current.loadMore();
    });

    await waitFor(() =>
      expect(result.current.error).toBe('Cannot reach the server. Check your connection.'),
    );
    expect(result.current.outfits).toEqual([outfitA]);
    expect(result.current.activity).toBe('idle');
    // The cursor survives, so onEndReached can retry the same page.
    expect(result.current.hasMore).toBe(true);
  });

  it('surfaces a first-page failure with an empty list', async () => {
    mockedFetchOutfits.mockRejectedValueOnce(
      new ApiClientError('UNAUTHORIZED', 'Session expired', 401),
    );

    const { result } = await renderHook(() => useOutfits());

    await waitFor(() => expect(result.current.error).toBe('Session expired'));
    expect(result.current.outfits).toEqual([]);
    expect(result.current.activity).toBe('idle');
  });

  it('clears a previous error when a new request starts', async () => {
    // Not when it succeeds — when it *starts*. A gallery rendering its banner
    // on `error !== null` would otherwise show the dead message underneath the
    // refresh spinner for the whole round trip.
    mockedFetchOutfits.mockRejectedValueOnce(new ApiClientError('NETWORK', 'offline'));
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.error).toBe('offline'));

    const refreshed = deferred<Page>();
    mockedFetchOutfits.mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      result.current.refresh();
    });

    expect(result.current.activity).toBe('refreshing');
    expect(result.current.error).toBeNull();

    await act(async () => {
      refreshed.resolve({ outfits: [outfitA] });
    });
    await waitFor(() => expect(result.current.outfits).toEqual([outfitA]));
    expect(result.current.error).toBeNull();
  });

  it('reports a retry that is in flight, not the failure it is retrying', async () => {
    // The case a single `status` union could not express, and the finding that
    // forced these two axes apart in Stage 4: after a page-2 failure,
    // `loadMore()` really does issue the request, and the screen has to be
    // able to say so.
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    mockedFetchOutfits.mockRejectedValueOnce(new ApiClientError('NETWORK', 'offline'));
    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.error).toBe('offline'));

    const retry = deferred<Page>();
    mockedFetchOutfits.mockReturnValueOnce(retry.promise);
    await act(async () => {
      result.current.loadMore();
    });

    expect(result.current.activity).toBe('loadingMore');
    expect(result.current.error).toBeNull();
    expect(result.current.outfits).toEqual([outfitA]);

    await act(async () => {
      retry.resolve({ outfits: [outfitB] });
    });
    await waitFor(() => expect(result.current.outfits).toEqual([outfitA, outfitB]));
  });

  it('refresh replaces the list rather than appending', async () => {
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA, outfitB], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const refreshed = deferred<Page>();
    mockedFetchOutfits.mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      result.current.refresh();
    });

    // Pull-to-refresh keeps the current rows on screen behind the spinner.
    expect(result.current.activity).toBe('refreshing');
    expect(result.current.outfits).toEqual([outfitA, outfitB]);
    // Page one: no cursor, whatever page the user had scrolled to.
    expect(mockedFetchOutfits).toHaveBeenLastCalledWith({ token: TOKEN });

    await act(async () => {
      refreshed.resolve({ outfits: [outfitC] });
    });

    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(result.current.outfits).toEqual([outfitC]);
    expect(result.current.hasMore).toBe(false);
  });

  it('reloads when the token changes', async () => {
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA] });
    const { result, rerender } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    mockedUseAuth.mockReturnValue(authValue('tok-other'));
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitC] });
    await act(async () => {
      await rerender(undefined);
    });

    await waitFor(() => expect(result.current.outfits).toEqual([outfitC]));
    expect(mockedFetchOutfits).toHaveBeenLastCalledWith({ token: 'tok-other' });
  });

  it('removes an outfit from the list after a successful delete', async () => {
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA, outfitB, outfitC] });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const deletion = deferred<undefined>();
    mockedDeleteOutfit.mockReturnValueOnce(deletion.promise);

    let removed: Promise<boolean> | undefined;
    await act(async () => {
      removed = result.current.remove('b');
    });

    // Still there: the row is dropped only once the server has confirmed the
    // delete. Dropping it first makes a failed delete look like a success,
    // and the outfit reappears on the next refresh with no explanation.
    expect(result.current.outfits).toEqual([outfitA, outfitB, outfitC]);
    expect(mockedDeleteOutfit).toHaveBeenCalledWith('b', TOKEN);

    await act(async () => {
      deletion.resolve(undefined);
    });

    await waitFor(() => expect(result.current.outfits).toEqual([outfitA, outfitC]));
    await expect(removed).resolves.toBe(true);
    expect(result.current.error).toBeNull();
    // A delete is not a list load: it must not leave the gallery spinning.
    expect(result.current.activity).toBe('idle');
  });

  it('keeps the outfit in the list when the delete fails, and sets error', async () => {
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA, outfitB] });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    mockedDeleteOutfit.mockRejectedValueOnce(
      new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'),
    );

    let removed: boolean | undefined;
    await act(async () => {
      removed = await result.current.remove('b');
    });

    expect(removed).toBe(false);
    expect(result.current.outfits).toEqual([outfitA, outfitB]);
    await waitFor(() =>
      expect(result.current.error).toBe('Cannot reach the server. Check your connection.'),
    );
  });

  it('does not issue a second DELETE for an outfit already being deleted', async () => {
    // A double-tapped delete button. The second DELETE would answer 404 —
    // `DELETE /outfits/:id` is deliberately not idempotent-silent — and paint
    // "Outfit not found" over a delete that in fact succeeded.
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA, outfitB] });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const deletion = deferred<undefined>();
    mockedDeleteOutfit.mockReturnValueOnce(deletion.promise);

    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    await act(async () => {
      first = result.current.remove('b');
      second = result.current.remove('b');
    });

    expect(mockedDeleteOutfit).toHaveBeenCalledTimes(1);

    await act(async () => {
      deletion.resolve(undefined);
    });

    // Both callers observe the same outcome, so a screen awaiting the second
    // tap is not told the delete failed.
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    await waitFor(() => expect(result.current.outfits).toEqual([outfitA]));
  });

  it('allows a delete to be retried after one fails', async () => {
    // The de-duplication above is per in-flight request, not per id forever: a
    // delete that failed must be retryable, or a network blip strands the row.
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA, outfitB] });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    mockedDeleteOutfit.mockRejectedValueOnce(new ApiClientError('NETWORK', 'offline'));
    await act(async () => {
      await result.current.remove('b');
    });
    await waitFor(() => expect(result.current.error).toBe('offline'));

    mockedDeleteOutfit.mockResolvedValueOnce(undefined);
    await act(async () => {
      await result.current.remove('b');
    });

    expect(mockedDeleteOutfit).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.outfits).toEqual([outfitA]));
    // Cleared when the retry *started*, and nothing since has failed.
    expect(result.current.error).toBeNull();
  });

  it('discards a superseded response even when it carries the current cursor', async () => {
    // The A -> B -> A race, which is why the guard is a monotonic counter and
    // not a comparison of the request's own arguments.
    //
    // A page append is in flight on cursor 'c1' when the user pulls to
    // refresh. The refresh replaces the list and hands back 'c1' AGAIN — the
    // same page boundary, which is the normal case when nothing was added.
    // The user scrolls, so a second append goes out on 'c1'. Now the FIRST
    // append lands. Its cursor is identical to the one in flight, so a value
    // comparison cannot tell the two apart and lets a page of the list the
    // user already refreshed away append onto the new one.
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA], nextCursor: 'c1' });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const firstAppend = deferred<Page>();
    const refreshed = deferred<Page>();
    const secondAppend = deferred<Page>();
    stallSurplusRequests();
    mockedFetchOutfits
      .mockReturnValueOnce(firstAppend.promise)
      .mockReturnValueOnce(refreshed.promise)
      .mockReturnValueOnce(secondAppend.promise);

    await act(async () => {
      result.current.loadMore();
    });
    await act(async () => {
      result.current.refresh();
    });

    await act(async () => {
      refreshed.resolve({ outfits: [outfitC], nextCursor: 'c1' });
    });
    await waitFor(() => expect(result.current.outfits).toEqual([outfitC]));

    await act(async () => {
      result.current.loadMore();
    });
    expect(mockedFetchOutfits).toHaveBeenCalledTimes(4);
    expect(mockedFetchOutfits).toHaveBeenLastCalledWith({ token: TOKEN, cursor: 'c1' });

    await act(async () => {
      firstAppend.resolve({ outfits: [outfitB], nextCursor: 'stale-cursor' });
    });

    expect(result.current.outfits).toEqual([outfitC]);
    expect(result.current.outfits).not.toContainEqual(outfitB);
    // The stale cursor must not land either, or the append still in flight is
    // followed by one paging into a list that no longer exists.
    expect(result.current.hasMore).toBe(true);
    expect(result.current.activity).toBe('loadingMore');
  });

  it('keeps a deleted outfit out of a refresh that was already in flight', async () => {
    // The server computed page one before the delete committed, so the
    // response still contains the outfit. The response is not stale in the
    // ordering sense — it is the newest request and the sequence guard passes
    // it, correctly — so only a record of what was deleted keeps the row off
    // the screen. Nothing re-fetches on its own (there is no useFocusEffect
    // anywhere in app/), so without that record the row is back for good.
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA, outfitB] });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const refreshed = deferred<Page>();
    stallSurplusRequests();
    mockedFetchOutfits.mockReturnValueOnce(refreshed.promise);

    await act(async () => {
      result.current.refresh();
    });

    mockedDeleteOutfit.mockResolvedValueOnce(undefined);
    await act(async () => {
      await result.current.remove('b');
    });
    expect(result.current.outfits).toEqual([outfitA]);

    await act(async () => {
      refreshed.resolve({ outfits: [outfitA, outfitB] });
    });

    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(result.current.outfits).toEqual([outfitA]);
    expect(result.current.outfits).not.toContainEqual(outfitB);
  });

  it('keeps a deleted outfit out of a later page append', async () => {
    // The same record, on the other list-writing path. Deleting a row shifts
    // every later page up by one, so a cursor issued before the delete can
    // legitimately re-serve the deleted outfit at the top of page two.
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA, outfitB], nextCursor: 'c1' });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    mockedDeleteOutfit.mockResolvedValueOnce(undefined);
    await act(async () => {
      await result.current.remove('b');
    });
    expect(result.current.outfits).toEqual([outfitA]);

    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitB, outfitC] });
    await act(async () => {
      result.current.loadMore();
    });

    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(result.current.outfits).toEqual([outfitA, outfitC]);
    expect(result.current.outfits).not.toContainEqual(outfitB);
  });

  it('drops the outfit when the server says it is already gone', async () => {
    // 404 is the one answer that means "it is not there" — deleted from
    // another device, or never the caller's (a foreign resource answers 404,
    // not 403). Treating it as a failure keeps the row, and then every retry
    // answers 404 too: a row that can never be deleted, showing "Outfit not
    // found" over a delete that already happened.
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA, outfitB] });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    mockedDeleteOutfit.mockRejectedValueOnce(
      new ApiClientError('NOT_FOUND', 'Outfit not found', 404),
    );

    let removed: boolean | undefined;
    await act(async () => {
      removed = await result.current.remove('b');
    });

    expect(removed).toBe(true);
    expect(result.current.outfits).toEqual([outfitA]);
    // Not an error the user needs to see: they asked for it gone and it is.
    expect(result.current.error).toBeNull();

    // And it is remembered, so a response computed before it vanished cannot
    // bring it back.
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA, outfitB] });
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.activity).toBe('idle'));
    expect(result.current.outfits).toEqual([outfitA]);
  });

  it('does not clear a failed delete message when a page load starts', async () => {
    // A delete fails, the user keeps scrolling, onEndReached fires. That load
    // is not a retry of the delete, and the delete's failure is still true —
    // the row is still there — so the message it left must survive.
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA, outfitB], nextCursor: 'c1' });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    mockedDeleteOutfit.mockRejectedValueOnce(new ApiClientError('NETWORK', 'offline'));
    await act(async () => {
      await result.current.remove('b');
    });
    await waitFor(() => expect(result.current.error).toBe('offline'));

    const page2 = deferred<Page>();
    mockedFetchOutfits.mockReturnValueOnce(page2.promise);
    await act(async () => {
      result.current.loadMore();
    });

    expect(result.current.activity).toBe('loadingMore');
    expect(result.current.error).toBe('offline');

    await act(async () => {
      page2.resolve({ outfits: [outfitC] });
    });
    await waitFor(() => expect(result.current.outfits).toEqual([outfitA, outfitB, outfitC]));
    // Still true, and still the only thing that failed.
    expect(result.current.error).toBe('offline');
  });

  it('does not clear a page-load error when a delete succeeds', async () => {
    // The converse. Page two is still missing after a successful delete, so
    // erasing the message that says so leaves the user with a short list and
    // no explanation for it.
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA, outfitB], nextCursor: 'c1' });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    mockedFetchOutfits.mockRejectedValueOnce(new ApiClientError('NETWORK', 'offline'));
    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.error).toBe('offline'));

    mockedDeleteOutfit.mockResolvedValueOnce(undefined);
    await act(async () => {
      await result.current.remove('b');
    });

    expect(result.current.outfits).toEqual([outfitA]);
    expect(result.current.error).toBe('offline');
  });

  it('does not discard an in-flight page load when an outfit is deleted', async () => {
    // A delete is not a list request and must not touch the list's sequence
    // number: bumping it here would discard the page currently in flight and,
    // worse, leave the in-flight flag latched — closing loadMore for the rest
    // of the session.
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitA, outfitB], nextCursor: 'cursor-1' });
    const { result } = await renderHook(() => useOutfits());
    await waitFor(() => expect(result.current.activity).toBe('idle'));

    const page2 = deferred<Page>();
    mockedFetchOutfits.mockReturnValueOnce(page2.promise);
    await act(async () => {
      result.current.loadMore();
    });

    mockedDeleteOutfit.mockResolvedValueOnce(undefined);
    await act(async () => {
      await result.current.remove('b');
    });
    await waitFor(() => expect(result.current.outfits).toEqual([outfitA]));

    await act(async () => {
      page2.resolve({ outfits: [outfitC], nextCursor: 'cursor-2' });
    });

    // The page landed, on top of the list the delete left behind.
    await waitFor(() => expect(result.current.outfits).toEqual([outfitA, outfitC]));
    expect(result.current.activity).toBe('idle');

    // And loadMore still works afterwards.
    mockedFetchOutfits.mockResolvedValueOnce({ outfits: [outfitB] });
    await act(async () => {
      result.current.loadMore();
    });
    expect(mockedFetchOutfits).toHaveBeenCalledTimes(3);
  });
});
