import { describe, it, expect } from 'vitest';
import { computePopoverPosition, POPOVER_GAP, VIEWPORT_MARGIN, TUTORIAL_STEPS } from './tutorial';

const viewport = { width: 1200, height: 800 };
const popover = { width: 320, height: 180 };

describe('computePopoverPosition', () => {
  it('centers when there is no target', () => {
    expect(computePopoverPosition(null, popover, viewport)).toEqual({
      top: (800 - 180) / 2,
      left: (1200 - 320) / 2,
      placement: 'center',
    });
  });

  it('places to the right of a sidebar item, vertically aligned', () => {
    const pos = computePopoverPosition({ top: 100, left: 8, width: 224, height: 40 }, popover, viewport);
    expect(pos.placement).toBe('right');
    expect(pos.left).toBe(8 + 224 + POPOVER_GAP);
    expect(pos.top).toBe(100 + 20 - 90);
  });

  it('clamps an aligned popover inside the viewport', () => {
    const pos = computePopoverPosition({ top: 4, left: 8, width: 224, height: 20 }, popover, viewport);
    expect(pos.top).toBe(VIEWPORT_MARGIN);
  });

  it('falls back to below for a target at the right edge, like the header status pill', () => {
    const pos = computePopoverPosition({ top: 16, left: 1000, width: 180, height: 32 }, popover, viewport);
    expect(pos.placement).toBe('bottom');
    expect(pos.top).toBe(16 + 32 + POPOVER_GAP);
    expect(pos.left + popover.width).toBeLessThanOrEqual(viewport.width - VIEWPORT_MARGIN);
  });

  it('centers when no side fits', () => {
    const tiny = { width: 340, height: 200 };
    const pos = computePopoverPosition({ top: 0, left: 0, width: 340, height: 200 }, popover, tiny);
    expect(pos.placement).toBe('center');
  });
});

describe('TUTORIAL_STEPS', () => {
  it('has unique ids', () => {
    const ids = TUTORIAL_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
