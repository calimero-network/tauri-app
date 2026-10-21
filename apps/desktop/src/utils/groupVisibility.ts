/**
 * What the group page's Visibility stat shows.
 *
 * merod's group info carries two fields, and only one says whether a folder is
 * private:
 *
 *   • `subgroupVisibility` — how the group takes members: `open` inherits the
 *     parent's, `restricted` admits directly.
 *   • `effectiveVisibility` — who outside the group can reach it: `restricted`
 *     when this group or any group above it (short of the namespace root) is
 *     Restricted, `open` only on an Open chain to the namespace (core#4640).
 *
 * An Open folder inside a private one reads `open` in the first and is closed
 * to the rest of the namespace, so the stat shows the second. A node that
 * predates the field omits it, and the stat falls back to the group's own
 * setting there.
 */
export interface GroupVisibilityFields {
  subgroupVisibility?: string;
  effectiveVisibility?: string;
}

export interface GroupVisibilityLabel {
  /** What the stat shows. */
  value: string;
  /** Set when the group's own setting differs from what reaches it. */
  hint?: string;
}

export function groupVisibilityLabel(info: GroupVisibilityFields): GroupVisibilityLabel {
  const own = info.subgroupVisibility || undefined;
  const effective = info.effectiveVisibility || undefined;
  if (!effective) return { value: own ?? '—' };
  if (own && own !== effective) {
    return {
      value: effective,
      hint: `Its own setting is ${own}, but a parent folder is ${effective}.`,
    };
  }
  return { value: effective };
}
