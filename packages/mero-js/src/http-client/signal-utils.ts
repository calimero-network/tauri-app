// Utility for combining multiple AbortSignals
export function combineSignals(
  signals: Array<AbortSignal | undefined>,
): AbortSignal | undefined {
  const list = signals.filter(Boolean) as AbortSignal[];
  if (list.length === 0) return undefined;

  // Prefer native any(), but fall back if unavailable or it throws
  const AbortSignalAny = AbortSignal as {
    any?: (signals: AbortSignal[]) => AbortSignal;
  };
  if (typeof AbortSignalAny.any === 'function') {
    try {
      return AbortSignalAny.any(list);
    } catch {
      // Fall through to manual implementation
    }
  }

  const controller = new AbortController();
  const onAbort = (evt: Event) => {
    controller.abort((evt.target as AbortSignal).reason);
    for (const s of list) s.removeEventListener('abort', onAbort);
  };

  for (const s of list) {
    if (s.aborted) return AbortSignal.abort(s.reason);
    s.addEventListener('abort', onAbort, { once: true });
  }

  return controller.signal;
}

// Helper to create a timeout signal
export function createTimeoutSignal(timeoutMs: number): AbortSignal {
  // Use AbortSignal.timeout if available (Node 18.17+, modern browsers)
  if (typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }

  // Fallback for older environments
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort(new DOMException('Timeout', 'TimeoutError'));
  }, timeoutMs);

  return controller.signal;
}
