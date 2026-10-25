import { describe, it, expect } from 'vitest';
import type { ReplicaRelease, ReplicaState } from './cloudApi';
import { replicaReleaseRow, isUpdating } from './replicaRelease';

const INTENT = { id: 'i1', target_version: '2.0.0', state: 'active' };

function release(
  states: [ReplicaState, string | null][],
  over: Partial<ReplicaRelease> = {},
): ReplicaRelease {
  const replicas = states.map(([state, running_version], i) => ({
    peer_id: `p${i}`,
    running_version,
    state,
  }));
  return {
    target_version: '2.0.0',
    replicas,
    on_target: replicas.filter((r) => r.state === 'on_target').length,
    total: replicas.length,
    intent: null,
    ...over,
  };
}

describe('replicaReleaseRow', () => {
  it('shows nothing without a status', () => {
    expect(replicaReleaseRow(null)).toBeNull();
  });

  it('shows nothing without a target', () => {
    const r = release([['unknown', null]], { target_version: null });
    expect(replicaReleaseRow(r)).toBeNull();
  });

  it('shows nothing when every replica is on target and no update is active', () => {
    const r = release([['on_target', '2.0.0'], ['on_target', '2.0.0']]);
    expect(replicaReleaseRow(r)).toBeNull();
  });

  it('names the older version when the behind replicas agree', () => {
    const r = release([
      ['on_target', '2.0.0'],
      ['behind', '1.0.0'],
      ['behind', '1.0.0'],
    ]);
    expect(replicaReleaseRow(r)).toEqual({
      tone: 'behind',
      text: '1 of 3 replicas on 2.0.0 · 2 still run 1.0.0',
      action: 'Update replicas',
    });
  });

  it('uses singular wording for one replica behind', () => {
    const r = release([['behind', '1.0.0']]);
    expect(replicaReleaseRow(r)?.text).toBe(
      '0 of 1 replica on 2.0.0 · 1 still runs 1.0.0',
    );
  });

  it('only counts the behind total when versions vary', () => {
    const r = release([
      ['on_target', '2.0.0'],
      ['behind', '1.0.0'],
      ['queued', '1.5.0'],
    ]);
    expect(replicaReleaseRow(r)?.text).toBe('1 of 3 replicas on 2.0.0 · 2 behind');
  });

  it('counts a replica with no reported version as behind, not as a version', () => {
    const r = release([['behind', null], ['behind', '1.0.0']]);
    expect(replicaReleaseRow(r)?.text).toBe('0 of 2 replicas on 2.0.0 · 2 behind');
  });

  it('shows progress with no action while an update is active', () => {
    const r = release(
      [['on_target', '2.0.0'], ['switching', '1.0.0'], ['queued', '1.0.0']],
      { intent: INTENT },
    );
    expect(replicaReleaseRow(r)).toEqual({
      tone: 'updating',
      text: 'Updating replicas, one at a time: 1 of 3 on 2.0.0',
      action: null,
    });
  });

  it('keeps showing progress while an update is active and all replicas just landed', () => {
    const r = release([['on_target', '2.0.0']], { intent: INTENT });
    expect(replicaReleaseRow(r)?.tone).toBe('updating');
  });

  it('offers a retry when a replica failed', () => {
    const r = release([
      ['on_target', '2.0.0'],
      ['failed', '1.0.0'],
      ['behind', '1.0.0'],
    ]);
    expect(replicaReleaseRow(r)).toEqual({
      tone: 'failed',
      text: '1 of 3 replicas on 2.0.0 · 1 failed to update',
      action: 'Retry update',
    });
  });

  it('pluralizes failures and wins over an active update', () => {
    const r = release([['failed', '1.0.0'], ['failed', '1.0.0']], {
      intent: INTENT,
    });
    expect(replicaReleaseRow(r)).toEqual({
      tone: 'failed',
      text: '0 of 2 replicas on 2.0.0 · 2 failed to update',
      action: 'Retry update',
    });
  });
});

describe('isUpdating', () => {
  it('is true only for the updating tone', () => {
    expect(isUpdating(release([['behind', '1.0.0']], { intent: INTENT }))).toBe(true);
    expect(isUpdating(release([['behind', '1.0.0']]))).toBe(false);
    expect(isUpdating(release([['failed', '1.0.0']], { intent: INTENT }))).toBe(false);
    expect(isUpdating(null)).toBe(false);
  });
});
