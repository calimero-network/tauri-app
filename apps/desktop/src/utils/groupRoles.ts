/**
 * "May I delete this, or may I only leave it?" — resolved from the member
 * list of the group that guards the action.
 *
 * Every destructive admin-API call the Namespaces page can make is role-gated
 * on merod's side, against the ACCOUNT the caller's device key acts as:
 *
 *   • `DELETE /admin-api/namespaces/:id`  → `require_admin` on the namespace root
 *   • `DELETE /admin-api/groups/:id`      → the subgroup's OWNER, an admin of the
 *                                           namespace root, or a member holding
 *                                           `CAN_DELETE_SUBGROUP`
 *   • `DELETE /admin-api/contexts/:id`    → `require_admin` on the context's
 *                                           OWNING group — the subgroup it lives
 *                                           in, or the namespace root for a
 *                                           root-level context
 *
 * so offering a plain member Delete is a dead-end button. The self-service
 * counterparts — `POST /admin-api/{namespaces,groups,contexts}/:id/leave` —
 * carry no role gate at all, and are what that member actually needs.
 *
 * The role read is a best guess, not the authority: the subgroup rule above
 * admits a non-admin capability holder the member list cannot distinguish. The
 * node stays the enforcement point, and `isPermissionError` catches what the
 * guess gets wrong.
 *
 * Kept as pure functions plus one fetch so the decision logic is unit-testable
 * without a node (the fetch is the only part the e2e mocks stand in for).
 */
import { getSettings } from './settings';
import { getAccessToken } from '../lib/token-storage';
import { extractMembersFromResponse } from './teeEviction';

interface GroupMember {
  /** The ACCOUNT, 64 hex. rc.23 (#3522) made the member listing answer with
   *  accounts, not the base58 device key — comparing against a device key
   *  matches nobody and every row reads as somebody else's. */
  identity: string;
  role?: string;
  name?: string;
}

/**
 * This node's role in a group, or `undefined` when it cannot be determined
 * (no account resolved yet, or no row for us in the list).
 *
 * `undefined` is deliberately NOT collapsed into "not admin": the two states
 * drive different UI (see `resolveGroupAction`).
 */
export function roleOf(
  members: readonly unknown[] | null | undefined,
  accountId: string | undefined,
): string | undefined {
  if (!accountId || !Array.isArray(members)) return undefined;
  const row = members.find(
    (m) => (m as GroupMember | null)?.identity === accountId,
  ) as GroupMember | undefined;
  return typeof row?.role === 'string' ? row.role : undefined;
}

/** Core serialises `GroupMemberRole::Admin` as the bare string `"Admin"`. */
export function isAdminRole(role: string | undefined): boolean {
  return (role ?? '').toLowerCase() === 'admin';
}

export type GroupAction = 'delete' | 'leave';

/**
 * Which destructive action to offer.
 *
 * Returns `'delete'` while anything is still unknown — members loading, no
 * account resolved, or no row found for us. That keeps the pre-existing
 * behaviour for the indeterminate window: merod still enforces admin-ship, so
 * the worst case is the error toast that was already there, never a wrong
 * destructive action. We only swap to `'leave'` once we POSITIVELY know we are
 * a non-admin member.
 */
export function resolveGroupAction(opts: {
  loading?: boolean;
  accountId?: string;
  role?: string;
}): GroupAction {
  if (opts.loading) return 'delete';
  if (!opts.accountId) return 'delete';
  if (opts.role === undefined) return 'delete';
  return isAdminRole(opts.role) ? 'delete' : 'leave';
}

/**
 * Does this failure SAY it was a permission refusal?
 *
 * Only some of them do, and which ones depends on the merod version — measured
 * against a live `merod:edge` in merobox CI, not assumed:
 *
 *   delete_namespace / delete_context
 *     core master → typed `403` carrying `MembershipError::NotAdmin`:
 *       "identity {id} is not an admin of group {group}"
 *     core 0.11.0-rc.28 → bare `500`, reason STRIPPED (see below)
 *
 *   delete_group → bare `500` on BOTH, reason stripped. It refuses with
 *     `CapabilitiesError::Unauthorized`, which `parse_api_error` classifies
 *     nowhere, because a subgroup delete does not go through `require_admin`
 *     at all: it admits the subgroup's owner, an admin of the namespace root,
 *     or a member holding `CAN_DELETE_SUBGROUP`.
 *
 * `parse_api_error` deliberately does not echo an unclassified error's message
 * back to the caller — it can carry store paths or key material — so the body
 * is literally `{"error":"Internal server error"}` and the reason exists only
 * in the node log. core master added `membership_refusal_status` to classify
 * the `MembershipError` family; `CapabilitiesError` has no equivalent yet, and
 * rc.28 (which the desktop bundles) has neither.
 *
 * So this returns true for the cases that self-describe, and
 * `isReasonlessRefusal` covers the rest. Both matter: the role read is only a
 * best guess — a `CAN_DELETE_SUBGROUP` holder who is not an admin CAN delete —
 * and these two are what catch the cases it gets wrong.
 */
export function isPermissionError(message: string | undefined | null): boolean {
  if (typeof message !== 'string') return false;
  return /is not an admin/i.test(message) || /lacks permission/i.test(message);
}

/**
 * Did the node refuse without saying why?
 *
 * On the merod the desktop bundles this is what EVERY refused delete looks
 * like, so a message that asserts a cause here would be a guess dressed as a
 * fact. Callers use it to name the likely fix ("if you are not an admin, use
 * Leave") without claiming to know that is what happened.
 */
export function isReasonlessRefusal(message: string | undefined | null): boolean {
  if (typeof message !== 'string') return false;
  // `parseApiError` renders core's body as "500: Internal server error", and
  // falls back to "500: 500" when there is no body at all.
  return (
    /internal server error/i.test(message) ||
    /^\s*5\d\d:\s*\d*\s*$/.test(message)
  );
}

/**
 * Does this failure mean "your membership here is inherited, there is no row
 * to remove"?
 *
 * `leave_group` publishes `MemberLeft` for a DIRECT membership row, and a
 * member who self-joined an Open subgroup through `join_subgroup_inheritance`
 * has none: the apply path for `MemberJoinedOpen` is validate-only and writes
 * no row. `list_group_members` nonetheless reports them — it unions the
 * inherited set in (core #2371) — so the role read above sees "Member",
 * offers Leave, and merod answers:
 *
 *   "this node is not a direct member of {group}; leave the parent group
 *    where the membership anchor lives instead"
 *
 * There is no field on the member entry that distinguishes the two, so this
 * cannot be predicted from the listing; it is recognised after the fact and
 * turned into the instruction merod is actually giving — leave the namespace.
 */
export function isInheritedMembershipError(
  message: string | undefined | null,
): boolean {
  return typeof message === 'string' && /not a direct member/i.test(message);
}

/**
 * `GET /admin-api/groups/:id/members`.
 *
 * A raw fetch rather than `mero.admin.listGroupMembers()` for the same reason
 * the namespace-root member list next to it is: the mero-react hook's parsing
 * of this route is still wrong (see the TODO in Namespaces.tsx). Both collapse
 * onto the SDK together once that is fixed.
 *
 * Resolves to `null` — never throws — when the node is unreachable, the token
 * is missing, or the response shape is unrecognised, so a caller cannot
 * mistake "couldn't tell" for "you have no role here".
 */
export async function fetchGroupMembers(
  groupId: string,
  signal?: AbortSignal,
): Promise<GroupMember[] | null> {
  const settings = getSettings();
  const token = getAccessToken();
  if (!settings.nodeUrl || !token) return null;
  try {
    const res = await fetch(
      `${settings.nodeUrl}/admin-api/groups/${encodeURIComponent(groupId)}/members`,
      { headers: { Authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}) },
    );
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return (extractMembersFromResponse(json) as GroupMember[] | null) ?? null;
  } catch {
    return null;
  }
}
