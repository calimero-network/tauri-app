import { useEffect, useState } from 'react';
import { findBundledFrontends } from '../utils/appUtils';

/** The node-bundled frontend URL by app id, for the apps that declare no frontend link; `probing` until the first answer. */
export function useBundledFrontends(apps: { id: string; metadata?: unknown }[]): {
  frontends: Record<string, string>;
  probing: boolean;
} {
  const [bundled, setBundled] = useState<Record<string, string>>({});
  const [probing, setProbing] = useState(true);
  const key = apps.map((app) => app.id).join(',');

  useEffect(() => {
    let cancelled = false;
    setProbing(true);
    findBundledFrontends(apps).then((found) => {
      if (cancelled) return;
      setBundled(found);
      setProbing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return { frontends: bundled, probing };
}
