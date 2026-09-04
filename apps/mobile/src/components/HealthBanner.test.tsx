import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { HealthBanner } from './HealthBanner';

describe('HealthBanner', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows a loading state before the response arrives', async () => {
    jest.spyOn(global, 'fetch').mockReturnValue(new Promise(() => {}) as Promise<Response>);
    await render(<HealthBanner baseUrl="http://localhost:3000" />);
    await waitFor(() => expect(screen.getByTestId('health-loading')).toBeTruthy());
  });

  it('renders every service status once loaded', async () => {
    // The API returns HTTP 503 (not 200) with a valid JSON body when a
    // dependency is down. HealthBanner deliberately ignores res.ok and reads
    // the body regardless of status code, so the banner can show *which*
    // service failed instead of just "unreachable". Mocking a 503 here (not
    // 200) is what pins that decision down as an executable constraint.
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ api: 'ok', database: 'ok', storage: 'ok', ai: 'down' }),
        { status: 503 },
      ),
    );

    await render(<HealthBanner baseUrl="http://localhost:3000" />);

    await waitFor(() => expect(screen.getByTestId('health-banner')).toBeTruthy());
    expect(screen.getByTestId('health-api')).toHaveTextContent('api: ok');
    expect(screen.getByTestId('health-database')).toHaveTextContent('database: ok');
    expect(screen.getByTestId('health-storage')).toHaveTextContent('storage: ok');
    expect(screen.getByTestId('health-ai')).toHaveTextContent('ai: down');
  });

  it('shows an error state when the API is unreachable', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network request failed'));
    await render(<HealthBanner baseUrl="http://localhost:3000" />);
    await waitFor(() => expect(screen.getByTestId('health-error')).toBeTruthy());
  });
});
