import type { ErrorRequestHandler, RequestHandler } from 'express';
import multer from 'multer';
import type { ApiErrorBody, ApiErrorCode, ApiFieldError } from '@wardrobe/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly fields?: ApiFieldError[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  const body: ApiErrorBody = { error: { code: 'NOT_FOUND', message: 'Route not found' } };
  res.status(404).json(body);
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    const body: ApiErrorBody = {
      error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) },
    };
    res.status(err.status).json(body);
    return;
  }

  // Multer rejects an oversized upload with its own error carrying this code,
  // not an ApiError. Map it explicitly so it reaches the client as a clean
  // 413 instead of falling through to the generic 500 branch below.
  // Checking `instanceof multer.MulterError` (not just duck-typing `.code`)
  // matters once Stage 3 adds a Python-service HTTP call: failures from that
  // call carry `.code` values like ECONNREFUSED/ETIMEDOUT, which would
  // otherwise collide with this branch and be misreported as a 413.
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    const body: ApiErrorBody = {
      error: { code: 'VALIDATION_FAILED', message: 'That image is too large' },
    };
    res.status(413).json(body);
    return;
  }

  // A part multer was not told to expect -- a typo'd field name, or a second
  // `image` part -- is a malformed request, not a server fault. Left
  // unmapped it produced a 500 plus a `console.error` per request, which
  // both misreports the fault and fills the log with lines describing a
  // healthy server. The field name the client sent is deliberately not
  // echoed back: it adds nothing the client does not already know.
  if (err instanceof multer.MulterError && err.code === 'LIMIT_UNEXPECTED_FILE') {
    const body: ApiErrorBody = {
      error: { code: 'VALIDATION_FAILED', message: 'Unexpected or duplicated file field' },
    };
    res.status(400).json(body);
    return;
  }

  // A body that is not parseable JSON is a client mistake, not a server fault.
  // body-parser throws a SyntaxError carrying `status: 400` and a `body`
  // property; left unmapped it produced a 500 plus a full stack trace in the
  // log, which both misreports the fault and describes a healthy server as
  // broken -- exactly what the multer branch above already exists to prevent.
  // The parser's own message is not echoed back: it quotes the offending
  // fragment, which is the client's own input reflected into a response.
  if (
    err instanceof SyntaxError &&
    'body' in err &&
    (err as SyntaxError & { status?: number }).status === 400
  ) {
    const body: ApiErrorBody = {
      error: { code: 'VALIDATION_FAILED', message: 'Request body is not valid JSON' },
    };
    res.status(400).json(body);
    return;
  }

  // A body larger than body-parser's limit is a client mistake too, and it is
  // NOT a SyntaxError -- body-parser throws a PayloadTooLargeError carrying
  // `status: 413` and `type: 'entity.too.large'`, so the branch above never
  // matched it and it fell through to INTERNAL: the client's fault reported as
  // the server's, with a stack trace logged for a server that is fine. The
  // same defect the multer branches already exist to prevent, reached through
  // a different door.
  //
  // Matched on body-parser's own `type` as well as the status, for the reason
  // the multer branches check `instanceof` rather than duck-typing `.code`:
  // identify the producer, not just a number that anything could carry.
  if (
    err instanceof Error &&
    'type' in err &&
    (err as Error & { type?: string }).type === 'entity.too.large' &&
    (err as Error & { status?: number }).status === 413
  ) {
    const body: ApiErrorBody = {
      error: { code: 'VALIDATION_FAILED', message: 'That request body is too large' },
    };
    res.status(413).json(body);
    return;
  }

  // Never surface an unexpected error's message: it can carry connection
  // strings, hashes, or file paths. Log it server-side, return a generic body.
  console.error('Unhandled error:', err);
  const body: ApiErrorBody = { error: { code: 'INTERNAL', message: 'Something went wrong' } };
  res.status(500).json(body);
};
