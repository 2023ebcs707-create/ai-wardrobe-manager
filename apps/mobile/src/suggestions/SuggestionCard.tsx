import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PublicOutfit } from '@wardrobe/shared';
import { ApiClientError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { createOutfit } from '../outfits/api';
import { ItemTile } from '../wardrobe/ItemTile';
import { color, radius, space } from '../theme/tokens';
import { font, text } from '../theme/type';
import { Panel } from '../theme/ui';
import type { DisplaySuggestion } from './useSuggestions';

/**
 * A suggestion's identity, for React's key and for this card's testIDs.
 *
 * **Never the array index**, and a `DisplaySuggestion` has no id to use
 * instead — a suggestion is COMPUTED and never persisted (`PublicSuggestion`
 * deliberately carries no id, because one would imply a row exists somewhere).
 * So the identity has to be derived, and the only honest derivation is the
 * thing that makes one suggestion different from another: its ordered set of
 * garments.
 *
 * Why the index is wrong here is the same reason it is wrong on the wardrobe
 * grid and the outfit gallery, and it bites through REPLACEMENT rather than
 * through paging: `refresh()` keeps the rows mounted (`activity` goes to
 * `'refreshing'`, not `'loading'`) and then swaps the shortlist wholesale. With
 * an index key React reuses each row — and the thumbnails already mounted in it
 * — for a different proposed outfit, so the Save button under a row would post
 * a set of ids that is not the one the user is looking at. There is no paging
 * on this endpoint at all (`GET /suggestions` answers a snapshot with no
 * cursor), so replacement is the ONLY way this list ever changes, which makes
 * the index key worse here than anywhere else in the app.
 *
 * Taken from `saveItemIds` rather than from `items` so that the key describes
 * exactly what a Save would post. The two are the same list by construction
 * (`saveItemIds` is `items.map(i => i.id)`), and reading the one the button
 * uses means a key can never describe a different outfit from the action.
 *
 * The degenerate case is handled UPSTREAM rather than here: a suggestion whose
 * items all failed to resolve has an empty `saveItemIds` and therefore an empty
 * key, and two such suggestions in one response would collide — a duplicate-key
 * React warning that is loud in dev and **silent in a release build**, which is
 * the build it would actually happen in. It is not tolerated: `SuggestionsPane`
 * drops a suggestion with no items before the list ever sees it (a card with no
 * garments is not "a complete outfit card", and its Save would post
 * `itemIds: []` for an unretryable 400), so this function is never handed one.
 * The alternative — a tiebreaker — could only come from the index, which is
 * precisely what this function exists to keep out.
 */
export const suggestionKeyExtractor = (suggestion: DisplaySuggestion): string =>
  suggestion.saveItemIds.join('-');

export interface SuggestionCardProps {
  suggestion: DisplaySuggestion;
  /**
   * Open one of the suggestion's garments — called with the item's id, never
   * with the item and never with an index, exactly as `ItemTile` hands it over.
   *
   * Required rather than optional: the thumbnails below are the app's real
   * `ItemTile`, whose accessibility hint says "Opens this item's details". An
   * optional handler would let a host render a row of buttons that announce
   * that and then do nothing.
   */
  onItemPress: (id: string) => void;
  /**
   * "Modify" — hand these ids to the composer as its starting selection.
   *
   * Called with `saveItemIds`: the ids of the garments that were DISPLAYED, in
   * the engine's order. Never with `itemIds`, which this module cannot see (see
   * `DisplaySuggestion`) — the composer would otherwise open holding a garment
   * the user was never shown.
   */
  onModify: (itemIds: string[]) => void;
  /**
   * Called with the outfit `POST /outfits` actually created.
   *
   * Optional: this card already reports the save on screen, so it exists for a
   * host that has something further to do — here, telling the outfit gallery
   * its list is stale.
   */
  onSaved?: (outfit: PublicOutfit) => void;
  /**
   * Called with `true` when THIS card's save starts and `false` when it
   * settles, either way.
   *
   * Same contract, and the same reason, as `OutfitComposer.onSavingChange`: a
   * card cannot defend itself against being unmounted mid-save, only whatever
   * renders it can. Without this the Add tab's mode chips stay live during a
   * save, and switching away completes the `POST` with no feedback anywhere.
   */
  onSavingChange?: (saving: boolean) => void;
  /**
   * Whether the HOST has a suggestion save in flight — on this card or on any
   * other one it is showing.
   *
   * This card's own `savingRef` is per instance and cannot see a sibling, so
   * without this a save on card 1 plus a Modify on card 2 walks straight
   * through: the composer opens, the whole shortlist unmounts, and card 1's
   * `POST` completes with nobody left to report it. The Add tab's mode chips
   * are disabled on exactly this condition (`savingSuggestions > 0`); Modify is
   * the other way out of the list, so it reads the same bit.
   *
   * Optional and defaulting to `false` so a host that renders a single card is
   * not forced to invent a value — but a host rendering a LIST must pass it.
   */
  blocked?: boolean;
}

function messageFor(err: unknown): string {
  // `ApiClientError` messages are already written for a person to read: the
  // client turns a network failure into "Cannot reach the server…" and passes
  // the API's own message through otherwise. Anything else is a bug in this app
  // and its message is not fit to show anyone.
  if (err instanceof ApiClientError) return err.message;
  return 'Something went wrong saving this outfit.';
}

/**
 * One proposed outfit, as a card the user can **save or modify** — Phase 3's
 * "Suggestions presented as complete outfit cards the user can save or modify",
 * and the only part of FR8 / TC-10 a person can see.
 *
 * ## What is on it, and why each part has to be
 *
 * - **The garments, in the engine's order.** That order is the outfit: "top,
 *   trousers, shoes" reads correctly and "shoes, top, trousers" does not, and
 *   it is the order `POST /outfits` will store. Rendered with the app's own
 *   `ItemTile` rather than a second thumbnail renderer, so the fallback to
 *   `imageUrl` for pre-Stage-4 uploads, the category badge, the colour dots and
 *   the accessibility label are the wardrobe grid's and cannot drift from them.
 * - **The rationale, verbatim.** TC-10 claims the results are "relevant for
 *   most cases"; this sentence is the only thing on screen that lets a person
 *   judge that at all. A suggestion that cannot say why it was made is
 *   indistinguishable from a random pair of garments.
 * - **Save and Modify**, which are the two verbs Phase 3 names.
 *
 * ## What is deliberately NOT on it: `score`
 *
 * `score` is the ranking key and its ORDER is meaningful, but it is a mean over
 * a four-valued ordinal scale (`ANALOGOUS`/`COMPLEMENTARY` 1.0, `NEUTRAL` 0.7,
 * `UNMATCHED` 0.35, `SINGLE_ITEM` 0.5), so rendering it as "N% colour match"
 * asserts interval semantics it does not have — and produces, on the same card,
 * claims the engine explicitly refuses to make:
 *
 * - the floor is 0.35, not 0, so an outfit where **no colour rule fired at all**
 *   would read "35% colour match" directly beneath a rationale saying "no colour
 *   rule matched";
 * - a one-garment suggestion scores 0.5 → "50% colour match" where no pair was
 *   ever compared;
 * - a neutral pairing scores 0.7, and the engine states in as many words that a
 *   neutral is not a match but the ABSENCE of a conflict;
 * - scores collide by design (most of a shortlist shares the leading score), so
 *   a percentage implies a precision the ranking does not carry.
 *
 * The rationale below already names the relation in plain language, which is
 * the honest version of what a percentage was reaching for.
 *
 * ## Save posts `saveItemIds` and nothing else
 *
 * Not `items.map(...)` recomputed here, and not `itemIds`, which this module
 * cannot reach at all — `useSuggestions` withholds it deliberately, because the
 * engine's answer can name an id the wardrobe no longer resolves and posting
 * that set saves an outfit the user was never shown. `saveItemIds` is the
 * displayed set by construction. Pass it straight through: do not sort it, do
 * not de-duplicate it, and do not rebuild it from anywhere else.
 *
 * ## The save is ref-guarded, per card; leaving is guarded per HOST
 *
 * See `savingRef`. The ref is per INSTANCE, so a save on one card never blocks
 * a save on another — two different proposed outfits are two different writes,
 * and there is no reason one should swallow the other.
 *
 * Modify is not a second write, it is a way OUT of the list, and the thing that
 * makes it dangerous is any card's save, not this card's. So it reads the ref
 * **and** `blocked`, which the host derives from the same count its mode chips
 * use. See `onModifyPress` for what each half actually covers.
 */
export function SuggestionCard({
  suggestion,
  onItemPress,
  onModify,
  onSaved,
  onSavingChange,
  blocked = false,
}: SuggestionCardProps) {
  const { token } = useAuth();

  const [saving, setSaving] = useState(false);
  /**
   * The in-flight guard. A REF, and the `saving` state above is not a
   * substitute for it.
   *
   * A double tap dispatches both presses before React can re-render, so the
   * second press sees the button's `disabled` prop still `false` AND invokes
   * the same `onSave` closure the first one did, still holding
   * `saving === false`. Both state-based defences miss it, and two identical
   * outfits are created — nothing downstream de-duplicates them. A ref is
   * written and read inside that one synchronous burst.
   *
   * Same reasoning, verbatim, as `busyRef` in `app/(tabs)/add.tsx` and
   * `savingRef` in `OutfitComposer`. Stage 5 shipped this exact double-POST on
   * the composer and again on the item-upload path.
   *
   * **It is released in a `finally`**, which is the half that gets forgotten:
   * Stage 6's review found a variant released only on the success path, so a
   * card whose save failed once could never be saved again — a dead control
   * that passed a test named "retryable" because that test only ever pressed
   * once. A guard that is never released is worse than no guard, so both halves
   * are pinned: one press issues one request, AND a press after a failure
   * reaches the API.
   *
   * `saving` remains as state because the spinner and the disabled button are a
   * render, and a ref does not cause one.
   */
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const key = suggestionKeyExtractor(suggestion);

  const onSave = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;

    setSaving(true);
    setSaveError(null);

    try {
      // INSIDE the `try`, not between taking the ref and entering it. This is
      // a prop: a host whose handler throws would otherwise leave `savingRef`
      // set for the life of the card, and the ref gates BOTH Save and Modify —
      // so one bad render would turn a card into two dead buttons with no
      // message. Inside, the `finally` still releases it and the user still
      // gets an error they can retry from.
      onSavingChange?.(true);
      const outfit = await createOutfit({
        token,
        // The displayed set, handed over exactly as `useSuggestions` derived
        // it. Nothing here re-derives, sorts or de-duplicates it — see the
        // component comment.
        //
        // No `name`: the API's name schema trims and accepts `''`, so sending
        // one would save an outfit whose name is deliberately empty rather than
        // one with no name at all. An unnamed outfit is valid, and the user has
        // not been asked to name this one — they pressed Save on a proposal.
        // Naming is what Modify is for.
        itemIds: suggestion.saveItemIds,
      });
      setSaved(true);
      onSaved?.(outfit);
    } catch (err) {
      // Deliberately no `setSaved`: a failed save must not claim anything was
      // stored. The button stays enabled — it IS the retry.
      setSaveError(messageFor(err));
    } finally {
      savingRef.current = false;
      setSaving(false);
      onSavingChange?.(false);
    }
  }, [onSaved, onSavingChange, suggestion.saveItemIds, token]);

  const onModifyPress = useCallback(() => {
    // TWO guards, because they cover two different things and neither is the
    // other's superset. Modify switches the Add tab to the composer, which
    // unmounts the whole shortlist — so a Modify landing while ANY card is
    // saving completes that `POST` with the card gone and the user told
    // nothing.
    //
    // - `savingRef` is per INSTANCE and synchronous, so it is the only one that
    //   sees a Save and a Modify dispatched on THIS card in the same frame,
    //   before React can re-render and before any prop can change.
    // - `blocked` is the host's `savingSuggestions > 0` — the same bit that
    //   disables the mode chips — and it is the only one that sees a save on a
    //   DIFFERENT card. The ref cannot: it is a separate ref per instance.
    //
    // What this does not cover, stated rather than implied: a Save on card 1
    // and a Modify on card 2 dispatched in the SAME frame. `blocked` is a prop,
    // so it is still `false` for that frame. That is the identical window the
    // mode chips have — they are a `disabled` prop off the same state — so
    // Modify is now exactly as strong as the other way out of this list, which
    // is what it claims to be, rather than strictly weaker.
    if (savingRef.current || blocked) return;
    onModify(suggestion.saveItemIds);
  }, [blocked, onModify, suggestion.saveItemIds]);

  // A card whose garments all failed to resolve would post `itemIds: []`, and
  // `POST /outfits` answers that with a 400 — the one error class this card's
  // "the button IS the retry" contract has no answer for, because pressing
  // again produces the same 400 forever. `SuggestionsPane` already drops such a
  // suggestion before it can be rendered; this is the second line of that
  // defence, for any other host.
  const nothingToSave = suggestion.saveItemIds.length === 0;
  const saveDisabled = saving || saved || nothingToSave;
  // Modify stays REF-guarded above; this is what tells the user why nothing
  // happens. A dead control with no visual state and no message is the failure
  // mode this project has already paid for once.
  const modifyDisabled = saving || blocked;

  return (
    // Lit from behind by every colour in the proposal — the signature applied
    // to the one card in the app that IS a colour argument. The engine paired
    // these garments on hue; showing the result in those hues is the shortest
    // possible statement of why.
    <Panel
      testID={`suggestion-card-${key}`}
      style={styles.card}
      glow={suggestion.items.flatMap((item) => item.colors)}
    >
      <View testID={`suggestion-items-${key}`} style={styles.items}>
        {/* IN ORDER, and the order is the engine's. Keyed by `item.id` rather
            than by position for the reason `suggestionKeyExtractor` gives about
            the list above: a row that is replaced must not keep the image
            already mounted in it. */}
        {suggestion.items.map((item) => (
          <ItemTile key={item.id} item={item} onPress={onItemPress} />
        ))}
      </View>

      {/* Rendered as-is. The engine writes this sentence; nothing here rewords
          it, and nothing builds a larger claim around it. Set in the serif
          italic because it is the one piece of prose in this app that was
          written by the product rather than by the user. */}
      <Text testID={`suggestion-rationale-${key}`} style={styles.rationale}>
        {suggestion.rationale}
      </Text>

      {/* NO SCORE. `design/05-soft.html` drew one — "Colour match 0.70" — and
          it is not here, because `score` is a mean over a four-valued scale
          (ANALOGOUS/COMPLEMENTARY 1.0, NEUTRAL 0.7, UNMATCHED 0.35,
          SINGLE_ITEM 0.5). Its ORDER is meaningful and its magnitude is not:
          the floor is 0.35, so an outfit where no colour rule fired at all
          would print a number directly under a rationale saying exactly that.
          The mockup was drawn without that knowledge; the rationale is the
          honest version of what the number was reaching for, and it is already
          on the card. Pinned by a test in
          `__tests__/suggestions/SuggestionCard.test.tsx`. */}

      <View style={styles.actions}>
        <Pressable
          testID={`suggestion-save-${key}`}
          onPress={onSave}
          // `saved` disables it permanently for this card: the proposal has
          // been stored, and a second press would create a second identical
          // outfit that the user has to go and delete. The ref above is what
          // stops the same-frame double tap; this stops the deliberate one.
          // `nothingToSave` is the empty-selection guard — see above.
          disabled={saveDisabled}
          accessibilityRole="button"
          accessibilityLabel="Save this outfit"
          accessibilityState={{ disabled: saveDisabled }}
          style={[styles.saveButton, saveDisabled && styles.saveButtonDisabled]}
        >
          {saving ? (
            <ActivityIndicator color={color.soft} />
          ) : (
            <Text style={[styles.saveButtonText, saveDisabled && styles.saveButtonTextDisabled]}>
              {saved ? 'Saved' : 'Save outfit'}
            </Text>
          )}
        </Pressable>

        <Pressable
          testID={`suggestion-modify-${key}`}
          onPress={onModifyPress}
          // IN ADDITION to the ref in `onModifyPress`, not instead of it. The
          // ref is the guard — it survives the same-frame race a `disabled`
          // prop cannot see. This is what makes the refusal visible: without it
          // Modify is a silent dead control during a save, with no `disabled`
          // state, no styling and no message.
          disabled={modifyDisabled}
          accessibilityRole="button"
          accessibilityLabel="Modify this outfit before saving"
          accessibilityHint="Opens the outfit composer with these items already chosen"
          accessibilityState={{ disabled: modifyDisabled }}
          style={[styles.modifyButton, modifyDisabled && styles.modifyButtonDisabled]}
        >
          <Text style={styles.modifyButtonText}>Modify</Text>
        </Pressable>
      </View>

      {saveError !== null ? (
        <Text testID={`suggestion-save-error-${key}`} style={styles.saveError}>
          {saveError}
        </Text>
      ) : null}

      {saved ? (
        <Text testID={`suggestion-saved-${key}`} style={styles.savedText}>
          Saved to your outfits.
        </Text>
      ) : null}
    </Panel>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: space.gutter, marginBottom: space.md, padding: space.md, gap: space.sm },
  // `ItemTile` in its default (tile) layout is a third of the row wide, so
  // three garments fill it exactly and a fourth wraps rather than shrinking
  // the rest.
  items: { flexDirection: 'row', flexWrap: 'wrap' },
  rationale: { ...text.rationale, fontSize: 14, marginTop: space.xs },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: space.xs },
  saveButton: {
    flex: 1,
    backgroundColor: color.ink,
    borderRadius: radius.pill,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
    // Held so the row does not jump when the label becomes a spinner.
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
  saveButtonDisabled: { backgroundColor: color.cloud },
  saveButtonTextDisabled: { color: color.soft },
  saveButtonText: { fontFamily: font.semibold, fontSize: 15, color: color.onInk },
  modifyButton: {
    flex: 1,
    backgroundColor: color.cloud,
    borderRadius: radius.pill,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
  },
  modifyButtonDisabled: { opacity: 0.4 },
  modifyButtonText: { fontFamily: font.semibold, fontSize: 15, color: color.ink },
  saveError: { ...text.body, fontSize: 13.5, color: color.washInk },
  savedText: { ...text.body, fontSize: 13.5, color: color.success },
});
