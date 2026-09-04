import { apiRequest, ApiClientError } from './client';

describe('apiRequest', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the parsed body on success', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ hello: 'world' }), { status: 200 }),
    );
    await expect(apiRequest<{ hello: string }>('/thing')).resolves.toEqual({ hello: 'world' });
  });

  it('sends the bearer token when one is supplied', async () => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await apiRequest('/thing', { token: 'abc123' });
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer abc123');
  });

  it('omits the Authorization header when no token is supplied', async () => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await apiRequest('/thing');
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('throws ApiClientError carrying the server error code', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'EMAIL_TAKEN', message: 'Already registered' } }), { status: 409 }),
    );
    await expect(apiRequest('/thing')).rejects.toMatchObject({
      code: 'EMAIL_TAKEN',
      message: 'Already registered',
      status: 409,
    });
  });

  it('exposes field errors from a validation failure', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'VALIDATION_FAILED', message: 'bad', fields: [{ path: 'email', message: 'Enter a valid email address' }] },
        }),
        { status: 400 },
      ),
    );
    await expect(apiRequest('/thing')).rejects.toMatchObject({
      fields: [{ path: 'email', message: 'Enter a valid email address' }],
    });
  });

  it('falls back to UNKNOWN when a non-ok response has JSON that is not a valid error envelope', async () => {
    // A body that looks error-shaped but carries a code outside API_ERROR_CODES (e.g. spoofed
    // by a misbehaving proxy) must not be trusted as-is — isApiErrorBody has to gate this path,
    // not just a bare `parsed.error.code` read.
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'NOT_A_REAL_CODE', message: 'spoofed' } }), { status: 500 }),
    );
    await expect(apiRequest('/thing')).rejects.toMatchObject({
      code: 'UNKNOWN',
      status: 500,
    });
  });

  it('throws a usable error when the server returns non-JSON', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>502</html>', { status: 502 }));
    await expect(apiRequest('/thing')).rejects.toBeInstanceOf(ApiClientError);
  });

  it('throws a usable error when the network is unreachable', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network request failed'));
    await expect(apiRequest('/thing')).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('sets Content-Type: application/json for a JSON body', async () => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await apiRequest('/thing', { method: 'POST', body: { a: 1 } });
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  // Task 7: uploads use multipart/form-data, whose boundary the fetch runtime
  // must generate itself. A hardcoded 'application/json' header here would
  // silently produce a request the server's multer middleware can't parse —
  // it would fail with a body-parsing error far from this file, not obviously
  // traceable back to this header. Asserting the header is *absent* (rather
  // than checking it isn't 'application/json') is what forces the runtime to
  // set its own boundary-bearing Content-Type instead of us omitting the
  // boundary and leaving JSON's value in place.
  it('omits Content-Type when the body is FormData, so fetch can set the multipart boundary itself', async () => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const form = new FormData();
    // RN's FormData accepts a `{ uri, name, type }` file part in place of a
    // web Blob (see uploadItem.ts); lib.dom's FormData.append types don't
    // know that shape, hence the cast.
    form.append('image', { uri: 'file:///tmp/a.jpg', name: 'a.jpg', type: 'image/jpeg' } as unknown as Blob);
    await apiRequest('/thing', { method: 'POST', body: form });

    const call = spy.mock.calls[0][1] as RequestInit;
    const headers = call.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    // The FormData instance must be passed through untouched (not JSON.stringify'd).
    expect(call.body).toBe(form);
  });

  it('still attaches the bearer token when the body is FormData', async () => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const form = new FormData();
    await apiRequest('/thing', { method: 'POST', body: form, token: 'tok-multipart' });
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-multipart');
  });
});
