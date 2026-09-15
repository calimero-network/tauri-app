import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./contexts/ThemeContext";
import { ToastProvider } from "./contexts/ToastContext";
import { NodeVersionsProvider } from "./contexts/NodeVersionsContext";
import ErrorBoundary from "./components/ErrorBoundary";
import { installRefreshSingleFlight } from "./lib/token-broker";
import { installInputHygiene } from "./utils/inputHygiene";
import "./index.css";

// Before anything can construct a MeroJs and start talking to the node: refresh
// tokens are single-use (calimero-network/core#3083), and the desktop runs
// several MeroJs instances that each dedupe refreshes only among their own
// requests. Without this, a burst of 401s fires several concurrent
// POST /auth/refresh calls carrying the same token — the node consumes it once
// and treats the rest as theft, revoking the family and logging everyone out.
installRefreshSingleFlight();

// macOS capitalises the first letter of every field and autocorrects the
// rest. Almost nothing this app asks for is a sentence — usernames, node
// names, package ids, ports, keys — so the substitutions are turned off
// once, here, for fields that exist now and for every one mounted later.
installInputHygiene();

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

