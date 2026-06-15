import { useEffect, useState } from "react";

import {
  CLOUD_ENABLED_CHANGED_EVENT,
  isCloudEnabled,
} from "../utils/featureFlags";

/**
 * Reactive read of the cloud feature flag.
 *
 * Returns the current `isCloudEnabled()` value and re-renders the consuming
 * component whenever the flag changes at runtime (e.g. the Settings "Enable Cloud"
 * toggle calls `notifyCloudEnabledChanged()`). Recomputes on mount in case the flag
 * changed before this component subscribed.
 *
 * For non-React callers, use the plain `isCloudEnabled()` function directly.
 */
export function useCloudEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(isCloudEnabled);

  useEffect(() => {
    // The useState initializer runs during render, but the listener below only
    // registers after commit. Re-read here so a flag change dispatched in that gap
    // is not missed. No-op when unchanged (React bails via Object.is).
    setEnabled(isCloudEnabled());

    const handler = () => setEnabled(isCloudEnabled());
    window.addEventListener(CLOUD_ENABLED_CHANGED_EVENT, handler);
    return () => {
      window.removeEventListener(CLOUD_ENABLED_CHANGED_EVENT, handler);
    };
  }, []);

  return enabled;
}
