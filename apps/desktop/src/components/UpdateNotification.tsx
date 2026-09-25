import { useState, useEffect, useCallback } from "react";
import {
  checkForUpdates,
  installUpdate,
  getCurrentVersion,
  isTauri,
  reflectUpdateInTray,
  startUpdateChecks,
  TRAY_CHECK_EVENT,
  type UpdateInfo,
  type UpdateStatus,
} from "../utils/updater";
import { parseTauriError } from "../utils/appUtils";
import "./UpdateNotification.css";

// Stores the version the user last deferred, not a boolean — otherwise "Later"
// either resets on every relaunch or silently swallows every future release.
const DISMISSED_KEY = "calimero-update-dismissed-version";
// How long the "you're up to date" answer to a manual check stays on screen.
const UP_TO_DATE_NOTICE_MS = 5000;

// The outcome of a check the user asked for (tray menu). Background checks
// never produce one: an offline laptop must not grow an error card every hour,
// but a question the user asked always gets an answer.
type ManualNotice =
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "failed"; message: string };

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

export default function UpdateNotification() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [installing, setInstalling] = useState(false);
  const [installStatus, setInstallStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [mandatory, setMandatory] = useState(false);
  const [notice, setNotice] = useState<ManualNotice | null>(null);

  const applyStatus = useCallback((status: UpdateStatus, manual: boolean) => {
    if (status.unsupported) return;
    reflectUpdateInTray(status);
    if (status.available && status.info) {
      setUpdateAvailable(true);
      setUpdateInfo(status.info);
      setMandatory(!!status.mandatory);
      // A manual check is the user asking to see it, so it overrides "Later".
      setDismissed(
        !manual &&
          !status.mandatory &&
          readDismissed() === status.info.version,
      );
      setNotice(null);
      return;
    }
    if (status.error) {
      console.error("Update check failed:", status.error);
      if (manual) setNotice({ kind: "failed", message: status.error });
      return;
    }
    // Up to date. Clear a banner a newer check has superseded.
    setUpdateAvailable(false);
    setUpdateInfo(null);
    setMandatory(false);
    if (manual) setNotice({ kind: "current" });
  }, []);

  const checkNow = useCallback(async () => {
    setNotice({ kind: "checking" });
    applyStatus(await checkForUpdates(), true);
  }, [applyStatus]);

  useEffect(() => {
    getCurrentVersion().then(setCurrentVersion);
    return startUpdateChecks((status) => applyStatus(status, false));
  }, [applyStatus]);

  // "Check for Updates…" in the tray menu. The Rust side has already shown the
  // main window, so the answer lands where the user is looking.
  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen(TRAY_CHECK_EVENT, () => { checkNow(); }))
      .then((unlisten) => {
        if (cancelled) unlisten();
        else off = unlisten;
      })
      .catch((e) => console.warn("[updater] tray listener failed:", e));
    return () => {
      cancelled = true;
      off?.();
    };
  }, [checkNow]);

  useEffect(() => {
    if (notice?.kind !== "current") return;
    const t = setTimeout(() => setNotice(null), UP_TO_DATE_NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

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
      try {
        localStorage.setItem(DISMISSED_KEY, updateInfo.version);
      } catch {
        // Storage unavailable: "Later" still hides it for this session.
      }
    }
    setDismissed(true);
  };

  if (!updateAvailable || dismissed || !updateInfo) {
    if (!notice) return null;
    return (
      <div className="update-notification" role="status" aria-live="polite">
        <div className="update-notification-content">
          <div className="update-notification-text">
            <h4>
              {notice.kind === "checking"
                ? "Checking for updates…"
                : notice.kind === "current"
                  ? "You're up to date"
                  : "Update check failed"}
            </h4>
            {notice.kind === "current" && currentVersion && (
              <p>Calimero Desktop {currentVersion} is the latest version.</p>
            )}
            {notice.kind === "failed" && (
              <p className="update-error-detail">{notice.message}</p>
            )}
          </div>
          {notice.kind !== "checking" && (
            <div className="update-notification-actions">
              {notice.kind === "failed" && (
                <button
                  className="update-button update-button-primary"
                  onClick={checkNow}
                >
                  Retry
                </button>
              )}
              <button
                className="update-button update-button-secondary"
                onClick={() => setNotice(null)}
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    );
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
