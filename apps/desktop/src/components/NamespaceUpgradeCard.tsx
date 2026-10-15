import { useCallback, useEffect, useState } from "react";
import { useMero, type Namespace } from "@calimero-network/mero-react";
import { ArrowUpCircle, CheckCircle2, Download, RefreshCw, AlertTriangle } from "lucide-react";
import { useToast } from "../contexts/ToastContext";
import { nodeErrorMessage } from "../lib/mero-client";
import { fetchAppVersions } from "../utils/registry";
import { getSettings } from "../utils/settings";
import { planUpgrade, readUpgradeProgress, type UpgradeStatusLike } from "../utils/appUpgrade";
import type { InstalledApp } from "../utils/namespaceApps";
import "./NamespaceUpgradeCard.css";

interface Props {
  ns: Namespace;
  /** The namespace's application as this node lists it; undefined when not installed. */
  app: InstalledApp | undefined;
  /** Admin of the namespace root: only an admin may install-and-upgrade it. */
  isAdmin: boolean;
  /** After an install: the page re-reads the installed apps. */
  onInstalled: () => void | Promise<void>;
  /** After an upgrade: the page re-reads the namespaces, whose `appVersion` moves. */
  onUpgraded: () => void | Promise<void>;
}

/** The newest release any configured registry lists for `pkg`, or null. */
async function newestPublished(pkg: string): Promise<string | null> {
  for (const registry of getSettings().registries ?? []) {
    try {
      const versions = await fetchAppVersions(registry, pkg);
      if (versions[0]) return versions[0].semver;
    } catch {
      // Try the next registry; one being down is not an answer.
    }
  }
  return null;
}

/**
 * Moves a namespace onto a newer release of its application.
 *
 * Two steps, because core keeps them apart (see `planUpgrade`): install the
 * release on this node, then upgrade the namespace, which publishes one signed
 * op every member follows by fetching the release from its own registry.
 * Members switch each context on its next use, so "done" here means this node
 * published the upgrade and swapped what it holds, not that every member has.
 */
export default function NamespaceUpgradeCard({ ns, app, isAdmin, onInstalled, onUpgraded }: Props) {
  const toast = useToast();
  const { mero } = useMero();
  const [published, setPublished] = useState<string | null>(null);
  const [publishedChecked, setPublishedChecked] = useState(false);
  const [status, setStatus] = useState<UpgradeStatusLike | null>(null);
  const [busy, setBusy] = useState<null | "install" | "upgrade" | "retry">(null);
  const [error, setError] = useState<string | null>(null);

  const pkg = app?.package ?? null;

  useEffect(() => {
    let cancelled = false;
    setPublishedChecked(false);
    if (!pkg) {
      setPublished(null);
      setPublishedChecked(true);
      return;
    }
    newestPublished(pkg).then((v) => {
      if (cancelled) return;
      setPublished(v);
      setPublishedChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [pkg]);

  const loadStatus = useCallback(async () => {
    if (!mero) return;
    try {
      setStatus((await mero.admin.getGroupUpgradeStatus(ns.namespaceId)) ?? null);
    } catch {
      // A namespace that was never upgraded has no row; nothing to show.
      setStatus(null);
    }
  }, [mero, ns.namespaceId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const progress = readUpgradeProgress(status);

  // Poll only while this node is still swapping contexts for a cascade.
  useEffect(() => {
    if (progress.kind !== "running") return;
    const timer = setInterval(() => void loadStatus(), 3000);
    return () => clearInterval(timer);
  }, [progress.kind, loadStatus]);

  const running = ns.appVersion ?? null;
  const installed = app?.installed ? app.version : null;
  const plan = planUpgrade({ running, installed, published });

  const install = async (version: string) => {
    if (!mero || !pkg) return;
    setBusy("install");
    setError(null);
    try {
      const { applicationId } = await mero.admin.installApplication({ package: pkg, version });
      // A bundle signed by another key derives another id; upgrading to it would
      // point the namespace at a different application.
      if (applicationId && applicationId !== ns.targetApplicationId) {
        throw new Error(
          `${pkg} ${version} installed as a different application (${applicationId.slice(0, 8)}…), ` +
            "probably signed by another key, so this namespace cannot upgrade to it.",
        );
      }
      toast.success(`Installed ${app?.name ?? pkg} ${version} on this node`);
      await onInstalled();
    } catch (e) {
      const msg = nodeErrorMessage(e, `Could not install ${version}`);
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  };

  const upgrade = async (version: string) => {
    if (!mero) return;
    setBusy("upgrade");
    setError(null);
    try {
      await mero.admin.upgradeGroup(ns.namespaceId, {
        // The same id the namespace runs: a bundle's id never changes, and the
        // node upgrades to the release its application row now names.
        targetApplicationId: ns.targetApplicationId,
        // Subgroups running the same release move with the namespace.
        cascade: true,
      });
      toast.success(`Upgrading ${ns.name || "namespace"} to ${version}`);
      await loadStatus();
      await onUpgraded();
    } catch (e) {
      const msg = nodeErrorMessage(e, `Could not upgrade to ${version}`);
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  };

  const retry = async () => {
    if (!mero) return;
    setBusy("retry");
    setError(null);
    try {
      await mero.admin.retryGroupUpgrade(ns.namespaceId);
      await loadStatus();
    } catch (e) {
      const msg = nodeErrorMessage(e, "Could not retry the upgrade");
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ns-upgrade-card" data-testid="ns-upgrade-card">
      <div className="ns-upgrade-versions">
        <div>
          <span className="field-label">Running</span>
          <span className="ns-upgrade-version" data-testid="ns-upgrade-running">
            {running ?? "not on this node yet"}
          </span>
        </div>
        <div>
          <span className="field-label">Installed on this node</span>
          <span className="ns-upgrade-version" data-testid="ns-upgrade-installed">
            {installed ?? "—"}
          </span>
        </div>
        <div>
          <span className="field-label">Latest published</span>
          <span className="ns-upgrade-version" data-testid="ns-upgrade-published">
            {published ?? (publishedChecked ? "unavailable" : "…")}
          </span>
        </div>
      </div>

      {progress.kind === "running" && (
        <div className="ns-upgrade-note" data-testid="ns-upgrade-progress">
          <RefreshCw size={14} className="ns-upgrade-spin" />
          Upgrading {progress.from} → {progress.to}
          {progress.total ? `: ${progress.swapped} of ${progress.total} contexts on this node` : "…"}
        </div>
      )}
      {progress.kind === "failed" && (
        <div className="ns-upgrade-note ns-upgrade-note-warn" data-testid="ns-upgrade-failed">
          <AlertTriangle size={14} />
          Upgrade to {progress.to}: {progress.failed} context{progress.failed === 1 ? "" : "s"} failed to switch on
          this node.
          {isAdmin && (
            <button className="ns-action-btn" onClick={retry} disabled={busy !== null}>
              {busy === "retry" ? "Retrying…" : "Retry"}
            </button>
          )}
        </div>
      )}

      {plan.kind === "current" && progress.kind !== "running" && (
        <div className="ns-upgrade-note" data-testid="ns-upgrade-current">
          <CheckCircle2 size={14} />
          Up to date.
          {progress.kind === "done" &&
            " Members switch each context to it the next time they use it."}
        </div>
      )}
      {plan.kind === "unknown" && (
        <div className="ns-upgrade-note" data-testid="ns-upgrade-unknown">
          This node doesn't hold the release this namespace runs yet. After an upgrade it fetches the new one the next
          time the app is used here.
        </div>
      )}

      {plan.kind === "install" &&
        (isAdmin ? (
          <div className="ns-upgrade-action">
            <span>
              {plan.version} is published. Install it on this node, then upgrade the namespace.
            </span>
            <button
              className="ns-action-btn ns-upgrade-primary"
              data-testid="ns-upgrade-install"
              onClick={() => install(plan.version)}
              disabled={busy !== null || !pkg}
            >
              <Download size={14} /> {busy === "install" ? "Installing…" : `Install ${plan.version}`}
            </button>
          </div>
        ) : (
          <div className="ns-upgrade-note">
            {plan.version} is available. An admin of this namespace can upgrade it.
          </div>
        ))}

      {plan.kind === "upgrade" &&
        progress.kind !== "running" &&
        (isAdmin ? (
          <div className="ns-upgrade-action">
            <span>
              Move this namespace and its subgroups from {running} to {plan.version}. Every member fetches it from
              their registry and switches on next use.
            </span>
            <button
              className="ns-action-btn ns-upgrade-primary"
              data-testid="ns-upgrade-upgrade"
              onClick={() => upgrade(plan.version)}
              disabled={busy !== null}
            >
              <ArrowUpCircle size={14} /> {busy === "upgrade" ? "Upgrading…" : `Upgrade to ${plan.version}`}
            </button>
          </div>
        ) : (
          <div className="ns-upgrade-note">
            {plan.version} is available. An admin of this namespace can upgrade it.
          </div>
        ))}

      {error && (
        <div className="ns-upgrade-note ns-upgrade-note-warn" role="alert" data-testid="ns-upgrade-error">
          <AlertTriangle size={14} /> {error}
        </div>
      )}
    </div>
  );
}
