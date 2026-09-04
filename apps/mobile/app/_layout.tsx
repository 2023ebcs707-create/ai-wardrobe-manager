import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Stack, useRouter, useSegments } from 'expo-router';
import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import { useAppFonts } from '../src/theme/fonts';
import { color } from '../src/theme/tokens';

function AuthGate() {
  const { status } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (status === 'restoring') return;

    const inAuthGroup = segments[0] === '(auth)';

    if (status === 'anonymous' && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (status === 'authenticated' && inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [status, segments, router]);

  if (status === 'restoring') {
    return (
      <View testID="auth-restoring" style={styles.hold}>
        <ActivityIndicator color={color.soft} />
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        // Every screen paints `shell` itself; this is what the navigator shows
        // in the gap DURING a push, and a default white flash between two
        // off-white screens is visible on a warm palette.
        contentStyle: { backgroundColor: color.shell },
      }}
    />
  );
}

export default function RootLayout() {
  /**
   * The whole app is set in Fraunces and Figtree, and React Native does not
   * re-layout text when a font arrives late — it draws the fallback face at
   * the fallback's metrics and leaves it. Rendering the tree before the
   * families are registered therefore does not produce a brief flash of the
   * wrong font; it produces a screen laid out to the wrong metrics until the
   * next state change happens to remount it. So this holds, briefly, rather
   * than degrading.
   */
  const fontsLoaded = useAppFonts();

  return (
    <SafeAreaProvider>
      {/*
        DARK status bar CONTENT, because every screen in this app is light.
        Not a preference — a defect fix, found by looking at the handset rather
        than by any test.

        The generated native theme is `Theme.AppCompat.DayNight.NoActionBar`
        with `android:statusBarColor` transparent, so the system draws the
        clock and icons directly over whatever the app renders, and picks their
        colour from the SYSTEM theme. On a phone in dark mode Android chooses
        WHITE icons -- over this app's light backgrounds, which made the status
        bar effectively invisible.

        `app.json` previously declared `userInterfaceStyle: "automatic"`, which
        says "this app adapts to the system theme". It does not: there is no
        `useColorScheme`, no dark palette, and every screen is a warm off-white
        by design. That declaration is now `"light"`, which is the true one.
        This component is the runtime half -- it fixes the same defect without
        depending on the native theme being regenerated, which matters because
        a standalone APK bakes that theme in at build time.

        `style="dark"` means dark CONTENT on a light bar, not a dark bar.
      */}
      <StatusBar style="dark" />
      {fontsLoaded ? (
        <AuthProvider>
          <AuthGate />
        </AuthProvider>
      ) : (
        <View testID="fonts-loading" style={styles.hold} />
      )}
    </SafeAreaProvider>
  );
}

const styles = {
  hold: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.shell,
  },
} as const;
