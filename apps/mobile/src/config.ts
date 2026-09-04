// A USB-connected Android device reaches the host through
// `adb reverse tcp:3000 tcp:3000`, so localhost is correct on device,
// emulator, and iOS simulator alike. Set EXPO_PUBLIC_API_URL to a LAN
// address (http://192.168.x.x:3000) to work over Wi-Fi instead.
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
