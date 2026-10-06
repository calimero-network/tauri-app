import { getSettings, saveSettings } from './settings';

/** Shell pages the tour can open; mirrors the sidebar's pages. */
export type TourPage = 'home' | 'nodes' | 'namespaces' | 'cloud' | 'account' | 'installed' | 'marketplace';
/** Settings tabs the tour can open; mirrors the tab bar in pages/Settings. */
export type SettingsTab = 'general' | 'registries' | 'agent' | 'account' | 'cloud';

/** Where the app has to be for a step: a shell page, or a tab of Settings. */
export type TourLocation = { view: 'shell'; page: TourPage } | { view: 'settings'; tab: SettingsTab };

/**
 * One stop of the guided tour. The tour opens `at` before showing the step, then
 * spotlights the element whose `data-tutorial` attribute is `target`; a step with
 * no target is shown centered. Pages load lazily and fetch their data, so the
 * target is waited for - if it never shows up the step is still shown, centered,
 * unless it is `optional`, in which case it is skipped.
 */
export interface TutorialStep {
  id: string;
  at: TourLocation;
  target?: string;
  optional?: boolean;
  /** Only part of the tour when this feature is on: the UI it explains is hidden otherwise. */
  requires?: 'developerMode' | 'cloud';
  title: string;
  body: string;
}

const page = (p: TourPage): TourLocation => ({ view: 'shell', page: p });
const tab = (t: SettingsTab): TourLocation => ({ view: 'settings', tab: t });

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  // ─── Home ───
  {
    id: 'welcome',
    at: page('home'),
    title: 'Welcome to Calimero Desktop',
    body: 'This tour walks through every page of the app and every tab of Settings, and explains what each part does. It opens each page for you as it goes. Use the arrow keys or the buttons to move, and close it at any time - you can replay it later from Settings → General → Help.',
  },
  {
    id: 'home',
    at: page('home'),
    target: 'nav-home',
    title: 'Home',
    body: 'Your starting point. It shows whether your node is reachable, the applications you installed most recently, and shortcuts to the things you do most.',
  },
  {
    id: 'home-status',
    at: page('home'),
    target: 'home-status',
    title: 'Node status',
    body: 'Calimero apps run on your own node - merod - which keeps your data on this computer and syncs it peer-to-peer. This card says whether the desktop can reach it. If it shows Disconnected (for example after your computer slept), a Reconnect button appears here.',
  },
  {
    id: 'home-actions',
    at: page('home'),
    target: 'home-actions',
    title: 'Quick actions',
    body: 'Jump straight to the Marketplace to install something new, to your Applications, or to Settings. Once you have apps installed, the four most recent show above this row, and clicking one opens it in its own window.',
  },
  {
    id: 'node-status',
    at: page('home'),
    target: 'node-status',
    title: 'Connection indicator',
    body: 'Visible on every page. Green means the desktop is talking to your node. When you run more than one local node, this is also where you switch which one the app is connected to. Click it while disconnected to reconnect.',
  },

  // ─── Nodes ───
  {
    id: 'nodes',
    at: page('nodes'),
    target: 'nav-nodes',
    requires: 'developerMode',
    title: 'Nodes',
    body: 'Everything about the merod nodes on this machine: which one the app talks to, creating new ones, starting and stopping them, and reading their logs.',
  },
  {
    id: 'nodes-connection',
    at: page('nodes'),
    target: 'nodes-connection',
    requires: 'developerMode',
    title: 'Connection',
    body: 'The node URL the app uses. It is your local node by default (http://localhost:2528), but you can point it at a remote node instead. The Auth URL is only needed when authentication is served from somewhere other than the node itself. Save to apply.',
  },
  {
    id: 'nodes-local',
    at: page('nodes'),
    target: 'nodes-local',
    requires: 'developerMode',
    title: 'Local nodes',
    body: 'Create a new node by giving it a name, a data directory, ports and an admin login - you can also pick which merod release it runs. Under Manage Nodes, select a node to Start, Stop or Restart it, see its ports, and open its logs. Debug logs are on by default, so the logs carry what you need when something goes wrong.',
  },
  {
    id: 'nodes-versions',
    at: page('nodes'),
    target: 'nodes-versions',
    requires: 'developerMode',
    optional: true,
    title: 'merod versions',
    body: 'The merod releases downloaded to this computer and how much disk they use. The app ships with a bundled release; others are added when you pick one while creating a node, and can be removed here.',
  },

  // ─── Namespaces ───
  {
    id: 'namespaces',
    at: page('namespaces'),
    target: 'nav-namespaces',
    requires: 'developerMode',
    title: 'Namespaces',
    body: 'A namespace is a workspace bound to one application - think of a team or a project. It holds contexts (running instances of the app, like a single chat channel) and subgroups (nested groups with their own contexts and members).',
  },
  {
    id: 'namespaces-apps',
    at: page('namespaces'),
    target: 'namespaces-header',
    requires: 'developerMode',
    title: 'Browse by application',
    body: 'Namespaces are grouped by the application they belong to, with an estimate of how much disk they use. Open an application to see its namespaces, create a new one, and drill into its contexts, members, invitations and subgroups.',
  },
  {
    id: 'namespaces-join',
    at: page('namespaces'),
    target: 'namespaces-join',
    requires: 'developerMode',
    title: 'Join a namespace',
    body: 'Someone invited you? Paste the invitation here to join their namespace. The invitation names the application, so you do not have to pick one first.',
  },

  // ─── Cloud ───
  {
    id: 'cloud',
    at: page('cloud'),
    target: 'nav-cloud',
    requires: 'cloud',
    title: 'Cloud',
    body: 'Calimero Cloud in one place. The dot next to it shows whether you are signed in: green when you are, amber when the session ran out.',
  },
  {
    id: 'cloud-apps',
    at: page('cloud'),
    target: 'cloud-apps',
    requires: 'cloud',
    optional: true,
    title: 'High Availability',
    body: 'Every namespace on this node, grouped by its application. Turn on High Availability and fleet nodes running in secure enclaves keep that namespace online and in sync while your devices are off. Only a namespace\'s admin can turn it on; namespaces shared with you show a lock.',
  },

  // ─── Account ───
  {
    id: 'account',
    at: page('account'),
    target: 'nav-account',
    title: 'Account',
    body: 'Your identity. One account can span several devices - this computer, your laptop, your phone - and each device holds its own key that the account authorises.',
  },
  {
    id: 'account-identity',
    at: page('account'),
    target: 'account-identity',
    title: 'This device',
    body: 'The account this node belongs to and this device\'s own identity. A fresh node gets an account identity the first time it takes part in a namespace.',
  },
  {
    id: 'account-cloud',
    at: page('account'),
    target: 'account-cloud',
    requires: 'cloud',
    optional: true,
    title: 'Link to Calimero Cloud',
    body: 'Link this account to your Calimero Cloud login so a plan can be attributed to it and you can find your namespaces again from a new device. Your account key signs a challenge from the cloud - it never leaves this computer.',
  },
  {
    id: 'account-devices',
    at: page('account'),
    target: 'account-devices',
    title: 'Devices',
    body: 'Every device paired with this account. Expand one to rename it, change what it may act for, sync it, or revoke it if it was lost. Add a device starts pairing a new one.',
  },
  {
    id: 'account-apps',
    at: page('account'),
    target: 'account-apps',
    title: 'Apps on this account',
    body: 'The applications your account\'s namespaces use, and on how many devices. If one is missing on this computer you can install it from here.',
  },
  {
    id: 'account-pair',
    at: page('account'),
    target: 'account-pair',
    title: 'Pair this computer',
    body: 'Already have an account on another device? Pair this computer into it from here instead of starting a new one.',
  },

  // ─── Applications ───
  {
    id: 'installed',
    at: page('installed'),
    target: 'nav-installed',
    title: 'Applications',
    body: 'Everything installed on your node.',
  },
  {
    id: 'installed-list',
    at: page('installed'),
    target: 'installed-header',
    title: 'Your applications',
    body: 'Click an app to open it in its own window. Its menu lets you create a launcher - a shortcut that opens the app straight from your desktop - or uninstall it. The refresh button reloads the list from the node.',
  },

  // ─── Marketplace ───
  {
    id: 'marketplace',
    at: page('marketplace'),
    target: 'nav-marketplace',
    title: 'Marketplace',
    body: 'Discover applications published to your registries and install them in one click. Open an app for its description, screenshots and versions.',
  },
  {
    id: 'marketplace-controls',
    at: page('marketplace'),
    target: 'marketplace-controls',
    title: 'Search and filter',
    body: 'Search by name, show only what is installed or not installed, and narrow down by category. Which registries the Marketplace lists is set in Settings → Registries.',
  },

  // ─── Settings ───
  {
    id: 'settings',
    at: page('marketplace'),
    target: 'nav-settings',
    title: 'Settings',
    body: 'Last stop: Settings. Let\'s go through each of its tabs.',
  },
  {
    id: 'settings-tabs',
    at: tab('general'),
    target: 'settings-tabs',
    title: 'Settings tabs',
    body: 'General holds app preferences, Registries the app sources, AI Agent connects a coding agent to your node, Account links to your devices, and Cloud signs you in to Calimero Cloud. The Back button at the top returns to the app.',
  },
  {
    id: 'settings-startup',
    at: tab('general'),
    target: 'settings-startup',
    title: 'Startup',
    body: 'Start Calimero when you log in, so your node is running and syncing without you opening the app.',
  },
  {
    id: 'settings-appearance',
    at: tab('general'),
    target: 'settings-appearance',
    title: 'Appearance',
    body: 'Switch between the light and dark theme.',
  },
  {
    id: 'settings-help',
    at: tab('general'),
    target: 'settings-help',
    title: 'Help',
    body: 'Turn this on to replay this tour the next time you leave Settings.',
  },
  {
    id: 'settings-updates',
    at: tab('general'),
    target: 'settings-updates',
    title: 'Updates',
    body: 'The version you are running. Calimero checks for updates by itself; check here to update right away.',
  },
  {
    id: 'settings-developer-mode',
    at: tab('general'),
    target: 'settings-developer-mode',
    title: 'Developer mode',
    body: 'On by default. It shows the Nodes and Namespaces pages and multi-node management. Turn it off for a simpler, single-node app.',
  },
  {
    id: 'settings-debug-logs',
    at: tab('general'),
    target: 'settings-debug-logs',
    title: 'Debug logs',
    body: 'On by default, so node logs have enough detail to troubleshoot. Changing it applies the next time the node restarts.',
  },
  {
    id: 'settings-cloud-toggle',
    at: tab('general'),
    target: 'settings-cloud-toggle',
    title: 'Enable Cloud',
    body: 'On by default. Shows Calimero Cloud everywhere in the app: the Cloud page in the sidebar, this Cloud tab, the cloud card on Account, and High Availability on namespaces. Turning it off hides them immediately.',
  },
  {
    id: 'settings-reset',
    at: tab('general'),
    target: 'settings-reset',
    title: 'Reset',
    body: 'Reset app clears settings and starts the app from scratch but leaves your nodes and their data alone. Total nuke also deletes the data folder - every node, app and namespace on this machine - so use it with care.',
  },
  {
    id: 'settings-registries',
    at: tab('registries'),
    target: 'settings-registries',
    title: 'Registries',
    body: 'The registries the Marketplace lists applications from. The Calimero registry is there by default; add the URL of another - your own, or a team\'s - to browse its apps too. Changes save automatically.',
  },
  {
    id: 'settings-agent',
    at: tab('agent'),
    target: 'settings-agent',
    title: 'AI Agent',
    body: 'Give a coding agent like Claude Code, Cursor or Codex CLI its own key for this node, so the Calimero MCP server can drive your installed apps for it. You get a ready-made prompt and MCP config to paste into the agent; connecting again replaces and revokes the previous key.',
  },
  {
    id: 'settings-account',
    at: tab('account'),
    target: 'settings-account',
    title: 'Account',
    body: 'A shortcut to the Account page, where your devices and account apps live.',
  },
  {
    id: 'settings-cloud',
    at: tab('cloud'),
    target: 'settings-cloud',
    requires: 'cloud',
    title: 'Calimero Cloud',
    body: 'Sign in with Google to connect Calimero Cloud: cloud-hosted contexts, High Availability replication of your namespaces, and managed infrastructure. Your local node stays primary - cloud is additive. Once connected, you see your plan here and can disconnect at any time. High Availability for each namespace is managed from the Cloud page in the sidebar.',
  },

  {
    id: 'done',
    at: page('home'),
    title: "You're all set",
    body: 'That is the whole app. Start by installing something from the Marketplace. You can replay this tour any time from Settings → General → Help.',
  },
];

/** The steps for this session: those whose feature is switched off are left out. */
export function tutorialSteps(features: { developerMode: boolean; cloud: boolean }): TutorialStep[] {
  return TUTORIAL_STEPS.filter((step) => !step.requires || features[step.requires]);
}

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

export type Placement = 'right' | 'left' | 'bottom' | 'top' | 'corner' | 'center';

/** Gap between the spotlight and the popover, and the popover and the viewport edge. */
export const POPOVER_GAP = 14;
export const VIEWPORT_MARGIN = 12;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

/**
 * Where the popover goes for a spotlighted rect. Tries the sides in order of how
 * the shell is laid out - the sidebar sits on the left, so right comes first, and
 * the header on top, so bottom next - and takes the first that fits. When nothing
 * fits - a whole card or section that fills the page - it sits in the bottom-right
 * corner, which covers the least of a target laid out from the top left. With no
 * target at all it is centered.
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
  return {
    top: Math.max(VIEWPORT_MARGIN, maxTop),
    left: Math.max(VIEWPORT_MARGIN, maxLeft),
    placement: 'corner',
  };
}
