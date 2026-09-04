import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  MAX_OCCASION_LENGTH,
  MAX_OUTFIT_NAME_LENGTH,
  type ItemCategory,
  type PublicClothingItem,
  type PublicOutfitDetail,
  type PublicWearEvent,
} from '@wardrobe/shared';
// The real `ApiClientError` — not a mock. Automocking a class that extends
// Error yields something that cannot be constructed, which is why
// `src/api/client` is never `jest.mock`ed anywhere in this repo. The screen
// tells a 404 from every other failure by testing this class and its `status`,
// so the instances rejected below have to be the genuine article.
import { ApiClientError } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { deleteOutfit, fetchOutfit, updateOutfit } from '../../src/outfits/api';
// The REAL signal module, not a mock: it is four lines of module state with no
// dependencies, and `__tests__/outfits/outfitsDirty.test.ts` pins its contract
// separately. Asserting through `consumeOutfitsDirty()` tests that this screen
// actually moved the bit, rather than that it called a function.
import { consumeOutfitsDirty } from '../../src/outfits/outfitsDirty';
// The real signal module again, for the same reason.
import { TRACKING_READERS, consumeTrackingDirty } from '../../src/tracking/trackingDirty';
import { useLogWear, type LogWearInput } from '../../src/tracking/useLogWear';
// The neutral placeholder lives with the card that first needed it, so the
// gallery and this screen cannot drift apart on the wording.
import { UNNAMED_OUTFIT } from '../../src/outfits/OutfitCard';
import OutfitDetailScreen from '../../app/outfits/[id]';

// This file is under `apps/mobile/__tests__/`, OUTSIDE the Expo Router app
// root, exactly like `__tests__/items/[id].test.tsx`. `expo-router/_ctx.android.js`
// builds its route context recursively and excludes only
// `+api`/`+html`/`+middleware` — a `__tests__` directory is not special to it,
// so a colocated test drags @testing-library/react-native into the production
// Android bundle. README.md:161.

// `../../src/outfits/api` exports plain functions and (erased) interfaces — no
// class — so a factory mock is safe here. `__tests__/outfits/api.test.ts`
// already pins down the URLs and the envelopes; this file is about what the
// SCREEN does with the results.
jest.mock('../../src/outfits/api', () => ({
  createOutfit: jest.fn(),
  fetchOutfits: jest.fn(),
  fetchOutfit: jest.fn(),
  updateOutfit: jest.fn(),
  deleteOutfit: jest.fn(),
}));

// Only `useAuth` is read by this screen, so the real module (and its
// expo-secure-store dependency) never loads.
jest.mock('../../src/auth/AuthContext', () => ({ useAuth: jest.fn() }));

jest.mock('expo-router', () => ({
  useLocalSearchParams: jest.fn(),
  useRouter: jest.fn(),
}));

/**
 * The wear hook is mocked, and that is the point rather than a shortcut.
 *
 * `useLogWear` already collapses two same-frame calls for one outfit into a
 * single request, and it has its own suite proving it
 * (`__tests__/tracking/useLogWear.test.ts`). Running the real hook here would
 * make THIS SCREEN's guard unfalsifiable: replace the ref below with a state
 * flag and the shared guard still swallows the second call, so one request
 * goes out either way and the test passes against a broken screen.
 * `useGuardedMutation`'s own header says so — a shared guard "is deliberately
 * not evidence that any particular caller uses it".
 *
 * Mocking it also puts the CLIENT CONTRACT under a direct assertion. The
 * argument the screen hands to `logWear` is the exact object
 * `LogWearInput` describes, so "this screen never fills `wornAt` from the
 * device clock" becomes a statement about `mock.calls[0][0]` rather than an
 * argument about what the layer below would have done with it.
 *
 * A factory mock is safe: the module exports one function and (erased)
 * interfaces, no class. Nothing here mocks `../../src/api/client` — an
 * automocked `ApiClientError` cannot be constructed.
 */
jest.mock('../../src/tracking/useLogWear', () => ({ useLogWear: jest.fn() }));

const mockedFetchOutfit = jest.mocked(fetchOutfit);
const mockedUseLogWear = jest.mocked(useLogWear);
/** The mocked hook's mutation. Its resolved value is set per test. */
const logWear = jest.fn();
const mockedUpdateOutfit = jest.mocked(updateOutfit);
const mockedDeleteOutfit = jest.mocked(deleteOutfit);
const mockedUseAuth = jest.mocked(useAuth);
const mockedUseLocalSearchParams = useLocalSearchParams as unknown as jest.Mock;
const mockedUseRouter = useRouter as unknown as jest.Mock;

/**
 * The delete confirmation must be INLINE, and this is the assertion that says
 * so. `Alert.alert` opens a blocking native modal that RNTL cannot dismiss and
 * that would stall Task 6's device gate behind a dialog nothing can press.
 */
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

const TOKEN = 'tok-abc';

const back = jest.fn();
const replace = jest.fn();
const canGoBack = jest.fn<boolean, []>();

type Element = ReturnType<typeof screen.getByTestId>;
type Node = Element['children'][number];

/** Every string rendered inside `node`, in order. Same helper as
 *  `__tests__/index.test.tsx`; RNTL exposes no textContent of its own. */
function textContent(node: Element): string {
  const parts: string[] = [];
  const visit = (current: Node): void => {
    if (typeof current === 'string') {
      parts.push(current);
      return;
    }
    current.children.forEach(visit);
  };
  node.children.forEach(visit);
  return parts.join(' ');
}

/** See `imageUri` in ItemTile.test.tsx — RN may normalise `source` to an array. */
function imageUri(el: Element): string | undefined {
  const source = el.props.source as { uri?: string } | { uri?: string }[] | undefined;
  return Array.isArray(source) ? source[0]?.uri : source?.uri;
}

/** A promise whose settlement the test controls, so "before the response
 *  lands" is a state a test can actually stand in. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The screen does handle its rejections, but only once it awaits — without
  // this Jest reports an unhandled rejection for the gap in between.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function item(id: string, category: ItemCategory): PublicClothingItem {
  return {
    id,
    userId: 'user-1',
    imageUrl: `https://example.test/full/${id}.jpg`,
    thumbnailUrl: `https://example.test/thumb/${id}.jpg`,
    category,
    colors: [],
    seasons: [],
    laundryStatus: 'available',
    wearCount: 0,
    source: 'manual',
    createdAt: '2026-08-01T10:00:00.000Z',
  };
}

const TOP = item('a', 'jacket');
const BOTTOM = item('b', 'trousers');
const SHOES = item('c', 'shoes');

/**
 * What `GET /outfits/:id` and `PATCH /outfits/:id` answer with:
 * `PublicOutfitDetail`, the HEAVY shape.
 *
 * It carries `items` and has NO `coverUrl` — `PublicOutfit` (from
 * `GET /outfits` and `POST /outfits`) is the other way round, and because
 * `coverUrl` is optional an assignment between the two compiles cleanly while
 * silently dropping the cover. Task 3's hand-off note names that as this
 * task's realistic trap, so this fixture is deliberately the exact shape the
 * detail path returns and nothing here is ever handed to the gallery's card.
 */
function detail(overrides: Partial<PublicOutfitDetail> = {}): PublicOutfitDetail {
  const items = overrides.items ?? [TOP, BOTTOM, SHOES];
  return {
    id: 'outfit-1',
    userId: 'user-1',
    name: 'Work fit',
    itemIds: items.map((each) => each.id),
    itemCount: items.length,
    createdAt: '2026-08-24T09:00:00.000Z',
    ...overrides,
    items,
  };
}

/** Render the screen and wait for the first fetch to settle. */
async function open(outfit: PublicOutfitDetail = detail()): Promise<void> {
  mockedFetchOutfit.mockResolvedValue(outfit);
  await render(<OutfitDetailScreen />);
  await waitFor(() => {
    expect(screen.getByTestId('outfit-detail-name')).toBeTruthy();
  });
}

async function press(testID: string): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID));
  });
}

/** Every event goes through `await act(async () => ...)`, the same convention
 *  `OutfitComposer.test.tsx` uses. A bare `fireEvent` runs its own act inside
 *  whatever scope is open, which React 19 reports as "overlapping act() calls"
 *  and which then swallows the render the event was supposed to cause. */
async function type(text: string): Promise<void> {
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('outfit-name-input'), text);
  });
}

/** The same, for the wear log's occasion field (Stage 6 Task 4). */
async function typeOccasion(text: string): Promise<void> {
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('outfit-occasion-input'), text);
  });
}

/**
 * Minimal shape of a React fiber, declared locally so this file does not take a
 * dependency on react-reconciler's types for one helper.
 */
type FiberLike = { memoizedProps: Record<string, unknown> | null; return: FiberLike | null };

/**
 * The `onPress` handler the element was rendered with, as a callable.
 *
 * Lifted from `OutfitComposer.test.tsx`, where it was introduced for the same
 * job. `fireEvent.press` is async and wraps every press in its own `act()`, so
 * two un-awaited ones inside a single outer `act` make React 19 log "You seem
 * to have overlapping act() calls" — a warning, and therefore a failure by this
 * project's pristine-output rule. Awaiting them instead defeats the point: the
 * first press flushes React, the button disables itself, and RNTL's
 * `isEventEnabled` then refuses the second press outright (a disabled
 * Pressable's `onStartShouldSetResponder` returns false), so the test would
 * pass against a guard that cannot actually stop the race.
 *
 * Invoking the captured handler twice is also the closer model: two touch
 * events dispatched in the same frame both call the handler instance that was
 * on screen when the first one landed.
 */
function onPressOf(host: ReturnType<typeof screen.getByTestId>): () => void {
  let fiber = host.unstable_fiber as unknown as FiberLike | null;
  while (fiber !== null) {
    const handler = fiber.memoizedProps?.onPress;
    if (typeof handler === 'function') return handler as () => void;
    fiber = fiber.return;
  }
  throw new Error('No onPress handler found above the element');
}

describe('OutfitDetailScreen — FR5, and the edit and delete Phase 3 §5 claims', () => {
  beforeEach(() => {
    canGoBack.mockReturnValue(true);
    mockedUseRouter.mockReturnValue({ back, replace, canGoBack });
    mockedUseLocalSearchParams.mockReturnValue({ id: 'outfit-1' });
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: null,
      token: TOKEN,
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
    mockedUseLogWear.mockReturnValue({ logWear, pending: false, error: null });
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Module state is shared between the tests in this file. Cleared through
    // the public door so a leftover mark cannot make the next test's
    // "did not mark" assertion depend on execution order.
    consumeOutfitsDirty();
    TRACKING_READERS.forEach((reader) => consumeTrackingDirty(reader));
  });

  it('shows a loading state first', async () => {
    const pending = deferred<PublicOutfitDetail>();
    mockedFetchOutfit.mockReturnValue(pending.promise);

    await render(<OutfitDetailScreen />);

    expect(screen.getByTestId('outfit-detail-loading')).toBeTruthy();
    expect(screen.queryByTestId('outfit-detail-name')).toBeNull();
    // Nothing editable while there is nothing loaded to edit.
    expect(screen.queryByTestId('outfit-delete')).toBeNull();

    await act(async () => {
      pending.resolve(detail());
    });
    expect(screen.queryByTestId('outfit-detail-loading')).toBeNull();
  });

  it('fetches the outfit named in the route, with the caller token', async () => {
    await open();

    expect(mockedFetchOutfit).toHaveBeenCalledTimes(1);
    expect(mockedFetchOutfit).toHaveBeenCalledWith('outfit-1', TOKEN);
  });

  it('renders the outfit name and its items in order', async () => {
    await open();

    expect(screen.getByTestId('outfit-detail-name')).toHaveTextContent('Work fit');

    // Order is the point of an outfit: "top, trousers, shoes" reads correctly
    // and "shoes, top, trousers" does not. The API reapplies the composed
    // order deliberately rather than inheriting `$in`'s index order, so a
    // screen that re-sorted would throw away work done for it two layers down.
    expect(screen.getByTestId('outfit-item-position-a')).toHaveTextContent('1');
    expect(screen.getByTestId('outfit-item-position-b')).toHaveTextContent('2');
    expect(screen.getByTestId('outfit-item-position-c')).toHaveTextContent('3');
    // Read in TREE order, so a screen that numbered the rows correctly while
    // rendering them in some other sequence still fails.
    expect(textContent(screen.getByTestId('outfit-detail-items'))).toBe(
      '1 jacket 2 trousers 3 shoes',
    );
    expect(imageUri(screen.getByTestId('outfit-item-image-a'))).toBe(
      'https://example.test/thumb/a.jpg',
    );
  });

  it('names each item position in its accessible label', async () => {
    await open();

    // A screen reader reads one row at a time and cannot infer position from
    // that. The ordinal on screen is the only thing carrying the order, so it
    // has to be in the label too — the same argument `ItemTile` makes for the
    // composer's selection ordinal.
    const row = screen.getByTestId('outfit-item-b');
    expect(row.props.accessibilityLabel).toBe('Item 2: trousers');
    // Reachability, not just text. A `View` is not an accessibility element
    // unless `accessible` is set, so without it TalkBack reads the ordinal, the
    // image and the category as three separate nodes and the label above is
    // never spoken. Dropping the prop survived this whole suite until this
    // line existed.
    expect(row.props.accessible).toBe(true);
    // ...and the photograph inside it stays out of the tree, so the row is one
    // node rather than two.
    expect(screen.getByTestId('outfit-item-image-b').props.accessible).toBe(false);
  });

  it('falls back to the full image for an item with no thumbnail', async () => {
    const { thumbnailUrl: _dropped, ...noThumb } = item('a', 'jacket');

    await open(detail({ items: [noThumb] }));

    // Nothing wrote `thumbnailKey` until Task 2 of this stage, so every item
    // uploaded before it has no thumbnail — and the full image is what keeps
    // those visible instead of leaving a blank row.
    expect(imageUri(screen.getByTestId('outfit-item-image-a'))).toBe(
      'https://example.test/full/a.jpg',
    );
  });

  it('renders the item count', async () => {
    await open();

    expect(screen.getByTestId('outfit-detail-count')).toHaveTextContent('3 items');
  });

  it('counts a single-item outfit in the singular', async () => {
    await open(detail({ items: [TOP] }));

    expect(screen.getByTestId('outfit-detail-count')).toHaveTextContent('1 item');
  });

  it('shows a neutral placeholder when the outfit has no name', async () => {
    const { name: _dropped, ...unnamed } = detail();

    await open(unnamed);

    // An unnamed outfit is valid — neither FR5 nor TC-07 mentions naming one —
    // so this must not invent a name and must not leave the heading blank.
    expect(screen.getByTestId('outfit-detail-name')).toHaveTextContent(UNNAMED_OUTFIT);
    // ...and the rename field starts empty rather than pre-filled with the
    // placeholder, which would save the placeholder as a real name.
    expect(screen.getByTestId('outfit-name-input').props.value).toBe('');
  });

  it('renames the outfit and shows the new name', async () => {
    await open();

    mockedUpdateOutfit.mockResolvedValue(detail({ name: 'Beach fit' }));
    await type('Beach fit');
    await press('outfit-rename');

    expect(mockedUpdateOutfit).toHaveBeenCalledTimes(1);
    expect(mockedUpdateOutfit).toHaveBeenCalledWith('outfit-1', {
      token: TOKEN,
      name: 'Beach fit',
    });
    await waitFor(() => {
      expect(screen.getByTestId('outfit-detail-name')).toHaveTextContent('Beach fit');
    });
    // Read from the RESPONSE, not from the field: what is on screen has to be
    // what the server recorded.
    expect(screen.getByTestId('outfit-name-input').props.value).toBe('Beach fit');
  });

  it('sends only the name on a rename, never the items', async () => {
    await open();

    mockedUpdateOutfit.mockResolvedValue(detail({ name: 'Beach fit' }));
    await type('  Beach fit  ');
    await press('outfit-rename');

    // `itemIds` on a PATCH is a full REPLACEMENT, not a delta. Sending the
    // items back on a rename would make every rename a rewrite of the outfit's
    // contents — harmless until the two disagree, which is exactly when it
    // matters. The name is trimmed because the API trims it too, so an
    // untrimmed one would make "unchanged" undetectable on the next render.
    const [, patch] = mockedUpdateOutfit.mock.calls[0];
    expect(patch).toEqual({ token: TOKEN, name: 'Beach fit' });
    expect(Object.keys(patch)).not.toContain('itemIds');
  });

  it('keeps the items on screen after a rename', async () => {
    await open();

    mockedUpdateOutfit.mockResolvedValue(detail({ name: 'Beach fit' }));
    await type('Beach fit');
    await press('outfit-rename');

    await waitFor(() => {
      expect(screen.getByTestId('outfit-detail-name')).toHaveTextContent('Beach fit');
    });
    // `PATCH` answers with the full detail shape, so the screen re-renders from
    // the response with no follow-up read. A screen that stored only the name
    // would blank the items.
    expect(textContent(screen.getByTestId('outfit-detail-items'))).toBe(
      '1 jacket 2 trousers 3 shoes',
    );
  });

  it('clears the name when the field is emptied', async () => {
    await open();

    const { name: _dropped, ...cleared } = detail();
    mockedUpdateOutfit.mockResolvedValue(cleared);
    await type('   ');
    await press('outfit-rename');

    // `name: ''` CLEARS the name; omitting the key leaves it unchanged. Those
    // are two different requests and a blank field means the first one.
    expect(mockedUpdateOutfit).toHaveBeenCalledWith('outfit-1', { token: TOKEN, name: '' });
    await waitFor(() => {
      expect(screen.getByTestId('outfit-detail-name')).toHaveTextContent(UNNAMED_OUTFIT);
    });
    // The field goes back to showing what the SERVER holds, not the whitespace
    // that was typed to clear it — otherwise the next render still measures
    // "has the name changed?" against a draft the server never accepted.
    expect(screen.getByTestId('outfit-name-input').props.value).toBe('');
  });

  it('refuses a rename that changes nothing', async () => {
    await open();

    // The API refuses a patch with neither key, and `updateOutfit` refuses it
    // client-side before a round trip. A patch that re-sends the name it
    // already has is not refused by either — it is simply a wasted write, and
    // this is where it is stopped.
    expect(screen.getByTestId('outfit-rename').props.accessibilityState.disabled).toBe(true);
    await type('  Work fit  ');
    await press('outfit-rename');

    expect(mockedUpdateOutfit).not.toHaveBeenCalled();
  });

  it('caps the name field at the length the API accepts', async () => {
    await open();

    // `nameSchema` is `z.string().trim().max(80)` and a longer name is a hard
    // 400 that no retry can fix. Cheaper to make it unenterable.
    expect(screen.getByTestId('outfit-name-input').props.maxLength).toBe(MAX_OUTFIT_NAME_LENGTH);
  });

  it('shows an error and keeps the old name when the rename fails', async () => {
    await open();

    mockedUpdateOutfit.mockRejectedValue(
      new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'),
    );
    await type('Beach fit');
    await press('outfit-rename');

    await waitFor(() => {
      expect(screen.getByTestId('outfit-rename-error')).toHaveTextContent(
        'Cannot reach the server. Check your connection.',
      );
    });
    // The heading is what the SERVER holds. Painting the attempted name over
    // it would tell the user a write succeeded that did not — and the next
    // visit would silently show the old name back with nothing to explain it.
    expect(screen.getByTestId('outfit-detail-name')).toHaveTextContent('Work fit');
    // The typed name stays in the field, because the button is the retry.
    expect(screen.getByTestId('outfit-name-input').props.value).toBe('Beach fit');
    expect(screen.getByTestId('outfit-rename').props.accessibilityState.disabled).toBe(false);
  });

  it('shows the not-found state when the rename says the outfit is gone', async () => {
    await open();

    mockedUpdateOutfit.mockRejectedValue(
      new ApiClientError('NOT_FOUND', 'Outfit not found', 404),
    );
    await type('Beach fit');
    await press('outfit-rename');

    // A 404 here is not retryable, and rendering it as an inline error produced
    // exactly what this screen's own `DetailState` comment forbids: "Outfit not
    // found" in red UNDER a heading naming the outfit, beside an enabled Save
    // button that can never succeed. The fetch path and the delete path both
    // treat 404 as its own outcome; so does this one.
    await waitFor(() => {
      expect(screen.getByTestId('outfit-detail-not-found')).toBeTruthy();
    });
    expect(screen.queryByTestId('outfit-rename-error')).toBeNull();
    expect(screen.queryByTestId('outfit-detail-name')).toBeNull();
    expect(screen.queryByTestId('outfit-rename')).toBeNull();
    // And the gallery is holding a row for something the server says is gone.
    expect(consumeOutfitsDirty()).toBe(true);
  });

  it('tells the gallery the list has changed after a rename', async () => {
    await open();

    mockedUpdateOutfit.mockResolvedValue(detail({ name: 'Beach fit' }));
    await type('Beach fit');
    await press('outfit-rename');
    await waitFor(() => {
      expect(screen.getByTestId('outfit-detail-name')).toHaveTextContent('Beach fit');
    });

    // The gallery is mounted behind this screen holding the OLD name, and it
    // has no way to find out. This bit is the only thing that tells it.
    expect(consumeOutfitsDirty()).toBe(true);
  });

  it('tells the PROFILE TAB that its wear history has changed after a rename', async () => {
    // The same argument as the delete path, and it is the argument
    // `src/tracking/trackingDirty.ts` already makes: `GET /wear-history`
    // resolves `outfitName` from the live Outfit document at READ time
    // (`apps/api/src/routes/wearHistory.ts`, `outfitNames()`), so a rename
    // invalidates every history row pointing at this outfit exactly as a delete
    // does. Without this the Profile tab keeps saying "Friday best" for an
    // outfit the user renamed thirty seconds ago, for the rest of the session —
    // the focus gate never fires, because nothing told it anything happened.
    await open();

    mockedUpdateOutfit.mockResolvedValue(detail({ name: 'Beach fit' }));
    await type('Beach fit');
    await press('outfit-rename');
    await waitFor(() => {
      expect(screen.getByTestId('outfit-detail-name')).toHaveTextContent('Beach fit');
    });

    expect(consumeTrackingDirty('profile')).toBe(true);
  });

  it('leaves the WARDROBE GRID alone after a rename', async () => {
    // A rename touches no item: no `wearCount`, no `lastWornAt`, no
    // `laundryStatus`. Marking the grid would make it discard every page the
    // user had scrolled to, to reload a list that did not move.
    await open();

    mockedUpdateOutfit.mockResolvedValue(detail({ name: 'Beach fit' }));
    await type('Beach fit');
    await press('outfit-rename');
    await waitFor(() => {
      expect(screen.getByTestId('outfit-detail-name')).toHaveTextContent('Beach fit');
    });

    expect(consumeTrackingDirty('wardrobe')).toBe(false);
  });

  it('tells the Profile tab too when the rename says the outfit is already gone', async () => {
    await open();

    mockedUpdateOutfit.mockRejectedValue(new ApiClientError('NOT_FOUND', 'Outfit not found', 404));
    await type('Beach fit');
    await press('outfit-rename');
    await waitFor(() => {
      expect(screen.getByTestId('outfit-detail-not-found')).toBeTruthy();
    });

    // The outfit is gone, so its history rows read back nameless — the same
    // state a delete leaves behind, reached through a different door.
    expect(consumeTrackingDirty('profile')).toBe(true);
  });

  it('does not tell the gallery anything when the rename fails', async () => {
    await open();

    mockedUpdateOutfit.mockRejectedValue(
      new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'),
    );
    await type('Beach fit');
    await press('outfit-rename');
    await waitFor(() => {
      expect(screen.getByTestId('outfit-rename-error')).toBeTruthy();
    });

    // Nothing changed server-side, so a refetch would be pure cost — and, worse,
    // it would train the gate to fire on non-events.
    expect(consumeOutfitsDirty()).toBe(false);
    expect(consumeTrackingDirty('profile')).toBe(false);
  });

  it('does not issue a second PATCH while a rename is in flight', async () => {
    await open();

    const pending = deferred<PublicOutfitDetail>();
    mockedUpdateOutfit.mockReturnValue(pending.promise);
    await type('Beach fit');
    const pressRename = onPressOf(screen.getByTestId('outfit-rename'));
    await act(async () => {
      pressRename();
      pressRename();
    });

    // Both presses land before React can re-render, so the second one sees
    // `disabled` still false AND the same closure the first one ran, still
    // holding `renaming === false`. Only a ref — written synchronously, read
    // synchronously — is true by the time the second press reads it. Same
    // reasoning as `savingRef` in the composer and `inFlightRef` in
    // `useOutfits`.
    expect(mockedUpdateOutfit).toHaveBeenCalledTimes(1);
    // And the field is frozen while the write is in flight, so a name typed
    // during it cannot end up describing an outfit that was saved under the
    // previous one.
    expect(screen.getByTestId('outfit-name-input').props.editable).toBe(false);

    await act(async () => {
      pending.resolve(detail({ name: 'Beach fit' }));
    });
  });

  it('asks for confirmation before deleting', async () => {
    await open();

    expect(screen.queryByTestId('outfit-delete-prompt')).toBeNull();
    await press('outfit-delete');

    expect(screen.getByTestId('outfit-delete-prompt')).toBeTruthy();
    expect(mockedDeleteOutfit).not.toHaveBeenCalled();
  });

  it('confirms inline, never through a blocking Alert', async () => {
    await open();

    await press('outfit-delete');
    mockedDeleteOutfit.mockResolvedValue(undefined);
    await press('outfit-delete-confirm');

    // `Alert.alert` is a native modal RNTL cannot see or dismiss. It would
    // stall Task 6's device gate behind a dialog nothing can press, and it is
    // why the confirmation is two rendered buttons.
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('deletes on confirmation and navigates back', async () => {
    await open();

    await press('outfit-delete');
    mockedDeleteOutfit.mockResolvedValue(undefined);
    await press('outfit-delete-confirm');

    expect(mockedDeleteOutfit).toHaveBeenCalledTimes(1);
    expect(mockedDeleteOutfit).toHaveBeenCalledWith('outfit-1', TOKEN);
    await waitFor(() => {
      expect(back).toHaveBeenCalledTimes(1);
    });
    // Staying on a screen whose subject no longer exists is the one outcome
    // that cannot be recovered from: every control on it now 404s.
    expect(replace).not.toHaveBeenCalled();
  });

  it('does not delete when the confirmation is dismissed', async () => {
    await open();

    await press('outfit-delete');
    await press('outfit-delete-cancel');

    expect(mockedDeleteOutfit).not.toHaveBeenCalled();
    // Back to the un-armed state, not merely inert: a confirmation left on
    // screen after a cancel is one an accidental tap can still fire.
    expect(screen.queryByTestId('outfit-delete-prompt')).toBeNull();
    expect(screen.getByTestId('outfit-delete')).toBeTruthy();
    expect(back).not.toHaveBeenCalled();
  });

  it('refuses a cancel while the delete is already in flight', async () => {
    await open();

    await press('outfit-delete');
    const pending = deferred<void>();
    mockedDeleteOutfit.mockReturnValue(pending.promise);
    await press('outfit-delete-confirm');

    // `disabled={deleting}` survived the suite until this test existed. Without
    // it, cancelling mid-request tears the prompt down while the DELETE is
    // still running, so the outfit vanishes server-side a moment after the user
    // was told nothing would happen — and the navigation still fires under
    // them when it lands.
    expect(screen.getByTestId('outfit-delete-cancel').props.accessibilityState.disabled).toBe(
      true,
    );
    await press('outfit-delete-cancel');
    expect(screen.getByTestId('outfit-delete-prompt')).toBeTruthy();

    await act(async () => {
      pending.resolve();
    });
  });

  it('clears a failed delete message when the confirmation is dismissed', async () => {
    await open();

    await press('outfit-delete');
    mockedDeleteOutfit.mockRejectedValue(
      new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'),
    );
    await press('outfit-delete-confirm');
    await waitFor(() => {
      expect(screen.getByTestId('outfit-delete-error')).toBeTruthy();
    });

    await press('outfit-delete-cancel');

    // `setDeleteError(null)` in the cancel handler also survived the suite.
    // Without it, a red "Cannot reach the server" sits under a screen the user
    // has just told to forget the whole thing, and it stays there until they
    // arm the prompt again — describing an operation that is no longer
    // happening.
    expect(screen.queryByTestId('outfit-delete-error')).toBeNull();
    expect(screen.queryByTestId('outfit-delete-prompt')).toBeNull();
  });

  it('tells the gallery the list has changed after a delete', async () => {
    await open();

    await press('outfit-delete');
    mockedDeleteOutfit.mockResolvedValue(undefined);
    await press('outfit-delete-confirm');
    await waitFor(() => {
      expect(back).toHaveBeenCalledTimes(1);
    });

    // Marked BEFORE the navigation, so the gallery this pops back to reloads
    // rather than showing the deleted card for the length of a round trip.
    expect(consumeOutfitsDirty()).toBe(true);
  });

  it('tells the gallery the list has changed when the delete says it was already gone', async () => {
    await open();

    await press('outfit-delete');
    mockedDeleteOutfit.mockRejectedValue(
      new ApiClientError('NOT_FOUND', 'Outfit not found', 404),
    );
    await press('outfit-delete-confirm');
    await waitFor(() => {
      expect(back).toHaveBeenCalledTimes(1);
    });

    // The row is on the gallery and the server says it is not there. That is
    // the case most in need of a reload, not the least.
    expect(consumeOutfitsDirty()).toBe(true);
  });

  it('tells the PROFILE TAB that its wear history has changed after a delete', async () => {
    // Ruling 3: the wear events survive the outfit. What does not survive is
    // their NAME — `GET /wear-history` resolves `outfitName` at read time, so
    // every past wear of this outfit reads back nameless from now on. The
    // Profile tab is holding the old names and cannot see that.
    await open();

    await press('outfit-delete');
    mockedDeleteOutfit.mockResolvedValue(undefined);
    await press('outfit-delete-confirm');
    await waitFor(() => {
      expect(back).toHaveBeenCalledTimes(1);
    });

    expect(consumeTrackingDirty('profile')).toBe(true);
  });

  it('leaves the WARDROBE GRID alone after a delete', async () => {
    // The one write in this stage whose effect is genuinely one-sided.
    // Deleting an outfit changes no item: no `wearCount`, no `lastWornAt`, no
    // `laundryStatus`. Marking the grid too would make it throw away every
    // page the user had scrolled to, to reload a list that did not move —
    // which is why `markTrackingDirty` takes a reader subset.
    await open();

    await press('outfit-delete');
    mockedDeleteOutfit.mockResolvedValue(undefined);
    await press('outfit-delete-confirm');
    await waitFor(() => {
      expect(back).toHaveBeenCalledTimes(1);
    });

    expect(consumeTrackingDirty('wardrobe')).toBe(false);
  });

  it('tells the Profile tab too when the delete says it was already gone', async () => {
    await open();

    await press('outfit-delete');
    mockedDeleteOutfit.mockRejectedValue(
      new ApiClientError('NOT_FOUND', 'Outfit not found', 404),
    );
    await press('outfit-delete-confirm');
    await waitFor(() => {
      expect(back).toHaveBeenCalledTimes(1);
    });

    // The outfit is gone either way, so the history rows pointing at it read
    // back nameless either way.
    expect(consumeTrackingDirty('profile')).toBe(true);
  });

  it('does not tell the gallery anything when the delete fails', async () => {
    await open();

    await press('outfit-delete');
    mockedDeleteOutfit.mockRejectedValue(
      new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'),
    );
    await press('outfit-delete-confirm');
    await waitFor(() => {
      expect(screen.getByTestId('outfit-delete-error')).toBeTruthy();
    });

    expect(consumeOutfitsDirty()).toBe(false);
    expect(consumeTrackingDirty('profile')).toBe(false);
  });

  it('goes to the gallery after a delete when there is nothing to go back to', async () => {
    canGoBack.mockReturnValue(false);
    await open();

    await press('outfit-delete');
    mockedDeleteOutfit.mockResolvedValue(undefined);
    await press('outfit-delete-confirm');

    // Opened by a deep link this is the first entry in the stack and `back()`
    // has nothing to pop, which would strand the user on a deleted outfit.
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/favorites');
    });
    expect(back).not.toHaveBeenCalled();
  });

  it('treats a 404 from the delete as already gone and leaves anyway', async () => {
    await open();

    await press('outfit-delete');
    mockedDeleteOutfit.mockRejectedValue(
      new ApiClientError('NOT_FOUND', 'Outfit not found', 404),
    );
    await press('outfit-delete-confirm');

    // 404 is the one answer that means "it is not there" — deleted from
    // another device, or never the caller's (a foreign resource answers 404,
    // not 403). Treating it as a failure strands the user on an outfit that
    // can never be deleted, because every retry answers 404 too.
    await waitFor(() => {
      expect(back).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('outfit-delete-error')).toBeNull();
  });

  it('keeps the user on the screen and explains a failed delete', async () => {
    await open();

    await press('outfit-delete');
    mockedDeleteOutfit.mockRejectedValue(
      new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'),
    );
    await press('outfit-delete-confirm');

    await waitFor(() => {
      expect(screen.getByTestId('outfit-delete-error')).toHaveTextContent(
        'Cannot reach the server. Check your connection.',
      );
    });
    expect(back).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    // The prompt stays armed: the confirm button is the retry.
    expect(screen.getByTestId('outfit-delete-confirm')).toBeTruthy();
  });

  it('does not issue a second DELETE while the first is in flight', async () => {
    await open();

    await press('outfit-delete');
    const pending = deferred<void>();
    mockedDeleteOutfit.mockReturnValue(pending.promise);
    const pressConfirm = onPressOf(screen.getByTestId('outfit-delete-confirm'));
    await act(async () => {
      pressConfirm();
      pressConfirm();
    });

    // `DELETE /outfits/:id` is deliberately not idempotent-silent, so a second
    // delete of the same id answers 404 — which this screen reads as "already
    // gone" and would use to navigate away from a delete that had not
    // finished. A ref is the only guard that survives two presses in one
    // synchronous burst; `deleting` state is still false in the closure the
    // second press runs.
    expect(mockedDeleteOutfit).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve();
    });
  });

  it('shows a not-found state on a 404', async () => {
    mockedFetchOutfit.mockRejectedValue(
      new ApiClientError('NOT_FOUND', 'Outfit not found', 404),
    );

    await render(<OutfitDetailScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('outfit-detail-not-found')).toBeTruthy();
    });
    // Not folded into "error": a 404 is the API's single answer to "no such
    // outfit" AND "not yours", so it is an ordinary, expected outcome with
    // nothing to retry. One state showing both would offer a "Try again"
    // button that can never succeed.
    expect(screen.queryByTestId('outfit-detail-error')).toBeNull();
    expect(screen.queryByTestId('outfit-detail-retry')).toBeNull();
    expect(screen.queryByTestId('outfit-detail-loading')).toBeNull();
  });

  it('shows a not-found state when the route carries no id, without a request', async () => {
    mockedUseLocalSearchParams.mockReturnValue({});

    await render(<OutfitDetailScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('outfit-detail-not-found')).toBeTruthy();
    });
    // `/outfits/undefined` is a 404 anyway — the ObjectId shape check runs
    // first — so this is the same outcome without the round trip.
    expect(mockedFetchOutfit).not.toHaveBeenCalled();
  });

  it('shows a retryable error on a network failure, and refetches on retry', async () => {
    mockedFetchOutfit.mockRejectedValue(
      new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'),
    );

    await render(<OutfitDetailScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('outfit-detail-error-message')).toHaveTextContent(
        'Cannot reach the server. Check your connection.',
      );
    });

    mockedFetchOutfit.mockResolvedValue(detail());
    await press('outfit-detail-retry');

    await waitFor(() => {
      expect(screen.getByTestId('outfit-detail-name')).toHaveTextContent('Work fit');
    });
    expect(mockedFetchOutfit).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('outfit-detail-error')).toBeNull();
  });

  it('reports when fewer items resolved than the outfit references', async () => {
    // The API returns BOTH arrays precisely so this is detectable: `items` may
    // be shorter than `itemIds` when an item no longer resolves, and
    // `itemCount` counts the ids. Silently rendering two rows for a
    // three-item outfit tells the user their outfit changed and says nothing
    // about why.
    await open(detail({ itemIds: ['a', 'b', 'c'], itemCount: 3, items: [TOP, SHOES] }));

    expect(screen.getByTestId('outfit-detail-missing')).toHaveTextContent(
      '1 item is no longer available',
    );
    // The count still reports what the outfit REFERENCES, which is what makes
    // the notice legible: 3 referenced, 2 shown.
    expect(screen.getByTestId('outfit-detail-count')).toHaveTextContent('3 items');
    expect(textContent(screen.getByTestId('outfit-detail-items'))).toBe('1 jacket 2 shoes');
  });

  it('reports more than one missing item in the plural', async () => {
    await open(detail({ itemIds: ['a', 'b', 'c'], itemCount: 3, items: [TOP] }));

    expect(screen.getByTestId('outfit-detail-missing')).toHaveTextContent(
      '2 items are no longer available',
    );
  });

  it('says nothing about missing items when every item resolved', async () => {
    await open();

    // A notice that is always on screen is one nobody reads.
    expect(screen.queryByTestId('outfit-detail-missing')).toBeNull();
  });

  it('goes back from the header', async () => {
    await open();

    await press('outfit-detail-back');

    expect(back).toHaveBeenCalledTimes(1);
  });
});

/**
 * Stage 6 Task 4 — FR6 / TC-08: "User logs wearing an outfit … Wear history
 * recorded with correct date; item wear counts updated."
 *
 * This screen is the only place in the app that can reach
 * `POST /wear-history`. Without it Task 1's route, Task 3's hook and every
 * analytic Task 5 renders are unreachable from the product.
 */
function wearEvent(overrides: Partial<PublicWearEvent> = {}): PublicWearEvent {
  return {
    id: 'wear-1',
    userId: 'user-1',
    outfitId: 'outfit-1',
    outfitName: 'Work fit',
    // Deliberately TWO ids where the outfit on screen has three. The
    // confirmation must read the composition the SERVER snapshotted, not the
    // one this screen happens to be holding — `PublicWearEvent.itemIds` is
    // documented as "the outfit's composition AT THE MOMENT IT WAS WORN", and
    // an outfit edited on another device is exactly when the two differ.
    itemIds: ['a', 'b'],
    wornAt: '2026-08-25T09:00:00.000Z',
    createdAt: '2026-08-25T09:00:00.000Z',
    ...overrides,
  };
}

describe('OutfitDetailScreen — logging a wear (FR6 / TC-08)', () => {
  beforeEach(() => {
    canGoBack.mockReturnValue(true);
    mockedUseRouter.mockReturnValue({ back, replace, canGoBack });
    mockedUseLocalSearchParams.mockReturnValue({ id: 'outfit-1' });
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: null,
      token: TOKEN,
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
    mockedUseLogWear.mockReturnValue({ logWear, pending: false, error: null });
    logWear.mockResolvedValue(wearEvent());
  });

  afterEach(() => {
    jest.clearAllMocks();
    logWear.mockReset();
    consumeOutfitsDirty();
    TRACKING_READERS.forEach((reader) => consumeTrackingDirty(reader));
  });

  it('logs a wear from the outfit detail screen', async () => {
    await open();

    await press('outfit-log-wear');

    expect(logWear).toHaveBeenCalledTimes(1);
    expect(logWear).toHaveBeenCalledWith({ outfitId: 'outfit-1' });
  });

  it('never sends a wornAt for a wear that is happening now', async () => {
    /**
     * THE test this screen exists to be constrained by, and the one failure in
     * this stage that is invisible on the device gate.
     *
     * `POST /wear-history` rejects a future `wornAt` against a `now` it takes
     * AFTER the request lands, with a strict `>` and no skew tolerance at all.
     * Measured against this API, a client clock 1ms ahead passes and 5ms ahead
     * is a 400 the user cannot act on. On a dev machine the emulator and the
     * API share one clock and the skew is exactly zero, so a screen that fills
     * this in from `new Date().toISOString()` passes every gate in this repo,
     * every device screenshot, and then fails in the field on any handset
     * whose clock runs fast.
     *
     * Nothing below this screen can prevent it. `src/tracking/api.ts` never
     * manufactures a timestamp and `useLogWear` never defaults one — both are
     * pinned by their own suites — but neither can stop a CALLER from passing
     * one in. This is the boundary where that becomes checkable, so the
     * assertion is on the whole key set rather than on the value: any
     * `wornAt` at all, from any source, fails it.
     */
    await open();

    await press('outfit-log-wear');

    const sent = logWear.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['outfitId']);
    expect(sent).not.toHaveProperty('wornAt');
  });

  it('never sends a wornAt alongside an occasion either', async () => {
    // The occasion path builds a different object literal, so it is a second
    // place the timestamp could be reintroduced.
    await open();

    await typeOccasion('brunch');
    await press('outfit-log-wear');

    const sent = logWear.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['occasion', 'outfitId']);
  });

  it('sends the trimmed occasion, and omits it when blank', async () => {
    await open();

    await typeOccasion('  brunch  ');
    await press('outfit-log-wear');
    // Trimmed on the way out because the API trims too and applies its bound
    // AFTER trimming: 64 characters of padding is a 60-character occasion.
    expect(logWear).toHaveBeenLastCalledWith({ outfitId: 'outfit-1', occasion: 'brunch' });

    await typeOccasion('   ');
    await press('outfit-log-wear');
    // OMITTED, never sent empty. The API treats a blank occasion as absent, so
    // sending `''` would be a key that means nothing travelling on every wear.
    const second = logWear.mock.calls[1][0] as Record<string, unknown>;
    expect(second).not.toHaveProperty('occasion');
    expect(Object.keys(second).sort()).toEqual(['outfitId']);
  });

  it('bounds the occasion field by the shared constant', async () => {
    // From `@wardrobe/shared`, never a literal: the API rejects a longer
    // occasion outright and a rejected wear is one the user cannot fix by
    // retrying, so a client enforcing a different number either lets them type
    // their way into a 400 or refuses input the API would have accepted.
    await open();

    expect(screen.getByTestId('outfit-occasion-input').props.maxLength).toBe(MAX_OCCASION_LENGTH);
  });

  it('ignores a second Log wear press in the same frame', async () => {
    // `POST /wear-history` is not idempotent in any sense: a second request
    // writes a second event AND increments every member item's `wearCount`
    // again, corrupting the exact number "most worn" ranks on — with no
    // endpoint in the system able to undo it. A state flag cannot stop this;
    // React commits state on the next render, which is strictly after every
    // handler queued in this frame has run.
    const pending = deferred<PublicWearEvent>();
    logWear.mockReturnValue(pending.promise);
    await open();

    const fire = onPressOf(screen.getByTestId('outfit-log-wear'));
    await act(async () => {
      fire();
      fire();
    });

    expect(logWear).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(wearEvent());
    });
  });

  it('allows a second wear once the first has settled', async () => {
    // The guard is per in-flight call, not per outfit forever: an outfit worn
    // on Monday and again on Tuesday is two wears, and both must be recorded.
    await open();

    await press('outfit-log-wear');
    await press('outfit-log-wear');

    expect(logWear).toHaveBeenCalledTimes(2);
  });

  it('shows what was logged rather than a bare confirmation', async () => {
    logWear.mockResolvedValue(wearEvent({ outfitName: 'Work fit', occasion: 'brunch' }));
    await open();

    await typeOccasion('brunch');
    await press('outfit-log-wear');

    const confirmation = textContent(screen.getByTestId('outfit-log-wear-done'));
    expect(confirmation).toContain('Work fit');
    // TWO, from the event's snapshot — the outfit on screen has three items.
    // "Logged" with no detail is indistinguishable from a mis-tap on the wrong
    // outfit, which is the failure a confirmation exists to catch.
    expect(confirmation).toContain('2 items');
    expect(confirmation).toContain('brunch');
  });

  it('names an unnamed outfit in the confirmation rather than leaving a hole', async () => {
    // `outfitName` is absent both for an outfit that never had one and for one
    // deleted between the write and the read. Interpolating it raw renders
    // "Logged undefined".
    logWear.mockResolvedValue(wearEvent({ outfitName: undefined }));
    await open(detail({ name: undefined }));

    await press('outfit-log-wear');

    expect(textContent(screen.getByTestId('outfit-log-wear-done'))).toContain(UNNAMED_OUTFIT);
  });

  it('shows no confirmation before anything has been logged', async () => {
    await open();
    expect(screen.queryByTestId('outfit-log-wear-done')).toBeNull();
  });

  it('clears the occasion once the wear is logged', async () => {
    // The next wear of this outfit is a different wear. Leaving "brunch" in
    // the field makes it the silent default for whatever is logged next.
    await open();

    await typeOccasion('brunch');
    await press('outfit-log-wear');

    expect(screen.getByTestId('outfit-occasion-input').props.value).toBe('');
  });

  it('keeps an occasion typed while the request was in flight', async () => {
    // Same rule as the composer's name field: text entered DURING the write
    // belongs to the next wear, and clearing it unconditionally throws away
    // something the user typed.
    const pending = deferred<PublicWearEvent>();
    logWear.mockReturnValue(pending.promise);
    await open();

    await typeOccasion('brunch');
    await press('outfit-log-wear');
    await typeOccasion('dinner');

    await act(async () => {
      pending.resolve(wearEvent({ occasion: 'brunch' }));
    });

    expect(screen.getByTestId('outfit-occasion-input').props.value).toBe('dinner');
  });

  it('marks the tracking data dirty for every reader after a wear', async () => {
    // Every member item's `wearCount` and `lastWornAt` have just changed, and
    // the Profile tab's analytics are computed from exactly those fields.
    // Neither the wardrobe nor Profile can see its own staleness.
    await open();

    expect(consumeTrackingDirty('wardrobe')).toBe(false);

    await press('outfit-log-wear');

    expect(consumeTrackingDirty('wardrobe')).toBe(true);
    expect(consumeTrackingDirty('profile')).toBe(true);
  });

  it('leaves the outfit gallery flag alone', async () => {
    // Logging a wear changes no outfit. Marking the gallery dirty would throw
    // away every page the user had scrolled to, for a list that is unchanged.
    await open();

    await press('outfit-log-wear');

    expect(consumeOutfitsDirty()).toBe(false);
  });

  it('marks nothing dirty when the wear fails', async () => {
    // `logWear` resolves `null` on failure rather than rejecting — see
    // `useGuardedMutation`. Nothing was written, so nothing is stale.
    logWear.mockResolvedValue(null);
    await open();

    await press('outfit-log-wear');

    expect(consumeTrackingDirty('wardrobe')).toBe(false);
    expect(consumeTrackingDirty('profile')).toBe(false);
    expect(screen.queryByTestId('outfit-log-wear-done')).toBeNull();
  });

  it("shows the hook's failure message", async () => {
    mockedUseLogWear.mockReturnValue({
      logWear,
      pending: false,
      error: 'Cannot reach the server. Check your connection.',
    });
    await open();

    expect(screen.getByTestId('outfit-log-wear-error')).toHaveTextContent(
      'Cannot reach the server. Check your connection.',
    );
  });

  it('leaves a failed wear LOOKING retryable — the occasion kept, the button live', async () => {
    // Appearance only, and named that way deliberately. This asserts the field
    // value and the enabled state; it passed against a screen on which retry
    // was impossible, because a leaked ref guard changes neither. The
    // behavioural claim belongs to `lets a failed wear be retried` above, and
    // splitting the two is what stopped one name covering for the other.
    logWear.mockResolvedValue(null);
    await open();

    await typeOccasion('brunch');
    await press('outfit-log-wear');

    expect(screen.getByTestId('outfit-occasion-input').props.value).toBe('brunch');
    expect(screen.getByTestId('outfit-log-wear').props.accessibilityState?.disabled).toBeFalsy();
  });

  /**
   * The mocked hook, given back the ONE piece of state the flat
   * `mockReturnValue` above cannot express: an `error` that appears because a
   * write failed.
   *
   * Real React hooks inside the mock implementation, so the screen re-renders
   * with `error !== null` exactly as `useGuardedMutation` would make it. The
   * `logWear` spy is still the thing that is called and still receives the
   * screen's payload untouched, so every assertion about what goes out is
   * unchanged.
   *
   * This exists because a constant `error` froze the suite out of a state it
   * needed to press in — see the two tests below.
   */
  const FAILURE = 'Cannot reach the server. Check your connection.';

  function withFailureChannel(): void {
    mockedUseLogWear.mockImplementation(() => {
      const [error, setError] = React.useState<string | null>(null);
      const run = React.useCallback(async (input: LogWearInput) => {
        const result = await logWear(input);
        setError(result === null ? FAILURE : null);
        return result;
      }, []);
      return { logWear: run, pending: false, error };
    });
  }

  it('lets a failed wear be retried — a second press reaches the hook', async () => {
    /**
     * The behavioural half of "retryable", and the test the assertion below it
     * only LOOKED like it was making.
     *
     * Releasing `loggingRef` on the success path instead of in `finally` is a
     * one-line change that nothing else in this repo catches. Under it, the
     * first failed wear leaves `loggingRef.current === true` for the life of
     * the screen: the early return on `null` skips the release, the button
     * re-renders enabled with the error underneath it, and every subsequent
     * press returns immediately. The user is left looking at a live control
     * that does nothing, for ever, and the only escape is to leave the screen.
     *
     * `allows a second wear once the first has settled` cannot see it, because
     * both of its calls succeed — which is precisely the path the mutation
     * preserves. The failure has to come first.
     *
     * It also closes the last `wornAt` escape. A screen could stamp a
     * timestamp on the RETRY only ("record when they actually pressed"), keyed
     * on `logError !== null`, and no other test in this file presses while the
     * hook reports an error — the flat mock's `error` is a constant, so the
     * state is unreachable. The key-set assertion on the SECOND call is what
     * shuts that door.
     */
    withFailureChannel();
    logWear.mockResolvedValueOnce(null);
    logWear.mockResolvedValueOnce(wearEvent());

    await open();
    await press('outfit-log-wear');

    expect(logWear).toHaveBeenCalledTimes(1);
    // The retry happens in the state the failure actually produces, not in a
    // fresh one — that is the whole point of the stateful mock.
    expect(screen.getByTestId('outfit-log-wear-error')).toHaveTextContent(FAILURE);

    await press('outfit-log-wear');

    // Reached the hook. This is the assertion the guard-leak mutation fails.
    expect(logWear).toHaveBeenCalledTimes(2);
    // And the retry sends the same thing the first attempt did: still no
    // `wornAt`, from any source, on any path.
    expect(Object.keys(logWear.mock.calls[1][0] as Record<string, unknown>).sort()).toEqual([
      'outfitId',
    ]);
    expect(screen.getByTestId('outfit-log-wear-done')).toBeTruthy();
    // The dead message is gone once the retry succeeds.
    expect(screen.queryByTestId('outfit-log-wear-error')).toBeNull();
  });

  it('sends no wornAt on a retry that carries an occasion either', async () => {
    // The second branch of the same escape: `error !== null` AND an occasion,
    // which builds a different object literal.
    withFailureChannel();
    logWear.mockResolvedValueOnce(null);
    logWear.mockResolvedValueOnce(wearEvent({ occasion: 'brunch' }));

    await open();
    await typeOccasion('brunch');
    await press('outfit-log-wear');
    expect(screen.getByTestId('outfit-log-wear-error')).toHaveTextContent(FAILURE);

    await press('outfit-log-wear');

    expect(logWear).toHaveBeenCalledTimes(2);
    expect(Object.keys(logWear.mock.calls[1][0] as Record<string, unknown>).sort()).toEqual([
      'occasion',
      'outfitId',
    ]);
  });

  it('disables the button while a wear is in flight', async () => {
    mockedUseLogWear.mockReturnValue({ logWear, pending: true, error: null });
    await open();

    expect(screen.getByTestId('outfit-log-wear').props.accessibilityState?.disabled).toBe(true);
  });

  it('offers nothing to log while the outfit is still loading', async () => {
    const loading = deferred<PublicOutfitDetail>();
    mockedFetchOutfit.mockReturnValue(loading.promise);

    await render(<OutfitDetailScreen />);

    expect(screen.queryByTestId('outfit-log-wear')).toBeNull();

    await act(async () => {
      loading.resolve(detail());
    });
  });
});
