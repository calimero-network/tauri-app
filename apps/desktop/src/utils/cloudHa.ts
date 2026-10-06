import type { InstalledApp } from './namespaceApps';
import { isAdminRole } from './groupRoles';

/** The fields of a node's namespace listing the Cloud page reads. */
export interface CloudPageNamespace {
  namespaceId: string;
  targetApplicationId?: string;
  name?: string;
  memberCount?: number;
}

/** One namespace row on the Cloud page. */
export interface HaRow {
  namespaceId: string;
  name: string;
  memberCount: number | null;
  /**
   * Only the namespace root's Admin can turn HA on or off: enabling it signs an
   * ownership proof with the root key and writes the TEE admission policy.
   * `null` while the role is still being looked up.
   */
  canManage: boolean | null;
  haOn: boolean;
}

/** One application and the namespaces bound to it. */
export interface HaAppGroup {
  applicationId: string;
  app: InstalledApp | undefined;
  rows: HaRow[];
  /** Rows this node may change. */
  manageable: number;
  /** Manageable rows with HA on. */
  manageableOn: number;
}

export type HaFilter = 'all' | 'off' | 'shared';

const truncateId = (id: string) => (id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-8)}` : id);

/**
 * Namespaces grouped under the application they target, for the Cloud page.
 *
 * Only applications with at least one namespace are listed (an app with no
 * namespace has nothing to keep online). Groups and rows sort by name so the
 * list stays put while switches flip, rather than reshuffling under the cursor.
 *
 * `roles` holds this node's role per namespace root; a missing key means the
 * lookup has not answered yet, `undefined` that it answered without one.
 */
export function groupForCloud(
  namespaces: readonly CloudPageNamespace[],
  appById: Record<string, InstalledApp>,
  roles: Record<string, string | undefined>,
  haEnabled: Record<string, boolean>,
): HaAppGroup[] {
  const byApp = new Map<string, HaRow[]>();
  for (const ns of namespaces) {
    const applicationId = ns.targetApplicationId ?? '';
    const app = appById[applicationId];
    const row: HaRow = {
      namespaceId: ns.namespaceId,
      name: ns.name || app?.name || truncateId(ns.namespaceId),
      memberCount: typeof ns.memberCount === 'number' ? ns.memberCount : null,
      canManage: ns.namespaceId in roles ? isAdminRole(roles[ns.namespaceId]) : null,
      haOn: haEnabled[ns.namespaceId] === true,
    };
    const list = byApp.get(applicationId);
    if (list) list.push(row);
    else byApp.set(applicationId, [row]);
  }
  return Array.from(byApp.entries())
    .map(([applicationId, rows]) => {
      rows.sort((a, b) => a.name.localeCompare(b.name) || a.namespaceId.localeCompare(b.namespaceId));
      const manageableRows = rows.filter((r) => r.canManage === true);
      return {
        applicationId,
        app: appById[applicationId],
        rows,
        manageable: manageableRows.length,
        manageableOn: manageableRows.filter((r) => r.haOn).length,
      };
    })
    .sort((a, b) =>
      (a.app?.name ?? a.applicationId).localeCompare(b.app?.name ?? b.applicationId),
    );
}

/**
 * The groups narrowed to a filter and a search. A group stays when any of its
 * rows match; a search that names the application keeps every row under it.
 *
 * - `off`: namespaces this node could turn on but has not.
 * - `shared`: namespaces someone else administers, which this node can only see.
 */
export function filterGroups(groups: readonly HaAppGroup[], filter: HaFilter, query: string): HaAppGroup[] {
  const q = query.trim().toLowerCase();
  const byFilter = (r: HaRow) =>
    filter === 'all' ||
    (filter === 'off' && r.canManage === true && !r.haOn) ||
    (filter === 'shared' && r.canManage === false);
  const out: HaAppGroup[] = [];
  for (const g of groups) {
    const appMatches =
      !q ||
      [g.app?.name, g.app?.package, g.applicationId].some((s) => !!s && s.toLowerCase().includes(q));
    const rows = g.rows.filter(
      (r) =>
        byFilter(r) &&
        (appMatches || r.name.toLowerCase().includes(q) || r.namespaceId.toLowerCase().includes(q)),
    );
    if (rows.length > 0) out.push({ ...g, rows });
  }
  return out;
}

/** Namespace ids in the groups that this node could turn on and has not. */
export function enableableIds(groups: readonly HaAppGroup[]): string[] {
  return groups.flatMap((g) => g.rows.filter((r) => r.canManage === true && !r.haOn).map((r) => r.namespaceId));
}
