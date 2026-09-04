import { Types } from 'mongoose';
import type { PublicClothingItem } from '@wardrobe/shared';
import { User, type UserDoc } from './User';
import { CommunityPost, toPostAuthor, toPublicPost, type CommunityPostDoc } from './CommunityPost';

/**
 * These are UNIT tests, deliberately, and they exist because the integration
 * tests cannot see what they check.
 *
 * `POST /community/posts` can only ever produce `likeCount: 0`, `liked: false`
 * and `saved: false`, so a mapper that ignored its arguments and hard-coded
 * those three values would pass every test in `community.integration.test.ts`.
 * The feed and the like endpoint are the callers that would then be silently
 * wrong — two tasks later, against a signature the brief fixed here precisely
 * so it would not have to change. The fixtures below therefore use values that
 * a hard-coded implementation CANNOT produce.
 *
 * No database connection: a Mongoose document can be constructed offline, and
 * a pure mapping function has no business needing a server to test.
 */
function postDoc(overrides: Partial<Record<string, unknown>> = {}): CommunityPostDoc {
  const doc = new CommunityPost({
    userId: new Types.ObjectId(),
    outfitId: new Types.ObjectId(),
    itemIds: [new Types.ObjectId(), new Types.ObjectId()],
    caption: 'A caption',
    ...overrides,
  }) as CommunityPostDoc;
  // `timestamps: true` stamps this on save; these documents are never saved.
  doc.createdAt = new Date('2026-08-25T09:15:00.000Z');
  return doc;
}

const item = (id: string): PublicClothingItem =>
  ({ id, imageUrl: `https://signed.example/${id}` }) as PublicClothingItem;

const author = { id: 'author-1', name: 'Ada Lovelace' };

describe('toPublicPost', () => {
  it('passes liked and saved through rather than assuming a fresh post', () => {
    // Both true is a state `POST /community/posts` can never produce.
    const post = toPublicPost(postDoc(), { items: [], author, liked: true, saved: true });
    expect(post.liked).toBe(true);
    expect(post.saved).toBe(true);

    const mixed = toPublicPost(postDoc(), { items: [], author, liked: false, saved: true });
    expect(mixed.liked).toBe(false);
    expect(mixed.saved).toBe(true);
  });

  it('reports the stored like count, not a constant', () => {
    expect(
      toPublicPost(postDoc({ likeCount: 7 }), { items: [], author, liked: false, saved: false })
        .likeCount,
    ).toBe(7);
    expect(
      toPublicPost(postDoc({ likeCount: 0 }), { items: [], author, liked: false, saved: false })
        .likeCount,
    ).toBe(0);
  });

  it('carries the author it is given', () => {
    const post = toPublicPost(postDoc(), {
      items: [],
      author: { id: 'u-9', name: 'Grace Hopper', avatarUrl: 'https://cdn.example/grace.png' },
      liked: false,
      saved: false,
    });
    expect(post.author).toEqual({
      id: 'u-9',
      name: 'Grace Hopper',
      avatarUrl: 'https://cdn.example/grace.png',
    });
  });

  it('stringifies the snapshotted ids in stored order', () => {
    const ids = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
    const doc = postDoc({ itemIds: [ids[2], ids[0], ids[1]] });

    const post = toPublicPost(doc, { items: [], author, liked: false, saved: false });

    expect(post.itemIds).toEqual([ids[2], ids[0], ids[1]].map(String));
    expect(post.itemIds.every((id) => typeof id === 'string')).toBe(true);
  });

  it('keeps items independent of itemIds, and tolerates an empty or shorter list', () => {
    // Ruling 4: `items` is compacted and `itemIds` is not, so they are NOT
    // parallel arrays. A mapper that derived one from the other would make
    // that impossible to express.
    const doc = postDoc();
    const stored = doc.itemIds.map(String);

    const partial = toPublicPost(doc, {
      items: [item(stored[1]!)],
      author,
      liked: false,
      saved: false,
    });
    expect(partial.itemIds).toEqual(stored);
    expect(partial.items.map((i) => i.id)).toEqual([stored[1]]);

    const empty = toPublicPost(doc, { items: [], author, liked: false, saved: false });
    expect(empty.items).toEqual([]);
    expect(empty.itemIds).toEqual(stored);
  });

  it('never publishes the source outfit id or the raw document', () => {
    const doc = postDoc();
    const post = toPublicPost(doc, { items: [], author, liked: false, saved: false });

    expect(post).not.toHaveProperty('outfitId');
    expect(post).not.toHaveProperty('userId');
    expect(JSON.stringify(post)).not.toContain(String(doc.outfitId));
    expect(JSON.stringify(post)).not.toContain(String(doc.userId));
  });

  it('renders createdAt as an ISO string', () => {
    const post = toPublicPost(postDoc(), { items: [], author, liked: false, saved: false });
    expect(post.createdAt).toBe('2026-08-25T09:15:00.000Z');
  });

  it('returns exactly the documented keys', () => {
    const post = toPublicPost(postDoc(), { items: [], author, liked: true, saved: false });
    expect(Object.keys(post).sort()).toEqual(
      ['author', 'caption', 'createdAt', 'id', 'itemIds', 'items', 'likeCount', 'liked', 'saved'].sort(),
    );
  });
});

describe('toPostAuthor', () => {
  function userDoc(overrides: Record<string, unknown> = {}): UserDoc {
    return new User({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      passwordHash: 'not-a-real-hash',
      ...overrides,
    }) as UserDoc;
  }

  it('carries the id and name', () => {
    const doc = userDoc();
    expect(toPostAuthor(doc)).toEqual({ id: String(doc._id), name: 'Ada Lovelace' });
  });

  it('OMITS avatarUrl rather than setting it to undefined when there is none', () => {
    // The distinction `toPublicUser` already makes: a client must not be able
    // to tell "absent" from "present but undefined" and start branching on it.
    const author = toPostAuthor(userDoc());
    expect('avatarUrl' in author).toBe(false);
  });

  it('includes avatarUrl when the user has one', () => {
    expect(toPostAuthor(userDoc({ avatarUrl: 'https://cdn.example/ada.png' })).avatarUrl).toBe(
      'https://cdn.example/ada.png',
    );
  });

  it('never leaks the email address or the password hash into a feed', () => {
    // The community feed is the one place in this API where one user's record
    // is handed to a different user. `toPublicUser` carries an email; this
    // must not, and it must not be quietly refactored into reusing it.
    const author = toPostAuthor(userDoc());
    expect(JSON.stringify(author)).not.toContain('ada@example.com');
    expect(JSON.stringify(author)).not.toContain('not-a-real-hash');
    expect(Object.keys(author).sort()).toEqual(['id', 'name']);
  });
});
