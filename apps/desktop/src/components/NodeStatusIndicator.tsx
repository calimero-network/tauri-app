import { useState, useRef, useEffect } from "react";
import { Server, ChevronDown } from "lucide-react";
import type { RunningMerodNode } from "../utils/merod";
import { formatVersionLabel, BUNDLED_VERSION_ID } from "../utils/merodVersions";
import { useNodeVersions } from "../contexts/NodeVersionsContext";
import "./NodeStatusIndicator.css";

interface NodeStatusIndicatorProps {
  connected: boolean;
  error?: string | null;
  onClick?: () => void;
  developerMode?: boolean;
  runningNodes?: RunningMerodNode[];
  currentNodeUrl?: string;
  onSelectNode?: (nodeUrl: string) => void;
}

export function NodeStatusIndicator({
  connected,
  error,
  onClick,
  developerMode,
  runningNodes,
  currentNodeUrl,
  onSelectNode,
}: NodeStatusIndicatorProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { byNode: nodeVersions, measured: versionMeasured, bundled } = useNodeVersions();

  // Pass the measured version through, or a local build always reads as the
  // generic "local build" and a rebuild produces no visible signal here.
  const versionOf = (node?: RunningMerodNode) => {
    const id = nodeVersions[node?.node_name ?? ""] ?? BUNDLED_VERSION_ID;
    return formatVersionLabel(id, bundled, versionMeasured[id]);
  };

  // Running nodes are known by port only, so match on port whenever the desktop
  // is pointed at this machine - a literal localhost string missed 127.0.0.1.
  const currentNode = (() => {
    if (!currentNodeUrl) return undefined;
    let host: string;
    let port: string;
    try {
      const u = new URL(currentNodeUrl);
      host = u.hostname;
      port = u.port;
    } catch {
      return undefined;
    }
    // URL.hostname strips the brackets from an IPv6 literal, so '::1' is the form seen here.
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) return undefined;
    return runningNodes?.find((n) => String(n.port) === port);
  })();

  const hasError = !connected && error;
  const isClickable = hasError && onClick;
  const showDropdown = developerMode && (runningNodes?.length ?? 0) > 1 && onSelectNode;

  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [dropdownOpen]);

  const handleToggle = () => {
    if (showDropdown) setDropdownOpen((v) => !v);
    else if (isClickable && onClick) onClick();
  };

  const handleSelectNode = (node: RunningMerodNode) => {
    const url = `http://localhost:${node.port}`;
    onSelectNode?.(url);
    setDropdownOpen(false);
  };

  const baseButton = (
    <button
      type="button"
      className={`node-status-indicator ${connected ? "connected" : "disconnected"} ${isClickable || showDropdown ? "clickable" : ""} ${showDropdown ? "has-dropdown" : ""}`}
      onClick={handleToggle}
      title={
        hasError
          ? `${error} Click to reconnect.`
          : connected
          ? "Node connected"
          : "Node disconnected"
      }
    >
      <span className="node-status-dot" />
      <Server size={14} className="node-status-icon" />
      <span className="node-status-label">
        {connected ? "Connected" : "Disconnected"}
      </span>
      {developerMode && connected && currentNode && (
        <span className="node-status-version">
          {currentNode.node_name} &middot; {versionOf(currentNode)}
        </span>
      )}
      {hasError && <span className="node-status-action">Reconnect →</span>}
      {showDropdown && <ChevronDown size={14} className="node-status-chevron" />}
    </button>
  );

  if (!showDropdown) return baseButton;

  return (
    <div className="node-status-dropdown-container" ref={containerRef}>
      {baseButton}
      {dropdownOpen && runningNodes && (
        <div className="node-status-dropdown">
          {runningNodes.map((node) => {
            const url = `http://localhost:${node.port}`;
            const isSelected = currentNodeUrl === url;
            return (
              <button
                key={`${node.pid}-${node.port}`}
                type="button"
                className={`node-status-dropdown-item ${isSelected ? "selected" : ""}`}
                onClick={() => handleSelectNode(node)}
              >
                {node.node_name} (port {node.port})
                <span className="node-status-dropdown-version">{versionOf(node)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
