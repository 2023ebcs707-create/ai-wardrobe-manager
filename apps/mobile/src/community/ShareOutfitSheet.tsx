import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { MAX_CAPTION_LENGTH } from '@wardrobe/shared';
import { ApiClientError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { sharePost } from './api';
import { markCommunityDirty } from './communityDirty';
import type { DisplayPost } from './posts';
import { color, radius, shadow, space } from '../theme/tokens';
import { font, text } from '../theme/type';

/**
 * `140 characters left`, `1 character left`.
 *
 * The noun has to agree, which is why this is not `${remaining} characters
 * left`. Exported so a test names the same sentence the sheet does rather than
 * a copy of it that can drift.
 */
export function remainingLabel(remaining: number): string {
  return `${remaining} ${remaining === 1 ? 'character' : 'characters'} left`;
}

function messageFor(err: unknown): string {
  // `ApiClientError` messages are already written for a person to read: the
  // client turns a network failure into "Cannot reach the server…" and passes
  // the API's own message through otherwise. Anything else is a bug in this app
  // and its message is not fit to show anyone.
  if (err instanceof ApiClientError) return err.message;
  return 'Something went wrong sharing this outfit.';
}

export interface ShareOutfitSheetProps {
  /**
   * An outfit the CALLER OWNS. `POST /community/posts` answers 404 for a
   * foreign outfit, one that never existed and a malformed id alike —
   * deliberately, so this endpoint cannot be used as an existence oracle over
   * other users' outfits — which means a bad id here is an error the user
   * cannot act on. Every host in this app takes it from an outfit it has just
   * loaded through `GET /outfits/:id`, which is already owner-scoped.
   */
  outfitId: string;
  /**
   * The post the server actually created, as a `DisplayPost`.
   *
   * A host should treat this as its cue to DISMISS the sheet: a successful
   * share is finished, and a composer left on screen with a caption in it
   * invites a second post of the same outfit.
   *
   * It is the response and never what the user typed. The caption arrives
   * trimmed as the server stored it, and `missingItemsNotice` is worded by the
   * data layer, so a confirmation built from this describes the post that
   * exists rather than the request that was sent.
   */
  onShared: (post: DisplayPost) => void;
  /** Back out without sharing. */
  onCancel: () => void;
}

/**
 * Share one saved outfit to the community feed, with a caption — FR9, and the
 * "with caption" half of TC-11.
 *
 * Without this component `POST /community/posts` is unreachable from the
 * product: `sharePost` has exactly one caller in the app and it is the press
 * handler below.
 *
 * ## It is an INLINE block, not a native modal, and the name "sheet" is about
 * its shape rather than its mechanism
 *
 * `app/outfits/[id].tsx` states the rule this follows for its delete
 * confirmation: a blocking native dialog is something no test can see or
 * dismiss and it would stall the device gate behind a control nothing can
 * press. Rendered elements are also the only version a screen reader can walk.
 * So the host mounts and unmounts this the way it would any other block.
 *
 * ## The caption bound is enforced HERE as well as at the API, and the counter
 * has to measure the same units the API does
 *
 * `MAX_CAPTION_LENGTH` comes from `@wardrobe/shared` rather than a literal, for
 * the reason that constant's own comment gives: two copies of one bound drift
 * silently and asymmetrically. A composer allowing more than the API turns
 * Share into an unretryable dead end; one allowing less refuses keystrokes the
 * server would have taken.
 *
 * **The count is `caption.length` — UTF-16 code units — and NOT
 * `[...caption].length`**, because that is the unit BOTH of the other two
 * layers measure in:
 *
 *  * the API's bound is `z.string().trim().max(MAX_CAPTION_LENGTH)`
 *    (`apps/api/src/routes/community.ts`), and zod's `.max()` on a string
 *    compares `String.length`;
 *  * `maxLength` on the field below reaches Android as
 *    `InputFilter.LengthFilter(maxLength)` (`ReactTextInputManager.kt` in
 *    react-native 0.86.2), which counts Java `char`s.
 *
 * So 140 of a non-BMP emoji is 280 units and fits, and 141 is 282 and does not.
 * A counter over code points would read 140 where those two read 280: it would
 * promise a user 140 more characters after the server had stopped accepting
 * them, and the field would stop taking input at a number the counter never
 * reached.
 *
 * **That is measured, not only derived.** The derivation above is what it rests
 * on for the Android filter, but the API half is pinned by
 * `apps/api/src/routes/community.integration.test.ts` — "bounds the caption in
 * UTF-16 code units, not code points" — which runs 140 emoji (201), 141 emoji
 * (400) and 141 ASCII (201) against the real route. The third row is what makes
 * the other two mean anything: without it, "140 in, 141 out" is equally
 * consistent with a code-point bound of 140.
 *
 * ## The write is ref-guarded, and the guard is released in a `finally`
 *
 * See `sharingRef`. Both halves are pinned by tests, because both halves have
 * shipped broken in this project: Stage 5 shipped a same-frame double tap that
 * created two identical outfits, and Stage 6's review then found a variant of
 * the guard released only on the success path — a dead control that passed a
 * test named "retryable" because that test only ever pressed once.
 *
 * ## A failed share keeps the caption
 *
 * Losing 280 typed characters to a network blip is a real defect, so nothing on
 * the failure path touches `caption`: the Share button is the retry. Nothing on
 * the SUCCESS path clears it either — the host dismisses the sheet, which
 * unmounts the field with it — so the caption in this component is only ever
 * lost because the user cleared it or the sheet went away.
 */
export function ShareOutfitSheet({ outfitId, onShared, onCancel }: ShareOutfitSheetProps) {
  const { token } = useAuth();

  const [caption, setCaption] = useState('');
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The in-flight guard. A REF, and the `sharing` state above is not a
   * substitute for it.
   *
   * A double tap dispatches both presses before React can re-render, so the
   * second press sees the button's `disabled` prop still `false` AND invokes
   * the same `onShare` closure the first one did, still holding
   * `sharing === false`. Both state-based defences miss it, and the result is
   * two identical public posts of one outfit — nothing server-side
   * de-duplicates a share, unlike a like or a save, and the user has to delete
   * one of them from the feed afterwards.
   *
   * Same reasoning, verbatim, as `savingRef` in `SuggestionCard` and
   * `OutfitComposer` and `busyRef` in `app/(tabs)/add.tsx`.
   *
   * `sharing` remains as state because the spinner and the disabled button are
   * a render, and a ref does not cause one.
   */
  const sharingRef = useRef(false);

  // `.length`, not a code-point count — see the header. `maxLength` on the
  // field below counts the same units, so this cannot go negative.
  const remaining = MAX_CAPTION_LENGTH - caption.length;
  // Trimmed, because the API rejects a whitespace-only caption with a 400 and
  // that is an error the user cannot act on: the field would look full.
  const trimmed = caption.trim();
  const canShare = trimmed !== '' && !sharing;

  const onShare = useCallback(async () => {
    if (sharingRef.current) return;
    // Deliberately NOT a repeat of the button's `disabled` prop for the empty
    // caption. The same-frame race a `disabled` prop cannot see needs two
    // presses on the SAME target; "clear the field" and "press Share" are two
    // different targets, so `disabled` is the whole defence there and this
    // would be a second copy of one condition. Same rule, stated for the same
    // reason, as `OutfitComposer`'s empty-selection guard.
    sharingRef.current = true;
    setSharing(true);
    setError(null);

    // Captured before the await so the request cannot pick up a keystroke that
    // landed while it was in flight.
    const sent = caption.trim();

    try {
      const post = await sharePost({ token, outfitId, caption: sent });
      // BEFORE handing back, so a host that dismisses this sheet and navigates
      // in `onShared` cannot leave the flag unset. The Search tab's focus gate
      // is what actually shows the new post: it is a page-one refetch keyed on
      // this bit, and without the mark the user returns to a feed that does not
      // contain what they just shared, with nothing to explain it.
      //
      // `['feed']` and only `'feed'`. `markCommunityDirty()` with no argument
      // marks every reader, which would additionally throw away the saved
      // list's scrolled pages to reload a list a share did not move — the
      // exact regression the reader split in `communityDirty.ts` exists to
      // prevent, and it is one omitted argument away.
      markCommunityDirty(['feed']);
      onShared(post);
    } catch (err) {
      // The caption is deliberately untouched: it is 280 characters the user
      // typed, and the button is the retry.
      setError(messageFor(err));
    } finally {
      // Released either way. A guard released only on the success path is a
      // control that dies at its first failure.
      sharingRef.current = false;
      setSharing(false);
    }
  }, [caption, onShared, outfitId, token]);

  return (
    <View testID="share-outfit-sheet" style={styles.sheet}>
      <Text style={styles.title}>Share to the community</Text>

      <TextInput
        testID="share-caption-input"
        value={caption}
        onChangeText={setCaption}
        placeholder="Say something about this outfit"
        // Was `#888`, copied from the feed's search box — **3.54:1** on white,
        // below WCAG AA. Placeholder text is real text and 1.4.3 does not
        // exempt it: on an empty field it is the only thing there, and it is
        // what says what the field is for. gray-500 is **4.83:1**, and still
        // reads lighter than the `#111` the caption itself renders in. The
        // original in `app/(tabs)/search.tsx` moved to the same value in the
        // same change, so the two composers have not drifted apart.
        placeholderTextColor={color.soft}
        // From `@wardrobe/shared`, never a literal — see the header. The API
        // rejects a longer caption outright and a rejected share is one the
        // user cannot fix by retrying, so it is cheaper to make the 281st
        // character unenterable than to explain it afterwards.
        maxLength={MAX_CAPTION_LENGTH}
        accessibilityLabel="Caption for this post"
        // Multiline, unlike the feed's search box: a caption is a sentence
        // about an outfit and the card lays out for several lines of it. The
        // API imposes no line-break rule on a caption, only a length.
        multiline
        editable={!sharing}
        style={styles.captionInput}
      />

      {/* Live, and it counts DOWN rather than up: what a user about to be cut
          off needs is the number of characters they have left, not the number
          they have already typed. */}
      <Text testID="share-caption-remaining" style={styles.remaining}>
        {remainingLabel(remaining)}
      </Text>

      <View style={styles.actions}>
        <Pressable
          testID="share-cancel"
          onPress={onCancel}
          // Disabled during the request, exactly as the delete prompt's Cancel
          // is: dismissing the sheet mid-share would complete the `POST` with
          // nobody left to report it, and the user would be told nothing about
          // a post that now exists.
          disabled={sharing}
          accessibilityRole="button"
          accessibilityLabel="Do not share this outfit"
          accessibilityState={{ disabled: sharing }}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryButtonText}>Cancel</Text>
        </Pressable>

        <Pressable
          testID="share-submit"
          onPress={onShare}
          // The render signal AND the whole defence against an empty caption —
          // see `onShare`. The ref is what stops the same-frame double tap;
          // this is what stops a press the API would answer with a 400 the
          // user cannot act on, and what makes the refusal visible rather than
          // leaving a silent dead control.
          disabled={!canShare}
          accessibilityRole="button"
          accessibilityLabel="Share this outfit to the community feed"
          accessibilityState={{ disabled: !canShare }}
          style={[styles.primaryButton, !canShare && styles.primaryButtonDisabled]}
        >
          {sharing ? (
            <ActivityIndicator color={color.soft} />
          ) : (
            <Text style={[styles.primaryButtonText, !canShare && styles.primaryButtonTextDisabled]}>
              Share
            </Text>
          )}
        </Pressable>
      </View>

      {error !== null ? (
        <Text testID="share-error" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    marginTop: space.lg,
    padding: space.lg,
    gap: space.sm,
    borderRadius: radius.card,
    backgroundColor: color.card,
    ...shadow.card,
  },
  title: { ...text.title, fontSize: 16 },
  captionInput: {
    backgroundColor: color.shell,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.cloud,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: font.body,
    fontSize: 15,
    color: color.ink,
    // A multiline field is one line tall by default on Android, which makes a
    // caption of any length scroll inside a single row.
    minHeight: 88,
    textAlignVertical: 'top',
  },
  remaining: { ...text.meta },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  secondaryButton: {
    backgroundColor: color.cloud,
    borderRadius: radius.pill,
    paddingVertical: 12,
    paddingHorizontal: 18,
    alignItems: 'center',
  },
  secondaryButtonText: { fontFamily: font.semibold, fontSize: 15, color: color.ink },
  primaryButton: {
    flex: 1,
    backgroundColor: color.ink,
    borderRadius: radius.pill,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
  },
  // A disabled FILLED button drops to the palette's quiet surface rather than
  // dimming. Opacity looked right in the stylesheet and wrong on the screen:
  // 40% of a near-black over a warm off-white is a mid grey, so the control
  // still reads as a solid, tappable button in a second colour — the exact
  // thing dimming was supposed to avoid. `cloud` under `soft` text is what
  // "inactive" already looks like everywhere else in this app (an unselected
  // chip is the same pair), and it clears WCAG AA at 5.0:1. Found by
  // photographing the screen, not by any test.
  primaryButtonDisabled: { backgroundColor: color.cloud },
  primaryButtonTextDisabled: { color: color.soft },
  primaryButtonText: { fontFamily: font.semibold, fontSize: 15, color: color.onInk },
  error: { ...text.body, fontSize: 13.5, color: color.washInk },
});
