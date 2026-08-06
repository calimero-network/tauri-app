import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  listInstalledMerodVersions,
  removeMerodVersion,
  repointLocalBuild,
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

  const handleRepoint = async (oldId: string) => {
    const picked = await invoke<string | null>('pick_merod_binary');
    if (!picked) return;
    setBusy(true);
    try {
      const changed = await repointLocalBuild(oldId, picked, homeDir);
      toast.success(`Repointed ${changed} node${changed === 1 ? '' : 's'} at ${picked}`);
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to repoint the local build');
    } finally {
      setBusy(false);
    }
  };

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
                  <span className="versions-row-sub" title={v.path}>
                    {isLocal ? v.path.split('/').slice(-3).join('/') : formatSize(v.size_bytes)}
                  </span>
                </div>
                <span className="versions-row-users">
                  {v.used_by.length ? `used by ${v.used_by.join(", ")}` : "unused"}
                </span>
                {isLocal && (
                  <button
                    className="button button-secondary"
                    disabled={busy}
                    title="Point these nodes at a different merod build"
                    onClick={() => handleRepoint(v.id)}
                  >
                    Change
                  </button>
                )}
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
