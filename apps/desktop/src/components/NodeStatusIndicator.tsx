import { useState, useRef, useEffect } from "react";
import { Server, ChevronDown } from "lucide-react";
import type { RunningMerodNode } from "../utils/merod";
import { listInstalledMerodVersions, formatVersionLabel, BUNDLED_VERSION_ID } from "../utils/merodVersions";
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
  const [nodeVersions, setNodeVersions] = useState<Record<string, string>>({});

  // Which binary each node runs, so the badge says what is actually being tested.
  useEffect(() => {
    if (!developerMode) return;
    listInstalledMerodVersions()
      .then((installed) => {
        const map: Record<string, string> = {};
        for (const entry of installed) {
          for (const node of entry.used_by) map[node] = entry.id;
        }
        setNodeVersions(map);
      })
      .catch(() => setNodeVersions({}));
  }, [developerMode, runningNodes]);

  const versionOf = (node?: RunningMerodNode) =>
    formatVersionLabel(nodeVersions[node?.node_name ?? ""] ?? BUNDLED_VERSION_ID, "");

  const currentNode = runningNodes?.find(
    (n) => `http://localhost:${n.port}` === currentNodeUrl,
  );

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
          ? `${error} Click to restart node.`
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
      {hasError && <span className="node-status-action">Restart Node →</span>}
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
