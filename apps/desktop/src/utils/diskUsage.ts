/**
 * Per-namespace disk usage from the local node's `GET /admin-api/usage`.
 *
 * The body is bare (`{ namespaces: [...] }`): core serializes this route
 * without the `data` envelope most admin routes carry, and mero-js's
 * `getUsage()` returns it untyped and unwrapped. Both shapes are accepted so a
 * future envelope does not blank the sizes.
 *
 * Bytes are RocksDB estimates of state, private state, deltas and governance.
 * Blobs and application bytecode are shared across namespaces and are not in
 * any namespace's figure.
 */

export interface NamespaceBytes {
  state: number;
  privateState: number;
  delta: number;
  governance: number;
  total: number;
}

const FIELDS: (keyof NamespaceBytes)[] = ["state", "privateState", "delta", "governance", "total"];

/**
 * Namespace id (lowercase hex) → its bytes. A row with a missing or
 * non-numeric field is dropped rather than half-reported: a breakdown missing a
 * column reads as a real, smaller number.
 */
export function parseUsage(raw: unknown): Map<string, NamespaceBytes> {
  const out = new Map<string, NamespaceBytes>();
  const body = (raw as { data?: unknown })?.data ?? raw;
  const rows = (body as { namespaces?: unknown })?.namespaces;
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const id = typeof row?.namespaceId === "string" ? row.namespaceId.trim().toLowerCase() : "";
    const bytes = row?.bytes;
    if (!id || !bytes || typeof bytes !== "object") continue;
    if (!FIELDS.every((f) => Number.isFinite(bytes[f]) && bytes[f] >= 0)) continue;
    out.set(id, Object.fromEntries(FIELDS.map((f) => [f, Number(bytes[f])])) as unknown as NamespaceBytes);
  }
  return out;
}

/** Look one namespace up, tolerating id case. */
export function usageFor(usage: Map<string, NamespaceBytes> | null, namespaceId: string): NamespaceBytes | undefined {
  return usage?.get(namespaceId.trim().toLowerCase());
}

/**
 * Total bytes over `namespaceIds`, or `null` when none of them has a figure —
 * "not reported" and "empty" are different statements.
 */
export function sumUsage(usage: Map<string, NamespaceBytes> | null, namespaceIds: string[]): number | null {
  let total = 0;
  let found = false;
  for (const id of namespaceIds) {
    const b = usageFor(usage, id);
    if (b) {
      total += b.total;
      found = true;
    }
  }
  return found ? total : null;
}

/** Decimal units ("1.23 MB"), matching how the cloud plans state storage. */
export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, n);
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i += 1;
  }
  const digits = i === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  const text = value.toFixed(digits);
  return `${text.includes(".") ? text.replace(/\.?0+$/, "") : text} ${units[i]}`;
}

/** Tooltip text breaking a namespace's figure into its columns. */
export function describeBytes(b: NamespaceBytes): string {
  return [
    `Disk used on this node: ${formatBytes(b.total)} (estimate)`,
    `State ${formatBytes(b.state)} · Private ${formatBytes(b.privateState)}`,
    `History ${formatBytes(b.delta)} · Governance ${formatBytes(b.governance)}`,
    "Blobs and app code are shared and not counted per namespace.",
  ].join("\n");
}
