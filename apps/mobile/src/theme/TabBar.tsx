/**
 * The Soft direction's tab bar.
 *
 * WHY THIS EXISTS AT ALL, given the navigator ships one.
 *
 * The stock bar is a fixed 40pt row that stacks the icon above the label
 * inside it, and a 24pt glyph plus the pill this design puts behind the
 * selected one does not fit. It does not respond by growing: react-native-web
 * squeezed the label to 2pt with `overflow: hidden`, and the result shipped as
 * an icon-only tab bar with every label still present in the tree — invisible
 * to RNTL, which renders no layout, and invisible in review, because the
 * markup was right.
 *
 * Setting `tabBarStyle.height` is not the fix either: `getTabBarHeight` in the
 * navigator returns a custom height VERBATIM, dropping the device's own bottom
 * inset with it, so a taller bar on a gesture-navigation phone sits underneath
 * the home indicator.
 *
 * So the bar is drawn here, where it can read the inset itself and size to its
 * own contents. `app/(tabs)/_layout.tsx` stays hook-free, which is what lets
 * its test call it as a plain function and read the options it declares.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// From `expo-router/js-tabs`, which is where the navigator's own types live —
// the root `expo-router` entry re-exports the `Tabs` component but not the
// shape its `tabBar` prop is handed.
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { color, radius } from './tokens';
import { font } from './type';

/** The glyph size handed to every `tabBarIcon`. */
const ICON_SIZE = 23;

export function SoftTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.bar,
        // At least 10pt of breathing room on a phone with no gesture bar, and
        // the real inset on one that has it.
        { paddingBottom: Math.max(insets.bottom, 10) },
      ]}
    >
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];
        const focused = state.index === index;
        const label = options.title ?? route.name;
        const tint = focused ? color.ink : color.soft;

        const onPress = () => {
          // Through the navigator's own event, not straight to `navigate`: a
          // screen can cancel a tab press (scroll-to-top on a re-tap is the
          // usual reason), and `defaultPrevented` is the only way to hear it.
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });
          if (!focused && !event.defaultPrevented) {
            navigation.navigate(route.name, route.params);
          }
        };

        return (
          <Pressable
            key={route.key}
            onPress={onPress}
            onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
            accessibilityRole="button"
            // `selected`, which is what a screen reader announces for a tab —
            // the tint and the pill are both invisible to it.
            accessibilityState={{ selected: focused }}
            accessibilityLabel={options.tabBarAccessibilityLabel ?? label}
            testID={`tab-${route.name}`}
            style={styles.item}
          >
            <View style={[styles.pill, focused ? styles.pillOn : null]}>
              {options.tabBarIcon?.({ focused, color: tint, size: ICON_SIZE })}
            </View>
            <Text
              numberOfLines={1}
              // Not scaled with the OS font size: the label sits in a row whose
              // height is the icon plus one line, and a label that grows past
              // that is the exact clipping this component was written to fix.
              // The accessible name above carries the same word, unclipped.
              allowFontScaling={false}
              style={[styles.label, { color: tint }, focused ? styles.labelOn : null]}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: color.shell,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.cloud,
    paddingTop: 9,
  },
  item: { flex: 1, alignItems: 'center', gap: 4 },
  pill: {
    width: 42,
    height: 30,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The pill is not decoration standing in for the tint: it is a SHAPE, and a
  // shape survives greyscale and colour blindness where a warm grey against a
  // near-black does not.
  pillOn: { backgroundColor: color.cloud },
  label: { fontFamily: font.medium, fontSize: 10, letterSpacing: 0.1 },
  labelOn: { fontFamily: font.semibold },
});
