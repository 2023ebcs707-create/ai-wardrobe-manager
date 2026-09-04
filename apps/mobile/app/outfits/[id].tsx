import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  MAX_OCCASION_LENGTH,
  MAX_OUTFIT_NAME_LENGTH,
  type PublicClothingItem,
  type PublicOutfitDetail,
  type PublicWearEvent,
} from '@wardrobe/shared';
import { ApiClientError } from '../../src/api/client';
import { useAuth } from '../../src/auth/AuthContext';
import { ShareOutfitSheet } from '../../src/community/ShareOutfitSheet';
import type { DisplayPost } from '../../src/community/posts';
import { countLabel } from '../../src/format/text';
import { deleteOutfit, fetchOutfit, updateOutfit } from '../../src/outfits/api';
import { markOutfitsDirty } from '../../src/outfits/outfitsDirty';
import { UNNAMED_OUTFIT } from '../../src/outfits/OutfitCard';
import { markTrackingDirty } from '../../src/tracking/trackingDirty';
import { useLogWear } from '../../src/tracking/useLogWear';
import Ionicons from '@expo/vector-icons/Ionicons';
import { color, radius, space } from '../../src/theme/tokens';
import { font, text } from '../../src/theme/type';
import { Panel, Strip, screen as screenStyles } from '../../src/theme/ui';

/**
 * The green this screen's two success lines are written in — "Logged …" and
 * "Shared to the community feed."
 *
 * `color.success` now, not a local literal. It used to be Tailwind green-700,
 * chosen here because the green-600 the rest of the app used was 3.30:1 on
 * white and failed WCAG 1.4.3 at 14pt — and that fix deliberately stopped at
 * this file's two lines. There were five such literals across the app in the
 * end; they are one token now, and the alias stays only so the two call sites
 * below keep reading as a named idea rather than a colour.
 */
const SUCCESS_TEXT = color.success;

/**
 * One saved outfit: its items in order, its name, its count — and the only
 * place in this app where an outfit can be renamed, deleted, or **logged as
 * worn**.
 *
 * That matters more than it sounds. Tasks 1 and 2 built `PATCH /outfits/:id`
 * and `DELETE /outfits/:id`, and Phase 3 §5 claims users "can create, save,
 * edit, and delete outfits". Without this screen both endpoints are
 * unreachable from the product and the claim is unsupported.
 *
 * ## Why this fetches rather than receiving the outfit through navigation
 *
 * A screen that can only be reached by carrying state is blank on a deep link
 * and blank after a reload. `GET /outfits/:id` is also the *only* endpoint
 * that resolves the items — the gallery's `PublicOutfit` carries a cover and a
 * count and no items at all — so there is nothing to hand over that would
 * save the round trip. The gallery's `useOutfits` never sees this request, so
 * opening a detail cannot disturb the list behind it.
 *
 * ## Why this holds `PublicOutfitDetail` and never `PublicOutfit`
 *
 * `fetchOutfit` and `updateOutfit` both answer with `PublicOutfitDetail`:
 * resolved `items`, no `coverUrl`. `PublicOutfitDetail extends
 * Omit<PublicOutfit, 'coverUrl'>` and `coverUrl` is optional, so assigning one
 * to the other compiles cleanly and silently drops the cover — Task 3's
 * hand-off note names that as this task's realistic trap. Nothing on this
 * screen is ever handed to `OutfitCard`, and `OutfitCardProps.outfit` is
 * declared `PublicOutfit & { items?: never }` so that trying would be a build
 * failure rather than a placeholder appearing in the gallery after every edit.
 *
 * ## Logging a wear, and the timestamp this screen must never send
 *
 * Stage 6 added "Log wear" here — FR6, and the action TC-08 names. This is the
 * only place in the app that can reach `POST /wear-history`, so without it
 * Task 1's route, Task 3's hook and every analytic Task 5 renders are
 * unreachable from the product.
 *
 * **It sends no `wornAt`.** That is a client contract stated on
 * `PublicWearEvent.wornAt` in `@wardrobe/shared` and restated on
 * `LogWearOptions.wornAt` and `LogWearInput.wornAt`, and this screen is the
 * last place it can be violated: the layers below provably never manufacture a
 * timestamp, but nothing in them can stop a screen from computing
 * `new Date().toISOString()` and passing it in. `POST /wear-history` rejects a
 * future `wornAt` against a `now` it takes AFTER the request lands, with a
 * strict `>` and no skew tolerance — measured, a client clock 1ms ahead passes
 * and 5ms ahead is a 400 the user cannot act on. The tolerance a client
 * actually gets is one-way transit time and nothing more, so the failure is
 * INVISIBLE on a dev machine, where the emulator and the API share one clock,
 * and appears only in the field.
 *
 * Omitting the key removes the bet: the server stamps the instant the request
 * landed, which is what "now" means anyway. The occasion field is the only
 * thing the user can add, and it travels only when they typed one.
 *
 * ## Sharing this outfit to the community feed, and why the entry point is here
 *
 * FR9 / TC-11. This is the only screen in the app that holds one outfit and
 * every action on it — rename, delete, log a wear — so a share belongs with
 * them rather than as a fourth verb bolted onto a gallery cell. The gallery
 * cell is a cover, a name and a count inside a single `Pressable` that opens
 * this screen; a second control nested in it would be a publish action one
 * mis-tap away while scrolling a grid, and the caption composer would then have
 * to open over the gallery anyway.
 *
 * The composer itself is `src/community/ShareOutfitSheet.tsx`, which owns the
 * caption bound, the in-flight guard and the dirty mark. This screen owns two
 * things only: when the sheet is on screen, and what is said afterwards.
 *
 * ## Why delete uses `deleteOutfit` and not `useOutfits().remove`
 *
 * `remove` belongs to a *list*: it drops a row from the outfits a hook
 * instance is holding. Calling `useOutfits()` here would mount a second,
 * unrelated instance and fetch the whole gallery just to delete one row, and
 * the instance behind the gallery — a different one — would learn nothing
 * from it. What the gallery actually relies on is its `useFocusEffect`
 * refetch, which runs when this screen pops.
 */

/**
 * Rendered state. Four cases, and "not found" is deliberately not folded into
 * "error": a 404 is the API's single answer to "no such outfit" *and* "not
 * yours" (`GET /outfits/:id` in `apps/api/src/routes/outfits.ts` answers a
 * foreign resource with 404, not 403), so it is an ordinary, expected outcome
 * with nothing to retry — whereas a network failure is transient and has
 * everything to retry. One state showing both would offer a "Try again"
 * button that can never succeed.
 */
type DetailState =
  | { status: 'loading' }
  | { status: 'ready'; outfit: PublicOutfitDetail }
  | { status: 'notFound' }
  | { status: 'error'; message: string };

function messageFor(err: unknown, fallback: string): string {
  // `ApiClientError` messages are already written for a person to read: the
  // client turns a network failure into "Cannot reach the server…" and passes
  // the API's own message through otherwise. Anything else is a bug in this
  // app and its message is not fit to show anyone.
  if (err instanceof ApiClientError) return err.message;
  return fallback;
}

/**
 * `2 items are no longer available`, `1 item is no longer available`.
 *
 * The verb has to agree as well as the noun, which is why this is not
 * `${countLabel(n)} are no longer available`.
 */
function missingLabel(missing: number): string {
  return missing === 1
    ? '1 item is no longer available'
    : `${missing} items are no longer available`;
}

/**
 * `Logged Work fit — 3 items for brunch.`
 *
 * Every field is read from the EVENT the server answered with, never from what
 * this screen was holding when the button was pressed. That is the difference
 * between a confirmation and a decoration:
 *
 *  * `itemIds` is the outfit's composition AT THE MOMENT IT WAS WORN,
 *    snapshotted on write, and it is what the wear record will always say.
 *    Reading `outfit.itemCount` instead would report the composition this
 *    screen happens to be showing, which is a different number the moment the
 *    outfit is edited on another device.
 *  * `occasion` is what the API stored after its own trim, so a value it
 *    discarded as blank cannot be echoed back as if it were kept.
 *  * `outfitName` is absent both for an outfit that never had one and for one
 *    deleted between the write and the read; `UNNAMED_OUTFIT` is the same
 *    neutral placeholder the gallery uses, so the two cannot drift.
 *
 * No date. `wornAt` is on the event and deliberately not shown: the server
 * stamped it "now", which is the one fact the user already knows, so a
 * formatted timestamp beside a button the user has just pressed adds nothing.
 * (The older wording here argued that printing one would mean a SECOND date
 * formatter to keep in step with `app/items/[id].tsx`'s. That is no longer
 * true — Task 5 moved the one formatter to `src/format/text.ts` — and the
 * argument never needed it: the reason is that the date carries no
 * information, not that formatting it would be inconvenient.)
 */
function loggedLabel(event: PublicWearEvent): string {
  const name = event.outfitName ?? UNNAMED_OUTFIT;
  const occasion = event.occasion === undefined ? '' : ` for ${event.occasion}`;
  return `Logged ${name} — ${countLabel(event.itemIds.length)}${occasion}.`;
}

export default function OutfitDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { token } = useAuth();
  const router = useRouter();

  const [state, setState] = useState<DetailState>({ status: 'loading' });
  // Bumped by "Try again". The fetch effect keys on it, which is what makes a
  // retry re-run a request whose inputs (id, token) have not changed.
  const [attempt, setAttempt] = useState(0);

  /**
   * The rename field, as `null` until the user types.
   *
   * `null` means "show whatever the server currently holds", so a successful
   * rename needs no synchronising effect — it sets this back to `null` and the
   * field re-derives from the response. A plain `useState(outfit.name ?? '')`
   * could not work at all: the outfit is not loaded on the first render.
   */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  /**
   * The in-flight guard for the rename. A REF, not the `renaming` state, and
   * the two are not interchangeable.
   *
   * A double tap dispatches both presses before React can re-render: the
   * second press sees the button's `disabled` prop still `false` AND invokes
   * the same closure the first one did, still holding `renaming === false`.
   * Both state-based defences miss it. Same reasoning, verbatim, as
   * `savingRef` in `OutfitComposer` and `inFlightRef` in `useOutfits`.
   */
  const renamingRef = useRef(false);

  /**
   * Whether the caption composer is on screen, and the post it produced.
   *
   * Sharing one outfit twice is allowed — two captions are two posts, and the
   * API says nothing against it — so the composer can be re-opened after a
   * successful share. What is NOT allowed is a confirmation sitting under a
   * composer while a second caption is being typed, claiming a post is already
   * shared when the sentence is about the previous one. So opening the composer
   * clears it.
   *
   * The consequence, stated rather than glossed: opening the composer and then
   * cancelling leaves no confirmation on screen. That is the right trade — the
   * confirmation is a transient acknowledgement rather than a record, and the
   * post it described is in the feed either way — and it is pinned by
   * `re-opening the composer clears the previous confirmation`.
   *
   * The composer holds no state this screen can see, so dismissing it and
   * re-opening it starts from an empty caption. Nothing here tries to preserve
   * a draft.
   */
  const [composingShare, setComposingShare] = useState(false);
  const [shared, setShared] = useState<DisplayPost | null>(null);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  /**
   * The same guard for the delete, and it earns its keep harder here:
   * `DELETE /outfits/:id` is deliberately not idempotent-silent, so a second
   * delete of the same id answers 404 — which this screen reads as "already
   * gone" and would act on by navigating away from a request that had not
   * finished.
   */
  const deletingRef = useRef(false);

  /**
   * FR6 / TC-08's write, plus the free-text occasion the API accepts.
   *
   * `pending` and `error` come from the hook — its `error` channel is not
   * shared with anything else on this screen, deliberately: `useLogWear` is
   * separate from `useWearHistory` precisely so a history load failing in the
   * background cannot erase the message a failed wear just wrote.
   */
  const { logWear, pending: logging, error: logError } = useLogWear();
  const [occasion, setOccasion] = useState('');
  const [logged, setLogged] = useState<PublicWearEvent | null>(null);
  /**
   * The in-flight guard for the wear. A REF, and the third one on this screen
   * for the third time for the same reason: a double tap dispatches both
   * presses before React can re-render, so the second sees `disabled` still
   * `false` and the same closure still holding `logging === false`.
   *
   * `useLogWear` has a guard of its own and it is NOT a reason to skip this
   * one — `useGuardedMutation`'s header says a shared guard "is deliberately
   * not evidence that any particular caller uses it". What is at stake is not
   * a wasted round trip: `POST /wear-history` is not idempotent in any sense,
   * and a second request writes a second event AND increments every member
   * item's `wearCount` a second time, corrupting the exact number "most worn"
   * ranks on, with no endpoint in this system able to undo it.
   */
  const loggingRef = useRef(false);

  useEffect(() => {
    // No id at all — a hand-typed or malformed deep link. The API answers
    // `/outfits/undefined` with a 404 anyway (the ObjectId shape check runs
    // first), so this is the same outcome without the round trip.
    if (!id) {
      setState({ status: 'notFound' });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });

    (async () => {
      try {
        const loaded = await fetchOutfit(id, token);
        if (!cancelled) setState({ status: 'ready', outfit: loaded });
      } catch (err) {
        if (cancelled) return;
        // `status` rather than `code`, because a 404 whose body is not a
        // well-formed ApiErrorBody arrives as
        // `ApiClientError('UNKNOWN', 'Request failed (404)', 404)` — and that
        // is still an outfit that is not there.
        if (err instanceof ApiClientError && err.status === 404) {
          setState({ status: 'notFound' });
        } else {
          setState({
            status: 'error',
            message: messageFor(err, 'Something went wrong loading this outfit.'),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, token, attempt]);

  const goBack = useCallback(() => {
    // The root Stack runs with `headerShown: false`, so the header button below
    // is this screen's only back affordance. Opened by a deep link this is the
    // first entry in the stack and `back()` has nothing to pop, which would
    // leave the user with no way out at all — and, after a delete, stranded on
    // an outfit whose every control now 404s.
    if (router.canGoBack()) router.back();
    else router.replace('/favorites');
  }, [router]);

  const outfit = state.status === 'ready' ? state.outfit : null;
  const currentName = outfit?.name ?? '';
  const fieldValue = nameDraft ?? currentName;
  // Trimmed on both sides of the comparison, because the API trims too: a name
  // padded with spaces is the same name, and sending it would be a write that
  // changes nothing and then reports success.
  const trimmedDraft = fieldValue.trim();
  const canRename = outfit !== null && !renaming && trimmedDraft !== currentName;

  const onRename = useCallback(async () => {
    if (renamingRef.current) return;
    // Not merely a repeat of the button's `disabled` prop: `disabled` is a
    // render, and this is the guard that holds inside one synchronous burst of
    // presses. It also covers the "nothing changed" case, which `updateOutfit`
    // would happily send — its own short-circuit only refuses a patch with
    // NEITHER key.
    if (!canRename || outfit === null) return;
    renamingRef.current = true;
    setRenaming(true);
    setRenameError(null);

    try {
      const patched = await updateOutfit(outfit.id, {
        token,
        // `name` only. `itemIds` on a PATCH is a full REPLACEMENT rather than a
        // delta, so sending the items back on a rename would make every rename
        // a rewrite of the outfit's contents — harmless right up until the two
        // disagree, which is exactly when it matters.
        //
        // `''` is meaningful and is sent: it CLEARS the name, where omitting
        // the key would leave it alone. A cleared name is how an outfit becomes
        // unnamed again, and unnamed is a valid outfit.
        name: trimmedDraft,
      });
      // Re-rendered from the response, which is the whole detail shape — items
      // included — so no follow-up read is needed and nothing on screen can
      // disagree with what the server stored.
      setState({ status: 'ready', outfit: patched });
      // Back to "show what the server holds".
      setNameDraft(null);
      // The gallery behind this screen is holding the OLD name. It has no way
      // to know that, so this is the only place that can tell it. See
      // `src/outfits/outfitsDirty.ts`.
      markOutfitsDirty();
      // And the Profile tab, ALONE — for exactly the reason the delete path
      // below gives, which applies verbatim to a rename and was missed here
      // first. `GET /wear-history` resolves `outfitName` from the live Outfit
      // document at READ time (`apps/api/src/routes/wearHistory.ts`,
      // `outfitNames()`), so a rename invalidates every history row pointing
      // at this outfit exactly as a delete does: the row keeps saying "Friday
      // best" for an outfit now called something else, and the focus gate
      // never fires because nothing told it anything happened.
      //
      // Not the wardrobe grid: a rename touches no item, so marking it would
      // discard the user's scrolled pages to reload a list that did not move.
      //
      // `'calendar'` for the same reason as `'profile'`, everywhere the two
      // appear together below: both screens render `GET /wear-history`, so
      // anything that changes how a past wear reads back is stale on both.
      markTrackingDirty(['profile', 'calendar']);
    } catch (err) {
      // A 404 means the outfit is gone — deleted from another device, or never
      // the caller's, since a foreign resource answers 404 rather than 403 —
      // and it is NOT a retryable error. Left in the branch below it produced
      // exactly what this file's own `DetailState` comment says must never
      // happen: red text reading "Outfit not found" UNDER a heading naming the
      // outfit, beside a Save button that stays enabled and can never succeed.
      // The fetch path and the delete path both treat 404 as its own outcome;
      // this is the third.
      if (err instanceof ApiClientError && err.status === 404) {
        setState({ status: 'notFound' });
        // The gallery is holding a row for something the server says is not
        // there. Same reasoning as the success path, for the opposite reason.
        markOutfitsDirty();
        // The outfit is gone, so its history rows read back nameless — the
        // same state a delete leaves behind, reached through a different door.
        markTrackingDirty(['profile', 'calendar']);
        return;
      }
      // Everything else: the outfit state is deliberately NOT touched. Painting
      // the attempted name over the heading would report a write that did not
      // happen, and the next visit would silently show the old name back with
      // nothing to explain it. The typed name stays in the field, because the
      // button is the retry.
      setRenameError(messageFor(err, 'Something went wrong renaming this outfit.'));
    } finally {
      renamingRef.current = false;
      setRenaming(false);
    }
  }, [canRename, outfit, token, trimmedDraft]);

  const onLogWear = useCallback(async () => {
    if (loggingRef.current) return;
    if (outfit === null) return;
    loggingRef.current = true;
    setLogged(null);

    // Captured before the await, so the success path can tell what it actually
    // sent from whatever the user has typed since.
    const sent = occasion.trim();

    try {
      const event = await logWear({
        outfitId: outfit.id,
        // **NO `wornAt`.** Read the section on this in the file header before
        // adding one. There is no clock read on this screen and there must
        // never be: the server stamps the instant the request landed, and a
        // timestamp from here is a bet that the handset's clock is not ahead
        // of the API's by even a few milliseconds — a bet that is always won
        // on a dev machine and lost in the field.
        //
        // Trimmed and OMITTED when blank rather than sent as `''`. The API
        // treats a blank occasion as absent, so an empty string would be a key
        // that means nothing travelling on every wear; and the trim happens
        // here as well as there because `MAX_OCCASION_LENGTH` is applied AFTER
        // trimming, so 64 characters of padding is a 60-character occasion.
        ...(sent === '' ? {} : { occasion: sent }),
      });
      // `null` is the hook's failure signal — it resolves rather than rejects
      // — and `logError` already carries a message for it. Nothing was
      // written, so nothing below this line should run.
      if (event === null) return;

      setLogged(event);
      // The next wear of this outfit is a different wear; leaving "brunch" in
      // the field would make it the silent default for whatever is logged
      // next. Guarded the same way `OutfitComposer` guards its name field: an
      // occasion typed DURING the request belongs to that next wear.
      setOccasion((prev) => (prev === sent ? '' : prev));
      // Every member item's `wearCount` and `lastWornAt` have just changed,
      // and Profile's analytics are ranked on exactly those fields. See
      // `src/tracking/trackingDirty.ts`.
      //
      // `markOutfitsDirty()` is deliberately NOT called: logging a wear
      // changes no outfit, and marking the gallery would throw away every page
      // the user had scrolled to in order to reload a list that is unchanged.
      markTrackingDirty();
    } finally {
      loggingRef.current = false;
    }
  }, [logWear, occasion, outfit]);

  const onShared = useCallback((post: DisplayPost) => {
    // The composer's job is done, and a composer left on screen with a caption
    // still in it invites a second post of the same outfit by accident.
    setComposingShare(false);
    // The RESPONSE, not what was typed. `missingItemsNotice` below is worded by
    // the data layer over the post the server actually stored, so the sentence
    // describes the post that exists rather than the request that was sent.
    //
    // The feed's dirty flag is NOT set here. `ShareOutfitSheet` marks `'feed'`
    // itself, immediately after the write and before it calls this, so no host
    // of that component can forget it — see the comment at that line.
    setShared(post);
  }, []);

  const onConfirmDelete = useCallback(async () => {
    if (deletingRef.current) return;
    if (outfit === null) return;
    deletingRef.current = true;
    setDeleting(true);
    setDeleteError(null);

    try {
      await deleteOutfit(outfit.id, token);
      // Before navigating, so the gallery this pops back to reloads instead of
      // showing the deleted card for the length of a round trip.
      markOutfitsDirty();
      // And the Profile tab, ALONE. Ruling 3: the wear events survive the
      // outfit, but their name does not — `GET /wear-history` resolves
      // `outfitName` at read time, so every past wear of this outfit reads
      // back nameless from now on and the history list is holding the old one.
      // The wardrobe grid is deliberately excluded: deleting an outfit touches
      // no item, so marking it would discard the user's scrolled pages to
      // reload a list that did not move.
      markTrackingDirty(['profile', 'calendar']);
      goBack();
    } catch (err) {
      // A 404 is the one answer that means "it is not there" — deleted from
      // another device, or never the caller's, since a foreign resource
      // answers 404 rather than 403. Either way the outcome is the one the user
      // asked for. Treating it as a failure strands them on an outfit that can
      // never be deleted, because every retry answers 404 too. Same rule as
      // `isAlreadyGone` in `useOutfits`.
      if (err instanceof ApiClientError && err.status === 404) {
        markOutfitsDirty();
        // The outfit is gone either way, so the history rows pointing at it
        // read back nameless either way.
        markTrackingDirty(['profile', 'calendar']);
        goBack();
        return;
      }
      // The prompt stays armed: the confirm button is the retry.
      setDeleteError(messageFor(err, 'Something went wrong deleting this outfit.'));
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }, [goBack, outfit, token]);

  return (
    <SafeAreaView style={screenStyles.root} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          testID="outfit-detail-back"
          onPress={goBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          // Text alone is a 16pt tap target; the padding is the hit area.
          style={styles.backButton}
        >
          <Ionicons name="chevron-back" size={20} color={color.ink} />
        </Pressable>
      </View>

      {state.status === 'loading' ? (
        <View testID="outfit-detail-loading" style={styles.centre}>
          <ActivityIndicator size="large" />
        </View>
      ) : null}

      {state.status === 'notFound' ? (
        <View testID="outfit-detail-not-found" style={styles.centre}>
          <Text style={styles.stateTitle}>Outfit not found</Text>
          {/* Deliberately vague about *why*. The API answers "no such outfit"
              and "belongs to someone else" with the same 404 so that a status
              code cannot confirm another user's outfit exists; saying "you do
              not own this" here would leak exactly what that costs to avoid. */}
          <Text style={styles.stateHint}>It may have been deleted, or the link may be wrong.</Text>
        </View>
      ) : null}

      {state.status === 'error' ? (
        <View testID="outfit-detail-error" style={styles.errorBanner}>
          <Text testID="outfit-detail-error-message" style={styles.errorText}>
            {state.message}
          </Text>
          <Pressable
            testID="outfit-detail-retry"
            onPress={() => setAttempt((n) => n + 1)}
            accessibilityRole="button"
            accessibilityLabel="Try loading this outfit again"
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {outfit !== null ? (
        <ScrollView testID="outfit-detail-scroll" contentContainerStyle={styles.content}>
          <Text testID="outfit-detail-name" style={styles.title}>
            {outfit.name ?? UNNAMED_OUTFIT}
          </Text>
          {/* `itemCount` counts the ids the outfit REFERENCES, not the items
              that resolved — `outfitBase` sets `itemCount: itemIds.length`
              deliberately. That is what makes the missing-items notice below
              legible: "3 items" with two rows on screen and a line saying one
              is gone. */}
          <Text testID="outfit-detail-count" style={styles.count}>
            {countLabel(outfit.itemCount)}
          </Text>

          {/* Said plainly rather than left for the user to notice. The API
              returns `items` AND `itemIds` precisely so a client can tell that
              something did not resolve; rendering only `items` would show a
              two-item outfit where the user saved three and say nothing about
              it. There is no cascade delete in this system, so today this is
              only reachable by a direct database deletion — the tolerance
              exists so that degrades the screen instead of 500ing it. */}
          {outfit.items.length < outfit.itemIds.length ? (
            <Text testID="outfit-detail-missing" style={styles.missing}>
              {missingLabel(outfit.itemIds.length - outfit.items.length)}
            </Text>
          ) : null}

          {/* The outfit AS AN OUTFIT — every garment at once, lit by the
              colours they share. The rows below say what is in it; this says
              what it looks like, which is the question somebody opens a saved
              outfit to answer.

              Absent rather than empty when nothing resolved: a glowing panel
              with no photographs in it would be a frame around the fact that
              the garments are gone, and the notice above already says so. */}
          {outfit.items.length > 0 ? (
            <Panel
              testID="outfit-detail-hero"
              style={styles.hero}
              glow={outfit.items.flatMap((each) => each.colors)}
            >
              <Strip uris={outfit.items.map((each) => each.thumbnailUrl ?? each.imageUrl)} />
            </Panel>
          ) : null}

          <Text style={styles.sectionLabel}>What's in it</Text>
          <View testID="outfit-detail-items" style={styles.items}>
            {outfit.items.map((each, index) => (
              <OutfitItemRow key={each.id} item={each} position={index + 1} />
            ))}
          </View>

          {/* FR6 / TC-08. Above the rename and delete controls because it is
              the thing a user opens a saved outfit to do; renaming it is
              housekeeping. */}
          <View style={styles.wearBlock}>
            <Text style={styles.sectionLabel}>Wear</Text>
            <TextInput
              testID="outfit-occasion-input"
              value={occasion}
              onChangeText={setOccasion}
              placeholder="What for? (optional)"
              // From `@wardrobe/shared`, never a literal. The API rejects a
              // longer occasion outright and a rejected wear is one the user
              // cannot fix by retrying, so a client enforcing a different
              // number either lets them type their way into a 400 or refuses
              // input the API would have accepted.
              maxLength={MAX_OCCASION_LENGTH}
              accessibilityLabel="Occasion, optional"
              editable={!logging}
              style={styles.nameInput}
            />
            <Pressable
              testID="outfit-log-wear"
              onPress={onLogWear}
              // The render signal, not the guard — see `loggingRef`. This
              // stops a SEQUENTIAL second press a frame later; the ref stops
              // the same-frame one.
              disabled={logging}
              accessibilityRole="button"
              accessibilityLabel="Log that you wore this outfit"
              style={[styles.primaryButton, logging && styles.primaryButtonDisabled]}
            >
              {logging ? (
                <ActivityIndicator color={color.soft} />
              ) : (
                <Text style={[styles.primaryButtonText, logging && styles.primaryButtonTextDisabled]}>
                  Log wear
                </Text>
              )}
            </Pressable>
            {logError !== null ? (
              <Text testID="outfit-log-wear-error" style={styles.inlineError}>
                {logError}
              </Text>
            ) : null}
            {logged !== null ? (
              <Text testID="outfit-log-wear-done" style={styles.loggedText}>
                {loggedLabel(logged)}
              </Text>
            ) : null}
          </View>

          {/* FR9 / TC-11. Below "Wear" because logging a wear is the thing a
              user opens a saved outfit to do; above the rename and delete
              controls because those are housekeeping. */}
          <View style={styles.shareBlock}>
            <Text style={styles.sectionLabel}>Community</Text>
            {composingShare ? (
              <ShareOutfitSheet
                // `outfit.id`, never the `id` route param. They agree on every
                // path that reaches here — the outfit was loaded BY that param
                // — and this one is the id the server confirmed exists and
                // belongs to this user.
                outfitId={outfit.id}
                onShared={onShared}
                onCancel={() => setComposingShare(false)}
              />
            ) : (
              <Pressable
                testID="outfit-share"
                onPress={() => {
                  // The previous confirmation describes a post that is now
                  // finished, and the user is composing the next one — see the
                  // note at `composingShare` for what this costs and why it is
                  // the right way round.
                  setShared(null);
                  setComposingShare(true);
                }}
                accessibilityRole="button"
                accessibilityLabel="Share this outfit to the community feed"
                accessibilityHint="Opens a caption box"
                style={styles.shareButton}
              >
                <Text style={styles.shareButtonText}>Share to community</Text>
              </Pressable>
            )}

            {shared !== null ? (
              <View testID="outfit-share-done" style={styles.sharedBlock}>
                <Text testID="outfit-share-done-text" style={styles.sharedText}>
                  Shared to the community feed.
                </Text>
                {shared.missingItemsNotice === null ? null : (
                  // VERBATIM. The data layer words this sentence over DISTINCT
                  // ids and states a fact about the post while asserting no
                  // cause; nothing here rewords it, wraps a larger claim around
                  // it, or derives a number back out of it. It is worth saying
                  // at all because the post has just gone PUBLIC missing some
                  // of the garments the outfit above still lists.
                  <Text testID="outfit-share-missing" style={styles.sharedNotice}>
                    {shared.missingItemsNotice}
                  </Text>
                )}
              </View>
            ) : null}
          </View>

          <View style={styles.editBlock}>
            <Text style={styles.sectionLabel}>Name</Text>
            <TextInput
              testID="outfit-name-input"
              value={fieldValue}
              onChangeText={setNameDraft}
              placeholder="Name this outfit (optional)"
              // The API rejects a longer name outright (`z.string().trim().max(80)`)
              // and a rejected rename is one the user cannot fix by retrying.
              // Cheaper to make it unenterable.
              maxLength={MAX_OUTFIT_NAME_LENGTH}
              accessibilityLabel="Outfit name, optional"
              editable={!renaming}
              style={styles.nameInput}
            />
            <Pressable
              testID="outfit-rename"
              onPress={onRename}
              disabled={!canRename}
              accessibilityRole="button"
              accessibilityLabel="Save this outfit's name"
              style={[styles.primaryButton, !canRename && styles.primaryButtonDisabled]}
            >
              {renaming ? (
                <ActivityIndicator color={color.soft} />
              ) : (
                <Text style={[styles.primaryButtonText, !canRename && styles.primaryButtonTextDisabled]}>
                  Save name
                </Text>
              )}
            </Pressable>
            {renameError !== null ? (
              <Text testID="outfit-rename-error" style={styles.inlineError}>
                {renameError}
              </Text>
            ) : null}
          </View>

          {/* The confirmation is INLINE, and that is a requirement rather than
              a style choice. `Alert.alert` opens a blocking native modal that
              no test can see or dismiss, and it would stall the device gate
              behind a dialog nothing can press. Two rendered buttons are also
              the only version a screen reader can walk. */}
          <View style={styles.deleteBlock}>
            {confirmingDelete ? (
              <View testID="outfit-delete-prompt" style={styles.deletePrompt}>
                <Text style={styles.deletePromptText}>
                  Delete this outfit? Your clothing items are not affected.
                </Text>
                <View style={styles.deleteRow}>
                  <Pressable
                    testID="outfit-delete-cancel"
                    onPress={() => {
                      // Disarmed, not merely hidden: a prompt left on screen
                      // after a cancel is one an accidental tap can still fire.
                      setConfirmingDelete(false);
                      setDeleteError(null);
                    }}
                    disabled={deleting}
                    accessibilityRole="button"
                    accessibilityLabel="Keep this outfit"
                    style={styles.secondaryButton}
                  >
                    <Text style={styles.secondaryButtonText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    testID="outfit-delete-confirm"
                    onPress={onConfirmDelete}
                    disabled={deleting}
                    accessibilityRole="button"
                    accessibilityLabel="Delete this outfit for good"
                    style={[styles.dangerButton, deleting && styles.dangerButtonDisabled]}
                  >
                    {deleting ? (
                      <ActivityIndicator color={color.soft} />
                    ) : (
                      <Text style={[styles.dangerButtonText, deleting && styles.dangerButtonTextDisabled]}>
                        Delete
                      </Text>
                    )}
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable
                testID="outfit-delete"
                onPress={() => setConfirmingDelete(true)}
                accessibilityRole="button"
                accessibilityLabel="Delete this outfit"
                style={styles.dangerOutlineButton}
              >
                <Text style={styles.dangerOutlineText}>Delete outfit</Text>
              </Pressable>
            )}
            {deleteError !== null ? (
              <Text testID="outfit-delete-error" style={styles.inlineError}>
                {deleteError}
              </Text>
            ) : null}
          </View>
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}

/**
 * One item of the outfit, numbered.
 *
 * The number is not decoration: the order is what `POST /outfits` stored and
 * what the API reapplies deliberately rather than inheriting `$in`'s index
 * order, and "top, trousers, shoes" reads correctly where "shoes, top,
 * trousers" does not. It is in the accessibility label as well as on screen,
 * because position is the one thing a screen reader cannot infer from a list
 * it is reading one row at a time.
 *
 * `thumbnailUrl ?? imageUrl` — pre-Stage-4 uploads have no thumbnail (nothing
 * wrote `thumbnailKey` until Task 2 of this stage), and the full image is what
 * keeps them visible.
 */
function OutfitItemRow({ item, position }: { item: PublicClothingItem; position: number }) {
  return (
    <View
      testID={`outfit-item-${item.id}`}
      style={styles.itemRow}
      // `accessible` is NOT optional beside the label, and dropping it survived
      // the whole suite until the test named below existed. A `View` is not an
      // accessibility element unless this is set, so without it TalkBack walks
      // the ordinal, the image and the category as three separate nodes and the
      // label right below — the one thing carrying this item's POSITION in the
      // outfit — is never spoken at all. Asserting the label's text does not
      // assert its reachability; `names each item position in its accessible
      // label` now asserts both.
      accessible
      accessibilityLabel={`Item ${position}: ${item.category}`}
    >
      <Image
        testID={`outfit-item-image-${item.id}`}
        source={{ uri: item.thumbnailUrl ?? item.imageUrl }}
        style={styles.itemImage}
        resizeMode="cover"
        // Explicit rather than inherited — see the same prop on `OutfitCard`.
        // The `accessible` row above already absorbs this image into one node,
        // so this changes nothing about what TalkBack says today; it records
        // that the row's label is the whole story and makes a future label on
        // the photograph a deliberate act. Asserted, because a prop that is
        // currently a no-op is exactly the kind that gets deleted by accident
        // and then matters.
        accessible={false}
      />
      <Text testID={`outfit-item-position-${item.id}`} style={styles.itemPosition}>
        {String(position)}
      </Text>
      <Text testID={`outfit-item-category-${item.id}`} style={styles.itemCategory}>
        {item.category}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', paddingHorizontal: space.md, paddingTop: space.sm },
  backButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: space.gutter, paddingBottom: 40, gap: space.xs },
  title: { ...text.display, paddingTop: space.sm },
  count: { ...text.meta, paddingBottom: space.xs },
  missing: { ...text.body, fontSize: 13, color: color.washInk, paddingVertical: 6 },

  hero: { marginTop: space.lg, marginBottom: space.xl, padding: space.md },
  items: { paddingTop: space.xs, paddingBottom: space.sm, gap: space.sm },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.cloud,
  },
  itemImage: { width: 56, height: 56, borderRadius: radius.md, backgroundColor: color.cloud },
  itemPosition: {
    fontFamily: font.bold,
    fontSize: 13,
    color: color.onInk,
    backgroundColor: color.ink,
    minWidth: 22,
    borderRadius: 11,
    paddingVertical: 3,
    textAlign: 'center',
    overflow: 'hidden',
  },
  // `textTransform: 'capitalize'` stays here rather than moving to
  // `categoryLabel`: this is a row inside an outfit, not a heading, and the
  // outfit detail tests read these rows by the wire spelling.
  itemCategory: { ...text.body, fontSize: 16, textTransform: 'capitalize', flexShrink: 1 },

  wearBlock: { paddingTop: space.xl, gap: space.sm },
  shareBlock: { paddingTop: space.xl, gap: space.sm },
  shareButton: {
    alignSelf: 'stretch',
    backgroundColor: color.cloud,
    borderRadius: radius.pill,
    paddingVertical: 14,
    paddingHorizontal: space.lg,
    alignItems: 'center',
  },
  shareButtonText: { ...text.button, color: color.ink },
  sharedBlock: { gap: space.xs },
  sharedText: { ...text.body, fontSize: 13.5, color: SUCCESS_TEXT },
  sharedNotice: { ...text.body, fontSize: 13, color: color.washInk },

  editBlock: { paddingTop: space.xl, gap: space.sm },
  sectionLabel: { ...text.label },
  nameInput: {
    backgroundColor: color.card,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.cloud,
    paddingVertical: 13,
    paddingHorizontal: 15,
    fontFamily: font.body,
    fontSize: 15,
    color: color.ink,
  },
  primaryButton: {
    alignSelf: 'stretch',
    backgroundColor: color.ink,
    borderRadius: radius.pill,
    paddingVertical: 15,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
    // Held so the button keeps its height when its label becomes a spinner.
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
  primaryButtonDisabled: { backgroundColor: color.cloud },
  primaryButtonTextDisabled: { color: color.soft },
  primaryButtonText: { ...text.button, color: color.onInk },

  deleteBlock: { paddingTop: 28, gap: space.sm },
  dangerOutlineButton: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: color.washInk,
    borderRadius: radius.pill,
    paddingVertical: 14,
    paddingHorizontal: space.xl,
    alignItems: 'center',
  },
  dangerOutlineText: { ...text.button, color: color.washInk },
  deletePrompt: {
    borderRadius: radius.lg,
    padding: space.lg,
    backgroundColor: color.wash,
    gap: 10,
  },
  deletePromptText: { ...text.body, fontSize: 13.5, color: color.washInk },
  deleteRow: { flexDirection: 'row', gap: 10 },
  secondaryButton: {
    flex: 1,
    borderRadius: radius.pill,
    paddingVertical: 11,
    paddingHorizontal: 18,
    backgroundColor: color.cloud,
    alignItems: 'center',
  },
  secondaryButtonText: { fontFamily: font.semibold, fontSize: 15, color: color.ink },
  dangerButton: {
    flex: 1,
    borderRadius: radius.pill,
    paddingVertical: 11,
    paddingHorizontal: 18,
    backgroundColor: color.washInk,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  // Same reasoning as the filled buttons above: an opacity-dimmed red is
  // still a solid coloured button. `cloud` is unmistakably inactive.
  dangerButtonDisabled: { backgroundColor: color.cloud },
  dangerButtonTextDisabled: { color: color.soft },
  dangerButtonText: { fontFamily: font.semibold, fontSize: 15, color: color.wash },

  inlineError: { ...text.body, fontSize: 13.5, color: color.washInk },
  loggedText: { ...text.body, fontSize: 13.5, color: SUCCESS_TEXT },
  centre: { flex: 1, justifyContent: 'center' },
  stateTitle: { ...text.title, textAlign: 'center' },
  stateHint: { ...text.meta, fontSize: 13.5, textAlign: 'center' },
  errorBanner: {
    margin: space.lg,
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
  pressed: { opacity: 0.72 },
});
