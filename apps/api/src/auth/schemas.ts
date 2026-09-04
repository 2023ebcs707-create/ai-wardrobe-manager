import { z } from 'zod';

// bcrypt hashes only the first 72 BYTES of its input and silently ignores the
// rest. Verified: a password sharing the first 72 bytes with another verifies
// against that other password's hash. So the limit must be enforced here, and
// it must be measured in bytes rather than characters — 20 emoji are 40
// characters but 80 bytes, so a character cap does not bound it.
const MAX_PASSWORD_BYTES = 72;

export const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  email: z.string().trim().email('Enter a valid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_PASSWORD_BYTES, {
      message: `Password must be at most ${MAX_PASSWORD_BYTES} bytes`,
    }),
});

export const loginSchema = z.object({
  email: z.string().trim().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});
