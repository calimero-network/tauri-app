import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import { useMero } from "@calimero-network/mero-react";
import { invalidateInstalledApps } from "../utils/installedAppsCache";
import { switchNamespace } from "../utils/memberSwitch";
import { readInstalledApps } from "../utils/namespaceApps";
import { behindNamespaces, registerGateHost, type BehindNamespace, type GateRequest } from "../utils/upgradeGate";
import "./AccountPanel.css";
import "./DeepLinkConsentDialog.css";

interface Open {
  req: GateRequest;
  behind: BehindNamespace[];
}

/**
 * The launch gate's modal: asks the user to switch this node onto the release a
 * namespace moved to before its app opens. Mounted once; `openAppFrontend` talks
 * to it through `confirmAppUpToDate`.
 */
export default function UpgradeGateHost() {
  const { mero } = useMero();
  const meroRef = useRef(mero);
  meroRef.current = mero;
  const asking = useRef(false);
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      registerGateHost(async (req) => {
        const m = meroRef.current;
        if (!m) return req.resolve(true);
        // One question at a time: a second launch while one is on screen waits for a fresh click.
        if (asking.current) return req.resolve(false);
        asking.current = true;
        const behind = await behindNamespaces(m, req.appId);
        if (behind.length === 0) {
          asking.current = false;
          return req.resolve(true);
        }
        setOpen({ req, behind });
      }),
    [],
  );

  if (!open) return null;
  const { req, behind } = open;

  const finish = (openApp: boolean) => {
    asking.current = false;
    setOpen(null);
    setError(null);
    req.resolve(openApp);
  };

  const update = async () => {
    if (!mero) return;
    setBusy(true);
    setError(null);
    try {
      invalidateInstalledApps();
      const apps = await readInstalledApps();
      for (const { ns } of behind) {
        const row = apps.find((a) => a.id === ns.targetApplicationId);
        const out = await switchNamespace(mero, ns, !!row?.installed && row.version === ns.appVersion);
        if (out.kind === "moved") {
          const fresh = await behindNamespaces(mero, req.appId);
          if (fresh.length === 0) return finish(true);
          return setOpen({ req, behind: fresh });
        }
        if (out.kind === "error") return setError(out.message);
        if (out.failed.length) {
          const n = out.failed.length;
          return setError(`${n} context${n === 1 ? "" : "s"} failed to switch on this node.`);
        }
      }
      finish(true);
    } finally {
      setBusy(false);
    }
  };

  const [first] = behind;
  const title = `${req.appName} was updated`;
  const nsName = (b: BehindNamespace) => b.ns.name || b.ns.namespaceId.slice(0, 8);

  return createPortal(
    <div className="account-modal-backdrop">
      <div className="account-modal" role="alertdialog" aria-modal="true" aria-label={title} data-testid="upgrade-gate">
        <div className="account-modal-header">
          <h2>{title}</h2>
        </div>
        <div className="account-modal-body deep-link-consent">
          {busy ? (
            <p data-testid="upgrade-gate-switching">Migrating your data. Keep Calimero open.</p>
          ) : behind.length === 1 ? (
            <p>
              The admin of {nsName(first)} moved it to {first.ns.appVersion}. {first.summary} Update to keep using{" "}
              {req.appName}.
            </p>
          ) : (
            <>
              <p>Update to keep using {req.appName}.</p>
              <ul>
                {behind.map((b) => (
                  <li key={b.ns.namespaceId}>
                    {nsName(b)}: the admin moved it to {b.ns.appVersion}. {b.summary}
                  </li>
                ))}
              </ul>
            </>
          )}

          {error && (
            <p className="deep-link-consent-warning" role="alert" data-testid="upgrade-gate-error">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>{error}</span>
            </p>
          )}

          <div className="deep-link-consent-actions">
            {!busy && (
              <button type="button" className="button button-secondary" onClick={() => finish(false)}>
                Cancel
              </button>
            )}
            <button
              type="button"
              className="button button-primary"
              data-testid="upgrade-gate-update"
              autoFocus
              disabled={busy}
              onClick={update}
            >
              {busy
                ? "Updating..."
                : error
                  ? "Retry"
                  : behind.length === 1
                    ? `Update to ${first.ns.appVersion}`
                    : `Update ${behind.length} namespaces`}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
