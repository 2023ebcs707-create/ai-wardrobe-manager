import type { PublicClothingItem } from '@wardrobe/shared';
import {
  MASONRY_COLUMNS,
  POST_CARD_METRICS,
  assignColumns,
  postCaptionLines,
  postCardHeight,
  postMediaHeight,
} from '../../src/community/masonry';
import type { DisplayPost } from '../../src/community/posts';

function item(id: string): PublicClothingItem {
  return {
    id,
    userId: 'user-1',
    imageUrl: `https://example.test/full/${id}.jpg`,
    thumbnailUrl: `https://example.test/thumb/${id}.jpg`,
    category: 'shirt',
    colors: [{ hex: '#001f3f', name: 'navy', share: 1 }],
    seasons: ['summer'],
    laundryStatus: 'available',
    wearCount: 0,
    source: 'manual',
    createdAt: '2026-08-20T10:00:00.000Z',
  };
}

function post(overrides: Partial<DisplayPost> = {}): DisplayPost {
  return {
    id: 'p1',
    author: { id: 'user-1', name: 'Ada Lovelace' },
    items: [item('i1'), item('i2')],
    caption: 'Sunny day',
    likeCount: 0,
    liked: false,
    saved: false,
    createdAt: '2026-08-24T09:00:00.000Z',
    missingItemsNotice: null,
    ...overrides,
  };
}

/** The height of each column under an assignment — what masonry balances. */
function columnTotals(heights: readonly number[], assignment: number[][]): number[] {
  return assignment.map((indices) =>
    indices.reduce((total, index) => total + heights[index], 0),
  );
}

/** The gap between the tallest and the shortest column. Zero is perfect. */
function imbalance(heights: readonly number[], assignment: number[][]): number {
  const totals = columnTotals(heights, assignment);
  return Math.max(...totals) - Math.min(...totals);
}

/**
 * The implementation this stage is most likely to ship by accident: strict
 * alternation by position, which is what a two-column grid degenerates into
 * and which is indistinguishable from masonry whenever the cards happen to be
 * the same height.
 *
 * It is here so the bound the test below asserts can be shown to be a real
 * bound rather than a number that anything would pass.
 */
function roundRobinColumns(heights: readonly number[], columns: number): number[][] {
  const assignment: number[][] = Array.from({ length: columns }, () => []);
  heights.forEach((_height, index) => assignment[index % columns].push(index));
  return assignment;
}

/**
 * One tall card followed by five short ones — the shape a real feed produces
 * constantly, because a post with six garments is three collage rows taller
 * than a post with none.
 *
 * Chosen because the two implementations separate on it completely: greedy
 * shortest-column reaches a perfectly level pair of columns, and round-robin
 * puts two of the short cards under the tall one and ends 400 points apart.
 */
const UNEVEN_HEIGHTS = [500, 100, 100, 100, 100, 100];

/**
 * One short card's worth of slack. Masonry's job is that a column is not left
 * hanging by more than about the size of the thing that could have gone in it.
 */
const IMBALANCE_BOUND = 100;

describe('assignColumns (ruling 8 — the computable half of "masonry-style grid layout")', () => {
  it('sends each card to the column that is currently shortest', () => {
    // Walked through by hand: 500 -> column 0 (0 vs 0, the tie goes left);
    // then column 1 is empty and stays the shorter one for every 100 that
    // follows, until it too reaches 500 — which happens on the last card, so
    // no card ever goes back to column 0.
    expect(assignColumns(UNEVEN_HEIGHTS, 2)).toEqual([[0], [1, 2, 3, 4, 5]]);
  });

  it('balances the columns on a fixture round-robin does not', () => {
    const greedy = assignColumns(UNEVEN_HEIGHTS, 2);
    expect(imbalance(UNEVEN_HEIGHTS, greedy)).toBeLessThanOrEqual(IMBALANCE_BOUND);

    // The falsification. Without this line the bound above is a number with no
    // demonstrated power to reject anything: this is the layout it rejects,
    // and it is four times over the bound on the same input.
    const roundRobin = roundRobinColumns(UNEVEN_HEIGHTS, 2);
    expect(imbalance(UNEVEN_HEIGHTS, roundRobin)).toBeGreaterThan(IMBALANCE_BOUND);
  });

  it('is stable for equal heights — the same input, the same answer, filling left first', () => {
    const equal = [10, 10, 10, 10, 10];
    // Alternation is what equal heights SHOULD produce; the property being
    // pinned is that the tie goes to the lowest column index, so the first
    // card is on the left and the reading order is the expected one. `<=`
    // instead of `<` in the comparison fills right-to-left from here.
    expect(assignColumns(equal, 2)).toEqual([
      [0, 2, 4],
      [1, 3],
    ]);
    // Deterministic: no clock, no randomness, no hidden state between calls.
    expect(assignColumns(equal, 2)).toEqual(assignColumns(equal, 2));
  });

  it('keeps feed order down each column', () => {
    // The feed is newest-first, so a layout that reordered posts to balance
    // the columns better would put an older post above a newer one. Greedy is
    // chosen over a packing optimum for exactly this.
    const mixed = [220, 130, 400, 130, 260, 130, 180];
    assignColumns(mixed, 2).forEach((indices) => {
      expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    });
  });

  it('places every card exactly once', () => {
    const mixed = [220, 130, 400, 130, 260, 130, 180];
    const placed = assignColumns(mixed, 2).flat().sort((a, b) => a - b);
    expect(placed).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('answers one empty column per column for an empty feed', () => {
    expect(assignColumns([], 2)).toEqual([[], []]);
  });

  it('falls back to a single column rather than dropping every card', () => {
    // Not reachable from `MasonryFeed`, which passes the constant. What makes
    // it worth a guard is the direction of the failure: `Array.from({length:
    // 0})` answers no columns at all, so every post in the feed would simply
    // not be rendered.
    expect(assignColumns([10, 20, 30], 0)).toEqual([[0, 1, 2]]);
    expect(assignColumns([10, 20, 30], Number.NaN)).toEqual([[0, 1, 2]]);
  });

  it('does not let one unmeasurable height capture a column', () => {
    // `NaN` compares false against everything, so an unguarded running total
    // that took one would stay `NaN` and never again be "the shortest",
    // pinning every later card into whichever column it landed in.
    const withNaN = [Number.NaN, 100, 100, 100];
    const assignment = assignColumns(withNaN, 2);
    expect(assignment[0].length).toBeGreaterThan(1);
    expect(assignment[1].length).toBeGreaterThan(0);
    expect(assignment.flat().sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('lays the feed out in two columns', () => {
    expect(MASONRY_COLUMNS).toBe(2);
  });
});

describe('postCardHeight — the number the masonry is balanced on', () => {
  it('grows a collage row for every two garments', () => {
    const { thumbnailHeight, thumbnailGap } = POST_CARD_METRICS;
    expect(postMediaHeight(post({ items: [] }))).toBe(0);
    expect(postMediaHeight(post({ items: [item('a')] }))).toBe(thumbnailHeight);
    expect(postMediaHeight(post({ items: [item('a'), item('b')] }))).toBe(thumbnailHeight);
    expect(postMediaHeight(post({ items: [item('a'), item('b'), item('c')] }))).toBe(
      thumbnailHeight * 2 + thumbnailGap,
    );
    expect(
      postMediaHeight(post({ items: ['a', 'b', 'c', 'd', 'e', 'f'].map(item) })),
    ).toBe(thumbnailHeight * 3 + thumbnailGap * 2);
  });

  it('clamps the caption to the number of lines the card actually renders', () => {
    // The card passes `maxCaptionLines` to `numberOfLines`, so a caption
    // longer than this does not make the card taller — and a height function
    // that kept counting would reserve a column of empty space under it.
    expect(postCaptionLines(post({ caption: 'Sunny day' }))).toBe(1);
    expect(postCaptionLines(post({ caption: 'x'.repeat(400) }))).toBe(
      POST_CARD_METRICS.maxCaptionLines,
    );
    // Never zero: the caption is documented as trimmed and never blank, and a
    // zero-line block would be a caption with nothing where it should be.
    expect(postCaptionLines(post({ caption: '' }))).toBe(1);
  });

  it('sums to the height the card lays out', () => {
    // Hand-computed against `POST_CARD_METRICS` rather than recomputed from
    // it, so a change to the arithmetic has to be a deliberate change to this
    // number too: header 32 + collage 96 + caption 19 + actions 28 = 175,
    // three 8pt gaps between the four blocks = 24, 10pt of padding top and
    // bottom = 20, and 10pt of margin below the card = 10.
    expect(postCardHeight(post())).toBe(229);
  });

  it('is shorter for a post whose garments have all been deleted', () => {
    // `items: []` is a real state and not an error (ruling 4). The collage
    // block is omitted rather than reserved, which also removes one gap.
    expect(postCardHeight(post({ items: [] }))).toBe(125);
    expect(postCardHeight(post({ items: [] }))).toBeLessThan(postCardHeight(post()));
  });

  it('makes room for the missing-items notice only when there is one', () => {
    const withNotice = post({ missingItemsNotice: '1 item is no longer available' });
    expect(postCardHeight(withNotice) - postCardHeight(post())).toBe(
      POST_CARD_METRICS.noticeHeight + POST_CARD_METRICS.gap,
    );
  });

  it('counts the space below the card as part of the column', () => {
    // What has to be balanced is the height of a COLUMN, and a column is its
    // cards plus the space between them. Dropping the margin biases every
    // column by one gap per card it holds — worst where the columns hold
    // different numbers of cards, which is exactly what masonry produces.
    expect(postCardHeight(post())).toBeGreaterThan(
      POST_CARD_METRICS.headerHeight +
        POST_CARD_METRICS.thumbnailHeight +
        POST_CARD_METRICS.captionLineHeight +
        POST_CARD_METRICS.actionsHeight +
        POST_CARD_METRICS.gap * 3 +
        POST_CARD_METRICS.padding * 2,
    );
  });

  it('sends a tall post and its short neighbours to different columns', () => {
    // The two functions together, on the case they exist for: a six-garment
    // post (433pt) beside four garmentless ones (125pt each). Greedy leaves
    // the tall card alone in column 0 and stacks all four short ones beside
    // it, which is 433 against 500. Round-robin puts the second and fourth
    // short cards UNDER the tall one and lands 308 apart.
    const tall = post({ id: 'tall', items: ['a', 'b', 'c', 'd', 'e', 'f'].map(item) });
    const shorts = [1, 2, 3, 4].map((n) => post({ id: `s${n}`, items: [] }));
    const heights = [tall, ...shorts].map(postCardHeight);

    expect(assignColumns(heights, MASONRY_COLUMNS)).toEqual([[0], [1, 2, 3, 4]]);
    expect(imbalance(heights, assignColumns(heights, MASONRY_COLUMNS))).toBeLessThanOrEqual(
      IMBALANCE_BOUND,
    );
    expect(
      imbalance(heights, roundRobinColumns(heights, MASONRY_COLUMNS)),
    ).toBeGreaterThan(IMBALANCE_BOUND);
  });
});
