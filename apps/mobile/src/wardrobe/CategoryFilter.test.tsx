import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ITEM_CATEGORIES } from '@wardrobe/shared';
import { CategoryFilter } from './CategoryFilter';

describe('CategoryFilter', () => {
  it('renders All plus every category', async () => {
    // Asserted against ITEM_CATEGORIES rather than a hardcoded list of ten
    // strings, so adding a category to the shared package cannot silently
    // leave the UI behind.
    await render(<CategoryFilter value={null} onChange={jest.fn()} />);

    expect(screen.getByTestId('filter-all')).toBeTruthy();
    for (const category of ITEM_CATEGORIES) {
      expect(screen.getByTestId(`filter-${category}`)).toBeTruthy();
    }
    // The count check is what makes the loop above load-bearing: without it,
    // rendering the ten categories *plus* an eleventh invented one would pass.
    expect(screen.getAllByTestId(/^filter-/)).toHaveLength(ITEM_CATEGORIES.length + 1);
  });

  it('marks the selected chip as selected', async () => {
    await render(<CategoryFilter value="shoes" onChange={jest.fn()} />);

    expect(screen.getByTestId('filter-shoes')).toBeSelected();
    expect(screen.getByTestId('filter-jacket')).not.toBeSelected();
    expect(screen.getByTestId('filter-all')).not.toBeSelected();
  });

  it('marks All as selected when no category is chosen', async () => {
    await render(<CategoryFilter value={null} onChange={jest.fn()} />);

    expect(screen.getByTestId('filter-all')).toBeSelected();
    for (const category of ITEM_CATEGORIES) {
      expect(screen.getByTestId(`filter-${category}`)).not.toBeSelected();
    }
  });

  it('calls onChange with the category when a chip is tapped', async () => {
    const onChange = jest.fn();
    await render(<CategoryFilter value={null} onChange={onChange} />);

    await fireEvent.press(screen.getByTestId('filter-jacket'));

    expect(onChange).toHaveBeenCalledWith('jacket');
  });

  it('calls onChange with null when All is tapped', async () => {
    // The plan drafted this as `undefined`; the hook this component exists to
    // drive settled on `null` for "no filter" (`category: ItemCategory | null`,
    // `setCategory(next: ItemCategory | null)`), so `null` is what the single
    // call site can actually consume. See the note in CategoryFilter.tsx.
    //
    // The negative assertion is the point of the test: `'all'` is not a member
    // of ITEM_CATEGORIES and `GET /items?category=all` is a 400.
    const onChange = jest.fn();
    await render(<CategoryFilter value="jacket" onChange={onChange} />);

    await fireEvent.press(screen.getByTestId('filter-all'));

    expect(onChange).toHaveBeenCalledWith(null);
    expect(onChange).not.toHaveBeenCalledWith('all');
  });  it('does not let a flex parent shrink the chip row', async () => {
    // Not cosmetic, and not something any assertion here can truly see. A
    // horizontal ScrollView has no intrinsic height, so a column flex parent
    // may hand it whatever space is left — and when a sibling claims that
    // space the chips are clipped from the bottom instead of the row
    // scrolling. On a device this shipped as a filter rendering only the top
    // few pixels of every label: the apex of the "A" in "All", the ascenders
    // of "tshirt". The pills still sized correctly per label, so it read as
    // deliberate rather than broken.
    //
    // RNTL cannot observe a clipped glyph. What it CAN observe is the property
    // that makes clipping impossible, which is why this asserts the style
    // rather than the appearance. The appearance is Stage 5's device
    // screenshot; this test only stops the fix being deleted.
    await render(<CategoryFilter value={null} onChange={() => {}} />);
    const scroller = await screen.findByTestId('category-filter');
    expect(StyleSheet.flatten(scroller.props.style)).toMatchObject({
      flexGrow: 0,
      flexShrink: 0,
    });
  });


});
