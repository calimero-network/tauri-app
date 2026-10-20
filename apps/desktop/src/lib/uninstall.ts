/**
 * What uninstalling an app does to each of its namespaces: a pure decision from
 * the dialog's two ticks, and the node calls that carry it out.
 */
import { AuthRevokedError, HTTPError, type MeroJs, type NodeIdentity } from '@calimero-network/mero-js';
import { isAdminRole, roleOf, transferCandidates } from '../utils/groupRoles';
import {
  isForgotten,
  leaveNamespacePurging,
  namespaceLabel,
  nodeErrorMessage,
  wrap,
  type ApiResponse,
} from './mero-client';

/** One of the app's namespaces as the uninstall dialog lists it. */
export interface AppNamespace {
  id: string;
  name: string;
  /** This account's role, or undefined when the member list did not name us. */
  role?: string;
  /** Members besides us who could take it over; fleet nodes are not counted. */
  others: number;
}

export interface UninstallChoice {
  deleteData: boolean;
  leave: boolean;
  /** Owned namespaces the user confirmed deleting for every member. */
  deleteForEveryone: ReadonlySet<string>;
  /** This node is a device linked to an account whose root is held elsewhere. */
  linkedDevice: boolean;
}

export type NamespaceAction =
  | 'keep'
  | 'remove'
  | 'leave'
  | 'delete-for-everyone'
  | 'needs-transfer'
  | 'needs-primary-device';

export function planNamespace(ns: AppNamespace, choice: UninstallChoice): NamespaceAction {
  if (!choice.deleteData) return 'keep';
  if (!choice.leave) return 'remove';
  // Core names no owner, and refuses a leave from the owner or the last admin,
  // so an admin is treated as the owner.
  if (!isAdminRole(ns.role)) return 'leave';
  // Owner-only ops need the account root, which a linked device does not hold.
  if (choice.linkedDevice) return 'needs-primary-device';
  if (ns.others === 0 || choice.deleteForEveryone.has(ns.id)) return 'delete-for-everyone';
  return 'needs-transfer';
}

export function isBlocked(actions: readonly NamespaceAction[]): boolean {
  return actions.some((a) => a === 'needs-transfer' || a === 'needs-primary-device');
}

function members(n: number): string {
  return n === 2 ? 'both members' : `all ${n} members`;
}

export function describeStep(ns: AppNamespace, action: NamespaceAction): string {
  const what = {
    keep: 'kept on this device',
    remove: 'removed from this device; you stay a member',
    leave: 'you leave it, and all your devices remove it',
    'delete-for-everyone':
      ns.others === 0 ? 'deleted; you are its only member' : `deleted for ${members(ns.others + 1)}`,
    'needs-transfer':
      ns.others === 1
        ? 'you own it and 1 other is a member; transfer ownership first'
        : `you own it and ${ns.others} others are members; transfer ownership first`,
    'needs-primary-device': 'only the computer that holds the account can delete it',
  }[action];
  return `${ns.name}: ${what}`;
}

export interface UninstallStep {
  ns: AppNamespace;
  action: NamespaceAction;
}

/** A failed uninstall, with the steps that had already taken effect. */
export interface UninstallError {
  message: string;
  code?: string;
  completed: UninstallStep[];
}

export interface UninstallResult {
  data?: { applicationId: string };
  error?: UninstallError;
}

export function describeDone(ns: AppNamespace, action: NamespaceAction): string {
  const did = {
    leave: 'was left',
    remove: 'was removed from this device',
    'delete-for-everyone': 'was deleted for everyone',
  }[action as 'leave' | 'remove' | 'delete-for-everyone'];
  return `${ns.name} ${did}`;
}

export function uninstallFailureMessage(appName: string, error: UninstallError): string {
  const parts = [...error.completed.map((s) => describeDone(s.ns, s.action)), error.message];
  return `"${appName}" was not uninstalled: ${parts.join('; ')}`;
}

/** The app's namespaces on this device, each with our role and member count. */
export function loadAppNamespaces(
  meroJs: MeroJs,
  applicationId: string,
): Promise<ApiResponse<{ namespaces: AppNamespace[]; linkedDevice: boolean }>> {
  return wrap("Failed to read the app's namespaces", async () => {
    const [all, identity] = await Promise.all([
      meroJs.admin.listNamespacesForApplication(applicationId),
      // A node that has taken part in nothing yet has no identity to answer with.
      meroJs.admin.getNodeIdentity().catch((e): NodeIdentity | null => {
        if (e instanceof HTTPError && e.status === 404) return null;
        throw e;
      }),
    ]);
    const accountId = identity?.accountId;
    const namespaces = await Promise.all(
      (all ?? []).filter((ns) => !isForgotten(ns)).map(async (ns) => {
        const { members } = await meroJs.admin.listGroupMembers(ns.namespaceId);
        return {
          id: ns.namespaceId,
          name: namespaceLabel(ns),
          role: roleOf(members, accountId),
          others: transferCandidates(members, accountId).length,
        };
      }),
    );
    return { namespaces, linkedDevice: identity?.holdsAccountRoot === false };
  });
}

function runStep(meroJs: MeroJs, { ns, action }: UninstallStep): Promise<unknown> {
  switch (action) {
    case 'leave':
      return leaveNamespacePurging(meroJs, ns.id);
    case 'remove':
      return meroJs.admin.deleteNamespace(ns.id);
    case 'delete-for-everyone':
      return meroJs.admin.ownerDeleteGroup(ns.id);
    default:
      return Promise.resolve();
  }
}

/**
 * Contexts of the app that outlived its namespaces' removal (a lazy upgrade
 * leaves a context on the old application id inside a namespace that targets
 * the new one). Leaving is node-local; a context delete would detach it for
 * every member.
 */
async function leaveRemainingContexts(meroJs: MeroJs, applicationId: string): Promise<void> {
  const { contexts } = await meroJs.admin.getContextsForApplication(applicationId);
  for (const { id } of contexts ?? []) {
    try {
      await meroJs.admin.leaveContext(id);
    } catch (e) {
      throw failure(e, `Context ${id.slice(0, 8)} failed`);
    }
  }
}

/**
 * Apply each namespace's step in order, then (with `sweepContexts`) leave any
 * context they left behind, then uninstall the app. The first failure stops it
 * with the app still installed, names what failed, and returns the steps that
 * had already taken effect.
 */
export async function uninstallApp(
  meroJs: MeroJs,
  applicationId: string,
  steps: readonly UninstallStep[],
  sweepContexts = false,
): Promise<UninstallResult> {
  const completed: UninstallStep[] = [];
  const response = await wrap('Failed to uninstall application', async () => {
    const waiting = steps.find((s) => isBlocked([s.action]));
    if (waiting) throw new Error(describeStep(waiting.ns, waiting.action));
    for (const step of steps) {
      try {
        await runStep(meroJs, step);
      } catch (e) {
        throw failure(e, `${step.ns.name} failed`);
      }
      if (step.action !== 'keep') completed.push(step);
    }
    if (sweepContexts) await leaveRemainingContexts(meroJs, applicationId);
    await meroJs.admin.uninstallApplication(applicationId);
    return { applicationId };
  });
  return response.error ? { error: { ...response.error, completed } } : { data: response.data };
}

/** Names what failed, but keeps a sign-in failure as is so `wrap` still reads it. */
function failure(e: unknown, what: string): unknown {
  if (e instanceof AuthRevokedError || (e instanceof HTTPError && e.status === 401)) return e;
  return new Error(nodeErrorMessage(e, what));
}
