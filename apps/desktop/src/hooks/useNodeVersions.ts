import { useEffect, useState } from "react";
import { listInstalledMerodVersions } from "../utils/merodVersions";

export interface NodeVersionMap {
  /** node name -> version id it is pinned to */
  byNode: Record<string, string>;
  /** version id -> what that binary reports now (local builds only) */
  measured: Record<string, string>;
  /** nodes whose binary now reports a different version than at creation */
  drifted: Set<string>;
}

const EMPTY: NodeVersionMap = { byNode: {}, measured: {}, drifted: new Set() };

/**
 * Which merod build each node runs. Three surfaces need this, so it lives in one
 * place; `deps` lets a caller refetch when its own node list changes.
 */
export function useNodeVersions(enabled: boolean, homeDir?: string, deps: unknown[] = []): NodeVersionMap {
  const [state, setState] = useState<NodeVersionMap>(EMPTY);

  useEffect(() => {
    if (!enabled) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;
    listInstalledMerodVersions(homeDir)
      .then((installed) => {
        if (cancelled) return;
        const byNode: Record<string, string> = {};
        const measured: Record<string, string> = {};
        const drifted = new Set<string>();
        for (const entry of installed) {
          for (const node of entry.used_by) byNode[node] = entry.id;
          if (entry.measured_version) measured[entry.id] = entry.measured_version;
          for (const node of entry.drifted_nodes) drifted.add(node);
        }
        setState({ byNode, measured, drifted });
      })
      .catch(() => {
        if (!cancelled) setState(EMPTY);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, homeDir, ...deps]);

  return state;
}
