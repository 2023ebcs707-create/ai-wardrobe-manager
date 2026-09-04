import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { compressForUpload, MAX_UPLOAD_DIMENSION, COMPRESSION_QUALITY } from './compress';

jest.mock('expo-image-manipulator', () => {
  const saveAsync = jest.fn();
  const renderAsync = jest.fn();
  const resize = jest.fn();
  const manipulate = jest.fn();
  // The context and the rendered image are separate native shared objects
  // with separate `release()`s, so they get separate mocks -- one shared spy
  // could not tell "released both" from "released the same one twice".
  const releaseContext = jest.fn();
  const releaseImage = jest.fn();
  // Present on the mock (rather than merely absent) so the test below can
  // assert the deprecated entry point was NOT called. With it missing, an
  // implementation that used it would fail with a TypeError instead of the
  // assertion that names the actual rule.
  const manipulateAsync = jest.fn();
  return {
    __esModule: true,
    ImageManipulator: { manipulate },
    manipulateAsync,
    SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
    __mocks: { saveAsync, renderAsync, resize, manipulate, manipulateAsync, releaseContext, releaseImage },
  };
});

const mocks = (jest.requireMock('expo-image-manipulator') as { __mocks: Record<string, jest.Mock> }).__mocks;

function wireChain(result: { uri: string; width: number; height: number }) {
  mocks.saveAsync.mockResolvedValue(result);
  mocks.renderAsync.mockResolvedValue({ saveAsync: mocks.saveAsync, release: mocks.releaseImage });
  const context = { resize: mocks.resize, renderAsync: mocks.renderAsync, release: mocks.releaseContext };
  mocks.resize.mockReturnValue(context);
  mocks.manipulate.mockReturnValue(context);
}

describe('compressForUpload', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns the compressed result', async () => {
    wireChain({ uri: 'file:///tmp/small.jpg', width: 1280, height: 960 });
    await expect(
      compressForUpload({ uri: 'file:///tmp/big.jpg', width: 4000, height: 3000 }),
    ).resolves.toEqual({ uri: 'file:///tmp/small.jpg', width: 1280, height: 960 });
  });

  describe('resize decision', () => {
    // Passing a single dimension to `resize` preserves aspect ratio, so the
    // dimension we pass MUST be the longer edge or the long edge stays oversized.
    it('resizes a landscape image (width > height) by width', async () => {
      wireChain({ uri: 'file:///tmp/small.jpg', width: MAX_UPLOAD_DIMENSION, height: 960 });
      await compressForUpload({ uri: 'file:///tmp/big.jpg', width: 4000, height: 3000 });
      expect(mocks.resize).toHaveBeenCalledWith({ width: MAX_UPLOAD_DIMENSION });
    });

    it('resizes a portrait image (height > width) by height, not width', async () => {
      wireChain({ uri: 'file:///tmp/small.jpg', width: 960, height: MAX_UPLOAD_DIMENSION });
      await compressForUpload({ uri: 'file:///tmp/big.jpg', width: 3000, height: 4000 });
      expect(mocks.resize).toHaveBeenCalledWith({ height: MAX_UPLOAD_DIMENSION });
    });

    it('resizes a square image by width', async () => {
      wireChain({ uri: 'file:///tmp/small.jpg', width: MAX_UPLOAD_DIMENSION, height: MAX_UPLOAD_DIMENSION });
      await compressForUpload({ uri: 'file:///tmp/big.jpg', width: 2000, height: 2000 });
      expect(mocks.resize).toHaveBeenCalledWith({ width: MAX_UPLOAD_DIMENSION });
    });

    // These two "no resize needed" cases still MUST compress: a small-but-heavy
    // image (e.g. 800x600 at several MB) is exactly the case TC-14 cares about,
    // and it's the least visible failure mode — a manual device test tends to
    // use a big photo, which resizes and therefore compresses regardless. A
    // mutant that short-circuits the no-resize path (returning the raw
    // `CapturedImage` without ever calling renderAsync/saveAsync) would still
    // pass a test that only checks `resize` was skipped, so each fixture below
    // uses a distinct input/output uri: if the mutant returns the input
    // unchanged, `result` carries the "original-*" uri instead of the
    // "compressed-*" one that only `saveAsync`'s mocked resolution produces.
    it('does not resize, but still compresses, an image already smaller than the max dimension', async () => {
      wireChain({ uri: 'file:///tmp/compressed-800.jpg', width: 800, height: 600 });
      const result = await compressForUpload({
        uri: 'file:///tmp/original-800.jpg',
        width: 800,
        height: 600,
      });
      expect(mocks.resize).not.toHaveBeenCalled();
      expect(mocks.saveAsync).toHaveBeenCalledWith({
        compress: COMPRESSION_QUALITY,
        format: SaveFormat.JPEG,
      });
      expect(result).toEqual({ uri: 'file:///tmp/compressed-800.jpg', width: 800, height: 600 });
    });

    it('does not resize, but still compresses, when the longest edge is exactly at the max dimension', async () => {
      wireChain({ uri: 'file:///tmp/compressed-exact.jpg', width: MAX_UPLOAD_DIMENSION, height: 960 });
      const result = await compressForUpload({
        uri: 'file:///tmp/original-exact.jpg',
        width: MAX_UPLOAD_DIMENSION,
        height: 960,
      });
      expect(mocks.resize).not.toHaveBeenCalled();
      expect(mocks.saveAsync).toHaveBeenCalledWith({
        compress: COMPRESSION_QUALITY,
        format: SaveFormat.JPEG,
      });
      expect(result).toEqual({
        uri: 'file:///tmp/compressed-exact.jpg',
        width: MAX_UPLOAD_DIMENSION,
        height: 960,
      });
    });

    it('resizes when the longest edge is one pixel over the max dimension', async () => {
      wireChain({ uri: 'file:///tmp/small.jpg', width: MAX_UPLOAD_DIMENSION, height: 960 });
      await compressForUpload({
        uri: 'file:///tmp/big.jpg',
        width: MAX_UPLOAD_DIMENSION + 1,
        height: 960,
      });
      expect(mocks.resize).toHaveBeenCalledWith({ width: MAX_UPLOAD_DIMENSION });
    });
  });

  it('saves as JPEG at the configured quality', async () => {
    wireChain({ uri: 'file:///tmp/small.jpg', width: 1280, height: 960 });
    await compressForUpload({ uri: 'file:///tmp/big.jpg', width: 4000, height: 3000 });
    expect(mocks.saveAsync).toHaveBeenCalledWith({
      compress: COMPRESSION_QUALITY,
      format: SaveFormat.JPEG,
    });
  });

  it('uses the contextual manipulate API, not the deprecated manipulateAsync', async () => {
    wireChain({ uri: 'file:///tmp/small.jpg', width: 1280, height: 960 });
    await compressForUpload({ uri: 'file:///tmp/big.jpg', width: 4000, height: 3000 });
    expect(mocks.manipulate).toHaveBeenCalledWith('file:///tmp/big.jpg');
    expect(mocks.renderAsync).toHaveBeenCalled();
    expect(ImageManipulator.manipulate).toHaveBeenCalled();
    // The negative half of the title, actually asserted: `manipulateAsync`
    // warns at runtime in SDK 57.
    expect(mocks.manipulateAsync).not.toHaveBeenCalled();
  });

  // Precautionary, not a fix for a measured leak: these hold native image
  // bitmaps, which is the one case expo-modules-core's own `release()` docs
  // name as worth managing by hand. The library's deprecated `manipulateAsync`
  // releases both for the same reason.
  describe('native shared objects', () => {
    it('releases both the context and the rendered image', async () => {
      wireChain({ uri: 'file:///tmp/small.jpg', width: 1280, height: 960 });
      await compressForUpload({ uri: 'file:///tmp/big.jpg', width: 4000, height: 3000 });
      expect(mocks.releaseContext).toHaveBeenCalledTimes(1);
      expect(mocks.releaseImage).toHaveBeenCalledTimes(1);
    });

    // The error path is the one that can least afford to leak a full-size
    // bitmap: it is reached precisely when the device is under memory
    // pressure. A straight-line release after `saveAsync` would skip it.
    it('releases the context even when rendering fails', async () => {
      wireChain({ uri: 'file:///tmp/small.jpg', width: 1280, height: 960 });
      mocks.renderAsync.mockRejectedValue(new Error('out of memory'));

      await expect(
        compressForUpload({ uri: 'file:///tmp/big.jpg', width: 4000, height: 3000 }),
      ).rejects.toThrow('out of memory');

      expect(mocks.releaseContext).toHaveBeenCalledTimes(1);
      // Nothing was rendered, so there is no image to release.
      expect(mocks.releaseImage).not.toHaveBeenCalled();
    });

    it('releases both when saving fails', async () => {
      wireChain({ uri: 'file:///tmp/small.jpg', width: 1280, height: 960 });
      mocks.saveAsync.mockRejectedValue(new Error('no space left on device'));

      await expect(
        compressForUpload({ uri: 'file:///tmp/big.jpg', width: 4000, height: 3000 }),
      ).rejects.toThrow('no space left on device');

      expect(mocks.releaseContext).toHaveBeenCalledTimes(1);
      expect(mocks.releaseImage).toHaveBeenCalledTimes(1);
    });
  });

  // Both constants are otherwise only ever asserted against their own imported
  // value (e.g. `toHaveBeenCalledWith({ width: MAX_UPLOAD_DIMENSION })`), which
  // would still pass even if the constant's value changed. Pin them directly.
  it('pins the compression constants so accidental changes are caught', () => {
    expect(MAX_UPLOAD_DIMENSION).toBe(1280);
    expect(COMPRESSION_QUALITY).toBe(0.7);
  });
});
