import type { ReplicaRelease, ReplicaState } from './cloudApi';

export interface ReplicaReleaseRow {
  tone: 'behind' | 'updating' | 'failed';
  text: string;
  action: 'Update replicas' | 'Retry update' | null;
}

// Replica states that still have to move to the target.
const NOT_ON_TARGET: ReplicaState[] = ['behind', 'queued', 'switching', 'failed'];

const noun = (n: number) => (n === 1 ? 'replica' : 'replicas');

/** What a namespace row's release sub-line shows; `null` shows nothing. */
export function replicaReleaseRow(
  status: ReplicaRelease | null,
): ReplicaReleaseRow | null {
  if (!status?.target_version) return null;

  const { target_version: target, on_target: onTarget, total, intent } = status;
  const behind = status.replicas.filter((r) => NOT_ON_TARGET.includes(r.state));
  const failed = behind.filter((r) => r.state === 'failed').length;

  if (failed === 0 && intent) {
    return {
      tone: 'updating',
      text: `Updating replicas, one at a time: ${onTarget} of ${total} on ${target}`,
      action: null,
    };
  }
  if (behind.length === 0) return null;

  const counts = `${onTarget} of ${total} ${noun(total)} on ${target}`;
  if (failed > 0) {
    return {
      tone: 'failed',
      text: `${counts} · ${failed} failed to update`,
      action: 'Retry update',
    };
  }

  const older = new Set(behind.map((r) => r.running_version));
  const tail =
    older.size === 1 && !older.has(null)
      ? `${behind.length} still ${behind.length === 1 ? 'runs' : 'run'} ${[...older][0]}`
      : `${behind.length} behind`;
  return { tone: 'behind', text: `${counts} · ${tail}`, action: 'Update replicas' };
}

export const isUpdating = (status: ReplicaRelease | null): boolean =>
  replicaReleaseRow(status)?.tone === 'updating';
