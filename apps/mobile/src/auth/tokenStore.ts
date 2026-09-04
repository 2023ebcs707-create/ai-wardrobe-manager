import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'wardrobe.auth.token';

export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function loadToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    // A locked or unavailable keystore must degrade to "logged out",
    // never to a crash on app launch.
    return null;
  }
}

export async function clearToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // Nothing useful to do; the user is being logged out either way.
  }
}
