import { appInstalled, decodeMetadata } from "./appUtils";
import { listInstalledApps } from "./installedAppsCache";

/**
 * Applications as the namespace views name them, read from the node's
 * installed-apps listing. Shared by the Namespaces and Cloud pages, which both
 * group namespaces under the application they target.
 */
export interface InstalledApp {
  id: string;
  name: string;
  /** The bundle's own package id (`only-peers-chat`), when it declares one. */
  package: string | null;
  version: string | null;
  /** `data:image/png;base64,…` from the signed bundle, as the launcher uses. */
  icon: string | null;
  frontendUrl: string | null;
  metadata?: unknown;
  /** The node names an app as soon as a namespace targets it; the blob is what
   *  makes it runnable here. */
  installed: boolean;
}

export function readInstalledApps(): Promise<InstalledApp[]> {
  return listInstalledApps().then((res) => {
    if (res.error || !Array.isArray(res.data)) return [];
    return res.data.map((app: any) => {
      let name: string = app.id;
      let frontendUrl: string | null = null;
      let pkg: string | null = null;
      // The list row carries a version of its own; bundle metadata wins when
      // both are present, matching InstalledAppCard.
      let version: string | null = app.version ?? null;
      let icon: string | null = null;
      try {
        const meta = decodeMetadata(app.metadata);
        if (meta) {
          name = meta.name || meta.alias || app.id;
          frontendUrl = meta?.links?.frontend ?? null;
          pkg = meta.package ?? null;
          version = meta.version ?? version;
          icon = meta.icon ?? null;
        }
      } catch {
        // ignore
      }
      return {
        id: app.id,
        name,
        package: pkg ?? app.package ?? null,
        version,
        icon,
        frontendUrl,
        installed: appInstalled(app),
      };
    });
  });
}
