import * as SecureStore from 'expo-secure-store';
import { saveToken, loadToken, clearToken } from './tokenStore';

jest.mock('expo-secure-store');

const mockedStore = SecureStore as jest.Mocked<typeof SecureStore>;

describe('tokenStore', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('saves the token under a stable key', async () => {
    await saveToken('abc123');
    expect(mockedStore.setItemAsync).toHaveBeenCalledWith('wardrobe.auth.token', 'abc123');
  });

  it('loads a stored token', async () => {
    mockedStore.getItemAsync.mockResolvedValue('abc123');
    await expect(loadToken()).resolves.toBe('abc123');
  });

  it('returns null when nothing is stored', async () => {
    mockedStore.getItemAsync.mockResolvedValue(null);
    await expect(loadToken()).resolves.toBeNull();
  });

  it('returns null rather than throwing when secure storage is unavailable', async () => {
    mockedStore.getItemAsync.mockRejectedValue(new Error('keystore unavailable'));
    await expect(loadToken()).resolves.toBeNull();
  });

  it('clears the token', async () => {
    await clearToken();
    expect(mockedStore.deleteItemAsync).toHaveBeenCalledWith('wardrobe.auth.token');
  });

  it('resolves rather than throwing when secure storage is unavailable during clear', async () => {
    mockedStore.deleteItemAsync.mockRejectedValue(new Error('keystore unavailable'));
    await expect(clearToken()).resolves.toBeUndefined();
  });
});
