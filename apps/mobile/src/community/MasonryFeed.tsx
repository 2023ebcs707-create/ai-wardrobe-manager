import React, { useCallback } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { MASONRY_COLUMNS, assignColumns, postCardHeight } from './masonry';
import { PostCard } from './PostCard';
import type { DisplayPost } from './posts';
import type { CommunityActivity } from './useCommunityFeed';
import { color, radius, space } from '../theme/tokens';
import { font, text } from '../theme/type';

/**
 * The feed's React key. **Never the array index.**
 *
 * Be precise about when that matters, because a paging test cannot tell the two
 * apart at all: a pure append leaves every existing card's position untouched,
 * so id keys and index keys reconcile identically there. The defect bites on
 * **replacement**, which this screen produces on three separate paths — a
 * pull-to-refresh, a focus refetch after a share, and every keystroke of a
 * search, all of which swap the whole list while the columns stay mounted. With
 * index keys React reuses each card, and the garment images already mounted in
 * it, for a different post: a stranger's outfit under the wrong author's name.
 *
 * Exported so the contract is directly assertable; the mount probe in
 * `__tests__/community/MasonryFeed.keys.test.tsx` catches the same defect
 * through public queries only.
 */
export const postKeyExtractor = (post: DisplayPost): string => post.id;

/**
 * How close to the bottom, in points, counts as "the end".
 *
 * Roughly one card's height, so the next page is requested while the user still
 * has something to look at rather than at the moment they run out.
 */
export const END_REACHED_THRESHOLD = 400;

export interface MasonryFeedProps {
  posts: DisplayPost[];
  activity: CommunityActivity;
  /** The last operation that failed, ready to render, or `null`. */
  error: string | null;
  /** The error banner's "Try again". */
  onRetry: () => void;
  /** Ask for the next page. Called repeatedly while near the bottom — see
   *  `onScroll` below. */
  onEndReached: () => void;
  /** Pull-to-refresh. */
  onRefresh: () => void;
  onToggleLike: (postId: string) => Promise<boolean>;
  onToggleSave: (postId: string) => Promise<boolean>;
  /**
   * The signed-in user's id, or `null`. Passed straight to every card, which
   * is where own-ness is decided — see `PostCardProps.viewerId` for why this is
   * required rather than optional and why it may not be inferred from a post.
   */
  viewerId: string | null;
  /**
   * Delete one of the viewer's own posts, by id. Optional: a list whose hook
   * has no delete path — `useSavedPosts` has none — simply does not pass one,
   * and no card in it carries the control.
   */
  onRemove?: (postId: string) => Promise<boolean>;
  /** What an empty list says. Defaulted to the community feed's wording; the
   *  saved list is a different situation with a different fix. */
  emptyTitle?: string;
  emptyHint?: string;
}

/**
 * Posts from **every user**, in a masonry-style two-column grid — Phase 3's
 * "masonry-style grid layout displaying posts from all users", FR10.
 *
 * ## Why this is a `ScrollView` and not a `FlatList`
 *
 * Masonry cannot be expressed as `numColumns`. A `FlatList` with two columns
 * lays its cells out in ROWS, and every cell in a row is as tall as the tallest
 * one — so a short card beside a tall card gets a rectangle of empty space
 * under it, which is precisely the ragged grid masonry exists to remove. The
 * layout requires two independent column stacks, and the only container that
 * holds two independent stacks and scrolls them together is a `ScrollView`.
 *
 * **The cost is real and worth stating: nothing here is virtualised.** Every
 * card the user has paged in stays mounted, images and all, where a `FlatList`
 * would recycle the off-screen ones. That is the price of masonry without a
 * third-party list (`@shopify/flash-list` is not a dependency of this app and
 * adding one is not this task's to make), and it is bounded by how far a user
 * scrolls in one session rather than by the size of the feed.
 *
 * ## Paging
 *
 * `onEndReached` is derived from the scroll offset rather than delivered by the
 * list, and it fires repeatedly through one fling — exactly as `FlatList`'s own
 * does, which is the case `useCommunityFeed.loadMore` is already written for
 * (it is a no-op while anything is in flight and past the last page).
 *
 * One difference from `FlatList` is worth writing down rather than discovering:
 * a scroll event is the ONLY trigger here, so a first page too short to scroll
 * never asks for a second. The server's page is 24 posts, which is twelve cards
 * per column and several screens tall, so this is not reachable through the
 * real route — but it would be through a much larger page size.
 */
export function MasonryFeed({
  posts,
  activity,
  error,
  onRetry,
  onEndReached,
  onRefresh,
  onToggleLike,
  onToggleSave,
  viewerId,
  onRemove,
  emptyTitle = 'Nothing shared yet',
  // Names the fix, and it has to name the RIGHT place. This read "Share an
  // outfit from the Add tab" while nothing on the Add tab — or anywhere else —
  // could share one; the entry point is on a saved outfit's own screen, which
  // is reached from the Favorites tab. An empty state that sends a new user to
  // a screen with no such control is worse than one that says nothing.
  emptyHint = 'Open one of your outfits on the Favorites tab and share it.',
}: MasonryFeedProps) {
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
      const distanceFromEnd = contentSize.height - (contentOffset.y + layoutMeasurement.height);
      if (distanceFromEnd <= END_REACHED_THRESHOLD) onEndReached();
    },
    [onEndReached],
  );

  // A full-list load with nothing renderable behind it: first mount, a token
  // change, or a new search term — all three clear the rows.
  //
  // The `posts.length === 0` half is a guard on THIS component's props, not on
  // what the hooks do. A `refreshing` load keeping its rows is already handled
  // by the `=== 'loading'` comparison, so it is not the reason for the
  // conjunct: the reason is that `posts` and `activity` arrive here as
  // independent props, and a caller holding rows while reporting `'loading'`
  // would blank a feed that has something in it. Both hooks batch `setPosts([])`
  // into the same commit as `run('loading', …)`, so neither reaches that pair
  // today — which is exactly why dropping this conjunct SURVIVED the suite
  // until `MasonryFeed.test.tsx` grew "keeps the rows on screen for a
  // 'loading' that has something behind it", the one test measured to fail
  // for it.
  const showFirstPageSpinner = activity === 'loading' && posts.length === 0;

  // A failed load is not an empty feed. Without the `error === null` guard the
  // screen would tell a user whose request just failed that nobody has shared
  // anything, which is both false and unrecoverable-looking — and the retry
  // button is in the banner they would then be told to ignore.
  const showEmptyState = posts.length === 0 && error === null;

  // THE masonry line. Heights are predicted rather than measured, because a
  // layout that waited for measurement would place every card in the wrong
  // column for one frame and then jump.
  const columns = assignColumns(posts.map(postCardHeight), MASONRY_COLUMNS);

  return (
    <View style={styles.container}>
      {error !== null ? (
        <View testID="community-error" style={styles.errorBanner}>
          {/* The message carries its own testID: the banner also contains the
              retry button's label, and RNTL's `toHaveTextContent` compares a
              string matcher by exact equality after normalisation. */}
          <Text testID="community-error-message" style={styles.errorText}>
            {error}
          </Text>
          <Pressable
            testID="community-retry"
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel="Try loading the community feed again"
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {showFirstPageSpinner ? (
        <View testID="community-loading" style={styles.centre}>
          <ActivityIndicator size="large" />
        </View>
      ) : (
        <ScrollView
          testID="community-feed"
          onScroll={onScroll}
          // 16ms rather than the default 0: without it Android delivers one
          // scroll event per gesture, which is exactly the event this list
          // derives its paging from.
          scrollEventThrottle={16}
          contentContainerStyle={styles.content}
          refreshControl={
            // No `testID`: `RefreshControl`'s does not reach the rendered
            // host node (the tree carries a bare `<RCTRefreshControl />`), so
            // one here would be a query nothing can answer. The element is
            // reachable as the `ScrollView`'s own `refreshControl` prop, which
            // is what the tests read.
            <RefreshControl refreshing={activity === 'refreshing'} onRefresh={onRefresh} />
          }
        >
          {showEmptyState ? (
            <View testID="community-empty" style={styles.centre}>
              {/* Two testIDs rather than one on the wrapper: RNTL's
                  `toHaveTextContent` compares a string matcher by EXACT
                  equality after normalisation, so a test reading the wrapper
                  would have to loosen every assertion about either sentence to
                  a substring regex. */}
              <Text testID="community-empty-title" style={styles.emptyTitle}>
                {emptyTitle}
              </Text>
              {/* Names the fix. An empty state that does not say where to go is
                  a dead end. */}
              <Text testID="community-empty-hint" style={styles.emptyHint}>
                {emptyHint}
              </Text>
            </View>
          ) : null}

          <View style={styles.columns}>
            {columns.map((indices, columnIndex) => (
              <View
                // The column count is a constant and the columns never
                // reorder, so a positional key is the identity here — the
                // same reasoning that makes an index key legitimate for
                // `ItemTile`'s colour swatches and a defect for the cards
                // inside these columns.
                key={`column-${columnIndex}`}
                testID={`community-column-${columnIndex}`}
                style={styles.column}
              >
                {indices.map((postIndex) => {
                  const post = posts[postIndex];
                  return (
                    <PostCard
                      key={postKeyExtractor(post)}
                      post={post}
                      onToggleLike={onToggleLike}
                      onToggleSave={onToggleSave}
                      // Handed to every card rather than to the ones this list
                      // thinks are the viewer's: the comparison belongs in one
                      // place, and a list deciding which cards deserve a
                      // viewer id would be a second implementation of it.
                      viewerId={viewerId}
                      onRemove={onRemove}
                    />
                  );
                })}
              </View>
            ))}
          </View>

          {activity === 'loadingMore' ? (
            <View testID="community-loading-more" style={styles.footer}>
              <ActivityIndicator />
            </View>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: space.md, paddingBottom: space.xxl },
  columns: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  // Equal widths whatever each column holds. `alignItems: 'flex-start'` above
  // is what stops the shorter column stretching to match the taller one.
  column: { flex: 1 },
  centre: { paddingVertical: 48, alignItems: 'center', gap: 6 },
  emptyTitle: { ...text.title, fontSize: 16 },
  emptyHint: { ...text.meta, fontSize: 13.5, textAlign: 'center' },
  errorBanner: {
    marginHorizontal: space.xs,
    marginBottom: space.sm,
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: color.wash,
    gap: space.md,
  },
  errorText: { ...text.body, fontSize: 13.5, color: color.washInk },
  retryButton: {
    alignSelf: 'flex-start',
    backgroundColor: color.washInk,
    borderRadius: radius.pill,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  retryText: { fontFamily: font.semibold, fontSize: 13, color: color.wash },
  footer: { paddingVertical: space.lg },
});
