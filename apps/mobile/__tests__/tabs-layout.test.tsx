import React, { type ReactElement, type ReactNode } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import TabLayout from '../app/(tabs)/_layout';

// In `__tests__/` rather than beside the layout it tests — Expo Router's
// Android require-context scans every `.tsx` under `app/` as a candidate
// route and does not exclude `.test.` files (or a `__tests__/` subdirectory
// inside `app/`). See the note in index.test.tsx and README.md's
// "Constraints worth knowing".
//
// WHAT THIS FILE CANNOT DO, and why it still exists.
//
// Every one of the five tab icons rendered as a tofu box (□) on device for
// the whole of Stage 3 while 84 mobile tests passed, because RNTL queries by
// text and testID and has no way to see a rendered glyph. That blindness is
// not fixed here and cannot be: these tests assert that a `tabBarIcon` is
// SUPPLIED for every tab and that it is WIRED to the `color` and `size`
// arguments the navigator hands it. **The device screenshot in Task 7 is
// what proves the glyphs actually render.** Nothing below should be read as
// covering that.
//
// Why `color` and `size` are load-bearing rather than cosmetic: expo-router's
// `TabBarIcon` (node_modules/expo-router/build/react-navigation/bottom-tabs/
// views/TabBarIcon.js) calls the supplied icon function TWICE per tab — once
// with `activeTintColor` and once with `inactiveTintColor` — and cross-fades
// the two layers by opacity. An icon that hardcodes its colour renders two
// identical layers, so the selected tab never looks selected. `size` comes
// from the same file's HIG-derived constants, which differ between the
// compact and regular tab bar variants.

/** The Ionicons element inside whatever `tabBarIcon` returns. */
type IconElement = ReactElement<{ name: string; color?: unknown; size?: unknown }>;

/**
 * `tabBarIcon` no longer returns the glyph directly — the Soft direction puts
 * a pill behind the selected tab, so it returns a wrapper with the Ionicons
 * element inside. This finds the glyph in whatever it returns, which keeps
 * every assertion below about the GLYPH rather than about the shape of the
 * layout's markup.
 *
 * Function components are INVOKED to see through them (they take no hooks —
 * see `declaredScreens` for why that is safe here); host elements are walked
 * by their children. Returning `null` rather than throwing at each step lets
 * the caller report "no glyph at all", which is the tofu case this whole file
 * exists for.
 */
function findIonicons(node: ReactNode): IconElement | null {
  if (!React.isValidElement(node)) return null;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.type === Ionicons) return element as IconElement;

  const inChildren = React.Children.toArray(element.props.children).reduce<IconElement | null>(
    (found, child) => found ?? findIonicons(child),
    null,
  );
  if (inChildren !== null) return inChildren;

  // Only a plain function component is invoked. A CLASS component also passes
  // `typeof === 'function'` and throws "Cannot call a class as a function" when
  // called directly — and `Ionicons` itself is a class, as is `View` under this
  // preset, so the naive check walks straight into it.
  const type = element.type as { prototype?: { isReactComponent?: unknown } };
  if (typeof element.type === 'function' && type.prototype?.isReactComponent === undefined) {
    return findIonicons((element.type as (props: unknown) => ReactNode)(element.props));
  }
  return null;
}

/** The glyph a tab's `tabBarIcon` produces for the given navigator arguments. */
function glyphFor(options: TabScreenOptions, focused: boolean): IconElement {
  const icon = findIonicons(
    options.tabBarIcon!({ focused, color: PROBE_COLOR, size: PROBE_SIZE }),
  );
  expect(icon).not.toBeNull();
  return icon!;
}

type TabScreenOptions = {
  title?: string;
  tabBarIcon?: (props: { focused: boolean; color: string; size: number }) => ReactNode;
};

/**
 * Sentinels, not plausible real values. A hardcoded `#111` or `24` in the
 * layout would pass a test that asserted "some colour" or "some size"; these
 * can only appear in the rendered icon if they were threaded through from the
 * navigator's arguments.
 */
const PROBE_COLOR = '#ff00ff';
const PROBE_SIZE = 37;

/** `_layout` and the `+api`/`+html`/`+middleware` special files are not routes. */
const NOT_A_ROUTE = /(_layout|[^/]*?\+[^/]*?)\.[tj]sx?$/;
const ROUTE_FILE = /\.[tj]sx?$/;

/**
 * The routes Expo Router will actually turn into tabs, read from disk rather
 * than listed here. A hardcoded list of five would let a sixth tab ship with
 * the fallback tofu glyph and no test would notice, which is exactly how this
 * defect reached a device the first time.
 *
 * **This walks the tree; it does not just list files.** Expo Router routes a
 * DIRECTORY exactly as it routes a file, so `outfits/index.tsx` is the tab
 * `outfits` just as much as `outfits.tsx` is. A first version of this helper
 * used a flat `readdirSync` filtered by extension, which silently dropped
 * every directory — a real sixth tab added as `app/(tabs)/outfits/index.tsx`
 * rendered `MissingIcon` on device while this suite reported 17/17 green.
 * Stage 5 builds outfit creation, and a nested route directory is a very
 * natural way to add it, so this is the form the hole would have been walked
 * into first.
 *
 * The three shapes that matter, and what each yields:
 *  * `outfits.tsx`             -> `outfits`
 *  * `outfits/index.tsx`       -> `outfits`        (index collapses to its directory)
 *  * `outfits/detail.tsx`      -> `outfits/detail` (no `_layout`, so it is a sibling tab)
 *
 * A directory that DOES contain `_layout.tsx` is one nested navigator, so it
 * contributes a single route named for the directory and its children belong
 * to that layout rather than to this tab bar.
 */
function routeFilesOnDisk(dir = path.join(__dirname, '..', 'app', '(tabs)'), prefix = ''): string[] {
  const routes: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const nested = path.join(dir, entry.name);
      const hasOwnLayout = fs
        .readdirSync(nested)
        .some((file) => /^_layout\.[tj]sx?$/.test(file));
      if (hasOwnLayout) {
        routes.push(`${prefix}${entry.name}`);
      } else {
        routes.push(...routeFilesOnDisk(nested, `${prefix}${entry.name}/`));
      }
      continue;
    }

    if (!ROUTE_FILE.test(entry.name) || NOT_A_ROUTE.test(entry.name)) continue;

    const base = entry.name.replace(ROUTE_FILE, '');
    // `foo/index.tsx` is the route `foo`, not `foo/index`.
    routes.push(base === 'index' && prefix ? prefix.slice(0, -1) : `${prefix}${base}`);
  }

  return routes;
}

/**
 * The `<Tabs.Screen>` elements the layout declares.
 *
 * `TabLayout` is invoked directly rather than rendered: mounting `<Tabs>`
 * needs a real navigation container, and what is under test here is the
 * options object the layout hands the navigator, not the navigator itself.
 * The component takes no props and uses no hooks, so calling it is safe.
 */
function declaredScreens(): { name: string; type: unknown; options: TabScreenOptions }[] {
  const tree = TabLayout() as ReactElement<{ children?: ReactNode }>;
  return React.Children.toArray(tree.props.children).map((child) => {
    const element = child as ReactElement<{ name: string; options?: TabScreenOptions }>;
    return {
      name: element.props.name,
      type: element.type,
      options: element.props.options ?? {},
    };
  });
}

function declaredByName(): Map<string, TabScreenOptions> {
  return new Map(declaredScreens().map((s) => [s.name, s.options]));
}

describe('TabLayout', () => {
  it('declares a Tabs.Screen for every route file under app/(tabs)', () => {
    const declared = declaredScreens();
    expect(declared.map((s) => s.name).sort()).toEqual(routeFilesOnDisk().sort());
    // Not merely "an element with a name prop" — the children have to be the
    // navigator's own Screen component, or the options never reach it.
    declared.forEach((s) => expect(s.type).toBe(Tabs.Screen));
  });

  // Driven off the files on disk, not off the layout's own children: a tab
  // whose route file exists but whose `<Tabs.Screen>` was never written gets
  // Expo Router's default options — which is precisely the tofu case.
  describe.each(routeFilesOnDisk())('the %s tab', (routeName) => {
    it('is declared with a tabBarIcon', () => {
      const options = declaredByName().get(routeName);
      expect(options).toBeDefined();
      expect(typeof options?.tabBarIcon).toBe('function');
    });

    // Named for what it does: the element is CREATED and its props read. It
    // is never mounted, so nothing here is evidence that a glyph draws.
    it('declares an Ionicons glyph name that exists in the font', () => {
      const icon = glyphFor(declaredByName().get(routeName)!, false);

      // `createIconSet` falls back to rendering a literal '?' for a name it
      // does not know (see the vendored create-icon-set.js), so a typo would
      // otherwise ship as a question mark rather than an icon. This is the
      // closest RNTL can get to "the glyph is real"; it still says nothing
      // about whether it draws. That the element IS an Ionicons is enforced by
      // `findIonicons`, which only ever returns one.
      expect(Object.prototype.hasOwnProperty.call(Ionicons.glyphMap, icon.props.name)).toBe(true);
    });

    it('passes the navigator-supplied colour and size through to the icon', () => {
      const icon = glyphFor(declaredByName().get(routeName)!, true);

      expect(icon.props.color).toBe(PROBE_COLOR);
      expect(icon.props.size).toBe(PROBE_SIZE);
    });
  });

  // Five tabs all showing the same glyph is a tab bar that is just as unusable
  // as five tofu boxes, and every assertion above would still pass.
  it('gives each tab a different glyph', () => {
    const names = declaredScreens().map((s) => glyphFor(s.options, false).props.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
