import { useEffect, useState } from 'react';
import { findBundledFrontends } from '../utils/appUtils';

/** The node-bundled frontend URL by app id, for the apps that declare no frontend link. */
export function useBundledFrontends(apps: { id: string; metadata?: unknown }[]): Record<string, string> {
  const [bundled, setBundled] = useState<Record<string, string>>({});
  const key = apps.map((app) => app.id).join(',');

  useEffect(() => {
    let cancelled = false;
    findBundledFrontends(apps).then((found) => {
      if (!cancelled) setBundled(found);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return bundled;
}
