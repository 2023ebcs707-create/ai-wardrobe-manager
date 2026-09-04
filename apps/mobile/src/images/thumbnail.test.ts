import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import {
  createThumbnail,
  THUMBNAIL_DIMENSION,
  THUMBNAIL_QUALITY,
  THUMBNAIL_MIME_TYPE,
} from './thumbnail';

// Same mock shape compress.test.ts uses for this library, deliberately: one
// module, one mocking convention. A second variant would drift.
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

describe('createThumbnail', () => {
  afterEach(() => jest.clearAllMocks());

  // Passing a single dimension to `resize` preserves aspect ratio, so the
  // dimension passed MUST be the longer edge — otherwise the long edge stays
  // oversized and the grid decodes a near-full-size image per tile, which is
  // the entire cost this module exists to avoid.
  it('caps the longer edge at THUMBNAIL_DIMENSION for a landscape image', async () => {
    wireChain({ uri: 'file:///tmp/thumb.jpg', width: THUMBNAIL_DIMENSION, height: 240 });
    await createThumbnail({ uri: 'file:///tmp/big.jpg', width: 4000, height: 3000 });
    expect(mocks.resize).toHaveBeenCalledWith({ width: THUMBNAIL_DIMENSION });
  });

  it('caps the longer edge at THUMBNAIL_DIMENSION for a portrait image', async () => {
    wireChain({ uri: 'file:///tmp/thumb.jpg', width: 240, height: THUMBNAIL_DIMENSION });
    await createThumbnail({ uri: 'file:///tmp/big.jpg', width: 3000, height: 4000 });
    expect(mocks.resize).toHaveBeenCalledWith({ height: THUMBNAIL_DIMENSION });
  });

  it('still resizes a square image', async () => {
    wireChain({ uri: 'file:///tmp/thumb.jpg', width: THUMBNAIL_DIMENSION, height: THUMBNAIL_DIMENSION });
    await createThumbnail({ uri: 'file:///tmp/big.jpg', width: 2000, height: 2000 });
    expect(mocks.resize).toHaveBeenCalledWith({ width: THUMBNAIL_DIMENSION });
  });

  it('always saves as JPEG at THUMBNAIL_QUALITY', async () => {
    wireChain({ uri: 'file:///tmp/thumb.jpg', width: THUMBNAIL_DIMENSION, height: 240 });
    await createThumbnail({ uri: 'file:///tmp/big.jpg', width: 4000, height: 3000 });
    expect(mocks.saveAsync).toHaveBeenCalledWith({
      compress: THUMBNAIL_QUALITY,
      format: SaveFormat.JPEG,
    });
  });

  // Unlike compressForUpload — which skips the resize entirely for a source
  // already under its cap — this module must never short-circuit: a 100x80
  // source returned untouched would be uploaded as the "thumbnail" at
  // whatever quality it already had. The input and output uris differ so a
  // mutant that returns the source unchanged is caught by the last
  // assertion, not just by the resize call.
  it('resizes even when the source is already smaller than the cap', async () => {
    wireChain({ uri: 'file:///tmp/thumb-small.jpg', width: 100, height: 80 });
    const result = await createThumbnail({ uri: 'file:///tmp/source-small.jpg', width: 100, height: 80 });

    // Capped, not stretched: THUMBNAIL_DIMENSION is a ceiling, so a source
    // under it keeps its own longer edge. Upscaling to 320 here would spend
    // bytes inventing detail the source does not contain.
    expect(mocks.resize).toHaveBeenCalledWith({ width: 100 });
    expect(mocks.saveAsync).toHaveBeenCalledWith({
      compress: THUMBNAIL_QUALITY,
      format: SaveFormat.JPEG,
    });
    expect(result).toEqual({ uri: 'file:///tmp/thumb-small.jpg', width: 100, height: 80 });
  });

  // The caller records these on the item it uploads; reporting the source's
  // 4000x3000 would describe an image that was never produced.
  it('reports the produced dimensions, not the source dimensions', async () => {
    wireChain({ uri: 'file:///tmp/thumb.jpg', width: THUMBNAIL_DIMENSION, height: 240 });
    const result = await createThumbnail({ uri: 'file:///tmp/big.jpg', width: 4000, height: 3000 });
    expect(result).toEqual({ uri: 'file:///tmp/thumb.jpg', width: THUMBNAIL_DIMENSION, height: 240 });
  });

  it('uses the contextual manipulate API, not the deprecated manipulateAsync', async () => {
    wireChain({ uri: 'file:///tmp/thumb.jpg', width: THUMBNAIL_DIMENSION, height: 240 });
    await createThumbnail({ uri: 'file:///tmp/big.jpg', width: 4000, height: 3000 });
    expect(mocks.manipulate).toHaveBeenCalledWith('file:///tmp/big.jpg');
    expect(mocks.renderAsync).toHaveBeenCalled();
    expect(ImageManipulator.manipulate).toHaveBeenCalled();
    // The negative half of the title, actually asserted rather than left to
    // the mock's omission: `manipulateAsync` warns at runtime in SDK 57.
    expect(mocks.manipulateAsync).not.toHaveBeenCalled();
  });

  // Precautionary, not a fix for a measured leak: these hold native image
  // bitmaps, which is the one case expo-modules-core's own `release()` docs
  // name as worth managing by hand. This module runs on the same original the
  // caller has just fed to `compressForUpload`, so it doubles the number of
  // un-released contexts and ImageRefs per save.
  describe('native shared objects', () => {
    it('releases both the context and the rendered image', async () => {
      wireChain({ uri: 'file:///tmp/thumb.jpg', width: THUMBNAIL_DIMENSION, height: 240 });
      await createThumbnail({ uri: 'file:///tmp/big.jpg', width: 4000, height: 3000 });
      expect(mocks.releaseContext).toHaveBeenCalledTimes(1);
      expect(mocks.releaseImage).toHaveBeenCalledTimes(1);
    });

    // The error path is the one that can least afford to leak a full-size
    // bitmap: it is reached precisely when the device is under memory
    // pressure. A straight-line release after `saveAsync` would skip it.
    it('releases the context even when rendering fails', async () => {
      wireChain({ uri: 'file:///tmp/thumb.jpg', width: THUMBNAIL_DIMENSION, height: 240 });
      mocks.renderAsync.mockRejectedValue(new Error('out of memory'));

      await expect(
        createThumbnail({ uri: 'file:///tmp/big.jpg', width: 4000, height: 3000 }),
      ).rejects.toThrow('out of memory');

      expect(mocks.releaseContext).toHaveBeenCalledTimes(1);
      // Nothing was rendered, so there is no image to release.
      expect(mocks.releaseImage).not.toHaveBeenCalled();
    });

    it('releases both when saving fails', async () => {
      wireChain({ uri: 'file:///tmp/thumb.jpg', width: THUMBNAIL_DIMENSION, height: 240 });
      mocks.saveAsync.mockRejectedValue(new Error('no space left on device'));

      await expect(
        createThumbnail({ uri: 'file:///tmp/big.jpg', width: 4000, height: 3000 }),
      ).rejects.toThrow('no space left on device');

      expect(mocks.releaseContext).toHaveBeenCalledTimes(1);
      expect(mocks.releaseImage).toHaveBeenCalledTimes(1);
    });
  });

  // Every assertion above compares a constant against its own imported
  // value, so all of them would still pass if the constant itself changed.
  // Pin the values directly. THUMBNAIL_MIME_TYPE is included because
  // uploadItem asserts the produced file's type against it before attaching
  // the part — if it drifted from `format: SaveFormat.JPEG` above, every
  // real upload would throw on device with nothing here to catch it.
  it('pins the thumbnail constants so accidental changes are caught', () => {
    expect(THUMBNAIL_DIMENSION).toBe(320);
    expect(THUMBNAIL_QUALITY).toBe(0.6);
    expect(THUMBNAIL_MIME_TYPE).toBe('image/jpeg');
  });
});
