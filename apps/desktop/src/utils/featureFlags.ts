import { getSettings } from "./settings";

/**
 * Runtime read of the cloud feature flag.
 *
 * On by default. A persisted settings.cloudEnabled wins when it is an explicit
 * boolean - only the Settings toggle writes it, so it is always the user's own
 * choice. Callable on each render —
 * the result is intentionally not cached at module load so the Settings toggle takes
 * effect immediately without a rebuild.
 *
 * NOTE: This flag is a UI-only convenience, NOT a security boundary. It is read from
 * localStorage (user-writable via settings) and only gates whether cloud UI surfaces
 * are shown. Every actual cloud operation independently enforces auth by validating the
 * MDMA session token (isMdmaSessionToken / isTokenExpired) regardless of this flag, so
 * flipping it cannot grant or bypass access to cloud functionality.
 */
export function isCloudEnabled(): boolean {
  const { cloudEnabled } = getSettings();
  return typeof cloudEnabled === "boolean" ? cloudEnabled : true;
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
