import { getSettings, saveSettings } from './settings';

/**
 * One stop of the guided tour. `target` names a `data-tutorial` attribute in the
 * app shell; a step without one is shown centered with no spotlight. A step whose
 * target is not on screen (Nodes and Namespaces are hidden outside developer
 * mode) is skipped rather than pointing at nothing.
 */
export interface TutorialStep {
  id: string;
  target?: string;
  title: string;
  body: string;
}

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Calimero Desktop',
    body: 'Take a quick tour of the main areas of the app. You can close it at any time and bring it back later from Settings.',
  },
  {
    id: 'home',
    target: 'nav-home',
    title: 'Home',
    body: 'Your starting point: node status at a glance, your most recent applications and quick actions.',
  },
  {
    id: 'nodes',
    target: 'nav-nodes',
    title: 'Nodes',
    body: 'Create, start and stop the merod nodes running on this machine, and switch which one the desktop talks to.',
  },
  {
    id: 'namespaces',
    target: 'nav-namespaces',
    title: 'Namespaces',
    body: 'Browse the namespaces and contexts your node is part of, and manage members and invitations.',
  },
  {
    id: 'account',
    target: 'nav-account',
    title: 'Account',
    body: 'Your identity on this node, the devices paired with it, and the apps signed in with your account.',
  },
  {
    id: 'installed',
    target: 'nav-installed',
    title: 'Applications',
    body: 'Everything installed on your node. Open an app from here, or uninstall the ones you no longer need.',
  },
  {
    id: 'marketplace',
    target: 'nav-marketplace',
    title: 'Marketplace',
    body: 'Discover new applications from the registry and install them in one click.',
  },
  {
    id: 'node-status',
    target: 'node-status',
    title: 'Node status',
    body: 'Shows whether the desktop can reach your node. If it disconnects, click here to reconnect.',
  },
  {
    id: 'settings',
    target: 'nav-settings',
    title: 'Settings',
    body: 'Theme, startup, updates, registries and more. You can replay this tour any time from Settings → General → Help.',
  },
];

export function isTutorialCompleted(): boolean {
  return getSettings().tutorialCompleted ?? false;
}

export function setTutorialCompleted(completed: boolean): void {
  saveSettings({ ...getSettings(), tutorialCompleted: completed });
}

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export type Placement = 'right' | 'left' | 'bottom' | 'top' | 'center';

/** Gap between the spotlight and the popover, and the popover and the viewport edge. */
export const POPOVER_GAP = 14;
export const VIEWPORT_MARGIN = 12;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

/**
 * Where the popover goes for a spotlighted rect. Tries the sides in order of how
 * the shell is laid out - the sidebar sits on the left, so right comes first, and
 * the header on top, so bottom next - and takes the first that fits. When nothing
 * fits (a tiny window) it falls back to centered, which at least stays readable.
 */
export function computePopoverPosition(
  target: Rect | null,
  popover: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number; placement: Placement } {
  const center = {
    top: Math.max(VIEWPORT_MARGIN, (viewport.height - popover.height) / 2),
    left: Math.max(VIEWPORT_MARGIN, (viewport.width - popover.width) / 2),
    placement: 'center' as const,
  };
  if (!target) return center;

  const maxTop = viewport.height - popover.height - VIEWPORT_MARGIN;
  const maxLeft = viewport.width - popover.width - VIEWPORT_MARGIN;
  const alignedTop = clamp(target.top + target.height / 2 - popover.height / 2, VIEWPORT_MARGIN, maxTop);
  const alignedLeft = clamp(target.left + target.width / 2 - popover.width / 2, VIEWPORT_MARGIN, maxLeft);

  const right = target.left + target.width + POPOVER_GAP;
  if (right + popover.width + VIEWPORT_MARGIN <= viewport.width) {
    return { top: alignedTop, left: right, placement: 'right' };
  }
  const below = target.top + target.height + POPOVER_GAP;
  if (below + popover.height + VIEWPORT_MARGIN <= viewport.height) {
    return { top: below, left: alignedLeft, placement: 'bottom' };
  }
  const left = target.left - POPOVER_GAP - popover.width;
  if (left >= VIEWPORT_MARGIN) {
    return { top: alignedTop, left, placement: 'left' };
  }
  const above = target.top - POPOVER_GAP - popover.height;
  if (above >= VIEWPORT_MARGIN) {
    return { top: above, left: alignedLeft, placement: 'top' };
  }
  return center;
}
