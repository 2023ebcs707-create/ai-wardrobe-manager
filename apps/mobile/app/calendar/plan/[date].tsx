import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { PublicOutfit } from '@wardrobe/shared';
import { ApiClientError } from '../../../src/api/client';
import { useAuth } from '../../../src/auth/AuthContext';
import { createOutfitPlan, plannedForOn } from '../../../src/calendar/api';
import { dateFromDayKey, localDayKey } from '../../../src/calendar/month';
import { markPlansDirty } from '../../../src/calendar/plansDirty';
import { useOutfits } from '../../../src/outfits/useOutfits';
import { useItemIndex } from '../../../src/wardrobe/useItemIndex';
import { OCCASION_LEGEND, color, space } from '../../../src/theme/tokens';
import { text } from '../../../src/theme/type';
import {
  Chip,
  ChipRow,
  EmptyState,
  ErrorPlate,
  Panel,
  ScreenHeader,
  Section,
  SmallButton,
  Strip,
  screen,
} from '../../../src/theme/ui';

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

/**
 * Plan an outfit for a day that has not happened yet — the forward-looking
 * twin of `app/calendar/[date].tsx`, which logs one that has.
 *
 * ## Why this is a separate screen rather than a mode of the log screen
 *
 * The two write to different endpoints with opposite date rules
 * (`POST /wear-history` refuses the future, `POST /outfit-plans` refuses the
 * past), and their copy differs in every sentence: one asks what you wore, the
 * other what you will. A single screen with a boolean would have to branch on
 * that flag in its heading, its invitation, its button label, its success
 * message and its endpoint — which is a second screen wearing the first one's
 * file name.
 *
 * ## The one rule this screen must not get wrong
 *
 * A plan carries LOCAL NOON on the chosen day, never local midnight and never
 * the device clock. `POST /outfit-plans` compares against a `now` taken after
 * the request lands with no skew tolerance, so midnight-for-today is already
 * hours in the past and would be refused for the most ordinary action this
 * screen offers. `plannedForOn` in `src/calendar/api.ts` is where that lives.
 */
export default function PlanOutfitScreen() {
  const router = useRouter();
  const { date } = useLocalSearchParams<{ date: string }>();
  const { token } = useAuth();
  const { outfits, activity, error, refresh } = useOutfits();
  const { byId: itemsById } = useItemIndex();

  const [occasion, setOccasion] = useState<string | null>(null);
  const [plannedOutfitId, setPlannedOutfitId] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  /**
   * The in-flight guard. A REF, not `planning`, and the two are not
   * interchangeable: a double tap dispatches both presses before React can
   * re-render, so the second sees `disabled` still false and the same closure
   * still holding `planning === false`. `POST /outfit-plans` is not
   * idempotent — a second request writes a second plan for the same day, and
   * the user would have to cancel one by hand.
   */
  const planningRef = useRef(false);

  const day = dateFromDayKey(date ?? '');
  const [todayKey] = useState(() => localDayKey(new Date()));
  // A day BEFORE today cannot be planned — the API refuses it, so offering the
  // action would be offering a 400. Today itself is fine: planning what you
  // are about to put on is an ordinary thing to do.
  const isPast = date !== undefined && date < todayKey;

  const onPlan = useCallback(
    async (outfit: PublicOutfit) => {
      if (planningRef.current) return;
      const plannedFor = date === undefined ? null : plannedForOn(date);
      // Refused rather than sent as `Invalid Date`: the screen already renders
      // its bad-date state for this, so this is the closure's own guard
      // against outliving the render that made it.
      if (plannedFor === null) return;
      planningRef.current = true;
      setPlanning(true);
      setPlanError(null);

      try {
        await createOutfitPlan({
          token,
          outfitId: outfit.id,
          plannedFor,
          ...(occasion === null ? {} : { occasion }),
        });
        setPlannedOutfitId(outfit.id);
        // The calendar behind this screen is holding a month that now has one
        // more plan in it, and it cannot see its own staleness.
        markPlansDirty();
        // Back to the month, which refetches on focus because of the line above.
        router.back();
      } catch (err) {
        // The button stays enabled — it IS the retry.
        setPlanError(
          err instanceof ApiClientError ? err.message : 'Something went wrong planning that outfit.',
        );
      } finally {
        planningRef.current = false;
        setPlanning(false);
      }
    },
    [date, occasion, router, token],
  );

  const heading = useMemo(() => {
    if (day === null) return 'That day';
    return `${WEEKDAYS[day.getDay()]} ${day.getDate()}`;
  }, [day]);

  if (day === null) {
    return (
      <SafeAreaView style={screen.root} edges={['top']}>
        <Header onBack={router.back} />
        <EmptyState
          testID="plan-outfit-bad-date"
          title="That is not a date"
          hint="Go back to the calendar and pick a day."
        />
      </SafeAreaView>
    );
  }

  if (isPast) {
    return (
      <SafeAreaView style={screen.root} edges={['top']}>
        <Header onBack={router.back} />
        <EmptyState
          testID="plan-outfit-past"
          title="That day has passed"
          hint="You can log what you actually wore instead, from the calendar."
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={screen.root} edges={['top']}>
      <Header onBack={router.back} />
      <ScrollView contentContainerStyle={screen.scroll} keyboardShouldPersistTaps="handled">
        <ScreenHeader title={heading} hi="Plan what you'll wear" />

        <Section>
          <Panel style={styles.invite}>
            <Text style={styles.inviteTitle}>What will you wear?</Text>
            <Text style={styles.inviteHint}>
              Planning ahead means one less decision on the day. Nothing is counted as worn until
              you log it.
            </Text>
          </Panel>
        </Section>

        <Section title="An occasion" aside="optional">
          {/* Free text in the API, so these are shortcuts rather than an enum —
              tapping a selected chip clears it, the same as the log screen. */}
          <ChipRow contentStyle={styles.chips}>
            {OCCASION_LEGEND.map((entry) => (
              <Chip
                key={entry.name}
                testID={`plan-outfit-occasion-${entry.name}`}
                label={entry.name}
                selected={occasion === entry.name}
                onPress={() => setOccasion((prev) => (prev === entry.name ? null : entry.name))}
              />
            ))}
          </ChipRow>
        </Section>

        {planError !== null ? <ErrorPlate testID="plan-outfit-error" message={planError} /> : null}

        <Section title="Your outfits" aside="tap one to plan it">
          {error !== null ? (
            <ErrorPlate
              testID="plan-outfit-outfits-error"
              message={error}
              onRetry={refresh}
              retryAccessibilityLabel="Try loading your outfits again"
            />
          ) : null}

          {activity === 'loading' && outfits.length === 0 ? (
            <View testID="plan-outfit-loading" style={styles.loading}>
              <ActivityIndicator color={color.soft} />
            </View>
          ) : outfits.length === 0 && error === null ? (
            <EmptyState
              testID="plan-outfit-no-outfits"
              title="No outfits yet"
              hint="Build one from the Add tab, then it will show up here to plan."
            />
          ) : (
            outfits.map((outfit) => (
              <Panel
                key={outfit.id}
                testID={`plan-outfit-${outfit.id}`}
                style={styles.outfit}
                glow={outfitColors(outfit, itemsById)}
              >
                <Strip uris={outfitPhotos(outfit, itemsById)} />
                <View style={styles.outfitFoot}>
                  <View style={styles.outfitName}>
                    <Text style={text.title} numberOfLines={1}>
                      {outfit.name ?? 'Unnamed outfit'}
                    </Text>
                    <Text style={text.label}>
                      {`${outfit.itemCount} ${outfit.itemCount === 1 ? 'piece' : 'pieces'}`}
                    </Text>
                  </View>
                  <SmallButton
                    testID={`plan-outfit-plan-${outfit.id}`}
                    label={plannedOutfitId === outfit.id ? 'Planned' : 'Plan this'}
                    // Aggregate, not per-outfit, and deliberately so — the same
                    // reasoning the log screen records: the endpoint is not
                    // idempotent, so disabling every button while one write is
                    // in flight is the cheap version of the ref guard above.
                    disabled={planning}
                    onPress={() => void onPlan(outfit)}
                    accessibilityLabel={`Plan ${outfit.name ?? 'this outfit'} for this day`}
                  />
                </View>
              </Panel>
            ))
          )}
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function Header({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.bar}>
      <Pressable
        testID="plan-outfit-back"
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Back to the calendar"
        style={({ pressed }) => [styles.back, pressed ? styles.pressed : null]}
      >
        <Ionicons name="chevron-back" size={20} color={color.ink} />
      </Pressable>
    </View>
  );
}

function outfitPhotos(
  outfit: PublicOutfit,
  itemsById: Record<string, { imageUrl: string; thumbnailUrl?: string }>,
): string[] {
  const resolved = outfit.itemIds
    .map((id) => itemsById[id])
    .filter((item) => item !== undefined)
    .map((item) => item.thumbnailUrl ?? item.imageUrl);
  // The cover is the server's own pick and needs no wardrobe walk, so it is
  // the honest fallback while the item index is still loading.
  if (resolved.length === 0 && outfit.coverUrl !== undefined) return [outfit.coverUrl];
  return resolved;
}

function outfitColors(
  outfit: PublicOutfit,
  itemsById: Record<string, { colors: { hex: string; name: string }[] }>,
) {
  return outfit.itemIds.flatMap((id) => itemsById[id]?.colors ?? []);
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: space.md, paddingTop: space.sm },
  back: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },

  invite: { alignItems: 'center', paddingVertical: 26, paddingHorizontal: 18 },
  inviteTitle: { ...text.title, fontSize: 19, textAlign: 'center' },
  inviteHint: {
    ...text.meta,
    fontSize: 13.5,
    lineHeight: 21,
    textAlign: 'center',
    marginTop: 8,
    maxWidth: 300,
  },

  chips: { paddingHorizontal: 0, paddingBottom: 0 },

  loading: { paddingVertical: 40, alignItems: 'center' },

  outfit: { marginBottom: space.md },
  outfitFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    marginTop: 13,
  },
  outfitName: { flex: 1, minWidth: 0, gap: 2 },

  pressed: { opacity: 0.72 },
});
