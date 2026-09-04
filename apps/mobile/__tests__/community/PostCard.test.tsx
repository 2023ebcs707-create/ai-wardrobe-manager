import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { PublicClothingItem } from '@wardrobe/shared';
import { ACTION_COLOUR, LIKED_COLOUR, SAVED_COLOUR, PostCard } from '../../src/community/PostCard';
import type { PostCardProps } from '../../src/community/PostCard';
import { AVATAR_INK, avatarColor, initials } from '../../src/community/avatar';
import { POST_CARD_METRICS } from '../../src/community/masonry';
import type { DisplayPost } from '../../src/community/posts';

type Element = ReturnType<typeof screen.getByTestId>;

function flat(el: Element): Record<string, unknown> {
  return (StyleSheet.flatten(el.props.style) ?? {}) as Record<string, unknown>;
}

/**
 * The character an `@expo/vector-icons` icon of this name renders.
 *
 * The `name` prop does NOT survive to the host element — `createIconSet` looks
 * the name up in the font's glyph map and renders the code point as the
 * `<Text>`'s only child, so `props.name` is `undefined` on the rendered node.
 * (The same discovery `LaundryBadge.test.tsx` records about `color`, which is
 * folded into the style rather than kept as a prop.) Reading the glyph map is
 * what makes "a filled heart, not a hollow one" observable at all: the two
 * names are 62314 and 62327, so the rendered text differs.
 */
function glyphFor(name: keyof typeof Ionicons.glyphMap): string {
  // The map is declared as `string | number` because a few icon sets key their
  // glyphs by ligature name; Ionicons' are all code points.
  return String.fromCodePoint(Ionicons.glyphMap[name] as number);
}

function item(id: string, overrides: Partial<PublicClothingItem> = {}): PublicClothingItem {
  return {
    id,
    userId: 'author-1',
    imageUrl: `https://example.test/full/${id}.jpg`,
    thumbnailUrl: `https://example.test/thumb/${id}.jpg`,
    category: 'shirt',
    colors: [{ hex: '#001f3f', name: 'navy', share: 1 }],
    seasons: ['summer'],
    laundryStatus: 'available',
    wearCount: 0,
    source: 'manual',
    createdAt: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

function post(overrides: Partial<DisplayPost> = {}): DisplayPost {
  return {
    id: 'p1',
    author: { id: 'author-1', name: 'Ada Lovelace' },
    items: [item('i1'), item('i2'), item('i3')],
    caption: 'Rainy Tuesday layers',
    likeCount: 4,
    liked: false,
    saved: false,
    createdAt: '2026-08-24T09:00:00.000Z',
    missingItemsNotice: null,
    ...overrides,
  };
}

const toggleLike = jest.fn<Promise<boolean>, [string]>();
const toggleSave = jest.fn<Promise<boolean>, [string]>();
const onRemove = jest.fn<Promise<boolean>, [string]>();

/**
 * The card's props, defaulted to **a viewer who is not the author and a host
 * with no delete path** — so every test that is not about retraction gets a
 * card with no retract control on it, and the tests that are about it say so
 * by passing `viewerId` and `onRemove` explicitly.
 */
function cardProps(overrides: Partial<PostCardProps> = {}): PostCardProps {
  return {
    post: post(),
    onToggleLike: toggleLike,
    onToggleSave: toggleSave,
    viewerId: null,
    ...overrides,
  };
}

async function mount(overrides: Partial<DisplayPost> = {}) {
  return render(<PostCard {...cardProps({ post: post(overrides) })} />);
}

/** Mount with the retract control live: the viewer IS the author, and the host
 *  can delete. */
async function mountOwn(overrides: Partial<PostCardProps> = {}) {
  return render(<PostCard {...cardProps({ viewerId: 'author-1', onRemove, ...overrides })} />);
}

type FiberLike = { memoizedProps: Record<string, unknown>; return: FiberLike | null };

/**
 * The `onPress` handler the element was rendered with, as a callable.
 *
 * `fireEvent.press` cannot model a same-frame double tap: it wraps each press
 * in its own `act()`, so React re-renders between them and the second press
 * sees an already-disabled button. Two touch events dispatched in one frame do
 * not — they both call the handler instance that was on screen when the first
 * landed, which is exactly what this reproduces. (Two nested `fireEvent.press`
 * calls inside one outer `act` make React 19 log "You seem to have overlapping
 * act() calls", so that route is not available either.)
 *
 * The same helper as `__tests__/suggestions/SuggestionCard.test.tsx` and
 * `__tests__/add.test.tsx`; duplicated rather than shared because a `.ts`
 * helper module under `__tests__/` is picked up by Jest's default testMatch and
 * fails as a suite with no tests.
 */
function onPressOf(host: Element): () => void {
  let fiber = host.unstable_fiber as unknown as FiberLike | null;
  while (fiber !== null) {
    const handler = fiber.memoizedProps?.onPress;
    if (typeof handler === 'function') return handler as () => void;
    fiber = fiber.return;
  }
  throw new Error('No onPress handler found above the element');
}

/** A promise this test resolves by hand, so the request can be held in flight
 *  while the intermediate state is asserted. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('PostCard (TC-11 — "post appears in feed with correct image, caption, and user info")', () => {
  beforeEach(() => {
    toggleLike.mockResolvedValue(true);
    toggleSave.mockResolvedValue(true);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('user info', () => {
    it("shows the author's name", async () => {
      await mount();
      expect(screen.getByTestId('post-author-p1')).toHaveTextContent('Ada Lovelace');
    });

    it('shows a name that happens to read as a tombstone unchanged', async () => {
      // A post outlives its author, so `'Deleted user'` arrives for an account
      // that is gone — and is also a legal display name. This card cannot tell
      // the two apart and must not try, so it renders what it was sent.
      await mount({ author: { id: 'author-9', name: 'Deleted user' } });
      expect(screen.getByTestId('post-author-p1')).toHaveTextContent('Deleted user');
    });

    it('draws an initials avatar when the author has no picture', async () => {
      // Which is EVERY author in the product as it stands: `avatarUrl` is on
      // the schema and nothing ever writes one. A card rendering "the picture
      // or a blank circle" renders a blank circle on every post in the feed.
      await mount();
      expect(screen.getByTestId('post-avatar-initials-p1')).toHaveTextContent(
        initials('Ada Lovelace'),
      );
      expect(screen.getByTestId('post-avatar-initials-p1')).toHaveTextContent('AL');
    });

    it('colours the disc from the author id, not from the name', async () => {
      // Author names are resolved on every read rather than snapshotted
      // (ruling 5), so a name-keyed colour would visibly change under a post
      // that did not.
      const view = await mount({ author: { id: 'author-1', name: 'Ada Lovelace' } });
      const first = flat(screen.getByTestId('post-avatar-p1')).backgroundColor;
      expect(first).toBe(avatarColor('author-1'));

      await act(async () => {
        view.rerender(
          <PostCard
            {...cardProps({ post: post({ author: { id: 'author-1', name: 'Ada Byron King' } }) })}
          />,
        );
      });
      expect(flat(screen.getByTestId('post-avatar-p1')).backgroundColor).toBe(first);

      await act(async () => {
        view.rerender(
          <PostCard
            {...cardProps({ post: post({ author: { id: 'author-2', name: 'Ada Lovelace' } }) })}
          />,
        );
      });
      expect(flat(screen.getByTestId('post-avatar-p1')).backgroundColor).toBe(
        avatarColor('author-2'),
      );
      expect(flat(screen.getByTestId('post-avatar-p1')).backgroundColor).not.toBe(first);
    });

    it('writes the initials in the ink the palette was contrast-checked against', async () => {
      // `avatar.test.ts` scores every palette entry against `AVATAR_INK` as a
      // luminance ratio. That check says nothing at all unless the card
      // actually writes in that ink, which is what this line pins.
      await mount();
      expect(flat(screen.getByTestId('post-avatar-initials-p1')).color).toBe(AVATAR_INK);
    });

    it('draws the picture instead when the author has one', async () => {
      // Unreachable today — nothing writes `avatarUrl` — and built anyway,
      // because the field is real and the wire carries it.
      await mount({
        author: { id: 'author-1', name: 'Ada Lovelace', avatarUrl: 'https://example.test/a.jpg' },
      });
      expect(screen.getByTestId('post-avatar-image-p1').props.source).toEqual({
        uri: 'https://example.test/a.jpg',
      });
      expect(screen.queryByTestId('post-avatar-initials-p1')).toBeNull();
    });
  });

  describe('images', () => {
    it("renders every garment, in the author's snapshot order", async () => {
      // The order IS the outfit: "top, trousers, shoes" reads correctly and
      // the same three garments in another order do not. `getAllByTestId`
      // answers in tree order, so reading the URIs off in sequence is what
      // catches a reversal.
      await mount();
      const uris = screen
        .getAllByTestId('post-item-p1')
        .map((el) => (el.props.source as { uri: string }).uri);
      expect(uris).toEqual([
        'https://example.test/thumb/i1.jpg',
        'https://example.test/thumb/i2.jpg',
        'https://example.test/thumb/i3.jpg',
      ]);
    });

    it('falls back to the full image for a garment with no thumbnail', async () => {
      // Pre-Stage-4 uploads have no `thumbnailKey`; the full image is what
      // keeps them visible rather than rendering an empty grey square.
      await mount({ items: [item('i1', { thumbnailUrl: undefined })] });
      expect(screen.getByTestId('post-item-p1').props.source).toEqual({
        uri: 'https://example.test/full/i1.jpg',
      });
    });

    it('describes each garment for a screen reader', async () => {
      // A grid of photographs is silent. Category and colours are what make
      // one thumbnail distinguishable from the next.
      await mount({ items: [item('i1', { category: 'jacket' })] });
      expect(screen.getByTestId('post-item-p1').props.accessibilityLabel).toBe('jacket, navy');
    });

    it('renders a post whose garments have all been deleted', async () => {
      // NOT an error (ruling 4). The post still exists, and it still has a
      // caption and an author. A card that treated `[]` as a failure would put
      // a hole in the feed every time somebody tidied their wardrobe.
      await mount({ items: [], missingItemsNotice: '3 items are no longer available' });
      expect(screen.queryByTestId('post-items-p1')).toBeNull();
      expect(screen.getByTestId('post-caption-p1')).toHaveTextContent('Rainy Tuesday layers');
      expect(screen.getByTestId('post-author-p1')).toHaveTextContent('Ada Lovelace');
    });
  });

  describe('caption', () => {
    it('shows the caption', async () => {
      await mount();
      expect(screen.getByTestId('post-caption-p1')).toHaveTextContent('Rainy Tuesday layers');
    });

    it('clamps it to the number of lines the height arithmetic assumes', async () => {
      // Not a style preference. `postCardHeight` reserves at most
      // `maxCaptionLines`, so an unclamped caption makes one card taller than
      // the masonry believes and leaves the column under it permanently short.
      await mount({ caption: 'x'.repeat(400) });
      expect(screen.getByTestId('post-caption-p1').props.numberOfLines).toBe(
        POST_CARD_METRICS.maxCaptionLines,
      );
    });

    it('renders the missing-items notice verbatim', async () => {
      // The data layer words this sentence, over DISTINCT ids, and states a
      // fact about the post while asserting no cause. Rewording it here — or
      // deriving a number back out of it — is what this pins against.
      await mount({ missingItemsNotice: '2 items are no longer available' });
      expect(screen.getByTestId('post-missing-p1')).toHaveTextContent(
        '2 items are no longer available',
      );
    });

    it('renders no notice when nothing is missing', async () => {
      await mount({ missingItemsNotice: null });
      expect(screen.queryByTestId('post-missing-p1')).toBeNull();
    });
  });

  describe('like control (TC-12)', () => {
    it('shows the count', async () => {
      await mount({ likeCount: 4 });
      expect(screen.getByTestId('post-like-count-p1')).toHaveTextContent('4');
    });

    it('shows a hollow heart and says "Like" when the viewer has not liked it', async () => {
      await mount({ liked: false, likeCount: 4 });
      expect(screen.getByTestId('post-like-icon-p1')).toHaveTextContent(glyphFor('heart-outline'));
      expect(flat(screen.getByTestId('post-like-icon-p1')).color).toBe(ACTION_COLOUR);
      expect(screen.getByTestId('post-like-p1').props.accessibilityState).toEqual({
        selected: false,
      });
      expect(screen.getByTestId('post-like-p1').props.accessibilityLabel).toBe(
        'Like this post, 4 likes',
      );
    });

    it('shows a filled heart and says "Unlike" when the viewer has', async () => {
      // A SHAPE change, not only a colour: the same reason the laundry
      // treatment carries a written label rather than a tint. The label is the
      // half a screen reader gets, and it carries the count because
      // `accessibilityState.selected` says whether YOU liked it and never how
      // many people have.
      await mount({ liked: true, likeCount: 5 });
      expect(screen.getByTestId('post-like-icon-p1')).toHaveTextContent(glyphFor('heart'));
      expect(screen.getByTestId('post-like-icon-p1')).not.toHaveTextContent(
        glyphFor('heart-outline'),
      );
      expect(flat(screen.getByTestId('post-like-icon-p1')).color).toBe(LIKED_COLOUR);
      // The colour is the SECOND channel, so it has to actually differ. Pinned
      // against the shipped constants rather than two literals: a palette that
      // collapsed both states onto one value would otherwise pass here and
      // leave the shape carrying the state alone.
      expect(LIKED_COLOUR).not.toBe(ACTION_COLOUR);
      expect(screen.getByTestId('post-like-p1').props.accessibilityState).toEqual({
        selected: true,
      });
      expect(screen.getByTestId('post-like-p1').props.accessibilityLabel).toBe(
        'Unlike this post, 5 likes',
      );
    });

    it('says "1 like" rather than "1 likes"', async () => {
      await mount({ liked: false, likeCount: 1 });
      expect(screen.getByTestId('post-like-p1').props.accessibilityLabel).toBe(
        'Like this post, 1 like',
      );
    });

    it('reports the tap by post id and nothing else', async () => {
      // The card does not own the count: the optimistic write, the rollback
      // and the cross-list broadcast all live in `usePostList`, which looks
      // the post up in the list it is holding NOW. Handing over the post
      // object instead would let a card captured one render ago decide what a
      // rollback restores.
      await mount();
      fireEvent.press(screen.getByTestId('post-like-p1'));
      expect(toggleLike).toHaveBeenCalledTimes(1);
      expect(toggleLike).toHaveBeenCalledWith('p1');
      expect(toggleSave).not.toHaveBeenCalled();
    });

    it('keeps the glyph out of OS font scaling', async () => {
      // The actions row has a fixed height that `postCardHeight` sums, and
      // `@expo/vector-icons` sets `allowFontScaling` in `defaultProps` — which
      // React 19 has already removed for function components. Pinned rather
      // than inherited.
      await mount();
      expect(screen.getByTestId('post-like-icon-p1').props.allowFontScaling).toBe(false);
    });

    it('renders a glyph rather than a question mark', async () => {
      // `createIconSet` renders a literal '?' for a name that is not in the
      // font's glyph map, so this rules out a typo'd icon name shipping as a
      // question mark. It does NOT prove the glyph draws — that is a pixel
      // property RNTL cannot reach, and Task 8's device gate is what settles
      // it.
      await mount({ liked: true });
      expect(screen.getByTestId('post-like-icon-p1')).not.toHaveTextContent('?');
      expect(screen.getByTestId('post-save-icon-p1')).not.toHaveTextContent('?');
    });
  });

  describe('save control', () => {
    it('shows a hollow bookmark and says "Save" when the viewer has not saved it', async () => {
      await mount({ saved: false });
      expect(screen.getByTestId('post-save-icon-p1')).toHaveTextContent(
        glyphFor('bookmark-outline'),
      );
      expect(flat(screen.getByTestId('post-save-icon-p1')).color).toBe(ACTION_COLOUR);
      expect(screen.getByTestId('post-save-p1').props.accessibilityState).toEqual({
        selected: false,
      });
      expect(screen.getByTestId('post-save-p1').props.accessibilityLabel).toBe('Save this post');
    });

    it('shows a filled bookmark and offers to remove it when the viewer has', async () => {
      await mount({ saved: true });
      expect(screen.getByTestId('post-save-icon-p1')).toHaveTextContent(glyphFor('bookmark'));
      expect(screen.getByTestId('post-save-icon-p1')).not.toHaveTextContent(
        glyphFor('bookmark-outline'),
      );
      expect(flat(screen.getByTestId('post-save-icon-p1')).color).toBe(SAVED_COLOUR);
      expect(SAVED_COLOUR).not.toBe(ACTION_COLOUR);
      expect(screen.getByTestId('post-save-p1').props.accessibilityState).toEqual({
        selected: true,
      });
      expect(screen.getByTestId('post-save-p1').props.accessibilityLabel).toBe(
        'Remove this post from your saved posts',
      );
    });

    it('reports the tap by post id and nothing else', async () => {
      await mount();
      fireEvent.press(screen.getByTestId('post-save-p1'));
      expect(toggleSave).toHaveBeenCalledTimes(1);
      expect(toggleSave).toHaveBeenCalledWith('p1');
      expect(toggleLike).not.toHaveBeenCalled();
    });
  });
  /**
   * Ruling 7's control. The endpoint was added deliberately as the one thing in
   * this stage beyond what any document claims, BECAUSE publishing to a public
   * feed with no way to take it down is a user-harm gap — so an endpoint with
   * no control is that same gap with extra steps.
   */
  describe('retracting your own post (ruling 7)', () => {
    beforeEach(() => {
      onRemove.mockResolvedValue(true);
    });

    it('offers a retract control on a post the viewer wrote', async () => {
      await mountOwn();
      expect(screen.getByTestId('post-retract-p1')).toBeTruthy();
      expect(screen.getByTestId('post-retract-p1').props.accessibilityLabel).toBe(
        'Retract this post from the community feed',
      );
    });

    it("shows no retract control at all on another user's post", async () => {
      // Not a DISABLED one: a disabled control advertises an action, and this
      // one would be answered with a 404 — the route carries the ownership in
      // its delete filter, so a foreign post and a post that never existed are
      // indistinguishable by design.
      await mountOwn({ viewerId: 'someone-else' });
      expect(screen.queryByTestId('post-retract-p1')).toBeNull();
      expect(screen.queryByTestId('post-retract-prompt-p1')).toBeNull();
    });

    it('shows no retract control when nobody is signed in', async () => {
      await mountOwn({ viewerId: null });
      expect(screen.queryByTestId('post-retract-p1')).toBeNull();
    });

    it('keeps the control on the viewer’s own post when every garment is gone', async () => {
      // The case that separates "is this post mine?" from every inference
      // available on the card's own data. `post.items[i].userId` is the author's
      // id — the garments belong to whoever composed the outfit — so for any
      // post that still HAS a garment it equals `post.author.id` and the two
      // rules are indistinguishable. A post whose garments have all been
      // deleted is a real, renderable case (ruling 4), and it is where the
      // inference silently answers "not yours" about your own post.
      await mountOwn({ post: post({ items: [] }) });
      expect(screen.getByTestId('post-retract-p1')).toBeTruthy();
    });

    it('shows no retract control on a stranger’s post when every garment is gone', async () => {
      // THE MIRROR OF THE TEST ABOVE, and the half with teeth. The one above
      // only pins the OWNER direction: `post.author.id === viewerId ||
      // post.items.length === 0` satisfies it, and satisfies every other test
      // in this file, because no other fixture pairs an empty `items` with a
      // foreign author. Only this one separates them.
      //
      // The shape is not hypothetical: ruling 4 makes a post whose garments
      // have all been deleted real and renderable, and a stranger's is exactly
      // as renderable as your own.
      //
      // What the false rule would cost is not a cosmetic stray button. Pressing
      // it sends `DELETE /community/posts/:id`; the route carries ownership in
      // its delete filter, so a foreign post answers 404, and
      // `useCommunityFeed`'s `isAlreadyGone` reads a 404 as "gone" — `remove`
      // resolves `true` and the row leaves the feed. The viewer is shown a
      // destructive control over someone else's public content and then told it
      // worked.
      await mountOwn({ viewerId: 'someone-else', post: post({ items: [] }) });
      expect(screen.queryByTestId('post-retract-p1')).toBeNull();
      expect(screen.queryByTestId('post-retract-prompt-p1')).toBeNull();
    });

    it('shows no retract control for a host with no delete path', async () => {
      // The saved list is one: `useSavedPosts` exposes no `remove`, so its
      // cards carry no retract control even on the viewer's own post.
      await mountOwn({ onRemove: undefined });
      expect(screen.queryByTestId('post-retract-p1')).toBeNull();
    });

    it('asks first, and touches nothing until the question is answered', async () => {
      // Destructive, irreversible, and about content other people can already
      // see. The prompt is INLINE rather than `Alert.alert` — a blocking native
      // dialog is one no test can see or dismiss and one no screen reader can
      // walk, and it would stall the device gate behind a control nothing can
      // press.
      await mountOwn();
      await fireEvent.press(screen.getByTestId('post-retract-p1'));

      expect(screen.getByTestId('post-retract-prompt-p1')).toBeTruthy();
      expect(screen.getByTestId('post-retract-prompt-text-p1')).toHaveTextContent(
        'Retract this post? It disappears from the community feed for everyone. Your outfit and your clothing items are not affected.',
      );
      expect(onRemove).not.toHaveBeenCalled();
    });

    it('disarms the prompt on cancel rather than merely hiding it', async () => {
      // A prompt left on screen after a cancel is one an accidental tap can
      // still fire.
      await mountOwn();
      await fireEvent.press(screen.getByTestId('post-retract-p1'));
      await fireEvent.press(screen.getByTestId('post-retract-cancel-p1'));

      expect(screen.queryByTestId('post-retract-prompt-p1')).toBeNull();
      expect(screen.getByTestId('post-retract-p1')).toBeTruthy();
      expect(onRemove).not.toHaveBeenCalled();
    });

    it('deletes by post id, and by nothing else', async () => {
      await mountOwn();
      await fireEvent.press(screen.getByTestId('post-retract-p1'));
      await fireEvent.press(screen.getByTestId('post-retract-confirm-p1'));

      expect(onRemove).toHaveBeenCalledTimes(1);
      expect(onRemove).toHaveBeenCalledWith('p1');
      // The card does not take its own row off the screen: the host owns the
      // list, and a card that removed itself would be a removal with no
      // rollback when the delete failed.
      expect(screen.getByTestId('post-card-p1')).toBeTruthy();
      // And it is left usable rather than spinning. The feed's own host does
      // unmount this card on success, but `PostCard` is an exported component
      // whose host owns the list — the saved list mounts it against a different
      // hook — so a guard released only on the failure path would hand such a
      // host a permanently dead control with a spinner in it. The same kind of
      // component-contract statement as `MasonryFeed`'s `posts.length === 0`
      // conjunct, rather than a state today's feed reaches.
      expect(screen.getByTestId('post-retract-confirm-p1').props.accessibilityState).toEqual({
        disabled: false,
      });
    });

    it('issues ONE request for a same-frame double tap', async () => {
      // Two touches dispatched before React can re-render both invoke the
      // closure that was on screen when the first landed, so the button's
      // `disabled` prop and the `retracting` state are both still false for the
      // second. Only the ref sees it.
      //
      // The request is HELD IN FLIGHT across the whole burst — a guard test
      // whose first request has already settled cannot see the guard at all.
      const gate = deferred<boolean>();
      onRemove.mockReturnValueOnce(gate.promise);
      await mountOwn();
      await fireEvent.press(screen.getByTestId('post-retract-p1'));

      const press = onPressOf(screen.getByTestId('post-retract-confirm-p1'));
      await act(async () => {
        press();
        press();
      });

      expect(onRemove).toHaveBeenCalledTimes(1);

      await act(async () => {
        gate.resolve(true);
      });
    });

    it('shows the retract in flight while it is running', async () => {
      // The intermediate state, asserted while it is committed rather than
      // inferred from the outcome: both prompt buttons refuse a press for as
      // long as the request is out.
      const gate = deferred<boolean>();
      onRemove.mockReturnValueOnce(gate.promise);
      await mountOwn();
      await fireEvent.press(screen.getByTestId('post-retract-p1'));
      // `onPressOf` rather than `await fireEvent.press`: RNTL 14's `fireEvent`
      // is async and does not settle until the handler's own promise does, so
      // awaiting a press whose request is deliberately left in flight hangs the
      // test until Jest's timeout. Calling the handler inside one `act` commits
      // the in-flight render and leaves the request out, which is the whole
      // point of the assertion below.
      const press = onPressOf(screen.getByTestId('post-retract-confirm-p1'));
      await act(async () => {
        press();
      });

      expect(screen.getByTestId('post-retract-confirm-p1').props.accessibilityState).toEqual({
        disabled: true,
      });
      expect(screen.getByTestId('post-retract-cancel-p1').props.accessibilityState).toEqual({
        disabled: true,
      });

      await act(async () => {
        gate.resolve(false);
      });

      expect(screen.getByTestId('post-retract-confirm-p1').props.accessibilityState).toEqual({
        disabled: false,
      });
    });

    it('keeps the prompt armed when the delete fails, so the button is the retry', async () => {
      // `remove` resolves `false` for a failure and carries the message on the
      // host's own error channel — the feed's banner. A prompt that disarmed
      // itself here would take the retry off the screen along with the
      // question.
      onRemove.mockResolvedValueOnce(false);
      await mountOwn();
      await fireEvent.press(screen.getByTestId('post-retract-p1'));
      await fireEvent.press(screen.getByTestId('post-retract-confirm-p1'));

      expect(screen.getByTestId('post-retract-prompt-p1')).toBeTruthy();
      expect(screen.getByTestId('post-retract-confirm-p1')).toBeTruthy();
    });

    it('lets a second press through after a failure — the guard is released either way', async () => {
      // Stage 6's review found a guard released only on the success path: the
      // control could never be used again, and the test named "retryable"
      // passed because it only ever pressed once. A guard that is never
      // released is worse than no guard.
      onRemove.mockResolvedValueOnce(false);
      await mountOwn();
      await fireEvent.press(screen.getByTestId('post-retract-p1'));
      await fireEvent.press(screen.getByTestId('post-retract-confirm-p1'));
      expect(onRemove).toHaveBeenCalledTimes(1);

      await fireEvent.press(screen.getByTestId('post-retract-confirm-p1'));

      expect(onRemove).toHaveBeenCalledTimes(2);
      expect(onRemove).toHaveBeenNthCalledWith(2, 'p1');
    });

    it('guards each card separately, so one retract does not swallow another', async () => {
      // The guard is per INSTANCE. Two posts are two different writes, and a
      // module-level flag would silently drop the second — a Retract button
      // that does nothing at all.
      const gate = deferred<boolean>();
      onRemove.mockReturnValueOnce(gate.promise);
      await render(
        <>
          <PostCard {...cardProps({ post: post({ id: 'p1' }), viewerId: 'author-1', onRemove })} />
          <PostCard {...cardProps({ post: post({ id: 'p2' }), viewerId: 'author-1', onRemove })} />
        </>,
      );
      await fireEvent.press(screen.getByTestId('post-retract-p1'));
      await fireEvent.press(screen.getByTestId('post-retract-p2'));

      const pressFirst = onPressOf(screen.getByTestId('post-retract-confirm-p1'));
      const pressSecond = onPressOf(screen.getByTestId('post-retract-confirm-p2'));
      await act(async () => {
        pressFirst();
        pressSecond();
      });

      expect(onRemove).toHaveBeenCalledTimes(2);
      expect(onRemove).toHaveBeenNthCalledWith(1, 'p1');
      expect(onRemove).toHaveBeenNthCalledWith(2, 'p2');

      await act(async () => {
        gate.resolve(true);
      });
    });
  });
});
