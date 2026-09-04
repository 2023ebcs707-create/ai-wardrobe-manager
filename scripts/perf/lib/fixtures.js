'use strict';

/**
 * The shared enums the seed needs, READ FROM `@wardrobe/shared` at runtime.
 *
 * The first draft of this file hard-coded the two arrays "mirrored from
 * shared" with a drift check beside them. The drift check failed on its first
 * run -- the hard-coded list had seven categories and the real one has ten
 * (`skirt`, `shorts` and `other` were missing) -- which is a small
 * demonstration of why a fixture that restates product constants is a bad
 * fixture. So they are parsed out of the real source instead. This is a
 * measurement harness, not a compiler: `@wardrobe/shared` is TypeScript and
 * putting ts-node in front of a data-loading step to read two string arrays
 * would be worse than reading them with a regex that fails loudly.
 */

const fs = require('node:fs');
const path = require('node:path');

const SHARED_ITEMS = path.join(__dirname, '..', '..', '..', 'packages', 'shared', 'src', 'items.ts');

function readSharedArray(name) {
  const src = fs.readFileSync(SHARED_ITEMS, 'utf8');
  const m = src.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!m) throw new Error(`could not find ${name} in ${SHARED_ITEMS}`);
  const values = m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  if (values.length === 0) throw new Error(`${name} parsed as empty from ${SHARED_ITEMS}`);
  return values;
}

const ITEM_CATEGORIES = readSharedArray('ITEM_CATEGORIES');
const SEASONS = readSharedArray('SEASONS');

module.exports = { ITEM_CATEGORIES, SEASONS, readSharedArray, SHARED_ITEMS };
