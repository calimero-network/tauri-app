import { ChevronRight, RefreshCw, Trash2 } from "lucide-react";
import AppIcon from "./AppIcon";
import { applicationLabel, tileNamespaceCount } from "./DevicePairing";
import {
  DEVICE_STATUS_LABEL,
  FOLLOW_STATE_LABEL,
  canRevoke,
  canSync,
  deviceLabel,
  deviceScope,
  deviceScopeApps,
  deviceStatus,
  namespaceFollowState,
  namespaceWord,
  scopeHint,
  scopeToggle,
  type AccountCatalog,
  type DeviceRow,
  type RowNote,
} from "../lib/account";
import { aliasFromInput } from "../lib/device-link";
import { truncateText } from "../utils/string";

interface AccountDeviceRowProps {
  device: DeviceRow;
  catalog: AccountCatalog;
  aliases: Record<string, string>;
  accountNamespace: string | null;
  isHolder: boolean;
  syncing: boolean;
  open: boolean;
  busy: boolean;
  note: RowNote | null;
  renaming: boolean;
  renameText: string;
  confirmingRevoke: boolean;
  onExpand: () => void;
  onStartRename: (name: string) => void;
  onRenameText: (text: string) => void;
  onCancelRename: () => void;
  onRename: () => void;
  onWiden: (applicationId: string) => void;
  onSync: () => void;
  onAskRevoke: () => void;
  onCancelRevoke: () => void;
  onRevoke: () => void;
}

export default function AccountDeviceRow({
  device,
  catalog,
  aliases,
  accountNamespace,
  isHolder,
  syncing,
  open,
  busy,
  note,
  renaming,
  renameText,
  confirmingRevoke,
  onExpand,
  onStartRename,
  onRenameText,
  onCancelRename,
  onRename,
  onWiden,
  onSync,
  onAskRevoke,
  onCancelRevoke,
  onRevoke,
}: AccountDeviceRowProps) {
  const status = deviceStatus(device, accountNamespace, syncing);
  const apps = deviceScopeApps(catalog.apps, device, catalog.namespaces, catalog.installed);
  const name = deviceLabel(device.deviceId, aliases);
  const shortId = truncateText(device.deviceId, 8);

  return (
    <div
      className={`disclosure-row account-device-row${open ? " is-open" : ""}${
        renaming ? " is-renaming" : ""
      }`}
      id={`device-row-${device.deviceId}`}
    >
      <div className="disclosure-head">
        <button
          type="button"
          className="disclosure-trigger"
          id={`device-expand-${device.deviceId}`}
          aria-expanded={open}
          onClick={onExpand}
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
          renaming ? (
            <>
              <input
                id={`device-rename-input-${device.deviceId}`}
                className="account-rename"
                type="text"
                autoFocus
                value={renameText}
                placeholder="for example, Alice's iPhone"
                onChange={(e) => onRenameText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onRename();
                  if (e.key === "Escape") onCancelRename();
                }}
              />
              <button
                type="button"
                id={`device-rename-save-${device.deviceId}`}
                className="button button-primary button-small"
                disabled={!aliasFromInput(renameText) || busy}
                onClick={onRename}
              >
                Save
              </button>
            </>
          ) : (
            <button
              type="button"
              id={`device-rename-${device.deviceId}`}
              className="button button-secondary button-small"
              onClick={() => onStartRename(name ?? "")}
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
          {confirmingRevoke ? (
            <>
              <span className="account-row-note">Withdraw it for good?</span>
              <button
                type="button"
                id={`device-revoke-confirm-${device.deviceId}`}
                className="button button-danger button-small"
                disabled={busy}
                onClick={onRevoke}
              >
                Revoke
              </button>
              <button
                type="button"
                id={`device-revoke-cancel-${device.deviceId}`}
                className="button button-secondary button-small"
                onClick={onCancelRevoke}
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
                  disabled={busy}
                  onClick={onSync}
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
                  onClick={onAskRevoke}
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
                    <span className="account-app-meta">{tileNamespaceCount(app.namespaces)}</span>
                  </span>
                  <div className="toggle-switch toggle-switch-small">
                    <input
                      id={toggleId}
                      type="checkbox"
                      role="switch"
                      aria-label={app.name}
                      aria-describedby={toggle.tip ? `${toggleId}-why` : undefined}
                      checked={toggle.on}
                      disabled={toggle.locked || busy}
                      onChange={() => onWiden(app.applicationId)}
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
            {catalog.namespaces.length === 0 && <p className="empty-hint">No namespaces yet.</p>}
          </section>
        </div>
      )}
    </div>
  );
}
