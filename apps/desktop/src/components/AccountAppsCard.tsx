import { Check } from "lucide-react";
import AppIcon from "./AppIcon";
import { namespaceWord, type AccountAppRow, type RowNote } from "../lib/account";
import { truncateText } from "../utils/string";

interface AccountAppsCardProps {
  rows: AccountAppRow[];
  installing: string;
  error: RowNote | null;
  onInstall: (app: AccountAppRow) => void;
}

export default function AccountAppsCard({
  rows,
  installing,
  error,
  onInstall,
}: AccountAppsCardProps) {
  return (
    <div className="settings-card">
      <h2>Apps on this account</h2>
      {rows.length === 0 ? (
        <p className="empty-hint" id="account-apps-empty">
          No namespace on this account targets an app yet.
        </p>
      ) : (
        <div id="account-apps">
          {rows.map((app) => (
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
                  onClick={() => onInstall(app)}
                >
                  {installing === app.applicationId ? "Installing…" : "Install"}
                </button>
              ) : (
                <span className="status-badge" id={`app-missing-${app.applicationId}`}>
                  Not installed here
                </span>
              )}
              {error?.deviceId === app.applicationId && (
                <span className="field-error" id={`app-install-error-${app.applicationId}`}>
                  {error.text}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
