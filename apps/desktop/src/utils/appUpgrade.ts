import { compareSemverDesc } from './registry';

/**
 * What a namespace admin can do to move a namespace onto a newer release.
 *
 * An upgrade takes two separate steps, and the second only does something
 * after the first:
 *
 * 1. INSTALL the release on this node. Local only: no peer sees it. A bundle's
 *    application id is `hash(package, signer)`, the same for every release, so
 *    installing a newer one moves this node's application row forward under
 *    the id the namespace already targets.
 * 2. UPGRADE the namespace (`upgradeGroup`). The node reads the target from
 *    that local row and publishes one signed op; every member then fetches the
 *    release from its own registry and switches each context on its next use.
 *
 * Upgrading without installing first moves the namespace to the release it
 * already runs, which does nothing. So the plan offers the install whenever
 * the registry has something newer than this node holds, and the upgrade only
 * once the installed release is newer than the one the namespace runs.
 */
export type UpgradePlan =
  /** The namespace runs the newest release we know of. */
  | { kind: 'current' }
  /** The registry has a release newer than this node holds: install it first. */
  | { kind: 'install'; version: string }
  /** This node holds a release newer than the namespace runs. */
  | { kind: 'upgrade'; version: string }
  /**
   * This node doesn't hold the release the namespace runs. On a member's node
   * that is the normal state right after an upgrade: the node learns the new
   * target at once but fetches the release only when a context is next used
   * there. Core before rc.90 names no running version then; from rc.90
   * (core#4607) it names the target's, which is newer than the one installed.
   */
  | { kind: 'unknown' };

/** Is `version` strictly newer than `than`? Missing or unparsable is never newer. */
export function isNewer(version: string | null | undefined, than: string | null | undefined): boolean {
  if (!version) return false;
  if (!than) return true;
  return compareSemverDesc(version, than) < 0;
}

export function planUpgrade(opts: {
  /** The version the namespace runs (`Namespace.appVersion`). */
  running?: string | null;
  /** The release this node's application row names. */
  installed?: string | null;
  /** The newest release the registry lists, if it was reachable. */
  published?: string | null;
}): UpgradePlan {
  const { running, installed, published } = opts;
  if (!running || isNewer(running, installed)) return { kind: 'unknown' };
  // Install before anything else: the upgrade targets whatever this node holds,
  // so a newer published release has to land here first.
  if (published && isNewer(published, installed) && isNewer(published, running)) {
    return { kind: 'install', version: published };
  }
  if (installed && isNewer(installed, running)) {
    return { kind: 'upgrade', version: installed };
  }
  return { kind: 'current' };
}

/** The upgrade row core keeps for a group, as `getGroupUpgradeStatus` returns it. */
export interface UpgradeStatusLike {
  fromVersion: string;
  toVersion: string;
  status: string;
  localContextsTotal?: number;
  localContextsSwapped?: number;
  localContextsFailed?: number;
}

export type UpgradeProgress =
  | { kind: 'none' }
  | { kind: 'running'; from: string; to: string; swapped: number; total?: number }
  | { kind: 'failed'; from: string; to: string; failed: number }
  | { kind: 'done'; from: string; to: string };

/**
 * Reads core's upgrade row. Core answers `in_progress` while a cascade walk is
 * swapping contexts and `completed` once it is done, which a direct upgrade is
 * at once, because its contexts switch lazily on their next use. A failed swap
 * is not a status of its own: it is a non-zero `localContextsFailed`, which
 * `retryGroupUpgrade` picks up.
 */
export function readUpgradeProgress(status: UpgradeStatusLike | null | undefined): UpgradeProgress {
  if (!status) return { kind: 'none' };
  const from = status.fromVersion;
  const to = status.toVersion;
  const failed = status.localContextsFailed ?? 0;
  if (failed > 0) return { kind: 'failed', from, to, failed };
  if (status.status.toLowerCase().replace(/[^a-z]/g, '') === 'inprogress') {
    return {
      kind: 'running',
      from,
      to,
      swapped: status.localContextsSwapped ?? 0,
      total: status.localContextsTotal,
    };
  }
  return { kind: 'done', from, to };
}
