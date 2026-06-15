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
    // Recompute on mount to catch any change between initial state and subscription.
    setEnabled(isCloudEnabled());

    const handler = () => setEnabled(isCloudEnabled());
    window.addEventListener(CLOUD_ENABLED_CHANGED_EVENT, handler);
    return () => {
      window.removeEventListener(CLOUD_ENABLED_CHANGED_EVENT, handler);
    };
  }, []);

  return enabled;
}
