import { escapeRegex, isDuplicateKeyError, DELETED_AUTHOR_NAME } from './community';

/**
 * UNIT tests for the two pure pieces of the feed, deliberately separate from
 * `community.integration.test.ts`.
 *
 * The integration suite can only ask `?q=` questions through captions it
 * happens to have seeded, so it proves the escape works for the handful of
 * metacharacters those captions contain. This file asserts the property
 * DIRECTLY, over every character the class names — including the ones no
 * caption fixture would think to contain — and it does so with no database and
 * no HTTP server.
 *
 * The assertions are written against `new RegExp(...)`, not against a
 * hard-coded expected string. An expected-string test would pass for an escape
 * that inserted backslashes in the wrong places; this one asks the only
 * question that matters — does the escaped pattern match the ORIGINAL text and
 * nothing else.
 *
 * WHAT THIS FILE STRUCTURALLY CANNOT SEE, and it cost a 500 to learn:
 * `new RegExp` is the JS regex engine, and the route hands its pattern to
 * MONGO'S. The two do not accept the same inputs. `new RegExp('\0')` compiles
 * without complaint; mongod refuses any `$regex` containing an embedded NUL
 * with a BadValue error, so `?q=%00` was a 500 while every assertion below
 * stayed green. Anything about which terms the SEARCH accepts therefore belongs
 * in `community.integration.test.ts`, where the answer comes from the route —
 * see `rejects a q carrying a control character with a 400, never a 500`. This
 * file's remit is the escape's TRANSFORMATION, and only that.
 */
describe('escapeRegex', () => {
  const METACHARACTERS = ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'];

  it('makes every regex metacharacter match itself literally', () => {
    for (const ch of METACHARACTERS) {
      const pattern = new RegExp(escapeRegex(ch));
      // The character matches itself...
      expect(pattern.test(`a${ch}b`)).toBe(true);
      // ...and does not match a string that lacks it. This half is what fails
      // for an unescaped `.`, which matches any character at all.
      expect(pattern.test('plain text')).toBe(false);
    }
  });

  it('compiles a term that is not a valid regex on its own', () => {
    // Unescaped, each of these throws on compile — which on the route would
    // turn a client's typo in the search box into a 500.
    // Every entry here was CHECKED to throw unescaped, not assumed: `a{2,`
    // was in this list first and does NOT throw, because Annex B rehabilitates
    // an unterminated quantifier as a literal. A list padded with terms that
    // never throw would make the first assertion below vacuous for those rows.
    for (const broken of ['[', '(', '*', '+', '?', '\\', '(?<', '[a-', '(a']) {
      expect(() => new RegExp(broken)).toThrow();
      expect(() => new RegExp(escapeRegex(broken))).not.toThrow();
      expect(new RegExp(escapeRegex(broken)).test(`x${broken}y`)).toBe(true);
    }
  });

  it('stops a wildcard term from matching everything', () => {
    // The quiet failure: `.*` unescaped matches every caption in the system,
    // so the search silently stops filtering rather than visibly breaking.
    expect(new RegExp('.*').test('anything at all')).toBe(true);
    expect(new RegExp(escapeRegex('.*')).test('anything at all')).toBe(false);
    expect(new RegExp(escapeRegex('.*')).test('a literal .* here')).toBe(true);
  });

  it('stops a group from widening the search instead of breaking it', () => {
    // `(blue)` unescaped is a capture group matching the substring "blue", so
    // it returns MORE than the user asked for — a failure that any
    // "did it return something?" assertion would sail straight past.
    expect(new RegExp('(blue)').test('Cotton blue shirt')).toBe(true);
    expect(new RegExp(escapeRegex('(blue)')).test('Cotton blue shirt')).toBe(false);
    expect(new RegExp(escapeRegex('(blue)')).test('Cotton (blue) shirt')).toBe(true);
  });

  it('defuses a catastrophically backtracking pattern', () => {
    // `(a+)+$` against a long non-matching string is exponential, and it would
    // run server-side against every caption. Escaped it is a 6-character
    // literal that no caption contains, and the search is linear again.
    const evil = '(a+)+$';
    const haystack = `${'a'.repeat(40)}!`;
    const started = Date.now();
    expect(new RegExp(escapeRegex(evil)).test(haystack)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('leaves an ordinary term untouched', () => {
    // The escape must not corrupt the overwhelmingly common case.
    for (const term of ['linen', 'Summer suit', 'Friday-best', 'a/b', '50% off', 'café']) {
      expect(escapeRegex(term)).toBe(term);
      expect(new RegExp(escapeRegex(term), 'i').test(`x ${term} y`)).toBe(true);
    }
  });
});

describe('DELETED_AUTHOR_NAME', () => {
  /**
   * Pinned as a literal here and asserted as a literal in the integration
   * suite, so the two cannot drift and neither can change silently: it is a
   * user-visible string on a public card, not an implementation detail.
   *
   * Non-empty is the load-bearing part. `PostAuthor.name` is what the initials
   * avatar is derived from (ruling 6), so an empty placeholder renders as the
   * blank circle that ruling exists to prevent.
   */
  it('is a real, non-empty display name', () => {
    expect(DELETED_AUTHOR_NAME).toBe('Deleted user');
    expect(DELETED_AUTHOR_NAME.trim()).toHaveLength(DELETED_AUTHOR_NAME.length);
    expect(DELETED_AUTHOR_NAME.length).toBeGreaterThan(0);
  });
});

describe('isDuplicateKeyError', () => {
  /**
   * The predicate that decides whether a failed interaction upsert is "somebody
   * else inserted this row first" or a genuine fault.
   *
   * It is unit-tested because the branch that CONSUMES it is a race — two
   * upserts of one (post, user) pair landing inside the same instant — and
   * nothing in an integration suite can interleave two handlers deterministically
   * enough to enter it. What CAN be checked there, and is, is that a real driver
   * error from a real unique index satisfies this predicate: see `raises a
   * duplicate-key error that isDuplicateKeyError recognises` in
   * `community.integration.test.ts`. This file's remit is the classification,
   * and in particular the things it must NOT classify as a duplicate — a
   * swallowed unrelated error would turn a genuine write failure into a cheerful
   * `liked: true` over a row that was never written.
   */
  it('recognises the numeric E11000 code, and nothing that merely resembles it', () => {
    expect(isDuplicateKeyError({ code: 11000 })).toBe(true);
    expect(isDuplicateKeyError(Object.assign(new Error('E11000 dup key'), { code: 11000 }))).toBe(
      true,
    );

    // A MESSAGE is not a code. An error whose text happens to contain E11000 —
    // a wrapped error, a log line replayed as an Error — is not the driver
    // saying a unique index rejected a write.
    expect(isDuplicateKeyError(new Error('E11000 duplicate key error'))).toBe(false);
    // The driver's `code` is a number. A string would mean this came from
    // somewhere else, and coercing would widen what gets swallowed.
    expect(isDuplicateKeyError({ code: '11000' })).toBe(false);
    expect(isDuplicateKeyError({ code: 11001 })).toBe(false);
    expect(isDuplicateKeyError({})).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
    expect(isDuplicateKeyError(undefined)).toBe(false);
    expect(isDuplicateKeyError('E11000')).toBe(false);
    expect(isDuplicateKeyError(11000)).toBe(false);
  });
});
