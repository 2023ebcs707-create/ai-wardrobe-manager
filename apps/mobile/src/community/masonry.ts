import type { DisplayPost } from './posts';

/**
 * The arithmetic behind "masonry-style grid layout" (Phase 3, FR10) — how tall
 * a post card will be, and which column it therefore belongs in.
 *
 * ## Why this is a module of pure functions rather than a layout in a component
 *
 * "Masonry" is a visual claim and RNTL renders no layout, so the comfortable
 * thing to write is that a device screenshot is the only way to check it. That
 * is the shape of excuse Stage 6 proved wrong when it turned "no test can see a
 * rendered glyph" into a computed greyscale-contrast assertion, and ruling 8
 * names the computable part here explicitly: **column assignment**. Given a
 * list of card heights, a masonry layout puts each card in the column that is
 * currently shortest. That is a total function of its inputs, so it can be
 * called directly, and it is falsifiable — a round-robin implementation
 * produces a measurably worse column balance on the same heights, which is
 * exactly the defect "a two-column list wearing the word masonry" consists of.
 *
 * What the tests here therefore establish is that the assignment is masonry's
 * assignment. What they do NOT establish is that `MasonryFeed` renders the
 * result, or that two columns lay out side by side on a phone; the first is
 * covered by the feed's own tests reading the rendered columns, and the second
 * is a native layout property that Task 8's device gate is the only thing that
 * can settle.
 */

/**
 * Two, not three.
 *
 * A post card carries a garment collage, an author row, a caption and two
 * controls. At a third of a phone's width the collage thumbnails fall under
 * 60pt and the caption becomes a two-word ellipsis — the same reasoning that
 * put the outfit gallery on two columns rather than the wardrobe grid's three.
 */
export const MASONRY_COLUMNS = 2;

/**
 * Every fixed dimension a post card is built from, in points.
 *
 * Shared by `postCardHeight` below and by `PostCard`'s own `StyleSheet`, so
 * the height this module predicts and the height the card actually lays out
 * cannot drift apart by an edit to one of them. A card whose real height
 * disagrees with the number handed to `assignColumns` still renders — it just
 * renders an unbalanced masonry, which is precisely the defect that has no
 * other detector.
 */
export const POST_CARD_METRICS = {
  /** Padding inside the card, on all four sides. */
  padding: 10,
  /** Vertical gap between the card's blocks (header, media, caption, …). */
  gap: 8,
  /** Space below the card, before the next card in the same column. */
  marginBottom: 10,
  /** The author row: an avatar disc with the name beside it, one line. */
  headerHeight: 32,
  /** One garment thumbnail. */
  thumbnailHeight: 96,
  /** Horizontal AND vertical gap between thumbnails in the collage. */
  thumbnailGap: 6,
  /** Thumbnails per collage row. Two, because the card is half a phone wide. */
  thumbnailsPerRow: 2,
  /** One line of caption. Pinned as an explicit `lineHeight` on the caption. */
  captionLineHeight: 19,
  /**
   * The caption is clamped to this many lines (`numberOfLines`), so a
   * three-paragraph caption cannot make one card as tall as the screen.
   */
  maxCaptionLines: 2,
  /**
   * Roughly how many characters of caption fit on one line at half a phone's
   * width.
   *
   * **THE ONE ESTIMATE IN THIS MODULE, AND IT IS AN ESTIMATE.** Every other
   * term below is a dimension the stylesheet fixes, so the sum is exact up to
   * this. A proportional font makes the true count depend on which characters
   * they are, and the OS font-size setting moves it again, so a caption this
   * over- or under-counts by one line puts one card up to `captionLineHeight`
   * points off. That is a slightly ragged column, not a broken one, and it is
   * bounded: the caption can only ever be one or two lines.
   */
  captionCharsPerLine: 34,
  /** The `missingItemsNotice` line, when there is one. One line, clamped. */
  noticeHeight: 17,
  /** The like/save row. Given an explicit height so this sum stays exact. */
  actionsHeight: 28,
} as const;

/**
 * How many points of collage a post's garments occupy — **0 for a post with
 * none**.
 *
 * Zero is a real case and not an error: items are deleted from wardrobes after
 * a post is shared, and when the last one goes the post still exists and still
 * renders, with its caption and its author (ruling 4). The card omits the
 * collage block entirely rather than reserving an empty rectangle.
 *
 * Every garment is drawn. There is no cap, so a ten-garment outfit is a tall
 * card — which is the sort of card a masonry layout exists to place, and which
 * a cap would have to hide garments to avoid.
 */
export function postMediaHeight(post: DisplayPost): number {
  const { thumbnailHeight, thumbnailGap, thumbnailsPerRow } = POST_CARD_METRICS;
  const rows = Math.ceil(post.items.length / thumbnailsPerRow);
  if (rows <= 0) return 0;
  return rows * thumbnailHeight + (rows - 1) * thumbnailGap;
}

/**
 * How many lines the caption will occupy, clamped to `maxCaptionLines`.
 *
 * At least one: `DisplayPost.caption` is documented as trimmed and never
 * blank, and a zero-line block would be a caption with nothing where it should
 * be. See `captionCharsPerLine` for why this is an estimate rather than a
 * measurement.
 */
export function postCaptionLines(post: DisplayPost): number {
  const { captionCharsPerLine, maxCaptionLines } = POST_CARD_METRICS;
  const wanted = Math.ceil(post.caption.length / captionCharsPerLine);
  return Math.min(maxCaptionLines, Math.max(1, wanted));
}

/**
 * How tall `PostCard` will render this post, including the space beneath it.
 *
 * This is what `assignColumns` is fed. It is a prediction rather than a
 * measurement — React Native cannot report a height before it lays the card
 * out, and a masonry that waited for layout would place every card in the
 * wrong column for one frame and then jump. Every term except the caption's
 * line count is fixed by `POST_CARD_METRICS`, which `PostCard`'s stylesheet
 * reads from too.
 *
 * The margin below the card is included deliberately: what has to be balanced
 * is the height of a COLUMN, and a column's height is the space its cards
 * occupy plus the space between them.
 */
export function postCardHeight(post: DisplayPost): number {
  const {
    padding,
    gap,
    marginBottom,
    headerHeight,
    captionLineHeight,
    noticeHeight,
    actionsHeight,
  } = POST_CARD_METRICS;

  const media = postMediaHeight(post);
  // The blocks the card actually renders, in order. The media block is absent
  // for a post whose garments are all gone, and the notice is absent for a
  // post that is missing none — so the gaps between them have to be counted
  // from this list rather than from a constant.
  const blocks = [
    headerHeight,
    ...(media > 0 ? [media] : []),
    postCaptionLines(post) * captionLineHeight,
    ...(post.missingItemsNotice === null ? [] : [noticeHeight]),
    actionsHeight,
  ];

  const content = blocks.reduce((total, block) => total + block, 0);
  return content + gap * (blocks.length - 1) + padding * 2 + marginBottom;
}

/**
 * Masonry's placement rule: **each card goes to the column that is currently
 * shortest.**
 *
 * Answers one array of indices INTO `heights` per column, in the order the
 * cards should be stacked down that column. Indices rather than heights so a
 * caller can look the post back up; the function itself knows nothing about
 * posts.
 *
 * ## The tie rule, and why it is `<` rather than `<=`
 *
 * A strict comparison keeps the lowest column index when two columns are level,
 * which is what makes the answer stable: equal-height cards alternate
 * left-right-left-right, the reading order a person expects, and the same input
 * always produces the same output. `<=` would take the LAST level column
 * instead, filling right-to-left, and on the very common case of a feed whose
 * cards are all the same height that is a visibly reversed layout.
 *
 * ## What this is deliberately not
 *
 * Not round-robin — `index % columns` — which is the implementation a
 * two-column grid degenerates into and the one this stage is most likely to
 * ship by accident, because it looks identical whenever the cards happen to be
 * the same height. It is separable on unequal heights: alternating strictly by
 * position sends every other tall card to the same column, and the columns end
 * up as far apart as the tall cards are unevenly spread.
 *
 * Not a bin-packing optimum either. Greedy shortest-first is the standard
 * masonry rule and it keeps the cards in feed order down the columns, which
 * matters here: the feed is newest-first, and reordering it to balance the
 * columns better would put an older post above a newer one.
 *
 * ## Defensive arguments
 *
 * `columns` is clamped to at least 1 rather than trusted. The caller passes the
 * constant above, so a bad value is not reachable today; what a 0 would
 * produce, though, is an empty answer — every card dropped from the feed — and
 * "one column" is the direction that still shows the user their posts. A
 * non-finite height counts as 0 for the same reason: `NaN` compares false
 * against everything, so one of them would silently pin every subsequent card
 * into column 0.
 */
export function assignColumns(heights: readonly number[], columns: number): number[][] {
  const columnCount = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1;

  const assignment: number[][] = Array.from({ length: columnCount }, () => []);
  const totals = new Array<number>(columnCount).fill(0);

  heights.forEach((height, index) => {
    let shortest = 0;
    for (let column = 1; column < columnCount; column += 1) {
      // Strictly less than — see the tie rule above.
      if (totals[column] < totals[shortest]) shortest = column;
    }
    assignment[shortest].push(index);
    totals[shortest] += Number.isFinite(height) ? Math.max(0, height) : 0;
  });

  return assignment;
}
