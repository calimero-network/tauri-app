import React, { useState, useEffect, useCallback, useRef } from "react";
import { apiClient } from "../lib/mero-client";
import { useToast } from "../contexts/ToastContext";
import ContextMenu from "../components/ContextMenu";
import InstalledAppCard from "../components/InstalledAppCard";
import Skeleton from "../components/Skeleton";
import { decodeMetadata, openAppFrontend, parseTauriError } from "../utils/appUtils";
import { listInstalledApps, invalidateInstalledApps } from "../utils/installedAppsCache";
import { getSettings } from "../utils/settings";
import { detectRunningMerodNodes, type RunningMerodNode } from "../utils/merod";
import { formatVersionLabel, BUNDLED_VERSION_ID } from "../utils/merodVersions";
import { useNodeVersions } from "../contexts/NodeVersionsContext";
import { useMerodStatusChanged } from "../hooks/useMerodStatusChanged";
import { useVisiblePoll } from "../hooks/useVisiblePoll";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, Trash2, Copy, Rocket } from "lucide-react";
import "./InstalledApps.css";

interface InstalledApplication {
  id: string;
  name?: string;
  version?: string;
  metadata: number[] | string;
  blob?: {
    bytecode: string;
    compiled: string;
  };
  size?: number;
  source?: string;
}

export interface InstalledAppsProps {
  onAuthRequired?: () => void;
  onConfirmUninstall?: (appId: string, appName: string, onConfirm: () => Promise<void>) => void;
  clientReady?: boolean;
}

const SKELETON_MIN_MS = 1000;

const InstalledApps: React.FC<InstalledAppsProps> = ({ onAuthRequired, onConfirmUninstall, clientReady = true }) => {
  const toast = useToast();
  const [apps, setApps] = useState<InstalledApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; app: InstalledApplication } | null>(null);
  const [openMenuAppId, setOpenMenuAppId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const developerMode = getSettings().developerMode ?? false;
  const [runningNodes, setRunningNodes] = useState<RunningMerodNode[]>([]);
  const [isolationOk, setIsolationOk] = useState(false);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const { byNode: nodeVersions, bundled: bundledVersion } = useNodeVersions();

  // Options are keyed by running-node port, so derive the default the same way:
  // a settings URL of 127.0.0.1 or with a trailing slash matched no option, and
  // the select then displayed a node it would not actually open against.
  const optionValue = (n: RunningMerodNode) => `http://localhost:${n.port}`;
  const activeTarget = (() => {
    let port = '';
    try {
      port = new URL(getSettings().nodeUrl).port;
    } catch {
      return undefined;
    }
    const match = runningNodes.find((n) => String(n.port) === port);
    return match ? optionValue(match) : undefined;
  })();
  const targetFor = (appId: string) => targets[appId] ?? activeTarget;

  // Nodes start and stop while this page stays open, so a one-shot fetch would
  // keep offering a dead node as a target.
  const refreshRunning = useCallback(() => {
    detectRunningMerodNodes()
      .then((n) => setRunningNodes(Array.isArray(n) ? n : []))
      .catch(() => setRunningNodes([]));
  }, []);
  useVisiblePoll(refreshRunning, 30000, developerMode);
  useMerodStatusChanged(refreshRunning, developerMode);

  useEffect(() => {
    if (!developerMode) return;
    // Platform support cannot change.
    invoke<boolean>('webview_isolation_supported')
      .then(setIsolationOk)
      .catch(() => setIsolationOk(false));
  }, [developerMode]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!openMenuAppId) return;
    const close = () => setOpenMenuAppId(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [openMenuAppId]);

  useEffect(() => {
    if (!clientReady) { setLoading(false); return; }
    loadInstalledApps();
  }, [clientReady]);

  const loadInstalledApps = async (force = false) => {
    if (force) invalidateInstalledApps();
    setLoading(true);
    setError(null);
    const start = Date.now();

    try {
      const response = await listInstalledApps();

      if (response.error) {
        if (response.error.code === '401') {
          console.warn("InstalledApps: 401 Unauthorized - token may be expired");
          onAuthRequired?.();
          return;
        }
        if (mountedRef.current) {
          setError(response.error.message);
          setApps([]);
        }
        return;
      }

      if (response.data) {
        const appsList = Array.isArray(response.data) ? response.data : [];
        if (mountedRef.current) setApps(appsList);
      } else {
        if (mountedRef.current) setApps([]);
      }
    } catch (err: any) {
      if (err?.status === 401 || err?.code === '401') {
        onAuthRequired?.();
        return;
      }
      if (mountedRef.current) {
        setError(parseTauriError(err, "Failed to load installed applications"));
        setApps([]);
      }
    } finally {
      // Ensure skeleton shows for at least SKELETON_MIN_MS
      const elapsed = Date.now() - start;
      const remaining = SKELETON_MIN_MS - elapsed;
      if (remaining > 0) {
        await new Promise((r) => setTimeout(r, remaining));
      }
      if (mountedRef.current) setLoading(false);
    }
  };

  const handleUninstall = async (appId: string, appName: string) => {
    if (onConfirmUninstall) {
      onConfirmUninstall(appId, appName, async () => {
        try {
          const response = await apiClient.node.uninstallApplication(appId);
          if (response.error) {
            toast.error(`Failed to uninstall: ${response.error.message}`);
            return;
          }
          toast.success(`"${appName}" uninstalled`);
          await loadInstalledApps(true);
        } catch (err) {
          toast.error(`Failed to uninstall: ${parseTauriError(err, "Unknown error")}`);
        }
      });
    } else {
      try {
        const response = await apiClient.node.uninstallApplication(appId);
        if (response.error) {
          toast.error(`Failed to uninstall: ${response.error.message}`);
          return;
        }
        toast.success(`"${appName}" uninstalled`);
        await loadInstalledApps(true);
      } catch (err) {
        toast.error(`Failed to uninstall: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    }
  };

  const handleOpenFrontend = async (frontendUrl: string, appName?: string, applicationId?: string, iconData?: string) => {
    // Warm up the token so any refresh completes before we read it from localStorage.
    // Wanted for the side effect, so it deliberately bypasses the list cache.
    try { await apiClient.node.listApplications(); } catch {}
    const targetNodeUrl = applicationId ? targetFor(applicationId) : undefined;
    await openAppFrontend(frontendUrl, appName, (error) => {
      toast.error(`Failed to open frontend: ${error.message}`);
    }, applicationId ? { applicationId, iconData, targetNodeUrl } : undefined);
  };

  const handleCreateLauncher = async (frontendUrl: string, appName: string, appId: string, iconData?: string) => {
    try {
      await invoke<string>('create_desktop_shortcut', { appName, frontendUrl, appId, icon: iconData ?? null, nodeUrl: getSettings().nodeUrl });
      toast.success(`Launcher for "${appName}" added to your Applications`);
    } catch (err) {
      toast.error(`Failed to create launcher: ${parseTauriError(err, "Unknown error")}`);
    }
  };

  const handleRowContextMenu = useCallback((e: React.MouseEvent, app: InstalledApplication) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, app });
  }, []);

  // The row whose menu is open, resolved once for the dropdown that is
  // rendered as a sibling of the grid rather than inside a card.
  const openMenuApp = openMenuAppId ? (apps.find((a) => a.id === openMenuAppId) ?? null) : null;

  return (
    <div className="installed-apps-page">
      <header className="installed-apps-header">
        <div>
          <span className="eyebrow">On this node</span>
          <h1>Applications</h1>
          <p>Manage your installed applications</p>
        </div>
        <button
          onClick={() => loadInstalledApps(true)}
          className="installed-refresh-btn"
          disabled={loading}
          title="Refresh"
        >
          <RefreshCw size={15} className={loading ? 'spinning' : ''} />
        </button>
      </header>

      <main className="installed-apps-main">
        {error && (
          <div className="error-message">{error}</div>
        )}

        {contextMenu && (() => {
          const metadata = decodeMetadata(contextMenu.app.metadata);
          const appName = metadata?.name || contextMenu.app.name || contextMenu.app.id;
          const frontendUrl = metadata?.links?.frontend;
          const items: { label: string; onClick: () => void; danger?: boolean }[] = [];
          if (frontendUrl) {
            items.push({ label: 'Open', onClick: () => handleOpenFrontend(frontendUrl, appName, contextMenu.app.id, metadata?.icon) });
            items.push({ label: 'Create launcher', onClick: () => handleCreateLauncher(frontendUrl, appName, contextMenu.app.id, metadata?.icon) });
          }
          items.push({ label: 'Uninstall', onClick: () => handleUninstall(contextMenu.app.id, appName), danger: true });
          return (
            <ContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              items={items}
              onClose={() => setContextMenu(null)}
            />
          );
        })()}

        {loading ? (
          <div className="installed-apps-grid">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="app-card installed-app-card" aria-hidden>
                <div className="app-card-top">
                  <Skeleton variant="rectangular" width="48px" height="48px" />
                  <div className="app-card-headings">
                    <Skeleton variant="text" width={`${55 + (i % 3) * 12}%`} height="14px" />
                    <Skeleton variant="text" width={`${70 + (i % 4) * 6}%`} height="11px" />
                  </div>
                </div>
                <Skeleton variant="text" width="100%" height="12px" />
                <Skeleton variant="text" width={`${60 + (i % 3) * 10}%`} height="12px" />
                <div className="installed-app-actions">
                  <Skeleton variant="rectangular" width="72px" height="28px" />
                  <Skeleton variant="rectangular" width="32px" height="28px" />
                </div>
              </div>
            ))}
          </div>
        ) : apps.length === 0 ? (
          <div className="empty-state">
            <p>No applications installed.</p>
            <p>Visit the <a href="#marketplace">Marketplace</a> to install applications.</p>
          </div>
        ) : (
          <div className="installed-apps-grid" data-testid="installed-apps-grid">
            {apps.map((app, index) => {
              const metadata = decodeMetadata(app.metadata);
              const appName = metadata?.name || app.name || app.id;
              const frontendUrl = metadata?.links?.frontend;
              return (
                <InstalledAppCard
                  key={app.id || app.name || app.source || `installed-${index}`}
                  app={app}
                  menuOpen={openMenuAppId === app.id}
                  onContextMenu={(e: React.MouseEvent) => handleRowContextMenu(e, app)}
                  onToggleMenu={(e: React.MouseEvent) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
                    setOpenMenuAppId(openMenuAppId === app.id ? null : app.id);
                  }}
                  onOpen={(url: string) => handleOpenFrontend(url, appName, app.id, metadata?.icon)}
                  nodeSelect={
                    frontendUrl && developerMode && runningNodes.length > 1 ? (
                      <select
                        className="app-target-select"
                        value={targetFor(app.id) ?? ''}
                        disabled={!isolationOk}
                        title={
                          isolationOk
                            ? "Which node this app runs against"
                            : "Needs macOS 14 or newer, or Linux - without isolated webview storage two nodes would share one session"
                        }
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setTargets((t) => ({ ...t, [app.id]: e.target.value }))}
                      >
                        {runningNodes.map((n) => (
                          <option key={n.pid} value={optionValue(n)}>
                            {n.node_name} - {formatVersionLabel(nodeVersions[n.node_name] ?? BUNDLED_VERSION_ID, bundledVersion)}
                          </option>
                        ))}
                      </select>
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        )}

        {/* Rendered OUTSIDE the grid on purpose — see InstalledAppCard. */}
        {openMenuApp && menuPos && (() => {
          const metadata = decodeMetadata(openMenuApp.metadata);
          const appName = metadata?.name || openMenuApp.name || openMenuApp.id;
          const frontendUrl = metadata?.links?.frontend;
          return (
            <div
              className="app-actions-dropdown"
              style={{ position: 'fixed', top: menuPos.top, right: menuPos.right }}
            >
              <button
                className="dropdown-item"
                onClick={() => { setOpenMenuAppId(null); navigator.clipboard.writeText(openMenuApp.id); toast.success('ID copied'); }}
              >
                <Copy size={13} />
                Copy ID
              </button>
              {frontendUrl && (
                <button
                  className="dropdown-item"
                  onClick={() => { setOpenMenuAppId(null); handleCreateLauncher(frontendUrl, appName, openMenuApp.id, metadata?.icon); }}
                >
                  <Rocket size={13} />
                  Create launcher
                </button>
              )}
              <div className="dropdown-divider" />
              <button
                className="dropdown-item dropdown-item-danger"
                onClick={() => { setOpenMenuAppId(null); handleUninstall(openMenuApp.id, appName); }}
              >
                <Trash2 size={13} />
                Uninstall
              </button>
            </div>
          );
        })()}
      </main>
    </div>
  );
};

export default React.memo(InstalledApps);
