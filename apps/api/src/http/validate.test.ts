import { z } from 'zod';
import { ApiError } from './errors';
import { parseBody } from './validate';

describe('parseBody', () => {
  it('dot-joins a nested path', () => {
    const schema = z.object({ user: z.object({ address: z.object({ zip: z.string() }) }) });

    try {
      parseBody(schema, { user: { address: { zip: 12345 } } });
      throw new Error('expected parseBody to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.fields).toEqual([expect.objectContaining({ path: 'user.address.zip' })]);
    }
  });

  it('falls back to (body) for an issue with an empty path', () => {
    const schema = z
      .object({ password: z.string(), confirmPassword: z.string() })
      .refine((data) => data.password === data.confirmPassword, { message: 'Passwords must match' });

    try {
      parseBody(schema, { password: 'a', confirmPassword: 'b' });
      throw new Error('expected parseBody to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.fields).toEqual([expect.objectContaining({ path: '(body)' })]);
    }
  });

  it('returns the parsed data when valid', () => {
    const schema = z.object({ email: z.string().email() });
    expect(parseBody(schema, { email: 'a@b.com' })).toEqual({ email: 'a@b.com' });
  });
});
