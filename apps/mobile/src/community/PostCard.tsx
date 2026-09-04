import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { PublicClothingItem } from '@wardrobe/shared';
import { AVATAR_INK, avatarColor, initials } from './avatar';
import { color, radius, shadow } from '../theme/tokens';
import { font } from '../theme/type';
import { POST_CARD_METRICS } from './masonry';
import type { DisplayPost } from './posts';

export interface PostCardProps {
  post: DisplayPost;
  /**
   * Report a tap on the heart — **by post id, and that is the whole contract.**
   *
   * This card does not own the count and must not: the optimistic write, the
   * rollback and the cross-list broadcast all live in `usePostList`, which
   * looks the post up in the list it is holding *now* so that a card captured
   * in a closure one render ago cannot decide what a rollback restores.
   *
   * Typed as the hook's own `toggleLike`, which resolves rather than rejects,
   * so a press handler cannot produce an unhandled rejection.
   */
  onToggleLike: (postId: string) => Promise<boolean>;
  /** The bookmark, on exactly the same terms. */
  onToggleSave: (postId: string) => Promise<boolean>;
  /**
   * **The signed-in user's id**, or `null` when there is not one.
   *
   * The one input the retract control is decided from: this post is the
   * viewer's own when `post.author.id === viewerId`, and nothing else in this
   * card may be used to guess at it. There are two tempting inferences on the
   * data already here and both are wrong — `items[i].userId` is the AUTHOR's
   * id (the garments belong to whoever composed the outfit), so comparing it to
   * anything answers a different question, and it is absent entirely from a
   * post whose garments have all been deleted; and `saved` / `liked` are facts
   * about the viewer that are true of other people's posts too.
   *
   * REQUIRED rather than optional, and that is the point of it. An optional
   * viewer would let a host mount this card without one and get a feed on
   * which nobody can retract anything — which is the gap this control exists
   * to close, restored silently by an omission the compiler would not mention.
   * A host with no signed-in user passes `null` deliberately.
   *
   * Passed in rather than read from `AuthContext` here, so that this card stays
   * a pure function of its props: `MasonryFeed` renders it, and both the
   * community feed and the saved list render `MasonryFeed`. The id itself comes
   * from `AuthContext` at the screen — `useAuth().user` — never from an id
   * carried on a post.
   */
  viewerId: string | null;
  /**
   * Delete this post, by id, for a host that has a delete path.
   *
   * Typed as `useCommunityFeed`'s own `remove`, which **resolves rather than
   * rejects** — `true` when the post is gone (a 404 included: the post is not
   * there, which is what the user asked for) and `false` when it is not, with
   * the message on the host's error channel. That is why the press handler
   * below has no `catch`.
   *
   * OPTIONAL, because one of the two lists that render this card has no delete
   * path at all: `useSavedPosts` exposes no `remove`, and a saved list dropping
   * a row on someone else's behalf is not a thing it can do. Absent means the
   * control is not rendered, on any post, own or not.
   */
  onRemove?: (postId: string) => Promise<boolean>;
}

/**
 * What a screen reader is told about one garment in the collage.
 *
 * The same two attributes `ItemTile` announces — category, then colours —
 * because a photograph is silent and those are what make one thumbnail
 * distinguishable from the next. Written here rather than imported from
 * `ItemTile` because that component's label also carries selection ordinals
 * and laundry state, neither of which is true of another user's garment on a
 * public post.
 */
function describeItem(item: PublicClothingItem): string {
  const colourNames = item.colors.map((colour) => colour.name).filter((name) => name.length > 0);
  return colourNames.length > 0 ? `${item.category}, ${colourNames.join(', ')}` : item.category;
}

/**
 * One community post, as a card in the feed — FR9 / FR10, and the whole of
 * TC-11's "post appears in feed with correct image, caption, and user info".
 *
 * ## The author row is an avatar AND a name, and the avatar is never blank
 *
 * Phase 3 claims "User avatars and usernames displayed on each post card".
 * `avatarUrl` is carried on every author and written by nothing, so the
 * picture branch below is unreachable in the product as it stands and the
 * initials disc is what every reader will actually see. See `avatar.ts` for
 * why an initials avatar is the honest discharge of that claim and a blank
 * circle is not.
 *
 * The name is rendered as the name it is. A post outlives its author and
 * arrives as `'Deleted user'` when the account is gone — which is also a legal
 * display name, byte-identical on the wire — so there is nothing this card
 * could do about the difference except be wrong about a real person.
 *
 * ## The garments are not pressable, unlike everywhere else in this app
 *
 * `ItemTile` is deliberately not reused. Its tap opens `/items/:id` and its
 * accessibility hint says so, and these ids belong to ANOTHER user's wardrobe:
 * `GET /items/:id` answers 404 for every one of them. A row of controls that
 * announce "Opens this item's details" and then produce a not-found screen is
 * worse than a row of pictures. Its laundry treatment would be wrong here too
 * — whether a stranger has this shirt in the wash is not a fact this card is
 * about.
 *
 * They are drawn in **snapshot order**, which is the order the author composed
 * the outfit in and the order the server preserves through the compaction.
 * "top, trousers, shoes" reads correctly and the same three garments in
 * another order do not.
 *
 * ## `items: []` is not an error
 *
 * A post whose garments have all been deleted still renders, with its caption
 * and its author (ruling 4). The collage block is omitted rather than
 * reserved, and `missingItemsNotice` — which the data layer has already worded
 * — is what tells the reader why.
 *
 * ## Height
 *
 * Every block below takes its dimensions from `POST_CARD_METRICS`, which is
 * also what `postCardHeight` sums to decide which masonry column this card
 * goes in. They are one set of constants on purpose: a card whose real height
 * disagrees with the predicted one renders perfectly well and lays out an
 * unbalanced masonry, which has no other detector.
 *
 * The retract control is inside the existing actions row, whose height is
 * fixed, so a card that can be retracted is exactly as tall as one that cannot
 * and no metric moves. The confirmation prompt is the one thing on this card
 * that is NOT in the predicted height: it is a block that appears below the
 * actions while it is armed, so for as long as one post's prompt is open that
 * card is taller than `postCardHeight` says. Stated rather than hidden — it is
 * bounded to one card, only its owner's, only while the prompt is open, and
 * the alternative is either a prompt no screen reader can walk or a permanent
 * reserved gap under every card in the feed.
 *
 * ## Retracting your own post (ruling 7)
 *
 * `DELETE /community/posts/:id` was added deliberately as the one thing in
 * this stage beyond what any document claims, because publishing to a public
 * feed with no way to take it down is a user-harm gap rather than a feature
 * gap. A control is what makes that endpoint reachable; without one the gap is
 * the same gap with extra steps.
 *
 * - **Own-ness is `post.author.id === viewerId` and nothing else.** See
 *   `viewerId` for the two inferences available on this card's own data that
 *   are both wrong.
 * - **It confirms first**, because it is destructive, irreversible and about
 *   content other people can already see. The idiom is the one
 *   `app/outfits/[id].tsx` established for deleting an outfit: two rendered
 *   buttons, inline. `Alert.alert` is deliberately not used — it opens a
 *   blocking native modal no test can see or dismiss, it would stall the
 *   device gate behind a dialog nothing can press, and two rendered buttons
 *   are the only version a screen reader can walk.
 * - **It is ref-guarded, per card** — see `retractingRef`.
 */
export function PostCard({ post, onToggleLike, onToggleSave, viewerId, onRemove }: PostCardProps) {
  const { author, id } = post;

  // `void`, and the promise is deliberately not awaited: both hooks resolve
  // rather than reject, and the count on screen is driven by the interaction
  // channel rather than by this handler's return value.
  const onLikePress = useCallback(() => {
    void onToggleLike(id);
  }, [id, onToggleLike]);

  const onSavePress = useCallback(() => {
    void onToggleSave(id);
  }, [id, onToggleSave]);

  const [confirmingRetract, setConfirmingRetract] = useState(false);
  const [retracting, setRetracting] = useState(false);
  /**
   * The in-flight guard for the retract. A REF, and the `retracting` state
   * above is not a substitute for it.
   *
   * A double tap dispatches both presses before React can re-render, so the
   * second press sees the button's `disabled` prop still `false` AND invokes
   * the same closure the first one did, still holding `retracting === false`.
   * Both state-based defences miss it. Per INSTANCE, so a retract on one card
   * never blocks a retract on another — two posts are two different writes.
   *
   * `useCommunityFeed.remove` keeps a map of in-flight deletes keyed by post
   * id and hands the second caller the first one's promise, and that is NOT a
   * reason to skip this guard: `useGuardedMutation`'s header states the rule
   * that a shared guard "is deliberately not evidence that any particular
   * caller uses it", and this card is also mounted against hosts that pass a
   * different `onRemove`. What the ref covers here that nothing else can is
   * this card's own `retracting` state and the second press's trip through it.
   *
   * **It is released in a `finally`**, which is the half that gets forgotten:
   * Stage 6's review found a variant released only on the success path, so a
   * control whose write had failed once could never be used again — a dead
   * control that passed a test named "retryable" because that test only ever
   * pressed once. Both halves are pinned: one press issues one request, AND a
   * press after a failure reaches the host's handler.
   */
  const retractingRef = useRef(false);

  const onRetractPress = useCallback(async () => {
    if (retractingRef.current) return;
    // `onRemove` is optional, and the control that reaches this handler is only
    // rendered when it is present — so this is unreachable through the UI. It
    // is here because the alternative is a non-null assertion on a prop, and
    // because a `finally` that never ran would leave the guard set for the life
    // of the card.
    if (onRemove === undefined) return;
    retractingRef.current = true;
    setRetracting(true);

    try {
      // The answer is deliberately not read. `remove` resolves `true` when the
      // post is gone, and the host is what takes the row off the screen — this
      // card cannot remove itself. On failure the host owns the message too
      // (the feed's error banner), and THE PROMPT STAYS ARMED: the confirm
      // button is the retry, exactly as on the outfit delete prompt.
      //
      // No `catch`, because `remove` is contracted to resolve rather than
      // reject; a host that breaks that contract should surface as a rejection
      // rather than be swallowed here. The `finally` releases the guard either
      // way, so the control survives it.
      await onRemove(id);
    } finally {
      retractingRef.current = false;
      setRetracting(false);
    }
  }, [id, onRemove]);

  // THE ownership line. `viewerId` is `null` when nobody is signed in, and a
  // post's author id is a non-empty string, so a null viewer owns nothing.
  const ownPost = post.author.id === viewerId;
  // Both halves are required and neither implies the other: a host with no
  // delete path renders no control on anyone's post, and a host with one still
  // renders none on a stranger's.
  const canRetract = ownPost && onRemove !== undefined;

  // The count belongs in the LABEL as well as beside the heart. A screen
  // reader announces an `accessibilityState.selected` control as "selected",
  // which says whether the viewer has liked it and never how many people have
  // — and the count is the half TC-12 is about.
  const likeLabel = `${post.liked ? 'Unlike' : 'Like'} this post, ${post.likeCount} ${
    post.likeCount === 1 ? 'like' : 'likes'
  }`;

  return (
    <View testID={`post-card-${id}`} style={styles.card}>
      <View testID={`post-author-row-${id}`} style={styles.header}>
        {author.avatarUrl === undefined ? (
          <View
            testID={`post-avatar-${id}`}
            // Deterministic in the id, so this disc is the same colour on
            // every post this author has ever made and in both lists that can
            // hold one.
            style={[styles.avatar, { backgroundColor: avatarColor(author.id) }]}
          >
            <Text
              testID={`post-avatar-initials-${id}`}
              style={styles.avatarInitials}
              // The disc is a fixed 32pt and the letters would be clipped
              // rather than merely cramped at large OS font sizes. The name
              // itself sits beside it at full scale, and the author's name is
              // also on the row's accessibility label, so a user who needs
              // large text has two unclipped routes to the same fact.
              allowFontScaling={false}
              accessible={false}
            >
              {initials(author.name)}
            </Text>
          </View>
        ) : (
          <Image
            testID={`post-avatar-image-${id}`}
            source={{ uri: author.avatarUrl }}
            style={styles.avatar}
            resizeMode="cover"
            // The name beside it already identifies the author; a labelled
            // avatar would make a screen reader read every card's author twice.
            accessible={false}
          />
        )}
        <Text testID={`post-author-${id}`} style={styles.authorName} numberOfLines={1}>
          {author.name}
        </Text>
      </View>

      {post.items.length > 0 ? (
        <View testID={`post-items-${id}`} style={styles.items}>
          {post.items.map((item) => (
            <Image
              // Keyed by `item.id`, never by position. The server
              // de-duplicates `items` precisely so that no client has to, so
              // these ids are unique within one post.
              key={item.id}
              testID={`post-item-${id}`}
              // Pre-Stage-4 uploads have no thumbnail; the full image is what
              // keeps them visible.
              source={{ uri: item.thumbnailUrl ?? item.imageUrl }}
              style={styles.thumbnail}
              resizeMode="cover"
              accessibilityLabel={describeItem(item)}
            />
          ))}
        </View>
      ) : null}

      <Text
        testID={`post-caption-${id}`}
        style={styles.caption}
        // Clamped, and `postCaptionLines` predicts the same clamp: without it
        // one long caption makes one card as tall as the screen and the
        // masonry column under it never catches up.
        numberOfLines={POST_CARD_METRICS.maxCaptionLines}
      >
        {post.caption}
      </Text>

      {post.missingItemsNotice === null ? null : (
        // VERBATIM. The data layer words this sentence over DISTINCT ids and
        // states a fact about the post while asserting no cause; nothing here
        // rewords it, builds a larger sentence around it, or derives a number
        // back out of it.
        <Text testID={`post-missing-${id}`} style={styles.notice} numberOfLines={1}>
          {post.missingItemsNotice}
        </Text>
      )}

      <View testID={`post-actions-${id}`} style={styles.actions}>
        <Pressable
          testID={`post-like-${id}`}
          onPress={onLikePress}
          accessibilityRole="button"
          accessibilityLabel={likeLabel}
          // Whether the VIEWER has liked it — never whether the author has.
          accessibilityState={{ selected: post.liked }}
          style={styles.action}
        >
          <Ionicons
            testID={`post-like-icon-${id}`}
            // A filled heart against an outline, so the state is a SHAPE and
            // not only a colour — the same reason the laundry treatment
            // carries a written label rather than a tint.
            name={post.liked ? 'heart' : 'heart-outline'}
            size={20}
            color={post.liked ? LIKED_COLOUR : ACTION_COLOUR}
            // The actions row has a fixed height that this sum depends on, and
            // `@expo/vector-icons` sets this in `defaultProps` — which React 19
            // has already removed for function components, so the day this
            // library converts `Icon`, an inherited default would silently
            // start growing the glyph out of the row.
            allowFontScaling={false}
            accessible={false}
          />
          <Text testID={`post-like-count-${id}`} style={styles.actionText} accessible={false}>
            {post.likeCount}
          </Text>
        </Pressable>

        <Pressable
          testID={`post-save-${id}`}
          onPress={onSavePress}
          accessibilityRole="button"
          accessibilityLabel={post.saved ? 'Remove this post from your saved posts' : 'Save this post'}
          accessibilityState={{ selected: post.saved }}
          style={styles.action}
        >
          <Ionicons
            testID={`post-save-icon-${id}`}
            name={post.saved ? 'bookmark' : 'bookmark-outline'}
            size={20}
            color={post.saved ? SAVED_COLOUR : ACTION_COLOUR}
            allowFontScaling={false}
            accessible={false}
          />
        </Pressable>

        {/* Only on a post the viewer wrote, and only for a host that can
            actually delete one. A stranger's card carries no such control at
            all — not a disabled one, which would advertise an action the API
            answers with a 404. */}
        {canRetract && !confirmingRetract ? (
          <Pressable
            testID={`post-retract-${id}`}
            onPress={() => setConfirmingRetract(true)}
            accessibilityRole="button"
            // Says what it does to a PUBLIC thing. "Delete" would be
            // ambiguous on a card whose garments are also deletable elsewhere
            // in this app; the outfit and the items it was shared from are not
            // touched by this.
            accessibilityLabel="Retract this post from the community feed"
            style={[styles.action, styles.retractAction]}
          >
            <Ionicons
              testID={`post-retract-icon-${id}`}
              name="trash-outline"
              size={20}
              color={RETRACT_COLOUR}
              // The actions row has a fixed height this sum depends on, and
              // `@expo/vector-icons` sets this in `defaultProps` — already
              // removed for function components in React 19 — so an inherited
              // default would silently start growing the glyph out of the row.
              allowFontScaling={false}
              accessible={false}
            />
          </Pressable>
        ) : null}
      </View>

      {/* Destructive, irreversible, and about something other people can
          already see, so it asks first. Inline rather than `Alert.alert` — see
          the component header.

          The `canRetract &&` conjunct is DEFENCE IN DEPTH AND NOTHING MEASURES
          IT: dropping it fails no test in this suite, because nothing arms the
          prompt on a card that then stops being retractable. It is here for the
          one transition that can: `viewerId` is a prop, so a host that changes
          it — a sign-out, or a list re-keyed onto another account — while a
          prompt is open would otherwise leave an armed Retract on a post that
          is no longer the viewer's. Kept deliberately, with the coverage gap
          stated rather than papered over. */}
      {canRetract && confirmingRetract ? (
        <View testID={`post-retract-prompt-${id}`} style={styles.retractPrompt}>
          <Text testID={`post-retract-prompt-text-${id}`} style={styles.retractPromptText}>
            Retract this post? It disappears from the community feed for everyone. Your outfit and
            your clothing items are not affected.
          </Text>
          <View style={styles.retractRow}>
            <Pressable
              testID={`post-retract-cancel-${id}`}
              onPress={() => {
                // Disarmed, not merely hidden: a prompt left on screen after a
                // cancel is one an accidental tap can still fire.
                setConfirmingRetract(false);
              }}
              disabled={retracting}
              accessibilityRole="button"
              accessibilityLabel="Keep this post in the community feed"
              accessibilityState={{ disabled: retracting }}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              testID={`post-retract-confirm-${id}`}
              onPress={onRetractPress}
              // The render signal, not the guard — see `retractingRef`. This
              // stops a SEQUENTIAL second press a frame later; the ref stops
              // the same-frame one.
              disabled={retracting}
              accessibilityRole="button"
              accessibilityLabel="Retract this post for good"
              accessibilityState={{ disabled: retracting }}
              style={[styles.dangerButton, retracting && styles.dangerButtonDisabled]}
            >
              {retracting ? (
                <ActivityIndicator color={color.soft} />
              ) : (
                <Text style={[styles.dangerButtonText, retracting && styles.dangerButtonTextDisabled]}>
                  Retract
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/*
 * The four states an action row can be in, all drawn from the palette and all
 * measured against `card` (white) at >= 4.5:1 — these are 14pt semibold
 * labels, which WCAG counts as normal text.
 *
 * `sage` and `blush` themselves are NOT here: at 3.8:1 and 2.3:1 on white they
 * are surface and pip colours, not text colours. The two darker relatives
 * below are what the same states look like when they have to be read.
 */
/*
 * Exported so a test asserts against the SHIPPED value rather than a copy of
 * it — the same reason `IN_LAUNDRY_LABEL` is exported one directory over. A
 * test carrying its own `'#444'` passes after the palette moves underneath it
 * and fails after any rename, which is the wrong way round.
 */
export const ACTION_COLOUR = color.soft;
export const LIKED_COLOUR = color.washInk;
export const SAVED_COLOUR = color.success;
const RETRACT_COLOUR = color.washInk;

const styles = StyleSheet.create({
  card: {
    padding: POST_CARD_METRICS.padding,
    marginBottom: POST_CARD_METRICS.marginBottom,
    gap: POST_CARD_METRICS.gap,
    borderRadius: radius.card,
    backgroundColor: color.card,
    ...shadow.card,
  },
  header: {
    height: POST_CARD_METRICS.headerHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  avatar: {
    width: POST_CARD_METRICS.headerHeight,
    height: POST_CARD_METRICS.headerHeight,
    borderRadius: POST_CARD_METRICS.headerHeight / 2,
    alignItems: 'center',
    justifyContent: 'center',
    // Overflow is clipped so a non-square uploaded picture cannot spill out of
    // the disc when one finally exists.
    overflow: 'hidden',
  },
  avatarInitials: { color: AVATAR_INK, fontFamily: font.bold, fontSize: 13 },
  // `flex: 1` so a long name ellipsises inside the row instead of pushing the
  // row wider than the card.
  authorName: { flex: 1, fontFamily: font.semibold, fontSize: 14, color: color.ink },
  items: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: POST_CARD_METRICS.thumbnailGap,
  },
  // A shade under half, so two sit on one row with the gap between them and a
  // third wraps. The height is fixed rather than an aspect ratio, because it
  // is a term in `postCardHeight`.
  thumbnail: {
    width: '48%',
    height: POST_CARD_METRICS.thumbnailHeight,
    borderRadius: 10,
    backgroundColor: color.cloud,
  },
  caption: {
    fontFamily: font.body,
    fontSize: 14,
    // Pinned rather than left to the platform default, for the same reason the
    // thumbnail height is: it is a term in `postCardHeight`.
    lineHeight: POST_CARD_METRICS.captionLineHeight,
    color: color.ink,
  },
  notice: {
    fontFamily: font.body,
    fontSize: 12,
    lineHeight: POST_CARD_METRICS.noticeHeight,
    color: color.soft,
  },
  actions: {
    height: POST_CARD_METRICS.actionsHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  action: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actionText: { fontFamily: font.semibold, fontSize: 14, color: ACTION_COLOUR },
  // Pushed to the far end of the row, away from the two controls a user taps
  // often: a destructive action should not sit under the thumb that is
  // double-tapping hearts.
  retractAction: { marginLeft: 'auto' },
  retractPrompt: { gap: 8 },
  retractPromptText: { fontFamily: font.body, fontSize: 13, color: color.ink, lineHeight: 18 },
  // STACKED, unlike the outfit delete prompt's side-by-side row, and the
  // difference is the width rather than a change of mind. That prompt sits on a
  // full-width screen; this one is inside a masonry card, which is about 143pt
  // of content once the feed's 12pt gutters, the 10pt column gap and the card's
  // own 10pt padding come out of a 360pt phone. Two buttons across that leaves
  // the confirm button roughly 59pt, and "Retract" at 14pt semibold is roughly
  // 54 — it fits at the default font scale and clips at the first step above
  // it. A destructive control whose label is cut in half is worse than one
  // extra row of height, and this block is already outside the predicted card
  // height while it is armed.
  //
  // A column `View` stretches its children, so each button is the full width of
  // the card; `flex: 1` is deliberately absent from the danger button for the
  // same reason — in a column it would stretch vertically instead.
  retractRow: { gap: 8 },
  secondaryButton: {
    backgroundColor: color.cloud,
    borderRadius: radius.pill,
    paddingVertical: 9,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  secondaryButtonText: { color: color.ink, fontFamily: font.semibold, fontSize: 14 },
  dangerButton: {
    backgroundColor: RETRACT_COLOUR,
    borderRadius: radius.pill,
    paddingVertical: 9,
    alignItems: 'center',
  },
  // Same reasoning as the filled buttons above: an opacity-dimmed red is
  // still a solid coloured button. `cloud` is unmistakably inactive.
  dangerButtonDisabled: { backgroundColor: color.cloud },
  dangerButtonTextDisabled: { color: color.soft },
  dangerButtonText: { color: color.wash, fontFamily: font.semibold, fontSize: 14 },
});
