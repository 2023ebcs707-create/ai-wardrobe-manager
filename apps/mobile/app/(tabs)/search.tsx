import React, { useCallback } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { useAuth } from '../../src/auth/AuthContext';
import { MasonryFeed } from '../../src/community/MasonryFeed';
import { consumeCommunityDirty } from '../../src/community/communityDirty';
import { useCommunityFeed } from '../../src/community/useCommunityFeed';
import { color, radius, space } from '../../src/theme/tokens';
import { font } from '../../src/theme/type';
import { ScreenHeader, screen as screenStyles } from '../../src/theme/ui';

/**
 * The community feed, and a search over the captions on it — FR9, FR10, TC-11,
 * TC-12.
 *
 * ## Why this is the Search tab (ruling 1)
 *
 * Phase 3 §2 names five tabs — Home, Search, Add, Favorites, Profile — so a
 * sixth would contradict the document and renaming this one to "Explore" would
 * too. The feed is therefore the Search tab's content, and the tab gains a
 * caption search over posts, which is what makes its name honest rather than
 * vestigial. FR10's "explore" is discharged by browsing the feed below.
 *
 * ## The search box does not fire a request per keystroke, and the reason is
 * the opposite of the intuition
 *
 * `?q=` costs O(feed size) rather than O(result size): measured at 5000 posts,
 * a *rare* term scans 5000 index keys to return nothing while a common term
 * scans 59 to return 20. **The expensive query is the one that finds nothing**
 * — which is what every prefix of a word is, and what an undebounced box sends
 * one of per letter. The debounce lives inside `useCommunityFeed` rather than
 * here, precisely so that no screen can omit it; this component hands over
 * every keystroke and the hook decides when to ask.
 *
 * ## What this screen deliberately does not take from the hook
 *
 * `hasMore` — `loadMore` already consults the cursor internally and is a no-op
 * past the last page, so an "end of feed" marker driven by it would sit
 * permanently under a feed that fits on one screen.
 *
 * ## `remove` IS wired, and the viewer id it needs comes from `AuthContext`
 *
 * Deleting your own post is built server-side (ruling 7) and exposed by the
 * hook, and until this task nothing called either — a user could publish to a
 * public feed and had no way to take it back down from anywhere in the app.
 * That is the user-harm gap ruling 7 added the endpoint FOR, so shipping the
 * endpoint without a control was the same gap with extra steps.
 *
 * The card decides which posts are the viewer's own, from `viewerId`, and this
 * screen is where that id is read: `useAuth().user`, the way every other screen
 * in this app reads the signed-in user. Never from a post — `post.items[i]
 * .userId` is the AUTHOR's id, so it answers a different question and is absent
 * on a post whose garments have all been deleted.
 *
 * `?? null` is REACHABLE, and not only a formality for the type. `app/_layout.tsx`
 * gates on `status` from a `useEffect`, so signing out sets `user` to `null`
 * and re-renders the tabs at least one commit before the redirect replaces the
 * route — this screen renders with no signed-in user in that gap. What the
 * fallback buys is that the gap draws a feed on which nothing is the viewer's
 * own, rather than throwing on `user.id`. A null viewer owns nothing, which is
 * the safe direction.
 */
export default function SearchScreen() {
  const { user } = useAuth();
  const {
    posts,
    activity,
    error,
    loadMore,
    refresh,
    query,
    setQuery,
    toggleLike,
    toggleSave,
    remove,
  } = useCommunityFeed();

  /**
   * Refetch when this tab comes back into view **and something actually
   * changed** — never merely because it came back.
   *
   * The gate is the whole design, exactly as on the Favorites tab. `refresh()`
   * is a page-ONE load that replaces the list, so an ungated focus effect
   * throws away every page the user has scrolled to: browse the feed, open the
   * Add tab, come back, and the second and third pages are gone. Here that is
   * worse than on the gallery, because this list is the one a user scrolls
   * deeply through.
   *
   * `consumeCommunityDirty('feed')` both reads and clears, so one change causes
   * exactly one reload rather than one per focus for the rest of the session.
   * **The argument matters**: `markCommunityDirty()` with no argument marks
   * every reader, and consuming the wrong reader here would leave the saved
   * list permanently stale while this one reloaded for changes that were not
   * its own.
   *
   * `useCallback` is not optional — `useFocusEffect` lists `effect` in its own
   * dependency array, so an inline arrow would re-run this on every render, and
   * this effect fetches, and a fetch renders.
   */
  useFocusEffect(
    useCallback(() => {
      if (consumeCommunityDirty('feed')) refresh();
    }, [refresh]),
  );

  return (
    <SafeAreaView style={screenStyles.root} edges={['top']}>
      <ScreenHeader title="Community" hi="What people wore this week" />

      <View style={styles.searchRow}>
        <TextInput
          testID="community-search-input"
          value={query}
          onChangeText={setQuery}
          placeholder="Search captions"
          // Placeholder text is real text and WCAG 1.4.3 does not exempt it:
          // it is the only thing in an empty field, and it is what tells a
          // user what the field is for. `soft` is 5.9:1 on `card` — measured
          // in `theme/tokens.test.ts` — and still reads as lighter than the
          // ink the user's own query renders in. `ShareOutfitSheet` takes the
          // same token, so the two composers still agree.
          placeholderTextColor={color.soft}
          accessibilityLabel="Search community captions"
          // SINGLE LINE, pinned rather than inherited. The API rejects a term
          // containing a control character with a 400, and the only way a user
          // could type one is a newline into a multiline box — so this default
          // is load-bearing, and a default that is load-bearing is written
          // down.
          multiline={false}
          // A caption search is a phrase, not a sentence: autocapitalising the
          // first letter makes "Blue" the term for a feed that stores "blue",
          // and the server's match is case-insensitive but the box would still
          // be lying about what was sent.
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={styles.searchInput}
        />
      </View>

      <MasonryFeed
        posts={posts}
        activity={activity}
        error={error}
        // The banner's retry is a page-one load of the CURRENT search, which is
        // what `refresh` is. It is also what pull-to-refresh does, deliberately
        // — one recovery path, not two that can drift.
        onRetry={refresh}
        onEndReached={loadMore}
        onRefresh={refresh}
        onToggleLike={toggleLike}
        onToggleSave={toggleSave}
        viewerId={user?.id ?? null}
        onRemove={remove}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  searchRow: { paddingHorizontal: space.gutter, paddingBottom: 18 },
  searchInput: {
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.cloud,
    paddingHorizontal: 15,
    paddingVertical: 13,
    fontFamily: font.body,
    fontSize: 15,
    color: color.ink,
  },
});
