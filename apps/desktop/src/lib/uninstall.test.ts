import { describe, it, expect } from 'vitest';
import { describeStep, isBlocked, planNamespace, type AppNamespace, type UninstallChoice } from './uninstall';

const joined: AppNamespace = { id: 'ns-joined', name: 'Team', role: 'Member', others: 3 };
const ownedAlone: AppNamespace = { id: 'ns-alone', name: 'Notes', role: 'Admin', others: 0 };
const ownedShared: AppNamespace = { id: 'ns-shared', name: 'Family', role: 'Admin', others: 2 };

function choice(overrides: Partial<UninstallChoice> = {}): UninstallChoice {
  return { deleteData: true, leave: true, deleteForEveryone: new Set(), linkedDevice: false, ...overrides };
}

describe('what an uninstall does to each namespace', () => {
  it('leaves a joined namespace when deleting and leaving', () => {
    expect(planNamespace(joined, choice())).toBe('leave');
  });

  it('deletes an owned namespace nobody else is in, without asking', () => {
    expect(planNamespace(ownedAlone, choice())).toBe('delete-for-everyone');
  });

  it('blocks an owned namespace others are in until ownership moves', () => {
    expect(planNamespace(ownedShared, choice())).toBe('needs-transfer');
  });

  it('deletes an owned namespace for everyone once the user confirmed it', () => {
    expect(planNamespace(ownedShared, choice({ deleteForEveryone: new Set(['ns-shared']) }))).toBe(
      'delete-for-everyone',
    );
  });

  it('removes every namespace from this device only when not leaving, whatever the role', () => {
    for (const ns of [joined, ownedAlone, ownedShared]) {
      expect(planNamespace(ns, choice({ leave: false }))).toBe('remove');
    }
  });

  it('touches nothing when the data is kept, even with leave still ticked', () => {
    for (const ns of [joined, ownedAlone, ownedShared]) {
      expect(planNamespace(ns, choice({ deleteData: false }))).toBe('keep');
    }
  });

  it('treats a namespace whose member list did not name us as joined', () => {
    expect(planNamespace({ ...joined, role: undefined }, choice())).toBe('leave');
  });
});

describe('on a linked device', () => {
  const linked = (overrides: Partial<UninstallChoice> = {}) => choice({ linkedDevice: true, ...overrides });

  it('does not attempt an owner-only delete, even for the only member', () => {
    expect(planNamespace(ownedAlone, linked())).toBe('needs-primary-device');
  });

  it('does not attempt a confirmed delete for everyone', () => {
    expect(planNamespace(ownedShared, linked({ deleteForEveryone: new Set(['ns-shared']) }))).toBe(
      'needs-primary-device',
    );
  });

  it('still leaves a joined namespace, which needs no root', () => {
    expect(planNamespace(joined, linked())).toBe('leave');
  });

  it('removes an owned namespace from this device once leave is unticked', () => {
    expect(planNamespace(ownedShared, linked({ leave: false }))).toBe('remove');
  });
});

describe('the uninstall can go ahead', () => {
  it('only when no namespace waits on the user', () => {
    expect(isBlocked(['leave', 'remove', 'delete-for-everyone', 'keep'])).toBe(false);
    expect(isBlocked(['leave', 'needs-transfer'])).toBe(true);
    expect(isBlocked(['needs-primary-device'])).toBe(true);
  });
});

describe('the line each namespace gets', () => {
  it('names the namespace and what happens to it', () => {
    expect(describeStep(joined, 'leave')).toBe('Team: you leave it, and all your devices remove it');
    expect(describeStep(joined, 'remove')).toBe('Team: removed from this device; you stay a member');
    expect(describeStep(joined, 'keep')).toBe('Team: kept on this device');
    expect(describeStep(ownedAlone, 'delete-for-everyone')).toBe('Notes: deleted; you are its only member');
    expect(describeStep(ownedShared, 'delete-for-everyone')).toBe('Family: deleted for all 3 members');
    expect(describeStep(ownedShared, 'needs-transfer')).toBe(
      'Family: you own it and 2 others are members; transfer ownership first',
    );
    expect(describeStep(ownedAlone, 'needs-primary-device')).toBe(
      'Notes: only your primary device can delete it',
    );
  });

  it('counts a single other member in the singular', () => {
    expect(describeStep({ ...ownedShared, others: 1 }, 'needs-transfer')).toBe(
      'Family: you own it and 1 other is a member; transfer ownership first',
    );
    expect(describeStep({ ...ownedShared, others: 1 }, 'delete-for-everyone')).toBe(
      'Family: deleted for both members',
    );
  });
});
