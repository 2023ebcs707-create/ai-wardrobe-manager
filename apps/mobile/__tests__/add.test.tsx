import React from 'react';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react-native';
import { ITEM_CATEGORIES, type PublicClothingItem } from '@wardrobe/shared';
import AddScreen, { LOW_CONFIDENCE_THRESHOLD } from '../app/(tabs)/add';
import * as capture from '../src/images/capture';
import * as compress from '../src/images/compress';
import * as thumbnail from '../src/images/thumbnail';
import * as uploadItemModule from '../src/items/uploadItem';
import { useAuth } from '../src/auth/AuthContext';
import { ApiClientError } from '../src/api/client';
// The real signal module — four lines of module state, no dependencies, and its
// own suite at `__tests__/outfits/outfitsDirty.test.ts`. Mocking it would test
// that a function was passed; consuming it tests that the bit actually moved.
import { consumeOutfitsDirty } from '../src/outfits/outfitsDirty';

jest.mock('../src/images/capture');
jest.mock('../src/images/compress');
jest.mock('../src/images/thumbnail');
jest.mock('../src/items/uploadItem');
// A bare `jest.mock('../src/auth/AuthContext')` would also automock
// AuthProvider — not needed here since AddScreen only reads `useAuth`.
jest.mock('../src/auth/AuthContext', () => ({
  useAuth: jest.fn(),
}));

// Stage 5 Task 4. The composer has its own 33-test suite
// (`__tests__/outfits/OutfitComposer.test.tsx`); stubbing it here keeps this
// file about what the ADD SCREEN does — which of its two modes is on screen —
// and stops `useWardrobe` (and through it `src/api/client` and a real `fetch`)
// from being pulled in by a screen that has no wardrobe of its own to load.
// `require` inside the factory because a `jest.mock` factory may not close
// over anything but `mock`-prefixed names.
jest.mock('../src/outfits/OutfitComposer', () => ({
  OutfitComposer: ({
    onSavingChange,
    onSaved,
  }: {
    onSavingChange?: (saving: boolean) => void;
    onSaved?: (outfit: unknown) => void;
  }) => {
    const ReactModule = require('react');
    const { Pressable, View } = require('react-native');
    // The stub carries two controls, one per callback this screen supplies: a
    // way to put the composer into the saving state the real one reports
    // through `onSavingChange`, and a way to report a completed save through
    // `onSaved`. Both signals are the whole contract this screen consumes, and
    // the composer's own suite proves each is emitted.
    return ReactModule.createElement(
      View,
      { testID: 'outfit-composer' },
      ReactModule.createElement(Pressable, {
        testID: 'outfit-composer-begin-save',
        onPress: () => onSavingChange?.(true),
      }),
      ReactModule.createElement(Pressable, {
        testID: 'outfit-composer-finish-save',
        onPress: () => onSaved?.({ id: 'outfit-1' }),
      }),
    );
  },
}));

const mockedCapture = capture as jest.Mocked<typeof capture>;
const mockedCompress = compress as jest.Mocked<typeof compress>;
const mockedThumbnail = thumbnail as jest.Mocked<typeof thumbnail>;
const mockedUploadItem = uploadItemModule.uploadItem as jest.Mock;
const mockedUpdateItemCategory = uploadItemModule.updateItemCategory as jest.Mock;
const mockedUseAuth = useAuth as jest.Mock;

/**
 * Minimal shape of a React fiber, declared locally so this file does not take
 * a dependency on react-reconciler's types for one lookup. Same helper as
 * `__tests__/outfits/OutfitComposer.test.tsx`; duplicated rather than shared
 * because a `.ts` helper module under `__tests__/` is picked up by Jest's
 * default testMatch and fails as a suite with no tests.
 */
type FiberLike = { memoizedProps: Record<string, unknown>; return: FiberLike | null };

/**
 * The `onPress` handler the element was rendered with, as a callable.
 *
 * `fireEvent.press` cannot model a same-frame double tap: it wraps each press
 * in its own `act()`, so React re-renders between them and the second press
 * sees an already-disabled button. Two touch events dispatched in one frame do
 * not — they both call the handler instance that was on screen when the first
 * landed, which is exactly what this reproduces. (Two nested `fireEvent.press`
 * calls inside one outer `act` make React 19 log "You seem to have overlapping
 * act() calls", so that route is not available either.)
 */
function onPressOf(host: ReturnType<typeof screen.getByTestId>): () => void {
  let fiber = host.unstable_fiber as unknown as FiberLike | null;
  while (fiber !== null) {
    const handler = fiber.memoizedProps?.onPress;
    if (typeof handler === 'function') return handler as () => void;
    fiber = fiber.return;
  }
  throw new Error('No onPress handler found above the element');
}

const capturedImage = { uri: 'file:///tmp/captured.jpg', width: 3000, height: 4000 };
// Deliberately a DIFFERENT uri from capturedImage — this is what lets a test
// distinguish "compressForUpload ran and its result was uploaded" from "the
// raw capture was uploaded regardless" (TC-14, Task 7's non-negotiable #3).
const compressedImage = { uri: 'file:///tmp/compressed.jpg', width: 1280, height: 1707 };
// Distinct again from both of the above, for the same reason: it is what
// distinguishes "a real thumbnail was generated and sent" from "the compressed
// image (or the raw capture) was sent under the thumbnail's name".
const thumbnailImage = { uri: 'file:///tmp/thumb.jpg', width: 240, height: 320 };

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

async function pickAnImage() {
  mockedCapture.pickFromLibrary.mockResolvedValue({ status: 'ok', image: capturedImage });
  await render(<AddScreen />);
  await act(async () => fireEvent.press(screen.getByTestId('add-library')));
  await waitFor(() => expect(screen.getByTestId('add-preview')).toBeTruthy());
}

describe('AddScreen', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      status: 'authenticated',
      user: { id: 'user-1', name: 'Zaid', email: 'z@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
      token: 'tok-abc',
      signIn: jest.fn(),
      signUp: jest.fn(),
      signOut: jest.fn(),
    });
    mockedCompress.compressForUpload.mockResolvedValue(compressedImage);
    mockedThumbnail.createThumbnail.mockResolvedValue(thumbnailImage);
    mockedUploadItem.mockResolvedValue(item);
  });

  afterEach(() => {
    // Module state, shared between the tests in this file. Cleared through the
    // public door so a leftover mark cannot make a "did not mark" assertion
    // depend on execution order.
    consumeOutfitsDirty();
    jest.resetAllMocks();
  });

  it('renders camera and library buttons', async () => {
    await render(<AddScreen />);
    expect(screen.getByTestId('add-camera')).toBeTruthy();
    expect(screen.getByTestId('add-library')).toBeTruthy();
  });

  // The other end of Task 6's hide-after-save fix. "Hide it whenever no
  // image is staged" would pass every assertion about hiding below while
  // quietly removing the ability to choose a category before taking the
  // photo — a fix that overshoots into a second defect. The selector is
  // hidden by a COMPLETED save and by nothing else.
  it('shows the pre-upload category selector before any image has been picked', async () => {
    await render(<AddScreen />);
    expect(
      screen.getByTestId(`add-category-${ITEM_CATEGORIES[0]}`).props.accessibilityState?.selected,
    ).toBe(true);
  });

  describe("status: 'ok'", () => {
    it('shows a preview after picking from the library and enables saving', async () => {
      mockedCapture.pickFromLibrary.mockResolvedValue({ status: 'ok', image: capturedImage });
      await render(<AddScreen />);
      await act(async () => fireEvent.press(screen.getByTestId('add-library')));
      await waitFor(() => expect(screen.getByTestId('add-preview')).toBeTruthy());
      expect(screen.getByTestId('add-save').props.accessibilityState?.disabled).not.toBe(true);
    });

    it('shows a preview after capturing with the camera', async () => {
      mockedCapture.captureWithCamera.mockResolvedValue({ status: 'ok', image: capturedImage });
      await render(<AddScreen />);
      await act(async () => fireEvent.press(screen.getByTestId('add-camera')));
      await waitFor(() => expect(screen.getByTestId('add-preview')).toBeTruthy());
    });
  });

  describe("status: 'cancelled'", () => {
    it('does nothing when the library picker is cancelled', async () => {
      mockedCapture.pickFromLibrary.mockResolvedValue({ status: 'cancelled' });
      await render(<AddScreen />);
      await act(async () => fireEvent.press(screen.getByTestId('add-library')));
      await waitFor(() => expect(mockedCapture.pickFromLibrary).toHaveBeenCalled());
      expect(screen.queryByTestId('add-preview')).toBeNull();
      expect(screen.queryByTestId('add-error')).toBeNull();
    });

    it('does nothing when the camera is cancelled', async () => {
      mockedCapture.captureWithCamera.mockResolvedValue({ status: 'cancelled' });
      await render(<AddScreen />);
      await act(async () => fireEvent.press(screen.getByTestId('add-camera')));
      await waitFor(() => expect(mockedCapture.captureWithCamera).toHaveBeenCalled());
      expect(screen.queryByTestId('add-preview')).toBeNull();
      expect(screen.queryByTestId('add-error')).toBeNull();
    });
  });

  // The non-negotiable case: the button was tapped and nothing visibly
  // happened unless this renders 'add-error'. A screen that treated this
  // like 'cancelled' would pass every test above and still look broken.
  describe("status: 'denied'", () => {
    it('shows an explanation pointing to Settings when library access is denied', async () => {
      mockedCapture.pickFromLibrary.mockResolvedValue({ status: 'denied' });
      await render(<AddScreen />);
      await act(async () => fireEvent.press(screen.getByTestId('add-library')));
      await waitFor(() => expect(screen.getByTestId('add-error')).toBeTruthy());
      expect(screen.getByTestId('add-error')).toHaveTextContent(/settings/i);
      expect(screen.queryByTestId('add-preview')).toBeNull();
    });

    it('shows an explanation pointing to Settings when camera access is denied', async () => {
      mockedCapture.captureWithCamera.mockResolvedValue({ status: 'denied' });
      await render(<AddScreen />);
      await act(async () => fireEvent.press(screen.getByTestId('add-camera')));
      await waitFor(() => expect(screen.getByTestId('add-error')).toBeTruthy());
      expect(screen.getByTestId('add-error')).toHaveTextContent(/settings/i);
    });
  });

  describe('saving', () => {
    it('compresses the captured image before uploading, and uploads the compressed result, not the raw capture (TC-14)', async () => {
      await pickAnImage();
      await act(async () => fireEvent.press(screen.getByTestId('add-save')));

      await waitFor(() => expect(mockedUploadItem).toHaveBeenCalled());
      expect(mockedCompress.compressForUpload).toHaveBeenCalledWith(capturedImage);
      expect(mockedUploadItem).toHaveBeenCalledWith(
        expect.objectContaining({ uri: compressedImage.uri }),
      );
    });

    // FR4 / TC-06: the wardrobe grid renders `thumbnailUrl`, and this screen
    // is the only place a thumbnail can be produced -- the API deliberately
    // does not decode images (no `sharp` in the API container). The thumbnail
    // is generated from the *capture*, not from the already-lossy compressed
    // output, so the grid tile is not a re-encode of a re-encode.
    it('creates a thumbnail from the captured image and uploads it alongside the compressed image', async () => {
      await pickAnImage();
      await act(async () => fireEvent.press(screen.getByTestId('add-save')));

      await waitFor(() => expect(mockedUploadItem).toHaveBeenCalled());
      expect(mockedThumbnail.createThumbnail).toHaveBeenCalledWith(capturedImage);
      expect(mockedUploadItem).toHaveBeenCalledWith(
        expect.objectContaining({ uri: compressedImage.uri, thumbnailUri: thumbnailImage.uri }),
      );
    });

    // M1: the thumbnail is a grid optimisation, and every other layer treats
    // it as optional -- POST /items accepts a request without the part,
    // PublicClothingItem.thumbnailUrl is optional, UploadItemParams.thumbnailUri
    // is optional, and the grid falls back to imageUrl. This screen must not
    // be the one layer that turns it into a hard prerequisite: on a
    // low-memory device the manipulator is decoding the same 12MP original a
    // second time here, and an OOM must not cost the user the whole save.
    it('still saves the item when thumbnail generation fails, with no thumbnailUri', async () => {
      mockedThumbnail.createThumbnail.mockRejectedValue(new Error('out of memory'));

      await pickAnImage();
      await act(async () => fireEvent.press(screen.getByTestId('add-save')));

      await waitFor(() => expect(mockedUploadItem).toHaveBeenCalled());

      const [args] = mockedUploadItem.mock.calls[0];
      // The compressed image still goes up -- only the thumbnail is dropped.
      expect(args.uri).toBe(compressedImage.uri);
      expect(args.thumbnailUri).toBeUndefined();

      // And the save reads as a success to the user, because it was one.
      await waitFor(() => expect(screen.getByTestId('add-confirmation')).toBeTruthy());
      expect(screen.queryByTestId('add-error')).toBeNull();
      expect(screen.queryByTestId('add-preview')).toBeNull();
    });

    it('uploads with the selected category and the bearer token from auth', async () => {
      await pickAnImage();
      await act(async () => fireEvent.press(screen.getByTestId('add-category-jacket')));
      await act(async () => fireEvent.press(screen.getByTestId('add-save')));

      await waitFor(() =>
        expect(mockedUploadItem).toHaveBeenCalledWith(
          expect.objectContaining({ category: 'jacket', token: 'tok-abc' }),
        ),
      );
    });

    // Task 6, defect 2 (found in the Stage 3 device screenshots, not by any
    // test): the pre-upload selector is a control for the NEXT upload, and
    // once a save has completed there is no next upload staged — no image,
    // Save disabled. Leaving it on screen showing a category is what let a
    // screenshot show `tshirt` selected at the top while the override row
    // below said `shirt`. It comes back when a new image is picked (see
    // 'restores the pre-upload category selector...' below), which is the
    // only moment it means anything again.
    it('clears the preview and the pre-upload category selector, and shows a confirmation, after a successful save', async () => {
      await pickAnImage();
      // Switch away from the default category before saving, so this is not
      // merely observing a selector that never moved.
      await act(async () => fireEvent.press(screen.getByTestId('add-category-jacket')));
      expect(screen.getByTestId('add-category-jacket').props.accessibilityState?.selected).toBe(true);

      await act(async () => fireEvent.press(screen.getByTestId('add-save')));

      await waitFor(() => expect(screen.getByTestId('add-confirmation')).toBeTruthy());
      expect(screen.queryByTestId('add-preview')).toBeNull();
      // Every chip, not just the one that was selected: hiding only the
      // selected chip would satisfy a narrower assertion and still leave a
      // half-drawn picker on screen.
      ITEM_CATEGORIES.forEach((c) => {
        expect(screen.queryByTestId(`add-category-${c}`)).toBeNull();
      });
    });

    // The other half of the pair above. Hiding the selector must not become
    // a way of hiding a selector that was never reset: if `setCategory` were
    // dropped from `onSave`, the picker would come back still holding the
    // last item's category and quietly apply it to the next upload. That is
    // exactly the shape of the bug this task is fixing, rebuilt one screen
    // later — so the reset is asserted at the moment the control is visible
    // again, which is the only moment a user could see it.
    it('restores the pre-upload category selector, reset to the default, when a new image is picked', async () => {
      await pickAnImage();
      await act(async () => fireEvent.press(screen.getByTestId('add-category-jacket')));
      await act(async () => fireEvent.press(screen.getByTestId('add-save')));
      await waitFor(() => expect(screen.getByTestId('add-confirmation')).toBeTruthy());
      expect(screen.queryByTestId('add-category-jacket')).toBeNull();

      await act(async () => fireEvent.press(screen.getByTestId('add-library')));
      await waitFor(() => expect(screen.getByTestId('add-preview')).toBeTruthy());

      expect(
        screen.getByTestId(`add-category-${ITEM_CATEGORIES[0]}`).props.accessibilityState?.selected,
      ).toBe(true);
      expect(screen.getByTestId('add-category-jacket').props.accessibilityState?.selected).toBe(false);
    });

    it('keeps the pre-upload category selector, still holding the chosen category, when a save fails', async () => {
      mockedUploadItem.mockRejectedValue(
        new ApiClientError('VALIDATION_FAILED', 'Unsupported image type', 400),
      );
      await pickAnImage();
      await act(async () => fireEvent.press(screen.getByTestId('add-category-jacket')));
      await act(async () => fireEvent.press(screen.getByTestId('add-save')));

      await waitFor(() => expect(screen.getByTestId('add-error')).toBeTruthy());
      // The image is deliberately kept for a retry (see the test above), and
      // a retry with no way to correct the category would be a worse screen
      // than the one this task is fixing. Every chip, like its two siblings
      // above, rather than one spot-check.
      ITEM_CATEGORIES.forEach((c) => {
        expect(screen.queryByTestId(`add-category-${c}`)).not.toBeNull();
      });
      // And the selection has to have SURVIVED the failure — a selector that
      // came back reset to the default would silently re-upload as 'tshirt'
      // on the retry, which is the same class of defect as the one being
      // fixed. `getByTestId` alone would not have caught that.
      expect(screen.getByTestId('add-category-jacket').props.accessibilityState?.selected).toBe(true);
      expect(
        screen.getByTestId(`add-category-${ITEM_CATEGORIES[0]}`).props.accessibilityState?.selected,
      ).toBe(false);
    });

    // m6: this state is a decision, so it gets a name. After a save whose
    // item came back `source: 'manual'` (tagging unavailable) there is no
    // override row — that section is AI-only — and the pre-upload selector
    // is hidden, so the screen carries NO category control at all. That is
    // intended: the selector configures the next upload, and with the image
    // cleared and Save disabled there is no next upload staged. Picking a
    // new photo brings it back. Without this test the behaviour is only
    // implied by the gate, and a reader cannot tell it from an oversight.
    it('deliberately shows no category control at all after a manual-source save', async () => {
      mockedUploadItem.mockResolvedValue({ ...item, source: 'manual' });
      await pickAnImage();
      await act(async () => fireEvent.press(screen.getByTestId('add-save')));
      await waitFor(() => expect(screen.getByTestId('add-confirmation')).toBeTruthy());

      ITEM_CATEGORIES.forEach((c) => {
        expect(screen.queryByTestId(`add-category-${c}`)).toBeNull();
        // No override row either — it renders only for `source: 'ai'`.
        expect(screen.queryByTestId(`add-override-${c}`)).toBeNull();
      });
    });

    it('does nothing when save is pressed with no image selected', async () => {
      await render(<AddScreen />);
      await act(async () => fireEvent.press(screen.getByTestId('add-save')));
      expect(mockedCompress.compressForUpload).not.toHaveBeenCalled();
      expect(mockedUploadItem).not.toHaveBeenCalled();
    });

    it('shows the server error message and keeps the image so the user can retry', async () => {
      mockedUploadItem.mockRejectedValue(
        new ApiClientError('VALIDATION_FAILED', 'Unsupported image type', 400),
      );
      await pickAnImage();
      await act(async () => fireEvent.press(screen.getByTestId('add-save')));

      await waitFor(() =>
        expect(screen.getByTestId('add-error')).toHaveTextContent('Unsupported image type'),
      );
      expect(screen.getByTestId('add-preview')).toBeTruthy();
    });
  });

  // Fix round 1, Findings 1 & 2: races around an in-flight save. Without a
  // `busy` guard on handleCapture, a capture started mid-upload could land
  // and set a new image, only for the *original* upload's success handler to
  // clobber it with `setImage(null)` when it finally resolved — silently
  // discarding a photo the user had already moved on to. Without a `busy`
  // check in onSave's own guard, a fast double-tap on Save could similarly
  // fire two uploads for one picked photo. Both fixes are defense-in-depth
  // alongside the existing `disabled` props on the relevant Pressables (see
  // the task report's mutation analysis): a UI-driven double-press mostly
  // exercises `disabled`, not these internal guards specifically, but the
  // combined protection — which is what actually ships — is what these
  // tests verify.
  describe('in-flight save races (fix round 1)', () => {
    function deferredUpload(): () => void {
      let resolve!: (value: PublicClothingItem) => void;
      const promise = new Promise<PublicClothingItem>((res) => {
        resolve = res;
      });
      mockedUploadItem.mockReturnValue(promise);
      return () => resolve(item);
    }

    it('Finding 1: ignores a new capture started while a save is in flight, so it cannot be discarded when the save resolves', async () => {
      const resolveUpload = deferredUpload();
      await pickAnImage();

      // Not awaited: `fireEvent.press` wraps the press in React's `act()`,
      // which will not settle until the whole handler chain resolves — and
      // `uploadItem`'s promise is deliberately still pending here, to
      // simulate an in-flight upload. `waitFor` below observes the busy
      // state without blocking on that chain; the promise itself is only
      // awaited later, after `resolveUpload()` runs.
      const savePromise = fireEvent.press(screen.getByTestId('add-save'));
      await waitFor(() => expect(mockedUploadItem).toHaveBeenCalledTimes(1));

      // Attempt to pick a DIFFERENT photo while that save is still pending.
      // Safe to await directly: `handleCapture` never touches the pending
      // `uploadItem` promise, so this settles on its own regardless of
      // whether the busy guard exists.
      const otherImage = { uri: 'file:///tmp/other.jpg', width: 2000, height: 1500 };
      mockedCapture.pickFromLibrary.mockResolvedValue({ status: 'ok', image: otherImage });
      await fireEvent.press(screen.getByTestId('add-library'));

      // The picker must not have been invoked a second time — the capture
      // was refused outright while busy, not merely discarded afterwards.
      expect(mockedCapture.pickFromLibrary).toHaveBeenCalledTimes(1);
      // The preview must still show the ORIGINAL image, not the new one.
      expect(screen.getByTestId('add-preview').props.source).toEqual({ uri: capturedImage.uri });

      // Let the pending upload finish, and confirm it completed once, for
      // the original photo, undisturbed by the ignored capture attempt.
      await act(async () => {
        resolveUpload();
        await savePromise;
      });
      await waitFor(() => expect(screen.getByTestId('add-confirmation')).toBeTruthy());
      expect(mockedUploadItem).toHaveBeenCalledTimes(1);
    });

    it('Finding 2: does not start a second upload if save is pressed again before the first resolves', async () => {
      const resolveUpload = deferredUpload();
      await pickAnImage();

      // A REAL double tap: both presses dispatched before React re-renders,
      // so both invoke the handler instance that was on screen when the first
      // one landed. The handler is captured BEFORE either press for exactly
      // that reason — re-reading it after the first would fetch a re-rendered
      // closure that already knows a save is running, which is the state a
      // genuine double tap never sees.
      //
      // This test used to press twice with `fireEvent.press`, and its own
      // comment conceded that it only proved `disabled` blocks dispatch:
      // RNTL wraps each press in `act()`, which re-renders between them.
      // Review of Stage 5 Task 4 drove the handler directly and `uploadItem`
      // was called TWICE. That is two `POST /items`, two ClothingItem
      // documents, two MinIO objects and two identical tiles, which the user
      // then has to find and delete one of by hand. Only `busyRef`, written
      // and read inside the one synchronous burst, stops it; `busy` state and
      // the `disabled` prop are both a render too late.
      const press = onPressOf(screen.getByTestId('add-save'));
      let firstSavePromise: unknown;
      await act(async () => {
        firstSavePromise = press();
        press();
      });

      expect(mockedUploadItem).toHaveBeenCalledTimes(1);
      // And the compression that precedes it ran once too — a second upload
      // would also mean a second full decode of the same photo.
      expect(mockedCompress.compressForUpload).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveUpload();
        await firstSavePromise;
      });
      await waitFor(() => expect(screen.getByTestId('add-confirmation')).toBeTruthy());
      expect(mockedUploadItem).toHaveBeenCalledTimes(1);
    });
  });

  // FR3: "Manual and automated tagging" is only satisfied if the screen both
  // shows the AI's guess and lets the user change it. Tagging happens
  // server-side during upload (see add.tsx's comment on `onSave`), so the
  // guess is only known once the save response comes back — these tests
  // exercise that response, not a pre-save preview.
  describe('AI tag display and override', () => {
    // `category: 'shoes'` deliberately differs from both the picker's
    // default (ITEM_CATEGORIES[0], 'tshirt') and the module-level `item`
    // fixture's category ('jacket') used by the tests above -- a hardcoded
    // displayed category would still coincidentally pass against either of
    // those, but not against 'shoes'.
    const aiItem: PublicClothingItem = {
      ...item,
      id: 'item-ai-1',
      category: 'shoes',
      source: 'ai',
      aiConfidence: 0.9,
    };

    it('shows the AI-guessed category after a save when source is "ai"', async () => {
      mockedUploadItem.mockResolvedValue(aiItem);
      await pickAnImage();
      await act(async () => fireEvent.press(screen.getByTestId('add-save')));

      await waitFor(() => expect(screen.getByTestId('add-ai-tag')).toBeTruthy());
      expect(screen.getByTestId('add-ai-tag')).toHaveTextContent(/shoes/i);
    });

    // Task 6, defect 2, in the exact form the Stage 3 screenshot caught it
    // (docs/verification/stage-3/04-override-changed-to-shirt.png): the top
    // "Category" selector still read `tshirt` while the override row below
    // read the category the item actually saved as. Two category pickers on
    // one screen, disagreeing. No Stage 3 test caught it because each picker
    // was correct in isolation and nothing asserted the RELATIONSHIP between
    // them — which is what this test does.
    //
    // `aiItem.category` is 'shoes', deliberately different from the picker's
    // default `ITEM_CATEGORIES[0]` ('tshirt'), so "they agree" and "the top
    // one is gone" cannot be confused for each other.
    it('leaves the override row as the only category control after an AI-tagged save', async () => {
      mockedUploadItem.mockResolvedValue(aiItem);
      await pickAnImage();
      await act(async () => fireEvent.press(screen.getByTestId('add-save')));
      await waitFor(() => expect(screen.getByTestId('add-ai-tag')).toBeTruthy());

      ITEM_CATEGORIES.forEach((c) => {
        expect(screen.queryByTestId(`add-category-${c}`)).toBeNull();
        // The override row is untouched — Stage 3 reviewed and fixed its
        // copy deliberately, and this task does not relitigate it.
        expect(screen.getByTestId(`add-override-${c}`)).toBeTruthy();
      });
      expect(screen.getByTestId('add-override-shoes').props.accessibilityState?.selected).toBe(true);
    });

    // Fix round 1: before any override, the screen must attribute the
    // category to the AI ("Tagged as", not "Changed to") and must show the
    // confidence warning it earned. This is the "before" half of the pair
    // below — without it, a mutation that always hid the AI wording (or the
    // warning) would only be caught after an override, not before one.
    it('attributes the category to the AI, and shows the confidence warning, before any override', async () => {
      mockedUploadItem.mockResolvedValue({ ...aiItem, aiConfidence: LOW_CONFIDENCE_THRESHOLD - 0.01 });
      await pickAnImage();
      await act(async () => fireEvent.press(screen.getByTestId('add-save')));

      await waitFor(() => expect(screen.getByTestId('add-ai-tag')).toBeTruthy());
      expect(screen.getByTestId('add-ai-tag')).toHaveTextContent(/tagged as shoes/i);
      expect(screen.getByTestId('add-low-confidence')).toBeTruthy();
    });

    it('shows nothing AI-related when source is "manual" (tagging unavailable must look normal)', async () => {
      mockedUploadItem.mockResolvedValue({ ...aiItem, source: 'manual', aiConfidence: undefined });
      await pickAnImage();
      await act(async () => fireEvent.press(screen.getByTestId('add-save')));

      await waitFor(() => expect(screen.getByTestId('add-confirmation')).toBeTruthy());
      expect(screen.queryByTestId('add-ai-tag')).toBeNull();
      expect(screen.queryByTestId('add-low-confidence')).toBeNull();
      expect(screen.queryByTestId('add-override-shoes')).toBeNull();
    });

    // Both sides of LOW_CONFIDENCE_THRESHOLD, imported from add.tsx itself
    // rather than a hardcoded 0.75 literal here -- so this stays correct if
    // the constant is ever retuned -- and a single-sided test could not
    // distinguish "the warning uses the threshold correctly" from "the
    // warning always/never shows".
    it('shows the low-confidence warning just below the threshold', async () => {
      mockedUploadItem.mockResolvedValue({ ...aiItem, aiConfidence: LOW_CONFIDENCE_THRESHOLD - 0.01 });
      await pickAnImage();
      await act(async () => fireEvent.press(screen.getByTestId('add-save')));

      await waitFor(() => expect(screen.getByTestId('add-low-confidence')).toBeTruthy());
    });

    it('does not show the low-confidence warning at or above the threshold', async () => {
      mockedUploadItem.mockResolvedValue({ ...aiItem, aiConfidence: LOW_CONFIDENCE_THRESHOLD });
      await pickAnImage();
      await act(async () => fireEvent.press(screen.getByTestId('add-save')));

      await waitFor(() => expect(screen.getByTestId('add-ai-tag')).toBeTruthy());
      expect(screen.queryByTestId('add-low-confidence')).toBeNull();
    });

    it('issues a PATCH with the tapped chip\'s category and this item\'s id when an override chip is tapped', async () => {
      mockedUploadItem.mockResolvedValue(aiItem);
      mockedUpdateItemCategory.mockResolvedValue({ ...aiItem, category: 'trousers' });
      await pickAnImage();
      await act(async () => fireEvent.press(screen.getByTestId('add-save')));
      await waitFor(() => expect(screen.getByTestId('add-ai-tag')).toBeTruthy());

      await act(async () => fireEvent.press(screen.getByTestId('add-override-trousers')));

      expect(mockedUpdateItemCategory).toHaveBeenCalledWith({
        id: aiItem.id,
        category: 'trousers',
        token: 'tok-abc',
      });
      // The displayed category must reflect what the server actually
      // persisted (the PATCH response), not the tapped chip optimistically.
      await waitFor(() => expect(screen.getByTestId('add-ai-tag')).toHaveTextContent(/trousers/i));
    });

    // Fix round 1: reviewer-flagged self-contradiction. Task 5's original
    // implementation left "Tagged as X" and the low-confidence warning
    // showing even after the user corrected X by hand — a screenshot of
    // that (Task 6 photographs exactly this flow) reads as a bug: it
    // implies the AI still said X, and warns about a category the human
    // just chose. The PATCH response here deliberately still carries the
    // original low `aiConfidence` (the endpoint only ever touches
    // `category` — see items.ts's `patchItemSchema` comment), which is
    // what proves the warning disappears because of the LOCAL override
    // flag, not because the server's confidence value happened to change.
    it('stops attributing the category to the AI and hides the confidence warning once the user has overridden it', async () => {
      const lowConfidence = LOW_CONFIDENCE_THRESHOLD - 0.01;
      mockedUploadItem.mockResolvedValue({ ...aiItem, aiConfidence: lowConfidence });
      mockedUpdateItemCategory.mockResolvedValue({ ...aiItem, category: 'trousers', aiConfidence: lowConfidence });
      await pickAnImage();
      await act(async () => fireEvent.press(screen.getByTestId('add-save')));
      await waitFor(() => expect(screen.getByTestId('add-low-confidence')).toBeTruthy());

      await act(async () => fireEvent.press(screen.getByTestId('add-override-trousers')));

      await waitFor(() => expect(screen.getByTestId('add-ai-tag')).toHaveTextContent(/trousers/i));
      // No longer "Tagged as" (that would still say the AI said so), and
      // the warning is gone even though `aiConfidence` itself is unchanged.
      expect(screen.getByTestId('add-ai-tag')).not.toHaveTextContent(/tagged as/i);
      expect(screen.queryByTestId('add-low-confidence')).toBeNull();
    });

    it('shows an error and leaves the displayed category unchanged when the override PATCH fails', async () => {
      mockedUploadItem.mockResolvedValue(aiItem);
      mockedUpdateItemCategory.mockRejectedValue(
        new ApiClientError('VALIDATION_FAILED', 'Could not save that change', 400),
      );
      await pickAnImage();
      await act(async () => fireEvent.press(screen.getByTestId('add-save')));
      await waitFor(() => expect(screen.getByTestId('add-ai-tag')).toBeTruthy());

      await act(async () => fireEvent.press(screen.getByTestId('add-override-trousers')));

      await waitFor(() =>
        expect(screen.getByTestId('add-error')).toHaveTextContent('Could not save that change'),
      );
      // Still 'shoes', and still attributed to the AI -- a failed PATCH
      // must not flip the wording to "Changed to" for a change that never
      // actually saved.
      expect(screen.getByTestId('add-ai-tag')).toHaveTextContent(/tagged as shoes/i);
      // m6: and the pre-upload selector stays HIDDEN through this failure,
      // which is a decision rather than an accident. The save itself
      // succeeded -- only the correction failed -- so the override row is
      // still the right control to offer, and un-hiding a second category
      // picker here would rebuild the very contradiction this task removed.
      ITEM_CATEGORIES.forEach((c) => {
        expect(screen.queryByTestId(`add-category-${c}`)).toBeNull();
      });
      expect(screen.getByTestId('add-override-shoes')).toBeTruthy();
    });
  });

  /**
   * Stage 5 Task 4 — FR5 / TC-07. Phase 3's flow composes an outfit on the
   * Add tab, so this screen now has two modes and the item form is one of
   * them rather than the whole screen.
   */
  describe('outfit composing (Stage 5 Task 4)', () => {
    async function chooseOutfitMode(): Promise<void> {
      await act(async () => {
        fireEvent.press(screen.getByTestId('add-mode-outfit'));
      });
    }

    it('shows the item form and not the composer by default', async () => {
      // Every other test in this file presses `add-camera` straight after
      // rendering, so the default mode is load-bearing for all of them.
      await render(<AddScreen />);
      expect(screen.getByTestId('add-item-form')).toBeTruthy();
      expect(screen.queryByTestId('outfit-composer')).toBeNull();
      expect(screen.getByTestId('add-mode-item').props.accessibilityState?.selected).toBe(true);
      expect(screen.getByTestId('add-mode-outfit').props.accessibilityState?.selected).toBe(false);
    });

    it('shows the outfit composer when the outfit mode is chosen', async () => {
      await render(<AddScreen />);
      await chooseOutfitMode();
      expect(screen.getByTestId('outfit-composer')).toBeTruthy();
      expect(screen.getByTestId('add-mode-outfit').props.accessibilityState?.selected).toBe(true);
    });

    it('takes the item form off the screen while composing, so a list is never nested in a ScrollView', async () => {
      // The composer is a `FlatList`. React Native logs "VirtualizedLists
      // should never be nested inside plain ScrollViews with the same
      // orientation" when one is rendered inside a `ScrollView`, which is a
      // failure by this project's pristine-output rule — and on a device the
      // nesting also breaks the grid's own scrolling and its windowing. The
      // two modes are therefore alternatives, not a section appended to the
      // form.
      await render(<AddScreen />);
      await chooseOutfitMode();
      expect(screen.queryByTestId('add-item-form')).toBeNull();
      expect(screen.queryByTestId('add-save')).toBeNull();
    });

    it('goes back to the item form', async () => {
      await render(<AddScreen />);
      await chooseOutfitMode();
      await act(async () => {
        fireEvent.press(screen.getByTestId('add-mode-item'));
      });
      expect(screen.getByTestId('add-item-form')).toBeTruthy();
      expect(screen.queryByTestId('outfit-composer')).toBeNull();
    });

    it('refuses to switch modes while an upload is in flight', async () => {
      // Switching would unmount the form mid-save, throwing away the
      // confirmation, the AI's tag and the override row the user is owed for
      // an upload that is going to succeed. Same reasoning as Finding 1's
      // capture guard above, and the same `busy` flag enforces it.
      let resolveUpload!: (value: PublicClothingItem) => void;
      mockedUploadItem.mockReturnValue(
        new Promise<PublicClothingItem>((resolve) => {
          resolveUpload = resolve;
        }),
      );
      await pickAnImage();

      const savePromise = fireEvent.press(screen.getByTestId('add-save'));
      await waitFor(() => expect(mockedUploadItem).toHaveBeenCalledTimes(1));

      await act(async () => {
        fireEvent.press(screen.getByTestId('add-mode-outfit'));
      });
      expect(screen.queryByTestId('outfit-composer')).toBeNull();
      expect(screen.getByTestId('add-item-form')).toBeTruthy();

      await act(async () => {
        resolveUpload(item);
        await savePromise;
      });
      await waitFor(() => expect(screen.getByTestId('add-confirmation')).toBeTruthy());
    });

    it('tells the outfit gallery when a new outfit has been saved here', async () => {
      // The gallery on the Favorites tab refetches on focus only when the
      // outfit list is known to have changed. A create is one of the three
      // things that changes it, and this call site is the only place that
      // knows — without the wiring, an outfit composed here does not appear in
      // the gallery AT ALL until the user thinks to pull to refresh, which is
      // precisely the half of TC-07 that reads "visible in outfit gallery".
      await render(<AddScreen />);
      await chooseOutfitMode();

      expect(consumeOutfitsDirty()).toBe(false);
      await act(async () => {
        fireEvent.press(screen.getByTestId('outfit-composer-finish-save'));
      });

      expect(consumeOutfitsDirty()).toBe(true);
    });

    it('says nothing to the gallery when no outfit has been saved', async () => {
      // Merely opening the composer is not a change. A gate that fired on
      // arrival would refetch the gallery — discarding its paging — every time
      // a user glanced at this tab.
      await render(<AddScreen />);
      await chooseOutfitMode();

      expect(consumeOutfitsDirty()).toBe(false);
    });

    it('refuses to switch modes while an OUTFIT save is in flight', async () => {
      // `busy` is this screen's own item upload and knows nothing about the
      // composer's save. Without the composer reporting its own state through
      // `onSavingChange`, switching back here would unmount it mid-`POST`:
      // the outfit is created, the user is told nothing, and the selection
      // that produced it is gone.
      await render(<AddScreen />);
      await chooseOutfitMode();

      await act(async () => {
        fireEvent.press(screen.getByTestId('outfit-composer-begin-save'));
      });
      await act(async () => {
        fireEvent.press(screen.getByTestId('add-mode-item'));
      });

      expect(screen.getByTestId('outfit-composer')).toBeTruthy();
      expect(screen.queryByTestId('add-item-form')).toBeNull();
    });
  });
});
