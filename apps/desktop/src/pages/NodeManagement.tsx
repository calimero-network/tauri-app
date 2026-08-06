import { useState, useEffect, useRef, memo } from "react";
import { getSettings, saveSettings } from "../utils/settings";
import { clearAccessToken, clearRefreshToken } from "../lib/token-storage";
import {
  listMerodNodes,
  initMerodNode,
  startMerod,
  stopMerod,
  stopMerodByPid,
  detectRunningMerodNodes,
  getMerodLogs,
  clearMerodLogs,
  getMerodBinaryVersion,
  type RunningMerodNode,
} from "../utils/merod";
import {
  listMerodReleases,
  formatVersionLabel,
  BUNDLED_VERSION_ID,
  LOCAL_ID_PREFIX,
  type ReleaseInfo,
} from "../utils/merodVersions";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "../contexts/ToastContext";
import { Play, Square, RefreshCw, Check, FileText, ChevronDown } from "lucide-react";
import { LogsViewer } from "../components/LogsViewer";
import { ScrollHint } from "../components/ScrollHint";
import { VersionsPanel } from "../components/VersionsPanel";
import { useNodeVersions } from "../hooks/useNodeVersions";
import { useMerodStatusChanged } from "../hooks/useMerodStatusChanged";
import "./NodeManagement.css";

function NodeManagement() {
  const toast = useToast();
  
  // Node management state
  const [availableNodes, setAvailableNodes] = useState<string[]>([]);
  const [runningNodes, setRunningNodes] = useState<RunningMerodNode[]>([]);
  const [homeDir, setHomeDir] = useState("~/.calimero");
  const [selectedNode, setSelectedNode] = useState<string>("");
  const [newNodeName, setNewNodeName] = useState("");
  const [newAdminUser, setNewAdminUser] = useState("");
  const [newAdminPassword, setNewAdminPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [serverPort, setServerPort] = useState<number>(2528);
  const [swarmPort, setSwarmPort] = useState<number>(2428);
  
  // Node configuration state
  const [nodeUrl, setNodeUrl] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [saved, setSaved] = useState(false);
  const mainScrollRef = useRef<HTMLElement>(null);
  const [nodeDropdownOpen, setNodeDropdownOpen] = useState(false);
  const nodeDropdownRef = useRef<HTMLDivElement>(null);
  const [showLogsModal, setShowLogsModal] = useState(false);
  const [logsContent, setLogsContent] = useState("");
  const [logsLoading, setLogsLoading] = useState(false);
  const [merodBinaryVersion, setMerodBinaryVersion] = useState<string>("");
  const [versionId, setVersionId] = useState<string>(BUNDLED_VERSION_ID);
  const [releases, setReleases] = useState<ReleaseInfo[]>([]);
  const [releasesError, setReleasesError] = useState<string>("");
  const [releasesStale, setReleasesStale] = useState(false);
  const developerMode = getSettings().developerMode ?? false;
  const { byNode: nodeVersions, measured: versionMeasured, drifted: driftedNodes } =
    useNodeVersions(developerMode, homeDir, [availableNodes]);
  const safeAvailableNodes = Array.isArray(availableNodes) ? availableNodes : [];
  const safeRunningNodes = Array.isArray(runningNodes) ? runningNodes : [];

  useEffect(() => {
    const settings = getSettings();
    setHomeDir(settings.embeddedNodeDataDir || "~/.calimero");
    setNodeUrl(settings.nodeUrl || "");
    setAuthUrl(settings.authUrl || "");
    getMerodBinaryVersion()
      .then(setMerodBinaryVersion)
      .catch(() => setMerodBinaryVersion("unknown"));
  }, []);

  useEffect(() => {
    if (!developerMode) return;
    listMerodReleases()
      .then((r) => {
        setReleases(r.releases.filter((item) => item.has_asset));
        setReleasesStale(r.stale);
      })
      .catch((e) => setReleasesError(e?.message || "Could not reach GitHub"));
  }, [developerMode]);


  // The backend emits on every start/stop/reap it performs; the slow poll is
  // only there to discover nodes started outside the app.
  useMerodStatusChanged(() => detectRunning());

  useEffect(() => {
    loadNodes();
    detectRunning();

    const interval = setInterval(detectRunning, 30000);
    return () => clearInterval(interval);
  }, [homeDir]);

  // When selected node is not running and current ports conflict with running nodes, auto-assign next free ports
  const getRunningNodeInfo = (nodeName: string): { running: boolean; port?: number } => {
    if (!nodeName) return { running: false };
    const runningNode = safeRunningNodes.find(n => n.node_name === nodeName);
    return runningNode ? { running: true, port: runningNode.port } : { running: false };
  };

  const getVersionBadge = (nodeName: string) => {
    const id = nodeVersions[nodeName] ?? BUNDLED_VERSION_ID;
    const drifted = driftedNodes.has(nodeName);
    return {
      label: formatVersionLabel(id, merodBinaryVersion, versionMeasured[id]),
      className: `node-version-badge${id !== BUNDLED_VERSION_ID ? ' custom' : ''}${drifted ? ' drifted' : ''}`,
      // Expected after a rebuild; surfaced so a mismatch isn't mistaken for a bug.
      title: drifted
        ? "This binary now reports a different version than when the node was created - the node's data directory was created by a different build."
        : undefined,
    };
  };

  useEffect(() => {
    if (!selectedNode || safeRunningNodes.length === 0) return;
    const nodeInfo = getRunningNodeInfo(selectedNode);
    if (nodeInfo.running) return;

    const serverPortInUse = safeRunningNodes.some(n => n.port === serverPort);
    const swarmPortInUse = safeRunningNodes.some(n => (n.swarm_port ?? 2428) === swarmPort);
    if (!serverPortInUse && !swarmPortInUse) return;

    const maxServerPort = Math.max(2528, ...safeRunningNodes.map(n => n.port));
    const maxSwarmPort = Math.max(2428, ...safeRunningNodes.map(n => n.swarm_port ?? 2428));
    setServerPort(maxServerPort + 1);
    setSwarmPort(maxSwarmPort + 1);
  }, [selectedNode, runningNodes, serverPort, swarmPort]);

  useEffect(() => {
    if (!nodeDropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (nodeDropdownRef.current && !nodeDropdownRef.current.contains(e.target as Node)) {
        setNodeDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [nodeDropdownOpen]);

  const loadNodes = async () => {
    try {
      const raw = await listMerodNodes(homeDir);
      const nodes = Array.isArray(raw) ? raw : [];
      setAvailableNodes(nodes);
      if (nodes.length > 0 && !selectedNode) {
        setSelectedNode(nodes[0]);
      }
    } catch (error) {
      console.error("Failed to load nodes:", error);
      setAvailableNodes([]);
    }
  };

  const detectRunning = async () => {
    try {
      const raw = await detectRunningMerodNodes();
      const running = Array.isArray(raw) ? raw : [];
      setRunningNodes(running);
    } catch (error) {
      console.error("Failed to detect running nodes:", error);
      setRunningNodes([]);
    }
  };

  const handlePickHomeDir = async () => {
    try {
      const result = await invoke<string | null>('pick_directory', { 
        defaultPath: homeDir || undefined 
      });
      if (result) {
        setHomeDir(result);
        const settings = getSettings();
        // Save the new home directory
        saveSettings({
          ...settings,
          embeddedNodeDataDir: result,
        });
      }
    } catch (error) {
      console.error("Failed to pick directory:", error);
      toast.error("Failed to pick directory");
    }
  };

  const handleCreateNode = async () => {
    if (!newNodeName.trim()) {
      toast.error("Please enter a node name");
      return;
    }
    // Since core rc.17 the admin account is minted at init — a node created
    // without credentials cannot be logged into.
    if (!newAdminUser.trim() || !newAdminPassword) {
      toast.error("Please choose an admin username and password for the node");
      return;
    }
    if (newAdminPassword.length < 8) {
      toast.error("The admin password must be at least 8 characters");
      return;
    }

    const createdName = newNodeName.trim();
    setLoading(true);
    try {
      await initMerodNode(createdName, homeDir, newAdminUser.trim(), newAdminPassword, versionId);
      toast.success(`Node "${createdName}" created successfully`);
      setNewNodeName("");
      setNewAdminUser("");
      setNewAdminPassword("");
      await loadNodes();
      await detectRunning(); // Fresh running nodes so port-bump effect uses correct ports
      setSelectedNode(createdName);
    } catch (error: any) {
      console.error("Failed to create node:", error);
      toast.error(`Failed to create node: ${error.message || error}`);
    } finally {
      setLoading(false);
    }
  };

  const handleStartNode = async () => {
    if (!selectedNode) {
      toast.error("Please select a node");
      return;
    }

    // Compute port at click time to avoid race with port-bump effect.
    // If current serverPort is already in use by another node, pick next free port.
    let portToUse = serverPort;
    let swarmToUse = swarmPort;
    const usedServerPorts = safeRunningNodes.map((n) => n.port ?? 2528);
    const usedSwarmPorts = safeRunningNodes.map((n) => n.swarm_port ?? 2428);
    if (usedServerPorts.includes(serverPort)) {
      portToUse = Math.max(2528, ...usedServerPorts) + 1;
      setServerPort(portToUse);
    }
    if (usedSwarmPorts.includes(swarmPort)) {
      swarmToUse = Math.max(2428, ...usedSwarmPorts) + 1;
      setSwarmPort(swarmToUse);
    }

    setLoading(true);
    try {
      await startMerod(portToUse, swarmToUse, homeDir, selectedNode, getSettings().debugLogs);
      toast.success(`Node "${selectedNode}" started successfully`);
      await detectRunning();

      // Auto-switch app to use this node's URL so connection works immediately
      const nodeUrlNew = `http://localhost:${portToUse}`;
      const settings = getSettings();
      const urlChanged = settings.nodeUrl !== nodeUrlNew;
      saveSettings({
        ...settings,
        nodeUrl: nodeUrlNew,
        authUrl: undefined,
      });

      // Clear auth tokens when switching nodes — old tokens are invalid
      if (urlChanged) {
        await clearAccessToken();
        await clearRefreshToken();
        localStorage.removeItem('calimero-auth-tokens');
      }

      setNodeUrl(nodeUrlNew);
      toast.success(`Switched to ${nodeUrlNew}. Reloading to connect.`);
      window.location.reload();
    } catch (error: any) {
      console.error("Failed to start node:", error);
      toast.error(`Failed to start node: ${error.message || error}`);
    } finally {
      setLoading(false);
    }
  };

  const handleStopNode = async () => {
    if (!selectedNode) {
      toast.error("Please select a node");
      return;
    }

    setLoading(true);
    try {
      // Try to stop by PID if we have it
      const runningNode = safeRunningNodes.find(n => n.node_name === selectedNode);
      if (runningNode && runningNode.pid) {
        await stopMerodByPid(runningNode.pid);
        toast.success(`Node "${selectedNode}" stopped successfully`);
      } else {
        // Fallback to stopping the embedded node
        await stopMerod();
        toast.success(`Node "${selectedNode}" stopped successfully`);
      }
      await detectRunning();
    } catch (error: any) {
      console.error("Failed to stop node:", error);
      toast.error(`Failed to stop node: ${error.message || error}`);
    } finally {
      setLoading(false);
    }
  };

  const handleViewLogs = async () => {
    if (!selectedNode) return;
    setShowLogsModal(true);
    setLogsLoading(true);
    setLogsContent("");
    try {
      const logs = await getMerodLogs(selectedNode, homeDir, 500);
      setLogsContent(logs || "(No log output yet)");
    } catch (err: any) {
      const msg = err?.message || "Failed to load logs";
      setLogsContent(
        msg.includes("No log file")
          ? `${msg}\n\nTip: Restart the node from this app to start capturing logs.`
          : msg
      );
    } finally {
      setLogsLoading(false);
    }
  };

  const handleRefreshLogs = async () => {
    if (!selectedNode) return;
    setLogsLoading(true);
    try {
      const logs = await getMerodLogs(selectedNode, homeDir, 500);
      setLogsContent(logs || "(No log output yet)");
    } catch (err: any) {
      setLogsContent(err?.message || "Failed to load logs");
      toast.error("Failed to refresh logs");
    } finally {
      setLogsLoading(false);
    }
  };

  const handleClearLogs = async () => {
    if (!selectedNode) return;
    setLogsLoading(true);
    try {
      await clearMerodLogs(selectedNode, homeDir);
      toast.success("Logs cleared");
    } catch (err: any) {
      toast.error(err?.message || "Failed to clear logs");
      setLogsLoading(false);
      return;
    }
    // Re-read in a separate step: a failed re-fetch (e.g. no merod.log yet after
    // clearing) must not be reported as a clear failure — the clear succeeded.
    try {
      const logs = await getMerodLogs(selectedNode, homeDir, 500);
      setLogsContent(logs || "(No log output yet)");
    } catch {
      setLogsContent("(No log output yet)");
    } finally {
      setLogsLoading(false);
    }
  };

  const handleSaveNodeConfig = async () => {
    try {
      const settings = getSettings();
      const newNodeUrl = nodeUrl.trim() || "http://localhost:2528";
      const urlChanged = settings.nodeUrl !== newNodeUrl;
      saveSettings({
        ...settings,
        nodeUrl: newNodeUrl,
        authUrl: authUrl.trim() || undefined,
      });

      // Clear auth tokens when switching to a different node — old tokens are invalid
      if (urlChanged) {
        await clearAccessToken();
        await clearRefreshToken();
        localStorage.removeItem('calimero-auth-tokens');
      }

      setSaved(true);
      toast.success("Node configuration saved successfully");
      // Reload app so Context, Applications, Marketplace use the new node URL
      window.location.reload();
    } catch (error) {
      console.error("Failed to save node configuration:", error);
      toast.error("Failed to save node configuration");
    }
  };

  return (
    <div className="node-management-page">
      <header className="node-management-header">
        <h1>Nodes</h1>
        <p className="page-subtitle">Configure which node the app connects to. Create and manage local nodes below.</p>
      </header>

      <main ref={mainScrollRef} className="node-management-main">
        {/* Section 1: Connection - what the app uses */}
        <section className="node-section">
          <h2 className="node-section-title">Connection</h2>
          <p className="node-section-desc">The app connects to this node URL. Use a local node or a remote one.</p>
          <div className="node-management-card node-config-card">
            <div className="form-field">
              <label htmlFor="node-url">Node URL</label>
              <input
                id="node-url"
                type="text"
                value={nodeUrl}
                onChange={(e) => setNodeUrl(e.target.value)}
                placeholder="http://localhost:2528"
              />
              <p className="field-hint">
                Admin API: <code>{nodeUrl ? `${nodeUrl.replace(/\/$/, '')}/admin-api` : '—'}</code>
              </p>
            </div>
            <div className="form-field">
              <label htmlFor="auth-url">Auth URL (optional)</label>
              <input
                id="auth-url"
                type="text"
                value={authUrl}
                onChange={(e) => setAuthUrl(e.target.value)}
                placeholder="Leave empty to use Node URL"
              />
            </div>
            <div className="node-actions">
              <button onClick={handleSaveNodeConfig} className="button button-primary">
                Save Configuration
              </button>
              {saved && (
                <span className="saved-indicator">
                  <Check size={14} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                  Saved
                </span>
              )}
            </div>
          </div>
        </section>

        {/* Section 2: Local nodes - create & manage */}
        <section className="node-section">
          <h2 className="node-section-title">Local Nodes</h2>
          <p className="node-section-desc">
            Create and run merod nodes on this machine.
          </p>

          <div className="node-management-card">
            <h3 className="node-card-title">Create New Node</h3>
            <div className="form-field">
              <label htmlFor="home-dir">Data Directory</label>
              <div className="input-group">
                <input
                  id="home-dir"
                  type="text"
                  value={homeDir}
                  onChange={(e) => setHomeDir(e.target.value)}
                  placeholder="~/.calimero"
                />
                <button onClick={handlePickHomeDir} className="button button-secondary">
                  Browse
                </button>
              </div>
            </div>
            <div className="form-row">
              <div className="form-field">
                <label htmlFor="new-node-name">Node Name</label>
                <input
                  id="new-node-name"
                  type="text"
                  value={newNodeName}
                  onChange={(e) => setNewNodeName(e.target.value)}
                  placeholder="default, node1, etc."
                />
              </div>
              {developerMode && (
                <div className="form-field">
                  <label htmlFor="merod-version">merod Version</label>
                  <select
                    id="merod-version"
                    className="version-select"
                    value={versionId}
                    onChange={async (e) => {
                      if (e.target.value !== "__local__") {
                        setVersionId(e.target.value);
                        return;
                      }
                      const picked = await invoke<string | null>('pick_merod_binary');
                      if (picked) {
                        setVersionId(`${LOCAL_ID_PREFIX}${picked}`);
                        return;
                      }
                      // Cancelled: no state changed, so React will not re-render
                      // and the select would keep showing "Use a local build...".
                      e.target.value = versionId;
                    }}
                    disabled={loading}
                  >
                    <option value={BUNDLED_VERSION_ID}>
                      {formatVersionLabel(BUNDLED_VERSION_ID, merodBinaryVersion)}
                    </option>
                    {releases.map((r) => (
                      <option key={r.tag} value={r.tag}>
                        {r.tag}{r.prerelease ? " (pre-release)" : ""}
                      </option>
                    ))}
                    {versionId.startsWith(LOCAL_ID_PREFIX) && (
                      <option value={versionId}>{versionId.slice(LOCAL_ID_PREFIX.length)}</option>
                    )}
                    <option value="__local__">Use a local build...</option>
                  </select>
                </div>
              )}
            </div>

            {developerMode && (
              <p className="field-hint">
                {releasesError
                  ? `Release list unavailable: ${releasesError}`
                  : releases.length === 0
                    ? "No merod releases are published for this platform. Use the bundled binary or a local build."
                    : releasesStale
                      ? "Showing the last list we fetched - GitHub was unreachable."
                      : "Fixed when the node is created. Create another node to try another version."}
              </p>
            )}

            <div className="form-row">
              <div className="form-field">
                <label htmlFor="new-admin-user">Admin Username</label>
                <input
                  id="new-admin-user"
                  type="text"
                  value={newAdminUser}
                  onChange={(e) => setNewAdminUser(e.target.value)}
                  placeholder="Username you will log in with"
                  autoComplete="username"
                />
              </div>
              <div className="form-field">
                <label htmlFor="new-admin-password">Admin Password</label>
                <input
                  id="new-admin-password"
                  type="password"
                  value={newAdminPassword}
                  onChange={(e) => setNewAdminPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  onKeyPress={(e) => e.key === 'Enter' && handleCreateNode()}
                />
              </div>
            </div>

            <div className="node-actions">
              <button
                onClick={handleCreateNode}
                className="button button-primary"
                disabled={!newNodeName.trim() || !newAdminUser.trim() || !newAdminPassword || loading}
              >
                {loading ? 'Creating...' : 'Create Node'}
              </button>
            </div>
          </div>

          {safeAvailableNodes.length > 0 && (
            <div className="node-management-card">
              <h3 className="node-card-title">Manage Nodes</h3>
              <div className="form-field">
                <label>Select node</label>
                <div className="node-select-wrapper" ref={nodeDropdownRef}>
                  <button
                    type="button"
                    className={`node-select-trigger${nodeDropdownOpen ? ' open' : ''}`}
                    onClick={() => !loading && setNodeDropdownOpen(o => !o)}
                    disabled={loading}
                  >
                    <span className="node-select-trigger-left">
                      <span className={`node-select-dot${getRunningNodeInfo(selectedNode).running ? ' running' : ''}`} />
                      <span className="node-select-name">{selectedNode || 'Select a node'}</span>
                      {selectedNode && (
                        <span className="node-select-badge">
                          {getRunningNodeInfo(selectedNode).running ? `Port ${getRunningNodeInfo(selectedNode).port}` : 'Stopped'}
                        </span>
                      )}
                      {developerMode && (() => {
                        const badge = getVersionBadge(selectedNode);
                        return (
                          <span className={badge.className} title={badge.title}>{badge.label}</span>
                        );
                      })()}
                    </span>
                    <ChevronDown size={15} className={`node-select-chevron${nodeDropdownOpen ? ' open' : ''}`} />
                  </button>
                  {nodeDropdownOpen && (
                    <div className="node-select-menu">
                      {safeAvailableNodes.map((node) => {
                        const nodeInfo = getRunningNodeInfo(node);
                        const isSelected = node === selectedNode;
                        const badge = getVersionBadge(node);
                        return (
                          <button
                            key={node}
                            type="button"
                            className={`node-select-option${isSelected ? ' selected' : ''}${nodeInfo.running ? ' running' : ''}`}
                            onClick={() => { setSelectedNode(node); setNodeDropdownOpen(false); }}
                          >
                            <span className={`node-select-dot${nodeInfo.running ? ' running' : ''}`} />
                            <span className="node-select-option-name">{node}</span>
                            <span className="node-select-option-badge">
                              {nodeInfo.running ? `Port ${nodeInfo.port}` : 'Stopped'}
                            </span>
                            {developerMode && (
                              <span className={badge.className} title={badge.title}>{badge.label}</span>
                            )}
                            {isSelected && <Check size={13} className="node-select-check" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              <div className="form-row">
                <div className="form-field">
                  <label htmlFor="server-port">Server Port</label>
                  <input
                    id="server-port"
                    type="number"
                    value={serverPort}
                    onChange={(e) => setServerPort(parseInt(e.target.value) || 2528)}
                    min={1024}
                    max={65535}
                    disabled={loading}
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="swarm-port">Swarm Port</label>
                  <input
                    id="swarm-port"
                    type="number"
                    value={swarmPort}
                    onChange={(e) => setSwarmPort(parseInt(e.target.value) || 2428)}
                    min={1024}
                    max={65535}
                    disabled={loading}
                  />
                </div>
              </div>

              <div className="node-actions">
                <button
                  onClick={handleStartNode}
                  className="button button-primary"
                  disabled={loading || !selectedNode || getRunningNodeInfo(selectedNode).running}
                >
                  <Play size={16} />
                  Start Node
                </button>
                <button
                  onClick={handleStopNode}
                  className="button button-secondary"
                  disabled={loading || !selectedNode || !getRunningNodeInfo(selectedNode).running}
                >
                  <Square size={16} />
                  Stop Node
                </button>
                <button
                  onClick={() => { loadNodes(); detectRunning(); }}
                  className="button button-secondary"
                  disabled={loading}
                >
                  <RefreshCw size={16} />
                  Refresh
                </button>
                {developerMode && (
                  <button
                    onClick={handleViewLogs}
                    className="button button-secondary"
                    disabled={loading || !selectedNode}
                    title="View node logs (developer mode)"
                  >
                    <FileText size={16} />
                    View Logs
                  </button>
                )}
              </div>
            </div>
          )}

          {developerMode && <VersionsPanel homeDir={homeDir} />}

          {safeAvailableNodes.length === 0 && (
            <div className="empty-state">
              <p>No nodes found. Create your first node above.</p>
            </div>
          )}
        </section>

        {showLogsModal && (
          <LogsViewer
            content={logsContent}
            title={selectedNode}
            loading={logsLoading}
            onRefresh={handleRefreshLogs}
            onClear={handleClearLogs}
            onClose={() => setShowLogsModal(false)}
          />
        )}
        <ScrollHint containerRef={mainScrollRef} />
      </main>
    </div>
  );
}

export default memo(NodeManagement);
