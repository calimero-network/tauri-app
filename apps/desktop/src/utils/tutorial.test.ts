import { describe, it, expect } from 'vitest';
import { computePopoverPosition, POPOVER_GAP, VIEWPORT_MARGIN, TUTORIAL_STEPS, tutorialSteps } from './tutorial';

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

  it('goes to the bottom-right corner when no side fits a large target', () => {
    const pos = computePopoverPosition({ top: 80, left: 240, width: 940, height: 700 }, popover, viewport);
    expect(pos).toEqual({
      top: 800 - 180 - VIEWPORT_MARGIN,
      left: 1200 - 320 - VIEWPORT_MARGIN,
      placement: 'corner',
    });
  });

  it('stays inside a window too small for the popover', () => {
    const tiny = { width: 300, height: 150 };
    const pos = computePopoverPosition({ top: 0, left: 0, width: 300, height: 150 }, popover, tiny);
    expect(pos.top).toBe(VIEWPORT_MARGIN);
    expect(pos.left).toBe(VIEWPORT_MARGIN);
  });
});

describe('TUTORIAL_STEPS', () => {
  it('has unique ids', () => {
    const ids = TUTORIAL_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('opens a page or a Settings tab for every step', () => {
    for (const step of TUTORIAL_STEPS) expect(step.at).toBeDefined();
  });

  it('covers every Settings tab', () => {
    const tabs = new Set(TUTORIAL_STEPS.flatMap((s) => (s.at.view === 'settings' ? [s.at.tab] : [])));
    expect([...tabs].sort()).toEqual(['account', 'agent', 'cloud', 'general', 'registries']);
  });
});

describe('tutorialSteps', () => {
  it('keeps everything when developer mode and cloud are on', () => {
    expect(tutorialSteps({ developerMode: true, cloud: true })).toHaveLength(TUTORIAL_STEPS.length);
  });

  it('drops the Nodes and Namespaces steps outside developer mode', () => {
    const ids = tutorialSteps({ developerMode: false, cloud: true }).map((s) => s.id);
    expect(ids.some((id) => id.startsWith('nodes') || id.startsWith('namespaces'))).toBe(false);
    expect(ids).toContain('settings-cloud');
  });

  it('drops the cloud steps when cloud is off', () => {
    const ids = tutorialSteps({ developerMode: true, cloud: false }).map((s) => s.id);
    expect(ids).not.toContain('settings-cloud');
    expect(ids).not.toContain('account-cloud');
    expect(ids).toContain('nodes');
  });
});
