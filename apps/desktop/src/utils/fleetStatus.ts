// What the cloud knows about the fleet nodes assigned to a namespace, read off
// `GET /api/cloud/me/namespaces/{ns}/relays`, and how to say it to the owner.
//
// The useful part is `join`: the fleet node's own report of its latest attempt
// to get in, with each admitter it asked directly and that admitter's reason.
// Admission is refused peer to peer, so before this the owner saw only
// "assigned" and the reason sat in a node log. The motivating case: a node an
// HA disable had removed, refused forever with "identity … was removed from
// group … and cannot rejoin; an admin must re-add them".
//
// Pure and DOM-free so it runs under the repo's node-env vitest.

/** One admitter that declined, in its own words. */
export interface FleetJoinRefusal {
  peer: string;
  reason: string;
}

/** A fleet node's account of its latest join attempt, or what an older cloud leaves out. */
export interface FleetJoinReport {
  state: string;
  attempts: number;
  refusals: FleetJoinRefusal[];
  error: string | null;
  reportedAt: string | null;
}

/** One fleet node assigned to a namespace, as far as this page needs it. */
export interface FleetRelayStatus {
  peerId: string;
  /** `assigned` (not in yet) or `active`. */
  status: string;
  /** The cloud's verdict: `confirmed`, `pending`, `refused`, `absent`; `null` from an older cloud. */
  admission: string | null;
  admissionHint: string | null;
  join: FleetJoinReport | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function joinOf(raw: unknown): FleetJoinReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const j = raw as Record<string, unknown>;
  const state = str(j.state);
  if (!state) return null;
  const refusals = Array.isArray(j.refusals)
    ? j.refusals
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map((r) => ({ peer: String(r.peer ?? ''), reason: String(r.reason ?? '') }))
    : [];
  return {
    state,
    attempts: typeof j.attempts === 'number' ? j.attempts : 0,
    refusals,
    error: str(j.error),
    reportedAt: str(j.reported_at),
  };
}

/** The relay rows of a `/relays` body; anything unrecognised is skipped, never thrown on. */
export function parseFleetRelays(body: unknown): FleetRelayStatus[] {
  const rows = (body as { relays?: unknown } | null)?.relays;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      peerId: String(r.peer_id ?? ''),
      status: String(r.status ?? ''),
      admission: str(r.admission),
      admissionHint: str(r.admission_hint),
      join: joinOf(r.join),
    }));
}

/**
 * The identity a refusal says was removed from the namespace, or `null`.
 *
 * Matches core's `RemovedFromGroup` wording. Only a key the owner can act on:
 * re-adding it (`MemberAdded`) is the one thing that lifts a removal.
 */
export function removedIdentityFromReason(reason: string): string | null {
  const m = /identity ([0-9a-f]{64}) was removed from group/i.exec(reason);
  return m ? m[1].toLowerCase() : null;
}

/** How one fleet node's state reads to the owner. */
export interface FleetStatusLine {
  tone: 'ok' | 'pending' | 'error';
  text: string;
  /** The admitters' reasons (or the attempt's error), verbatim. */
  details: string[];
  /** Set when the node was refused for having been removed: the owner can re-add it. */
  removedIdentity: string | null;
}

export function describeFleetRelay(relay: FleetRelayStatus): FleetStatusLine {
  const join = relay.join;
  if (relay.status === 'active' || relay.admission === 'confirmed') {
    return { tone: 'ok', text: 'Replicating', details: [], removedIdentity: null };
  }
  const tries = join && join.attempts > 1 ? ` (attempt ${join.attempts})` : '';
  if (join?.state === 'refused') {
    const removed = join.refusals
      .map((r) => removedIdentityFromReason(r.reason))
      .find((id): id is string => id !== null);
    return {
      tone: 'error',
      text: removed
        ? `Refused: this node was removed from the namespace${tries}`
        : `Refused by the namespace's admitters${tries}`,
      details: join.refusals.map((r) => r.reason),
      removedIdentity: removed ?? null,
    };
  }
  if (join?.state === 'error') {
    return {
      tone: 'error',
      text: `Join attempt failed${tries}`,
      details: join.error ? [join.error] : [],
      removedIdentity: null,
    };
  }
  if (join?.state === 'admitted') {
    return { tone: 'pending', text: 'Admitted; receiving keys and state', details: [], removedIdentity: null };
  }
  if (relay.admission === 'refused') {
    // The cloud inferred it (alive, trying, still out) but the node sent no reason.
    return {
      tone: 'error',
      text: `Not admitted yet${tries}`,
      details: relay.admissionHint ? [relay.admissionHint] : [],
      removedIdentity: null,
    };
  }
  if (relay.admission === 'absent') {
    return {
      tone: 'error',
      text: 'Not responding',
      details: relay.admissionHint ? [relay.admissionHint] : [],
      removedIdentity: null,
    };
  }
  return { tone: 'pending', text: `Joining${tries}`, details: [], removedIdentity: null };
}
