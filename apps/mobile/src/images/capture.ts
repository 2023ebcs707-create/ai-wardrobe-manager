import * as ImagePicker from 'expo-image-picker';

export interface CapturedImage {
  uri: string;
  width: number;
  height: number;
}

/**
 * Distinguishes "the user opened the picker/camera and backed out" from
 * "we never got to open it because permission was refused" — Task 7's Add
 * screen reacts to these differently (denial should prompt the user toward
 * Settings; cancellation is a silent no-op).
 */
export type CaptureResult =
  | { status: 'ok'; image: CapturedImage }
  | { status: 'cancelled' }
  | { status: 'denied' };

/**
 * Shared by `pickFromLibrary` and `captureWithCamera` so the two never drift
 * on picker options (a `mediaTypes`/`quality` change applied to one call site
 * and not the other) or on the permission/cancel/empty-result handling.
 */
async function capture(
  requestPermission: () => Promise<ImagePicker.PermissionResponse>,
  launch: (options?: ImagePicker.ImagePickerOptions) => Promise<ImagePicker.ImagePickerResult>
): Promise<CaptureResult> {
  const permission = await requestPermission();
  if (!permission.granted) return { status: 'denied' };

  // `mediaTypes: ['images']` is the current API. `MediaTypeOptions.Images` is
  // deprecated in SDK 57 and warns at runtime. `quality: 1` is deliberate:
  // compression happens in Task 6, where it is measurable and testable.
  const result = await launch({ mediaTypes: ['images'], quality: 1 });
  if (result.canceled || !result.assets || result.assets.length === 0) {
    return { status: 'cancelled' };
  }

  const [asset] = result.assets;
  return { status: 'ok', image: { uri: asset.uri, width: asset.width, height: asset.height } };
}

export function pickFromLibrary(): Promise<CaptureResult> {
  return capture(ImagePicker.requestMediaLibraryPermissionsAsync, ImagePicker.launchImageLibraryAsync);
}

export function captureWithCamera(): Promise<CaptureResult> {
  return capture(ImagePicker.requestCameraPermissionsAsync, ImagePicker.launchCameraAsync);
}
