/**
 * The Soft direction's component vocabulary.
 *
 * Every screen is assembled from these; a screen that reaches past them for a
 * raw colour or radius is how a design system stops being one. The set is
 * deliberately small — it is exactly the pieces `design/05-soft.html` uses,
 * and nothing was added on speculation.
 */
import type { ReactNode } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import type { ItemColor } from '@wardrobe/shared';
import { color, radius, shadow, space } from './tokens';
import { font, text } from './type';

/* ------------------------------------------------------------------ colour */

/** `#RRGGBB` -> `rgba(r,g,b,a)`. Needed because gradients must fade to a
 *  *transparent version of the surface*, and RN has no colour arithmetic. */
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * THE SIGNATURE OF THIS DESIGN, and the reason it is not a generic wardrobe
 * app: a card is lit from behind by the garment's OWN extracted colours, so
 * the screen takes on the palette of the user's wardrobe instead of a brand
 * colour. The colours come from the k-means pass in `services/ai` — they are
 * measured from the photograph, not chosen by anyone.
 *
 * CSS gets this with `filter: blur(34px)` over a linear-gradient. React Native
 * has no blur filter, so the softness is built instead: a wide three-stop
 * gradient (which is already smooth) at low opacity, with a second gradient
 * fading it into the surface colour before it reaches the bottom of the card.
 * The visible result is ambient colour with no hard edge, which is what the
 * blur was for.
 *
 * The parent MUST set `overflow: 'hidden'` and a background, or the glow
 * bleeds past the card's corners.
 */
export function Glow({
  colors,
  surface = color.card,
  intensity = 0.4,
}: {
  colors: readonly ItemColor[];
  /** The colour the glow has to disappear into. */
  surface?: string;
  intensity?: number;
}) {
  const stops = glowStops(colors);
  if (stops === null) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient
        colors={stops}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0.9 }}
        style={[StyleSheet.absoluteFill, { opacity: intensity }]}
      />
      <LinearGradient
        colors={[withAlpha(surface, 0), withAlpha(surface, 0.82), surface]}
        locations={[0, 0.55, 1]}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

/**
 * Up to three stops from the item's palette, widened to a legal gradient.
 *
 * `LinearGradient` needs at least two colours; a garment can legitimately have
 * exactly one (a plain white tee often does), so a single colour is repeated
 * rather than dropped. An item with no colours at all — an upload whose AI pass
 * degraded — returns `null` and gets no glow, which is honest: there is no
 * measured colour to show.
 */
function glowStops(colors: readonly ItemColor[]): readonly [string, string, ...string[]] | null {
  const hexes = colors.slice(0, 3).map((c) => c.hex);
  if (hexes.length === 0) return null;
  if (hexes.length === 1) return [hexes[0], hexes[0]];
  return [hexes[0], hexes[1], ...hexes.slice(2)];
}

/* ---------------------------------------------------------------- surfaces */

/** A raised white surface. `glow` opts the card into the signature above. */
export function Panel({
  children,
  glow,
  style,
  testID,
}: {
  children: ReactNode;
  glow?: readonly ItemColor[];
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <View testID={testID} style={[styles.panel, style]}>
      {glow === undefined ? null : <Glow colors={glow} />}
      {/* The content sits in its own layer so the absolutely-positioned glow
          cannot paint over it — RN has no `z-index` without a stacking
          context, and a sibling later in the tree is the one that wins. */}
      <View>{children}</View>
    </View>
  );
}

/** The dark card. One per screen at most — it is the loudest thing here. */
export function InkPanel({
  children,
  glow,
  style,
  testID,
}: {
  children: ReactNode;
  glow?: readonly ItemColor[];
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <View testID={testID} style={[styles.inkPanel, style]}>
      {glow === undefined ? null : <Glow colors={glow} surface={color.ink} intensity={0.5} />}
      <View>{children}</View>
    </View>
  );
}

/* ------------------------------------------------------------------ layout */

/** A screen section: the standard gutter, an optional heading and aside. */
export function Section({
  title,
  aside,
  children,
  style,
  testID,
}: {
  title?: string;
  /** The quiet line to the right of a heading — a count, a qualifier. */
  aside?: string;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <View testID={testID} style={[styles.section, style]}>
      {title === undefined ? null : (
        <View style={styles.sectionHead}>
          <Text style={text.heading}>{title}</Text>
          {aside === undefined ? null : <Text style={styles.aside}>{aside}</Text>}
        </View>
      )}
      {children}
    </View>
  );
}

/** A screen header: a small greeting, a display title, an optional right slot. */
export function ScreenHeader({
  hi,
  title,
  right,
  style,
}: {
  hi?: string;
  title: ReactNode;
  right?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.header, style]}>
      <View style={styles.headerMain}>
        {hi === undefined ? null : <Text style={styles.hi}>{hi}</Text>}
        {typeof title === 'string' ? <Text style={text.display}>{title}</Text> : title}
      </View>
      {right}
    </View>
  );
}

/** Equal-width garment thumbnails — the shorthand for "an outfit" everywhere. */
export function Strip({ uris, testID }: { uris: readonly string[]; testID?: string }) {
  return (
    <View testID={testID} style={styles.strip}>
      {uris.map((uri, i) => (
        <Image key={`${uri}-${i}`} source={{ uri }} style={styles.stripShot} />
      ))}
    </View>
  );
}

/** A list row: leading thumbnail, a two-line middle, a trailing slot. */
export function Row({
  uri,
  name,
  meta,
  trailing,
  first,
  testID,
}: {
  uri?: string;
  name: string;
  meta?: string;
  trailing?: ReactNode;
  /** Rows are separated by a hairline; the first one must not carry it. */
  first?: boolean;
  testID?: string;
}) {
  return (
    <View testID={testID} style={[styles.row, first === true ? null : styles.rowDivided]}>
      {uri === undefined ? null : <Image source={{ uri }} style={styles.rowShot} />}
      <View style={styles.grow}>
        <Text style={text.name}>{name}</Text>
        {meta === undefined ? null : <Text style={text.meta}>{meta}</Text>}
      </View>
      {trailing}
    </View>
  );
}

/* ----------------------------------------------------------------- atoms */

export function Avatar({
  initials,
  size = 38,
  testID,
}: {
  initials: string;
  size?: number;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}
    >
      <Text style={[styles.avatarText, { fontSize: Math.round(size * 0.34) }]}>{initials}</Text>
    </View>
  );
}

/** A small colour dot — a garment's dominant colour, an occasion, a status. */
export function Pip({ hex, size = 9, style }: { hex: string; size?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[
        { width: size, height: size, borderRadius: size / 2, backgroundColor: hex },
        styles.pipRing,
        style,
      ]}
    />
  );
}

/** The pale lozenge that carries a state word: "In the wash", an occasion. */
export function Lozenge({
  children,
  tone = 'quiet',
  style,
  testID,
}: {
  children: ReactNode;
  tone?: 'quiet' | 'wash';
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      style={[styles.lozenge, tone === 'wash' ? styles.lozengeWash : styles.lozengeQuiet, style]}
    >
      {typeof children === 'string' ? (
        <Text style={[styles.lozengeText, tone === 'wash' ? styles.lozengeTextWash : null]}>
          {children}
        </Text>
      ) : (
        children
      )}
    </View>
  );
}

/* --------------------------------------------------------------- controls */

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  style,
  testID,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const ghost = variant === 'ghost';
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: disabled === true }}
      style={({ pressed }) => [
        styles.button,
        ghost ? styles.buttonGhost : styles.buttonPrimary,
        pressed ? styles.pressed : null,
        disabled === true ? styles.disabled : null,
        style,
      ]}
    >
      <Text style={[text.button, ghost ? styles.buttonGhostText : styles.buttonPrimaryText]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A compact action inside a card — "Log this", "Save outfit". */
export function SmallButton({
  label,
  onPress,
  disabled,
  testID,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: disabled === true }}
      style={({ pressed }) => [
        styles.smallButton,
        pressed ? styles.pressed : null,
        disabled === true ? styles.disabled : null,
      ]}
    >
      <Text style={styles.smallButtonText}>{label}</Text>
    </Pressable>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  disabled,
  testID,
  accessibilityLabel,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      // `selected` is the state a screen reader announces for a filter; it is
      // also what `CategoryFilter`'s tests query on, so it is not decorative.
      // `disabled` is spread in the same object rather than set unconditionally
      // — the Add tab's mode chips go unavailable during a save, and a chip
      // that is merely dimmed says nothing to a screen reader.
      accessibilityState={{ selected, disabled: disabled === true }}
      style={({ pressed }) => [
        styles.chip,
        selected ? styles.chipOn : null,
        pressed ? styles.pressed : null,
        disabled === true ? styles.disabled : null,
      ]}
    >
      <Text style={[styles.chipText, selected ? styles.chipTextOn : null]}>{label}</Text>
    </Pressable>
  );
}

/** A horizontally scrolling chip rail with the screen gutter built in. */
export function ChipRow({
  children,
  style,
  contentStyle,
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <ScrollView
      testID={testID}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.chipRow, style]}
      contentContainerStyle={[styles.chipRowContent, contentStyle]}
    >
      {children}
    </ScrollView>
  );
}

/**
 * A labelled text field.
 *
 * The label is always visible rather than a placeholder that vanishes on the
 * first keystroke: a form whose fields are unlabelled the moment you start
 * typing is unusable to anyone who looks away mid-entry, and it is the single
 * most common accessibility defect in a login screen. The placeholder is left
 * for an EXAMPLE of the value, which is a different job.
 */
export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  testID,
  ...input
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  testID?: string;
} & Omit<TextInputProps, 'value' | 'onChangeText' | 'placeholder' | 'testID' | 'style'>) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        testID={testID}
        style={styles.fieldInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={color.soft}
        // The label is drawn above the field, but a screen reader walking the
        // form hears only the input; without this it announces "edit box".
        accessibilityLabel={label}
        {...input}
      />
    </View>
  );
}

/* ------------------------------------------------------------------ states */

/**
 * The one way this app reports a failure, so a user meets the same shape
 * everywhere. Pale rather than red: an error here is "that did not load", not
 * a hazard, and the palette has no red in it to escalate to.
 */
export function ErrorPlate({
  message,
  onRetry,
  retryLabel = 'Try again',
  style,
  testID,
  messageTestID,
  retryTestID,
  retryAccessibilityLabel,
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  messageTestID?: string;
  retryTestID?: string;
  retryAccessibilityLabel?: string;
}) {
  return (
    <View testID={testID} style={[styles.errorPlate, style]}>
      <Text testID={messageTestID} style={styles.errorText}>
        {message}
      </Text>
      {onRetry === undefined ? null : (
        <Pressable
          testID={retryTestID}
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={retryAccessibilityLabel ?? retryLabel}
          style={({ pressed }) => [styles.errorRetry, pressed ? styles.pressed : null]}
        >
          <Text style={styles.errorRetryText}>{retryLabel}</Text>
        </Pressable>
      )}
    </View>
  );
}

/** An empty state. A headline that says what is true, and a line that says what to do. */
export function EmptyState({
  title,
  hint,
  style,
  testID,
}: {
  title: string;
  hint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <View testID={testID} style={[styles.empty, style]}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {hint === undefined ? null : <Text style={styles.emptyHint}>{hint}</Text>}
    </View>
  );
}

/* ------------------------------------------------------------------ styles */

const styles = StyleSheet.create({
  panel: {
    backgroundColor: color.card,
    borderRadius: radius.card,
    padding: space.lg,
    overflow: 'hidden',
    ...shadow.card,
  },
  inkPanel: {
    backgroundColor: color.ink,
    borderRadius: radius.hero - 2,
    padding: space.xl,
    overflow: 'hidden',
  },

  section: { paddingHorizontal: space.gutter, paddingBottom: space.xxl },
  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: space.md,
    gap: space.md,
  },
  aside: { ...text.meta, flexShrink: 1, textAlign: 'right' },

  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.md,
    paddingHorizontal: space.gutter,
    paddingTop: space.sm,
    paddingBottom: space.lg,
  },
  headerMain: { flex: 1 },
  hi: { ...text.meta, fontSize: 13, marginBottom: 5 },

  strip: { flexDirection: 'row', gap: 7 },
  stripShot: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 12,
    backgroundColor: color.cloud,
  },

  row: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 11 },
  rowDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.cloud },
  rowShot: { width: 46, height: 46, borderRadius: 12, backgroundColor: color.cloud },
  grow: { flex: 1, minWidth: 0 },

  avatar: { backgroundColor: color.cloud, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: font.bold, color: color.ink, letterSpacing: -0.3 },

  // A garment's own colour can be near-white, which would vanish on a white
  // card; the ring is what keeps a pale swatch readable as a swatch.
  pipRing: { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(42,41,37,0.18)' },

  lozenge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: radius.pill,
    paddingVertical: 5,
    paddingHorizontal: 11,
  },
  lozengeQuiet: { backgroundColor: color.cloud },
  lozengeWash: { backgroundColor: color.wash },
  lozengeText: { fontFamily: font.semibold, fontSize: 11.5, color: color.ink },
  lozengeTextWash: { color: color.washInk },

  button: {
    borderRadius: radius.pill,
    paddingVertical: 16,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPrimary: { backgroundColor: color.ink },
  buttonGhost: { backgroundColor: color.cloud },
  buttonPrimaryText: { color: color.onInk },
  buttonGhostText: { color: color.ink },

  smallButton: {
    borderRadius: radius.pill,
    paddingVertical: 9,
    paddingHorizontal: 16,
    backgroundColor: color.ink,
  },
  smallButtonText: { fontFamily: font.semibold, fontSize: 13, color: color.onInk },

  chipRow: { flexGrow: 0 },
  chipRowContent: { gap: space.sm, paddingHorizontal: space.gutter, paddingBottom: 18 },
  chip: {
    borderRadius: radius.pill,
    paddingVertical: 10,
    paddingHorizontal: 15,
    backgroundColor: color.cloud,
    justifyContent: 'center',
  },
  chipOn: { backgroundColor: color.ink },
  chipText: { fontFamily: font.medium, fontSize: 13, color: color.soft },
  chipTextOn: { color: color.shell },

  field: {
    backgroundColor: color.card,
    borderRadius: radius.lg,
    paddingHorizontal: 15,
    paddingTop: 10,
    paddingBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.cloud,
  },
  fieldLabel: { fontFamily: font.semibold, fontSize: 11, color: color.soft },
  fieldInput: {
    fontFamily: font.body,
    fontSize: 16,
    letterSpacing: -0.16,
    color: color.ink,
    // Zero on Android, where a TextInput carries a large default vertical
    // padding that would push the field to twice the height of the label above.
    paddingVertical: 2,
    marginTop: 1,
  },

  errorPlate: {
    marginHorizontal: space.gutter,
    marginBottom: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: color.wash,
    gap: space.md,
  },
  errorText: { fontFamily: font.body, fontSize: 13.5, lineHeight: 20, color: color.washInk },
  errorRetry: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: color.washInk,
  },
  errorRetryText: { fontFamily: font.semibold, fontSize: 13, color: color.wash },

  empty: { paddingVertical: 48, paddingHorizontal: space.gutter, alignItems: 'center', gap: 6 },
  emptyTitle: { ...text.title, textAlign: 'center' },
  emptyHint: { ...text.meta, fontSize: 13.5, textAlign: 'center', maxWidth: 280 },

  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.45 },
});

/** Shared page chrome, so a screen never re-declares the shell colour. */
export const screen = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.shell },
  scroll: { paddingBottom: space.xxl },
});
