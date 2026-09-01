import { describe, it, expect } from 'vitest';

import {
  isAdminRole,
  isInheritedMembershipError,
  isPermissionError,
  isReasonlessRefusal,
  resolveGroupAction,
  roleOf,
} from './groupRoles';

// The account this node writes as. 64 hex since rc.27 — same length and
// alphabet as a device key, which is exactly why matching the wrong one
// fails silently rather than throwing.
const ME = 'a'.repeat(64);
const SOMEONE_ELSE = 'b'.repeat(64);

describe('roleOf', () => {
  it('finds our role by account', () => {
    expect(
      roleOf(
        [
          { identity: SOMEONE_ELSE, role: 'Admin' },
          { identity: ME, role: 'Member' },
        ],
        ME,
      ),
    ).toBe('Member');
  });

  it('is undefined when no row names us — not "member"', () => {
    expect(roleOf([{ identity: SOMEONE_ELSE, role: 'Admin' }], ME)).toBeUndefined();
  });

  it('is undefined when the account has not resolved yet', () => {
    expect(roleOf([{ identity: ME, role: 'Admin' }], undefined)).toBeUndefined();
  });

  it('is undefined when the fetch could not tell (null members)', () => {
    expect(roleOf(null, ME)).toBeUndefined();
    expect(roleOf(undefined, ME)).toBeUndefined();
  });

  it('ignores a row whose role is not a string', () => {
    expect(roleOf([{ identity: ME, role: 7 as unknown as string }], ME)).toBeUndefined();
  });
});

describe('isAdminRole', () => {
  it('matches core’s serialisation and is case-insensitive', () => {
    expect(isAdminRole('Admin')).toBe(true);
    expect(isAdminRole('admin')).toBe(true);
  });

  it('rejects every other role core can send', () => {
    for (const role of ['Member', 'Observer', 'ReadOnlyTee', '', undefined]) {
      expect(isAdminRole(role)).toBe(false);
    }
  });
});

describe('resolveGroupAction', () => {
  it('offers Leave only when we POSITIVELY know we are a non-admin member', () => {
    expect(resolveGroupAction({ accountId: ME, role: 'Member' })).toBe('leave');
    expect(resolveGroupAction({ accountId: ME, role: 'Observer' })).toBe('leave');
    expect(resolveGroupAction({ accountId: ME, role: 'ReadOnlyTee' })).toBe('leave');
  });

  it('offers Delete to an admin', () => {
    expect(resolveGroupAction({ accountId: ME, role: 'Admin' })).toBe('delete');
  });

  // The indeterminate window must not flip the button: merod still enforces
  // admin-ship, so keeping Delete costs at most the error toast that was
  // already there, whereas guessing Leave would offer a DIFFERENT operation
  // (a self-removal) to somebody who asked to tear the group down.
  it('keeps Delete while the member list is still loading', () => {
    expect(resolveGroupAction({ loading: true, accountId: ME, role: 'Member' })).toBe('delete');
  });

  it('keeps Delete before our account resolves', () => {
    expect(resolveGroupAction({ accountId: undefined, role: 'Member' })).toBe('delete');
  });

  it('keeps Delete when no row names us', () => {
    expect(resolveGroupAction({ accountId: ME, role: undefined })).toBe('delete');
  });
});

describe('isPermissionError', () => {
  // delete_namespace / delete_context, verbatim from
  // crates/governance-store/src/errors.rs (MembershipError::NotAdmin).
  it('matches the NotAdmin render', () => {
    expect(
      isPermissionError(`identity ${ME} is not an admin of group 0xabc`),
    ).toBe(true);
  });

  // delete_group takes a DIFFERENT path — the subgroup's owner, a root admin,
  // or CAN_DELETE_SUBGROUP — and so refuses with CapabilitiesError::Unauthorized
  // wrapped by crates/context/src/handlers/delete_group.rs. A matcher that only
  // knew the NotAdmin wording would report this one as a node fault.
  it('matches delete_group’s wrapped Unauthorized', () => {
    expect(
      isPermissionError(
        "deleting subgroup '0xabc': requester lacks permission to delete subgroup " +
          '(CAN_DELETE_SUBGROUP) in group 0xabc (or be its owner)',
      ),
    ).toBe(true);
  });

  it('matches through the HTTP status prefix parseApiError adds', () => {
    expect(isPermissionError('500: identity … is not an admin of group …')).toBe(true);
  });

  it('does not claim unrelated failures are a permission problem', () => {
    expect(isPermissionError('500: group not found')).toBe(false);
    expect(isPermissionError('Failed to fetch')).toBe(false);
    expect(isPermissionError('cannot remove the last admin of the group')).toBe(false);
    expect(isPermissionError(undefined)).toBe(false);
    expect(isPermissionError(null)).toBe(false);
  });
});

describe('isInheritedMembershipError', () => {
  // crates/context/src/handlers/leave_group.rs — the refusal a member who
  // joined an Open subgroup by inheritance gets, even though
  // `list_group_members` reported them with a role.
  it('recognises the no-direct-row refusal', () => {
    expect(
      isInheritedMembershipError(
        "this node is not a direct member of ContextGroupId(0xabc); leave the " +
          'parent group where the membership anchor lives instead',
      ),
    ).toBe(true);
  });

  it('does not fire on a permission refusal', () => {
    expect(
      isInheritedMembershipError(`identity ${ME} is not an admin of group 0xabc`),
    ).toBe(false);
    expect(isInheritedMembershipError('Failed to fetch')).toBe(false);
    expect(isInheritedMembershipError(null)).toBe(false);
  });
});

describe('isReasonlessRefusal', () => {
  // What core sends when `parse_api_error` classifies the error nowhere: it
  // deliberately does not echo an unclassified message back (it can carry
  // store paths or key material), so the body is `{"error":"Internal server
  // error"}`. On 0.11.0-rc.28 — the merod this app bundles — that is EVERY
  // refused delete; on master it is still every `delete_group`.
  it('recognises core’s reason-stripped refusal', () => {
    expect(isReasonlessRefusal('500: Internal server error')).toBe(true);
    expect(isReasonlessRefusal('Internal server error')).toBe(true);
  });

  it('recognises a failure with no body at all', () => {
    expect(isReasonlessRefusal('500: 500')).toBe(true);
    expect(isReasonlessRefusal('503:')).toBe(true);
  });

  it('does not swallow a refusal that DID say why', () => {
    expect(
      isReasonlessRefusal(`403: identity ${ME} is not an admin of group 0xabc`),
    ).toBe(false);
    expect(isReasonlessRefusal('500: namespace not found')).toBe(false);
    expect(isReasonlessRefusal('Failed to fetch')).toBe(false);
    expect(isReasonlessRefusal(undefined)).toBe(false);
  });

  // The two matchers must not both claim the same message: `isPermissionError`
  // asserts a cause, `isReasonlessRefusal` explicitly declines to.
  it('is disjoint from isPermissionError', () => {
    for (const m of [
      `identity ${ME} is not an admin of group 0xabc`,
      '500: Internal server error',
      '500: namespace not found',
    ]) {
      expect(isPermissionError(m) && isReasonlessRefusal(m)).toBe(false);
    }
  });
});
