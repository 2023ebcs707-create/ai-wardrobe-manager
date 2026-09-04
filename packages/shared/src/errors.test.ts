import { isApiErrorBody, type ApiErrorBody } from './errors';

describe('isApiErrorBody', () => {
  it('accepts a well-formed envelope', () => {
    const body: ApiErrorBody = { error: { code: 'VALIDATION_FAILED', message: 'bad input' } };
    expect(isApiErrorBody(body)).toBe(true);
  });

  it('accepts an envelope carrying field errors', () => {
    const body: ApiErrorBody = {
      error: { code: 'VALIDATION_FAILED', message: 'bad input', fields: [{ path: 'email', message: 'Invalid email address' }] },
    };
    expect(isApiErrorBody(body)).toBe(true);
  });

  // Written as a RAW object rather than a typed `ApiErrorBody` on purpose:
  // annotating it would make removing the code from API_ERROR_CODES a
  // compile error here, and a test that cannot run against the broken version
  // is not evidence that it catches it. `GET /suggestions` returns this code
  // and Stage 7's Task 3 hook branches on it to say "suggestions are
  // unavailable" rather than "you have no suggestions"; a client that cannot
  // recognise the envelope falls back to UNKNOWN and says the wrong one.
  it('accepts the AI_UNAVAILABLE envelope GET /suggestions returns', () => {
    expect(isApiErrorBody({ error: { code: 'AI_UNAVAILABLE', message: 'unavailable' } })).toBe(true);
  });

  it('rejects a plain object that is not an envelope', () => {
    expect(isApiErrorBody({ message: 'nope' })).toBe(false);
  });

  it('rejects null and undefined', () => {
    expect(isApiErrorBody(null)).toBe(false);
    expect(isApiErrorBody(undefined)).toBe(false);
  });

  it('rejects an error object missing a code', () => {
    expect(isApiErrorBody({ error: { message: 'no code' } })).toBe(false);
  });

  it('rejects an error object with a code but no message', () => {
    expect(isApiErrorBody({ error: { code: 'VALIDATION_FAILED' } })).toBe(false);
  });

  it('rejects an envelope whose error is null', () => {
    expect(isApiErrorBody({ error: null })).toBe(false);
  });

  it('rejects a code that is not one of the known ApiErrorCode values', () => {
    expect(isApiErrorBody({ error: { code: 'literally-anything', message: 'x' } })).toBe(false);
  });

  it('rejects a malformed fields entry', () => {
    expect(
      isApiErrorBody({
        error: { code: 'VALIDATION_FAILED', message: 'bad input', fields: [{ path: 'email' }] },
      }),
    ).toBe(false);
    expect(
      isApiErrorBody({
        error: { code: 'VALIDATION_FAILED', message: 'bad input', fields: 'not-an-array' },
      }),
    ).toBe(false);
  });
});
