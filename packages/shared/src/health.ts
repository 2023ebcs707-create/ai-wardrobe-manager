export type ServiceStatus = 'ok' | 'degraded' | 'down';

export interface HealthResponse {
  api: ServiceStatus;
  database: ServiceStatus;
  storage: ServiceStatus;
  ai: ServiceStatus;
}

export function overallStatus(health: HealthResponse): ServiceStatus {
  const statuses = [health.api, health.database, health.storage, health.ai];
  if (statuses.includes('down')) return 'down';
  if (statuses.includes('degraded')) return 'degraded';
  return 'ok';
}
