/**
 * Time window the node logs viewer shows. `tail` is the default "latest N
 * lines" view; the others read the node's whole retained history and keep only
 * lines whose timestamp falls in the window.
 */
export type LogTimeRange =
  | { kind: "tail" }
  | { kind: "relative"; minutes: number }
  /** `from`/`to` are `<input type="datetime-local">` values in local time; either may be empty. */
  | { kind: "custom"; from: string; to: string };

export const RELATIVE_RANGES: { minutes: number; label: string }[] = [
  { minutes: 15, label: "Last 15 minutes" },
  { minutes: 60, label: "Last hour" },
  { minutes: 6 * 60, label: "Last 6 hours" },
  { minutes: 24 * 60, label: "Last 24 hours" },
  { minutes: 7 * 24 * 60, label: "Last 7 days" },
];

/** Unix-millisecond bounds for a range, or null for the plain tail. */
export interface ResolvedLogRange {
  fromMs?: number;
  toMs?: number;
}

/**
 * Turn a range into absolute bounds. Relative ranges resolve against `now`, so
 * a Refresh slides the window forward. Throws on an unparseable or inverted
 * custom range, with a message fit for the user.
 */
export function resolveLogTimeRange(
  range: LogTimeRange,
  now: number = Date.now()
): ResolvedLogRange | null {
  switch (range.kind) {
    case "tail":
      return null;
    case "relative":
      return { fromMs: now - range.minutes * 60_000 };
    case "custom": {
      const fromMs = parseLocal(range.from, "start");
      // datetime-local has minute precision: make the end inclusive of that minute.
      const toBase = parseLocal(range.to, "end");
      const toMs = toBase === undefined ? undefined : toBase + 59_999;
      if (fromMs === undefined && toMs === undefined) {
        throw new Error("Pick a start or end time for the custom range");
      }
      if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
        throw new Error("The start of the time range is after its end");
      }
      return { fromMs, toMs };
    }
  }
}

function parseLocal(value: string, which: string): number | undefined {
  if (!value) return undefined;
  // A datetime-local value has no offset, so Date parses it as local time.
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) throw new Error(`Invalid ${which} time`);
  return ms;
}

/** Value for an `<input type="datetime-local">` showing `ms` in local time. */
export function toDateTimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
