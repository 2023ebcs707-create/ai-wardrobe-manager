import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { SoftTabBar } from '../../src/theme/TabBar';
import { color } from '../../src/theme/tokens';

/**
 * Every tab needs its own `tabBarIcon`. Without one, expo-router substitutes
 * `MissingIcon` from its bundled `@react-navigation/elements`
 * (`build/react-navigation/bottom-tabs/views/BottomTabBar.js`:
 * `options.tabBarIcon ?? (({ color, size }) => <MissingIcon ... />)`), which
 * is what rendered as five tofu boxes (□) across the whole of Stage 3 — see
 * VERIFICATION.md, "Known UI defects found by looking at the Stage 3 device
 * screenshots". No mobile test saw it, because RNTL cannot see a glyph.
 *
 * `color` and `size` are threaded through rather than hardcoded, and that is
 * not a style preference: `TabBarIcon.js` renders each icon twice — once with
 * `activeTintColor`, once with `inactiveTintColor` — and cross-fades between
 * the two by opacity. A hardcoded colour produces two identical layers, so
 * the selected tab is indistinguishable from the rest. `size` likewise comes
 * from that file's HIG constants and differs between the compact and regular
 * tab bar variants.
 *
 * `@expo/vector-icons` is bundled with Expo Go, so this needs no native
 * rebuild. It is, however, on a deprecation path: Expo's docs now steer to
 * `@react-native-vector-icons`, and the linked post
 * (https://expo.dev/blog/moving-away-from-expo-vector-icons) says of the
 * successor packages, verbatim, "These new packages work in all important
 * contexts—Expo Go, dev builds, and across all platforms."
 *
 * So Expo Go is NOT what blocks the migration, and nothing about a dev
 * client would unblock it. The successor's default (dynamic) import needs
 * "no native configuration or config plugin" and is documented as "the only
 * option that works with Expo Go", requiring only Expo SDK >= 52 — this app
 * is SDK 57 with `expo-font` already installed. Only the `/static` import
 * needs a prebuild, and nothing here needs `/static`.
 *
 * REVISIT AT THE NEXT EXPO SDK UPGRADE. That is a checkpoint that will
 * actually arrive, and the deadline is real: when a future SDK finally drops
 * `@expo/vector-icons`, every icon below reverts to `MissingIcon` — the
 * exact defect this file exists to fix.
 *
 * `expo-symbols` is installed but is iOS-only (SF Symbols) and renders
 * nothing on Android, which is this project's only supported platform.
 *
 * ---------------------------------------------------------------------------
 * THE FIVE SLOTS, AND WHY PROFILE IS NOT ONE OF THEM.
 *
 * The Soft direction adds the wear calendar, which makes six destinations for
 * five slots. Calendar took the slot and Profile moved to the avatar in each
 * screen's header (`app/profile.tsx`), because a calendar is somewhere you go
 * daily and a profile is somewhere you go twice. Nothing about the profile
 * screen changed except how it is reached.
 *
 * `headerShown` is false for the whole group: every screen in this direction
 * draws its own header, in Fraunces, with its own greeting line — a navigator
 * header above that would be a second, worse title for the same screen.
 *
 * The BAR itself is `src/theme/TabBar.tsx` rather than the navigator's. Read
 * that file's header for why: the stock one is a fixed 40pt row that silently
 * squeezes the label to nothing once the icon block grows, and setting a
 * custom height on it drops the device's bottom inset. This layout stays
 * hook-free either way, which is what lets its test call it as a plain
 * function to read the options it declares.
 */
export default function TabLayout() {
  return (
    <Tabs
      tabBar={(props) => <SoftTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: color.shell },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Wardrobe',
          tabBarIcon: ({ color: tint, size }) => (
            <Ionicons name="shirt-outline" color={tint} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: 'Community',
          tabBarIcon: ({ color: tint, size }) => (
            <Ionicons name="people-outline" color={tint} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="add"
        options={{
          title: 'Add',
          tabBarIcon: ({ color: tint, size }) => (
            <Ionicons name="add-circle-outline" color={tint} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="favorites"
        options={{
          title: 'Outfits',
          tabBarIcon: ({ color: tint, size }) => (
            <Ionicons name="heart-outline" color={tint} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{
          title: 'Calendar',
          tabBarIcon: ({ color: tint, size }) => (
            <Ionicons name="calendar-outline" color={tint} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
