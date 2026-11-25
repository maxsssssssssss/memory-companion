import { describe, expect, it } from 'vitest';
import { editVisibilityDelta } from './notebook-scroll';

describe('edit controls stay in the reading area', () => {
  it('does not move when both buttons are visible, even just inside the page edge', () => {
    expect(editVisibilityDelta(394, 845, 520, 800, 844.9)).toBe(0);
  });
  it('keeps visible buttons in place when the beginning of the field is above the viewport', () => {
    expect(editVisibilityDelta(100, 500, 84, 200, 244)).toBe(0);
  });
  it('reveals ordinary clipped edit controls with only the missing distance and breathing room', () => {
    expect(editVisibilityDelta(394, 845, 744.297, 836.297, 880.297)).toBeCloseTo(45.297);
  });
  it('includes both rows of buttons on a narrow page', () => {
    expect(editVisibilityDelta(100, 500, 330, 443, 538)).toBe(48);
  });
  it('reveals a clipped action row above the viewport', () => {
    expect(editVisibilityDelta(100, 500, -20, 80, 124)).toBe(-30);
  });
  it('does not chase the end of an oversized edit whose beginning is visible', () => {
    expect(editVisibilityDelta(100, 500, 200, 856, 900)).toBe(0);
  });
  it('reveals the beginning of an oversized edit when both field and actions are below the viewport', () => {
    expect(editVisibilityDelta(100, 500, 550, 1456, 1500)).toBe(440);
  });
  it('uses visual viewport offsets without assuming a desktop size', () => {
    expect(editVisibilityDelta(80, 580, 410, 566, 610)).toBe(40);
  });
});
