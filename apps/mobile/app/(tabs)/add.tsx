import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ITEM_CATEGORIES, type ItemCategory, type PublicClothingItem } from '@wardrobe/shared';
import { captureWithCamera, pickFromLibrary, type CapturedImage } from '../../src/images/capture';
import { compressForUpload } from '../../src/images/compress';
import { createThumbnail } from '../../src/images/thumbnail';
import { uploadItem, updateItemCategory } from '../../src/items/uploadItem';
import { useAuth } from '../../src/auth/AuthContext';
import { OutfitComposer } from '../../src/outfits/OutfitComposer';
import { markOutfitsDirty } from '../../src/outfits/outfitsDirty';
import { SuggestionCard, suggestionKeyExtractor } from '../../src/suggestions/SuggestionCard';
import { useSuggestions } from '../../src/suggestions/useSuggestions';
import { ApiClientError } from '../../src/api/client';
import { categoryLabel } from '../../src/format/text';
import { color, radius, space } from '../../src/theme/tokens';
import { font, text } from '../../src/theme/type';
import {
  Button,
  Chip,
  EmptyState,
  ErrorPlate,
  ScreenHeader,
  screen,
} from '../../src/theme/ui';

type CaptureSource = 'camera' | 'library';

/**
 * The three things this tab does: add one item (Stage 5, FR5 / TC-07), compose
 * an outfit by hand (the same), and read the outfits the engine proposes
 * (Stage 7, FR8 / TC-10).
 *
 * They are ALTERNATIVES, not three sections of one scrolling screen. The
 * composer and the suggestion list are both `FlatList`s, and React Native logs
 * "VirtualizedLists should never be nested inside plain ScrollViews with the
 * same orientation" when one is rendered inside a `ScrollView` — which would
 * break both this project's pristine-output rule and, on a device, the list's
 * own scrolling and windowing. Rendering one or the other is what keeps each
 * list at the top of its own scroll container.
 *
 * Suggestions live HERE rather than on a tab of their own because they are an
 * input to composing: the two verbs on a suggestion card are Save and Modify,
 * and Modify lands in the composer one chip away with its garments already
 * chosen. Splitting them across tabs would put a navigation between a proposal
 * and the edit of it.
 */
type AddMode = 'item' | 'outfit' | 'suggestion';

/**
 * What each mode chip says, what a screen reader hears instead, and the header
 * the screen wears while that mode is showing.
 *
 * The title changes with the mode because the three modes are three different
 * screens sharing a tab — "Add" over the suggestion list would be naming the
 * tab rather than what the user is looking at.
 */
const MODE_LABELS: Record<
  AddMode,
  { chip: string; accessibility: string; title: string; blurb: string }
> = {
  item: {
    chip: 'Add item',
    accessibility: 'Add a single item',
    title: 'Add a piece',
    blurb: "Snap it — we'll read the colour and file it",
  },
  outfit: {
    chip: 'Create outfit',
    accessibility: 'Create an outfit',
    title: 'Build an outfit',
    blurb: 'Pick the pieces that go together',
  },
  suggestion: {
    chip: 'Suggestions',
    accessibility: 'See outfit suggestions',
    title: 'Outfit ideas',
    blurb: 'Built from the colours in your own wardrobe',
  },
};

const ADD_MODES = ['item', 'outfit', 'suggestion'] as const;

// Below this, the model is guessing more than recognising. Measured on the
// committed fixture set: correct predictions clustered at 0.73-0.99, and the
// single miss sat at 0.72 - so a threshold here separates "probably right"
// from "worth a human glance" without crying wolf on every upload.
export const LOW_CONFIDENCE_THRESHOLD = 0.75;

interface SuggestionsPaneProps {
  /** Open one of a suggestion's garments. */
  onItemPress: (id: string) => void;
  /** "Modify" — hand these ids to the composer and switch to it. */
  onModify: (itemIds: string[]) => void;
  /** Reported per card: `true` when one starts saving, `false` when it settles. */
  onSavingChange: (saving: boolean) => void;
  /**
   * Whether ANY suggestion save is in flight — the same bit the mode chips are
   * disabled on, handed back down so each card's Modify can read it.
   *
   * It has to come from up here: a card's own guard is a `useRef` per instance
   * and cannot see a sibling, so without this a save on one card and a Modify
   * on another leaves the list mid-`POST`.
   */
  saving: boolean;
}

/**
 * The suggestion shortlist — FR8, and the half of TC-10 a person can see:
 * Phase 3's "Suggestions presented as complete outfit cards the user can save
 * or modify".
 *
 * A component of its own rather than a block inside `AddScreen` so that
 * `useSuggestions` — which fetches on mount — runs only while this mode is on
 * screen. Called at the top of `AddScreen` it would run the caller's whole
 * wardrobe through the rule engine, and sign a URL per returned item
 * server-side, every time somebody opened the Add tab to photograph a shirt.
 *
 * Every screen state is derived from the hook's axes rather than from one
 * field, and `unavailable` is a state in its own right — see below.
 */
function SuggestionsPane({
  onItemPress,
  onModify,
  onSavingChange,
  saving,
}: SuggestionsPaneProps) {
  const { snapshot, unavailable, activity, error, refresh } = useSuggestions();

  // `snapshot === null` is "not loaded yet", which is NOT the same as "loaded
  // and empty" — only the API can say which the user is looking at, which is
  // why the hook keeps them apart. Flattening it for rendering is safe
  // precisely because `showEmptyState` below re-consults `snapshot` itself.
  //
  // A suggestion with NO items is dropped rather than drawn. It would render a
  // card with zero thumbnails — which is not "a complete outfit card" — whose
  // Save posts `itemIds: []`, and `POST /outfits` answers that with a 400: the
  // one error class a card whose retry IS the button cannot recover from,
  // because pressing again produces the same 400 forever. It would also give
  // `suggestionKeyExtractor` an empty key, and two of them would collide on a
  // duplicate React key — loud in dev, SILENT in a release build, which is the
  // build it would actually happen in. Filtered here rather than inside the
  // card because the key is chosen out here, so a card returning `null` would
  // leave the collision in place.
  const suggestions = (snapshot?.suggestions ?? []).filter((each) => each.items.length > 0);
  const laundryNotice = snapshot?.laundryNotice ?? null;

  // A full load with nothing renderable behind it: first mount, or a token
  // change (both clear the snapshot). A `refreshing` load keeps the shortlist
  // on screen and must not blank it, or every retry flashes a spinner over
  // cards that are fine.
  const showFirstLoadSpinner = activity === 'loading' && suggestions.length === 0;

  /**
   * "The engine had nothing to propose from this wardrobe" — a real, successful
   * answer, and the ONLY state allowed to say so.
   *
   * `snapshot !== null` keeps "not loaded yet" out. `error === null` keeps
   * every failure out, and that conjunct is the one that matters most on this
   * screen: a failed request leaves the last good snapshot in place, so without
   * it a user whose retry just failed on an empty wardrobe would be told to add
   * items by a screen that had learned nothing.
   *
   * `!unavailable` is stated SEPARATELY even though the hook never sets
   * `unavailable` without also setting `error`. That is one `catch` block's
   * behaviour, not a property of the contract, and this screen would be relying
   * on it silently: widen or split that block and an outage starts rendering as
   * "add a few items first" — the exact sentence three tasks exist to keep off
   * this screen. Free insurance on the one claim that must not drift.
   */
  const showEmptyState =
    snapshot !== null && suggestions.length === 0 && error === null && !unavailable;

  return (
    <View style={styles.suggestions}>
      {/* `unavailable` is a REFINEMENT of `error` — it is never true while
          `error` is null — so these are one banner with two wordings rather
          than two banners that could both appear.

          The outage wording is this app's own and not the API's message,
          because it is the one sentence on this screen that must be
          load-bearing: `GET /suggestions` answers 503 with no `suggestions`
          key AT ALL, rather than an empty list, for the sole purpose of
          keeping "the engine is down" and "your wardrobe produced nothing"
          apart. Rendering an outage as the empty state would tell a user with
          a full wardrobe that none of it goes together, and would make three
          tasks of deliberate server-side design pointless. */}
      {unavailable ? (
        <ErrorPlate
          testID="suggestions-unavailable"
          messageTestID="suggestions-unavailable-message"
          retryTestID="suggestions-retry"
          message={
            'Outfit suggestions are temporarily unavailable. Nothing is wrong with your wardrobe — try again shortly.'
          }
          onRetry={refresh}
          retryAccessibilityLabel="Try loading your suggestions again"
        />
      ) : error !== null ? (
        // The message carries its own testID: the plate also contains the
        // retry button's label, and RNTL's `toHaveTextContent` compares a
        // string matcher by exact equality after normalisation, so reading
        // the plate would mean loosening every assertion about this message
        // to a substring regex.
        <ErrorPlate
          testID="suggestions-error"
          messageTestID="suggestions-error-message"
          retryTestID="suggestions-retry"
          message={error}
          onRetry={refresh}
          retryAccessibilityLabel="Try loading your suggestions again"
        />
      ) : null}

      {/* VERBATIM, and that is a constraint rather than laziness. The count
          behind this sentence is every in-laundry item in the wardrobe, NOT a
          number of suggestions that were withheld — a wardrobe of one shirt
          plus three in-laundry accessories answers an empty shortlist with
          `excludedInLaundry: 3`, and not one of those three could have produced
          a suggestion because there was no bottom to pair with. So nothing here
          may reword it into "3 suggestions were hidden" or interpolate it into
          a larger claim: each asserts a causation this number does not carry,
          and each is a sentence a user would act on by fetching laundry that
          would change nothing. `useSuggestions` withholds the raw integer for
          exactly this reason; `laundryNoticeFor` is where the wording lives. */}
      {laundryNotice !== null ? (
        <Text testID="suggestions-laundry-notice" style={styles.laundryNotice}>
          {laundryNotice}
        </Text>
      ) : null}

      {showFirstLoadSpinner ? (
        <View testID="suggestions-loading" style={styles.centre}>
          <ActivityIndicator size="large" color={color.soft} />
        </View>
      ) : (
        <FlatList
          testID="suggestions-list"
          data={suggestions}
          // A stable, content-derived id — never the index. See
          // `suggestionKeyExtractor`: this list only ever changes by
          // REPLACEMENT (the endpoint has no cursor at all), which is the one
          // case an index key gets wrong.
          keyExtractor={suggestionKeyExtractor}
          renderItem={({ item }) => (
            <SuggestionCard
              suggestion={item}
              onItemPress={onItemPress}
              onModify={onModify}
              // The gallery on the Favorites tab refetches on focus only when
              // the outfit list is known to have changed, and a suggestion
              // saved here is a create like any other — without this it does
              // not appear there at all until the user thinks to pull to
              // refresh. The same signal the composer's save uses, deliberately:
              // one bit, one reader. `markTrackingDirty` is NOT also sent,
              // because creating an outfit moves no `wearCount`, no
              // `lastWornAt` and no `laundryStatus` — marking the wardrobe grid
              // would throw away its scrolled pages to reload a list that did
              // not move.
              onSaved={markOutfitsDirty}
              onSavingChange={onSavingChange}
              // Every card learns that SOME card is saving. Its own ref only
              // knows about itself, so this is what stops a Modify on card 2
              // from unmounting this list while card 1's `POST` is in flight —
              // the same condition, from the same state, that disables the mode
              // chips below.
              blocked={saving}
            />
          )}
          contentContainerStyle={styles.list}
          // The hook's OWN axis, not a local flag: `refresh()` sets `activity`
          // to `'refreshing'` and leaves the shortlist on screen, so this is
          // the only thing that tells the user a pull actually started. Pinned
          // in both directions by a test — a hard-coded `false` leaves the
          // control silently dead, and `activity === 'loading'` would spin
          // during a first load, when this list is not even mounted.
          refreshing={activity === 'refreshing'}
          onRefresh={refresh}
          ListEmptyComponent={
            showEmptyState ? (
              // Names the fix. An empty state that does not say what to do is
              // a dead end — and this one is honest about the mechanism rather
              // than promising that any single item will help: the engine
              // pairs a top with a bottom, so one more shirt on its own
              // changes nothing.
              <EmptyState
                testID="suggestions-empty"
                title="No outfit suggestions yet"
                hint="Add a few items first — outfits are built by pairing a top with a bottom."
              />
            ) : null
          }
        />
      )}
    </View>
  );
}

export default function AddScreen() {
  const { token } = useAuth();
  const [image, setImage] = useState<CapturedImage | null>(null);
  const [category, setCategory] = useState<ItemCategory>(ITEM_CATEGORIES[0]);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The in-flight guard. A REF, and the `busy` STATE above is not a substitute
   * for it.
   *
   * A double tap dispatches both presses before React can re-render, so the
   * second press sees `add-save`'s `disabled` prop still `false` AND invokes
   * the same `onSave` closure the first one did, still holding
   * `busy === false`. Both state-based defences miss it, and the result is two
   * `POST /items`: two ClothingItem documents, two MinIO objects, two
   * identical tiles — and **no way to remove either**, because this API has no
   * `DELETE /items` (Stage 5 ruling 3). There is no idempotency key and
   * nothing de-duplicates downstream.
   *
   * Found by review of Stage 5 Task 4, which had already hit and fixed the
   * identical bug on the outfit composer's save button; the same reasoning is
   * stated at `inFlightRef` in `useWardrobe` and at `savingRef` in
   * `OutfitComposer`. `busy` remains as state because the spinner and the
   * disabled buttons are a render, and a ref does not cause one.
   */
  const busyRef = useRef(false);
  const [mode, setMode] = useState<AddMode>('item');
  /**
   * Whether the OUTFIT composer has a save in flight. Distinct from `busy`,
   * which is this screen's own item upload and knows nothing about the
   * composer — without this, switching modes mid-save would unmount the
   * composer, completing the POST with no feedback and the selection gone.
   */
  const [composerSaving, setComposerSaving] = useState(false);
  /**
   * How many SUGGESTION cards have a save in flight — a count, not a boolean.
   *
   * Distinct from `busy` and from `composerSaving` for the same reason those
   * two are distinct from each other: they are three different writes, and none
   * of them knows about the others.
   *
   * A count rather than a flag because there are many cards and each guards
   * itself, so two saves really can overlap — the user taps Save on one card
   * and, while it is in flight, on another. With a boolean the first card to
   * settle would report `false` and re-enable the mode chips while the second
   * `POST` was still running, which is precisely the state this flag exists to
   * prevent. Every card reports `true` exactly once and `false` exactly once,
   * from a `finally`, so the count returns to zero even when a save fails and
   * even if the card is unmounted while its request is in flight.
   */
  const [savingSuggestions, setSavingSuggestions] = useState(0);
  /**
   * The selection the composer should open holding, set by "Modify" on a
   * suggestion card and `undefined` for a composer opened from the chip row.
   *
   * Ids, not a richer model: the composer owns selection order and derives its
   * ordinals from it.
   */
  const [preselectedItemIds, setPreselectedItemIds] = useState<string[] | undefined>(undefined);
  // The item the server actually saved, kept around after a successful save
  // so the AI's guess (and any override of it) can be shown. Tagging runs
  // server-side during POST /items, so this is the earliest point the app
  // can know what the AI decided — see onSave's comment for why the screen
  // saves with the user's chosen category and offers a correction here,
  // rather than tagging in a separate round trip before the save.
  const [savedItem, setSavedItem] = useState<PublicClothingItem | null>(null);
  // Fix round 1: `PATCH /items/:id` deliberately only ever writes `category`
  // — `source` and `aiConfidence` are left as the server originally stored
  // them, on purpose (see items.ts's `patchItemSchema` comment: widening the
  // PATCH to also write `source: 'manual'` would make that field mean "who
  // last touched it" instead of "how was it tagged", and Stage 9 needs
  // `source: 'ai'` to survive an override so it can measure how often users
  // correct the AI). That means `savedItem` alone can't tell the UI whether
  // the *displayed* category is still the AI's word or the user's — this
  // flag is purely local, client-side state for that distinction.
  const [overridden, setOverridden] = useState(false);

  const router = useRouter();

  const openItem = useCallback(
    (id: string) => {
      // The same destination the wardrobe grid's tiles use. These thumbnails
      // are the app's real `ItemTile`, whose accessibility hint says "Opens
      // this item's details"; wiring them anywhere else — or nowhere — would
      // make that hint a lie.
      router.push(`/items/${id}`);
    },
    [router],
  );

  /**
   * Choosing a mode from the chip row.
   *
   * The preselection is cleared on the way in, and that is not tidying:
   * "Create outfit" from the chip row means a NEW outfit, and ids left behind
   * by an earlier Modify would silently seed it with a suggestion the user has
   * moved on from. Only `handleModify` sets them.
   */
  const selectMode = useCallback((next: AddMode) => {
    setPreselectedItemIds(undefined);
    setMode(next);
  }, []);

  /**
   * "Modify" on a suggestion card: open the composer holding that suggestion's
   * garments.
   *
   * The ids are `saveItemIds` — the set that was DISPLAYED — so the composer
   * opens holding the outfit the user was looking at rather than the one the
   * engine proposed. `useSuggestions` does not expose the engine's own list at
   * all, which is what makes that impossible to get wrong here.
   */
  const handleModify = useCallback((itemIds: string[]) => {
    setPreselectedItemIds(itemIds);
    setMode('outfit');
  }, []);

  const handleSuggestionSavingChange = useCallback((saving: boolean) => {
    setSavingSuggestions((count) => (saving ? count + 1 : count - 1));
  }, []);

  async function handleCapture(source: CaptureSource) {
    // Finding 1 (Task 7 fix round 1): without this guard, a capture started
    // mid-upload can land after the upload's `finally` already ran, and its
    // `setImage(null)` would silently discard the just-picked replacement
    // image out from under the user. The Pressables below are also disabled
    // while busy, but that alone doesn't stop this function from running if
    // a press already landed — so the guard belongs here too.
    //
    // Reads the REF rather than the state, for the same reason `onSave` does:
    // two fingers landing in one frame, on Save and on a capture button, would
    // both see a stale `busy === false`.
    if (busyRef.current) return;

    const result = source === 'camera' ? await captureWithCamera() : await pickFromLibrary();

    if (result.status === 'ok') {
      // A fresh pick supersedes whatever was on screen before, including
      // any AI tag (and its override UI) left over from a previous save.
      setImage(result.image);
      setError(null);
      setConfirmation(null);
      setSavedItem(null);
      setOverridden(false);
      return;
    }

    if (result.status === 'denied') {
      // The button was tapped and the picker never opened — silence here
      // would look exactly like a broken button, so this is the one status
      // that must produce visible feedback.
      setError(
        source === 'camera'
          ? 'Camera access is off. Enable it in Settings to take a photo.'
          : 'Photo library access is off. Enable it in Settings to choose a photo.',
      );
      return;
    }

    // status === 'cancelled': the user closed the picker on purpose.
    // Deliberately a no-op — a message here would be noise.
  }

  async function onSave() {
    if (!image || !token) return;
    // See `busyRef`: this is the only guard that survives a same-frame double
    // tap, and a double POST here is unrecoverable for the user.
    if (busyRef.current) return;
    busyRef.current = true;

    setBusy(true);
    setError(null);
    try {
      // TC-14: never upload the raw capture. Compression must run first, and
      // it's the compressed result's uri that goes to the server.
      const compressed = await compressForUpload(image);
      // FR4 / TC-06: the grid tile renders `thumbnailUrl`, and this is the
      // only place it can be produced -- the API deliberately does not decode
      // images (adding `sharp`, a native binary, to the API image was the
      // alternative). Generated from `image`, the original capture, rather
      // than from `compressed`, so the tile is not a re-encode of a
      // re-encode. Run after compression rather than concurrently with it:
      // both drive the same native image pipeline, and nothing here is
      // latency-critical enough to justify assuming it is safe to overlap.
      //
      // Best-effort, and deliberately not inside the outer try: a thumbnail
      // is an optimisation, not part of the item. Every other layer already
      // treats it as optional -- `POST /items` accepts a request with no
      // thumbnail part, `PublicClothingItem.thumbnailUrl` is optional,
      // `UploadItemParams.thumbnailUri` is optional, and the grid falls back
      // to `imageUrl` (which is also what every item uploaded before this
      // stage relies on). If this screen let a failure here reach the outer
      // catch, it would be the single layer turning an explicitly optional
      // feature into a hard prerequisite: the user would see "Something went
      // wrong" and lose the save entirely, over an image the server never
      // required. That failure is realistic rather than theoretical -- this
      // is the second full decode of the same original, so a low-memory
      // device is exactly where the manipulator gives up.
      //
      // Swallowed without logging on purpose: there is no log sink on a
      // device, and nothing else in this app writes to `console` (the API,
      // which does have somewhere for a log to go, is where fail-soft paths
      // log -- see `tagImage`). The visible consequence is a tile that falls
      // back to the full image, which is the documented fallback.
      let thumbnailUri: string | undefined;
      try {
        thumbnailUri = (await createThumbnail(image)).uri;
      } catch {
        thumbnailUri = undefined;
      }
      // Tagging happens server-side, during this single POST — the app has
      // no way to know the AI's guess beforehand, so there is no "pre-fill
      // the picker" version of this flow. Two honest designs exist: tag
      // before saving (a separate analyse round trip, doubling the network
      // cost and uploading the same bytes twice), or save with the user's
      // chosen category and offer a correction once the guess comes back.
      // This app does the latter: `category` here is a starting point, not
      // a promise, and `savedItem` below is what actually lets the user see
      // and fix what the AI decided.
      const created = await uploadItem({ uri: compressed.uri, thumbnailUri, category, token });
      setImage(null);
      setCategory(ITEM_CATEGORIES[0]);
      setConfirmation('Saved to your wardrobe.');
      setSavedItem(created);
      setOverridden(false);
    } catch (err) {
      // The image is intentionally NOT cleared here, so a failed save can be
      // retried without picking the photo again.
      setError(err instanceof ApiClientError ? err.message : 'Something went wrong');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function handleOverride(newCategory: ItemCategory) {
    if (!savedItem || !token) return;

    setError(null);
    try {
      // The displayed category updates from the server's response, not
      // optimistically from `newCategory` — if the PATCH fails, `savedItem`
      // is left exactly as it was, so the screen never claims a correction
      // was saved when it was not.
      const updated = await updateItemCategory({ id: savedItem.id, category: newCategory, token });
      setSavedItem(updated);
      // The user has now spoken for this item's category. The
      // low-confidence warning existed to prompt exactly this human check,
      // so it has served its purpose; continuing to say "Tagged as" would
      // misattribute the user's own correction to the AI.
      setOverridden(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Something went wrong');
    }
  }

  return (
    <SafeAreaView style={screen.root} edges={['top']}>
      <ScreenHeader
        title={MODE_LABELS[mode].title}
        hi={MODE_LABELS[mode].blurb}
        style={styles.header}
      />

      <View style={styles.modeRow}>
        {ADD_MODES.map((option) => (
          <Chip
            key={option}
            testID={`add-mode-${option}`}
            label={MODE_LABELS[option].chip}
            selected={mode === option}
            onPress={() => selectMode(option)}
            // Switching mid-save would unmount whichever part is working: an
            // item upload loses the confirmation, the AI's tag and the
            // override row the user is owed for it; an outfit save completes
            // its POST with no feedback and the selection gone; and a
            // suggestion card's save completes with the card gone, so the user
            // never learns whether the outfit they asked for exists.
            //
            // THREE flags because they are three different saves and none of
            // them can see the others — `busy` is this screen's own upload,
            // `composerSaving` is the composer's (reported through its
            // `onSavingChange`), and `savingSuggestions` counts the suggestion
            // cards' (reported the same way, one report per card).
            disabled={busy || composerSaving || savingSuggestions > 0}
            accessibilityLabel={MODE_LABELS[option].accessibility}
          />
        ))}
      </View>

      {mode === 'outfit' ? (
        // `onSaved` now has something to do, which it did not when this call
        // site was written. The gallery on the Favorites tab refetches on focus
        // only when the outfit list is known to have changed, and a create here
        // is one of the three things that changes it — without this, an outfit
        // composed on this tab does not appear in the gallery at all until the
        // user thinks to pull to refresh, which is precisely the half of TC-07
        // that reads "visible in outfit gallery".
        //
        // The composer already reports the save on screen, so this is not
        // feedback; it is the one bit the gallery cannot work out for itself.
        // `markOutfitsDirty` ignores the outfit it is handed, deliberately —
        // see `src/outfits/outfitsDirty.ts` for why one bit rather than a set
        // of ids.
        <OutfitComposer
          // Stage 7: set by "Modify" on a suggestion card, `undefined` when the
          // composer was opened from the chip row. The composer applies it
          // whenever its VALUE changes, not only at mount — see the prop's
          // comment for why `useState(initial)` is not the whole mechanism.
          preselectedItemIds={preselectedItemIds}
          onSavingChange={setComposerSaving}
          onSaved={markOutfitsDirty}
        />
      ) : mode === 'suggestion' ? (
        <SuggestionsPane
          onItemPress={openItem}
          onModify={handleModify}
          onSavingChange={handleSuggestionSavingChange}
          // The same expression the mode chips read below. Modify is the OTHER
          // way out of the suggestion list, so it has to be guarded on the same
          // condition — otherwise the chip guard is walked around by tapping
          // Modify on a different card.
          saving={savingSuggestions > 0}
        />
      ) : (
        <ScrollView testID="add-item-form" contentContainerStyle={styles.content}>
        <View style={styles.row}>
          <Button
            testID="add-camera"
            label="Take a photo"
            onPress={() => handleCapture('camera')}
            disabled={busy}
            style={styles.capture}
          />
          <Button
            testID="add-library"
            label="Choose from library"
            variant="ghost"
            onPress={() => handleCapture('library')}
            disabled={busy}
            style={styles.capture}
          />
        </View>

        {image ? <Image testID="add-preview" source={{ uri: image.uri }} style={styles.preview} /> : null}

        {/* Task 6, defect 2, carried forward from Stage 3 and found by
            LOOKING at a device screenshot rather than by any test
            (docs/verification/stage-3/04-override-changed-to-shirt.png):
            after a save this selector still read `tshirt` while the override
            row below read the category the item had actually saved as. Two
            category pickers on one screen, contradicting each other.

            This one is a control for the NEXT upload — `category` is the
            value `onSave` posts — and once a save has completed there is no
            next upload staged: the image is cleared and Save is disabled.
            So it is hidden until a new image is picked, at which point
            `handleCapture` clears `savedItem` and it returns, reset to the
            default by `onSave` above. `savedItem` is the gate rather than
            `confirmation` because it is the state that means "a save
            completed"; a failed save leaves it null on purpose, so the
            selector stays put and a retry can still change the category.

            The override row below is deliberately untouched — its copy was
            reviewed and fixed in Stage 3. */}
        {savedItem === null ? (
          <>
            <Text style={styles.sectionLabel}>What is it?</Text>
            <View style={styles.categories}>
              {ITEM_CATEGORIES.map((c) => (
                <Chip
                  key={c}
                  testID={`add-category-${c}`}
                  label={categoryLabel(c)}
                  // The wire spelling, so a screen reader says the same word
                  // the AI tag line and the filter row do.
                  accessibilityLabel={`Save this as ${c}`}
                  selected={category === c}
                  onPress={() => setCategory(c)}
                />
              ))}
            </View>
          </>
        ) : null}

        {error ? (
          <Text testID="add-error" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {confirmation ? (
          <Text testID="add-confirmation" style={styles.confirmation}>
            {confirmation}
          </Text>
        ) : null}

        {/* FR3: a screen that silently accepted the AI's category, or one
            that never showed it, would each satisfy only half of "manual
            and automated tagging". This section only renders for
            `source === 'ai'` — when tagging was unavailable and the item
            saved as 'manual', nothing here should look any different from
            before this task. */}
        {savedItem && savedItem.source === 'ai' ? (
          <View style={styles.aiTagSection}>
            <Text testID="add-ai-tag" style={styles.aiTagText}>
              {overridden ? 'Changed to ' : 'Tagged as '}
              <Text style={styles.aiTagCategory}>{savedItem.category}</Text>
            </Text>
            {/* Once the user has overridden, they have already done the
                checking this warning was asking for -- showing it about a
                category they just picked by hand would contradict the
                screen's own "Changed to" text right above it. */}
            {!overridden && savedItem.aiConfidence !== undefined && savedItem.aiConfidence < LOW_CONFIDENCE_THRESHOLD ? (
              <Text testID="add-low-confidence" style={styles.lowConfidence}>
                Not confident about this one — check it&apos;s right.
              </Text>
            ) : null}
            <Text style={styles.sectionLabel}>Not right? Tap the correct category:</Text>
            <View style={styles.categories}>
              {ITEM_CATEGORIES.map((c) => (
                <Chip
                  key={c}
                  testID={`add-override-${c}`}
                  label={categoryLabel(c)}
                  accessibilityLabel={`Change this to ${c}`}
                  selected={savedItem.category === c}
                  onPress={() => handleOverride(c)}
                />
              ))}
            </View>
          </View>
        ) : null}

        <Pressable
          testID="add-save"
          style={[styles.saveButton, (!image || busy) && styles.saveButtonDisabled]}
          onPress={onSave}
          disabled={!image || busy}
        >
          {busy ? (
            <ActivityIndicator color={color.soft} />
          ) : (
            <Text style={[styles.saveButtonText, (!image || busy) && styles.saveButtonTextDisabled]}>
              Save this piece
            </Text>
          )}
        </Pressable>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.shell },
  header: { paddingBottom: space.md },
  content: { paddingHorizontal: space.gutter, paddingBottom: space.xxl, gap: space.md },

  modeRow: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.gutter, paddingBottom: 18 },

  row: { flexDirection: 'row', gap: 10 },
  capture: { flex: 1, paddingHorizontal: space.md },
  preview: {
    width: '100%',
    height: 300,
    borderRadius: radius.hero,
    backgroundColor: color.cloud,
    marginTop: space.xs,
  },

  sectionLabel: { ...text.label, marginTop: space.sm },
  categories: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },

  // Errors and confirmations are sentences under the form rather than plates:
  // they answer a control the user just used and sit directly beneath it, where
  // a bordered box would read as a second, unrelated region.
  error: { ...text.body, fontSize: 13.5, color: color.washInk },
  confirmation: { ...text.body, fontSize: 13.5, color: color.success },

  aiTagSection: { gap: space.sm, marginTop: space.xs },
  aiTagText: { ...text.body, color: color.soft },
  aiTagCategory: { fontFamily: font.semibold, color: color.ink },
  lowConfidence: { ...text.body, fontSize: 13, color: color.washInk },

  saveButton: {
    backgroundColor: color.ink,
    borderRadius: radius.pill,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.sm,
    // Pinned so the button keeps its height when the label is swapped for a
    // spinner mid-save.
    minHeight: 52,
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
  saveButtonText: { ...text.button, color: color.onInk },

  suggestions: { flex: 1 },
  list: { paddingBottom: space.xxl },
  centre: { paddingVertical: 48, paddingHorizontal: space.xxl, alignItems: 'center', gap: 6 },
  laundryNotice: {
    ...text.meta,
    fontSize: 13,
    color: color.washInk,
    paddingHorizontal: space.gutter,
    paddingBottom: space.sm,
  },
});
