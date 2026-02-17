import { useState, useEffect, useRef } from "react";
import { getSettings, saveSettings } from "../utils/settings";
import { clearAccessToken, clearRefreshToken } from "@calimero-network/mero-react";
import {
  listMerodNodes,
  initMerodNode,
  startMerod,
  stopMerod,
  stopMerodByPid,
  detectRunningMerodNodes,
  getMerodLogs,
  type RunningMerodNode,
} from "../utils/merod";
import { invoke } from "@tauri-apps/api/tauri";
import { useToast } from "../contexts/ToastContext";
import { Play, Square, RefreshCw, Check, FileText } from "lucide-react";
import { LogsViewer } from "../components/LogsViewer";
import { ScrollHint } from "../components/ScrollHint";
import "./NodeManagement.css";

export default function NodeManagement() {
  const toast = useToast();
  
  // Node management state
  const [availableNodes, setAvailableNodes] = useState<string[]>([]);
  const [runningNodes, setRunningNodes] = useState<RunningMerodNode[]>([]);
  const [homeDir, setHomeDir] = useState("~/.calimero");
  const [selectedNode, setSelectedNode] = useState<string>("");
  const [newNodeName, setNewNodeName] = useState("");
  const [loading, setLoading] = useState(false);
  const [serverPort, setServerPort] = useState<number>(2528);
  const [swarmPort, setSwarmPort] = useState<number>(2428);
  
  // Node configuration state
  const [nodeUrl, setNodeUrl] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [saved, setSaved] = useState(false);
  const mainScrollRef = useRef<HTMLElement>(null);
  const [showLogsModal, setShowLogsModal] = useState(false);
  const [logsContent, setLogsContent] = useState("");
  const [logsLoading, setLogsLoading] = useState(false);
  const developerMode = getSettings().developerMode ?? false;

  useEffect(() => {
    const settings = getSettings();
    setHomeDir(settings.embeddedNodeDataDir || "~/.calimero");
    setNodeUrl(settings.nodeUrl || "");
    setAuthUrl(settings.authUrl || "");
  }, []);

  useEffect(() => {
    loadNodes();
    detectRunning();

    const interval = setInterval(detectRunning, 3000);
    return () => clearInterval(interval);
  }, [homeDir]);

  // When selected node is not running and current ports conflict with running nodes, auto-assign next free ports
  const getRunningNodeInfo = (nodeName: string): { running: boolean; port?: number } => {
    if (!nodeName) return { running: false };
    const runningNode = runningNodes.find(n => n.node_name === nodeName);
    return runningNode ? { running: true, port: runningNode.port } : { running: false };
  };

  useEffect(() => {
    if (!selectedNode || runningNodes.length === 0) return;
    const nodeInfo = getRunningNodeInfo(selectedNode);
    if (nodeInfo.running) return;

    const serverPortInUse = runningNodes.some(n => n.port === serverPort);
    const swarmPortInUse = runningNodes.some(n => (n.swarm_port ?? 2428) === swarmPort);
    if (!serverPortInUse && !swarmPortInUse) return;

    const maxServerPort = Math.max(2528, ...runningNodes.map(n => n.port));
    const maxSwarmPort = Math.max(2428, ...runningNodes.map(n => n.swarm_port ?? 2428));
    setServerPort(maxServerPort + 1);
    setSwarmPort(maxSwarmPort + 1);
  }, [selectedNode, runningNodes, serverPort, swarmPort]);

  const loadNodes = async () => {
    try {
      const nodes = await listMerodNodes(homeDir);
      setAvailableNodes(nodes);
      if (nodes.length > 0 && !selectedNode) {
        setSelectedNode(nodes[0]);
      }
    } catch (error) {
      console.error("Failed to load nodes:", error);
    }
  };

  const detectRunning = async () => {
    try {
      const running = await detectRunningMerodNodes();
      setRunningNodes(running);
    } catch (error) {
      console.error("Failed to detect running nodes:", error);
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

    const createdName = newNodeName.trim();
    setLoading(true);
    try {
      await initMerodNode(createdName, homeDir);
      toast.success(`Node "${createdName}" created successfully`);
      setNewNodeName("");
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
    const usedServerPorts = runningNodes.map((n) => n.port ?? 2528);
    const usedSwarmPorts = runningNodes.map((n) => n.swarm_port ?? 2428);
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
        clearAccessToken();
        clearRefreshToken();
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
      const runningNode = runningNodes.find(n => n.node_name === selectedNode);
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

  const handleSaveNodeConfig = () => {
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
        clearAccessToken();
        clearRefreshToken();
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
          <p className="node-section-desc">Create and run merod nodes on this machine.</p>

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
            <div className="form-field">
              <label htmlFor="new-node-name">Node Name</label>
              <div className="input-group">
                <input
                  id="new-node-name"
                  type="text"
                  value={newNodeName}
                  onChange={(e) => setNewNodeName(e.target.value)}
                  placeholder="default, node1, etc."
                  onKeyPress={(e) => e.key === 'Enter' && handleCreateNode()}
                />
                <button
                  onClick={handleCreateNode}
                  className="button button-primary"
                  disabled={!newNodeName.trim() || loading}
                >
                  {loading ? 'Creating...' : 'Create'}
                </button>
              </div>
            </div>
          </div>

          {availableNodes.length > 0 && (
            <div className="node-management-card">
              <h3 className="node-card-title">Manage Nodes</h3>
              <div className="form-field">
                <label>Select node</label>
                <select
                  value={selectedNode}
                  onChange={(e) => setSelectedNode(e.target.value)}
                  disabled={loading}
                >
                  {availableNodes.map((node) => {
                    const nodeInfo = getRunningNodeInfo(node);
                    return (
                      <option key={node} value={node}>
                        {node} {nodeInfo.running ? `• Port ${nodeInfo.port}` : '• Stopped'}
                      </option>
                    );
                  })}
                </select>
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
              <div className="node-status-cards">
                {availableNodes.map((node) => {
                  const nodeInfo = getRunningNodeInfo(node);
                  return (
                    <div
                      key={node}
                      className={`node-status-card ${nodeInfo.running ? 'running' : 'stopped'}`}
                    >
                      <div className="node-status-card-header">
                        <span className="node-status-dot" />
                        <span className="node-status-name">{node}</span>
                        <span className="node-status-badge">
                          {nodeInfo.running ? `Port ${nodeInfo.port}` : 'Stopped'}
                        </span>
                      </div>
                    </div>
                  );
                })}
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

          {availableNodes.length === 0 && (
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
            onClose={() => setShowLogsModal(false)}
          />
        )}
        <ScrollHint containerRef={mainScrollRef} />
      </main>
    </div>
  );
}
