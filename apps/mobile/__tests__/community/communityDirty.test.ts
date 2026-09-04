import {
  COMMUNITY_READERS,
  consumeCommunityDirty,
  markCommunityDirty,
  type CommunityReader,
} from '../../src/community/communityDirty';

// Drained through the public door rather than a test-only reset, so these
// tests use exactly the mechanism the app does. Module scope means one set per
// test FILE, so this only has to keep tests inside this file honest.
beforeEach(() => {
  COMMUNITY_READERS.forEach((reader) => consumeCommunityDirty(reader));
});

describe('communityDirty', () => {
  it('starts clean', async () => {
    COMMUNITY_READERS.forEach((reader) => {
      expect(consumeCommunityDirty(reader)).toBe(false);
    });
  });

  it('marks every reader by default', async () => {
    // The safe direction: a caller who forgets to think about which screens a
    // write touches costs at most one unnecessary page-one fetch, whereas a
    // default of "none" would be a screen that silently never refreshes.
    markCommunityDirty();

    COMMUNITY_READERS.forEach((reader) => {
      expect(consumeCommunityDirty(reader)).toBe(true);
    });
  });

  it('gives each reader its own bit, so one screen consuming does not blind the other', async () => {
    // This is the whole reason this is not `outfitsDirty`, whose single bit is
    // read AND cleared by one consumer. The feed and the saved list are on
    // different tabs; with one shared bit, whichever the user opened first
    // would spend the change and the other would be told nothing had happened
    // — a stale screen that no amount of navigating fixes.
    markCommunityDirty();

    expect(consumeCommunityDirty('feed')).toBe(true);
    expect(consumeCommunityDirty('saved')).toBe(true);
  });

  it('marks only the readers it is given', async () => {
    // A save changes the saved list and does not move a single row in the
    // feed. Marking the feed too would throw away its scrolled pages to reload
    // a list that did not change — the exact regression a focus gate exists to
    // prevent, arriving through the signal instead of through the effect.
    markCommunityDirty(['saved']);

    expect(consumeCommunityDirty('feed')).toBe(false);
    expect(consumeCommunityDirty('saved')).toBe(true);
  });

  it('marks nothing for an empty array', async () => {
    // The obvious "no readers means all readers" defaulting would turn a
    // caller that computed an empty set into a whole-app refetch, which is the
    // opposite of what it asked for.
    markCommunityDirty([]);

    COMMUNITY_READERS.forEach((reader) => {
      expect(consumeCommunityDirty(reader)).toBe(false);
    });
  });

  it('consumes rather than merely reads', async () => {
    // Without this, one share causes a refetch on every subsequent focus for
    // the rest of the session.
    markCommunityDirty(['feed']);

    expect(consumeCommunityDirty('feed')).toBe(true);
    expect(consumeCommunityDirty('feed')).toBe(false);
  });

  it('is idempotent per reader', async () => {
    markCommunityDirty(['feed']);
    markCommunityDirty(['feed']);

    expect(consumeCommunityDirty('feed')).toBe(true);
    expect(consumeCommunityDirty('feed')).toBe(false);
  });

  it('names exactly the two readers this stage has', async () => {
    // The union is closed on purpose: a typo'd reader id would be a screen
    // that silently never refreshes, which is precisely what this module
    // exists to prevent. Walking the exported array rather than restating it
    // means adding a reader is a deliberate act that shows up here.
    const readers: CommunityReader[] = [...COMMUNITY_READERS];
    expect(readers).toEqual(['feed', 'saved']);
  });
});
