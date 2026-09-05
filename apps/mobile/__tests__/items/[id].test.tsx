import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { LaundryStatus, PublicClothingItem } from '@wardrobe/shared';
// The real `ApiClientError` — not a mock. Automocking a class that extends
// Error yields something that cannot be constructed, which is why
// `src/api/client` is never `jest.mock`ed anywhere in this repo. The screen
// distinguishes a 404 from every other failure by testing this class and its
// `status`, so the instances rejected below have to be the genuine article.
import { ApiClientError } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { deleteItem, fetchItem } from '../../src/wardrobe/api';
import { useRetireItem } from '../../src/wardrobe/useRetireItem';
// The REAL signal module, not a mock: it is a handful of lines of module state
// with no dependencies, and `__tests__/tracking/trackingDirty.test.ts` pins its
// contract separately. Asserting through `consumeTrackingDirty` tests that this
// screen actually moved the bit, rather than that it called a function.
import {
  TRACKING_READERS,
  consumeTrackingDirty,
} from '../../src/tracking/trackingDirty';
import { useLaundryStatus } from '../../src/tracking/useLaundryStatus';
import ItemDetailScreen from '../../app/items/[id]';
// The heading goes through `categoryLabel`, so the assertions below do too
// rather than carrying a second copy of the spelling. That is not laziness: the
// screen used to render the raw `shoes` under a `textTransform: 'capitalize'`,
// which leaves the TEXT lowercase and only paints it capitalised — so a literal
// here would have been asserting the old mechanism, and `tshirt` would have to
// read as "Tshirt" for it to keep passing.
import { categoryLabel } from '../../src/format/text';

/**
 * Location, deliberately: this file is under `apps/mobile/__tests__/`, OUTSIDE
 * the Expo Router app root, exactly like `__tests__/index.test.tsx` and
 * `__tests__/add.test.tsx`.
 *
 * The brief drafted it as `app/items/__tests__/[id].test.tsx`. That path is not
 * safe, and the brief's own stated reason is why. `expo-router/_ctx.android.js`
 * builds its route context with
 *
 *   require.context(APP_ROOT, true,
 *     /^(?:\.\/)(?!(?:(?:(?:.*\+api)|(?:\+html)|(?:\+middleware)))\.[tj]sx?$).*(?:\.ios|\.web)?\.[tj]sx?$/)
 *
 * — recursive, with the only exclusions being `+api`/`+html`/`+middleware`.
 * Checked against expo-router 57.0.15's actual file rather than assumed: that
 * regex returns `true` for `./items/__tests__/[id].test.tsx` just as it does
 * for `./items/[id].test.tsx`. A `__tests__` directory is not special to it, so
 * either path drags @testing-library/react-native into the production Android
 * bundle — the Stage 2 Task 8 failure recorded at README.md:161. `@expo/cli`'s
 * `TYPED_ROUTES_EXCLUSION_REGEX` (`/(_layout|[^/]*?\+[^/]*?)\.[tj]sx?$/`)
 * likewise matches neither, so either would also inject a junk member into the
 * generated href union. Only leaving the app root avoids both.
 */

// `../../src/wardrobe/api` exports two plain functions and (erased) interfaces
// — no class — so a factory mock is safe here in the way a mock of
// `../../src/api/client` would not be. `src/wardrobe/api.test.ts` already pins
// down the URL and the envelope; this file is about what the screen does with
// the result.
jest.mock('../../src/wardrobe/api', () => ({
  fetchItems: jest.fn(),
  fetchItem: jest.fn(),
  setRetired: jest.fn(),
  deleteItem: jest.fn(),
}));

// Only `useAuth` is read by this screen, so the real module (and its
// expo-secure-store dependency) never loads.
jest.mock('../../src/auth/AuthContext', () => ({ useAuth: jest.fn() }));

// Only these two hooks are used, so a factory mock avoids loading expo-router
// (and its native deps) entirely.
jest.mock('expo-router', () => ({
  useLocalSearchParams: jest.fn(),
  useRouter: jest.fn(),
}));

/**
 * The laundry hook is mocked, and that is the point rather than a shortcut.
 *
 * `useLaundryStatus` already collapses two same-frame calls for one item into
 * a single request, and it has its own suite proving it
 * (`__tests__/tracking/useLaundryStatus.test.ts`). Running the real hook here
 * would therefore make the screen's own guard UNFALSIFIABLE: replace this
 * screen's ref with a state flag and the shared guard still swallows the
 * second call, so `setLaundryStatus` is invoked once either way and the test
 * passes against the broken screen. `useGuardedMutation`'s own header says as
 * much — a shared guard "is deliberately not evidence that any particular
 * caller uses it".
 *
 * With the hook mocked, `setStatus` is a bare `jest.fn` that cannot decline,
 * so the only thing between two presses and two calls is the screen.
 *
 * A factory mock is safe: the module exports one function and (erased)
 * interfaces, no class. Nothing here mocks `../../src/api/client` — an
 * automocked `ApiClientError` cannot be constructed.
 */
jest.mock('../../src/tracking/useLaundryStatus', () => ({ useLaundryStatus: jest.fn() }));

/**
 * The retire hook is mocked for the SAME reason the laundry one is, verbatim:
 * `useRetireItem` collapses two same-frame calls itself and has its own suite
 * proving it (`__tests__/wardrobe/useRetireItem.test.ts`), so running the real
 * hook here would make this screen's own `retiringRef` unfalsifiable — swap it
 * for a state flag and the shared guard still swallows the second call.
 */
jest.mock('../../src/wardrobe/useRetireItem', () => ({ useRetireItem: jest.fn() }));

const mockedFetchItem = jest.mocked(fetchItem);
const mockedDeleteItem = jest.mocked(deleteItem);
const mockedUseRetireItem = jest.mocked(useRetireItem);
const mockedUseLaundryStatus = jest.mocked(useLaundryStatus);
const mockedUseAuth = jest.mocked(useAuth);
const mockedUseLocalSearchParams = useLocalSearchParams as unknown as jest.Mock;
const mockedUseRouter = useRouter as unknown as jest.Mock;

const TOKEN = 'tok-abc';

/** The mocked hook's mutation. Its resolved value is set per test. */
const setStatus = jest.fn();
/** The retire hook's mutation, same arrangement. */
const setRetiredMutation = jest.fn();

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

function item(overrides: Partial<PublicClothingItem> = {}): PublicClothingItem {
  const merged: PublicClothingItem = {
    id: 'item-1',
    userId: 'user-1',
    imageUrl: 'https://example.test/full/item-1.jpg',
    // Deliberately different from `imageUrl`, so "renders the full image" is
    // distinguishable from "renders whatever the tile renders".
    thumbnailUrl: 'https://example.test/thumb/item-1.jpg',
    category: 'jacket',
    colors: [{ hex: '#001f3f', name: 'navy', share: 1 }],
    seasons: ['winter'],
    laundryStatus: 'available',
    retired: false,
    wearCount: 0,
    source: 'ai',
    aiConfidence: 0.82,
    createdAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };

  // The default is the ordinary, un-corrected shape: the model's category and
  // the item's are the same word, which is what a freshly tagged upload
  // produces (`apps/api/src/routes/items.ts` writes both from the same
  // `tags.category`). Written here rather than as a literal above so that a
  // test overriding `category` does not silently become an *override* fixture
  // — which would change which branch of the confidence guard it exercises
  // without saying so. A test that wants a corrected item states `aiCategory`
  // explicitly; a manual item gets none, because no model ran.
  if (!('aiCategory' in overrides) && merged.source === 'ai') {
    merged.aiCategory = merged.category;
  }
  return merged;
}

/** Renders the screen and waits for the fetched item to be on screen. */
async function renderReady(value: PublicClothingItem) {
  mockedFetchItem.mockResolvedValueOnce(value);
  const view = await render(<ItemDetailScreen />);
  await waitFor(() => expect(screen.getByTestId('item-detail-category')).toBeTruthy());
  return view;
}

describe('ItemDetailScreen (FR4 — item details)', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: null,
      token: TOKEN,
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
    mockedUseLocalSearchParams.mockReturnValue({ id: 'item-1' });
    canGoBack.mockReturnValue(true);
    mockedUseRouter.mockReturnValue({ back, replace, canGoBack });
    // The idle shape of the mocked hook. Tests that want a failure or an
    // in-flight state override this.
    mockedUseLaundryStatus.mockReturnValue({ setStatus, pending: false, error: null });
    mockedUseRetireItem.mockReturnValue({
      setRetired: setRetiredMutation,
      pending: false,
      error: null,
    });
  });

  afterEach(() => {
    // `reset`, not `clear`: some tests install a lasting `mockImplementation`
    // on `fetchItem`, and `clearAllMocks` wipes only the call log. Everything
    // else is re-established in `beforeEach`.
    jest.resetAllMocks();
    // Module state is shared between the tests in this file. Cleared through
    // the public door so a leftover mark cannot make the next test's "did not
    // mark" assertion depend on execution order.
    TRACKING_READERS.forEach((reader) => consumeTrackingDirty(reader));
  });

  it('shows a loading state first', async () => {
    const pending = deferred<PublicClothingItem>();
    mockedFetchItem.mockReturnValueOnce(pending.promise);

    await render(<ItemDetailScreen />);

    expect(screen.getByTestId('item-detail-loading')).toBeTruthy();
    expect(screen.queryByTestId('item-detail-category')).toBeNull();
    expect(screen.queryByTestId('item-detail-not-found')).toBeNull();

    await act(async () => {
      pending.resolve(item());
    });

    await waitFor(() => expect(screen.getByTestId('item-detail-category')).toBeTruthy());
    expect(screen.queryByTestId('item-detail-loading')).toBeNull();
  });

  it('fetches the item named in the route, with the signed-in token', async () => {
    // The contract decision this screen exists to honour: the detail comes from
    // `GET /items/:id`, not from an object carried through navigation. A screen
    // that reads navigation state is unreachable by deep link and blank after a
    // reload, and Stage 5's outfit builder links straight here.
    mockedUseLocalSearchParams.mockReturnValue({ id: 'item-42' });

    await renderReady(item({ id: 'item-42' }));

    expect(mockedFetchItem).toHaveBeenCalledWith('item-42', TOKEN);
  });

  it('renders the category, seasons and wear count', async () => {
    await renderReady(item({ category: 'shoes', seasons: ['spring', 'autumn'], wearCount: 7 }));

    expect(screen.getByTestId('item-detail-category')).toHaveTextContent(categoryLabel('shoes'));
    // Exact, not `toContain('spring')`. A `toContain` passes against
    // `String(item.seasons)` — the raw array coercion `spring,autumn`, which is
    // a data structure leaking onto the screen rather than a list a person
    // reads. Same standard the laundry assertion below already holds.
    expect(screen.getByTestId('item-detail-seasons')).toHaveTextContent('spring, autumn');
    expect(textContent(screen.getByTestId('item-detail-seasons'))).not.toContain('spring,autumn');
    expect(screen.getByTestId('item-detail-wear-count')).toHaveTextContent('7');
  });

  it('renders the full image, not the thumbnail', async () => {
    // This is the *detail* screen: the grid's 240px thumbnail is what the tile
    // shows, and using it here would put a visibly soft image under the
    // attributes it is meant to justify.
    const shown = item();

    await renderReady(shown);

    expect(imageUri(screen.getByTestId('item-detail-image'))).toBe(shown.imageUrl);
    expect(imageUri(screen.getByTestId('item-detail-image'))).not.toBe(shown.thumbnailUrl);
  });

  it('renders each colour with its share as a percentage', async () => {
    // TC-05's signal, cashed in. `packages/shared/src/items.ts` documents why
    // the fraction is persisted: "navy 55% / white 45%" is what makes a
    // two-tone garment legible as two-tone rather than as a navy one.
    await renderReady(
      item({
        colors: [
          { hex: '#001f3f', name: 'navy', share: 0.55 },
          { hex: '#ffffff', name: 'white', share: 0.45 },
        ],
      }),
    );

    expect(screen.getByTestId('item-detail-color-0')).toHaveTextContent('navy 55%');
    expect(screen.getByTestId('item-detail-color-1')).toHaveTextContent('white 45%');

    // Each label is paired with a swatch carrying that colour. Whether the
    // swatch actually *looks* navy is a pixel property of a real screen that
    // RNTL cannot see — Task 7 photographs it; this asserts only that the hex
    // reached the style.
    expect(StyleSheet.flatten(screen.getByTestId('item-detail-swatch-0').props.style)).toMatchObject({
      backgroundColor: '#001f3f',
    });
    expect(StyleSheet.flatten(screen.getByTestId('item-detail-swatch-1').props.style)).toMatchObject({
      backgroundColor: '#ffffff',
    });
  });

  it('omits the share when the colour has none', async () => {
    // `share` is optional on `ItemColor`: every item created before Stage 3
    // has colours with `hex` and `name` and nothing else. Rendering
    // `Math.round(share * 100)` unguarded turns those into "NaN%", and a
    // `${share}%` interpolation into "undefined%".
    await renderReady(item({ colors: [{ hex: '#001f3f', name: 'navy' }] }));

    const label = screen.getByTestId('item-detail-color-0');
    expect(label).toHaveTextContent('navy');
    const rendered = textContent(label);
    expect(rendered).not.toContain('NaN');
    expect(rendered).not.toContain('undefined');
    // Nothing at all, rather than "navy 0%" — a missing measurement is not a
    // measurement of zero.
    expect(rendered).not.toContain('%');
  });

  it('omits the share when the server sends null instead of omitting it', async () => {
    // Nothing between the socket and this screen validates the response shape
    // — `apiRequest` ends in `return parsed as T`. `share: null` types as
    // impossible and arrives as `null * 100 === 0`, which would render the
    // confident falsehood "navy 0%". The cast is the point of the test.
    await renderReady(
      item({ colors: [{ hex: '#001f3f', name: 'navy', share: null } as unknown as { hex: string; name: string }] }),
    );

    const rendered = textContent(screen.getByTestId('item-detail-color-0'));
    expect(rendered).toBe('navy');
    expect(rendered).not.toContain('%');
  });

  it('shows a real but tiny cluster as <1%, never as 0%', async () => {
    // `services/ai/app/colour.py` clusters a 100x100 downsample with no
    // minimum-share filter, so any cluster under 50 pixels rounds to zero — a
    // navy jacket with a small white logo. "white 0%" says the colour is not
    // there, which is the same confident falsehood the null guard exists to
    // prevent.
    await renderReady(
      item({
        colors: [
          { hex: '#001f3f', name: 'navy', share: 0.996 },
          { hex: '#ffffff', name: 'white', share: 0.004 },
        ],
      }),
    );

    const tiny = textContent(screen.getByTestId('item-detail-color-1'));
    expect(tiny).toBe('white <1%');
    // Scoped to this label, not the whole block: "navy 100%" contains "0%".
    expect(tiny).not.toContain('0%');
    // The floor must not swallow shares that genuinely round to 1% or more.
    expect(screen.getByTestId('item-detail-color-0')).toHaveTextContent('navy 100%');
  });

  it('omits a share that is outside 0..1 rather than printing it', async () => {
    // Same threat model as the null case: nothing between the socket and this
    // screen validates the response. `4` renders `navy 400%` and `-0.4` renders
    // `navy -40%` — both a value that is not a share being printed as one.
    // [0,1] is the interval `apps/api/src/ai/tagClient.ts` already validates
    // the AI service's own response against.
    await renderReady(
      item({
        colors: [
          { hex: '#001f3f', name: 'navy', share: 4 },
          { hex: '#ffffff', name: 'white', share: -0.4 },
        ],
      }),
    );

    expect(screen.getByTestId('item-detail-color-0')).toHaveTextContent('navy');
    expect(screen.getByTestId('item-detail-color-1')).toHaveTextContent('white');
    const rendered = textContent(screen.getByTestId('item-detail-colors'));
    expect(rendered).not.toContain('%');
    expect(rendered).not.toContain('400');
    expect(rendered).not.toContain('-40');
  });

  it('shows the AI confidence while the AI\'s own category still stands', async () => {
    await renderReady(item({ source: 'ai', category: 'jacket', aiCategory: 'jacket', aiConfidence: 0.82 }));

    expect(screen.getByTestId('item-detail-source')).toHaveTextContent('AI tagged');
    expect(screen.getByTestId('item-detail-confidence')).toHaveTextContent('82%');
    // Nothing was corrected, so there is nothing to say about a correction.
    expect(screen.queryByTestId('item-detail-override')).toBeNull();
  });

  it('does not show a confidence once the user has corrected the category', async () => {
    // The case that made this guard wrong before. The model called the photo a
    // shirt at 0.87 and the user corrected it to a jacket. `PATCH /items/:id`
    // writes `category` and nothing else — `source` stays 'ai' by design
    // (Stage 3 Task 5: it records how the item was tagged, not who last
    // touched it) — so a guard of `source === 'ai' && aiConfidence !==
    // undefined` renders "jacket - AI tagged - AI confidence 87%". That 87%
    // was a measurement about the word "shirt".
    await renderReady(item({ source: 'ai', category: 'jacket', aiCategory: 'shirt', aiConfidence: 0.87 }));

    expect(screen.getByTestId('item-detail-category')).toHaveTextContent(categoryLabel('jacket'));
    expect(screen.queryByTestId('item-detail-confidence')).toBeNull();
    expect(screen.queryByText(/87%/)).toBeNull();
  });

  it('says what the user changed the category from', async () => {
    // Withholding the confidence is only half of it. The override is a real
    // fact about the item and `aiCategory` is the only place it is recorded,
    // so the screen states it rather than silently dropping a row.
    await renderReady(item({ source: 'ai', category: 'jacket', aiCategory: 'shirt', aiConfidence: 0.87 }));

    expect(screen.getByTestId('item-detail-override')).toHaveTextContent('You changed this from shirt.');
  });

  it('does not show a confidence for an item stored before aiCategory existed', async () => {
    // Absent `aiCategory` means "unknown", not "not corrected" — every item
    // stored before the field existed looks like this. A confidence shown
    // beside a category that may or may not have been corrected is the same
    // defect as showing one beside a category that certainly was.
    await renderReady(item({ source: 'ai', aiCategory: undefined, aiConfidence: 0.82 }));

    expect(screen.queryByTestId('item-detail-confidence')).toBeNull();
    expect(screen.queryByText(/82%/)).toBeNull();
    // …and it must not claim a correction it cannot know about either.
    expect(screen.queryByTestId('item-detail-override')).toBeNull();
  });

  it('does not show a confidence when source is manual', async () => {
    // `aiConfidence` is set here on a manual item deliberately. Be honest about
    // what that is: the API cannot currently produce this shape —
    // `apps/api/src/routes/items.ts` writes `source: 'ai'` *with* a confidence
    // or `source: 'manual'` *without* one, never the mixture. This guards the
    // branch, not a live case, and is cheap defence in depth for a screen whose
    // whole job is not to state things it cannot support.
    await renderReady(item({ source: 'manual', aiConfidence: 0.99 }));

    expect(screen.getByTestId('item-detail-source')).toHaveTextContent('Categorised by you');
    expect(screen.queryByTestId('item-detail-confidence')).toBeNull();
    expect(screen.queryByText(/99%/)).toBeNull();
  });

  it('does not show a confidence for an AI item that recorded none', async () => {
    // Items tagged before Stage 3 stored `source: 'ai'` with no confidence;
    // `Math.round(undefined * 100)` is NaN.
    await renderReady(item({ source: 'ai', aiConfidence: undefined }));

    expect(screen.queryByTestId('item-detail-confidence')).toBeNull();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it('shows the laundry status', async () => {
    await renderReady(item({ laundryStatus: 'in_laundry' }));

    const status = screen.getByTestId('item-detail-laundry');
    expect(status).toHaveTextContent('In laundry');
    // The stored enum is a database value, not a sentence. Printing it raw
    // would satisfy "a laundry status is shown" while showing "in_laundry".
    expect(textContent(status)).not.toContain('in_laundry');
  });

  it('falls back to the raw status for one this build has never heard of', async () => {
    // Same threat model as the out-of-range share: `apiRequest` ends in
    // `return parsed as T`, so a status only the server knows about arrives
    // typed as one of the two this build compiles against. A bare
    // `LAUNDRY_LABELS[status]` lookup then renders an empty value and an
    // accessibility label reading "Laundry: undefined" — a screen reader
    // announcing nothing at all. The raw word is at least true.
    await renderReady(item({ laundryStatus: 'drying' as unknown as PublicClothingItem['laundryStatus'] }));

    const status = screen.getByTestId('item-detail-laundry');
    expect(status).toHaveTextContent('drying');
    expect(textContent(status)).not.toContain('undefined');
  });

  it('shows the date the item was added', async () => {
    await renderReady(item({ createdAt: '2026-08-01T10:00:00.000Z' }));

    expect(screen.getByTestId('item-detail-created')).toHaveTextContent('1 Aug 2026');
  });

  it('dates the item in the device\'s own timezone, not UTC', async () => {
    // `jest.config.js` pins TZ to America/Los_Angeles, which is what makes the
    // two readings distinguishable at all. An item added at 18:00 on 1 August
    // in Los Angeles is stored as this instant; formatted from UTC, a field
    // labelled "Added" would read "2 Aug 2026" — tomorrow. That is not a
    // date-line edge case: it is every negative offset, every evening.
    await renderReady(item({ createdAt: '2026-08-02T01:00:00.000Z' }));

    expect(screen.getByTestId('item-detail-created')).toHaveTextContent('1 Aug 2026');
  });

  it('renders a malformed timestamp as itself rather than "Invalid Date"', async () => {
    await renderReady(item({ createdAt: 'not-a-timestamp' }));

    const added = screen.getByTestId('item-detail-created');
    expect(added).toHaveTextContent('not-a-timestamp');
    expect(textContent(added)).not.toContain('Invalid Date');
    expect(textContent(added)).not.toContain('NaN');
  });

  it('shows when the item was last worn, and omits the row when it never was', async () => {
    // Nothing writes `lastWornAt` today — no route in
    // `apps/api/src/routes/items.ts` sets it — so this row never renders
    // against the current API. It is stored and on `PublicClothingItem`
    // though, so the screen handles it now rather than silently omitting an
    // attribute the moment a wear-tracking route lands.
    const worn = await renderReady(item({ lastWornAt: '2026-08-10T12:00:00.000Z' }));
    expect(screen.getByTestId('item-detail-last-worn')).toHaveTextContent('10 Aug 2026');
    await worn.unmount();

    await renderReady(item({ lastWornAt: undefined }));
    // Absent, not "Never worn": this app has no way to know an item was never
    // worn, only that nothing recorded a wear.
    expect(screen.queryByTestId('item-detail-last-worn')).toBeNull();
  });

  it('shows a not-found state on a 404', async () => {
    // A 404 here means "no such item, or not yours" — the API answers both the
    // same way on purpose. Neither a crash nor a spinner that never stops.
    mockedFetchItem.mockRejectedValueOnce(new ApiClientError('NOT_FOUND', 'Item not found', 404));

    await render(<ItemDetailScreen />);

    await waitFor(() => expect(screen.getByTestId('item-detail-not-found')).toBeTruthy());
    expect(screen.queryByTestId('item-detail-loading')).toBeNull();
    expect(screen.queryByTestId('item-detail-error')).toBeNull();
    expect(screen.queryByTestId('item-detail-category')).toBeNull();
  });

  it('shows the not-found state when the route carries no id', async () => {
    // Deep links and hand-typed URLs both land here. Without the guard the
    // screen would request `/items/undefined`, which the API answers 404 for
    // anyway — a round trip to learn what the params already said.
    mockedUseLocalSearchParams.mockReturnValue({});

    await render(<ItemDetailScreen />);

    await waitFor(() => expect(screen.getByTestId('item-detail-not-found')).toBeTruthy());
    expect(mockedFetchItem).not.toHaveBeenCalled();
  });

  it('shows an error state, not a not-found state, when the request fails otherwise', async () => {
    mockedFetchItem.mockRejectedValueOnce(
      new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.'),
    );

    await render(<ItemDetailScreen />);

    await waitFor(() =>
      expect(screen.getByTestId('item-detail-error-message')).toHaveTextContent(
        'Cannot reach the server. Check your connection.',
      ),
    );
    expect(screen.queryByTestId('item-detail-not-found')).toBeNull();
  });

  it('refetches when the error state is retried', async () => {
    mockedFetchItem.mockRejectedValueOnce(new ApiClientError('NETWORK', 'offline'));

    await render(<ItemDetailScreen />);
    await waitFor(() => expect(screen.getByTestId('item-detail-retry')).toBeTruthy());

    mockedFetchItem.mockResolvedValueOnce(item({ category: 'shoes' }));
    await act(async () => {
      fireEvent.press(screen.getByTestId('item-detail-retry'));
    });

    await waitFor(() => expect(screen.getByTestId('item-detail-category')).toHaveTextContent(categoryLabel('shoes')));
    expect(mockedFetchItem).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('item-detail-error')).toBeNull();
  });

  it('ignores a response for an item the screen has already moved off', async () => {
    // The `cancelled` flag in the fetch effect is the only concurrency logic in
    // this screen. Stage 5's outfit builder can push from one detail screen
    // straight to another, which re-runs the effect with a new id while the
    // first request is still open; without the guard the slow first response
    // lands last and paints the previous garment's details under the new one's
    // route.
    const first = deferred<PublicClothingItem>();
    const second = deferred<PublicClothingItem>();
    mockedFetchItem.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    mockedUseLocalSearchParams.mockReturnValue({ id: 'item-1' });
    const view = await render(<ItemDetailScreen />);

    mockedUseLocalSearchParams.mockReturnValue({ id: 'item-2' });
    await act(async () => {
      await view.rerender(<ItemDetailScreen />);
    });

    await act(async () => {
      second.resolve(item({ id: 'item-2', category: 'shoes' }));
    });
    await waitFor(() => expect(screen.getByTestId('item-detail-category')).toHaveTextContent(categoryLabel('shoes')));

    // The superseded request finally answers.
    await act(async () => {
      first.resolve(item({ id: 'item-1', category: 'dress' }));
    });

    expect(screen.getByTestId('item-detail-category')).toHaveTextContent(categoryLabel('shoes'));
    expect(mockedFetchItem).toHaveBeenNthCalledWith(1, 'item-1', TOKEN);
    expect(mockedFetchItem).toHaveBeenNthCalledWith(2, 'item-2', TOKEN);
  });

  it('goes back to the screen that opened it', async () => {
    // The root Stack runs with `headerShown: false`, so this screen renders no
    // native back affordance of its own.
    canGoBack.mockReturnValue(true);
    await renderReady(item());

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-detail-back'));
    });

    expect(back).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('falls back to the wardrobe when there is nothing to go back to', async () => {
    // Opened by a deep link, this is the first entry in the stack: `back()`
    // has nothing to pop and would leave the user on a screen with no exit.
    canGoBack.mockReturnValue(false);
    await renderReady(item());

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-detail-back'));
    });

    expect(back).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith('/');
  });
});

/**
 * Minimal shape of a React fiber, declared locally so this file does not take a
 * dependency on react-reconciler's types for one helper.
 */
type FiberLike = { memoizedProps: Record<string, unknown> | null; return: FiberLike | null };

/**
 * The `onPress` handler the element was rendered with, as a callable.
 *
 * Lifted verbatim from `__tests__/outfits/[id].test.tsx`, where it was
 * introduced for the same job. `fireEvent.press` is async and wraps every press
 * in its own `act()`, so two un-awaited presses inside one outer `act` make
 * React 19 log "You seem to have overlapping act() calls" — a warning, and
 * therefore a failure by this project's pristine-output rule. Awaiting them
 * instead defeats the point: the first press flushes React, the button disables
 * itself, and RNTL's `isEventEnabled` then refuses the second press outright,
 * so the test would pass against a guard that cannot stop the race.
 *
 * Invoking the captured handler twice is also the closer model of the defect:
 * two touch events dispatched in the same frame both call the handler instance
 * that was on screen when the first one landed.
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

/**
 * Stage 6 Task 4 — FR7 / TC-09's write half: "User marks item as 'In Laundry'
 * … Status updated in database and reflected in UI."
 *
 * This screen is the only place in the app that can reach
 * `PATCH /items/:id/laundry`. Without it Task 1's route and Task 3's hook are
 * both unreachable from the product and TC-09 is unsupported.
 */
describe('ItemDetailScreen — the laundry toggle (FR7 / TC-09)', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: null,
      token: TOKEN,
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
    mockedUseLocalSearchParams.mockReturnValue({ id: 'item-1' });
    canGoBack.mockReturnValue(true);
    mockedUseRouter.mockReturnValue({ back, replace, canGoBack });
    mockedUseLaundryStatus.mockReturnValue({ setStatus, pending: false, error: null });
    mockedUseRetireItem.mockReturnValue({
      setRetired: setRetiredMutation,
      pending: false,
      error: null,
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
    TRACKING_READERS.forEach((reader) => consumeTrackingDirty(reader));
  });

  it('offers to put an available item in the laundry', async () => {
    await renderReady(item({ laundryStatus: 'available' }));

    const toggle = screen.getByTestId('item-laundry-toggle');
    // The button says what pressing it DOES, not what the item currently is —
    // the "Laundry" row directly above it already says that, and a control
    // labelled with the present state is the classic toggle ambiguity.
    expect(toggle.props.accessibilityLabel as string).toMatch(/mark .*in laundry/i);
    expect(textContent(toggle)).toMatch(/laundry/i);
  });

  it('offers to bring an in-laundry item back', async () => {
    await renderReady(item({ laundryStatus: 'in_laundry' }));

    const toggle = screen.getByTestId('item-laundry-toggle');
    expect(toggle.props.accessibilityLabel as string).toMatch(/mark .*available/i);
  });

  it('toggles an item to in_laundry from the detail screen', async () => {
    const shown = item({ id: 'item-1', laundryStatus: 'available' });
    setStatus.mockResolvedValue({ ...shown, laundryStatus: 'in_laundry' });
    await renderReady(shown);

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-laundry-toggle'));
    });

    // The id and the OPPOSITE status. Never a hard-coded 'in_laundry': a
    // toggle that can only send one value is a one-way door, and there is no
    // other control in the app that brings a garment back out of the wash.
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith('item-1', 'in_laundry');
  });

  it('toggles an in-laundry item back to available', async () => {
    const shown = item({ id: 'item-1', laundryStatus: 'in_laundry' });
    setStatus.mockResolvedValue({ ...shown, laundryStatus: 'available' });
    await renderReady(shown);

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-laundry-toggle'));
    });

    expect(setStatus).toHaveBeenCalledWith('item-1', 'available');
  });

  it('re-renders from the item the server answered with', async () => {
    // No optimistic update, deliberately — see `useLaundryStatus`'s header.
    // The updated item is what `PATCH /items/:id/laundry` returned, so the row
    // and the button below it are showing a fact rather than a guess, and a
    // failed transition cannot leave the screen claiming a state the wardrobe
    // is not in.
    const shown = item({ laundryStatus: 'available' });
    setStatus.mockResolvedValue({ ...shown, laundryStatus: 'in_laundry' });
    await renderReady(shown);

    expect(screen.getByTestId('item-detail-laundry')).toHaveTextContent('Available');

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-laundry-toggle'));
    });

    expect(screen.getByTestId('item-detail-laundry')).toHaveTextContent('In laundry');
    // And the control now offers the other direction.
    expect(
      screen.getByTestId('item-laundry-toggle').props.accessibilityLabel as string,
    ).toMatch(/mark .*available/i);
  });

  it('ignores a second toggle press that lands before the first resolves', async () => {
    // Stage 5 shipped a same-frame double tap that created two identical
    // outfits, and the same bug was live on the item-upload path. Here it is
    // worse than a wasted round trip: `PATCH /items/:id/laundry` appends a row
    // to the transition log for EVERY transition including a no-op one, so a
    // double tap writes a phantom history entry for a change the user made
    // once. A state flag cannot stop it — React commits state on the NEXT
    // render, which is strictly after every handler queued in this frame has
    // already run.
    const pending = deferred<PublicClothingItem>();
    setStatus.mockReturnValue(pending.promise);
    await renderReady(item({ laundryStatus: 'available' }));

    const press = onPressOf(screen.getByTestId('item-laundry-toggle'));
    await act(async () => {
      press();
      press();
    });

    expect(setStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(item({ laundryStatus: 'in_laundry' }));
    });
  });

  it('allows a genuine second toggle once the first has settled', async () => {
    // The other side of the guard: it is per in-flight call, not per item
    // forever. A user who puts a shirt in the wash and takes it straight back
    // out has made two intents and both must reach the server.
    const shown = item({ laundryStatus: 'available' });
    setStatus.mockResolvedValueOnce({ ...shown, laundryStatus: 'in_laundry' });
    setStatus.mockResolvedValueOnce({ ...shown, laundryStatus: 'available' });
    await renderReady(shown);

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-laundry-toggle'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('item-laundry-toggle'));
    });

    expect(setStatus).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenNthCalledWith(1, 'item-1', 'in_laundry');
    expect(setStatus).toHaveBeenNthCalledWith(2, 'item-1', 'available');
  });

  it('marks the tracking data dirty for every reader after a successful toggle', async () => {
    // The wardrobe grid behind this screen is holding an item whose status has
    // just changed, and the Profile tab's `itemsInLaundry` count is now wrong.
    // Neither can see its own staleness, so this is the only place that can
    // tell them.
    const shown = item({ laundryStatus: 'available' });
    setStatus.mockResolvedValue({ ...shown, laundryStatus: 'in_laundry' });
    await renderReady(shown);

    expect(consumeTrackingDirty('wardrobe')).toBe(false);

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-laundry-toggle'));
    });

    expect(consumeTrackingDirty('wardrobe')).toBe(true);
    // Per reader, so the grid consuming it does not blind the Profile tab.
    expect(consumeTrackingDirty('profile')).toBe(true);
  });

  it('marks nothing dirty when the toggle fails', async () => {
    // `setStatus` resolves `null` on failure rather than rejecting — see
    // `useGuardedMutation`. Nothing changed on the server, so a refetch on the
    // next focus would be a page-one load bought for nothing.
    setStatus.mockResolvedValue(null);
    await renderReady(item({ laundryStatus: 'available' }));

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-laundry-toggle'));
    });

    expect(consumeTrackingDirty('wardrobe')).toBe(false);
    expect(consumeTrackingDirty('profile')).toBe(false);
  });

  it('leaves a failed toggle LOOKING retryable, with the status untouched', async () => {
    // Appearance only, and named that way deliberately: this passed against a
    // screen on which retry was impossible, because a leaked ref guard changes
    // neither the row nor the button's label. The behavioural claim belongs to
    // `lets a failed toggle be retried` above.
    setStatus.mockResolvedValue(null);
    await renderReady(item({ laundryStatus: 'available' }));

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-laundry-toggle'));
    });

    // Painting the attempted status over the row would report a write that did
    // not happen, and the next visit would silently show the old one back with
    // nothing to explain it.
    expect(screen.getByTestId('item-detail-laundry')).toHaveTextContent('Available');
    expect(
      screen.getByTestId('item-laundry-toggle').props.accessibilityLabel as string,
    ).toMatch(/mark .*in laundry/i);
  });

  it("shows the hook's failure message", async () => {
    mockedUseLaundryStatus.mockReturnValue({
      setStatus,
      pending: false,
      error: 'Cannot reach the server. Check your connection.',
    });
    await renderReady(item());

    expect(screen.getByTestId('item-laundry-error')).toHaveTextContent(
      'Cannot reach the server. Check your connection.',
    );
  });

  it('shows no error banner when nothing has failed', async () => {
    await renderReady(item());
    expect(screen.queryByTestId('item-laundry-error')).toBeNull();
  });

  /**
   * The mocked hook, given back the one piece of state a flat `mockReturnValue`
   * cannot express: an `error` that appears BECAUSE a write failed. Real React
   * hooks inside the mock, so the screen re-renders with `error !== null`
   * exactly as `useGuardedMutation` would make it; `setStatus` remains the spy
   * that is counted and that receives the screen's arguments untouched.
   */
  const FAILURE = 'Cannot reach the server. Check your connection.';

  function withFailureChannel(): void {
    mockedUseLaundryStatus.mockImplementation(() => {
      const [error, setError] = React.useState<string | null>(null);
      const run = React.useCallback(async (id: string, status: LaundryStatus) => {
        const result = await setStatus(id, status);
        setError(result === null ? FAILURE : null);
        return result;
      }, []);
      return { setStatus: run, pending: false, error };
    });
  }

  it('lets a failed toggle be retried — a second press reaches the hook', async () => {
    /**
     * The behavioural half of "retryable". Releasing `togglingRef` on the
     * success path instead of in `finally` is a one-line change nothing else
     * catches: the first failed toggle leaves the ref `true` for the life of
     * the screen, so a user whose first attempt failed offline can never move
     * that garment into or out of the wash again without leaving and
     * re-entering the screen — while the button sits there enabled.
     *
     * `allows a genuine second toggle once the first has settled` cannot see
     * it: both of its calls succeed, which is exactly the path the mutation
     * preserves. The failure has to come first.
     */
    withFailureChannel();
    const shown = item({ laundryStatus: 'available' });
    setStatus.mockResolvedValueOnce(null);
    setStatus.mockResolvedValueOnce({ ...shown, laundryStatus: 'in_laundry' });

    await renderReady(shown);
    await act(async () => {
      fireEvent.press(screen.getByTestId('item-laundry-toggle'));
    });

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('item-laundry-error')).toHaveTextContent(FAILURE);
    // The failure changed nothing, so the retry must still be asking for the
    // same transition rather than for its opposite.
    expect(screen.getByTestId('item-detail-laundry')).toHaveTextContent('Available');

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-laundry-toggle'));
    });

    // Reached the hook. This is the assertion the guard-leak mutation fails.
    expect(setStatus).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenNthCalledWith(2, 'item-1', 'in_laundry');
    expect(screen.getByTestId('item-detail-laundry')).toHaveTextContent('In laundry');
    expect(screen.queryByTestId('item-laundry-error')).toBeNull();
  });

  it('disables the toggle while a transition is in flight', async () => {
    // The render signal, not the guard — see `useGuardedMutation`. It is what
    // stops a SEQUENTIAL second press a frame later, which the ref guard also
    // catches; the two are belt and braces and neither replaces the other.
    mockedUseLaundryStatus.mockReturnValue({ setStatus, pending: true, error: null });
    await renderReady(item());

    expect(screen.getByTestId('item-laundry-toggle').props.accessibilityState?.disabled).toBe(true);
  });

  it('offers no toggle while the item is still loading', async () => {
    const loading = deferred<PublicClothingItem>();
    mockedFetchItem.mockReturnValueOnce(loading.promise);

    await render(<ItemDetailScreen />);

    // Nothing to toggle, and no id to toggle it with.
    expect(screen.queryByTestId('item-laundry-toggle')).toBeNull();

    await act(async () => {
      loading.resolve(item());
    });
  });
});

/**
 * The Active/Retired toggle.
 *
 * Retiring is distinct from the laundry state directly above it: laundry is
 * temporary and leaves the item selectable in the composer, retiring takes it
 * out of the active wardrobe entirely (`resolveOwnedItems` rejects it
 * server-side, and `OutfitComposer` hides it). The two controls sit on one
 * screen, which is exactly why the labels must not collide.
 */
describe('ItemDetailScreen — the Active/Retired toggle', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: null,
      token: TOKEN,
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
    mockedUseLocalSearchParams.mockReturnValue({ id: 'item-1' });
    canGoBack.mockReturnValue(true);
    mockedUseRouter.mockReturnValue({ back, replace, canGoBack });
    mockedUseLaundryStatus.mockReturnValue({ setStatus, pending: false, error: null });
    mockedUseRetireItem.mockReturnValue({
      setRetired: setRetiredMutation,
      pending: false,
      error: null,
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
    TRACKING_READERS.forEach((reader) => consumeTrackingDirty(reader));
  });

  it('shows the status as Active for an item in the wardrobe', async () => {
    await renderReady(item({ retired: false }));

    expect(screen.getByTestId('item-detail-retired')).toHaveTextContent('Active');
  });

  it('shows the status as Retired for one that is out of it', async () => {
    await renderReady(item({ retired: true }));

    expect(screen.getByTestId('item-detail-retired')).toHaveTextContent('Retired');
  });

  it('never labels the retire toggle the same as the laundry one', async () => {
    // The reason this concept is called Active/Retired rather than
    // available/unavailable: both controls are on screen at once, and the
    // laundry button already says "Mark as available".
    await renderReady(item({ retired: false, laundryStatus: 'in_laundry' }));

    const laundry = screen.getByTestId('item-laundry-toggle').props.accessibilityLabel as string;
    const retire = screen.getByTestId('item-retire-toggle').props.accessibilityLabel as string;
    expect(laundry).toMatch(/mark as available/i);
    expect(retire).not.toBe(laundry);
    expect(retire).not.toMatch(/mark as available/i);
  });

  it('retires an active item', async () => {
    setRetiredMutation.mockResolvedValueOnce(item({ retired: true }));
    await renderReady(item({ retired: false }));

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-retire-toggle'));
    });

    expect(setRetiredMutation).toHaveBeenCalledWith('item-1', true);
  });

  it('sends the OPPOSITE of the current state, so retiring is not a one-way door', async () => {
    setRetiredMutation.mockResolvedValueOnce(item({ retired: false }));
    await renderReady(item({ retired: true }));

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-retire-toggle'));
    });

    expect(setRetiredMutation).toHaveBeenCalledWith('item-1', false);
  });

  it('re-renders from the item the server answered with', async () => {
    setRetiredMutation.mockResolvedValueOnce(item({ retired: true }));
    await renderReady(item({ retired: false }));

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-retire-toggle'));
    });

    await waitFor(() =>
      expect(screen.getByTestId('item-detail-retired')).toHaveTextContent('Retired'),
    );
  });

  it('ignores a second press that lands before the first resolves', async () => {
    // The screen's own ref guard. The hook is mocked precisely so it cannot
    // decline on this screen's behalf.
    const pending = deferred<PublicClothingItem>();
    setRetiredMutation.mockReturnValueOnce(pending.promise);
    await renderReady(item({ retired: false }));

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-retire-toggle'));
      fireEvent.press(screen.getByTestId('item-retire-toggle'));
    });

    expect(setRetiredMutation).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(item({ retired: true }));
    });
  });

  it('leaves the status untouched when the toggle fails', async () => {
    // `null` is the hook's failure signal. Painting the attempted status over
    // the row would report a write that did not happen.
    setRetiredMutation.mockResolvedValueOnce(null);
    mockedUseRetireItem.mockReturnValue({
      setRetired: setRetiredMutation,
      pending: false,
      error: 'Nope',
    });
    await renderReady(item({ retired: false }));

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-retire-toggle'));
    });

    expect(screen.getByTestId('item-detail-retired')).toHaveTextContent('Active');
    expect(screen.getByTestId('item-retire-error')).toHaveTextContent('Nope');
  });

  it('marks the tracking data dirty after a successful toggle', async () => {
    // The wardrobe grid is holding an item whose badge just changed, and the
    // composer's selectable set just gained or lost a garment.
    setRetiredMutation.mockResolvedValueOnce(item({ retired: true }));
    await renderReady(item({ retired: false }));

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-retire-toggle'));
    });

    expect(consumeTrackingDirty('wardrobe')).toBe(true);
  });

  it('marks nothing dirty when the toggle fails', async () => {
    setRetiredMutation.mockResolvedValueOnce(null);
    await renderReady(item({ retired: false }));

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-retire-toggle'));
    });

    expect(consumeTrackingDirty('wardrobe')).toBe(false);
  });
});

/**
 * Deleting an item.
 *
 * The confirmation is INLINE rather than an `Alert.alert`, for the reason
 * `app/outfits/[id].tsx` records: a native modal is invisible to every test in
 * this repo and would stall the device gate behind a dialog nothing can press.
 */
describe('ItemDetailScreen — deleting an item', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: null,
      token: TOKEN,
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
    mockedUseLocalSearchParams.mockReturnValue({ id: 'item-1' });
    canGoBack.mockReturnValue(true);
    mockedUseRouter.mockReturnValue({ back, replace, canGoBack });
    mockedUseLaundryStatus.mockReturnValue({ setStatus, pending: false, error: null });
    mockedUseRetireItem.mockReturnValue({
      setRetired: setRetiredMutation,
      pending: false,
      error: null,
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
    TRACKING_READERS.forEach((reader) => consumeTrackingDirty(reader));
  });

  it('does not delete on the first press — it arms a confirmation', async () => {
    await renderReady(item());

    expect(screen.queryByTestId('item-delete-prompt')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-delete'));
    });

    expect(screen.getByTestId('item-delete-prompt')).toBeTruthy();
    // THE POINT of the two-step: one press must not destroy anything.
    expect(mockedDeleteItem).not.toHaveBeenCalled();
  });

  it('deletes once the confirmation is pressed', async () => {
    mockedDeleteItem.mockResolvedValueOnce(undefined);
    await renderReady(item());

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-delete'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('item-delete-confirm'));
    });

    expect(mockedDeleteItem).toHaveBeenCalledWith('item-1', TOKEN);
  });

  it('goes back after a successful delete', async () => {
    mockedDeleteItem.mockResolvedValueOnce(undefined);
    await renderReady(item());

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-delete'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('item-delete-confirm'));
    });

    expect(back).toHaveBeenCalled();
  });

  it('disarms the prompt on cancel, so a stray tap cannot still fire it', async () => {
    await renderReady(item());

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-delete'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('item-delete-cancel'));
    });

    expect(screen.queryByTestId('item-delete-prompt')).toBeNull();
    expect(screen.getByTestId('item-delete')).toBeTruthy();
    expect(mockedDeleteItem).not.toHaveBeenCalled();
  });

  it('ignores a second confirm that lands before the first resolves', async () => {
    // A double tap here is the worst race on this screen: the second request
    // answers 404 (the route is deliberately not idempotent-silent), so the
    // user would be shown an error for a deletion that in fact succeeded.
    const pending = deferred<void>();
    mockedDeleteItem.mockReturnValueOnce(pending.promise);
    await renderReady(item());

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-delete'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('item-delete-confirm'));
      fireEvent.press(screen.getByTestId('item-delete-confirm'));
    });

    expect(mockedDeleteItem).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve();
    });
  });

  it('treats a 404 as success — the item is gone either way', async () => {
    // Treating it as a failure would strand the user on an item that can never
    // be deleted, because every retry answers 404 too.
    mockedDeleteItem.mockRejectedValueOnce(new ApiClientError('NOT_FOUND', 'Item not found', 404));
    await renderReady(item());

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-delete'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('item-delete-confirm'));
    });

    expect(back).toHaveBeenCalled();
    expect(screen.queryByTestId('item-delete-error')).toBeNull();
  });

  it('keeps the prompt armed and shows the message on any other failure', async () => {
    mockedDeleteItem.mockRejectedValueOnce(new ApiClientError('UNKNOWN', 'Server exploded', 500));
    await renderReady(item());

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-delete'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('item-delete-confirm'));
    });

    expect(back).not.toHaveBeenCalled();
    expect(screen.getByTestId('item-delete-error')).toHaveTextContent('Server exploded');
    // The confirm button IS the retry, so the prompt must still be there.
    expect(screen.getByTestId('item-delete-confirm')).toBeTruthy();
  });

  it('marks the wardrobe dirty after a successful delete', async () => {
    mockedDeleteItem.mockResolvedValueOnce(undefined);
    await renderReady(item());

    await act(async () => {
      fireEvent.press(screen.getByTestId('item-delete'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('item-delete-confirm'));
    });

    expect(consumeTrackingDirty('wardrobe')).toBe(true);
  });
});
