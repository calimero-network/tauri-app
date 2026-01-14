import { useState, useEffect } from "react";
import {
  checkForUpdates,
  installUpdate,
  getCurrentVersion,
  type UpdateInfo,
} from "../utils/updater";
import "./UpdateNotification.css";

interface UpdateNotificationProps {
  checkOnMount?: boolean;
  checkInterval?: number; // in milliseconds, 0 to disable
}

export default function UpdateNotification({
  checkOnMount = true,
  checkInterval = 3600000, // 1 hour default
}: UpdateNotificationProps) {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

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
      setDismissed(false);
    } else if (status.error) {
      console.warn("Update check failed:", status.error);
    }
  };

  const handleInstall = async () => {
    setInstalling(true);
    setError(null);

    try {
      await installUpdate();
      // If we get here, the app should restart
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to install update");
      setInstalling(false);
    }
  };

  const handleDismiss = () => {
    setDismissed(true);
  };

  // Don't render if no update or dismissed
  if (!updateAvailable || dismissed || !updateInfo) {
    return null;
  }

  return (
    <div className="update-notification">
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
          <h4>Update Available</h4>
          <p>
            Version {updateInfo.version} is available.
            {currentVersion && ` You have ${currentVersion}.`}
          </p>
        </div>

        <div className="update-notification-actions">
          {error && <span className="update-error">{error}</span>}

          <button
            className="update-button update-button-secondary"
            onClick={handleDismiss}
            disabled={installing}
          >
            Later
          </button>

          <button
            className="update-button update-button-primary"
            onClick={handleInstall}
            disabled={installing}
          >
            {installing ? "Installing..." : "Update Now"}
          </button>
        </div>
      </div>
    </div>
  );
}
