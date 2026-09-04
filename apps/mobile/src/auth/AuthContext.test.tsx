import React from 'react';
import { Pressable, Text } from 'react-native';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react-native';
import { AuthProvider, useAuth } from './AuthContext';
import * as tokenStore from './tokenStore';
import * as client from '../api/client';

jest.mock('./tokenStore');
// A bare `jest.mock('../api/client')` automocks `ApiClientError` too, and Jest's
// automocking of a class that `extends Error` does not run the real constructor —
// `new client.ApiClientError('UNAUTHORIZED', ...)` would come out with `code`
// undefined and would not even be `instanceof Error`. That silently breaks the
// UNAUTHORIZED-vs-NETWORK distinction this file exists to pin down (verified: the
// "clears a stored token" case failed against the literal brief mock because the
// automocked error had no `.code`). Keep the real `ApiClientError` class and
// automock only `apiRequest`.
jest.mock('../api/client', () => ({
  ...jest.requireActual('../api/client'),
  apiRequest: jest.fn(),
}));

const mockedStore = tokenStore as jest.Mocked<typeof tokenStore>;
const mockedClient = client as jest.Mocked<typeof client>;

function Probe() {
  const { status, user } = useAuth();
  return <Text testID="probe">{`${status}:${user?.email ?? 'none'}`}</Text>;
}

const publicUser = { id: 'u1', name: 'Zaid', email: 'z@example.com', createdAt: '2026-01-01T00:00:00.000Z' };

// The five tests above only exercise the restore-on-mount path, and the Probe
// component above never reads `token` at all. Nothing in the brief's test set
// would notice if `signIn`/`signUp`/`signOut` hit the wrong endpoint, sent the
// wrong body, forgot to persist the token via `saveToken`/`clearToken`, or
// forgot to expose `token` on the context — yet Stages 2 and 4-8 depend on
// reading exactly that `token` value for every authenticated call. This probe
// and the tests below close that gap.
function ActionProbe() {
  const { status, user, token, signIn, signUp, signOut } = useAuth();
  return (
    <>
      <Text testID="probe">{`${status}:${user?.email ?? 'none'}:${token ?? 'none'}`}</Text>
      <Pressable testID="do-sign-in" onPress={() => signIn('z@example.com', 'hunter2')} />
      <Pressable testID="do-sign-up" onPress={() => signUp('Zaid', 'z@example.com', 'hunter2')} />
      <Pressable testID="do-sign-out" onPress={() => signOut()} />
    </>
  );
}

describe('AuthContext', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('starts in the restoring state', async () => {
    mockedStore.loadToken.mockReturnValue(new Promise(() => {}));
    await render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('restoring:none'));
  });

  it('ends anonymous when no token is stored', async () => {
    mockedStore.loadToken.mockResolvedValue(null);
    await render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('anonymous:none'));
    expect(mockedClient.apiRequest).not.toHaveBeenCalled();
  });

  it('restores an authenticated session from a stored token (TC-13)', async () => {
    mockedStore.loadToken.mockResolvedValue('stored-token');
    mockedClient.apiRequest.mockResolvedValue({ user: publicUser });
    await render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('authenticated:z@example.com'));
    expect(mockedClient.apiRequest).toHaveBeenCalledWith('/auth/me', { token: 'stored-token' });
  });

  it('clears a stored token the server rejects, and ends anonymous', async () => {
    mockedStore.loadToken.mockResolvedValue('expired-token');
    mockedClient.apiRequest.mockRejectedValue(new client.ApiClientError('UNAUTHORIZED', 'expired', 401));
    await render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('anonymous:none'));
    expect(mockedStore.clearToken).toHaveBeenCalled();
  });

  it('keeps the session when restore fails for a network reason', async () => {
    mockedStore.loadToken.mockResolvedValue('good-token');
    mockedClient.apiRequest.mockRejectedValue(new client.ApiClientError('NETWORK', 'offline'));
    await render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('anonymous:none'));
    expect(mockedStore.clearToken).not.toHaveBeenCalled();
  });

  it('signIn calls POST /auth/login, persists the token, and exposes it on the context', async () => {
    mockedStore.loadToken.mockResolvedValue(null);
    mockedClient.apiRequest.mockResolvedValue({ token: 'fresh-token', user: publicUser });
    await render(<AuthProvider><ActionProbe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('anonymous:none:none'));

    await act(async () => fireEvent.press(screen.getByTestId('do-sign-in')));

    expect(mockedClient.apiRequest).toHaveBeenCalledWith('/auth/login', {
      method: 'POST',
      body: { email: 'z@example.com', password: 'hunter2' },
    });
    expect(mockedStore.saveToken).toHaveBeenCalledWith('fresh-token');
    await waitFor(() =>
      expect(screen.getByTestId('probe')).toHaveTextContent('authenticated:z@example.com:fresh-token'),
    );
  });

  it('signUp calls POST /auth/register, persists the token, and exposes it on the context', async () => {
    mockedStore.loadToken.mockResolvedValue(null);
    mockedClient.apiRequest.mockResolvedValue({ token: 'signup-token', user: publicUser });
    await render(<AuthProvider><ActionProbe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('anonymous:none:none'));

    await act(async () => fireEvent.press(screen.getByTestId('do-sign-up')));

    expect(mockedClient.apiRequest).toHaveBeenCalledWith('/auth/register', {
      method: 'POST',
      body: { name: 'Zaid', email: 'z@example.com', password: 'hunter2' },
    });
    expect(mockedStore.saveToken).toHaveBeenCalledWith('signup-token');
    await waitFor(() =>
      expect(screen.getByTestId('probe')).toHaveTextContent('authenticated:z@example.com:signup-token'),
    );
  });

  it('signOut clears the persisted token and resets user/token to nothing', async () => {
    mockedStore.loadToken.mockResolvedValue('stored-token');
    mockedClient.apiRequest.mockResolvedValue({ user: publicUser });
    await render(<AuthProvider><ActionProbe /></AuthProvider>);
    await waitFor(() =>
      expect(screen.getByTestId('probe')).toHaveTextContent('authenticated:z@example.com:stored-token'),
    );

    await act(async () => fireEvent.press(screen.getByTestId('do-sign-out')));

    expect(mockedStore.clearToken).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('anonymous:none:none'));
  });
});
