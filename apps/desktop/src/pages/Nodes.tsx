import { useState, useEffect } from "react";
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
import { getSettings, saveSettings } from "../utils/settings";
import "./Nodes.css";

interface NodesProps {
  onBack?: () => void;
}

export default function Nodes({ onBack }: NodesProps) {
  const [availableNodes, setAvailableNodes] = useState<string[]>([]);
  const [runningNodes, setRunningNodes] = useState<RunningMerodNode[]>([]);
  const [homeDir, setHomeDir] = useState("~/.calimero");
  const [selectedNode, setSelectedNode] = useState<string>("");
  const [creatingNode, setCreatingNode] = useState(false);
  const [newNodeName, setNewNodeName] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<MerodStatus>({ running: false });
  const [currentNodeUrl, setCurrentNodeUrl] = useState<string>("");
  const [serverPort, setServerPort] = useState<number>(2528);
  const [swarmPort, setSwarmPort] = useState<number>(2428);

  useEffect(() => {
    const settings = getSettings();
    setCurrentNodeUrl(settings.nodeUrl);
  }, []);

  // Helper function to check if a node is running and get its port
  const getRunningNodeInfo = (nodeName: string): { running: boolean; port?: number } => {
    if (!nodeName) {
      return { running: false };
    }
    const runningNode = runningNodes.find(n => n.node_name === nodeName);
    if (runningNode) {
      return { running: true, port: runningNode.port };
    }
    return { running: false };
  };

  useEffect(() => {
    loadNodes();
    detectRunning();
    checkStatus();
    
    // Set up intervals
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
      console.log("Loaded nodes:", nodes, "from homeDir:", homeDir);
      setAvailableNodes(nodes);
      if (nodes.length > 0 && !selectedNode) {
        setSelectedNode(nodes[0]);
      } else if (nodes.length > 0 && selectedNode && !nodes.includes(selectedNode)) {
        // If selected node is no longer in the list, select first available
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
      }
    } catch (error) {
      console.error("Failed to pick directory:", error);
      alert("Failed to pick directory");
    }
  };

  const handleCreateNode = async () => {
    if (!newNodeName.trim()) {
      alert("Please enter a node name");
      return;
    }
    
    setLoading(true);
    try {
      await initMerodNode(newNodeName.trim(), homeDir);
      const createdNodeName = newNodeName.trim();
      setNewNodeName("");
      setCreatingNode(false);
      await loadNodes();
      // Select the newly created node
      setSelectedNode(createdNodeName);
      alert(`Node '${createdNodeName}' created successfully`);
    } catch (error: any) {
      console.error("Failed to create node:", error);
      alert(`Failed to create node: ${error.message || error}`);
    } finally {
      setLoading(false);
    }
  };

  const handleStartNode = async () => {
    if (!selectedNode) {
      alert("Please select a node");
      return;
    }
    
    // Check if node is already running
    const nodeInfo = getRunningNodeInfo(selectedNode);
    if (nodeInfo.running) {
      alert(`Node '${selectedNode}' is already running on port ${nodeInfo.port}`);
      return;
    }
    
    setLoading(true);
    try {
      await startMerod(serverPort, swarmPort, homeDir, selectedNode);
      await checkStatus();
      await detectRunning();
      alert(`Node '${selectedNode}' started successfully on server port ${serverPort} and swarm port ${swarmPort}`);
    } catch (error: any) {
      console.error("Failed to start node:", error);
      await checkStatus();
      await detectRunning();
      alert(`Failed to start node: ${error.message || error}`);
    } finally {
      setLoading(false);
    }
  };

  const handleStopNode = async (pid?: number) => {
    setLoading(true);
    try {
      if (pid) {
        await stopMerodByPid(pid);
      } else {
        await stopMerod();
      }
      await checkStatus();
      await detectRunning();
      alert("Node stopped successfully");
    } catch (error: any) {
      console.error("Failed to stop node:", error);
      await checkStatus();
      await detectRunning();
      alert(`Failed to stop node: ${error.message || error}`);
    } finally {
      setLoading(false);
    }
  };

  const handleUseNode = async (node: RunningMerodNode) => {
    try {
      const nodeUrl = `http://localhost:${node.port}`;
      const settings = getSettings();
      saveSettings({
        ...settings,
        nodeUrl,
        authUrl: undefined, // Clear authUrl so it defaults to nodeUrl
      });
      setCurrentNodeUrl(nodeUrl);
      alert(`Node URL set to ${nodeUrl}. The app will reload to connect to this node.`);
      // Reload the page to reconnect with new node URL
      window.location.reload();
    } catch (error: any) {
      console.error("Failed to use node:", error);
      alert(`Failed to use node: ${error.message || error}`);
    }
  };

  const isNodeInUse = (node: RunningMerodNode): boolean => {
    const nodeUrl = `http://localhost:${node.port}`;
    return currentNodeUrl === nodeUrl || currentNodeUrl === `${nodeUrl}/`;
  };

  return (
    <div className="nodes-page">
      <header className="nodes-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {onBack && (
            <button onClick={onBack} className="button" style={{ background: '#f0f0f0' }}>
              ← Back
            </button>
          )}
          <h1 style={{ margin: 0 }}>Nodes</h1>
        </div>
      </header>

      <main className="nodes-main">
        {/* Create Node Section */}
        <div className="nodes-card">
          <h2>Create Node</h2>
          
          <div className="nodes-field">
            <label htmlFor="home-dir">Home Directory</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                id="home-dir"
                type="text"
                value={homeDir}
                onChange={(e) => setHomeDir(e.target.value)}
                placeholder="~/.calimero"
                style={{ flex: 1 }}
              />
              <button onClick={handlePickHomeDir} className="button">
                Browse
              </button>
            </div>
            <p className="field-hint">
              Directory where nodes will be stored (default: ~/.calimero)
            </p>
          </div>

          {!creatingNode ? (
            <div className="nodes-field">
              <button 
                onClick={() => setCreatingNode(true)}
                className="button button-primary"
                disabled={loading}
              >
                + Create New Node
              </button>
            </div>
          ) : (
            <div className="nodes-field">
              <label htmlFor="new-node-name">Node Name</label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  id="new-node-name"
                  type="text"
                  value={newNodeName}
                  onChange={(e) => setNewNodeName(e.target.value)}
                  placeholder="node1, node2, etc."
                  onKeyPress={(e) => e.key === 'Enter' && handleCreateNode()}
                  style={{ flex: 1 }}
                />
                <button
                  onClick={handleCreateNode}
                  className="button button-primary"
                  disabled={!newNodeName.trim() || loading}
                >
                  {loading ? 'Creating...' : 'Create'}
                </button>
                <button
                  onClick={() => {
                    setCreatingNode(false);
                    setNewNodeName("");
                  }}
                  className="button"
                  disabled={loading}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Available Nodes Section */}
        <div className="nodes-card">
          <h2>Available Nodes</h2>
          <p className="field-hint" style={{ marginTop: '4px', marginBottom: '16px', fontSize: '12px', color: '#666' }}>
            Home directory: {homeDir}
          </p>
          
          {availableNodes.length === 0 ? (
            <p className="field-hint">No nodes found. Create a new node to get started.</p>
          ) : (
            <>
              <div className="nodes-field">
                <label htmlFor="node-select">Select Node</label>
                <select
                  id="node-select"
                  value={selectedNode}
                  onChange={(e) => setSelectedNode(e.target.value)}
                  disabled={loading}
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #ddd', borderRadius: '4px' }}
                >
                  {availableNodes.map((node) => {
                    if (!node) return null;
                    const nodeInfo = getRunningNodeInfo(node);
                    const displayName = nodeInfo.running && nodeInfo.port
                      ? `${node} - running (${nodeInfo.port})`
                      : node;
                    return (
                      <option 
                        key={node} 
                        value={node}
                        disabled={nodeInfo.running}
                      >
                        {displayName}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
                <div className="nodes-field" style={{ flex: 1 }}>
                  <label htmlFor="server-port">Server Port</label>
                  <input
                    id="server-port"
                    type="number"
                    value={serverPort}
                    onChange={(e) => {
                      const port = parseInt(e.target.value, 10);
                      if (!isNaN(port) && port > 0 && port <= 65535) {
                        setServerPort(port);
                      }
                    }}
                    min="1"
                    max="65535"
                    disabled={loading}
                    style={{ width: '100%', padding: '10px 12px', border: '1px solid #ddd', borderRadius: '4px' }}
                  />
                  <p className="field-hint" style={{ marginTop: '4px', fontSize: '12px', color: '#666' }}>
                    Default: 2528. HTTP/API server port.
                  </p>
                </div>

                <div className="nodes-field" style={{ flex: 1 }}>
                  <label htmlFor="swarm-port">Swarm Port</label>
                  <input
                    id="swarm-port"
                    type="number"
                    value={swarmPort}
                    onChange={(e) => {
                      const port = parseInt(e.target.value, 10);
                      if (!isNaN(port) && port > 0 && port <= 65535) {
                        setSwarmPort(port);
                      }
                    }}
                    min="1"
                    max="65535"
                    disabled={loading}
                    style={{ width: '100%', padding: '10px 12px', border: '1px solid #ddd', borderRadius: '4px' }}
                  />
                  <p className="field-hint" style={{ marginTop: '4px', fontSize: '12px', color: '#666' }}>
                    Default: 2428. P2P swarm networking port.
                  </p>
                </div>
              </div>

              <div className="nodes-field">
                <button
                  onClick={handleStartNode}
                  className="button button-primary"
                  disabled={!selectedNode || loading || getRunningNodeInfo(selectedNode || "").running}
                >
                  {loading ? 'Starting...' : 'Start Node'}
                </button>
                {status.running && (
                  <p className="field-hint" style={{ marginTop: '8px', color: '#ef4444' }}>
                    A node is already running. Starting a new node will stop the current one.
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        {/* Running Nodes Section */}
        <div className="nodes-card">
          <h2>Running Nodes</h2>
          
          {runningNodes.length === 0 ? (
            <p className="field-hint">No running nodes detected.</p>
          ) : (
            <div className="nodes-list">
              {runningNodes.map((node) => (
                <div key={node.pid} className="node-item">
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                      {node.node_name}
                    </div>
                    <div style={{ fontSize: '12px', color: '#666' }}>
                      PID: {node.pid} | Server: {node.port} | Swarm: {node.swarm_port || 2428}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    {isNodeInUse(node) && (
                      <span style={{ fontSize: '12px', color: '#666', fontStyle: 'italic' }}>
                        In Use
                      </span>
                    )}
                    <button
                      onClick={() => handleUseNode(node)}
                      className="button button-primary"
                      disabled={isNodeInUse(node)}
                      style={{ fontSize: '12px', padding: '6px 12px' }}
                    >
                      Use
                    </button>
                    <button
                      onClick={() => handleStopNode(node.pid)}
                      className="button"
                      disabled={loading}
                      style={{ background: '#ef4444', color: 'white', fontSize: '12px', padding: '6px 12px' }}
                    >
                      {loading ? 'Stopping...' : 'Stop'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
