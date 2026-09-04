/**
 * The chrome shared by the two auth screens.
 *
 * In `src/` rather than beside them, and not imported from one route file into
 * the other: every file under `app/` is a ROUTE to Expo Router's require-context,
 * so a route that imports another route couples two screens' module graphs for
 * the sake of a stylesheet.
 *
 * Both screens are the same shape on purpose — a pitch at the top, a form at
 * the bottom — so that switching between them moves the words and nothing else.
 */
import { StyleSheet } from 'react-native';
import { color, space } from './tokens';
import { font, text } from './type';

export const authStyles = StyleSheet.create({
  fill: { flex: 1 },
  // `justifyContent: 'space-between'` on a grown container, so the pitch stays
  // at the top and the form at the bottom on a tall screen, and the whole
  // thing simply scrolls on a short one.
  page: { flexGrow: 1, justifyContent: 'space-between', paddingBottom: 38 },
  pitch: { paddingHorizontal: 22, paddingTop: 56 },
  headline: { ...text.display, fontSize: 38, lineHeight: 42 },
  headlineEm: { fontFamily: font.displayItalic },
  blurb: {
    ...text.body,
    fontSize: 15,
    lineHeight: 24,
    color: color.soft,
    marginTop: 14,
    maxWidth: 300,
  },
  form: { paddingHorizontal: 22, paddingTop: 32, gap: 10 },
  error: { marginHorizontal: 0, marginBottom: space.xs },
  submit: {
    marginTop: space.sm,
    backgroundColor: color.ink,
    borderRadius: 999,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    // Pinned so the button does not change height when the label is swapped
    // for a spinner mid-submit.
    minHeight: 52,
  },
  submitText: { ...text.button, color: color.onInk },
  switch: { paddingVertical: space.md, alignItems: 'center' },
  switchText: { ...text.body, color: color.soft },
  switchStrong: { fontFamily: font.semibold, color: color.ink },
  pressed: { opacity: 0.72 },
});

