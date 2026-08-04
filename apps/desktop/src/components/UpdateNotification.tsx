import { useState, useEffect } from "react";
import {
  checkForUpdates,
  installUpdate,
  getCurrentVersion,
  type UpdateInfo,
} from "../utils/updater";
import { parseTauriError } from "../utils/appUtils";
import "./UpdateNotification.css";

interface UpdateNotificationProps {
  checkOnMount?: boolean;
  checkInterval?: number; // in milliseconds, 0 to disable
}

// Stores the version the user last deferred, not a boolean — otherwise "Later"
// either resets on every relaunch or silently swallows every future release.
const DISMISSED_KEY = "calimero-update-dismissed-version";

export default function UpdateNotification({
  checkOnMount = true,
  checkInterval = 3600000, // 1 hour default
}: UpdateNotificationProps) {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [installing, setInstalling] = useState(false);
  const [installStatus, setInstallStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [mandatory, setMandatory] = useState(false);

  useEffect(() => {
    // Get current version
    getCurrentVersion().then(setCurrentVersion);

    // Check for updates on mount
    if (checkOnMount) {
      performUpdateCheck();
    }

    // Set up interval for periodic checks
    if (checkInterval > 0) {
      const interval = setInterval(performUpdateCheck, checkInterval);
      return () => clearInterval(interval);
    }
  }, [checkOnMount, checkInterval]);

  const performUpdateCheck = async () => {
    const status = await checkForUpdates();
    if (status.available && status.info) {
      setUpdateAvailable(true);
      setUpdateInfo(status.info);
      setMandatory(!!status.mandatory);
      setDismissed(
        !status.mandatory &&
          localStorage.getItem(DISMISSED_KEY) === status.info.version,
      );
    } else if (status.error) {
      console.warn("Update check failed:", status.error);
    }
  };

  const handleInstall = async () => {
    setInstalling(true);
    setError(null);
    try {
      await installUpdate((status) => setInstallStatus(status));
      // relaunch() is called inside installUpdate — app closes here
    } catch (err) {
      setError(parseTauriError(err, "Failed to install update"));
      setInstalling(false);
      setInstallStatus("");
    }
  };

  const handleDismiss = () => {
    if (updateInfo) {
      localStorage.setItem(DISMISSED_KEY, updateInfo.version);
    }
    setDismissed(true);
  };

  // Don't render if no update or dismissed
  if (!updateAvailable || dismissed || !updateInfo) {
    return null;
  }

  return (
    <div
      className={
        mandatory
          ? "update-notification update-notification-blocking"
          : "update-notification"
      }
      role={mandatory ? "alertdialog" : undefined}
      aria-modal={mandatory ? true : undefined}
      aria-label={mandatory ? "Required update" : undefined}
    >
      <div className="update-notification-content">
        <div className="update-notification-icon">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 12a9 9 0 11-6.219-8.56" />
            <polyline points="21 3 21 9 15 9" />
          </svg>
        </div>

        <div className="update-notification-text">
          <h4>{mandatory ? "Update Required" : "Update Available"}</h4>
          <p>
            {mandatory
              ? `This version is no longer supported. Update to ${updateInfo.version} to keep using Calimero Desktop.`
              : `Version ${updateInfo.version} is available.`}
            {currentVersion && ` You have ${currentVersion}.`}
          </p>
        </div>

        <div className="update-notification-actions">
          {error && <span className="update-error">{error}</span>}

          {!mandatory && (
            <button
              className="update-button update-button-secondary"
              onClick={handleDismiss}
              disabled={installing}
            >
              Later
            </button>
          )}

          <button
            className="update-button update-button-primary"
            onClick={handleInstall}
            disabled={installing}
          >
            {installing ? (installStatus || "Installing...") : "Update Now"}
          </button>
        </div>
      </div>
    </div>
  );
}
