import { aiStatus } from './aiCheck';

describe('aiStatus', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is ok when the service responds with status ok', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok', model_loaded: false }), { status: 200 }),
    );
    await expect(aiStatus('http://ai:8000')).resolves.toBe('ok');
  });

  it('is degraded when the service responds with a non-200', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    await expect(aiStatus('http://ai:8000')).resolves.toBe('degraded');
  });

  it('is down when the service is unreachable', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(aiStatus('http://ai:8000')).resolves.toBe('down');
  });

  it('is degraded when the service responds 200 but reports an unhealthy status', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'starting', model_loaded: false }), { status: 200 }),
    );
    await expect(aiStatus('http://ai:8000')).resolves.toBe('degraded');
  });
});
