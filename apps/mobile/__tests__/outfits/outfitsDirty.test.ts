import { consumeOutfitsDirty, markOutfitsDirty } from '../../src/outfits/outfitsDirty';

// The signal itself, tested apart from either screen that uses it. Its whole
// contract is two functions and one bit, and every property below is one a
// screen relies on without being able to observe it.

describe('outfitsDirty', () => {
  afterEach(() => {
    // Through the public door, not a test-only reset: module state is shared
    // between the tests in this file, and leaving it set would make the next
    // test's "starts clean" assertion depend on execution order.
    consumeOutfitsDirty();
  });

  it('starts clean', () => {
    expect(consumeOutfitsDirty()).toBe(false);
  });

  it('reports a mark, then clears it', () => {
    markOutfitsDirty();

    expect(consumeOutfitsDirty()).toBe(true);
    // The clear is the point. Without it one rename would refetch the gallery
    // on every focus for the rest of the session — the same always-refetch
    // behaviour, arrived at by a longer route.
    expect(consumeOutfitsDirty()).toBe(false);
  });

  it('collapses repeated marks into one consume', () => {
    markOutfitsDirty();
    markOutfitsDirty();
    markOutfitsDirty();

    expect(consumeOutfitsDirty()).toBe(true);
    // Three renames before the user goes back is still one reload. A counter
    // here would mean three page-one fetches on three consecutive focuses.
    expect(consumeOutfitsDirty()).toBe(false);
  });

  it('can be marked again after a consume', () => {
    markOutfitsDirty();
    expect(consumeOutfitsDirty()).toBe(true);

    markOutfitsDirty();

    // A latch that could only fire once would leave the gallery permanently
    // stale after the user's second edit.
    expect(consumeOutfitsDirty()).toBe(true);
  });
});
