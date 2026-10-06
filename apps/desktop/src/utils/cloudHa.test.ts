import { describe, it, expect } from 'vitest';

import { enableableIds, filterGroups, groupForCloud } from './cloudHa';
import type { InstalledApp } from './namespaceApps';

const app = (id: string, name: string, pkg: string): InstalledApp => ({
  id,
  name,
  package: pkg,
  version: '1.0.0',
  icon: null,
  frontendUrl: null,
  installed: true,
});

const APPS: Record<string, InstalledApp> = {
  chat: app('chat', 'Chat', 'com.calimero.chat'),
  docs: app('docs', 'Docs', 'com.calimero.docs'),
};

const NAMESPACES = [
  { namespaceId: 'ns-trip', targetApplicationId: 'chat', name: 'Weekend trip', memberCount: 4 },
  { namespaceId: 'ns-design', targetApplicationId: 'chat', name: 'Design team', memberCount: 8 },
  { namespaceId: 'ns-board', targetApplicationId: 'docs', name: 'Board notes' },
  { namespaceId: 'ns-q4', targetApplicationId: 'docs', name: 'Q4 planning' },
  { namespaceId: 'ns-orphan-0000000000000000', targetApplicationId: 'gone' },
];

const ROLES: Record<string, string | undefined> = {
  'ns-trip': 'Admin',
  'ns-design': 'Admin',
  'ns-board': 'Member',
  'ns-q4': 'Admin',
};

const HA = { 'ns-design': true, 'ns-board': true };

describe('groupForCloud', () => {
  const groups = groupForCloud(NAMESPACES, APPS, ROLES, HA);

  it('groups namespaces under their application, sorted by name', () => {
    expect(groups.map((g) => g.app?.name ?? g.applicationId)).toEqual(['Chat', 'Docs', 'gone']);
    expect(groups[0].rows.map((r) => r.name)).toEqual(['Design team', 'Weekend trip']);
  });

  it('counts only the namespaces this node administers', () => {
    const docs = groups.find((g) => g.applicationId === 'docs')!;
    // Board notes is on, but someone else administers it.
    expect(docs.manageable).toBe(1);
    expect(docs.manageableOn).toBe(0);
    const chat = groups.find((g) => g.applicationId === 'chat')!;
    expect(chat.manageable).toBe(2);
    expect(chat.manageableOn).toBe(1);
  });

  it('tells a role still loading apart from one that is not Admin', () => {
    const orphan = groups.find((g) => g.applicationId === 'gone')!.rows[0];
    expect(orphan.canManage).toBeNull();
    const board = groups.find((g) => g.applicationId === 'docs')!.rows[0];
    expect(board.canManage).toBe(false);
  });

  it('falls back to a shortened id when there is no name to show', () => {
    const orphan = groups.find((g) => g.applicationId === 'gone')!.rows[0];
    expect(orphan.name).toBe('ns-orpha…00000000');
    expect(orphan.memberCount).toBeNull();
  });

  it('names a namespace without its own name after its application', () => {
    const [g] = groupForCloud([{ namespaceId: 'x', targetApplicationId: 'chat' }], APPS, {}, {});
    expect(g.rows[0].name).toBe('Chat');
  });
});

describe('filterGroups', () => {
  const groups = groupForCloud(NAMESPACES, APPS, ROLES, HA);

  it('keeps only namespaces that could be turned on for "off"', () => {
    const ids = filterGroups(groups, 'off', '').flatMap((g) => g.rows.map((r) => r.namespaceId));
    expect(ids).toEqual(['ns-trip', 'ns-q4']);
  });

  it('keeps only namespaces someone else administers for "shared"', () => {
    const ids = filterGroups(groups, 'shared', '').flatMap((g) => g.rows.map((r) => r.namespaceId));
    expect(ids).toEqual(['ns-board']);
  });

  it('matches a search on the namespace name', () => {
    const out = filterGroups(groups, 'all', 'design');
    expect(out).toHaveLength(1);
    expect(out[0].rows.map((r) => r.name)).toEqual(['Design team']);
  });

  it('keeps every namespace of an application the search names', () => {
    const out = filterGroups(groups, 'all', 'calimero.docs');
    expect(out.map((g) => g.applicationId)).toEqual(['docs']);
    expect(out[0].rows).toHaveLength(2);
  });

  it('drops groups left empty', () => {
    expect(filterGroups(groups, 'all', 'nothing matches this')).toEqual([]);
  });
});

describe('enableableIds', () => {
  it('lists administered namespaces with HA off', () => {
    expect(enableableIds(groupForCloud(NAMESPACES, APPS, ROLES, HA))).toEqual(['ns-trip', 'ns-q4']);
  });
});
