import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  MAX_OUTFIT_ITEMS,
  MAX_OUTFIT_NAME_LENGTH,
  type PublicClothingItem,
  type PublicOutfit,
} from '@wardrobe/shared';
import { ApiClientError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { CategoryFilter } from '../wardrobe/CategoryFilter';
import { ItemTile } from '../wardrobe/ItemTile';
import { useWardrobe } from '../wardrobe/useWardrobe';
import { createOutfit } from './api';
import { color, radius, space } from '../theme/tokens';
import { font, text } from '../theme/type';

/*
 * `MAX_OUTFIT_ITEMS` and `MAX_OUTFIT_NAME_LENGTH` come from `@wardrobe/shared`
 * (see the comment beside them there), not from a literal copied out of the
 * route. Both are hard 400s that no retry can fix, and this screen's entire
 * error contract is "the save is retryable — press it again", so a selection
 * the API would reject is the one error state it has no answer for. Enforcing
 * them here is only safe while "them" means the same numbers the API is using,
 * which is what a shared constant guarantees and a copied one does not.
 */

export interface OutfitComposerProps {
  /**
   * Ids to start the selection with, in order — Stage 7's "Modify" (FR8 /
   * TC-10), which opens this composer holding the garments a suggestion
   * proposed so the user can swap one before saving.
   *
   * **Ids, not a selection model.** This composer owns selection order and
   * derives its ordinals from it (see `ordinals`); handing it a richer shape
   * would give it a second source for a fact it already computes.
   *
   * Absent means "start empty", which is every caller that is not Modify.
   *
   * ## It is applied whenever its VALUE changes, not only at mount
   *
   * `useState(initial)` reads its argument on the first render alone, so a
   * composer that is already mounted would ignore a second Modify on a
   * different suggestion — the user taps Modify, backs out, taps Modify on
   * another card, and gets the first card's garments. `useState` is therefore
   * not the whole mechanism: the block beside `appliedPreselection` re-applies
   * the prop when its contents change.
   *
   * Compared by VALUE rather than by reference deliberately. A host that
   * writes `preselectedItemIds={[...ids]}` inline builds a new array on every
   * render, and a reference comparison would re-apply the preselection on each
   * one — silently undoing every tap the user made. Value comparison makes the
   * prop mean what it says for any caller.
   *
   * The consequence of that choice, stated rather than left to be discovered:
   * re-applying the SAME ids is a no-op, so a host that wants "Modify this
   * suggestion again, from scratch" after the user has edited the selection
   * must unmount this component (the Add tab does — its modes are alternatives,
   * so leaving the composer destroys it) or change the ids.
   *
   * ## Longer than `MAX_OUTFIT_ITEMS`, and duplicates
   *
   * Both are normalised rather than accepted — see `normalisePreselection`.
   */
  preselectedItemIds?: readonly string[];
  /**
   * Called with the outfit `POST /outfits` actually created — a
   * `PublicOutfit`, the LIGHT shape: a cover and a count, no resolved items.
   *
   * Optional: the composer already reports the save on screen, so a host that
   * has nothing further to do can leave it out. It exists for a host that
   * does — a gallery that wants to fold the new outfit in without a refetch.
   */
  onSaved?: (outfit: PublicOutfit) => void;
  /**
   * Called with `true` when a save starts and `false` when it settles, either
   * way.
   *
   * The composer cannot defend itself against being unmounted mid-save — only
   * whatever renders it can, and the host's own "busy" flag knows nothing
   * about this one. Without this signal, the Add tab's mode chips stay live
   * during a save and switching away completes the `POST` with no feedback
   * anywhere and the selection gone.
   */
  onSavingChange?: (saving: boolean) => void;
}

function messageFor(err: unknown): string {
  // `ApiClientError` messages are already written for a person to read: the
  // client turns a network failure into "Cannot reach the server…" and passes
  // the API's own message through otherwise. Anything else is a bug in this
  // app and its message is not fit to show anyone.
  if (err instanceof ApiClientError) return err.message;
  return 'Something went wrong saving your outfit.';
}

/**
 * The grid's React key. **Never the array index** — and the reason bites
 * harder here than on the wardrobe grid it is borrowed from.
 *
 * `FlatList` keys each cell within a row by its column index, so this only
 * ever sets the ROW key, and a pure page append cannot tell id keys and index
 * keys apart. What it bites on is REPLACEMENT: a category change or a refresh
 * swaps `items` wholesale while the rows stay mounted. With index keys React
 * reuses the cell — and the image already in it — for a different garment, so
 * the selection ring and the ordinal disc would end up drawn over a garment
 * that is not in the outfit. See `wardrobeKeyExtractor` in
 * `app/(tabs)/index.tsx` for the same decision on the grid.
 */
const composerKeyExtractor = (item: PublicClothingItem): string => item.id;

/**
 * A `preselectedItemIds` prop → a selection this composer can actually hold.
 *
 * Two things are enforced, and neither is a formality:
 *
 * 1. **`MAX_OUTFIT_ITEMS`.** `toggle` refuses a tap past the limit rather than
 *    sending a selection the API would reject, because a 400 is the one error
 *    this screen's "the save is retryable — press it again" contract has no
 *    answer for. A preselection that walked in over the limit would defeat that
 *    guard from the other side: the save button would be enabled, the POST
 *    would 400, and pressing it again would 400 again, forever. The FIRST
 *    `MAX_OUTFIT_ITEMS` are kept because the order is the engine's and the
 *    front of it is the outfit's core — a top and a bottom before its
 *    accessories.
 * 2. **Duplicates.** The composer's selection is an ordered SET: `toggle` tests
 *    membership with `includes` and removes with `filter`, so a repeated id
 *    could never be deselected once (one tap would remove both copies) and
 *    would take two ordinals for one tile. `POST /outfits` also rejects a
 *    duplicate outright with a 400 — again unretryable. A duplicate is
 *    unreachable from `saveItemIds` today (it is `items.map(i => i.id)`, and
 *    the API resolves each id once), which is exactly why it is normalised
 *    here rather than assumed away: this prop is public and its next caller
 *    need not come from a suggestion.
 *
 * Nothing is sorted. The order that arrives is the order the user was shown,
 * and re-ordering it here would mean the composer opened holding a different
 * outfit from the card that launched it.
 */
function normalisePreselection(ids: readonly string[] | undefined): string[] {
  if (ids === undefined) return [];

  const kept: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
    if (kept.length === MAX_OUTFIT_ITEMS) break;
  }
  return kept;
}

/** Do two id lists carry the same ids in the same order? */
function sameIds(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Compose an outfit out of wardrobe items — FR5, and the action TC-07 names:
 * "User selects multiple items and saves as an outfit."
 *
 * ## What this screen does not own
 *
 * The item list comes from `useWardrobe()` rather than a fetch of its own, so
 * paging, category filtering, the stale-response guards and the error and
 * empty states are the wardrobe grid's, not a second implementation that can
 * drift from it. **The category filter stays**: composing an outfit *is*
 * picking a top, then trousers, then shoes, and the chips are how a user does
 * that.
 *
 * ## The selection is an ordered array, and that is the whole design
 *
 * `selectedIds` is a `string[]` in the order the user tapped, and the ordinal
 * on each tile is that id's POSITION in the array, derived on every render.
 * Nothing stores an ordinal. That is what makes a middle deselect renumber the
 * rest — select a, b, c, then deselect b, and c reads 2 — which is the defect
 * most likely to ship in this screen. The array is also exactly what goes on
 * the wire, so what the user sees and what the API stores cannot disagree: the
 * order is meaningful ("top, trousers, shoes" reads correctly, "shoes, top,
 * trousers" does not) and the API preserves it deliberately.
 *
 * The selection is this component's own state, not a projection of `items`, so
 * it survives the list being replaced under it. Filtering to `shoes` after
 * choosing a top must not discard the top — the user cannot even see it any
 * more to notice.
 *
 * ## Failure
 *
 * A failed save keeps the selection intact and shows a retryable error; the
 * save button IS the retry. Losing a nine-item selection to a flaky network is
 * the worst outcome available here. The wardrobe's own load error is rendered
 * separately, because a page load erasing a save failure the user still needs
 * to read is a bug this stage has already paid for once (Task 3, minor m5).
 */
export function OutfitComposer({
  preselectedItemIds,
  onSaved,
  onSavingChange,
}: OutfitComposerProps) {
  const { token } = useAuth();
  const { items: wardrobeItems, category, setCategory, activity, error, loadMore, refresh } =
    useWardrobe();

  /**
   * The wardrobe grid MINUS retired items — the deliberate OPPOSITE of how
   * this composer treats an in-laundry one, which stays selectable (ruling 3:
   * the composer must show it, because there the user is choosing). A retired
   * item is a harder exclusion: the user asked not to be able to select it at
   * all, and the same rule is enforced server-side in `resolveOwnedItems`
   * (`apps/api/src/routes/outfits.ts`) — this is the client half, so a
   * retired item never even appears to be pickable rather than being pickable
   * and then rejected on save.
   */
  const items = useMemo(() => wardrobeItems.filter((item) => !item.retired), [wardrobeItems]);

  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    normalisePreselection(preselectedItemIds),
  );
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  /**
   * The in-flight guard. A REF, not the `saving` state above, and the two are
   * not interchangeable.
   *
   * A double tap on the save button dispatches both presses before React can
   * re-render: the second press therefore sees the button's `disabled` prop
   * still `false` AND invokes the same `onSave` closure the first one did,
   * still holding `saving === false`. Both state-based defences miss it, and
   * two identical outfits are created — nothing downstream de-duplicates
   * them. A ref is written and read inside that one synchronous burst.
   *
   * Same reasoning, verbatim, as `inFlightRef` in `useWardrobe`. `saving`
   * remains as state because the spinner and the disabled button are a
   * render, and a ref does not cause one.
   */
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The light create shape, held as such deliberately. `PublicOutfitDetail`
  // (what `GET /outfits/:id` and `PATCH` answer with) has `items` and NO
  // `coverUrl`, and because `coverUrl` is optional an assignment between the
  // two compiles cleanly while silently dropping the cover. This state is only
  // ever written from `createOutfit`, which returns `PublicOutfit`.
  const [saved, setSaved] = useState<PublicOutfit | null>(null);

  /**
   * The `preselectedItemIds` value currently reflected in `selectedIds`.
   *
   * This is the standard "adjusting state when a prop changes" shape: state set
   * during render, which React applies by re-running this component
   * immediately, before anything is committed or any child renders. The
   * alternative — a `useEffect` — would commit one render holding the OLD
   * selection first, so the composer would flash the previous suggestion's
   * garments (and, for one frame, offer a Save button that would post them).
   *
   * The comparison is by value; see `preselectedItemIds` for why a reference
   * comparison would silently undo the user's taps under an inline array.
   */
  const [appliedPreselection, setAppliedPreselection] = useState(preselectedItemIds);
  if (!sameIds(appliedPreselection, preselectedItemIds)) {
    setAppliedPreselection(preselectedItemIds);
    // A REPLACEMENT, not a merge. The user asked to modify one proposed
    // outfit; folding it into whatever was selected before would build a
    // garment pile out of two suggestions.
    setSelectedIds(normalisePreselection(preselectedItemIds));
    // The previous outfit's verdict goes with it, for the same reason `toggle`
    // clears `saved`: both describe an outfit the user has finished with. This
    // is invisible in `add.tsx`, whose modes are alternatives and so unmount
    // this component between Modifies — but the sync exists precisely FOR a
    // host that keeps it mounted, and on that host a second Modify would
    // otherwise arrive with the previous outfit's "Saved" still on screen, or
    // with its save error still being offered as retryable.
    setSaved(null);
    setSaveError(null);
  }

  /**
   * id → 1-based position in the selection.
   *
   * DERIVED from `selectedIds` on every change, never accumulated. An
   * implementation that assigned a number when an item was picked would leave
   * c reading 3 after b was removed, which is the stale-ordinal defect. A Map
   * rather than `indexOf` per tile so a long grid is not quadratic.
   */
  const ordinals = useMemo(() => {
    const positions = new Map<string, number>();
    selectedIds.forEach((id, index) => positions.set(id, index + 1));
    return positions;
  }, [selectedIds]);

  const atLimit = selectedIds.length >= MAX_OUTFIT_ITEMS;

  const toggle = useCallback((id: string) => {
    // The previous save's confirmation describes an outfit that is now
    // finished; the user has moved on to composing the next one.
    setSaved(null);
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((selectedId) => selectedId !== id);
      // Refused rather than sent and rejected — see MAX_OUTFIT_ITEMS. The
      // reason is already on screen by the time this can happen, because the
      // notice renders at the limit rather than after it is exceeded.
      if (prev.length >= MAX_OUTFIT_ITEMS) return prev;
      return [...prev, id];
    });
  }, []);

  const onSave = useCallback(async () => {
    // Only the double-tap is guarded here. An empty selection is guarded by
    // the button's `disabled` prop alone and deliberately not repeated: the
    // same-frame race that defeats `disabled` needs two presses on the SAME
    // target, and "deselect the last item" and "press save" are two different
    // targets, so the state can never be stale in the way it is below.
    if (savingRef.current) return;
    savingRef.current = true;

    setSaving(true);
    onSavingChange?.(true);
    setSaveError(null);
    setSaved(null);
    // Captured before the await, so the success path can tell what it actually
    // sent from whatever the user has done since.
    const posted = selectedIds;
    const nameAtStart = name;

    try {
      const trimmed = nameAtStart.trim();
      const outfit = await createOutfit({
        token,
        // Omitted, never sent empty. The API's name schema trims and accepts
        // `''`, so a blank field would otherwise save an outfit whose name is
        // deliberately empty rather than one with no name at all — and an
        // unnamed outfit is valid (neither FR5 nor TC-07 mentions naming one).
        ...(trimmed === '' ? {} : { name: trimmed }),
        // The array itself, in selection order. Never re-derived from `items`:
        // that would post the wardrobe's order, not the user's.
        itemIds: posted,
      });
      // Only what was actually POSTed is cleared — not the whole selection.
      // The tiles stay tappable during a save, so a tap that lands while the
      // request is in flight is a choice the user made for the NEXT outfit,
      // and `setSelectedIds([])` would silently throw it away along with the
      // ids that really were saved. Same rule as the failure path: a
      // selection is only ever lost because the user removed it.
      setSelectedIds((prev) => prev.filter((id) => !posted.includes(id)));
      // The next outfit is a different outfit; leaving the name in the field
      // would make it the default for whatever is composed next. Guarded the
      // same way: a name typed DURING the save belongs to the next outfit.
      setName((prev) => (prev === nameAtStart ? '' : prev));
      setSaved(outfit);
      onSaved?.(outfit);
    } catch (err) {
      // The selection is deliberately NOT cleared, and the button is
      // deliberately left enabled: it is the retry.
      setSaveError(messageFor(err));
    } finally {
      savingRef.current = false;
      setSaving(false);
      onSavingChange?.(false);
    }
  }, [name, onSaved, onSavingChange, selectedIds, token]);

  // A full-list load with nothing renderable behind it — first mount, or a
  // category change, both of which clear `items`. A `refreshing` load keeps
  // its rows and must not blank the grid, or a selection the user can no
  // longer see is one they cannot correct.
  const showFirstPageSpinner = activity === 'loading' && items.length === 0;
  // A failed load is not an empty wardrobe. Without the `error === null` guard
  // this would tell a user whose request just failed that they own nothing.
  const showEmptyState = activity === 'idle' && items.length === 0 && error === null;

  return (
    <View style={styles.composer}>
      {/* Outside the list on purpose, exactly as on the wardrobe grid: the
          filter must stay reachable while the first page loads and while an
          error is showing, which it would not be behind a spinner as a
          ListHeaderComponent. */}
      <CategoryFilter value={category} onChange={setCategory} />

      {error !== null ? (
        <View testID="composer-wardrobe-error" style={styles.errorBanner}>
          {/* The message carries its own testID: the banner also contains the
              retry button's label, and RNTL's `toHaveTextContent` compares a
              string matcher by exact equality after normalisation, so reading
              the banner would mean loosening every assertion about this
              message to a substring regex. */}
          <Text testID="composer-wardrobe-error-message" style={styles.errorText}>
            {error}
          </Text>
          {/* `refresh`, never re-selecting the current chip: the hook's fetch
              effect keys on the category value, so `setCategory(current)` is a
              no-op and a retry built that way would silently do nothing. */}
          <Pressable
            testID="composer-wardrobe-retry"
            onPress={refresh}
            accessibilityRole="button"
            accessibilityLabel="Try loading your wardrobe again"
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {showFirstPageSpinner ? (
        <View testID="composer-loading" style={styles.centre}>
          <ActivityIndicator size="large" />
        </View>
      ) : (
        <FlatList
          testID="composer-grid"
          data={items}
          numColumns={3}
          keyExtractor={composerKeyExtractor}
          // `extraData` is what tells `VirtualizedList` that a cell's contents
          // depend on something other than its row of `data` — here, whether
          // the item is selected and at which position. Without it, memoised
          // cells keep their old ring and their old ordinal on a device.
          //
          // The PROP is asserted (`reads the selection through extraData`, via
          // the list's fiber). What is device-only is the EFFECT: this
          // renderer re-renders the whole tree on every state change, so cell
          // memoisation never bites here and no test can observe a stale cell.
          // Task 6 looks at that half.
          extraData={ordinals}
          renderItem={({ item }) => (
            <ItemTile
              item={item}
              onPress={toggle}
              // Always passed, even when false: its PRESENCE is what tells the
              // tile it is in a selection UI rather than the wardrobe grid, so
              // the tap hint says "adds to the outfit" instead of "opens this
              // item's details".
              selected={ordinals.has(item.id)}
              selectionIndex={ordinals.get(item.id)}
            />
          )}
          contentContainerStyle={styles.grid}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          refreshing={activity === 'refreshing'}
          onRefresh={refresh}
          ListEmptyComponent={
            showEmptyState ? (
              <View testID="composer-empty" style={styles.centre}>
                <Text style={styles.emptyTitle}>Nothing to build an outfit from yet</Text>
                <Text style={styles.emptyHint}>
                  {category === null
                    ? 'Add a few items from the Add tab first.'
                    : `No ${category} items — try another category.`}
                </Text>
              </View>
            ) : null
          }
          ListFooterComponent={
            activity === 'loadingMore' ? (
              <View testID="composer-loading-more" style={styles.footer}>
                <ActivityIndicator />
              </View>
            ) : null
          }
        />
      )}

      {/* The save bar is a SIBLING of the list, not a footer inside it, so the
          count and the button stay put while the grid scrolls — the count is
          the only feedback that a tap far up the grid registered. */}
      <View style={styles.saveBar}>
        <TextInput
          testID="outfit-name"
          value={name}
          onChangeText={setName}
          placeholder="Name this outfit (optional)"
          // The API rejects a longer name outright, and a rejected save is one
          // the user cannot fix by retrying — the only error this screen
          // cannot answer. Cheaper to make it unenterable.
          maxLength={MAX_OUTFIT_NAME_LENGTH}
          accessibilityLabel="Outfit name, optional"
          style={styles.nameInput}
        />

        <View style={styles.saveRow}>
          <Text testID="outfit-count" style={styles.count}>
            {`${selectedIds.length} selected`}
          </Text>
          <Pressable
            testID="outfit-save"
            onPress={onSave}
            // An outfit needs at least one item; `POST /outfits` rejects an
            // empty `itemIds`. Disabling says so before the press rather than
            // a round trip after it.
            disabled={selectedIds.length === 0 || saving}
            accessibilityRole="button"
            accessibilityLabel="Save this outfit"
            style={[
              styles.saveButton,
              (selectedIds.length === 0 || saving) && styles.saveButtonDisabled,
            ]}
          >
            {saving ? (
              <ActivityIndicator color={color.soft} />
            ) : (
              <Text style={[styles.saveButtonText, (selectedIds.length === 0 || saving) && styles.saveButtonTextDisabled]}>
                Save outfit
              </Text>
            )}
          </Pressable>
        </View>

        {atLimit ? (
          <Text testID="outfit-limit" style={styles.limit}>
            {`That's the most an outfit can hold (${MAX_OUTFIT_ITEMS}). Remove one to swap it.`}
          </Text>
        ) : null}

        {saveError !== null ? (
          <Text testID="outfit-save-error" style={styles.saveError}>
            {saveError}
          </Text>
        ) : null}

        {saved !== null ? (
          <View testID="outfit-saved" style={styles.savedRow}>
            {/* Read from the RESPONSE — `coverUrl` and `itemCount` are what the
                server actually stored, and the selection they describe has
                already been cleared. `coverUrl` is absent when the first item
                no longer resolves, which degrades to no picture rather than to
                a broken one. */}
            {saved.coverUrl !== undefined ? (
              <Image
                testID="outfit-saved-cover"
                source={{ uri: saved.coverUrl }}
                style={styles.savedCover}
                accessible={false}
              />
            ) : null}
            <Text style={styles.savedText}>
              {saved.name === undefined
                ? `Saved an outfit with ${saved.itemCount} ${saved.itemCount === 1 ? 'item' : 'items'}.`
                : `Saved "${saved.name}" with ${saved.itemCount} ${saved.itemCount === 1 ? 'item' : 'items'}.`}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  composer: { flex: 1 },
  // 12 here plus each tile's own 4 of padding gives the 16 the grid needs,
  // without a flex `gap` that a partial last row would spread.
  grid: { paddingHorizontal: space.md, paddingBottom: space.lg },
  centre: { paddingVertical: 48, alignItems: 'center', gap: 6 },
  emptyTitle: { ...text.title, fontSize: 16 },
  emptyHint: { ...text.meta, fontSize: 13.5, textAlign: 'center' },
  errorBanner: {
    marginHorizontal: space.gutter,
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
  saveBar: {
    padding: space.lg,
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.cloud,
    backgroundColor: color.shell,
  },
  nameInput: {
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.cloud,
    paddingVertical: 12,
    paddingHorizontal: 15,
    fontFamily: font.body,
    fontSize: 15,
    color: color.ink,
  },
  saveRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  count: { ...text.name, fontSize: 15 },
  saveButton: {
    backgroundColor: color.ink,
    borderRadius: radius.pill,
    paddingVertical: 14,
    paddingHorizontal: space.xxl,
    minWidth: 140,
    alignItems: 'center',
    justifyContent: 'center',
    // Held so the bar does not jump when the label becomes a spinner.
    minHeight: 50,
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
  saveButtonText: { ...text.button, fontSize: 16, color: color.onInk },
  limit: { ...text.body, fontSize: 13, color: color.washInk },
  saveError: { ...text.body, fontSize: 13.5, color: color.washInk },
  savedRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  savedCover: { width: 36, height: 36, borderRadius: 10, backgroundColor: color.cloud },
  savedText: { ...text.body, fontSize: 13.5, color: color.success, flexShrink: 1 },
});
