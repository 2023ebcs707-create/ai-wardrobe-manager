import * as ImagePicker from 'expo-image-picker';
import { pickFromLibrary, captureWithCamera } from './capture';

jest.mock('expo-image-picker');

const picker = ImagePicker as jest.Mocked<typeof ImagePicker>;

const asset = { uri: 'file:///tmp/a.jpg', width: 3000, height: 4000 };

describe('image capture', () => {
  afterEach(() => jest.resetAllMocks());

  it('returns the picked asset from the library', async () => {
    picker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true } as never);
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [asset] } as never);

    await expect(pickFromLibrary()).resolves.toEqual({
      status: 'ok',
      image: { uri: asset.uri, width: asset.width, height: asset.height },
    });
  });

  it('requests images only at full quality, using the current MediaType API', async () => {
    picker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true } as never);
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null } as never);

    await pickFromLibrary();

    expect(picker.launchImageLibraryAsync.mock.calls[0][0]).toEqual({
      mediaTypes: ['images'],
      quality: 1,
    });
  });

  it('returns cancelled when the user cancels the library picker', async () => {
    picker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true } as never);
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null } as never);
    await expect(pickFromLibrary()).resolves.toEqual({ status: 'cancelled' });
  });

  it('returns cancelled when canceled is true even if stale assets are present', async () => {
    picker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true } as never);
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: [asset] } as never);
    await expect(pickFromLibrary()).resolves.toEqual({ status: 'cancelled' });
  });

  it('returns cancelled when not canceled but no assets were returned', async () => {
    picker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true } as never);
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [] } as never);
    await expect(pickFromLibrary()).resolves.toEqual({ status: 'cancelled' });
  });

  it('returns denied when library permission is denied, without launching the picker', async () => {
    picker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: false } as never);
    await expect(pickFromLibrary()).resolves.toEqual({ status: 'denied' });
    expect(picker.launchImageLibraryAsync).not.toHaveBeenCalled();
  });

  it('returns the captured asset from the camera', async () => {
    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true } as never);
    picker.launchCameraAsync.mockResolvedValue({ canceled: false, assets: [asset] } as never);
    await expect(captureWithCamera()).resolves.toEqual({
      status: 'ok',
      image: { uri: asset.uri, width: asset.width, height: asset.height },
    });
  });

  it('returns denied when camera permission is denied, without launching the camera', async () => {
    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: false } as never);
    await expect(captureWithCamera()).resolves.toEqual({ status: 'denied' });
    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
  });

  it('requests images only at full quality from the camera, using the current MediaType API', async () => {
    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true } as never);
    picker.launchCameraAsync.mockResolvedValue({ canceled: true, assets: null } as never);

    await captureWithCamera();

    expect(picker.launchCameraAsync.mock.calls[0][0]).toEqual({
      mediaTypes: ['images'],
      quality: 1,
    });
  });

  it('returns cancelled when canceled is true even if stale assets are present from the camera', async () => {
    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true } as never);
    picker.launchCameraAsync.mockResolvedValue({ canceled: true, assets: [asset] } as never);
    await expect(captureWithCamera()).resolves.toEqual({ status: 'cancelled' });
  });

  it('returns cancelled when the camera is not canceled but no assets were returned', async () => {
    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true } as never);
    picker.launchCameraAsync.mockResolvedValue({ canceled: false, assets: [] } as never);
    await expect(captureWithCamera()).resolves.toEqual({ status: 'cancelled' });
  });
});
