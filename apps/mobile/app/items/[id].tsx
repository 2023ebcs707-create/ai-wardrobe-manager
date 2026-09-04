import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { ItemColor, PublicClothingItem } from '@wardrobe/shared';
import { ApiClientError } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { formatDay } from '../../src/format/text';
import { markTrackingDirty } from '../../src/tracking/trackingDirty';
import { useLaundryStatus } from '../../src/tracking/useLaundryStatus';
import { fetchItem } from '../../src/wardrobe/api';
import Ionicons from '@expo/vector-icons/Ionicons';
import { categoryLabel } from '../../src/format/text';
import { color, radius, space } from '../../src/theme/tokens';
import { font, text } from '../../src/theme/type';
import { EmptyState, ErrorPlate, Glow, screen as screenStyles } from '../../src/theme/ui';

/**
 * The item detail screen — the third leg of FR4, which Phase 3 §5 records as
 * "fully validated -- grid display, category filtering, and item details are
 * functional."
 *
 * The item is fetched by id from `GET /items/:id` rather than read out of an
 * object handed over by navigation. That is a contract decision, not a style
 * one: a screen that can only be reached by carrying state is blank on a deep
 * link and blank after a reload, and Stage 5's outfit builder links straight
 * to `/items/:id`. `useWardrobe` never sees this request, so opening a detail
 * cannot disturb the grid behind it.
 *
 * ## The one thing this screen writes
 *
 * Stage 6 gave it the laundry toggle — FR7, and the action TC-09 names: "User
 * marks item as 'In Laundry'". This is the only place in the app that can
 * reach `PATCH /items/:id/laundry`, so without it Task 1's route and Task 3's
 * hook are both unreachable from the product and TC-09 is unsupported.
 *
 * It is still the ONLY write. `PATCH /items/:id` exists (Stage 3 uses it to
 * correct an AI category), but editing from this screen is not in FR4 and is
 * not claimed anywhere; adding it would be new surface with no document behind
 * it.
 */

/** Rendered state. Four cases, and "not found" is deliberately not folded into
 *  "error": a 404 here is the API's single answer to "no such item" *and* "not
 *  yours" (see `router.get('/:id')` in `apps/api/src/routes/items.ts`), so it
 *  is an ordinary, expected outcome with nothing to retry, whereas a network
 *  failure is a transient one with everything to retry. One state showing both
 *  would offer a "Try again" button that can never succeed. */
type DetailState =
  | { status: 'loading' }
  | { status: 'ready'; item: PublicClothingItem }
  | { status: 'notFound' }
  | { status: 'error'; message: string };

function messageFor(err: unknown): string {
  // ApiClientError messages are already written for a person to read.
  if (err instanceof ApiClientError) return err.message;
  return 'Something went wrong loading this item.';
}

/**
 * `formatDay` and `countLabel` moved to `src/format/text.ts` in Stage 6 Task 5.
 *
 * This screen had the only copy of the date formatter, written here because it
 * was the only screen showing a date. The wear-history rows on the Profile tab
 * show one too, and the argument that makes this function correct — local-time
 * getters, not UTC; assembled by hand, not through Hermes' cut-down `Intl` —
 * is written down once there rather than copied. A copy that quietly used the
 * UTC getters would render a different date for the same instant on another
 * screen and read as a data problem.
 */

/**
 * `{ name: 'navy', share: 0.55 }` → `navy 55%`; a colour with no usable share
 * → `navy`; a real but tiny cluster → `navy <1%`.
 *
 * The percentage is the point of showing colours at all. It is the TC-05
 * signal `packages/shared/src/items.ts` explains at length: a solid navy
 * garment measures 1.00, a two-tone stripe 0.55/0.45, a print ~0.37 across
 * three clusters. Without the share, all three read as "navy".
 *
 * **What counts as no measurement.** `share` is optional on `ItemColor` and
 * genuinely absent on every item stored before Stage 3 started persisting it,
 * so an unguarded `Math.round(share * 100)` renders `navy NaN%` and a bare
 * `${share}%` renders `navy undefined%`. But the guard has to be wider than
 * `!== undefined`, because nothing between the socket and here validates the
 * response — `apiRequest` ends in `return parsed as T`. `null` would multiply
 * to a confident, false `navy 0%`; `4` would render `navy 400%`; `-0.4`,
 * `navy -40%`. All four are the same defect — a value that is not a share
 * being printed as one — so all four take the same branch and print no
 * percentage at all. The accepted range is [0,1], the same interval
 * `apps/api/src/ai/tagClient.ts` validates the AI service's response against.
 *
 * **Why `<1%` rather than `0%`.** `services/ai/app/colour.py` clusters a
 * 100×100 downsample with no minimum-share filter, so any cluster smaller than
 * 50 pixels is a real, present colour whose share rounds to zero — a navy
 * jacket with a small white logo. Printing "white 0%" for it says the colour
 * is not there, which is exactly the confident falsehood the `null` branch
 * above exists to prevent; it would be odd to guard one and print the other.
 */
function colourLabel(colour: ItemColor): string {
  const { share } = colour;
  if (typeof share !== 'number' || !Number.isFinite(share) || share < 0 || share > 1) {
    return colour.name;
  }
  const percent = Math.round(share * 100);
  return `${colour.name} ${percent < 1 ? '<1' : percent}%`;
}

const LAUNDRY_LABELS: Record<PublicClothingItem['laundryStatus'], string> = {
  available: 'Available',
  in_laundry: 'In laundry',
};

/**
 * The stored enum is a database value, not a sentence: `in_laundry` is not
 * something to show a person.
 *
 * Typed as a total `Record` so that adding a member to `LaundryStatus` in the
 * shared package fails this build rather than this screen. The `??` covers
 * what the type system cannot: a status that only the *server* has heard of
 * still arrives typed as one of these two, because `apiRequest` ends in
 * `return parsed as T`. Without the fallback that renders an empty value and
 * an accessibility label reading "Laundry: undefined" — worse than showing the
 * raw word, which is at least true.
 */
function laundryLabel(status: PublicClothingItem['laundryStatus']): string {
  return LAUNDRY_LABELS[status] ?? String(status);
}

export default function ItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { token } = useAuth();
  const router = useRouter();

  const [state, setState] = useState<DetailState>({ status: 'loading' });
  // Bumped by "Try again". The fetch effect keys on it, which is what makes a
  // retry re-run a request whose inputs (id, token) have not changed.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // No id at all — a hand-typed or malformed deep link. The API answers
    // `/items/undefined` with a 404 anyway (the ObjectId shape check runs
    // first), so this is the same outcome without the round trip.
    if (!id) {
      setState({ status: 'notFound' });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });

    (async () => {
      try {
        const loaded = await fetchItem(id, token);
        if (!cancelled) setState({ status: 'ready', item: loaded });
      } catch (err) {
        if (cancelled) return;
        // 404 is its own state. `status` rather than `code` because a 404 whose
        // body is not a well-formed ApiErrorBody arrives as
        // `ApiClientError('UNKNOWN', 'Request failed (404)', 404)`, and that is
        // still an item that is not there.
        if (err instanceof ApiClientError && err.status === 404) {
          setState({ status: 'notFound' });
        } else {
          setState({ status: 'error', message: messageFor(err) });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, token, attempt]);

  /**
   * FR7 / TC-09's write. No optimistic update, deliberately — see
   * `useLaundryStatus`'s header: the response carries the updated item, so the
   * row and the button re-render from a fact rather than a guess, and a failed
   * transition cannot leave this screen claiming a state the wardrobe is not
   * in.
   */
  const { setStatus, pending: laundryPending, error: laundryError } = useLaundryStatus();

  /**
   * The in-flight guard for the toggle. A REF, not the hook's `laundryPending`
   * state, and the two are not interchangeable.
   *
   * A double tap dispatches both presses before React can re-render: the second
   * press sees the button's `disabled` prop still `false` AND invokes the same
   * closure the first one did, still holding `laundryPending === false`. Both
   * state-based defences miss it. Same reasoning, verbatim, as `renamingRef` in
   * `app/outfits/[id].tsx`, `savingRef` in `OutfitComposer` and `inFlightRef`
   * in `useGuardedMutation`.
   *
   * `useLaundryStatus` has a guard of its own and it is NOT a reason to skip
   * this one. Its header says so directly — a shared guard "is deliberately not
   * evidence that any particular caller uses it" — and the two protect
   * different things: the hook stops two requests, this stops this screen from
   * starting a second write it will then act on twice. What is at stake if
   * both are absent is not a wasted round trip: `PATCH /items/:id/laundry`
   * records EVERY transition including a no-op one, so a double tap appends a
   * phantom row to the transition log for a change the user made once, and
   * nothing in the system can remove it.
   */
  const togglingRef = useRef(false);

  const current = state.status === 'ready' ? state.item : null;

  const onToggleLaundry = useCallback(async () => {
    if (togglingRef.current) return;
    // Nothing loaded means no id to address and no status to invert. Not merely
    // a repeat of the render guard below: this closure can outlive the render
    // that made it.
    if (current === null) return;
    togglingRef.current = true;

    try {
      // The OPPOSITE of what is on screen, never a hard-coded 'in_laundry'.
      // This is the only control in the app that can bring a garment back out
      // of the wash; a one-way door here would make `available` unreachable.
      const next = current.laundryStatus === 'in_laundry' ? 'available' : 'in_laundry';
      const updated = await setStatus(current.id, next);
      // `null` is the hook's failure signal — it resolves rather than rejects
      // — and `laundryError` already carries a message for it. The item is
      // deliberately NOT touched: painting the attempted status over the row
      // would report a write that did not happen, and the next visit would
      // silently show the old one back with nothing to explain it.
      if (updated === null) return;

      setState({ status: 'ready', item: updated });
      // The wardrobe grid behind this screen is holding an item whose status
      // has just changed, and Profile's `itemsInLaundry` is now wrong. Neither
      // can see its own staleness, so this is the only place that can tell
      // them. See `src/tracking/trackingDirty.ts` for why it is one bit per
      // reader rather than the outfit gallery's single shared one.
      markTrackingDirty();
    } finally {
      togglingRef.current = false;
    }
  }, [current, setStatus]);

  const goBack = useCallback(() => {
    // The root Stack runs with `headerShown: false`, so this button is the
    // screen's only back affordance. Opened by a deep link this is the first
    // entry in the stack and `back()` has nothing to pop, which would leave
    // the user with no way out at all.
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  return (
    <SafeAreaView style={screenStyles.root} edges={['top']}>
      {/* THE SIGNATURE, at the one size where it can actually be seen: the top
          of the screen tinted by the garment the screen is about.

          FULL-BLEED, and behind everything including the back bar. Two earlier
          attempts are worth recording because both look reasonable in a
          stylesheet. A halo inset behind the photograph is entirely covered by
          it — the CSS mockup gets its spread from `filter: blur(34px)`, and
          React Native has no blur, so the same rectangle either hides or
          sticks out as a hard-edged block. Starting the wash at the top of the
          SCROLL content instead put a visible horizontal seam directly under
          the back chevron, because that bar is not inside the scroll view.

          From the top of the screen down, fading into `shell`, there is no
          edge anywhere: the sides reach the screen and the bottom dissolves.
          Which is what the blur was for.

          First child, so every sibling paints over it. */}
      {state.status === 'ready' ? (
        <View style={styles.heroGlow} pointerEvents="none">
          <Glow colors={state.item.colors} surface={color.shell} intensity={0.5} />
        </View>
      ) : null}

      <View style={styles.header}>
        <Pressable
          testID="item-detail-back"
          onPress={goBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          // A glyph alone is a 20pt tap target; the box around it is the hit
          // area, at the 44pt minimum.
          style={({ pressed }) => [styles.backButton, pressed ? styles.pressed : null]}
        >
          <Ionicons name="chevron-back" size={20} color={color.ink} />
        </Pressable>
      </View>

      {state.status === 'loading' ? (
        <View testID="item-detail-loading" style={styles.centre}>
          <ActivityIndicator size="large" color={color.soft} />
        </View>
      ) : null}

      {state.status === 'notFound' ? (
        // Deliberately vague about *why*. The API answers "no such item" and
        // "belongs to someone else" with the same 404 so that a status code
        // cannot confirm another user's item exists; saying "you do not own
        // this" here would leak exactly what that costs to avoid.
        <EmptyState
          testID="item-detail-not-found"
          title="Item not found"
          hint="It may have been deleted, or the link may be wrong."
          style={styles.centre}
        />
      ) : null}

      {state.status === 'error' ? (
        <ErrorPlate
          testID="item-detail-error"
          messageTestID="item-detail-error-message"
          retryTestID="item-detail-retry"
          message={state.message}
          onRetry={() => setAttempt((n) => n + 1)}
          retryAccessibilityLabel="Try loading this item again"
        />
      ) : null}

      {state.status === 'ready' ? (
        <ItemDetail
          item={state.item}
          onToggleLaundry={onToggleLaundry}
          laundryPending={laundryPending}
          laundryError={laundryError}
        />
      ) : null}
    </SafeAreaView>
  );
}

function ItemDetail({
  item,
  onToggleLaundry,
  laundryPending,
  laundryError,
}: {
  item: PublicClothingItem;
  onToggleLaundry: () => void;
  laundryPending: boolean;
  laundryError: string | null;
}) {
  // `thumbnailUrl` exists and is deliberately not used: this is the detail
  // screen, and the thumbnail is a 240px grid asset that would be visibly soft
  // at full width.
  const seasons = item.seasons.length > 0 ? item.seasons.join(', ') : 'Not recorded';

  // The user corrected the model. `source` cannot express this — it stays 'ai'
  // through a PATCH on purpose, because it records how the item was tagged
  // rather than who last touched it — so `aiCategory`, the category the model
  // itself assigned, is the only thing that can.
  const overridden = item.aiCategory !== undefined && item.aiCategory !== item.category;

  /**
   * A confidence is shown only when the model's category and the item's
   * category are the same word.
   *
   * `aiConfidence` is the model's certainty about `aiCategory`, and about
   * nothing else. Once the user corrects a shirt at 0.87 into a jacket, "AI
   * confidence 87%" beside "jacket" is a number that was never about jackets.
   * The condition is therefore equality, not `source === 'ai' && aiConfidence
   * !== undefined`, which is what an earlier revision used and which renders
   * exactly that falsehood.
   *
   * Note what this does to items stored before `aiCategory` existed: their
   * `aiCategory` is absent, so no confidence is shown even where one is
   * recorded. That is deliberate. Absent means "we do not know whether this
   * was corrected", and a confidence displayed on a maybe-corrected category
   * is the defect this guard exists for. Withholding a true number is the
   * cheaper error than asserting a false one.
   */
  const showConfidence = item.aiCategory === item.category && typeof item.aiConfidence === 'number';

  return (
    <ScrollView testID="item-detail-scroll" contentContainerStyle={styles.content}>
      <Image
        testID="item-detail-image"
        source={{ uri: item.imageUrl }}
        style={styles.image}
        resizeMode="cover"
        // The category heading below already names the garment; labelling the
        // image too would make a screen reader say it twice.
        accessible={false}
      />

      {/* `categoryLabel` writes the wire's `tshirt` as "T-shirt". This is the
          screen's own title, so it is the one place the word most needs to
          read as English rather than as a database value. */}
      <Text testID="item-detail-category" style={styles.title}>
        {categoryLabel(item.category)}
      </Text>

      <View testID="item-detail-colors" style={styles.colours}>
        {item.colors.length > 0 ? (
          item.colors.map((colour, index) => (
            <View
              // Colours are a fixed, ordered attribute of one item and never
              // reorder or page, so index is a legitimate key here — unlike the
              // wardrobe grid, where it would be a defect.
              key={`${colour.hex}-${index}`}
              style={styles.colourChip}
            >
              {/* Whether this square actually *reads* as navy is a pixel
                  property of a real screen that no test in this repo can see —
                  Task 7 photographs it. The colour name beside it is what
                  carries the information without one. */}
              <View
                testID={`item-detail-swatch-${index}`}
                style={[styles.swatch, { backgroundColor: colour.hex }]}
              />
              <Text testID={`item-detail-color-${index}`} style={styles.colourLabel}>
                {colourLabel(colour)}
              </Text>
            </View>
          ))
        ) : (
          <Text style={styles.value}>No colours recorded</Text>
        )}
      </View>

      <DetailRow testID="item-detail-seasons" label="Seasons" value={seasons} />
      <DetailRow
        testID="item-detail-source"
        label="Category from"
        value={item.source === 'ai' ? 'AI tagged' : 'Categorised by you'}
      />
      {/* A plain sentence rather than a label/value row, because that is what
          it is. "AI tagged" above stays true — the item *was* tagged by the
          model — and this says what happened afterwards, which is the part
          that explains why no confidence is shown. */}
      {overridden ? (
        <Text testID="item-detail-override" style={styles.note}>
          {`You changed this from ${item.aiCategory}.`}
        </Text>
      ) : null}
      {showConfidence ? (
        <DetailRow
          testID="item-detail-confidence"
          label="AI confidence"
          value={`${Math.round((item.aiConfidence as number) * 100)}%`}
        />
      ) : null}
      <DetailRow testID="item-detail-wear-count" label="Times worn" value={String(item.wearCount)} />
      {/* Conditional because `lastWornAt` is genuinely absent until an item
          has been worn — NOT because nothing writes it. That was true when
          this row was added and stopped being true in Task 1 of this stage:
          `POST /wear-history` fans a wear out to every member item, setting
          `lastWornAt` and incrementing `wearCount`. (The old wording said "no
          route sets it, so this row never renders", which the wear-log button
          on `app/outfits/[id].tsx` now contradicts — as does
          `src/tracking/trackingDirty.ts`, which exists to tell this screen
          that exactly these two fields have moved.)

          Rendering "Never worn" for the absent case instead of hiding the row
          would be a claim about a garment the wardrobe cannot actually make:
          absence means no wear has been RECORDED, and this app only started
          recording in Stage 6. */}
      {item.lastWornAt ? (
        <DetailRow testID="item-detail-last-worn" label="Last worn" value={formatDay(item.lastWornAt)} />
      ) : null}
      <DetailRow testID="item-detail-laundry" label="Laundry" value={laundryLabel(item.laundryStatus)} />

      {/* FR7 / TC-09. Directly under the row it changes, so the current state
          and the control that inverts it read as one thing.

          The label says what the press DOES rather than what the item IS — the
          row above already says that, and a toggle captioned with its present
          state is the classic ambiguity ("does 'In laundry' mean it is, or
          that pressing puts it there?"). */}
      <Pressable
        testID="item-laundry-toggle"
        onPress={onToggleLaundry}
        // The render signal, not the guard — see `togglingRef`. This stops a
        // SEQUENTIAL second press a frame later; the ref stops the same-frame
        // one. Neither replaces the other.
        disabled={laundryPending}
        accessibilityRole="button"
        accessibilityLabel={
          item.laundryStatus === 'in_laundry' ? 'Mark as available' : 'Mark as in laundry'
        }
        style={[styles.laundryButton, laundryPending && styles.laundryButtonDisabled]}
      >
        {laundryPending ? (
          <ActivityIndicator color={color.soft} />
        ) : (
          <Text style={styles.laundryButtonText}>
            {item.laundryStatus === 'in_laundry' ? 'Mark as available' : 'Mark as in laundry'}
          </Text>
        )}
      </Pressable>

      {laundryError !== null ? (
        <Text testID="item-laundry-error" style={styles.inlineError}>
          {laundryError}
        </Text>
      ) : null}

      <DetailRow testID="item-detail-created" label="Added" value={formatDay(item.createdAt)} />
    </ScrollView>
  );
}

/**
 * One label/value line.
 *
 * The testID goes on the *value*, not on the row. RNTL 14's
 * `toHaveTextContent` compares the whole subtree's text for exact equality
 * after normalisation, so a row-level id makes every assertion read
 * `LaundryIn laundry` — the label welded to the value with no separator. An id
 * on the value keeps assertions about the value.
 *
 * The row is one accessibility node so a screen reader announces
 * "Laundry: In laundry" rather than two orphaned fragments; `accessible` is
 * what makes that label take effect at all on Android.
 */
function DetailRow({ testID, label, value }: { testID: string; label: string; value: string }) {
  return (
    <View style={styles.row} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={styles.label}>{label}</Text>
      <Text testID={testID} style={styles.value}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', paddingHorizontal: space.md, paddingTop: space.sm },
  backButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: space.gutter, paddingBottom: 32, gap: space.xs },
  // A fixed aspect ratio rather than a measured height: the photo is whatever
  // shape the camera produced, and `cover` on a 4:3 box crops it consistently
  // instead of letting one portrait shot push the attributes off-screen.
  image: {
    marginTop: space.sm,
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: radius.hero,
    backgroundColor: color.cloud,
  },
  // No `textTransform: 'capitalize'` any more — `categoryLabel` writes the
  // word, so "tshirt" becomes "T-shirt" rather than "Tshirt".
  title: { ...text.display, paddingTop: space.lg },
  // Anchored to the screen, which has no horizontal padding, so plain zeros
  // reach both edges. Tall enough to clear the photograph and the title, so
  // the fade finishes on empty page rather than halfway through a word.
  heroGlow: { position: 'absolute', top: 0, left: 0, right: 0, height: 530 },
  // A wrapped row of lozenges rather than a stacked list: the shares are one
  // fact about one garment — "47% blue, 34% beige, 19% grey" — and stacking
  // them turns a composition into a table of three unrelated rows.
  colours: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 9,
    paddingTop: space.md,
    paddingBottom: space.sm,
  },
  colourChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: color.cloud,
    borderRadius: radius.pill,
    paddingVertical: 7,
    paddingHorizontal: 13,
  },
  swatch: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    // A white swatch on a pale chip would otherwise be invisible.
    borderColor: 'rgba(42, 41, 37, 0.25)',
  },
  colourLabel: { ...text.body, fontSize: 13, fontFamily: font.medium },
  note: { ...text.meta, fontFamily: font.displayItalic, fontSize: 13.5, paddingVertical: 10 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.cloud,
    gap: space.md,
  },
  label: { ...text.meta, fontSize: 13 },
  value: { ...text.name, fontSize: 15, flexShrink: 1, textAlign: 'right' },
  centre: { flex: 1, justifyContent: 'center' },
  laundryButton: {
    alignSelf: 'stretch',
    marginTop: space.xl,
    backgroundColor: color.ink,
    borderRadius: radius.pill,
    paddingVertical: 16,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
    // Held so the button keeps its height when its label becomes a spinner.
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
  laundryButtonDisabled: { backgroundColor: color.cloud },
  laundryButtonTextDisabled: { color: color.soft },
  laundryButtonText: { ...text.button, color: color.onInk },
  inlineError: { ...text.body, fontSize: 13.5, color: color.washInk, paddingTop: space.sm },
  pressed: { opacity: 0.72 },
});
