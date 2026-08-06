import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./contexts/ThemeContext";
import { ToastProvider } from "./contexts/ToastContext";
import { NodeVersionsProvider } from "./contexts/NodeVersionsContext";
import ErrorBoundary from "./components/ErrorBoundary";
import { installRefreshSingleFlight } from "./lib/token-broker";
import "./index.css";

// Before anything can construct a MeroJs and start talking to the node: refresh
// tokens are single-use (calimero-network/core#3083), and the desktop runs
// several MeroJs instances that each dedupe refreshes only among their own
// requests. Without this, a burst of 401s fires several concurrent
// POST /auth/refresh calls carrying the same token — the node consumes it once
// and treats the rest as theft, revoking the family and logging everyone out.
installRefreshSingleFlight();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <NodeVersionsProvider>
          <ErrorBoundary componentName="Calimero Desktop">
            <Suspense fallback={null}>
              <App />
            </Suspense>
          </ErrorBoundary>
        </NodeVersionsProvider>
      </ToastProvider>
    </ThemeProvider>
  </React.StrictMode>
);

