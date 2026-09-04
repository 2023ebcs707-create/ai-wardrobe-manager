import { consumeOutfitsDirty } from '../../src/outfits/outfitsDirty';
import {
  TRACKING_READERS,
  consumeTrackingDirty,
  markTrackingDirty,
} from '../../src/tracking/trackingDirty';

/**
 * The extension of Stage 5's `outfitsDirty` pattern that Stage 6 needs, and
 * the test that says WHY it had to be an extension rather than a reuse.
 *
 * `consumeOutfitsDirty` reads AND clears, and its own header states the
 * consequence in as many words: "exactly one reader may act on a given change
 * — which is correct here, because there is exactly one gallery." Tracking has
 * two readers. A laundry toggle changes what the wardrobe grid must draw AND
 * what the Profile tab's analytics say, and with one shared bit whichever tab
 * the user opened first would consume it and the other would never learn
 * anything. So the bit is per reader; `markTrackingDirty` sets all of them.
 */
describe('trackingDirty', () => {
  beforeEach(() => {
    // Through the public door rather than a test-only reset, exactly as
    // `outfitsDirty`'s own suite does: module state is shared between the
    // tests in this file, and a leftover mark would make a "did not mark"
    // assertion depend on execution order.
    TRACKING_READERS.forEach((reader) => consumeTrackingDirty(reader));
    consumeOutfitsDirty();
  });

  it('starts clean for every reader', () => {
    TRACKING_READERS.forEach((reader) => {
      expect(consumeTrackingDirty(reader)).toBe(false);
    });
  });

  it('marks every reader at once', () => {
    markTrackingDirty();
    TRACKING_READERS.forEach((reader) => {
      expect(consumeTrackingDirty(reader)).toBe(true);
    });
  });

  it('lets one reader consume without blinding the other', () => {
    // THE reason this module exists. Under a single shared bit this is the
    // test that fails: the wardrobe consumes, and Profile is told nothing ever
    // happened.
    markTrackingDirty();

    expect(consumeTrackingDirty('wardrobe')).toBe(true);
    expect(consumeTrackingDirty('profile')).toBe(true);
  });

  it('consumes rather than merely reads', () => {
    markTrackingDirty();

    expect(consumeTrackingDirty('wardrobe')).toBe(true);
    // Otherwise one toggle would refetch on every focus for the rest of the
    // session.
    expect(consumeTrackingDirty('wardrobe')).toBe(false);
  });

  it('collapses repeated marks into one', () => {
    // A user toggling three items before returning to the grid has changed it
    // once as far as the reader is concerned: its answer to any number of
    // changes is one page-one reload.
    markTrackingDirty();
    markTrackingDirty();
    markTrackingDirty();

    expect(consumeTrackingDirty('wardrobe')).toBe(true);
    expect(consumeTrackingDirty('wardrobe')).toBe(false);
  });

  it('re-arms after a consume', () => {
    markTrackingDirty();
    expect(consumeTrackingDirty('profile')).toBe(true);

    markTrackingDirty();
    expect(consumeTrackingDirty('profile')).toBe(true);
  });

  it('marks only the readers it is given', () => {
    // Added in Task 5, for the one write whose effect is genuinely one-sided:
    // deleting an outfit changes what a PAST wear event reads back as (the API
    // resolves `outfitName` at read time, so the row becomes nameless) and
    // changes nothing at all in the wardrobe grid. Marking both would make the
    // grid discard its scrolled pages to reload a list that did not move.
    markTrackingDirty(['profile']);

    expect(consumeTrackingDirty('wardrobe')).toBe(false);
    expect(consumeTrackingDirty('profile')).toBe(true);
  });

  it('marks nothing for an empty subset', () => {
    // A degenerate call, asserted because the obvious "no readers means all
    // readers" defaulting is silently wrong: it would turn a caller that
    // computed an empty set into a whole-app refetch.
    markTrackingDirty([]);

    TRACKING_READERS.forEach((reader) => {
      expect(consumeTrackingDirty(reader)).toBe(false);
    });
  });

  it('does not disturb the outfit gallery flag', () => {
    // The two signals are separate bits on purpose. Folding tracking into
    // `outfitsDirty` would make every laundry toggle refetch page one of the
    // outfit gallery — a list that has not changed — and would throw away the
    // gallery's scrolled pages to do it.
    markTrackingDirty();

    expect(consumeOutfitsDirty()).toBe(false);
  });
});
