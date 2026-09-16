import type { NodeIdentity } from "@calimero-network/mero-js";
import {
  applicationLabel,
  scopeTiles,
  type InstalledApp,
  type ScopeTile,
} from "../components/DevicePairing";
import type {
  AccountApplication,
  AccountDevice,
  NamespaceSummary,
  RelinkResult,
} from "./device-link";
import { appInstalled, decodeMetadata } from "../utils/appUtils";

/** `syncing` marks a device we linked but have not yet seen in the listing. */
export type DeviceRow = AccountDevice & { syncing?: boolean };

/** What the page is saying about one row after an action on it. */
export interface RowNote {
  deviceId: string;
  text: string;
  error?: boolean;
}

/** Everything the rows need naming, fetched once for the whole page. */
export interface AccountCatalog {
  apps: AccountApplication[];
  namespaces: NamespaceSummary[];
  installed: InstalledApp[];
}

/** What the identity card has to say before anything else on it is worth reading. */
export interface DeviceBanner {
  kind: "revoked" | "legacy";
  text: string;
}

export const namespaceWord = (n: number) => (n === 1 ? "namespace" : "namespaces");

/** What this node calls a device, or null where no alias names it and the row
 *  falls back to the short id. Core allows several aliases on one device; the
 *  first the listing carries is the one a row shows. */
export function deviceLabel(
  deviceId: string,
  aliases: Record<string, string>,
): string | null {
  return Object.entries(aliases).find(([, id]) => id === deviceId)?.[0] ?? null;
}

/** Core's empty `applications` means every application, not none. */
export function deviceScope(device: AccountDevice): string {
  const count = device.applications.length;
  if (!count) return "All apps";
  return `${count} ${count === 1 ? "app" : "apps"}`;
}

/** Core reads an empty scope as every application, the opposite of what an empty
 *  relink asks for. */
export function inScope(device: AccountDevice, applicationId: string): boolean {
  return !device.applications.length || device.applications.includes(applicationId);
}

/** The account namespace, but only once the listing shows a device bound into it.
 *  A node too old to bind anybody there would otherwise have every device read as
 *  not following the account. */
export function reportedAccountNamespace(
  devices: AccountDevice[],
  accountNamespaceId: string | null | undefined,
): string | null {
  if (!accountNamespaceId) return null;
  return devices.some((device) => device.namespaces.includes(accountNamespaceId))
    ? accountNamespaceId
    : null;
}

/** Following the account is what carries a device into namespaces nobody told it
 *  about, so it is the binding into the account namespace itself. */
export function followsAccount(
  device: AccountDevice,
  accountNamespace: string | null,
): boolean {
  return !accountNamespace || device.namespaces.includes(accountNamespace);
}

export type DeviceStatus = "active" | "syncing" | "not-following" | "revoked";

export const DEVICE_STATUS_LABEL: Record<DeviceStatus, string> = {
  active: "Active",
  syncing: "Syncing",
  "not-following": "Not following the account",
  revoked: "Revoked",
};

export function deviceStatus(
  device: AccountDevice,
  accountNamespace: string | null,
  syncing: boolean,
): DeviceStatus {
  if (device.revoked) return "revoked";
  if (syncing) return "syncing";
  return followsAccount(device, accountNamespace) ? "active" : "not-following";
}

export type FollowState =
  | "following"
  | "syncing"
  | "not-in-scope"
  | "not-following"
  | "retired";

export const FOLLOW_STATE_LABEL: Record<FollowState, string> = {
  following: "Following",
  syncing: "Syncing",
  "not-in-scope": "Not in scope",
  "not-following": "Not following",
  retired: "Retired",
};

/** What one device is doing about one namespace. A binding the namespace lists is
 *  the only proof of following; everything else says why there is none. */
export function namespaceFollowState(
  device: AccountDevice,
  namespace: NamespaceSummary,
  accountNamespace: string | null,
  syncing: boolean,
): FollowState {
  if (device.revoked) return "retired";
  if (!inScope(device, namespace.targetApplicationId)) return "not-in-scope";
  if (syncing) return "syncing";
  if (!followsAccount(device, accountNamespace)) return "not-following";
  return device.namespaces.includes(namespace.namespaceId) ? "following" : "not-following";
}

/** One app's switch on a device row. Core cannot narrow a scope without a fresh
 *  pairing, so the on direction is the only one a toggle ever takes. */
export interface ScopeToggle {
  on: boolean;
  locked: boolean;
  tip?: string;
}

export function scopeToggle(
  device: AccountDevice,
  applicationId: string,
  isHolder: boolean,
): ScopeToggle {
  const on = inScope(device, applicationId);
  if (device.revoked) {
    return { on: false, locked: true, tip: "Revoked devices cannot be changed" };
  }
  if (!isHolder) {
    return {
      on,
      locked: true,
      tip: "Only the computer holding the account root can change scope",
    };
  }
  if (!device.applications.length) {
    return {
      on: true,
      locked: true,
      tip: "This device follows everything, including apps added later",
    };
  }
  if (on) return { on, locked: true, tip: "Narrowing a scope needs a fresh pairing" };
  return { on, locked: false };
}

export function scopeHint(device: AccountDevice, total: number): string {
  if (!device.applications.length) return "everything, including apps added later";
  return `${device.applications.length} of ${total} ${total === 1 ? "app" : "apps"}`;
}

/** The apps one row switches between: those the account speaks in, plus any this
 *  device's own scope still names. */
export function deviceScopeApps(
  applications: AccountApplication[],
  device: AccountDevice,
  namespaces: NamespaceSummary[],
  installed: InstalledApp[],
): ScopeTile[] {
  const extra = device.applications
    .filter((id) => !applications.some((app) => app.applicationId === id))
    .map((id) => installed.find((app) => app.id === id) ?? { id });
  // Rows for apps the account already names are passed through too: they add
  // nothing to the union, and they are where the app's own name comes from.
  const named = installed.filter((app) =>
    applications.some((entry) => entry.applicationId === app.id),
  );
  return scopeTiles(applications, namespaces, [...extra, ...named]);
}

/** One app the account's namespaces target, as the card lists it. Registry
 *  coordinates are carried only in the pair that can install something. */
export interface AccountAppRow {
  applicationId: string;
  name: string;
  package?: string;
  version?: string;
  namespaces: number;
  devices: number;
  installed: boolean;
}

export function accountAppRows(
  applications: AccountApplication[],
  devices: AccountDevice[],
  namespaces: NamespaceSummary[],
  installed: InstalledApp[],
): AccountAppRow[] {
  return applications
    .map(({ applicationId, namespaces: targeting }) => {
      const app = installed.find((entry) => entry.id === applicationId);
      const meta = decodeMetadata(app?.metadata);
      const pkg = app?.package ?? meta?.package;
      const version = app?.version ?? meta?.version;
      return {
        applicationId,
        name: applicationLabel(applicationId, namespaces, installed),
        ...(pkg && version ? { package: pkg, version } : {}),
        namespaces: targeting.length,
        devices: devices.filter((device) => !device.revoked && inScope(device, applicationId))
          .length,
        installed: appInstalled(app),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function thisDeviceBanner(
  identity: NodeIdentity | null,
  devices: AccountDevice[],
): DeviceBanner | null {
  if (devices.some((device) => device.isSelf && device.revoked)) {
    return {
      kind: "revoked",
      text:
        "This device was revoked from the account. It keeps its local copy but can no " +
        "longer write, and it will not be carried into new namespaces.",
    };
  }
  if (identity && identity.holdsAccountRoot === false && !identity.accountNamespaceId) {
    return {
      kind: "legacy",
      text:
        "This device does not follow the account yet. It was paired by an older version. " +
        "Paste a link code from the computer that holds the account and it will pick up " +
        "the account's namespaces on its own.",
    };
  }
  return null;
}

/** Relinking this node's own device is defined but can never publish anything, so
 *  the holder is not offered it; a device held elsewhere can only repair itself. */
export function canSync(device: AccountDevice, isHolder: boolean): boolean {
  if (device.revoked) return false;
  return isHolder ? !device.isSelf : device.isSelf;
}

/** Revocation is terminal, and its route names a namespace, so a device bound
 *  nowhere has nothing to revoke in. */
export function canRevoke(device: AccountDevice, isHolder: boolean): boolean {
  return isHolder && !device.isSelf && !device.revoked && device.namespaces.length > 0;
}

export function widenSummary({ linkedIn }: RelinkResult, added: number): string {
  const appWord = added === 1 ? "app" : "apps";
  return `Added ${added} ${appWord}, reaching ${linkedIn.length} more ${namespaceWord(linkedIn.length)}.`;
}

/** Only the holder of an account's root can certify a device into it, so a node
 *  paired into someone else's account is offered no invite. A node too old to say
 *  keeps the offer: refusing on a missing field would withdraw a working feature. */
export function canInviteDevices(identity: NodeIdentity | null): boolean {
  return identity?.holdsAccountRoot !== false;
}

/** A device paired into an account holds a device id but may not have synced the
 *  account's roster, and "none found" would read as a pairing that never landed. */
export function devicesEmptyMessage(identity: NodeIdentity | null): string {
  if (!identity) return "This node is not part of an account yet.";
  if (identity.holdsAccountRoot === false) {
    return "This device is linked to an account held on another device. Its devices are managed there.";
  }
  if (identity.deviceId) {
    return "This device is on the account. The account's other devices have not reached it yet.";
  }
  return "No devices found for this account.";
}

export function relinkSummary({ linkedIn, skipped }: RelinkResult): string {
  if (!linkedIn.length && !skipped.length) return "Nothing to repair.";
  return `Repaired ${linkedIn.length} ${namespaceWord(linkedIn.length)}, skipped ${skipped.length}.`;
}
