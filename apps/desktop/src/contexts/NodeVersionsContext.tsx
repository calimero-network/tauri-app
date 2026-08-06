import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { listInstalledMerodVersions } from "../utils/merodVersions";
import { getMerodBinaryVersion } from "../utils/merod";
import { getSettings } from "../utils/settings";

export interface NodeVersionMap {
  /** node name -> version id it is pinned to */
  byNode: Record<string, string>;
  /** version id -> what that binary reports now (local builds only) */
  measured: Record<string, string>;
  /** nodes whose binary now reports a different version than at creation */
  drifted: Set<string>;
  /** what the shipped binary reports, for labelling the bundled id */
  bundled: string;
}

interface NodeVersions extends NodeVersionMap {
  /** Re-read the map, optionally against another data dir. */
  refresh: (homeDir?: string) => void;
}

type NodeMaps = Omit<NodeVersionMap, "bundled">;
const EMPTY: NodeMaps = { byNode: {}, measured: {}, drifted: new Set() };

const NodeVersionsContext = createContext<NodeVersions | undefined>(undefined);

/**
 * Which merod build each node runs, read once for the whole app: the header,
 * the Applications table and the Nodes page each used to invoke the same two
 * commands for identical data. Not gated on developer mode - it is two invokes
 * per launch either way, and gating left every label stale until a reload when
 * the toggle flipped.
 */
export function NodeVersionsProvider({ children }: { children: ReactNode }) {
  const [maps, setMaps] = useState<NodeMaps>(EMPTY);
  const [bundled, setBundled] = useState("");
  const [dir, setDir] = useState<string | undefined>(() => getSettings().embeddedNodeDataDir);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback((homeDir?: string) => {
    if (homeDir !== undefined) setDir(homeDir);
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    getMerodBinaryVersion().then(setBundled).catch(() => setBundled(""));
  }, []);

  useEffect(() => {
    let cancelled = false;
    listInstalledMerodVersions(dir)
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
        setMaps({ byNode, measured, drifted });
      })
      .catch(() => {
        if (!cancelled) setMaps(EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, [dir, nonce]);

  const value = useMemo<NodeVersions>(
    () => ({ ...maps, bundled, refresh }),
    [maps, bundled, refresh]
  );

  return <NodeVersionsContext.Provider value={value}>{children}</NodeVersionsContext.Provider>;
}

export function useNodeVersions(): NodeVersions {
  const context = useContext(NodeVersionsContext);
  if (context === undefined) {
    throw new Error("useNodeVersions must be used within a NodeVersionsProvider");
  }
  return context;
}
