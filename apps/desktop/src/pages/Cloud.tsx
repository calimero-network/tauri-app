import { useCallback, useEffect, useMemo, useState } from "react";
import { useMero, useNamespaces, useNodeIdentity } from "@calimero-network/mero-react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, Cloud as CloudIcon, Cpu, Lock, MonitorSmartphone, Search, ShieldCheck, Zap } from "lucide-react";
import AppIcon from "../components/AppIcon";
import { useToast } from "../contexts/ToastContext";
import { useCloudSession } from "../hooks/useCloudSession";
import { useHaStatus } from "../hooks/useHaStatus";
import { useVisiblePoll } from "../hooks/useVisiblePoll";
import { CloudSessionExpiredError, getCloudSubscription } from "../utils/cloudApi";
import { disconnectCloud, getCloudIdToken, startCloudLogin } from "../utils/cloudAuth";
import { enableableIds, filterGroups, groupForCloud, type HaAppGroup, type HaFilter, type HaRow } from "../utils/cloudHa";
import { formatBytes, parseUsage, sumUsage, usageFor, type NamespaceBytes } from "../utils/diskUsage";
import { fetchGroupMembers, roleOf } from "../utils/groupRoles";
import { readInstalledApps, type InstalledApp } from "../utils/namespaceApps";
import { getSettings } from "../utils/settings";
import "./Cloud.css";

const CLOUD_PORTAL_URL = "https://cloud.calimero.network";

const FILTERS: { id: HaFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "off", label: "Not always on" },
  { id: "shared", label: "Shared with me" },
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Calimero Cloud in one place: the signed-in account and its plan, and High
 * Availability for every namespace on this node, grouped by application.
 *
 * HA used to be a section at the bottom of each namespace's detail view, three
 * levels into the Namespaces page (which itself only shows in Developer Mode).
 * This page lists every namespace with its own switch, so turning HA on is one
 * click from the sidebar.
 */
export default function Cloud() {
  const toast = useToast();
  const { mero } = useMero();
  const session = useCloudSession();
  const connected = session === "connected";
  const ha = useHaStatus(!!mero);

  const { namespaces, loading, error, refetch } = useNamespaces();
  useVisiblePoll(() => { void refetch(); }, 30000);

  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  useEffect(() => {
    readInstalledApps().then(setInstalledApps).catch(() => setInstalledApps([]));
  }, []);
  const appById = useMemo(
    () => Object.fromEntries(installedApps.map((a) => [a.id, a])) as Record<string, InstalledApp>,
    [installedApps],
  );

  // Disk used per namespace on this node; `null` when the node cannot say.
  const [usage, setUsage] = useState<Map<string, NamespaceBytes> | null>(null);
  useVisiblePoll(() => {
    if (!mero) return;
    mero.admin.getUsage().then((raw) => setUsage(parseUsage(raw))).catch(() => setUsage(null));
  }, 60000);

  // This node's role on each namespace root. Only the root's Admin can change
  // HA, so every other namespace is listed but locked.
  const { identity } = useNodeIdentity();
  const accountId = identity?.accountId;
  const namespaceIds = namespaces.map((n) => n.namespaceId).join(",");
  const [roles, setRoles] = useState<Record<string, string | undefined>>({});
  useEffect(() => {
    const ids = namespaceIds ? namespaceIds.split(",") : [];
    if (!accountId || ids.length === 0) return;
    let cancelled = false;
    void Promise.all(
      ids.map(async (id) => [id, roleOf(await fetchGroupMembers(id), accountId)] as const),
    ).then((entries) => {
      if (!cancelled) setRoles(Object.fromEntries(entries));
    });
    return () => { cancelled = true; };
  }, [namespaceIds, accountId]);

  const [plan, setPlan] = useState<string | null>(null);
  useEffect(() => {
    const token = getCloudIdToken();
    if (!connected || !token) { setPlan(null); return; }
    let cancelled = false;
    getCloudSubscription(token)
      .then((sub) => { if (!cancelled) setPlan(sub?.plan ?? null); })
      .catch((err) => {
        if (cancelled || !(err instanceof CloudSessionExpiredError)) return;
        disconnectCloud();
        toast.error("Cloud session expired — sign in again");
      });
    return () => { cancelled = true; };
  }, [connected, toast]);

  const [signingIn, setSigningIn] = useState(false);
  const signIn = useCallback(async () => {
    setSigningIn(true);
    try {
      const user = await startCloudLogin();
      if (user) toast.success("Connected to Calimero Cloud");
      else toast.error("Cloud sign-in timed out or was cancelled");
    } catch (err) {
      toast.error(`Cloud sign-in failed: ${String(err)}`);
    } finally {
      setSigningIn(false);
    }
  }, [toast]);

  const groups = useMemo(
    () =>
      groupForCloud(
        namespaces.map((ns) => ({
          namespaceId: ns.namespaceId,
          targetApplicationId: ns.targetApplicationId,
          name: (ns as { name?: string }).name,
          memberCount: (ns as { memberCount?: number }).memberCount,
        })),
        appById,
        roles,
        ha.haEnabled,
      ),
    [namespaces, appById, roles, ha.haEnabled],
  );

  const [filter, setFilter] = useState<HaFilter>("all");
  const [query, setQuery] = useState("");
  const visible = useMemo(() => filterGroups(groups, filter, query), [groups, filter, query]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapsed = (applicationId: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(applicationId)) next.delete(applicationId);
      else next.add(applicationId);
      return next;
    });
  // Turning HA off makes the fleet nodes leave and delete their copy, so it
  // asks first; turning it on does not.
  const [confirmOff, setConfirmOff] = useState<string | null>(null);

  const manageable = groups.reduce((n, g) => n + g.manageable, 0);
  const manageableOn = groups.reduce((n, g) => n + g.manageableOn, 0);
  const onIds = groups.flatMap((g) => g.rows.filter((r) => r.haOn).map((r) => r.namespaceId));
  const fleetActive = onIds.reduce((n, id) => n + (ha.replicas[id]?.active ?? 0), 0);
  const fleetAssigned = onIds.reduce((n, id) => n + (ha.replicas[id]?.assigned ?? 0), 0);
  const bytesOn = sumUsage(usage, onIds);
  const allOff = enableableIds(groups);
  const rolesLoading = !!accountId && namespaces.some((n) => !(n.namespaceId in roles));

  const user = getSettings();

  const renderRow = (row: HaRow) => {
    const busy = !!ha.haEnabling[row.namespaceId];
    const bytes = usageFor(usage, row.namespaceId);
    const fleet = ha.replicas[row.namespaceId];
    const confirming = confirmOff === row.namespaceId;
    let status: { label: string; tone: "on" | "off" | "busy" };
    if (busy) status = { label: row.haOn ? "Turning off…" : "Turning on…", tone: "busy" };
    else if (row.haOn) status = { label: "Always on", tone: "on" };
    else status = { label: "Off", tone: "off" };

    return (
      <div key={row.namespaceId} className="cloud-ns-row" data-testid="cloud-ns-row" data-namespace-id={row.namespaceId}>
        <div className="cloud-ns-name">
          <span className="cloud-ns-title">{row.name}</span>
          <span className="cloud-ns-id" title={row.namespaceId}>
            {row.namespaceId.slice(0, 8)}…{row.namespaceId.slice(-6)}
          </span>
        </div>
        <span className="cloud-ns-meta">
          {row.memberCount !== null ? plural(row.memberCount, "member") : ""}
        </span>
        <span className="cloud-ns-meta" title="Disk used on this node (estimate)">
          {bytes ? formatBytes(bytes.total) : ""}
        </span>
        {confirming ? (
          <div className="cloud-ns-confirm" role="group" aria-label={`Turn off High Availability for ${row.name}`}>
            <span>Fleet nodes will leave and delete their copy.</span>
            <button
              className="button button-small button-danger"
              onClick={() => { setConfirmOff(null); void ha.toggleHa(row.namespaceId); }}
            >
              Turn off
            </button>
            <button className="button button-small button-secondary" onClick={() => setConfirmOff(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            <span
              className={`cloud-pill cloud-pill-${status.tone}`}
              title={fleet && row.haOn ? `${fleet.active} of ${fleet.assigned} fleet nodes active` : undefined}
            >
              {status.label}
              {fleet && row.haOn && !busy && fleet.assigned > 0 ? ` · ${fleet.active}/${fleet.assigned}` : ""}
            </span>
            {row.canManage === true ? (
              <button
                type="button"
                role="switch"
                className="cloud-switch"
                aria-checked={row.haOn}
                aria-label={`High Availability for ${row.name}`}
                disabled={busy || !connected}
                onClick={() => {
                  if (row.haOn) setConfirmOff(row.namespaceId);
                  else void ha.toggleHa(row.namespaceId);
                }}
              />
            ) : (
              <span
                className="cloud-ns-lock"
                title={
                  row.canManage === null
                    ? "Checking your role…"
                    : "Only the namespace admin can change High Availability"
                }
              >
                {row.canManage === null ? "…" : <Lock size={14} />}
              </span>
            )}
          </>
        )}
      </div>
    );
  };

  const renderGroup = (g: HaAppGroup) => {
    const isCollapsed = collapsed.has(g.applicationId) && !query;
    const title = g.app?.name ?? "Unknown application";
    const offIds = g.rows.filter((r) => r.canManage === true && !r.haOn).map((r) => r.namespaceId);
    const total = groups.find((x) => x.applicationId === g.applicationId)?.rows.length ?? g.rows.length;
    const pct = g.manageable > 0 ? (g.manageableOn / g.manageable) * 100 : 0;
    return (
      <section key={g.applicationId} className={`cloud-app${isCollapsed ? " collapsed" : ""}`} data-testid="cloud-app">
        <div
          className="cloud-app-header"
          role="button"
          tabIndex={0}
          aria-expanded={!isCollapsed}
          onClick={() => toggleCollapsed(g.applicationId)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCollapsed(g.applicationId); }
          }}
        >
          <ChevronRight size={16} className="cloud-app-chevron" />
          <AppIcon icon={g.app?.icon ?? undefined} name={title} seed={g.app?.package ?? g.applicationId} size={32} />
          <div className="cloud-app-headings">
            <span className="cloud-app-title">{title}</span>
            <span className="cloud-app-sub">
              {g.app?.package ?? g.applicationId.slice(0, 12)}
              {g.app?.version ? ` · v${g.app.version}` : ""} · {plural(total, "namespace")}
            </span>
          </div>
          <div className="cloud-app-meter">
            {g.manageable > 0 ? (
              <>
                <div className="cloud-meter-bar"><i style={{ width: `${pct}%` }} /></div>
                <span>{g.manageableOn} of {g.manageable} always on</span>
              </>
            ) : (
              <span>Shared with you</span>
            )}
          </div>
          <div className="cloud-app-action">
            {connected && offIds.length > 0 && (
              <button
                className="button button-small button-secondary"
                onClick={(e) => { e.stopPropagation(); void ha.enableMany(offIds); }}
                disabled={offIds.some((id) => ha.haEnabling[id])}
              >
                {offIds.length === 1 ? "Turn on" : `Turn on ${offIds.length}`}
              </button>
            )}
            {g.manageable > 0 && offIds.length === 0 && g.manageableOn === g.manageable && (
              <span className="cloud-pill cloud-pill-on"><ShieldCheck size={12} /> All on</span>
            )}
          </div>
        </div>
        {!isCollapsed && <div className="cloud-app-rows">{g.rows.map(renderRow)}</div>}
      </section>
    );
  };

  return (
    <div className="cloud-page" data-testid="cloud-page">
      <div className="cloud-page-header">
        <h1>Cloud</h1>
        <p>Keep your namespaces online and in sync, even when this computer is off.</p>
      </div>

      {!connected ? (
        <div className="cloud-connect" data-tutorial="cloud-account">
          <div className="cloud-connect-icon"><CloudIcon size={26} /></div>
          <h2>{session === "expired" ? "Your cloud session expired" : "Connect Calimero Cloud"}</h2>
          <p>
            {session === "expired"
              ? "Sign in again to see and change High Availability for your namespaces."
              : "Sign in once, then turn on High Availability for any namespace with one switch."}
          </p>
          <div className="cloud-benefits">
            <div><b><Zap size={14} /> Always on</b><span>Fleet nodes keep your namespaces syncing when your devices are off.</span></div>
            <div><b><Cpu size={14} /> Runs in TEEs</b><span>Replicas run inside attested secure enclaves.</span></div>
            <div><b><MonitorSmartphone size={14} /> Any device</b><span>New devices catch up from the fleet.</span></div>
          </div>
          <button className="button button-primary" onClick={() => void signIn()} disabled={signingIn}>
            {signingIn ? "Waiting for sign-in…" : session === "expired" ? "Sign in again" : "Sign in to Calimero Cloud"}
          </button>
          <span className="cloud-connect-note">High Availability needs a paid plan. Your data stays on your device until you turn it on.</span>
        </div>
      ) : (
        <>
          <div className="cloud-account" data-tutorial="cloud-account">
            {user.cloudUserPicture ? (
              <img src={user.cloudUserPicture} alt="" className="cloud-avatar" />
            ) : (
              <span className="cloud-avatar cloud-avatar-letter">
                {(user.cloudUserName || user.cloudUserEmail || "?").charAt(0).toUpperCase()}
              </span>
            )}
            <div className="cloud-account-meta">
              <span className="cloud-account-name">{user.cloudUserName || "Connected"}</span>
              <span className="cloud-account-email">{user.cloudUserEmail}</span>
            </div>
            {plan && <span className="cloud-pill cloud-pill-plan">{plan} plan</span>}
            <div className="cloud-account-actions">
              <button
                className="button button-small button-secondary"
                onClick={() => void invoke("open_url_in_browser", { url: CLOUD_PORTAL_URL })}
              >
                Manage plan
              </button>
              <button
                className="button button-small button-secondary"
                onClick={() => { disconnectCloud(); toast.success("Disconnected from Calimero Cloud"); }}
              >
                Disconnect
              </button>
            </div>
          </div>

          <div className="cloud-stats">
            <div className="cloud-stat cloud-stat-accent">
              <span className="cloud-stat-value">
                {manageableOn} <small>of {manageable}</small>
              </span>
              <span className="cloud-stat-label">Your namespaces always on</span>
            </div>
            <div className="cloud-stat">
              <span className="cloud-stat-value">
                {fleetAssigned > 0 ? <>{fleetActive} <small>of {fleetAssigned}</small></> : "—"}
              </span>
              <span className="cloud-stat-label">Fleet nodes active</span>
            </div>
            <div className="cloud-stat">
              <span className="cloud-stat-value">{bytesOn !== null ? formatBytes(bytesOn) : "—"}</span>
              <span className="cloud-stat-label">Kept always on (estimate)</span>
            </div>
          </div>

          <div className="cloud-list" data-tutorial="cloud-apps">
            <div className="cloud-list-toolbar">
              <span className="cloud-list-title">Applications</span>
              <div className="cloud-filters" role="group" aria-label="Filter namespaces">
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    className={`cloud-filter${filter === f.id ? " active" : ""}`}
                    aria-pressed={filter === f.id}
                    onClick={() => setFilter(f.id)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <label className="cloud-search">
                <Search size={13} />
                <input
                  id="cloud-search"
                  type="search"
                  placeholder="Search apps or namespaces"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              {allOff.length > 1 && (
                <button
                  className="button button-small button-primary"
                  onClick={() => void ha.enableMany(allOff)}
                  disabled={allOff.some((id) => ha.haEnabling[id])}
                >
                  Turn on all {allOff.length}
                </button>
              )}
            </div>

            {error && namespaces.length === 0 ? (
              <p className="cloud-empty">Could not load namespaces from your node: {error.message}</p>
            ) : loading && namespaces.length === 0 ? (
              <p className="cloud-empty">Loading namespaces…</p>
            ) : groups.length === 0 ? (
              <p className="cloud-empty">
                No namespaces on this node yet. Namespaces you create or join show up here.
              </p>
            ) : visible.length === 0 ? (
              <p className="cloud-empty">Nothing matches this filter.</p>
            ) : (
              visible.map(renderGroup)
            )}
            {rolesLoading && groups.length > 0 && (
              <p className="cloud-list-note">Checking which namespaces you administer…</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
