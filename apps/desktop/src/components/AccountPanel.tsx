import { useState, useEffect } from "react";
import { Check, ChevronRight, Plus, RefreshCw, Trash2 } from "lucide-react";
import AppIcon from "./AppIcon";
import CopyButton from "./CopyButton";
import {
  DevicePairWizard,
  DevicePairResponder,
  applicationLabel,
  scopeTiles,
  tileNamespaceCount,
  type InstalledApp,
  type ScopeTile,
} from "./DevicePairing";
import { SkeletonText, SkeletonTable } from "./Skeleton";
import { useVisiblePoll } from "../hooks/useVisiblePoll";
import type { NodeIdentity } from "@calimero-network/mero-js";
import {
  aliasFromInput,
  createDeviceAlias,
  deleteDeviceAlias,
  listAccountApplications,
  listAccountDevices,
  listDeviceAliases,
  listNamespaces,
  nodeIdentity,
  relinkDevice,
  revokeDevice,
  type AccountApplication,
  type AccountDevice,
  type NamespaceSummary,
  type RelinkResult,
} from "../lib/device-link";
import { appInstalled, decodeMetadata, parseTauriError } from "../utils/appUtils";
import { apiClient } from "../lib/mero-client";
import { invalidateInstalledApps, listInstalledApps } from "../utils/installedAppsCache";
import { truncateText } from "../utils/string";
import "./AccountPanel.css";

/** The five the card prints. Named rather than `keyof`, which now also spans a
 *  boolean these rows cannot render. */
const IDENTITY_FIELDS: {
  id: string;
  label: string;
  key:
    | "accountId"
    | "deviceId"
    | "publicKey"
    | "accountRootPublicKey"
    | "accountNamespaceId";
}[] = [
  { id: "account-id", label: "Account ID", key: "accountId" },
  { id: "device-id", label: "Device ID", key: "deviceId" },
  { id: "public-key", label: "Device public key", key: "publicKey" },
  { id: "account-root-public-key", label: "Account root public key", key: "accountRootPublicKey" },
  { id: "account-namespace", label: "Account namespace", key: "accountNamespaceId" },
];

/** `syncing` marks a device we linked but have not yet seen in the listing. */
type DeviceRow = AccountDevice & { syncing?: boolean };

/** What the panel is saying about one row after an action on it. */
interface RowNote {
  deviceId: string;
  text: string;
  error?: boolean;
}

const namespaceWord = (n: number) => (n === 1 ? "namespace" : "namespaces");

const dropKey = <T,>(map: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(map).filter(([at]) => at !== key));

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

/** What the identity card has to say before anything else on it is worth reading. */
export function thisDeviceBanner(
  identity: NodeIdentity | null,
  devices: AccountDevice[],
): { kind: "revoked" | "legacy"; text: string } | null {
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

export default function AccountPanel() {
  const [identity, setIdentity] = useState<NodeIdentity | null>(null);
  const [identityLoading, setIdentityLoading] = useState(true);
  const [identityError, setIdentityError] = useState("");
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState("");
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState("");
  const [renameText, setRenameText] = useState("");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [deviceReloads, setDeviceReloads] = useState(0);
  const [busyDevice, setBusyDevice] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // The app each row is waiting to see in the listing after a relink widened it.
  const [widening, setWidening] = useState<Record<string, string>>({});
  const [catalog, setCatalog] = useState<{
    apps: AccountApplication[];
    namespaces: NamespaceSummary[];
    installed: InstalledApp[];
  }>({ apps: [], namespaces: [], installed: [] });
  const [rowNote, setRowNote] = useState<RowNote | null>(null);
  const [installing, setInstalling] = useState("");
  const [installError, setInstallError] = useState<RowNote | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setIdentityLoading(true);
    setIdentityError("");
    nodeIdentity()
      .then((next) => {
        if (!controller.signal.aborted) setIdentity(next);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setIdentityError(parseTauriError(err, "Could not read this device's identity"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setIdentityLoading(false);
      });
    return () => controller.abort();
  }, [reloads]);

  // Kept apart from the identity fetch: a device listing that fails must not
  // take the account and key fields off the screen with it.
  const accountId = identity?.accountId;
  useEffect(() => {
    if (!accountId) {
      setDevices([]);
      return;
    }
    const controller = new AbortController();
    setDevicesLoading(true);
    setDevicesError("");
    // A name is a nicety; a lookup that fails must not take the listing with it.
    Promise.all([listAccountDevices(), listDeviceAliases().catch(() => ({}))])
      .then(([rows, names]) => {
        if (controller.signal.aborted) return;
        setDevices(rows);
        setAliases(names);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setDevicesError(parseTauriError(err, "Could not list the devices on this account"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDevicesLoading(false);
      });
    return () => controller.abort();
  }, [accountId, reloads, deviceReloads]);

  // Names and namespace counts for the expanded rows. A failure here leaves the
  // rows readable by id rather than taking the listing down with it.
  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();
    Promise.all([
      listAccountApplications(),
      listNamespaces(controller.signal),
      listInstalledApps()
        .then((r) => (Array.isArray(r.data) ? (r.data as InstalledApp[]) : []))
        .catch(() => [] as InstalledApp[]),
    ])
      .then(([apps, namespaces, installed]) => {
        if (!controller.signal.aborted) setCatalog({ apps, namespaces, installed });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [accountId, reloads, deviceReloads]);

  // Core follows and unfollows this device's namespaces on its own, so both
  // listings change with nothing here asking. A failed poll keeps what it has.
  useVisiblePoll(
    () => {
      listAccountDevices()
        .then(setDevices)
        .catch(() => {});
      listDeviceAliases()
        .then(setAliases)
        .catch(() => {});
      listNamespaces()
        .then((namespaces) => setCatalog((prev) => ({ ...prev, namespaces })))
        .catch(() => {});
    },
    30000,
    !!accountId,
  );

  // A widened row stays on Syncing until the listing carries the app the relink
  // added, which is the only signal that the new scope reached the registry.
  useEffect(() => {
    setWidening((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([deviceId, applicationId]) => {
          const row = devices.find((device) => device.deviceId === deviceId);
          return !row || !inScope(row, applicationId);
        }),
      );
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [devices]);

  // A device we linked but never saw converge is not in the listing yet, so
  // refetching would drop it: show it as syncing instead.
  const handleLinked = (deviceId: string, converged: boolean) => {
    if (converged) {
      setDeviceReloads((n) => n + 1);
      return;
    }
    setDevices((prev) =>
      prev.some((d) => d.deviceId === deviceId)
        ? prev
        : [
            ...prev,
            {
              deviceId,
              signingKey: "",
              isSelf: false,
              revoked: false,
              applications: [],
              namespaces: [],
              syncing: true,
            },
          ],
    );
  };

  const runRowAction = async (deviceId: string, action: () => Promise<string>) => {
    setBusyDevice(deviceId);
    setRowNote(null);
    try {
      setRowNote({ deviceId, text: await action() });
      setDeviceReloads((n) => n + 1);
      return true;
    } catch (err: unknown) {
      setRowNote({
        deviceId,
        text: parseTauriError(err, "That did not work"),
        error: true,
      });
      return false;
    } finally {
      setBusyDevice("");
    }
  };

  const sync = (device: DeviceRow) =>
    runRowAction(device.deviceId, async () => relinkSummary(await relinkDevice(device.deviceId)));

  const widen = async (device: DeviceRow, applicationId: string) => {
    const scope = [...device.applications, applicationId];
    setWidening((prev) => ({ ...prev, [device.deviceId]: applicationId }));
    const ok = await runRowAction(device.deviceId, async () =>
      widenSummary(await relinkDevice(device.deviceId, scope), 1),
    );
    if (!ok) setWidening((prev) => dropKey(prev, device.deviceId));
  };

  const revoke = (device: DeviceRow) => {
    setConfirmRevoke("");
    // A revocation reaches every namespace the device is in whichever one the
    // route names, so the first is as good as any.
    return runRowAction(device.deviceId, async () => {
      const { revokedIn } = await revokeDevice(device.namespaces[0], device.deviceId);
      return `Withdrawn from ${revokedIn.length} ${namespaceWord(revokedIn.length)}.`;
    });
  };

  // Aliases are this node's own, so a rename changes nothing the device listing
  // carries: the map is corrected here rather than by refetching the roster.
  const rename = async (device: DeviceRow) => {
    const alias = aliasFromInput(renameText);
    if (!alias) return;
    const previous = deviceLabel(device.deviceId, aliases);
    setBusyDevice(device.deviceId);
    setRowNote(null);
    try {
      await createDeviceAlias({ alias, deviceId: device.deviceId });
      // The name is stored, so the row takes it before the old one is dropped:
      // a failed delete leaves a stale alias, not a row under the wrong name.
      setAliases((prev) => ({
        ...(previous ? dropKey(prev, previous) : prev),
        [alias]: device.deviceId,
      }));
      setRenaming("");
      if (previous && previous !== alias) await deleteDeviceAlias(previous);
    } catch (err: unknown) {
      setRowNote({
        deviceId: device.deviceId,
        text: parseTauriError(err, "Could not save that name"),
        error: true,
      });
    } finally {
      setBusyDevice("");
    }
  };

  const install = async (app: AccountAppRow) => {
    if (!app.package || !app.version) return;
    setInstalling(app.applicationId);
    setInstallError(null);
    try {
      const response = await apiClient.node.installApplication({
        package: app.package,
        version: app.version,
      });
      if (response.error) throw new Error(response.error.message);
      invalidateInstalledApps();
      setDeviceReloads((n) => n + 1);
    } catch (err: unknown) {
      setInstallError({
        deviceId: app.applicationId,
        text: parseTauriError(err, "Could not install that app"),
        error: true,
      });
    } finally {
      setInstalling("");
    }
  };

  const isHolder = canInviteDevices(identity);
  const accountNamespace = reportedAccountNamespace(devices, identity?.accountNamespaceId);
  const banner = thisDeviceBanner(identity, devices);
  const isSyncing = (device: DeviceRow) => !!device.syncing || device.deviceId in widening;
  const appRows = accountAppRows(catalog.apps, devices, catalog.namespaces, catalog.installed);

  const renderDeviceRow = (device: DeviceRow) => {
    const open = !!expanded[device.deviceId];
    const syncing = isSyncing(device);
    const status = deviceStatus(device, accountNamespace, syncing);
    const note = rowNote?.deviceId === device.deviceId ? rowNote : null;
    const apps = deviceScopeApps(catalog.apps, device, catalog.namespaces, catalog.installed);
    const name = deviceLabel(device.deviceId, aliases);
    const shortId = truncateText(device.deviceId, 8);

    return (
      <div
        className={`account-device-row${open ? " is-open" : ""}${
          renaming === device.deviceId ? " is-renaming" : ""
        }`}
        key={device.deviceId}
        id={`device-row-${device.deviceId}`}
      >
        <div className="account-device-head">
          <button
            type="button"
            className="account-device-expand"
            id={`device-expand-${device.deviceId}`}
            aria-expanded={open}
            onClick={() =>
              setExpanded((prev) => ({ ...prev, [device.deviceId]: !prev[device.deviceId] }))
            }
          >
            <ChevronRight size={14} className="account-device-chevron" />
            <span className="account-device-label">
              <span className="account-device-name">
                {name ?? <code className="account-mono">{shortId}</code>}
                {device.isSelf && <span className="account-this-device">This device</span>}
              </span>
              <span className="account-device-meta">
                {name && (
                  <>
                    <code className="account-mono">{shortId}</code> ·{" "}
                  </>
                )}
                {deviceScope(device)} · {device.namespaces.length}{" "}
                {namespaceWord(device.namespaces.length)}
              </span>
            </span>
          </button>
          {open && (isHolder || device.isSelf) && (
            renaming === device.deviceId ? (
              <>
                <input
                  id={`device-rename-input-${device.deviceId}`}
                  className="account-rename"
                  type="text"
                  autoFocus
                  value={renameText}
                  placeholder="for example, Alice's iPhone"
                  onChange={(e) => setRenameText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") rename(device);
                    if (e.key === "Escape") setRenaming("");
                  }}
                />
                <button
                  type="button"
                  id={`device-rename-save-${device.deviceId}`}
                  className="button button-primary button-small"
                  disabled={!aliasFromInput(renameText) || busyDevice === device.deviceId}
                  onClick={() => rename(device)}
                >
                  Save
                </button>
              </>
            ) : (
              <button
                type="button"
                id={`device-rename-${device.deviceId}`}
                className="button button-secondary button-small"
                onClick={() => {
                  setRenaming(device.deviceId);
                  setRenameText(name ?? "");
                }}
              >
                Rename
              </button>
            )
          )}
          <span className={`account-status is-${status}`}>{DEVICE_STATUS_LABEL[status]}</span>
          <div className="account-row-actions">
          {confirmRevoke === device.deviceId ? (
            <>
              <span className="account-row-note">Withdraw it for good?</span>
              <button
                type="button"
                id={`device-revoke-confirm-${device.deviceId}`}
                className="button button-danger button-small"
                disabled={busyDevice === device.deviceId}
                onClick={() => revoke(device)}
              >
                Revoke
              </button>
              <button
                type="button"
                id={`device-revoke-cancel-${device.deviceId}`}
                className="button button-secondary button-small"
                onClick={() => setConfirmRevoke("")}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              {canSync(device, isHolder) && (
                <button
                  type="button"
                  id={`device-sync-${device.deviceId}`}
                  className="button button-secondary button-small"
                  disabled={busyDevice === device.deviceId}
                  onClick={() => sync(device)}
                >
                  <RefreshCw size={12} />
                  Sync
                </button>
              )}
              {canRevoke(device, isHolder) && (
                <button
                  type="button"
                  id={`device-revoke-${device.deviceId}`}
                  className="button button-secondary button-small"
                  onClick={() => setConfirmRevoke(device.deviceId)}
                >
                  <Trash2 size={12} />
                  Revoke
                </button>
              )}
            </>
          )}
            {note && (
              <span
                className={note.error ? "field-error" : "account-row-note"}
                id={`device-note-${device.deviceId}`}
              >
                {note.text}
              </span>
            )}
          </div>
        </div>

        {open && (
          <div className="account-device-body">
            <section className="account-device-section">
              <h3>
                Apps this device may act for
                <span className="account-section-hint">{scopeHint(device, apps.length)}</span>
              </h3>
              {apps.map((app) => {
                const toggle = scopeToggle(device, app.applicationId, isHolder);
                return (
                  <div className="account-app-row" key={app.applicationId}>
                    <AppIcon name={app.name} seed={app.applicationId} size={24} />
                    <span className="account-app-text">
                      <span className="account-app-name">{app.name}</span>
                      <span className="account-app-meta">
                        {tileNamespaceCount(app.namespaces)}
                      </span>
                    </span>
                    <button
                      type="button"
                      id={`device-app-${device.deviceId}-${app.applicationId}`}
                      className={`account-toggle${toggle.on ? " is-on" : ""}${
                        toggle.locked ? " is-locked" : ""
                      }`}
                      role="switch"
                      aria-checked={toggle.on}
                      aria-label={app.name}
                      title={toggle.tip}
                      disabled={toggle.locked || busyDevice === device.deviceId}
                      onClick={() => widen(device, app.applicationId)}
                    >
                      <i />
                    </button>
                  </div>
                );
              })}
              {apps.length === 0 && (
                <p className="field-hint">This account speaks in no app yet.</p>
              )}
            </section>

            <section className="account-device-section">
              <h3>Namespaces</h3>
              {catalog.namespaces.map((namespace) => {
                const state = namespaceFollowState(device, namespace, accountNamespace, syncing);
                return (
                  <div className="account-ns-row" key={namespace.namespaceId}>
                    <span className="account-ns-name">
                      {namespace.name || truncateText(namespace.namespaceId, 8)}
                      <small>
                        {applicationLabel(
                          namespace.targetApplicationId,
                          catalog.namespaces,
                          catalog.installed,
                        )}
                      </small>
                    </span>
                    <span className={`account-status is-${state}`}>
                      {FOLLOW_STATE_LABEL[state]}
                    </span>
                  </div>
                );
              })}
              {catalog.namespaces.length === 0 && (
                <p className="field-hint">No namespaces yet.</p>
              )}
            </section>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="settings-card">
        {banner && (
          <p className={`account-banner is-${banner.kind}`} id={`account-banner-${banner.kind}`}>
            {banner.text}
          </p>
        )}
        <h2>This device</h2>
        {identityLoading ? (
          <SkeletonText lines={4} />
        ) : identityError ? (
          <>
            <p className="field-error">{identityError}</p>
            <button
              type="button"
              id="account-retry"
              className="button button-secondary"
              onClick={() => setReloads((n) => n + 1)}
            >
              Retry
            </button>
          </>
        ) : !identity ? (
          <p className="field-hint" id="account-no-identity">
            This node has no account identity yet. It gets one the first time it takes part in
            a namespace.
          </p>
        ) : (
          IDENTITY_FIELDS.map(({ id, label, key }) => {
            const value = identity[key];
            return (
              <div className="settings-field" key={id}>
                <div className="agent-config-header">
                  <span className="settings-field-label">{label}</span>
                  {value && <CopyButton id={`copy-${id}`} value={value} />}
                </div>
                <code className="account-mono account-value" id={`value-${id}`}>
                  {value || "Not set"}
                </code>
              </div>
            );
          })
        )}
      </div>

      <div className="settings-card">
        <div className="account-devices-header">
          <h2>Devices on this account</h2>
          {isHolder && (
            <button
              type="button"
              id="add-device"
              className="button button-primary"
              disabled={wizardOpen}
              onClick={() => setWizardOpen(true)}
            >
              <Plus size={14} style={{ marginRight: "6px", verticalAlign: "middle" }} />
              Add a device
            </button>
          )}
        </div>
        {identityLoading || devicesLoading ? (
          <SkeletonTable rows={2} columns={5} />
        ) : devicesError ? (
          <>
            <p className="field-error">{devicesError}</p>
            <button
              type="button"
              id="devices-retry"
              className="button button-secondary"
              onClick={() => setDeviceReloads((n) => n + 1)}
            >
              Retry
            </button>
          </>
        ) : devices.length === 0 ? (
          <p className="field-hint" id="devices-empty">
            {devicesEmptyMessage(identity)}
          </p>
        ) : (
          <div className="account-device-list">{devices.map(renderDeviceRow)}</div>
        )}
        {wizardOpen && (
          <DevicePairWizard
            rootKey={identity?.accountRootPublicKey}
            accountNamespaceId={identity?.accountNamespaceId}
            onLinked={handleLinked}
            onClose={() => setWizardOpen(false)}
          />
        )}
      </div>

      <div className="settings-card">
        <h2>Apps on this account</h2>
        {appRows.length === 0 ? (
          <p className="field-hint" id="account-apps-empty">
            No namespace on this account targets an app yet.
          </p>
        ) : (
          <div className="account-app-list" id="account-apps">
            {appRows.map((app) => (
              <div className="account-app-row" key={app.applicationId}>
                <AppIcon name={app.name} seed={app.applicationId} size={28} />
                <span className="account-app-text">
                  <span className="account-app-name">{app.name}</span>
                  <span className="account-app-meta">
                    {app.package ?? truncateText(app.applicationId, 12)} ·{" "}
                    {app.namespaces} {namespaceWord(app.namespaces)} · {app.devices}{" "}
                    {app.devices === 1 ? "device" : "devices"} in scope
                  </span>
                </span>
                {app.installed ? (
                  <span className="account-status is-active" id={`app-installed-${app.applicationId}`}>
                    <Check size={12} />
                    Installed
                  </span>
                ) : app.package ? (
                  <button
                    type="button"
                    id={`app-install-${app.applicationId}`}
                    className="button button-primary button-small"
                    disabled={installing === app.applicationId}
                    onClick={() => install(app)}
                  >
                    {installing === app.applicationId ? "Installing…" : "Install"}
                  </button>
                ) : (
                  <span className="account-status" id={`app-missing-${app.applicationId}`}>
                    Not installed here
                  </span>
                )}
                {installError?.deviceId === app.applicationId && (
                  <span className="field-error" id={`app-install-error-${app.applicationId}`}>
                    {installError.text}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-card">
        <h2>Pair this computer into an account</h2>
        <DevicePairResponder enrolledDeviceId={identity?.deviceId ?? undefined} />
      </div>
    </>
  );
}
