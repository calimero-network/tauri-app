import { useCallback, useEffect, useState } from "react";
import { useMero, type Namespace } from "@calimero-network/mero-react";
import type { ContextWithGroup } from "@calimero-network/mero-js";
import { ArrowUpCircle, CheckCircle2, Download, RefreshCw, AlertTriangle } from "lucide-react";
import { useToast } from "../contexts/ToastContext";
import { nodeErrorMessage } from "../lib/mero-client";
import { fetchAppVersions } from "../utils/registry";
import { getSettings } from "../utils/settings";
import { planUpgrade, readUpgradeProgress, type UpgradeStatusLike } from "../utils/appUpgrade";
import { behindContexts, behindPhrase, runningLabel, switchNamespace, type FailedContext } from "../utils/memberSwitch";
import type { InstalledApp } from "../utils/namespaceApps";
import "./NamespaceUpgradeCard.css";

interface Props {
  ns: Namespace;
  /** The namespace's application as this node lists it; undefined when not installed. */
  app: InstalledApp | undefined;
  /** The namespace and every subgroup of it, to tell which contexts this node holds for it. */
  groupIds: string[];
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
export default function NamespaceUpgradeCard({ ns, app, groupIds, isAdmin, onInstalled, onUpgraded }: Props) {
  const toast = useToast();
  const { mero } = useMero();
  const [published, setPublished] = useState<string | null>(null);
  const [publishedChecked, setPublishedChecked] = useState(false);
  const [status, setStatus] = useState<UpgradeStatusLike | null>(null);
  const [busy, setBusy] = useState<null | "install" | "upgrade" | "retry" | "switch">(null);
  const [switchStep, setSwitchStep] = useState<null | "installing" | "switching">(null);
  const [switchFailed, setSwitchFailed] = useState<FailedContext[]>([]);
  const [moved, setMoved] = useState(false);
  const [contexts, setContexts] = useState<ContextWithGroup[]>([]);
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

  const loadContexts = useCallback(async () => {
    if (!mero) return;
    try {
      setContexts((await mero.admin.getContexts()).contexts);
    } catch {
      // Not knowing what this node runs is not "behind".
      setContexts([]);
    }
  }, [mero]);

  // The listing's release moves when the admin upgrades; what this node runs follows only a switch.
  useEffect(() => {
    void loadContexts();
  }, [loadContexts, ns.appVersion]);

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
  const behind = behindContexts(ns, contexts, groupIds).length > 0;
  const adminActionPending = isAdmin && (plan.kind === "install" || plan.kind === "upgrade");
  const showSwitch = behind && !adminActionPending && progress.kind !== "running";

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
      // The upgrade moves the namespace, not this node's own contexts: switch them onto the new target.
      await applySwitch(await mero.admin.getNamespace(ns.namespaceId), true);
    } catch (e) {
      const msg = nodeErrorMessage(e, `Could not upgrade to ${version}`);
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  };

  const applySwitch = async (target: Namespace, installedOnTarget: boolean) => {
    if (!mero) return;
    setBusy("switch");
    setError(null);
    setMoved(false);
    setSwitchFailed([]);
    try {
      const out = await switchNamespace(mero, target, installedOnTarget, setSwitchStep);
      if (out.kind === "error") {
        setError(out.message);
        toast.error(out.message);
      } else if (out.kind === "moved") setMoved(true);
      else setSwitchFailed(out.failed);
      await Promise.all([loadContexts(), onInstalled(), onUpgraded()]);
    } finally {
      setBusy(null);
      setSwitchStep(null);
    }
  };

  const switchNow = () => applySwitch(ns, installed !== null && installed === running);

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
          <span className="field-label">Namespace release</span>
          <span className="ns-upgrade-version" data-testid="ns-upgrade-target">
            {running ?? "not known yet"}
          </span>
        </div>
        <div>
          <span className="field-label">Running on this node</span>
          <span className="ns-upgrade-version" data-testid="ns-upgrade-running">
            {runningLabel(ns, contexts, groupIds)}
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

      {plan.kind === "current" && progress.kind !== "running" && !behind && (
        <div className="ns-upgrade-note" data-testid="ns-upgrade-current">
          <CheckCircle2 size={14} />
          Up to date.
          {progress.kind === "done" &&
            " Members switch each context to it the next time they use it."}
        </div>
      )}
      {plan.kind === "unknown" && !showSwitch && (
        <div className="ns-upgrade-note" data-testid="ns-upgrade-unknown">
          This node doesn't hold the release this namespace runs yet. After an upgrade it fetches the new one the next
          time the app is used here.
        </div>
      )}

      {switchFailed.length > 0 && (
        <div className="ns-upgrade-note ns-upgrade-note-warn" data-testid="ns-upgrade-switch-failed">
          <AlertTriangle size={14} />
          {switchFailed.length} context{switchFailed.length === 1 ? "" : "s"} failed to switch on this node.
          {switchFailed.some((f) => f.retryable) && (
            <button
              className="ns-action-btn"
              data-testid="ns-upgrade-switch-retry"
              onClick={switchNow}
              disabled={busy !== null}
            >
              Retry
            </button>
          )}
        </div>
      )}
      {showSwitch && switchFailed.length === 0 && (
        <div className="ns-upgrade-action">
          {busy === "switch" ? (
            <span data-testid="ns-upgrade-switching">Migrating your data. Keep Calimero open.</span>
          ) : moved ? (
            <span data-testid="ns-upgrade-moved">
              The admin moved this namespace to {running} while this node was switching.
            </span>
          ) : (
            <span data-testid="ns-upgrade-behind">
              The admin moved this namespace to {running}. {behindPhrase(ns, contexts, groupIds, "contexts")}
            </span>
          )}
          <button
            className="ns-action-btn ns-upgrade-primary"
            data-testid="ns-upgrade-switch"
            onClick={switchNow}
            disabled={busy !== null}
          >
            <RefreshCw size={14} className={busy === "switch" ? "ns-upgrade-spin" : undefined} />
            {busy !== "switch" ? (moved ? `Switch to ${running}` : "Switch now") : switchStep === "installing" ? `Installing ${running}...` : "Switching..."}
          </button>
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
