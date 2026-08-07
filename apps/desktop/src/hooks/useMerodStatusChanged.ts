import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * Run `fn` whenever the backend reports a merod start/stop/reap; pair with a
 * slow poll only to discover nodes started outside the app. `fn` is read
 * through a ref so a caller redefining it per render does not resubscribe.
 */
export function useMerodStatusChanged(fn: () => void, enabled = true): void {
  const latest = useRef(fn);

  useEffect(() => {
    latest.current = fn;
  });

  useEffect(() => {
    if (!enabled) return;
    const unlisten = listen("merod-status-changed", () => latest.current()).catch(() => null);
    return () => {
      unlisten.then((off) => off && off()).catch(() => {});
    };
  }, [enabled]);
}
