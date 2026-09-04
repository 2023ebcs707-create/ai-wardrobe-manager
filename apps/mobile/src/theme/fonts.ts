/**
 * Font loading. Called once, from the root layout.
 *
 * The families are bundled as assets rather than fetched, so this resolves
 * without a network round trip and there is no flash of a fallback face — the
 * root layout holds the splash screen until this reports `true`. Every face
 * listed here is named by a preset in `type.ts`; the two lists must stay in
 * step, because a preset naming an unregistered family renders as the system
 * font silently, with no error to notice.
 */
import { useFonts } from 'expo-font';
import {
  Fraunces_400Regular,
  Fraunces_400Regular_Italic,
  Fraunces_500Medium,
} from '@expo-google-fonts/fraunces';
import {
  Figtree_400Regular,
  Figtree_500Medium,
  Figtree_600SemiBold,
  Figtree_700Bold,
} from '@expo-google-fonts/figtree';

export function useAppFonts(): boolean {
  const [loaded] = useFonts({
    Fraunces_400Regular,
    Fraunces_400Regular_Italic,
    Fraunces_500Medium,
    Figtree_400Regular,
    Figtree_500Medium,
    Figtree_600SemiBold,
    Figtree_700Bold,
  });
  return loaded;
}
