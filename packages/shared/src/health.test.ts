import { overallStatus, type HealthResponse } from './health';

const base: HealthResponse = { api: 'ok', database: 'ok', storage: 'ok', ai: 'ok' };

describe('overallStatus', () => {
  it('is ok when every service is ok', () => {
    expect(overallStatus(base)).toBe('ok');
  });

  it('is down when any service is down', () => {
    expect(overallStatus({ ...base, database: 'down' })).toBe('down');
  });

  it('is degraded when a service is degraded but none are down', () => {
    expect(overallStatus({ ...base, ai: 'degraded' })).toBe('degraded');
  });

  it('prefers down over degraded when both are present', () => {
    expect(overallStatus({ ...base, ai: 'degraded', storage: 'down' })).toBe('down');
  });
});
