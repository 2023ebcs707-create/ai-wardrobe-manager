import type { PublicClothingItem } from '@wardrobe/shared';
import { uploadItem, updateItemCategory } from './uploadItem';
import { apiRequest, ApiClientError } from '../api/client';
import { COMPRESSED_MIME_TYPE } from '../images/compress';
import { THUMBNAIL_MIME_TYPE } from '../images/thumbnail';

// Automocking `../api/client` would also automock `ApiClientError`, and Jest's
// automocking of a class that `extends Error` does not run the real
// constructor — the tests below that check `err.code === 'NETWORK'` need the
// real class. Keep it real; automock only `apiRequest`. (Same trap AuthContext's
// tests document.)
jest.mock('../api/client', () => ({
  ...jest.requireActual('../api/client'),
  apiRequest: jest.fn(),
}));

// `expo-file-system`'s `File` wraps a native module Jest cannot run. Stand
// in a minimal fake carrying `uri`/`type`/`name` — the properties
// `uploadItem.ts` and `convertFormData` (on a real device) actually read.
// `type` defaults to a hardcoded 'image/jpeg' literal rather than importing
// `COMPRESSED_MIME_TYPE` deliberately: this factory must be fully
// self-contained. `jest.mock()` calls are hoisted above this file's
// imports — including `./uploadItem`, which itself imports
// `expo-file-system` — so any outer-scope variable (imported or declared)
// the factory closed over would still be unresolved the first time the
// factory actually runs (as a side effect of importing `./uploadItem`
// above, before line 4's `COMPRESSED_MIME_TYPE` import has executed). The
// mock is exposed as `__mockFile` on the mocked module itself and
// retrieved below via `jest.requireMock`, which is safe because by then
// all module-level code — including this factory's first run — has
// finished.
//
// `name` is derived from the uri rather than hardcoded so the `image` and
// `thumbnail` parts are distinguishable in the assertions below: with one
// fixed name, a mutant that attached the compressed image twice would be
// indistinguishable from one that attached the thumbnail correctly.
jest.mock('expo-file-system', () => {
  const mockFile = jest
    .fn()
    .mockImplementation((uri: string) => ({ uri, type: 'image/jpeg', name: uri.split('/').pop() }));
  return { File: mockFile, __mockFile: mockFile };
});

const { __mockFile: MockFile } = jest.requireMock('expo-file-system') as { __mockFile: jest.Mock };

const mockedApiRequest = apiRequest as jest.Mock;

const item: PublicClothingItem = {
  id: 'item-1',
  userId: 'user-1',
  imageUrl: 'https://minio.example/signed-url',
  category: 'jacket',
  colors: [],
  seasons: [],
  laundryStatus: 'available',
  retired: false,
  wearCount: 0,
  source: 'manual',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('uploadItem', () => {
  beforeEach(() => {
    // `resetAllMocks` below (kept from before this fix, and still needed
    // for `mockedApiRequest`) also clears any `mockImplementation` — on
    // EVERY jest.fn(), including ones created inside a jest.mock() factory
    // — so this needs to be re-armed before every test, not just once at
    // module load. Every test calls `uploadItem`, which always constructs
    // a `File`, not only the FormData-shape test below.
    MockFile.mockImplementation((uri: string) => ({ uri, type: 'image/jpeg', name: uri.split('/').pop() }));
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('returns the created item on a successful upload', async () => {
    mockedApiRequest.mockResolvedValue({ item });
    await expect(
      uploadItem({ uri: 'file:///tmp/compressed.jpg', category: 'jacket', token: 'tok-abc' }),
    ).resolves.toEqual(item);
  });

  it('posts to /items with the bearer token', async () => {
    mockedApiRequest.mockResolvedValue({ item });
    await uploadItem({ uri: 'file:///tmp/compressed.jpg', category: 'jacket', token: 'tok-abc' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      '/items',
      expect.objectContaining({ method: 'POST', token: 'tok-abc' }),
    );
  });

  it('sends a FormData body carrying the image, category, and seasons', async () => {
    mockedApiRequest.mockResolvedValue({ item });
    await uploadItem({
      uri: 'file:///tmp/compressed.jpg',
      category: 'jacket',
      seasons: ['winter', 'autumn'],
      token: 'tok-abc',
    });

    const [, options] = mockedApiRequest.mock.calls[0];
    const form = options.body as FormData;
    expect(form).toBeInstanceOf(FormData);

    expect(form.getAll('category')).toEqual(['jacket']);
    expect(form.getAll('seasons')).toEqual(['winter', 'autumn']);

    // `new File(uri)` must wrap the exact uri passed in, and that `File` —
    // not a `{uri,name,type}` object, and not a hand-built `Blob` (see
    // uploadItem.ts's comment for why both of those fail on a real device)
    // — must be what actually gets attached to the FormData part.
    expect(MockFile).toHaveBeenCalledWith('file:///tmp/compressed.jpg');

    const [imagePart] = form.getAll('image');
    expect(imagePart).toMatchObject({ uri: 'file:///tmp/compressed.jpg', type: 'image/jpeg' });
  });

  // Task 2 (Stage 4): the wardrobe grid renders `thumbnailUrl`, and nothing
  // has ever populated `thumbnailKey` server-side because nothing has ever
  // sent this part. The part name must be exactly 'thumbnail' -- that is what
  // `upload.fields` on the API keys on.
  it('attaches the thumbnail as a second file part when a thumbnailUri is given', async () => {
    mockedApiRequest.mockResolvedValue({ item });
    await uploadItem({
      uri: 'file:///tmp/compressed.jpg',
      thumbnailUri: 'file:///tmp/thumb.jpg',
      category: 'jacket',
      token: 'tok-abc',
    });

    const [, options] = mockedApiRequest.mock.calls[0];
    const form = options.body as FormData;

    // Both parts present, each wrapping its own uri -- not the compressed
    // image attached twice under two names.
    expect(MockFile).toHaveBeenCalledWith('file:///tmp/thumb.jpg');
    const [imagePart] = form.getAll('image');
    const [thumbnailPart] = form.getAll('thumbnail');
    expect(imagePart).toMatchObject({ uri: 'file:///tmp/compressed.jpg', name: 'compressed.jpg' });
    // The filename and type the part carries are the ones `createThumbnail`
    // actually produced, so the API's magic-byte check sees a declared type
    // that matches the bytes.
    expect(thumbnailPart).toMatchObject({
      uri: 'file:///tmp/thumb.jpg',
      name: 'thumb.jpg',
      type: THUMBNAIL_MIME_TYPE,
    });
  });

  // The API treats the part as optional so items uploaded before this stage
  // keep working with no backfill; sending an empty or duplicate part instead
  // of sending nothing would defeat that.
  it('omits the thumbnail part entirely when no thumbnailUri is given', async () => {
    mockedApiRequest.mockResolvedValue({ item });
    await uploadItem({ uri: 'file:///tmp/compressed.jpg', category: 'jacket', token: 'tok-abc' });

    const [, options] = mockedApiRequest.mock.calls[0];
    const form = options.body as FormData;
    expect(form.getAll('thumbnail')).toEqual([]);
    expect(form.getAll('image')).toHaveLength(1);
  });

  // The same defence-in-depth the image part gets, for the same reason: the
  // declared type is checked against the file's real magic bytes server-side,
  // so a drift between THUMBNAIL_MIME_TYPE and what `createThumbnail` saves
  // must fail loudly here rather than as an opaque 400 on device.
  it('rejects when the thumbnail file type does not match what createThumbnail is expected to emit', async () => {
    MockFile.mockImplementation((uri: string) =>
      uri.includes('thumb')
        ? { uri, type: 'image/png', name: 'thumb.png' }
        : { uri, type: 'image/jpeg', name: 'compressed.jpg' },
    );

    await expect(
      uploadItem({
        uri: 'file:///tmp/compressed.jpg',
        thumbnailUri: 'file:///tmp/thumb.jpg',
        category: 'jacket',
        token: 'tok-abc',
      }),
    ).rejects.toThrow(new RegExp(`image/png.*${THUMBNAIL_MIME_TYPE.replace('/', '\\/')}`));
    expect(mockedApiRequest).not.toHaveBeenCalled();
  });

  it('rejects when the file type does not match what compressForUpload is expected to emit', async () => {
    // Defence-in-depth (see uploadItem.ts's comment): compressForUpload
    // always saves as SaveFormat.JPEG, so File#type should always resolve
    // to COMPRESSED_MIME_TYPE. Pinned against the real shared constant
    // (not a hardcoded 'image/png' vs 'image/jpeg' pair) so this stays
    // meaningful if COMPRESSED_MIME_TYPE itself is ever changed.
    MockFile.mockImplementation((uri: string) => ({ uri, type: 'image/png', name: 'upload.png' }));

    await expect(
      uploadItem({ uri: 'file:///tmp/compressed.jpg', category: 'jacket', token: 'tok-abc' }),
    ).rejects.toThrow(new RegExp(`image/png.*${COMPRESSED_MIME_TYPE.replace('/', '\\/')}`));
    expect(mockedApiRequest).not.toHaveBeenCalled();
  });

  it('omits seasons fields entirely when none are given', async () => {
    mockedApiRequest.mockResolvedValue({ item });
    await uploadItem({ uri: 'file:///tmp/compressed.jpg', category: 'jacket', token: 'tok-abc' });

    const [, options] = mockedApiRequest.mock.calls[0];
    const form = options.body as FormData;
    expect(form.getAll('seasons')).toEqual([]);
  });

  it('surfaces a server error as ApiClientError', async () => {
    mockedApiRequest.mockRejectedValue(
      new ApiClientError('VALIDATION_FAILED', 'Unsupported image type', 400),
    );
    await expect(
      uploadItem({ uri: 'file:///tmp/compressed.jpg', category: 'jacket', token: 'tok-abc' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
  });

  it('surfaces a network failure as ApiClientError with code NETWORK', async () => {
    mockedApiRequest.mockRejectedValue(new ApiClientError('NETWORK', 'Cannot reach the server.'));
    await expect(
      uploadItem({ uri: 'file:///tmp/compressed.jpg', category: 'jacket', token: 'tok-abc' }),
    ).rejects.toBeInstanceOf(ApiClientError);
    await expect(
      uploadItem({ uri: 'file:///tmp/compressed.jpg', category: 'jacket', token: 'tok-abc' }),
    ).rejects.toMatchObject({ code: 'NETWORK' });
  });
});

// Task 5: the Add screen's override flow, once a save comes back with
// `source: 'ai'`. Every test here uses a category ('shoes') and id
// ('item-9') that differ from the module's default `item` fixture
// (category 'jacket', id 'item-1') deliberately — a hardcoded id or
// category in `updateItemCategory` would still pass any test that reused
// those defaults.
describe('updateItemCategory', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('PATCHes /items/:id, keyed on the given id, with the bearer token', async () => {
    mockedApiRequest.mockResolvedValue({ item: { ...item, id: 'item-9', category: 'shoes' } });
    await updateItemCategory({ id: 'item-9', category: 'shoes', token: 'tok-xyz' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      '/items/item-9',
      expect.objectContaining({ method: 'PATCH', token: 'tok-xyz' }),
    );
  });

  it('targets whatever id it is given, not a hardcoded one', async () => {
    mockedApiRequest.mockResolvedValue({ item: { ...item, id: 'item-different', category: 'shoes' } });
    await updateItemCategory({ id: 'item-different', category: 'shoes', token: 'tok-xyz' });

    const [path] = mockedApiRequest.mock.calls[0];
    expect(path).toBe('/items/item-different');
  });

  it('sends only the chosen category as the request body', async () => {
    mockedApiRequest.mockResolvedValue({ item: { ...item, id: 'item-9', category: 'shoes' } });
    await updateItemCategory({ id: 'item-9', category: 'shoes', token: 'tok-xyz' });

    const [, options] = mockedApiRequest.mock.calls[0];
    expect(options.body).toEqual({ category: 'shoes' });
  });

  it('resolves with the updated item returned by the server', async () => {
    const updated: PublicClothingItem = { ...item, id: 'item-9', category: 'shoes' };
    mockedApiRequest.mockResolvedValue({ item: updated });
    await expect(
      updateItemCategory({ id: 'item-9', category: 'shoes', token: 'tok-xyz' }),
    ).resolves.toEqual(updated);
  });

  it('surfaces a server error as ApiClientError', async () => {
    mockedApiRequest.mockRejectedValue(new ApiClientError('VALIDATION_FAILED', 'Unknown category', 400));
    await expect(
      updateItemCategory({ id: 'item-9', category: 'shoes', token: 'tok-xyz' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
  });

  it('surfaces a network failure as ApiClientError with code NETWORK', async () => {
    mockedApiRequest.mockRejectedValue(new ApiClientError('NETWORK', 'Cannot reach the server.'));
    await expect(
      updateItemCategory({ id: 'item-9', category: 'shoes', token: 'tok-xyz' }),
    ).rejects.toMatchObject({ code: 'NETWORK' });
  });
});
