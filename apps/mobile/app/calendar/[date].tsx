import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { PublicOutfit } from '@wardrobe/shared';
import { dateFromDayKey, localDayKey } from '../../src/calendar/month';
import { markTrackingDirty } from '../../src/tracking/trackingDirty';
import { useLogWear } from '../../src/tracking/useLogWear';
import { useOutfits } from '../../src/outfits/useOutfits';
import { useItemIndex } from '../../src/wardrobe/useItemIndex';
import { OCCASION_LEGEND, color, space } from '../../src/theme/tokens';
import { font, text } from '../../src/theme/type';
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
} from '../../src/theme/ui';

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

/**
 * FR6/TC-08 from the calendar's side: log what was worn on one particular day.
 *
 * An empty day is an invitation, not a blank — the screen opens with the
 * question and the user's own outfits already laid out, because the whole
 * value of the wear log is that it gets filled in, and a day that offers
 * nothing gets filled in by nobody.
 *
 * ## The one rule this screen must not get wrong
 *
 * A wear happening NOW carries no `wornAt` at all; a wear on a day the user
 * picked carries one. `POST /wear-history` compares `wornAt` to a `now` it
 * takes after the request lands, with a strict `>` and no skew tolerance, so a
 * handset a few milliseconds fast that sent its own clock for "today" would
 * get a 400 it cannot act on — and it would be invisible in development, where
 * the emulator and the API share a clock. The full reasoning is on
 * `PublicWearEvent.wornAt` in `@wardrobe/shared`.
 *
 * `wornAtFor` below is where that rule lives, and it is the reason this screen
 * knows what "today" is at all.
 */
export default function LogWearScreen() {
  const router = useRouter();
  const { date } = useLocalSearchParams<{ date: string }>();
  const { outfits, activity, error, refresh } = useOutfits();
  const { byId: itemsById } = useItemIndex();
  const { logWear, pending, error: logError } = useLogWear();

  const [occasion, setOccasion] = useState<string | null>(null);
  const [loggedOutfitId, setLoggedOutfitId] = useState<string | null>(null);

  const day = dateFromDayKey(date ?? '');
  const [todayKey] = useState(() => localDayKey(new Date()));
  const isToday = date === todayKey;

  const onLog = useCallback(
    async (outfit: PublicOutfit) => {
      const event = await logWear({
        outfitId: outfit.id,
        ...wornAtFor(date, todayKey),
        ...(occasion === null ? {} : { occasion }),
      });
      if (event === null) return;
      setLoggedOutfitId(outfit.id);
      // Both wear-history screens and the wardrobe grid are now stale: every
      // member item's `wearCount` and `lastWornAt` just moved.
      markTrackingDirty();
      // Back to the month, which refetches on focus because of the line above.
      router.back();
    },
    [date, todayKey, occasion, logWear, router],
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
          testID="log-wear-bad-date"
          title="That is not a date"
          hint="Go back to the calendar and pick a day."
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={screen.root} edges={['top']}>
      <Header onBack={router.back} />
      <ScrollView contentContainerStyle={screen.scroll} keyboardShouldPersistTaps="handled">
        {/* Says what this screen DOES, not what the day contains. An earlier
            version read "Nothing logged yet", which is false the moment the
            user arrives here through "Log another outfit for this day" — a day
            can hold several wears, and this screen never fetches the history
            that would let it know. A screen that cannot check a fact does not
            get to assert it. */}
        <ScreenHeader title={heading} hi={isToday ? 'Log what you wore today' : 'Log what you wore'} />

        <Section>
          <Panel style={styles.invite}>
            <Text style={styles.inviteTitle}>
              {isToday ? 'What did you wear today?' : 'What did you wear?'}
            </Text>
            <Text style={styles.inviteHint}>
              Logging it keeps your wear counts honest and teaches the suggestions what you
              actually reach for.
            </Text>
          </Panel>
        </Section>

        <Section title="An occasion" aside="optional">
          {/* Free text in the API, so these are shortcuts rather than an enum —
              tapping a selected chip clears it, which is the only way back to
              "no occasion" once one is chosen. */}
          <ChipRow contentStyle={styles.chips}>
            {OCCASION_LEGEND.map((entry) => (
              <Chip
                key={entry.name}
                testID={`log-wear-occasion-${entry.name}`}
                label={entry.name}
                selected={occasion === entry.name}
                onPress={() => setOccasion((prev) => (prev === entry.name ? null : entry.name))}
              />
            ))}
          </ChipRow>
        </Section>

        {logError !== null ? <ErrorPlate testID="log-wear-error" message={logError} /> : null}

        <Section title="Your outfits" aside="tap one to log it">
          {error !== null ? (
            <ErrorPlate
              testID="log-wear-outfits-error"
              message={error}
              onRetry={refresh}
              retryAccessibilityLabel="Try loading your outfits again"
            />
          ) : null}

          {activity === 'loading' && outfits.length === 0 ? (
            <View testID="log-wear-loading" style={styles.loading}>
              <ActivityIndicator color={color.soft} />
            </View>
          ) : outfits.length === 0 && error === null ? (
            <EmptyState
              testID="log-wear-no-outfits"
              title="No outfits yet"
              hint="Build one from the Add tab, then it will show up here to log."
            />
          ) : (
            outfits.map((outfit) => (
              <Panel
                key={outfit.id}
                testID={`log-wear-outfit-${outfit.id}`}
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
                    testID={`log-wear-log-${outfit.id}`}
                    label={loggedOutfitId === outfit.id ? 'Logged' : 'Log this'}
                    // `pending` is aggregate, not per-outfit, and that is the
                    // point: `POST /wear-history` is not idempotent, and a
                    // second tap writes a second event and double-counts every
                    // member item's `wearCount` with no endpoint able to undo
                    // it. Disabling every button while one is in flight is the
                    // cheap version of the guard `useGuardedMutation` already
                    // enforces underneath.
                    disabled={pending}
                    onPress={() => void onLog(outfit)}
                    accessibilityLabel={`Log ${outfit.name ?? 'this outfit'} as worn`}
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
        testID="log-wear-back"
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

/**
 * The `wornAt` half of the request body — `{}` for today, `{ wornAt }` for a
 * day the user picked. Read this file's header comment before changing it.
 *
 * Local NOON, not local midnight. The server stores an instant and this app
 * reads the local day back out of it, so any time inside the chosen local day
 * round-trips correctly; noon is the choice that survives a daylight-saving
 * shift in either direction, where midnight can land on the previous day.
 */
export function wornAtFor(dayKey: string | undefined, todayKey: string): { wornAt?: string } {
  if (dayKey === undefined || dayKey === todayKey) return {};
  const day = dateFromDayKey(dayKey);
  if (day === null) return {};
  day.setHours(12, 0, 0, 0);
  return { wornAt: day.toISOString() };
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
