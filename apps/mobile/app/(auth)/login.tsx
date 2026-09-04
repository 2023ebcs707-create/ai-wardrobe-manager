import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/auth/AuthContext';
import { ApiClientError } from '../../src/api/client';
import { color } from '../../src/theme/tokens';
import { authStyles as styles } from '../../src/theme/auth';
import { ErrorPlate, Field, screen } from '../../src/theme/ui';

/**
 * The first screen anyone sees, so it says what the app is for before it asks
 * for anything.
 *
 * The mockup put a strip of garment photographs under the headline. It is not
 * here, and deliberately: nobody is signed in on this screen, so there are no
 * garments to show — a strip of stock photography would be a promise made by
 * pictures of clothes the user does not own.
 */
export default function LoginScreen() {
  const router = useRouter();
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={screen.root}>
      <KeyboardAvoidingView
        style={styles.fill}
        // The form sits at the bottom of the screen; on Android the keyboard
        // would cover it outright without this.
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          <View style={styles.pitch}>
            <Text style={styles.headline}>
              Your wardrobe,{'\n'}
              <Text style={styles.headlineEm}>already sorted.</Text>
            </Text>
            <Text style={styles.blurb}>
              Take a photo of anything you own. We read the colour, file it, and suggest what goes
              with it.
            </Text>
          </View>

          <View style={styles.form}>
            {error === null ? null : (
              <ErrorPlate testID="login-error" message={error} style={styles.error} />
            )}

            <Field
              testID="login-email"
              label="Email"
              placeholder="you@example.com"
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              value={email}
              onChangeText={setEmail}
            />
            <Field
              testID="login-password"
              label="Password"
              placeholder="••••••••"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />

            <Pressable
              testID="login-submit"
              onPress={onSubmit}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Sign in"
              accessibilityState={{ disabled: busy, busy }}
              style={({ pressed }) => [
                styles.submit,
                pressed ? styles.pressed : null,
                busy ? styles.pressed : null,
              ]}
            >
              {busy ? (
                <ActivityIndicator color={color.onInk} />
              ) : (
                <Text style={styles.submitText}>Sign in</Text>
              )}
            </Pressable>

            <Pressable
              testID="login-to-register"
              onPress={() => router.replace('/(auth)/register')}
              accessibilityRole="button"
              accessibilityLabel="Create an account"
              style={styles.switch}
            >
              <Text style={styles.switchText}>
                New here? <Text style={styles.switchStrong}>Create an account</Text>
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
