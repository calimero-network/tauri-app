import { useState, useEffect } from "react";
import { MonitorSmartphone, Plus, RefreshCw, SquarePlus, Trash2 } from "lucide-react";
import DataTable, { type Column } from "./DataTable";
import CopyButton from "./CopyButton";
import {
  DevicePairWizard,
  DevicePairResponder,
  scopeRow,
  type InstalledApp,
} from "./DevicePairing";
import { SkeletonText, SkeletonTable } from "./Skeleton";
import type { NodeIdentity } from "@calimero-network/mero-js";
import {
  listAccountApplications,
  listAccountDevices,
  listNamespaces,
  nodeIdentity,
  relinkDevice,
  revokeDevice,
  type AccountApplication,
  type AccountDevice,
  type NamespaceSummary,
  type RelinkResult,
} from "../lib/device-link";
import { parseTauriError } from "../utils/appUtils";
import { listInstalledApps } from "../utils/installedAppsCache";
import { truncateText } from "../utils/string";

/** The four the card prints. Named rather than `keyof`, which now also spans a
 *  boolean these rows cannot render. */
const IDENTITY_FIELDS: {
  id: string;
  label: string;
  key: "accountId" | "deviceId" | "publicKey" | "accountRootPublicKey";
}[] = [
  { id: "account-id", label: "Account ID", key: "accountId" },
  { id: "device-id", label: "Device ID", key: "deviceId" },
  { id: "public-key", label: "Device public key", key: "publicKey" },
  { id: "account-root-public-key", label: "Account root public key", key: "accountRootPublicKey" },
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

/** Core's empty `applications` means every application, not none. */
export function deviceScope(device: AccountDevice): string {
  const count = device.applications.length;
  if (!count) return "All apps";
  return `${count} ${count === 1 ? "app" : "apps"}`;
}

/** Relinking this node's own device, or a withdrawn one, is defined but can
 *  never publish anything, so neither is offered the action. */
export function canSync(device: AccountDevice): boolean {
  return !device.isSelf && !device.revoked;
}

/** Revocation is terminal, and its route names a namespace, so a device bound
 *  nowhere has nothing to revoke in. */
export function canRevoke(device: AccountDevice): boolean {
  return !device.isSelf && !device.revoked && device.namespaces.length > 0;
}

/** A relink ADDS to the stored scope, and an empty scope already covers every
 *  application, so a device holding one has nothing to widen. */
export function canWiden(device: AccountDevice): boolean {
  return canSync(device) && device.applications.length > 0;
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
  const [wizardOpen, setWizardOpen] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [deviceReloads, setDeviceReloads] = useState(0);
  const [busyDevice, setBusyDevice] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState("");
  const [scopeDevice, setScopeDevice] = useState("");
  const [scopeChoices, setScopeChoices] = useState<string[]>([]);
  const [scopeError, setScopeError] = useState("");
  const [catalog, setCatalog] = useState<{
    apps: AccountApplication[];
    namespaces: NamespaceSummary[];
    installed: InstalledApp[];
  } | null>(null);
  const [rowNote, setRowNote] = useState<RowNote | null>(null);

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
    listAccountDevices(controller.signal)
      .then(setDevices)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setDevicesError(parseTauriError(err, "Could not list the devices on this account"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDevicesLoading(false);
      });
    return () => controller.abort();
  }, [accountId, reloads, deviceReloads]);

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
    } catch (err: unknown) {
      setRowNote({
        deviceId,
        text: parseTauriError(err, "That did not work"),
        error: true,
      });
    } finally {
      setBusyDevice("");
    }
  };

  const sync = (device: DeviceRow) =>
    runRowAction(device.deviceId, async () => relinkSummary(await relinkDevice(device.deviceId)));

  // Loaded on demand: most visits to this panel never open the picker, and the
  // catalog is the same for every row once it is here.
  const openScope = async (device: DeviceRow) => {
    setScopeDevice(device.deviceId);
    setScopeChoices([]);
    setScopeError("");
    if (catalog) return;
    try {
      const [apps, namespaces, installed] = await Promise.all([
        listAccountApplications(),
        listNamespaces(),
        // A name is a nicety; the picker must still work when the lookup fails.
        listInstalledApps()
          .then((r) => (Array.isArray(r.data) ? (r.data as InstalledApp[]) : []))
          .catch(() => [] as InstalledApp[]),
      ]);
      setCatalog({ apps, namespaces, installed });
    } catch (err: unknown) {
      setScopeError(parseTauriError(err, "Could not read this account's apps"));
    }
  };

  const widen = (device: DeviceRow) => {
    const chosen = scopeChoices;
    setScopeDevice("");
    return runRowAction(device.deviceId, async () =>
      widenSummary(await relinkDevice(device.deviceId, chosen), chosen.length),
    );
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

  const scopeTarget = devices.find((device) => device.deviceId === scopeDevice);
  // A relink only adds, so an app the device already holds is not offered.
  const addableApps = (catalog?.apps ?? []).filter(
    (app) => !scopeTarget?.applications.includes(app.applicationId),
  );

  const columns: Column<DeviceRow>[] = [
    {
      key: "deviceId",
      label: "Device",
      render: (device) => (
        <span className="account-device-cell">
          <MonitorSmartphone size={14} />
          <code className="account-mono">{truncateText(device.deviceId, 8)}</code>
        </span>
      ),
    },
    {
      key: "applications",
      label: "Scope",
      render: (device) => (
        <span className="account-mono" title={device.applications.join(", ") || undefined}>
          {device.syncing ? "-" : deviceScope(device)}
        </span>
      ),
    },
    {
      key: "namespaces",
      label: "Namespaces",
      render: (device) => (
        <span className="account-mono">{device.syncing ? "-" : device.namespaces.length}</span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (device) =>
        device.syncing ? (
          <span className="account-syncing">Syncing</span>
        ) : device.isSelf ? (
          <span className="account-this-device">This device</span>
        ) : device.revoked ? (
          <span className="account-revoked">Revoked</span>
        ) : (
          <span className="account-active">Active</span>
        ),
    },
    {
      key: "actions",
      label: "",
      render: (device) => {
        if (device.syncing) return null;
        const note = rowNote?.deviceId === device.deviceId ? rowNote : null;
        return (
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
                {canWiden(device) && (
                  <button
                    type="button"
                    id={`device-scope-${device.deviceId}`}
                    className="button button-secondary button-small"
                    disabled={busyDevice === device.deviceId}
                    onClick={() => openScope(device)}
                  >
                    <SquarePlus size={12} />
                    Add apps
                  </button>
                )}
                {canSync(device) && (
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
                {canRevoke(device) && (
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
        );
      },
    },
  ];

  return (
    <>
      <div className="settings-card">
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
          {canInviteDevices(identity) && (
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
        ) : (
          <DataTable
            data={devices}
            columns={columns}
            keyExtractor={(device) => device.deviceId}
            emptyMessage={devicesEmptyMessage(identity)}
            compact
          />
        )}
        {scopeTarget && (
          <div className="account-wizard" id="device-scope-picker">
            <p className="field-hint">
              Which apps should {truncateText(scopeTarget.deviceId, 8)} also reach?
            </p>
            {scopeError ? (
              <p className="field-error" id="device-scope-error">
                {scopeError}
              </p>
            ) : !catalog ? (
              <SkeletonText />
            ) : addableApps.length === 0 ? (
              <p className="field-hint" id="device-scope-none">
                It already reaches every app this account speaks in.
              </p>
            ) : (
              <div className="account-scope-apps" id="device-scope-apps">
                {addableApps.map((app) => (
                  <label
                    className="account-scope-choice account-scope-app"
                    key={app.applicationId}
                  >
                    <input
                      type="checkbox"
                      id={`device-scope-app-${app.applicationId}`}
                      checked={scopeChoices.includes(app.applicationId)}
                      onChange={() =>
                        setScopeChoices((prev) =>
                          prev.includes(app.applicationId)
                            ? prev.filter((id) => id !== app.applicationId)
                            : [...prev, app.applicationId],
                        )
                      }
                    />
                    <span className="account-scope-app-text">
                      {scopeRow(app.applicationId, catalog.namespaces, catalog.installed).map((line, i) => (
                        <span
                          key={line}
                          className={i === 0 ? "account-scope-app-name" : "account-scope-app-ns"}
                        >
                          {line}
                        </span>
                      ))}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <div className="account-wizard-actions">
              <button
                type="button"
                id="device-scope-add"
                className="button button-primary"
                disabled={!scopeChoices.length || busyDevice === scopeTarget.deviceId}
                onClick={() => widen(scopeTarget)}
              >
                Add
              </button>
              <button
                type="button"
                id="device-scope-cancel"
                className="button button-secondary"
                onClick={() => setScopeDevice("")}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {wizardOpen && (
          <DevicePairWizard
            rootKey={identity?.accountRootPublicKey}
            onLinked={handleLinked}
            onClose={() => setWizardOpen(false)}
          />
        )}
      </div>

      <div className="settings-card">
        <h2>Pair this computer into an account</h2>
        <DevicePairResponder enrolledDeviceId={identity?.deviceId} />
      </div>
    </>
  );
}
