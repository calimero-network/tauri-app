import { describe, expect, it } from 'vitest';

import { describeFleetRelay, parseFleetRelays, removedIdentityFromReason } from './fleetStatus';

const KEY = 'd8c51285dd3346e81ca7cf7f2a7a49573507d842527a5d233232e30b665566ea';
const REMOVED = `identity ${KEY} was removed from group b42f4ad2e12ab9c212ca14330389b0b52e803d95df765dfa0c12ef284342fc98 and cannot rejoin; an admin must re-add them`;

const row = (over: Record<string, unknown> = {}) => ({
  peer_id: '12D3KooWfleet',
  status: 'assigned',
  admission: 'pending',
  admission_hint: 'Assigned; the node is attempting to join.',
  ...over,
});

describe('parseFleetRelays', () => {
  it('reads the join report the fleet node sent', () => {
    const [r] = parseFleetRelays({
      relays: [
        row({
          admission: 'refused',
          join: { state: 'refused', attempts: 4, refusals: [{ peer: '12D3KooWowner', reason: REMOVED }], error: null, reported_at: '2026-10-06T02:58:25' },
        }),
      ],
    });
    expect(r.join).toEqual({
      state: 'refused',
      attempts: 4,
      refusals: [{ peer: '12D3KooWowner', reason: REMOVED }],
      error: null,
      reportedAt: '2026-10-06T02:58:25',
    });
  });

  it('leaves join null for an older cloud or a malformed report, and never throws', () => {
    const rows = parseFleetRelays({ relays: [row(), row({ join: 'x' }), row({ join: { attempts: 1 } }), null, 7] });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.join === null)).toBe(true);
    expect(parseFleetRelays(null)).toEqual([]);
    expect(parseFleetRelays({ relays: 'no' })).toEqual([]);
  });
});

describe('removedIdentityFromReason', () => {
  it("pulls the key out of core's removal refusal", () => {
    expect(removedIdentityFromReason(REMOVED)).toBe(KEY);
  });

  it('ignores any other refusal', () => {
    expect(removedIdentityFromReason('MRTD not in policy allowlist')).toBeNull();
    // A truncated key is not something to re-add.
    expect(removedIdentityFromReason('identity d8c5 was removed from group x')).toBeNull();
  });
});

describe('describeFleetRelay', () => {
  it('offers a re-add for a node refused because it was removed', () => {
    const [r] = parseFleetRelays({
      relays: [row({ join: { state: 'refused', attempts: 3, refusals: [{ peer: 'p', reason: REMOVED }] } })],
    });
    const line = describeFleetRelay(r);
    expect(line.tone).toBe('error');
    expect(line.text).toContain('removed');
    expect(line.text).toContain('attempt 3');
    expect(line.details).toEqual([REMOVED]);
    expect(line.removedIdentity).toBe(KEY);
  });

  it('shows any other refusal verbatim, with nothing to re-add', () => {
    const [r] = parseFleetRelays({
      relays: [row({ join: { state: 'refused', attempts: 1, refusals: [{ peer: 'p', reason: 'TCB status not in policy allowlist' }] } })],
    });
    const line = describeFleetRelay(r);
    expect(line.details).toEqual(['TCB status not in policy allowlist']);
    expect(line.removedIdentity).toBeNull();
  });

  it('reads an active node as replicating, whatever it last reported', () => {
    const [r] = parseFleetRelays({
      relays: [row({ status: 'active', admission: 'confirmed', join: { state: 'refused', refusals: [{ peer: 'p', reason: REMOVED }] } })],
    });
    expect(describeFleetRelay(r)).toMatchObject({ tone: 'ok', removedIdentity: null });
  });

  it("falls back to the cloud's own verdict when the node sent no report", () => {
    const [refused, absent, pending] = parseFleetRelays({
      relays: [row({ admission: 'refused', admission_hint: 'check the owner log' }), row({ admission: 'absent' }), row()],
    });
    expect(describeFleetRelay(refused)).toMatchObject({ tone: 'error', details: ['check the owner log'] });
    expect(describeFleetRelay(absent).text).toBe('Not responding');
    expect(describeFleetRelay(pending)).toMatchObject({ tone: 'pending', text: 'Joining' });
  });

  it('distinguishes an admitter that said yes from one still waiting', () => {
    const [admitted, failed] = parseFleetRelays({
      relays: [
        row({ join: { state: 'admitted', attempts: 1, refusals: [] } }),
        row({ join: { state: 'error', attempts: 2, refusals: [], error: 'fleet-join failed: timed out after 90s' } }),
      ],
    });
    expect(describeFleetRelay(admitted).text).toContain('Admitted');
    expect(describeFleetRelay(failed)).toMatchObject({ tone: 'error', details: ['fleet-join failed: timed out after 90s'] });
  });
});
