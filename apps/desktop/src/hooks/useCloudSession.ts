import { useEffect, useState } from "react";

import { CLOUD_SESSION_CHANGED_EVENT, getCloudIdToken } from "../utils/cloudAuth";
import { getSettings } from "../utils/settings";

/**
 * Where the stored Calimero Cloud session stands.
 *
 * `expired` is a session this app still remembers but can no longer use: the
 * user signed in once and the token ran out. It reads differently from never
 * having signed in, so the UI can say "sign in again" rather than "connect".
 */
export type CloudSessionStatus = "connected" | "expired" | "signed-out";

export function readCloudSessionStatus(): CloudSessionStatus {
  const settings = getSettings();
  if (!settings.cloudConnected || !settings.cloudIdToken) return "signed-out";
  return getCloudIdToken() ? "connected" : "expired";
}

/**
 * Reactive read of the cloud session. Re-reads on sign-in and disconnect
 * (`CLOUD_SESSION_CHANGED_EVENT`) and whenever the window regains focus, which
 * is when a token that ran out in the background is noticed.
 */
export function useCloudSession(): CloudSessionStatus {
  const [status, setStatus] = useState<CloudSessionStatus>(readCloudSessionStatus);

  useEffect(() => {
    const update = () => setStatus(readCloudSessionStatus());
    // A change dispatched between render and this effect would otherwise be missed.
    update();
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, update);
    window.addEventListener("focus", update);
    return () => {
      window.removeEventListener(CLOUD_SESSION_CHANGED_EVENT, update);
      window.removeEventListener("focus", update);
    };
  }, []);

  return status;
}
