import { useState, useEffect } from "react";
import { getSettings, saveSettings } from "../utils/settings";
import { 
  listMerodNodes, 
  initMerodNode, 
  startMerod, 
  stopMerod, 
  stopMerodByPid,
  getMerodStatus,
  detectRunningMerodNodes,
  type RunningMerodNode,
  type MerodStatus
} from "../utils/merod";
import { invoke } from "@tauri-apps/api/tauri";
import { useToast } from "../contexts/ToastContext";
import { Play, Square, RefreshCw, Check } from "lucide-react";
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
  const [status, setStatus] = useState<MerodStatus>({ running: false });
  const [serverPort, setServerPort] = useState<number>(2528);
  const [swarmPort, setSwarmPort] = useState<number>(2428);
  
  // Node configuration state
  const [nodeUrl, setNodeUrl] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const settings = getSettings();
    setHomeDir(settings.embeddedNodeDataDir || "~/.calimero");
    setNodeUrl(settings.nodeUrl || "");
    setAuthUrl(settings.authUrl || "");
  }, []);

  useEffect(() => {
    loadNodes();
    detectRunning();
    checkStatus();
    
    const runningInterval = setInterval(detectRunning, 3000);
    const statusInterval = setInterval(checkStatus, 2000);
    
    return () => {
      clearInterval(runningInterval);
      clearInterval(statusInterval);
    };
  }, [homeDir]);

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

  const checkStatus = async () => {
    try {
      const currentStatus = await getMerodStatus();
      setStatus(currentStatus);
    } catch (error) {
      console.error("Failed to check status:", error);
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

    setLoading(true);
    try {
      await initMerodNode(newNodeName.trim(), homeDir);
      toast.success(`Node "${newNodeName.trim()}" created successfully`);
      setNewNodeName("");
      await loadNodes();
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

    setLoading(true);
    try {
      await startMerod(serverPort, swarmPort, homeDir, selectedNode);
      toast.success(`Node "${selectedNode}" started successfully`);
      await detectRunning();
      await checkStatus();
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
      await checkStatus();
    } catch (error: any) {
      console.error("Failed to stop node:", error);
      toast.error(`Failed to stop node: ${error.message || error}`);
    } finally {
      setLoading(false);
    }
  };

  const getRunningNodeInfo = (nodeName: string): { running: boolean; port?: number } => {
    if (!nodeName) return { running: false };
    const runningNode = runningNodes.find(n => n.node_name === nodeName);
    return runningNode ? { running: true, port: runningNode.port } : { running: false };
  };

  const handleSaveNodeConfig = () => {
    try {
      const settings = getSettings();
      saveSettings({
        ...settings,
        nodeUrl,
        authUrl: authUrl.trim() || undefined,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success("Node configuration saved successfully");
    } catch (error) {
      console.error("Failed to save node configuration:", error);
      toast.error("Failed to save node configuration");
    }
  };

  return (
    <div className="node-management-page">
      <header className="node-management-header">
        <h1>Nodes</h1>
        <p className="page-subtitle">Create and manage your Calimero nodes</p>
      </header>

      <main className="node-management-main">
        <div className="node-management-card">
          <h2>Node Configuration</h2>
          
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
              Base URL for your merod node. Admin API will be accessed at:{" "}
              <code>{nodeUrl ? `${nodeUrl.replace(/\/$/, '')}/admin-api` : ''}</code>
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
            <p className="field-hint">
              Base URL for authentication service. If empty, uses Node URL.
            </p>
          </div>

          <div className="node-actions" style={{ marginTop: '24px' }}>
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

        <div className="node-management-card">
          <h2>Create Node</h2>
          
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
            <p className="field-hint">Directory where nodes will be stored</p>
          </div>

          <div className="form-field">
            <label htmlFor="new-node-name">Node Name</label>
            <div className="input-group">
              <input
                id="new-node-name"
                type="text"
                value={newNodeName}
                onChange={(e) => setNewNodeName(e.target.value)}
                placeholder="node1, node2, etc."
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
            <h2>Available Nodes</h2>
            
            <div className="form-field">
              <label htmlFor="node-select">Select Node</label>
              <select
                id="node-select"
                value={selectedNode}
                onChange={(e) => setSelectedNode(e.target.value)}
                disabled={loading}
              >
                {availableNodes.map((node) => {
                  const nodeInfo = getRunningNodeInfo(node);
                  return (
                    <option key={node} value={node}>
                      {node} {nodeInfo.running ? `(running on ${nodeInfo.port})` : ''}
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
                  min="1024"
                  max="65535"
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
                  min="1024"
                  max="65535"
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
                onClick={() => {
                  loadNodes();
                  detectRunning();
                  checkStatus();
                }}
                className="button button-secondary"
                disabled={loading}
              >
                <RefreshCw size={16} />
                Refresh
              </button>
            </div>

            {status.running && (
              <div className="status-info">
                <p><strong>Status:</strong> Running</p>
                {runningNodes.length > 0 && runningNodes[0].port && (
                  <p><strong>Port:</strong> {runningNodes[0].port}</p>
                )}
              </div>
            )}
          </div>
        )}

        {availableNodes.length === 0 && (
          <div className="empty-state">
            <p>No nodes found. Create your first node above.</p>
          </div>
        )}
      </main>
    </div>
  );
}
