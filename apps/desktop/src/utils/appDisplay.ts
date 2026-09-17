/**
 * Backfills an app row's display (name/icon) from the registry when core
 * seeded it with empty metadata - the case for bytecode that arrived by blob
 * share instead of a registry install.
 */

import { decodeMetadata } from './appUtils';

export interface AppDisplay {
  name?: string;
  icon?: string;
  description?: string;
}

export interface AppRow {
  package?: string;
  version?: string;
  metadata?: unknown;
}

/** True when the row names a package/version but its metadata has no name to show. */
export function needsDisplayBackfill(app: AppRow): boolean {
  if (typeof app.package !== 'string' || !app.package) return false;
  if (typeof app.version !== 'string' || !app.version) return false;
  const decoded = decodeMetadata(app.metadata);
  return !decoded?.name;
}

/** Copy of `app` with its metadata replaced by `display`; unchanged when `display` is null. */
export function withDisplay<T extends AppRow>(app: T, display: AppDisplay | null): T {
  if (!display) return app;
  return { ...app, metadata: display };
}
