/// <reference types="vite/client" />

import { getSettings } from "./settings";

const RAW_CLOUD = import.meta.env.VITE_ENABLE_CLOUD as string | undefined;

/**
 * Build-time default for the cloud feature flag.
 * If VITE_ENABLE_CLOUD is "true"/"1" -> true; if explicitly other non-empty -> false;
 * if unset/empty -> defaults to import.meta.env.DEV.
 */
function buildTimeDefault(): boolean {
  if (RAW_CLOUD === undefined || RAW_CLOUD === "") return Boolean(import.meta.env.DEV);
  return RAW_CLOUD === "true" || RAW_CLOUD === "1";
}

/**
 * Runtime read of the cloud feature flag.
 *
 * A persisted runtime override (settings.cloudEnabled) wins when it is an explicit
 * boolean; otherwise we fall back to the build-time default. Callable on each render —
 * the result is intentionally not cached at module load so the Settings toggle takes
 * effect immediately without a rebuild.
 */
export function isCloudEnabled(): boolean {
  const { cloudEnabled } = getSettings();
  if (typeof cloudEnabled === "boolean") return cloudEnabled;
  return buildTimeDefault();
}

/**
 * Event name dispatched on `window` when the cloud feature flag changes at runtime.
 * Subscribers (e.g. the `useCloudEnabled` React hook) listen for this to re-read
 * `isCloudEnabled()` and re-render without requiring a navigation.
 */
export const CLOUD_ENABLED_CHANGED_EVENT = "calimero:cloud-enabled-changed";

/**
 * Notify subscribers that the cloud feature flag changed.
 *
 * Implemented as a custom DOM event on `window` so the pub/sub stays framework-agnostic.
 * No-op in non-browser environments (SSR / tests without a DOM).
 */
export function notifyCloudEnabledChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CLOUD_ENABLED_CHANGED_EVENT));
}
