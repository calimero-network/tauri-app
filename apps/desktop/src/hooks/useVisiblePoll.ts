import { useEffect, useRef } from "react";

/**
 * Run `fn` every `intervalMs` while the window is visible, plus once
 * immediately each time it becomes visible again so state catches up.
 *
 * Hiding this app leaves React mounted, so an ungated interval keeps talking to
 * the node for as long as the tray icon sits there. `fn` is read through a ref:
 * a caller redefining it per render does not restart the interval.
 */
export function useVisiblePoll(fn: () => void, intervalMs: number, enabled = true): void {
  const latest = useRef(fn);

  useEffect(() => {
    latest.current = fn;
  });

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      if (timer !== undefined) return;
      latest.current();
      timer = setInterval(() => latest.current(), intervalMs);
    };

    const onVisibilityChange = () => (document.hidden ? stop() : start());
    onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs, enabled]);
}
