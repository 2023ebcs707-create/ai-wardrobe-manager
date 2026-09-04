import type { ServiceStatus } from '@wardrobe/shared';

export interface HealthChecks {
  database: () => Promise<ServiceStatus>;
  storage: () => Promise<ServiceStatus>;
  ai: () => Promise<ServiceStatus>;
}

export async function safeCheck(check: () => Promise<ServiceStatus>): Promise<ServiceStatus> {
  try {
    return await check();
  } catch {
    return 'down';
  }
}
