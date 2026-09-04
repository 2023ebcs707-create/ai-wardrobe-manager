import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/auth/AuthContext';
import { ApiClientError } from '../../src/api/client';
import { authStyles as styles } from '../../src/theme/auth';
import { color } from '../../src/theme/tokens';
import { ErrorPlate, Field, screen } from '../../src/theme/ui';

/**
 * Register, and the same shape as sign-in so switching between them moves the
 * words and nothing else.
 *
 * The headline names the smallest thing that gets a new account to its first
 * suggestion — one top and one pair of trousers — rather than saying "sign
 * up". An empty wardrobe is this app's real onboarding problem, and the copy
 * is the first attempt at it.
 */
export default function RegisterScreen() {
  const router = useRouter();
  const { signUp } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setBusy(true);
    setError(null);
    try {
      await signUp(name.trim(), email.trim(), password);
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
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          <View style={styles.pitch}>
            <Text style={styles.headline}>
              Let's start with{'\n'}
              <Text style={styles.headlineEm}>one piece.</Text>
            </Text>
            <Text style={styles.blurb}>
              A top and a pair of trousers is enough for your first suggestion.
            </Text>
          </View>

          <View style={styles.form}>
            {error === null ? null : (
              <ErrorPlate testID="register-error" message={error} style={styles.error} />
            )}

            <Field
              testID="register-name"
              label="Name"
              placeholder="Your name"
              autoCapitalize="words"
              autoComplete="name"
              value={name}
              onChangeText={setName}
            />
            <Field
              testID="register-email"
              label="Email"
              placeholder="you@example.com"
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              value={email}
              onChangeText={setEmail}
            />
            <Field
              testID="register-password"
              label="Password"
              // States the rule up front rather than after a rejected submit.
              placeholder="at least 8 characters"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />

            <Pressable
              testID="register-submit"
              onPress={onSubmit}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Create account"
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
                <Text style={styles.submitText}>Create account</Text>
              )}
            </Pressable>

            <Pressable
              testID="register-to-login"
              onPress={() => router.replace('/(auth)/login')}
              accessibilityRole="button"
              accessibilityLabel="Sign in"
              style={styles.switch}
            >
              <Text style={styles.switchText}>
                Already have one? <Text style={styles.switchStrong}>Sign in</Text>
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
