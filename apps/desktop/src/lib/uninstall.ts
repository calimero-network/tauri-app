/**
 * What uninstalling an app does to each of its namespaces, decided from the
 * dialog's two ticks. Pure, so every row of the outcome table is unit-tested.
 */
import { isAdminRole } from '../utils/groupRoles';

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
    'needs-primary-device': 'only your primary device can delete it',
  }[action];
  return `${ns.name}: ${what}`;
}
