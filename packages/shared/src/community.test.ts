import { MAX_CAPTION_LENGTH } from './community';

describe('MAX_CAPTION_LENGTH', () => {
  /**
   * This pins the NUMBER, and it is the only test in this task that can.
   *
   * Every other caption assertion — in the route, in the schema, in the mobile
   * composer — is written relative to this constant, which is exactly what
   * stops the layers drifting apart. The same property makes them all blind to
   * a change in the constant itself: raise it to 5000 and the API silently
   * accepts 5000-character captions with every one of those tests still green,
   * because they all moved with it.
   *
   * 280 is a product decision, not an implementation detail, so it is asserted
   * as a literal here and nowhere else.
   */
  it('is 280 — the documented caption bound, changed only deliberately', () => {
    expect(MAX_CAPTION_LENGTH).toBe(280);
  });
});
