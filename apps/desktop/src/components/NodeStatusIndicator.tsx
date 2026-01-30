import { Server } from "lucide-react";
import "./NodeStatusIndicator.css";

interface NodeStatusIndicatorProps {
  connected: boolean;
  error?: string | null;
  onClick?: () => void;
}

export function NodeStatusIndicator({
  connected,
  error,
  onClick,
}: NodeStatusIndicatorProps) {
  const hasError = !connected && error;
  const isClickable = hasError && onClick;

  return (
    <button
      type="button"
      className={`node-status-indicator ${connected ? "connected" : "disconnected"} ${isClickable ? "clickable" : ""}`}
      onClick={isClickable ? onClick : undefined}
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
      {hasError && <span className="node-status-action">Restart Node →</span>}
    </button>
  );
}
