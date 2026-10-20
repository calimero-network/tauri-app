import React, { useState } from "react";
import {
  describeStep,
  isBlocked,
  planNamespace,
  type AppNamespace,
  type UninstallStep,
} from "../lib/uninstall";
import { roleLabel } from "../utils/groupRoles";
import "./UninstallApp.css";

/** What the Applications page fetched before opening the dialog. */
export interface UninstallRequest {
  appName: string;
  namespaces: AppNamespace[];
  linkedDevice: boolean;
  onConfirm: (steps: UninstallStep[], deleteData: boolean) => Promise<void>;
}

interface UninstallAppProps extends UninstallRequest {
  onCancel: () => void;
  /** Open the Namespaces page's transfer picker for this namespace. */
  onTransfer: (namespaceId: string) => void;
  breadcrumbs: Array<{ label: string; onClick?: () => void }>;
}

const reasonId = (ns: AppNamespace) => `uninstall-reason-${ns.id}`;
const OLDER_CONTEXTS = "Contexts still on an older version of the app are left on this node, whether or not you leave.";
const LEAVE_LABEL = "Also leave shared namespaces";

function whoElse(others: number): string {
  if (others === 0) return "only you";
  return others === 1 ? "you and 1 other" : `you and ${others} others`;
}

const UninstallApp: React.FC<UninstallAppProps> = ({
  appName,
  namespaces,
  linkedDevice,
  onConfirm,
  onCancel,
  onTransfer,
  breadcrumbs,
}) => {
  const [deleteData, setDeleteData] = useState(true);
  const [leave, setLeave] = useState(true);
  const [forced, setForced] = useState<ReadonlySet<string>>(new Set());
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);

  const leaving = deleteData && leave;
  const deleteForEveryone = new Set(namespaces.filter((ns) => forced.has(ns.id) && typed[ns.id]?.trim() === ns.name).map((ns) => ns.id));
  const choice = { deleteData, leave, deleteForEveryone, linkedDevice };
  const steps: UninstallStep[] = namespaces.map((ns) => ({ ns, action: planNamespace(ns, choice) }));
  const blocked = isBlocked(steps.map((s) => s.action));
  const blockedSteps = steps.filter((s) => isBlocked([s.action]));
  const blockedReasons = blockedSteps.map((s) => reasonId(s.ns)).join(" ");
  // The force option belongs to a namespace the user owns and shares, whether or not it is ticked yet.
  const sharedAndOwned = (ns: AppNamespace) =>
    planNamespace(ns, { ...choice, deleteForEveryone: new Set() }) === "needs-transfer";

  const toggleForced = (id: string, on: boolean) =>
    setForced((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const confirm = async () => {
    setRunning(true);
    try {
      await onConfirm(steps, deleteData);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="confirm-action-page">
      <nav className="breadcrumbs">
        {breadcrumbs.map((crumb, index) => (
          <React.Fragment key={index}>
            {index > 0 && <span className="breadcrumb-separator"> / </span>}
            {crumb.onClick ? (
              <button className="breadcrumb-link" onClick={crumb.onClick} type="button">
                {crumb.label}
              </button>
            ) : (
              <span className="breadcrumb-current">{crumb.label}</span>
            )}
          </React.Fragment>
        ))}
      </nav>

      <div className="confirm-action-content">
        <h1>Uninstall Application</h1>
        <p className="item-name">"{appName}"</p>

        <section className="uninstall-section" aria-labelledby="uninstall-here">
          <h2 id="uninstall-here" className="uninstall-section-title">On this device</h2>
          {namespaces.length === 0 ? (
            <p className="uninstall-empty">No namespaces of this app are on this device.</p>
          ) : (
            <ul className="uninstall-namespaces" data-testid="uninstall-namespaces">
              {namespaces.map((ns) => (
                <li key={ns.id}>
                  <span className="uninstall-ns-name">{ns.name}</span>
                  <span className="uninstall-ns-meta">
                    {ns.role ? `${roleLabel(ns.role)} · ` : ""}
                    {whoElse(ns.others)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="uninstall-options">
          <label className="confirm-option">
            <input type="checkbox" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} />
            <span>
              <span className="confirm-option-label">Delete all application data</span>
              <span className="confirm-option-hint">
                {deleteData
                  ? "Removes the app's namespaces and their data from this device."
                  : "Keeps every namespace and its data on this device; only the app is removed."}
              </span>
            </span>
          </label>
          <label className={`confirm-option confirm-option-nested${deleteData ? "" : " is-disabled"}`}>
            <input
              type="checkbox"
              checked={leaving}
              disabled={!deleteData}
              onChange={(e) => setLeave(e.target.checked)}
            />
            <span>
              <span className="confirm-option-label">
                {LEAVE_LABEL}
                {leaving && <span className="status-badge disconnected uninstall-tag">Affects all your devices</span>}
              </span>
              {deleteData && (
                <span className="confirm-option-hint">
                  {leave
                    ? "Your account leaves them, and your other devices remove them too."
                    : "You stay a member, and reinstalling the app restores them."}
                </span>
              )}
            </span>
          </label>
        </div>

        <section className="uninstall-section" aria-labelledby="uninstall-outcome">
          <h2 id="uninstall-outcome" className="uninstall-section-title">What happens</h2>
          <ul className="uninstall-outcomes" data-testid="uninstall-outcomes">
            <li>The app is removed from this device.</li>
            {steps.map(({ ns, action }) => (
              <li key={ns.id} className={isBlocked([action]) ? "is-blocked" : undefined}>
                <span id={isBlocked([action]) ? reasonId(ns) : undefined}>{describeStep(ns, action)}</span>
                {action === "needs-primary-device" && (
                  <p className="uninstall-block-hint">
                    Do this on the computer that holds the account, or untick "{LEAVE_LABEL}".
                  </p>
                )}
                {sharedAndOwned(ns) && (
                  <div className="uninstall-block">
                    {!forced.has(ns.id) && (
                      <p className="uninstall-block-hint">
                        <button type="button" className="uninstall-link" onClick={() => onTransfer(ns.id)}>
                          Transfer ownership
                        </button>
                        , or untick "{LEAVE_LABEL}".
                      </p>
                    )}
                    <label className="confirm-option">
                      <input
                        type="checkbox"
                        checked={forced.has(ns.id)}
                        onChange={(e) => toggleForced(ns.id, e.target.checked)}
                      />
                      <span className="confirm-option-label">Delete {ns.name} for everyone</span>
                    </label>
                    {forced.has(ns.id) && (
                      <input
                        className="uninstall-typed"
                        type="text"
                        value={typed[ns.id] ?? ""}
                        onChange={(e) => setTyped((t) => ({ ...t, [ns.id]: e.target.value }))}
                        placeholder={`Type ${ns.name} to confirm`}
                        aria-label={`Type ${ns.name} to confirm`}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    )}
                  </div>
                )}
              </li>
            ))}
            {deleteData && <li>{OLDER_CONTEXTS}</li>}
          </ul>
          <p className="uninstall-summary" data-testid="uninstall-summary" aria-live="polite">
            {blockedSteps.length > 0 &&
              `Resolve ${blockedSteps.length} ${blockedSteps.length === 1 ? "namespace" : "namespaces"} above to continue.`}
          </p>
        </section>

        <div className="confirm-actions">
          <button onClick={onCancel} className="button button-secondary" type="button" disabled={running}>
            Cancel
          </button>
          <button
            onClick={confirm}
            className="button button-danger"
            type="button"
            disabled={blocked || running}
            aria-describedby={blockedReasons || undefined}
          >
            {running ? "Uninstalling..." : "Uninstall"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default React.memo(UninstallApp);
