import type { DeviceScope, NodeIdentity } from "@calimero-network/mero-js";
import {
  applicationIcon,
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
  RescopeResult,
} from "./device-link";
import { appInstalled, decodeMetadata } from "../utils/appUtils";

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

export const namespaceWord = (n: number) => (n === 1 ? "namespace" : "namespaces");

/** What this node calls a device, or null where no alias names it. Core allows
 *  several aliases on one device; a row shows the first the listing carries. */
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

export type DeviceStatus = "active" | "revoked";

export const DEVICE_STATUS_LABEL: Record<DeviceStatus, string> = {
  active: "Active",
  revoked: "Revoked",
};

export function deviceStatus(device: AccountDevice): DeviceStatus {
  return device.revoked ? "revoked" : "active";
}

export type FollowState = "following" | "not-in-scope" | "not-following" | "retired";

export const FOLLOW_STATE_LABEL: Record<FollowState, string> = {
  following: "Following",
  "not-in-scope": "Not in scope",
  "not-following": "Not following",
  retired: "Retired",
};

/** What one device is doing about one namespace. A binding the namespace lists is
 *  the only proof of following; everything else says why there is none. */
export function namespaceFollowState(
  device: AccountDevice,
  namespace: NamespaceSummary,
): FollowState {
  if (device.revoked) return "retired";
  if (!inScope(device, namespace.targetApplicationId)) return "not-in-scope";
  return device.namespaces.includes(namespace.namespaceId) ? "following" : "not-following";
}

/** The apps a device acts for, spelled out. Core's empty scope is every
 *  application, which on a row is every app that row lists. */
export function effectiveScope(device: AccountDevice, rowAppIds: string[]): string[] {
  return device.applications.length ? device.applications : rowAppIds;
}

/** A switch the reader moved: the first one, or one app's. */
export type ScopeChange =
  | { kind: "all"; on: boolean }
  | { kind: "app"; applicationId: string; on: boolean };

/** The scope to ask core for once a switch has moved. Only the first switch ever
 *  asks for `all`; switching an app on holds the device to a list. */
export function nextScope(
  device: AccountDevice,
  rowAppIds: string[],
  change: ScopeChange,
): DeviceScope {
  if (change.kind === "all") return change.on ? "all" : { only: rowAppIds };
  const rest = effectiveScope(device, rowAppIds).filter((id) => id !== change.applicationId);
  return { only: change.on ? [...rest, change.applicationId] : rest };
}

/** One switch on a device row. */
export interface ScopeToggle {
  on: boolean;
  locked: boolean;
}

/** Every switch in a row's app section: the first one, then one per app. */
export interface ScopeSwitches {
  all: ScopeToggle;
  apps: Record<string, ScopeToggle>;
}

export function scopeSwitches(
  device: AccountDevice,
  rowAppIds: string[],
  isHolder: boolean,
): ScopeSwitches {
  const held = new Set(effectiveScope(device, rowAppIds));
  // Only the holder certifies, a withdrawn device is past changing, and the
  // holder's own device follows the account by definition.
  const frozen = !isHolder || device.revoked || device.isSelf;
  return {
    all: { on: !device.applications.length, locked: frozen || !rowAppIds.length },
    apps: Object.fromEntries(
      rowAppIds.map((id) => [
        id,
        // Core refuses an empty scope, so the last app left on cannot go off.
        { on: held.has(id), locked: frozen || (held.has(id) && held.size === 1) },
      ]),
    ),
  };
}

/** Why a row's switches are locked, said once under the app list: a tooltip on
 *  each one is neither findable nor worth repeating. Null where none is. */
export function scopeLockHint(
  device: AccountDevice,
  isHolder: boolean,
  rowAppIds: string[],
): string | null {
  if (device.revoked) return "Revoked devices cannot be changed.";
  if (!isHolder) return "Only the computer holding the account root can change scope.";
  if (device.isSelf) return "This device follows everything, including apps added later.";
  if (!rowAppIds.length) return "Add an app to the account before limiting this device.";
  if (effectiveScope(device, rowAppIds).length === 1) {
    return "A device acts for at least one app. Revoke it to remove it entirely.";
  }
  return null;
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
  icon?: string;
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
    .map((entry) => {
      const { applicationId } = entry;
      const app = installed.find((row) => row.id === applicationId);
      const meta = decodeMetadata(app?.metadata);
      const pkg = app?.package ?? meta?.package;
      const version = app?.version ?? meta?.version;
      const icon = applicationIcon(applicationId, installed);
      return {
        applicationId,
        name: applicationLabel(applicationId, namespaces, installed),
        ...(icon ? { icon } : {}),
        ...(pkg && version ? { package: pkg, version } : {}),
        namespaces: entry.namespaces.length,
        devices: devices.filter((device) => !device.revoked && inScope(device, applicationId))
          .length,
        installed: appInstalled(app),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** What the identity card has to say before anything else on it is worth reading. */
export function thisDeviceBanner(devices: AccountDevice[]): string | null {
  if (devices.some((device) => device.isSelf && device.revoked)) {
    return (
      "This device was revoked from the account. It keeps its local copy but can no " +
      "longer write, and it will not be carried into new namespaces."
    );
  }
  return null;
}

/** Relinking this node's own device is defined but can never publish anything, so
 *  the holder is not offered it; a device held elsewhere can only repair itself. */
export function canSync(device: AccountDevice, isHolder: boolean): boolean {
  // A relink certifies, and only the node holding the account root can.
  return isHolder && !device.isSelf && !device.revoked;
}

/** Revocation is terminal, and its route names a namespace, so a device bound
 *  nowhere has nothing to revoke in. */
export function canRevoke(device: AccountDevice, isHolder: boolean): boolean {
  return isHolder && !device.isSelf && !device.revoked && device.namespaces.length > 0;
}

/** What a scope replacement moved. The word "namespace" is said once, so the
 *  combined sentence carries only the second count. */
export function rescopeSummary({ descoped, bound }: RescopeResult): string {
  if (!descoped.length && !bound.length) return "Scope updated.";
  if (!descoped.length) return `Added to ${bound.length} ${namespaceWord(bound.length)}.`;
  const removed = `Removed from ${descoped.length} ${namespaceWord(descoped.length)}`;
  return bound.length ? `${removed}, added to ${bound.length}.` : `${removed}.`;
}

/** Only the holder of an account's root can certify a device into it. A node too
 *  old to say keeps the offer rather than losing a feature over a missing field. */
export function canInviteDevices(identity: NodeIdentity | null): boolean {
  return identity?.holdsAccountRoot !== false;
}

/** A device paired into an account holds a device id but may not have synced the
 *  account's roster, and "none found" would read as a pairing that never landed. */
export function devicesEmptyMessage(identity: NodeIdentity | null): string {
  if (!identity) return "This node is not part of an account yet.";
  if (identity.holdsAccountRoot === false) {
    if (identity.deviceCertified === false) {
      return "Pairing is not finished. Finish it on the computer that holds the account.";
    }
    return "This device is linked to an account held on another device. Its devices are managed there.";
  }
  if (identity.deviceId) {
    return "This device is on the account. The account's other devices have not reached it yet.";
  }
  return "No devices found for this account.";
}

export function relinkSummary({ linkedIn, pending }: RelinkResult): string {
  if (!linkedIn.length) {
    if (!pending.length) return "Already up to date.";
    return `${pending.length} ${namespaceWord(pending.length)} not reachable yet. Try again shortly.`;
  }
  const repaired = `Repaired ${linkedIn.length} ${namespaceWord(linkedIn.length)}`;
  return pending.length ? `${repaired}, ${pending.length} not reachable yet.` : `${repaired}.`;
}
