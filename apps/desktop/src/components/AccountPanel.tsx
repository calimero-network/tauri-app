import { Fragment, useState, useEffect } from "react";
import { Check, ChevronRight, Plus, RefreshCw, Trash2 } from "lucide-react";
import AppIcon from "./AppIcon";
import CopyButton from "./CopyButton";
import {
  DevicePairWizard,
  DevicePairResponder,
  applicationLabel,
  tileNamespaceCount,
  type InstalledApp,
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
} from "../lib/device-link";
import {
  DEVICE_STATUS_LABEL,
  FOLLOW_STATE_LABEL,
  accountAppRows,
  canInviteDevices,
  canRevoke,
  canSync,
  deviceLabel,
  deviceScope,
  deviceScopeApps,
  deviceStatus,
  devicesEmptyMessage,
  inScope,
  namespaceFollowState,
  namespaceWord,
  relinkSummary,
  reportedAccountNamespace,
  scopeHint,
  scopeToggle,
  thisDeviceBanner,
  widenSummary,
  type AccountAppRow,
} from "../lib/account";
import { parseTauriError } from "../utils/appUtils";
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

const dropKey = <T,>(map: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(map).filter(([at]) => at !== key));

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
        className={`disclosure-row account-device-row${open ? " is-open" : ""}${
          renaming === device.deviceId ? " is-renaming" : ""
        }`}
        key={device.deviceId}
        id={`device-row-${device.deviceId}`}
      >
        <div className="disclosure-head">
          <button
            type="button"
            className="disclosure-trigger"
            id={`device-expand-${device.deviceId}`}
            aria-expanded={open}
            onClick={() =>
              setExpanded((prev) => ({ ...prev, [device.deviceId]: !prev[device.deviceId] }))
            }
          >
            <ChevronRight size={14} className="disclosure-chevron" />
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
          <span className={`status-badge ${status}`}>
            {status === "syncing" ? (
              <RefreshCw size={11} className="spinning" />
            ) : (
              <span className="status-dot" />
            )}
            {DEVICE_STATUS_LABEL[status]}
          </span>
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
          <div className="disclosure-body account-device-body">
            <section className="account-device-section">
              <h3>
                Apps this device may act for
                <span className="account-section-hint">{scopeHint(device, apps.length)}</span>
              </h3>
              {apps.map((app) => {
                const toggle = scopeToggle(device, app.applicationId, isHolder);
                const toggleId = `device-app-${device.deviceId}-${app.applicationId}`;
                return (
                  <div className="account-app-row" key={app.applicationId}>
                    <AppIcon name={app.name} seed={app.applicationId} size={24} />
                    <span className="account-app-text">
                      <span className="account-app-name">{app.name}</span>
                      <span className="account-app-meta">
                        {tileNamespaceCount(app.namespaces)}
                      </span>
                    </span>
                    <div className="toggle-switch toggle-switch-small">
                      <input
                        id={toggleId}
                        type="checkbox"
                        role="switch"
                        aria-label={app.name}
                        aria-describedby={toggle.tip ? `${toggleId}-why` : undefined}
                        checked={toggle.on}
                        disabled={toggle.locked || busyDevice === device.deviceId}
                        onChange={() => widen(device, app.applicationId)}
                      />
                      <label htmlFor={toggleId} className="toggle-label" title={toggle.tip}>
                        <span className="toggle-slider" />
                      </label>
                      {toggle.tip && (
                        <span className="visually-hidden" id={`${toggleId}-why`}>
                          {toggle.tip}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              {apps.length === 0 && (
                <p className="empty-hint">This account speaks in no app yet.</p>
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
                    <span className={`status-badge ${state}`}>
                      {state === "syncing" ? (
                        <RefreshCw size={11} className="spinning" />
                      ) : (
                        <span className="status-dot" />
                      )}
                      {FOLLOW_STATE_LABEL[state]}
                    </span>
                  </div>
                );
              })}
              {catalog.namespaces.length === 0 && (
                <p className="empty-hint">No namespaces yet.</p>
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
          <p
            className={banner.kind === "revoked" ? "error-message" : "account-banner"}
            id={`account-banner-${banner.kind}`}
          >
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
          <dl className="account-identity">
            {IDENTITY_FIELDS.map(({ id, label, key }) => {
              const value = identity[key];
              return (
                <Fragment key={id}>
                  <dt>{label}</dt>
                  <dd>
                    <code id={`value-${id}`} title={value || undefined}>
                      {value || "Not set"}
                    </code>
                    {value && <CopyButton id={`copy-${id}`} value={value} />}
                  </dd>
                </Fragment>
              );
            })}
          </dl>
        )}
      </div>

      <div className="settings-card">
        <div className="account-devices-header">
          <h2>Devices</h2>
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
          <p className="empty-hint" id="devices-empty">
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
          <p className="empty-hint" id="account-apps-empty">
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
                  <span className="status-badge active" id={`app-installed-${app.applicationId}`}>
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
                  <span className="status-badge" id={`app-missing-${app.applicationId}`}>
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
