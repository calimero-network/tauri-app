import { useEffect, useState } from "react";
import {
  listInstalledMerodVersions,
  removeMerodVersion,
  formatVersionLabel,
  type InstalledVersion,
  LOCAL_ID_PREFIX,
} from "../utils/merodVersions";
import { useToast } from "../contexts/ToastContext";
import "./VersionsPanel.css";

function formatSize(bytes: number): string {
  if (!bytes) return "-";
  return `${Math.round(bytes / 1_048_576)} MB`;
}

export function VersionsPanel({ homeDir }: { homeDir: string }) {
  const toast = useToast();
  const [versions, setVersions] = useState<InstalledVersion[]>([]);
  const [busy, setBusy] = useState(false);

  const load = () => {
    listInstalledMerodVersions(homeDir)
      .then(setVersions)
      .catch((e) => toast.error(e?.message || "Failed to list merod versions"));
  };

  useEffect(load, [homeDir]);

  const handleRemove = async (id: string) => {
    setBusy(true);
    try {
      await removeMerodVersion(id, homeDir);
      toast.success(`Removed ${id}`);
      load();
    } catch (e: any) {
      toast.error(e?.message || `Failed to remove ${id}`);
    } finally {
      setBusy(false);
    }
  };

  const total = versions.reduce((sum, v) => sum + v.size_bytes, 0);

  return (
    <div className="versions-panel">
      <div className="versions-panel-head">
        <h3 className="node-card-title">merod versions</h3>
        <span className="versions-total">{formatSize(total)} total</span>
      </div>

      {versions.length === 0 ? (
        <p className="field-hint">
          Only the bundled binary is installed. Pick a release when creating a node to add one.
        </p>
      ) : (
        <ul className="versions-list">
          {versions.map((v) => {
            const isLocal = v.id.startsWith(LOCAL_ID_PREFIX);
            return (
              <li key={v.id} className="versions-row">
                <div className="versions-row-main">
                  <span className="versions-row-id">
                    {isLocal ? formatVersionLabel(v.id, "", v.measured_version) : v.id}
                  </span>
                  <span className="versions-row-sub">
                    {isLocal ? v.path : `${formatSize(v.size_bytes)} - ${v.path}`}
                  </span>
                </div>
                <span className="versions-row-users">
                  {v.used_by.length ? `used by ${v.used_by.join(", ")}` : "unused"}
                </span>
                {!isLocal && (
                  <button
                    className="button button-secondary"
                    disabled={busy || v.used_by.length > 0}
                    title={
                      v.used_by.length
                        ? `Still used by ${v.used_by.join(", ")}`
                        : "Delete this binary"
                    }
                    onClick={() => handleRemove(v.id)}
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
