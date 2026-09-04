import type { ServiceStatus } from '@wardrobe/shared';

export async function aiStatus(baseUrl: string): Promise<ServiceStatus> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return 'degraded';
    const body = (await res.json()) as { status?: string };
    return body.status === 'ok' ? 'ok' : 'degraded';
  } catch {
    return 'down';
  }
}
