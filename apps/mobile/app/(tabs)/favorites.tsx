import React, { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import type { PublicOutfit } from '@wardrobe/shared';
import { useAuth } from '../../src/auth/AuthContext';
import { MasonryFeed } from '../../src/community/MasonryFeed';
import { consumeCommunityDirty } from '../../src/community/communityDirty';
import { useSavedPosts } from '../../src/community/useSavedPosts';
import { OutfitCard } from '../../src/outfits/OutfitCard';
import { consumeOutfitsDirty } from '../../src/outfits/outfitsDirty';
import { useOutfits } from '../../src/outfits/useOutfits';
import { color, space } from '../../src/theme/tokens';
import { text } from '../../src/theme/type';
import { Chip, ErrorPlate, ScreenHeader, screen as screenStyles } from '../../src/theme/ui';

/**
 * The gallery's React key. **Never the array index.**
 *
 * Be precise about when that matters, because a paging test cannot tell the
 * two apart at all. `FlatList` keys each cell *within* a row by its column
 * index — `<React.Fragment key={kk}>` in FlatList.js — so this extractor only
 * ever sets the **row** key, and a pure page append leaves every existing
 * row's item-to-position mapping untouched. Stage 4 verified that directly:
 * with `keyExtractor={(_item, index) => String(index)}` in place, all 28 of
 * its screen tests passed.
 *
 * The defect bites on **replacement**, and this screen invites replacement
 * more than any other in the app because it refetches on every focus (see
 * `useFocusEffect` below). A refresh keeps the rows mounted — `activity` goes
 * to `'refreshing'`, not `'loading'` — and then swaps `outfits` wholesale, so
 * with index keys React reuses each cell, and the cover image already mounted
 * in it, for a different outfit. Deleting an outfit does the same thing
 * without a replacement at all: every row after it shifts up one position.
 *
 * Exported so the contract is directly assertable; see also the mount probe in
 * `__tests__/outfits/favorites.keys.test.tsx`, which catches the same defect
 * through public queries only.
 */
export const outfitKeyExtractor = (outfit: PublicOutfit): string => outfit.id;

/**
 * The two things this tab keeps: the outfits you built (FR5 / TC-07) and the
 * community posts you bookmarked (FR10's "save", and the half of TC-12 that
 * reads "post added to user's saved list").
 *
 * They are ALTERNATIVES, not two sections of one scrolling screen — the rule
 * `app/(tabs)/add.tsx` states for its three modes. Both of these are
 * full-height scrolling lists, so the only way to show them together is to
 * stack them inside a scroll container of their own, and that is where the
 * gallery's `FlatList` draws React Native's "VirtualizedLists should never be
 * nested inside plain ScrollViews with the same orientation" — a failure by
 * this project's pristine-output rule before it is a scrolling bug on a device.
 * Rendered as alternatives, neither list is ever inside the other and no third
 * container exists.
 *
 * THE COST, STATED IN BOTH DIRECTIONS. Keeping the saved hook inside the pane
 * avoids a `GET /community/saved` on every visit to this tab — the saving this
 * design is justified by, and it is measured (`does not fetch the saved list
 * until the mode is chosen`). The other half is not free and is not measured:
 * because the pane owns the hook, EVERY return to "Saved posts" remounts it,
 * so a fresh page-one request goes out and any pages the user had scrolled are
 * thrown away. The gallery, whose hook sits at screen level, keeps its pages
 * across the identical switch. Page three of your saved posts, a tap to
 * "Outfits" and back, and you are at the top again with a round trip in
 * between. That is the right trade for a tab opened mostly for outfits, and it
 * is an asymmetry a device gate should look at rather than a property anything
 * here pins.
 *
 * It also keeps the hook behind the mode you are not looking
 * at unmounted, which is the cost `SavedPostsPane` below is about.
 */
type FavoritesMode = 'outfits' | 'saved';

/**
 * What each mode chip says, what a screen reader hears instead, and the header
 * the screen wears while that mode is showing.
 *
 * The title changes with the mode for the same reason the Add tab's does: two
 * lists share this tab, and one fixed heading would name the tab rather than
 * what is on screen. The chip row still says which is selected — the header
 * says what it IS, which is a different sentence.
 */
const MODE_LABELS: Record<
  FavoritesMode,
  { chip: string; accessibility: string; title: string; blurb: string }
> = {
  outfits: {
    chip: 'Outfits',
    accessibility: 'Outfits you have saved',
    title: 'Your outfits',
    blurb: 'Everything you have put together',
  },
  saved: {
    chip: 'Saved posts',
    accessibility: 'Posts you have saved from the community',
    title: 'Saved posts',
    blurb: 'Kept from the community feed',
  },
};

const FAVORITES_MODES = ['outfits', 'saved'] as const;

interface SavedPostsPaneProps {
  /**
   * Reported `true` when a like or an unsave starts and `false` when it
   * settles — the bit the mode chips are disabled on.
   *
   * It has to be reported UP rather than kept here, because what it guards is
   * this component's own unmount: switching modes while a write is in flight
   * takes `useSavedPosts` off the tree, and the failure message that write is
   * about to produce then has nowhere to render. See the chip row's `disabled`
   * for the whole argument.
   *
   * Must be stable across renders — the wrapped handlers depend on it.
   */
  onWritingChange: (writing: boolean) => void;
}

/**
 * The saved-post list — FR10's "save", and TC-12's user-facing half.
 *
 * ## Why this is a component rather than a block inside `FavoritesScreen`
 *
 * `useSavedPosts` fetches on mount. Called at the top of the screen it would
 * issue `GET /community/saved` every time anybody opened the Favorites tab to
 * look at their outfits, which is what that tab is mostly for. Declared here,
 * the request happens when the mode is chosen and not before — the same
 * reasoning `SuggestionsPane` records on the Add tab.
 *
 * ## What this screen deliberately does not take from the hook
 *
 * `hasMore` — `loadMore` already consults the cursor internally and is a no-op
 * past the last page, so an "end of list" marker driven by it would sit
 * permanently under a list that fits on one screen.
 *
 * ## There is no retract control here, and that is a decision rather than an
 * omission
 *
 * `useSavedPosts` exposes no `remove`, so this list has no delete path — and
 * `onRemove` is therefore not passed to `MasonryFeed` at all, which is what
 * makes `PostCard.canRetract` false on **every** card here, the viewer's own
 * included. A saved list that drew the control anyway would draw one that
 * cannot work, and ruling 7 admitted `DELETE /community/posts/:id` precisely
 * because a control that silently fails is worse than no control. The feed on
 * the Search tab still retracts, a delete made there marks this list dirty,
 * and the focus gate below is how the row leaves.
 */
function SavedPostsPane({ onWritingChange }: SavedPostsPaneProps) {
  const { user } = useAuth();
  const { posts, activity, error, loadMore, refresh, toggleLike, toggleSave } = useSavedPosts();

  /**
   * Refetch when this tab comes back into view **and something actually
   * changed** — never merely because it came back.
   *
   * The gate is the whole design, exactly as it is for the gallery below.
   * `refresh()` is a page-ONE load that replaces the list, so an ungated focus
   * effect throws away every page the user has scrolled to.
   *
   * `consumeCommunityDirty('saved')` both reads and clears. **The argument
   * matters**: `'saved'` is this list's own reader, and consuming `'feed'` here
   * would reload for changes that are not this list's while swallowing the flag
   * the Search tab is waiting on.
   *
   * A mount that happens while the tab is already focused — which is what
   * choosing this mode is — runs this immediately, and that costs nothing even
   * when the flag IS set: `useSavedPosts`'s own mount effect is registered
   * earlier in this component, so it runs first and sets its in-flight marker
   * synchronously, and `refresh` is a no-op while a full-list load is running.
   * The flag is therefore consumed by a request that was already fetching page
   * one. That is a claim about effect ordering across two modules, so it is
   * pinned against the real hook in
   * `__tests__/community/favorites.saved.real.test.tsx`.
   *
   * `useCallback` is not optional — `useFocusEffect` lists `effect` in its own
   * dependency array, so an inline arrow would re-run this on every render, and
   * this effect fetches, and a fetch renders.
   */
  useFocusEffect(
    useCallback(() => {
      if (consumeCommunityDirty('saved')) refresh();
    }, [refresh]),
  );

  /**
   * Report a write while it is in flight.
   *
   * The promise is taken already-started rather than as a thunk, so the call
   * into `usePostList` happens in the press handler's own frame — its guard is
   * keyed on a map written before the first suspension point, and a wrapper
   * that deferred the call would change which taps that guard can see.
   *
   * **The `finally` is defence in depth and NOTHING MEASURES IT.** `toggleLike`
   * and `toggleSave` are contracted to RESOLVE rather than reject — `false` is
   * how they report a failure — so the failure path is a resolve and runs
   * through the `return` above; releasing the flag there instead would fail no
   * test in this suite, and a mutation saying so is recorded rather than
   * hidden. It is kept because the alternative to a `finally` is a mode row
   * that stays dead for the rest of the session if that contract is ever
   * broken.
   *
   * An earlier version of this comment said a rejection "cannot be tested from
   * here without an unhandled one", because `PostCard` invokes these as
   * `void onToggleSave(id)`. **That was wrong, and it is the shape this stage
   * keeps finding — a comment claiming more than was checked, inverted into
   * claiming less.** It is true of the PRESS path only: reading the handler off
   * the card's props calls it with the rejection HANDLED, producing no
   * unhandled rejection. Measured — removing this `finally` fails
   * `releases the mode row when a write REJECTS, not only when it fails`,
   * typecheck clean, 1 of 36. The ordinary resolve-false path is covered
   * separately by `lets the mode change again once a write that failed has
   * settled`.
   */
  const track = useCallback(
    async (write: Promise<boolean>): Promise<boolean> => {
      onWritingChange(true);
      try {
        return await write;
      } finally {
        onWritingChange(false);
      }
    },
    [onWritingChange],
  );

  const handleToggleLike = useCallback(
    (postId: string): Promise<boolean> => track(toggleLike(postId)),
    [track, toggleLike],
  );

  const handleToggleSave = useCallback(
    (postId: string): Promise<boolean> => track(toggleSave(postId)),
    [track, toggleSave],
  );

  /**
   * **Unsaving takes the row off THIS list, and the filter is how.**
   *
   * `useSavedPosts` deliberately keeps the row in `posts` until the next load,
   * and that is not in tension with this line — it is what makes it safe. The
   * optimistic write publishes `saved: false` and a failure publishes
   * `saved: true` back, and a patch can only reach posts the list is still
   * HOLDING. Filtering at the render keeps the row in the hook's array, so the
   * rollback still lands on it and the row comes back; dropping it from the
   * hook's array instead would be a removal with no rollback, which is the one
   * shape of optimistic update that lies.
   *
   * A list called "Saved posts" showing a row the viewer has just unsaved is
   * wrong about its own contents, and the bookmark alone does not fix that: the
   * row is still a row in a list whose whole meaning is membership.
   *
   * The same filter is what makes an unsave made on the **Search tab** land
   * here — the interaction channel broadcasts the patch to every mounted list,
   * so the row leaves this one without either screen knowing about the other.
   * The channel half of that is measured, at the hooks, by `crossList.test.ts`'s
   * `shows an unsave made in the feed as a hollow bookmark on the saved list’s
   * copy`; **no test in this repository mounts both SCREENS at once**, so what
   * is stated here is the composition of two measured pieces rather than a
   * third measurement.
   *
   * The cost, stated: when the last row goes this way the empty state appears
   * while the hook is still holding that post, and a failed unsave puts both
   * the row and an error banner back. That flicker is the optimistic model
   * being visible, not a state that needs a guard.
   */
  const rows = posts.filter((post) => post.saved);

  return (
    <MasonryFeed
      // `posts` and `activity` are INDEPENDENT props here in a way they are not
      // on the Search tab: this host shrinks the list without touching the
      // activity axis. It cannot produce a `'loading'` with rows behind it —
      // the only caller of `run('loading')` batches `setPosts([])` into the same
      // commit, and this filter can only ever shrink what that produces — but
      // the pair genuinely moves separately now, and `MasonryFeed` guards it on
      // its own props rather than on what a hook happens to do.
      posts={rows}
      activity={activity}
      error={error}
      // The banner's retry is a page-one load, which is what `refresh` is — the
      // same recovery path as pull-to-refresh rather than a second one that can
      // drift.
      onRetry={refresh}
      onEndReached={loadMore}
      onRefresh={refresh}
      onToggleLike={handleToggleLike}
      onToggleSave={handleToggleSave}
      // From `AuthContext`, never from anything on a post: `post.items[i].userId`
      // is the AUTHOR's id, so it answers a different question. `?? null` is
      // reachable — `app/_layout.tsx` gates on `status` from an effect, so a
      // sign-out renders this tree with no user for at least one commit before
      // the redirect. A null viewer owns nothing, which is the safe direction.
      //
      // Nothing on THIS screen renders differently for it while `onRemove` is
      // absent, which is exactly why it is asserted at the seam rather than
      // through a query — `favorites.saved.test.tsx`'s `hands the card the
      // signed-in viewer, and no delete path` reads the prop off the card's
      // fiber, because no query can see a value nothing draws.
      viewerId={user?.id ?? null}
      // Not "nobody has shared anything" — that is the community feed's empty
      // state and it would be a claim about other people. This list is empty
      // because of what the viewer has not done yet.
      emptyTitle="Nothing saved yet"
      // Names the fix, and names the RIGHT place: the bookmark lives on a post
      // card, and the feed those cards are in is the Search tab (ruling 1).
      emptyHint="Tap the bookmark on a post in the Search tab to keep it here."
    />
  );
}

/**
 * The saved-outfit gallery — FR5, and the half of TC-07 that reads "visible in
 * outfit gallery". Phase 3's feature list promises "View saved outfits in a
 * dedicated gallery"; this is it.
 *
 * On the **Favorites** tab, per the spec's screen map, which puts the composer
 * on Add and the gallery here. Home stays the wardrobe because Phase 3 §4
 * measures "the wardrobe dashboard" load time.
 *
 * Every screen state is derived from the hook's *two* axes rather than one
 * field. `activity` says what is in flight; `error` says what happened last,
 * and both can be true at once (a retry running over a previous failure).
 */
export default function FavoritesScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<FavoritesMode>('outfits');
  /**
   * How many post writes — likes and unsaves — are in flight in the saved
   * list, reported by `SavedPostsPane`.
   *
   * A COUNT, not a boolean, for the reason `savingSuggestions` gives on the Add
   * tab: `usePostList`'s guard is keyed by post AND kind, so a like and an
   * unsave really can overlap, and so can writes on two different cards. With a
   * boolean the first to settle would re-enable the chips while the second was
   * still running, which is precisely the state the flag exists to prevent.
   * Every write reports `true` exactly once and `false` exactly once, from a
   * `finally`, so the count returns to zero through a failure too.
   */
  const [postWrites, setPostWrites] = useState(0);

  const handleWritingChange = useCallback((writing: boolean) => {
    setPostWrites((count) => count + (writing ? 1 : -1));
  }, []);
  // `hasMore` and `remove` are deliberately not taken, and both are contracted
  // API rather than accidental accretion — Task 3's brief mandated this exact
  // return shape.
  //
  // `loadMore` already consults the cursor internally and is a no-op past the
  // last page, so rendering an "end of list" marker from `hasMore` would show
  // one permanently on a gallery that fits in a single screen.
  //
  // `remove` drops a row from the list ONE hook instance is holding. The detail
  // screen cannot use it: calling `useOutfits()` there would mount a second,
  // unrelated instance and fetch the whole gallery to delete one row, while the
  // instance behind THIS screen learned nothing from it. What closes that gap
  // is the dirty flag above, not a second delete affordance here. `remove`
  // stays because it carries semantics that cost a full review round to derive
  // — a 404 resolves `true`, because the one answer meaning "it is not there"
  // must not be the one that leaves an undeletable row on screen — and those
  // would have to be re-derived the day a gallery-level delete is briefed.
  const { outfits, activity, error, loadMore, refresh } = useOutfits();

  const openOutfit = useCallback(
    (id: string) => {
      // The route file `app/outfits/[id].tsx` ships in the same change as this
      // line, and that is not a stylistic preference. expo-router's typed-route
      // generator rewrites `.expo/types/router.d.ts` from the files on disk
      // unconditionally at every dev-server start, and `.expo/` is gitignored
      // in a project with no git — so a push to a path with no file behind it
      // breaks `pnpm typecheck` for everyone the moment somebody runs
      // `pnpm dev:mobile`, with nothing in the diff to explain it.
      router.push(`/outfits/${id}`);
    },
    [router],
  );

  /**
   * Refetch when this tab comes back into view **and something actually
   * changed** — never merely because it came back.
   *
   * This screen cannot see its own staleness. `useOutfits`'s effect keys only
   * on `[token]`, there is no shared outfit store, and Expo Router keeps this
   * gallery mounted while the detail screen is pushed over it — so a rename or
   * a delete performed there, and an outfit created on the Add tab, are
   * invisible on return until the user happens to pull to refresh. TC-07 is
   * recorded as "Outfit saved with correct item references; visible in outfit
   * gallery", and "visible after you think to swipe down" is not that.
   *
   * **The gate is the whole design, and refreshing unconditionally was a
   * regression.** `refresh()` is a page-ONE load that replaces the list, so a
   * focus effect without the gate throws away every page the user has scrolled
   * to: load page one, scroll to page two, open an outfit, come back — and the
   * page-two rows are gone, with the last request carrying no cursor at all.
   * That breaks browse → open → back → keep browsing for every user past the
   * server's 24-per-page default, which is the gallery's primary loop.
   *
   * `consumeOutfitsDirty()` both reads and clears, so one change causes exactly
   * one reload rather than one per focus for the rest of the session. The three
   * writers are `app/outfits/[id].tsx` (rename, delete, and a rename or delete
   * that answers 404 — the outfit is gone, so the list is stale either way) and
   * `app/(tabs)/add.tsx`, which passes `markOutfitsDirty` as the composer's
   * `onSaved`. See `src/outfits/outfitsDirty.ts` for why one bit rather than a
   * set of ids.
   *
   * The first focus costs nothing even when the flag IS set — a create on the
   * Add tab followed by a first visit to this tab: the effect fires while the
   * hook's own mount load is already in flight, and `refresh` is a no-op while
   * a full-list load is running, so the flag is consumed by a request that was
   * already fetching page one. That is a claim about effect ordering across two
   * modules — the hook's effect is registered earlier in this component, so it
   * runs first — and mocking `useOutfits` would make it unfalsifiable, so it is
   * pinned against the real hook in `__tests__/outfits/favorites.focus.test.tsx`.
   *
   * `useCallback` is not optional here. `useFocusEffect` lists `effect` in its
   * own `useEffect` deps, so an inline arrow would re-run the effect on every
   * render — and this effect fetches, and a fetch renders.
   */
  useFocusEffect(
    useCallback(() => {
      if (consumeOutfitsDirty()) refresh();
    }, [refresh]),
  );

  // A full-list load with nothing renderable behind it: first mount, or a
  // token change (both clear `outfits`). `activity === 'loading'` alone is not
  // enough — a `refreshing` load keeps its rows and must not blank the screen,
  // or every return to this tab flashes a spinner over content that is fine.
  //
  // The `outfits.length === 0` conjunct is a statement about `UseOutfitsResult`,
  // not about today's `useOutfits`: that hook batches `setOutfits([])` into the
  // same commit as `run('loading', ...)` (the mount effect is the only caller
  // of `run('loading')`), so no render it produces can currently reach this
  // with rows already on screen. Dropping the conjunct therefore survives the
  // suite unless a test states the CONTRACT rather than the implementation,
  // which `keeps rows on screen for a load that has something behind it` does.
  // The conjunct is what stops a hook that ever cleared the list a commit later
  // from blanking a populated gallery.
  const showFirstPageSpinner = activity === 'loading' && outfits.length === 0;

  // A failed load is not an empty gallery. Without the `error === null` guard
  // the screen would tell a user whose request just failed that they have
  // saved nothing, which is both false and unrecoverable-looking.
  //
  // `activity` plays NO part, deliberately, and an earlier revision of this line
  // got that wrong in both directions.
  //
  // Keyed on `activity === 'idle'` the empty state vanished during a refresh:
  // the rows stay on screen through a refresh — that is what makes a
  // pull-to-refresh not a reset — and the empty state IS this list's rows when
  // it has none, so a new user returning to this tab watched "No outfits yet"
  // and the pointer to the Add tab disappear for a round trip, losing the only
  // instruction the screen offers at the only moment it matters.
  //
  // An `activity !== 'loading'` guard then looked like the fix and was dead
  // code: a `loading` activity with no outfits is exactly `showFirstPageSpinner`
  // above, which replaces the whole list, so `ListEmptyComponent` is not
  // rendered at all in that case and no value of this expression can be
  // observed. A conjunct that cannot change the output is worse than none — no
  // mutation can kill it, so it reads as a tested guard while covering nothing.
  //
  // A failed load is not an empty gallery, so `error === null` stays: without
  // it the screen tells a user whose request just failed that they have saved
  // nothing, which is both false and unrecoverable-looking.
  //
  // There is only ONE empty state here, unlike the wardrobe grid: the gallery
  // has no category filter, so "empty" is unambiguous and the fix is always
  // the same one.
  const showEmptyState = outfits.length === 0 && error === null;

  return (
    <SafeAreaView style={screenStyles.root} edges={['top']}>
      <ScreenHeader
        title={MODE_LABELS[mode].title}
        hi={MODE_LABELS[mode].blurb}
        style={styles.header}
      />

      <View style={styles.modeRow}>
        {FAVORITES_MODES.map((option) => (
          <Chip
            key={option}
            testID={`favorites-mode-${option}`}
            label={MODE_LABELS[option].chip}
            selected={mode === option}
            onPress={() => setMode(option)}
            // Switching mid-write unmounts the saved list, and with it
            // `useSavedPosts` — so a like or an unsave that is about to FAIL
            // completes with nothing on screen to report it. The write itself
            // survives (the request is already out and `usePostList` marks the
            // saved list dirty on success), but its error message is written to
            // a hook that is no longer mounted, and React has not warned about
            // that since v18: the user is left looking at a list that will
            // quietly disagree with the server the next time they open it.
            //
            // ONE expression rather than a guard per source, extending the
            // count the way the Add tab's chips extend `busy || composerSaving
            // || savingSuggestions > 0`. A second check inside `onPress` would
            // be a second place for the same rule to be wrong — and it would be
            // the silent one, because `Pressable` merges THIS prop into the
            // `accessibilityState` it renders (`{...accessibilityState,
            // disabled}`), so a screen reader is told about this expression and
            // about nothing else. The tests read that merged value.
            disabled={postWrites > 0}
            accessibilityLabel={MODE_LABELS[option].accessibility}
          />
        ))}
      </View>

      {mode === 'saved' ? (
        <SavedPostsPane onWritingChange={handleWritingChange} />
      ) : (
        <>
        {/* No "Outfits" heading here. The chip row directly above already says
            which of the two lists is showing, and the nav header says
            "Favorites" — a third band repeating the selected chip's own label
            is chrome, not information. Found by looking at the device gate's
            screenshots rather than by any test: nothing asserts this heading,
            which is exactly why it survived. The saved side never had one, so
            removing it also makes the two modes symmetrical. */}

        {/* The message carries its own testID: the plate also contains the
            retry button's label, and RNTL's `toHaveTextContent` compares a
            string matcher by exact equality after normalisation, so reading
            the plate would mean loosening every assertion about this message
            to a substring regex. */}
        {error !== null ? (
          <ErrorPlate
            testID="outfits-error"
            messageTestID="outfits-error-message"
            retryTestID="outfits-retry"
            message={error}
            onRetry={refresh}
            retryAccessibilityLabel="Try loading your outfits again"
          />
        ) : null}

        {showFirstPageSpinner ? (
          <View testID="outfits-loading" style={styles.centre}>
            <ActivityIndicator size="large" color={color.soft} />
          </View>
        ) : (
          <FlatList
            testID="outfits-gallery"
            data={outfits}
            // Two, not the wardrobe's three: an outfit cell carries a cover, a
            // name AND a count, and a third of a phone's width leaves the name a
            // two-word ellipsis.
            numColumns={2}
            keyExtractor={outfitKeyExtractor}
            renderItem={({ item }) => <OutfitCard outfit={item} onPress={openOutfit} />}
            contentContainerStyle={styles.gallery}
            onEndReached={loadMore}
            onEndReachedThreshold={0.5}
            refreshing={activity === 'refreshing'}
            onRefresh={refresh}
            ListEmptyComponent={
              showEmptyState ? (
                <View testID="outfits-empty" style={styles.centre}>
                  <Text style={styles.emptyTitle}>No outfits yet</Text>
                  {/* Names the fix. The composer is on the Add tab, and an empty
                      state that does not say where to go is a dead end. */}
                  <Text style={styles.emptyHint}>Build your first one from the Add tab.</Text>
                </View>
              ) : null
            }
            ListFooterComponent={
              activity === 'loadingMore' ? (
                <View testID="outfits-loading-more" style={styles.footer}>
                  <ActivityIndicator />
                </View>
              ) : null
            }
          />
        )}
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { paddingBottom: space.md },
  // The same chip row as the Add tab's, built from the same primitive rather
  // than a second copy of its values — the two mode rows in this app are one
  // pattern, and that is now enforced by there being one component.
  modeRow: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.gutter, paddingBottom: 18 },
  // 12 here plus each cell's own 8 of padding gives the 20 gutter the rest of
  // the app aligns to, without a flex `gap` that a partial last row would
  // spread.
  gallery: { paddingHorizontal: space.md, paddingBottom: space.xxl },
  centre: { paddingVertical: 48, alignItems: 'center', gap: 6 },
  emptyTitle: { ...text.title, fontSize: 16 },
  emptyHint: { ...text.meta, fontSize: 13.5, textAlign: 'center' },
  footer: { paddingVertical: space.lg },
});
