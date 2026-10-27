import {
  HTTPError,
  type ActivateGroupUpgradeFailedContext,
  type AdminApiClient,
  type ContextWithGroup,
  type Namespace,
} from '@calimero-network/mero-js';
import { nodeErrorMessage } from '../lib/mero-client';

export type FailedContext = ActivateGroupUpgradeFailedContext;
export type SwitchTarget = Pick<
  Namespace,
  'namespaceId' | 'name' | 'targetApplicationId' | 'appVersion' | 'appPackage'
>;
type SwitchClient = { admin: Pick<AdminApiClient, 'installApplication' | 'activateGroupUpgrade' | 'getGroupMissingReleases'> };

export type SwitchResult =
  | { kind: 'switched'; failed: FailedContext[] }
  | { kind: 'moved' }
  | { kind: 'error'; message: string };

/**
 * The contexts this node holds for the namespace that run another release than
 * it names. A context with no release of its own is unknown, never behind.
 */
export function behindContexts(
  ns: Pick<SwitchTarget, 'appVersion'>,
  contexts: ContextWithGroup[],
  groupIds: string[],
): ContextWithGroup[] {
  if (!ns.appVersion) return [];
  return heldContexts(contexts, groupIds).filter(
    (c) => c.applicationVersion && c.applicationVersion !== ns.appVersion,
  );
}

const heldContexts = (contexts: ContextWithGroup[], groupIds: string[]) =>
  contexts.filter((c) => c.groupId && groupIds.includes(c.groupId));

/** The release this node runs the namespace on; each release with its context count while mixed. */
export function runningLabel(
  ns: Pick<SwitchTarget, 'appVersion'>,
  contexts: ContextWithGroup[],
  groupIds: string[],
): string {
  const held = heldContexts(contexts, groupIds);
  if (held.length === 0) return 'not on this node yet';
  const counts = new Map<string, number>();
  for (const c of held) {
    if (c.applicationVersion) counts.set(c.applicationVersion, (counts.get(c.applicationVersion) ?? 0) + 1);
  }
  if (counts.size === 0) return ns.appVersion ?? 'unknown';
  if (counts.size === 1) return [...counts.keys()][0]!;
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([v, n]) => `${v} on ${n}`)
    .join(', ');
}

/** How many of this node's contexts of the namespace still run an older release, as a sentence. */
export function behindPhrase(
  ns: Pick<SwitchTarget, 'appVersion'>,
  contexts: ContextWithGroup[],
  groupIds: string[],
  subject: 'contexts' | 'of its contexts',
): string {
  const behind = behindContexts(ns, contexts, groupIds).length;
  const held = heldContexts(contexts, groupIds).length;
  return `${behind} of ${held} ${subject} on this node ${behind === 1 ? 'still runs' : 'still run'} an older release.`;
}

// A bundle signed by another key derives another id, so it is not this namespace's app.
const differentApplication = (pkg: string, version: string, applicationId: string) =>
  new Error(
    `${pkg} ${version} installed as a different application (${applicationId.slice(0, 8)}...), ` +
      'probably signed by another key, so this namespace cannot switch to it.',
  );

/**
 * Moves this node's contexts of the namespace onto the release it names: installs
 * the releases this node lacks, oldest first and the target last, then activates, refused (409) if the admin moved on.
 */
export async function switchNamespace(
  mero: SwitchClient,
  ns: SwitchTarget,
  installed: boolean,
  onStep?: (step: 'installing' | 'switching') => void,
): Promise<SwitchResult> {
  const version = ns.appVersion;
  try {
    const missing = await mero.admin.getGroupMissingReleases(ns.namespaceId);
    if (missing.length > 0) onStep?.('installing');
    for (const r of missing) {
      const { applicationId } = await mero.admin.installApplication({ package: r.package, version: r.version });
      if (applicationId && applicationId !== r.applicationId) throw differentApplication(r.package, r.version, applicationId);
    }
    // The last install names the application's current release, so the target must come last.
    if (missing.length > 0 ? missing[missing.length - 1]!.version !== version : !installed) {
      if (!ns.appPackage || !version) throw new Error('the namespace names no release to install');
      onStep?.('installing');
      const { applicationId } = await mero.admin.installApplication({ package: ns.appPackage, version });
      if (applicationId && applicationId !== ns.targetApplicationId) {
        throw differentApplication(ns.appPackage, version, applicationId);
      }
    }
    onStep?.('switching');
    const res = await mero.admin.activateGroupUpgrade(ns.namespaceId, {
      expectedApplicationId: ns.targetApplicationId,
      expectedVersion: version,
    });
    return { kind: 'switched', failed: res.failedContexts };
  } catch (e) {
    if (e instanceof HTTPError && e.status === 409) return { kind: 'moved' };
    return { kind: 'error', message: nodeErrorMessage(e, `Could not switch to ${version}`) };
  }
}
