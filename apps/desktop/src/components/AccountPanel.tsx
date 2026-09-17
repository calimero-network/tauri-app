import { useState, useEffect } from "react";
import { Plus } from "lucide-react";
import AccountAppsCard from "./AccountAppsCard";
import AccountDeviceRow from "./AccountDeviceRow";
import AccountIdentityCard from "./AccountIdentityCard";
import { DevicePairWizard, DevicePairResponder, type InstalledApp } from "./DevicePairing";
import { SkeletonTable } from "./Skeleton";
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
  type AccountDevice,
} from "../lib/device-link";
import {
  accountAppRows,
  canInviteDevices,
  deviceLabel,
  devicesEmptyMessage,
  namespaceWord,
  relinkSummary,
  thisDeviceBanner,
  widenSummary,
  type AccountAppRow,
  type AccountCatalog,
  type RowNote,
} from "../lib/account";
import { parseTauriError } from "../utils/appUtils";
import { apiClient } from "../lib/mero-client";
import { invalidateInstalledApps, listInstalledApps } from "../utils/installedAppsCache";
import "./AccountPanel.css";

const dropKey = <T,>(map: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(map).filter(([at]) => at !== key));

/** Everything the rows need naming. A lookup that fails leaves the rows readable
 *  by id rather than taking the listing down with it. */
async function loadCatalog(signal?: AbortSignal): Promise<AccountCatalog> {
  const [apps, namespaces, installed] = await Promise.all([
    listAccountApplications(),
    listNamespaces(signal),
    listInstalledApps()
      .then((r) => (Array.isArray(r.data) ? (r.data as InstalledApp[]) : []))
      .catch(() => [] as InstalledApp[]),
  ]);
  return { apps, namespaces, installed };
}

/** The listing, and what this node calls the devices in it. A name lookup that
 *  fails answers null, so the caller keeps the names it already has. */
function loadDevices() {
  return Promise.all([listAccountDevices(), listDeviceAliases().catch(() => null)]);
}

export default function AccountPanel() {
  const [identity, setIdentity] = useState<NodeIdentity | null>(null);
  const [identityLoading, setIdentityLoading] = useState(true);
  const [identityError, setIdentityError] = useState("");
  const [devices, setDevices] = useState<AccountDevice[]>([]);
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
  const [catalog, setCatalog] = useState<AccountCatalog>({
    apps: [],
    namespaces: [],
    installed: [],
  });
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
    loadDevices()
      .then(([rows, names]) => {
        if (controller.signal.aborted) return;
        setDevices(rows);
        if (names) setAliases(names);
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

  // Names and namespace counts for the expanded rows.
  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();
    loadCatalog(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setCatalog(next);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [accountId, reloads, deviceReloads]);

  // Core follows and unfollows this device's namespaces on its own, and a
  // follower's application row can go from bytecode-less to installed between
  // ticks, so the whole catalog is reloaded alongside the devices. A failed
  // poll keeps what it has.
  useVisiblePoll(
    () => {
      loadDevices()
        .then(([rows, names]) => {
          setDevices(rows);
          if (names) setAliases(names);
        })
        .catch(() => {});
      invalidateInstalledApps();
      loadCatalog()
        .then(setCatalog)
        .catch(() => {});
    },
    30000,
    !!accountId,
  );

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

  const sync = (device: AccountDevice) =>
    runRowAction(device.deviceId, async () => relinkSummary(await relinkDevice(device.deviceId)));

  const widen = (device: AccountDevice, applicationId: string) =>
    runRowAction(device.deviceId, async () =>
      widenSummary(await relinkDevice(device.deviceId, [...device.applications, applicationId]), 1),
    );

  const revoke = (device: AccountDevice) => {
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
  const rename = async (device: AccountDevice) => {
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

  return (
    <>
      <AccountIdentityCard
        identity={identity}
        loading={identityLoading}
        error={identityError}
        banner={thisDeviceBanner(devices)}
        onRetry={() => setReloads((n) => n + 1)}
      />

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
          <div className="account-device-list">
            {devices.map((device) => (
              <AccountDeviceRow
                key={device.deviceId}
                device={device}
                catalog={catalog}
                aliases={aliases}
                isHolder={isHolder}
                open={!!expanded[device.deviceId]}
                busy={busyDevice === device.deviceId}
                note={rowNote?.deviceId === device.deviceId ? rowNote : null}
                renaming={renaming === device.deviceId}
                renameText={renameText}
                confirmingRevoke={confirmRevoke === device.deviceId}
                onExpand={() =>
                  setExpanded((prev) => ({ ...prev, [device.deviceId]: !prev[device.deviceId] }))
                }
                onStartRename={(name) => {
                  setRenaming(device.deviceId);
                  setRenameText(name);
                }}
                onRenameText={setRenameText}
                onCancelRename={() => setRenaming("")}
                onRename={() => rename(device)}
                onWiden={(applicationId) => widen(device, applicationId)}
                onSync={() => sync(device)}
                onAskRevoke={() => setConfirmRevoke(device.deviceId)}
                onCancelRevoke={() => setConfirmRevoke("")}
                onRevoke={() => revoke(device)}
              />
            ))}
          </div>
        )}
        {wizardOpen && (
          <DevicePairWizard
            rootKey={identity?.accountRootPublicKey}
            accountNamespaceId={identity?.accountNamespaceId}
            onLinked={() => setDeviceReloads((n) => n + 1)}
            onClose={() => setWizardOpen(false)}
          />
        )}
      </div>

      <AccountAppsCard
        rows={accountAppRows(catalog.apps, devices, catalog.namespaces, catalog.installed)}
        installing={installing}
        error={installError}
        onInstall={install}
      />

      <div className="settings-card">
        <h2>Pair this computer into an account</h2>
        <DevicePairResponder enrolledDeviceId={identity?.deviceId ?? undefined} />
      </div>
    </>
  );
}
