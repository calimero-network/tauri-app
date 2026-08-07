import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { listInstalledMerodVersions } from "../utils/merodVersions";
import { getMerodBinaryVersion } from "../utils/merod";
import { getSettings } from "../utils/settings";
import { useMerodStatusChanged } from "../hooks/useMerodStatusChanged";

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
  /** Re-read the map, against `homeDir` when the caller holds an unsaved one. */
  refresh: (homeDir?: string) => void;
}

type NodeMaps = Omit<NodeVersionMap, "bundled">;
const EMPTY: NodeMaps = { byNode: {}, measured: {}, drifted: new Set() };

const NodeVersionsContext = createContext<NodeVersions | undefined>(undefined);

/** One read of the merod version map for the whole app. */
export function NodeVersionsProvider({ children }: { children: ReactNode }) {
  const [maps, setMaps] = useState<NodeMaps>(EMPTY);
  const [bundled, setBundled] = useState("");
  const [override, setOverride] = useState<string>();
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback((homeDir?: string) => {
    // An empty or blank field is "no override", not a real directory.
    setOverride(homeDir?.trim() ? homeDir : undefined);
    setNonce((n) => n + 1);
  }, []);

  // Node creation/deletion changes which nodes each version is pinned to; the
  // per-page hooks this provider replaced refetched via their deps arrays.
  // Keeps any caller-set override, unlike refresh().
  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  useMerodStatusChanged(refetch);

  useEffect(() => {
    getMerodBinaryVersion().then(setBundled).catch(() => setBundled(""));
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Settings are read per fetch, not snapshotted at mount: onboarding writes
    // the data dir afterwards and completes without reloading the window.
    listInstalledMerodVersions(override ?? getSettings().embeddedNodeDataDir)
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
  }, [override, nonce]);

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
