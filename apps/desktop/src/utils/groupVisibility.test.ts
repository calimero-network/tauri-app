import { describe, it, expect } from 'vitest';

import { groupVisibilityLabel } from './groupVisibility';

describe('groupVisibilityLabel', () => {
  it('shows an Open folder inside a private one as restricted', () => {
    expect(
      groupVisibilityLabel({ subgroupVisibility: 'open', effectiveVisibility: 'restricted' }),
    ).toEqual({
      value: 'restricted',
      hint: 'Its own setting is open, but a parent folder is restricted.',
    });
  });

  it('shows an Open folder on an Open chain as open', () => {
    expect(
      groupVisibilityLabel({ subgroupVisibility: 'open', effectiveVisibility: 'open' }),
    ).toEqual({ value: 'open' });
  });

  it('shows a Restricted folder as restricted', () => {
    expect(
      groupVisibilityLabel({ subgroupVisibility: 'restricted', effectiveVisibility: 'restricted' }),
    ).toEqual({ value: 'restricted' });
  });

  it('falls back to the own setting from a node that predates effectiveVisibility', () => {
    expect(groupVisibilityLabel({ subgroupVisibility: 'open' })).toEqual({ value: 'open' });
  });

  it('shows a dash when the node sends neither', () => {
    expect(groupVisibilityLabel({})).toEqual({ value: '—' });
  });
});
