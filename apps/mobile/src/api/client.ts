import { isApiErrorBody, type ApiErrorCode, type ApiFieldError } from '@wardrobe/shared';
import { API_BASE_URL } from '../config';

export class ApiClientError extends Error {
  constructor(
    public readonly code: ApiErrorCode | 'NETWORK' | 'UNKNOWN',
    message: string,
    public readonly status?: number,
    public readonly fields?: ApiFieldError[],
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  token?: string | null;
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token } = options;

  // Multipart uploads (Task 7's /items) pass a FormData body. The runtime
  // (fetch on both web and React Native) must generate its own
  // `multipart/form-data; boundary=...` Content-Type for that body — a
  // hardcoded 'application/json' here would make the request unparseable
  // server-side without any error surfacing at this layer.
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;

  const headers: Record<string, string> = {};
  if (!isFormData) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: isFormData ? (body as FormData) : JSON.stringify(body) }),
    });
  } catch {
    throw new ApiClientError('NETWORK', 'Cannot reach the server. Check your connection.');
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiClientError('UNKNOWN', `Server returned an unexpected response (${res.status})`, res.status);
  }

  if (!res.ok) {
    if (isApiErrorBody(parsed)) {
      throw new ApiClientError(parsed.error.code, parsed.error.message, res.status, parsed.error.fields);
    }
    throw new ApiClientError('UNKNOWN', `Request failed (${res.status})`, res.status);
  }

  return parsed as T;
}
