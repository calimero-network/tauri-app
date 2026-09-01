import { useState, useEffect } from "react";
import { KeyRound } from "lucide-react";
import CopyButton from "./CopyButton";
import { SkeletonText } from "./Skeleton";
import {
  listAccountApplications,
  refusalStatus,
  listAccountDevices,
  listNamespaces,
  pairInit,
  pairComplete,
  normalizeConfirmationCode,
  validatePairPayload,
  type AccountApplication,
  type NamespaceSummary,
  type PairInitResult,
  type PairCompleteResult,
} from "../lib/device-link";
import { decodeMetadata, parseTauriError } from "../utils/appUtils";
import { listInstalledApps, invalidateInstalledApps } from "../utils/installedAppsCache";
import { fetchNodeIdentity, type NodeIdentity } from "../utils/nodeIdentity";
import { apiClient } from "../lib/mero-client";
import { truncateText } from "../utils/string";

/** Marks a blob as the invite the account holder hands out. */
const INVITE_PREFIX = "mero-pair:";
/** Marks a blob as the new device's answer. Never carries the confirmation code. */
const REPLY_PREFIX = "mero-pair-reply:";
/** How often, and for how long, we watch for the new device to show up in the listing. */
const POLL_INTERVAL_MS = 1000;
const POLL_CEILING_MS = 15000;

/** An application the invite offers to install. The device holds only core's
 *  content-hash id, which no registry resolves, so the holder passes the URL it
 *  installed from; the same artifact yields the same id. */
export interface PairInviteApp {
  source: string;
  metadata?: number[] | string;
}

export interface PairInvite {
  rootKey: string;
  namespaces: string[];
  apps?: PairInviteApp[];
}

/** Fetched over the network on the strength of a pasted blob, so anything but a
 *  web URL is dropped rather than handed to the node. */
export function installableApps(value: unknown): PairInviteApp[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const source = str((entry as PairInviteApp | undefined)?.source);
    if (!/^https?:\/\//i.test(source)) return [];
    const metadata = (entry as PairInviteApp).metadata;
    return [{ source, ...(metadata === undefined ? {} : { metadata }) }];
  });
}

export type PairReply = Omit<PairInitResult, "accountId" | "confirmationCode">;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function encodeBlob(prefix: string, value: object): string {
  return prefix + btoa(JSON.stringify(value));
}

function decodeBlob(prefix: string, blob: string): Record<string, unknown> | null {
  const text = blob.trim();
  if (!text.startsWith(prefix)) return null;
  try {
    const parsed = JSON.parse(atob(text.slice(prefix.length)));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function encodeInvite(invite: PairInvite): string {
  return encodeBlob(INVITE_PREFIX, invite);
}

export function decodeInvite(blob: string): PairInvite | null {
  const body = decodeBlob(INVITE_PREFIX, blob);
  const rootKey = str(body?.rootKey);
  const namespaces = Array.isArray(body?.namespaces)
    ? body.namespaces.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  // Core refuses an empty namespace list, so an invite carrying none is not one.
  if (!rootKey || !namespaces.length) return null;
  const apps = installableApps(body?.apps);
  return { rootKey, namespaces, ...(apps.length ? { apps } : {}) };
}

/** The confirmation code is deliberately left out: a code that travels with the
 *  keys it describes proves nothing, since one forger rewrites both. */
export function encodeReply(result: PairInitResult): string {
  return encodeBlob(REPLY_PREFIX, {
    deviceId: result.deviceId,
    kemPublicKey: result.kemPublicKey,
    signPublicKey: result.signPublicKey,
    statement: result.statement,
  });
}

export function decodeReply(blob: string): PairReply | null {
  const body = decodeBlob(REPLY_PREFIX, blob);
  if (!body) return null;
  return {
    deviceId: str(body.deviceId),
    kemPublicKey: str(body.kemPublicKey),
    signPublicKey: str(body.signPublicKey),
    statement: str(body.statement),
  };
}

/** What the new device listens on: every namespace, or those the chosen
 *  applications target. `undefined` applications is "everything". */
export function inviteNamespaces(
  namespaces: NamespaceSummary[],
  applications?: string[],
): string[] {
  const chosen = applications
    ? namespaces.filter((ns) => applications.includes(ns.targetApplicationId))
    : namespaces;
  return chosen.map((ns) => ns.namespaceId);
}

/** What the label needs off an installed application; the node's row carries more. */
export interface InstalledApp {
  id: string;
  name?: string;
  metadata?: number[] | string;
  /** Where the node fetched it from. A local path for a hand-installed app. */
  source?: string;
}

/** The apps an invite offers to install: those in scope that the holder can point
 *  at a URL. An undefined scope is every application, the same as core reads it. */
export function inviteApps(
  applications: string[] | undefined,
  installed: InstalledApp[],
): PairInviteApp[] {
  const scoped = applications && new Set(applications);
  return installableApps(
    installed
      .filter((app) => !scoped || scoped.has(app.id))
      .map((app) => ({ source: app.source, metadata: app.metadata })),
  );
}

/** The namespaces an application is spoken in, named where they have names. A
 *  scope is chosen per application, so this says what picking one would cover. */
export function applicationNamespaces(
  applicationId: string,
  namespaces: NamespaceSummary[],
): string {
  return namespaces
    .filter((ns) => ns.targetApplicationId === applicationId)
    .map((ns) => ns.name || truncateText(ns.namespaceId, 8))
    .join(", ");
}

/** The lines one scope choice shows: its name, then the namespaces it covers
 *  when those say something the name did not already. */
export function scopeRow(
  applicationId: string,
  namespaces: NamespaceSummary[],
  installed?: InstalledApp[],
): string[] {
  const name = applicationLabel(applicationId, namespaces, installed);
  const covered = applicationNamespaces(applicationId, namespaces);
  return covered && covered !== name ? [name, covered] : [name];
}

/** The application's own name where the node has one, since the question being
 *  answered is which app to trust. Namespaces naming it, then the id, fall back. */
export function applicationLabel(
  applicationId: string,
  namespaces: NamespaceSummary[],
  installed?: InstalledApp[],
): string {
  const app = installed?.find((entry) => entry.id === applicationId);
  const named = app && (decodeMetadata(app.metadata)?.name || app.name);
  if (named) return named;

  const names = namespaces
    .filter((ns) => ns.targetApplicationId === applicationId && ns.name)
    .map((ns) => ns.name as string);
  return names.length ? names.join(", ") : truncateText(applicationId, 12);
}

async function waitForDevice(deviceId: string): Promise<boolean> {
  const deadline = Date.now() + POLL_CEILING_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const devices = await listAccountDevices().catch(() => []);
    if (devices.some((d) => d.deviceId === deviceId)) return true;
  }
  return false;
}

interface WizardProps {
  /** From this node's identity; without one it cannot invite anybody. */
  rootKey?: string;
  onLinked: (deviceId: string, converged: boolean) => void;
  onClose: () => void;
}

export function DevicePairWizard({ rootKey, onLinked, onClose }: WizardProps) {
  const [namespaces, setNamespaces] = useState<NamespaceSummary[]>([]);
  const [applications, setApplications] = useState<AccountApplication[]>([]);
  const [installed, setInstalled] = useState<InstalledApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [everything, setEverything] = useState(true);
  const [chosenApps, setChosenApps] = useState<string[]>([]);
  const [replyText, setReplyText] = useState("");
  const [code, setCode] = useState("");
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState("");
  // A 409 refuses the SCOPE, not the payload, so retyping the code cannot help.
  const [scopeRefused, setScopeRefused] = useState(false);
  const [result, setResult] = useState<PairCompleteResult | null>(null);
  const [converged, setConverged] = useState(false);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    if (!rootKey) return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    Promise.all([
      listNamespaces(controller.signal),
      listAccountApplications(controller.signal),
      // A name is a nicety; the invite must still work when the lookup fails.
      listInstalledApps()
        .then((r) => (Array.isArray(r.data) ? (r.data as InstalledApp[]) : []))
        .catch(() => [] as InstalledApp[]),
    ])
      .then(([ns, apps, apps_installed]) => {
        setNamespaces(ns);
        setApplications(apps);
        setInstalled(apps_installed);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(parseTauriError(err, "Could not prepare an invite"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [rootKey, reloads]);

  // The one value the two halves of pairing disagree about on purpose: the
  // invite names namespaces to listen on, pair-complete names applications.
  const scopedApps = everything ? undefined : chosenApps;
  const inviteNs = inviteNamespaces(namespaces, scopedApps);

  const reply = decodeReply(replyText);
  const payload = reply ? { ...reply, confirmationCode: code } : null;
  const invalid = !replyText.trim()
    ? null
    : payload
      ? validatePairPayload(payload)
      : "That is not a response from the other computer.";

  const toggleApp = (applicationId: string) =>
    setChosenApps((prev) =>
      prev.includes(applicationId)
        ? prev.filter((id) => id !== applicationId)
        : [...prev, applicationId],
    );

  const link = async () => {
    if (!payload || invalid) return;
    setLinking(true);
    setLinkError("");
    setScopeRefused(false);
    try {
      const done = await pairComplete(payload, scopedApps);
      const seen = await waitForDevice(done.deviceId);
      setResult(done);
      setConverged(seen);
      onLinked(done.deviceId, seen);
    } catch (err: unknown) {
      setLinkError(parseTauriError(err, "Could not link the device"));
      setScopeRefused(refusalStatus(err) === 409);
    } finally {
      setLinking(false);
    }
  };

  if (!rootKey) {
    return (
      <div className="account-wizard">
        <p className="field-hint" id="pair-no-root-key">
          This node has no account root key yet, so it cannot invite another device. It gets
          one the first time it takes part in a namespace.
        </p>
        <button type="button" id="pair-cancel" className="button button-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="account-wizard">
        <SkeletonText lines={3} />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="account-wizard">
        <p className="field-error">{loadError}</p>
        <button
          type="button"
          id="pair-retry"
          className="button button-secondary"
          onClick={() => setReloads((n) => n + 1)}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!namespaces.length) {
    return (
      <div className="account-wizard">
        <p className="field-hint" id="pair-no-namespace">
          This node is not part of anything yet, so there is nothing to add a device to. Join
          or create something first, then come back.
        </p>
        <button type="button" id="pair-cancel" className="button button-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }

  if (result) {
    return (
      <div className="account-wizard">
        <p className="settings-field-label" id="pair-success">Device linked.</p>
        <p className="field-hint">
          {result.keyDelivered
            ? "The device has its account key."
            : "The account key has not reached it yet - the device's sync pull will retry."}
        </p>
        {!converged && (
          <p className="field-hint" id="pair-syncing-note">
            It has not appeared in the list here yet; it is still syncing.
          </p>
        )}
        <button type="button" id="pair-done" className="button button-primary" onClick={onClose}>
          Done
        </button>
      </div>
    );
  }

  if (linking) {
    return (
      <div className="account-wizard">
        <p className="field-hint" id="pair-linking">Linking the device…</p>
        <SkeletonText lines={2} />
      </div>
    );
  }

  if (step === 0) {
    return (
      <div className="account-wizard">
        <p className="field-hint">What should this device have?</p>
        <label className="account-scope-choice">
          <input
            type="radio"
            id="pair-scope-all"
            name="pair-scope"
            checked={everything}
            onChange={() => setEverything(true)}
          />
          <span>Everything on this account</span>
        </label>
        <label className="account-scope-choice">
          <input
            type="radio"
            id="pair-scope-apps"
            name="pair-scope"
            checked={!everything}
            onChange={() => setEverything(false)}
          />
          <span>Only the apps I choose</span>
        </label>
        {!everything && (
          <div className="account-scope-apps" id="pair-app-list">
            {applications.length === 0 ? (
              <p className="field-hint" id="pair-no-apps">
                This account speaks in no app yet.
              </p>
            ) : (
              applications.map((app) => (
                <label className="account-scope-choice account-scope-app" key={app.applicationId}>
                  <input
                    type="checkbox"
                    id={`pair-app-${app.applicationId}`}
                    checked={chosenApps.includes(app.applicationId)}
                    onChange={() => toggleApp(app.applicationId)}
                  />
                  <span className="account-scope-app-text">
                    {scopeRow(app.applicationId, namespaces, installed).map((line, i) => (
                        <span
                          key={line}
                          className={i === 0 ? "account-scope-app-name" : "account-scope-app-ns"}
                        >
                          {line}
                        </span>
                      ))}
                  </span>
                </label>
              ))
            )}
          </div>
        )}
        <div className="account-wizard-actions">
          <button
            type="button"
            id="pair-scope-next"
            className="button button-primary"
            onClick={() => setStep(1)}
            disabled={!inviteNs.length}
          >
            Next
          </button>
          <button type="button" id="pair-cancel" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const invite = encodeInvite({
    rootKey,
    namespaces: inviteNs,
    apps: inviteApps(scopedApps, installed),
  });

  return (
    <div className="account-wizard">
      {step === 1 ? (
        <>
          <p className="field-hint">
            On the computer you are adding, open Settings, then Account, and paste this into
            "Pair this computer into an account".
          </p>
          <div className="settings-field">
            <div className="agent-config-header">
              <span className="settings-field-label">Invite</span>
              <CopyButton id="copy-pair-invite" value={invite} />
            </div>
            <pre className="agent-config account-blob" tabIndex={0} id="pair-invite">{invite}</pre>
          </div>
          <div className="account-wizard-actions">
            <button
              type="button"
              id="pair-next"
              className="button button-primary"
              onClick={() => setStep(2)}
            >
              Next
            </button>
            <button
              type="button"
              id="pair-scope-back"
              className="button button-secondary"
              onClick={() => setStep(0)}
            >
              Back
            </button>
            <button type="button" id="pair-cancel" className="button button-secondary" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="field-hint">
            The other computer now shows a response and a confirmation code. Paste the response
            here, then type the code as it appears on that screen.
          </p>
          <div className="settings-field">
            <label htmlFor="pair-response">Response from the other computer</label>
            <textarea
              id="pair-response"
              className="account-blob-input"
              rows={4}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder={`${REPLY_PREFIX}…`}
            />
          </div>
          <div className="settings-field">
            <label htmlFor="pair-code">
              Confirmation code, read off the other computer's screen
            </label>
            <input
              id="pair-code"
              type="text"
              value={code}
              onChange={(e) => setCode(normalizeConfirmationCode(e.target.value))}
              placeholder="ABCD-1234"
            />
            <p className="field-hint">
              Type it in yourself. It is not part of the response, so that a rewritten response
              cannot carry a matching code.
            </p>
          </div>
          {invalid && <p className="field-error" id="pair-invalid">{invalid}</p>}
          {linkError && <p className="field-error" id="pair-error">{linkError}</p>}
          {scopeRefused && (
            <button
              type="button"
              id="pair-change-scope"
              className="button button-secondary"
              onClick={() => {
                setScopeRefused(false);
                setLinkError("");
                setStep(0);
              }}
            >
              Change the apps
            </button>
          )}
          <div className="account-wizard-actions">
            <button
              type="button"
              id="pair-complete"
              className="button button-primary"
              onClick={link}
              disabled={!payload || !!invalid}
            >
              Link device
            </button>
            <button
              type="button"
              id="pair-back"
              className="button button-secondary"
              onClick={() => setStep(1)}
            >
              Back
            </button>
            <button type="button" id="pair-cancel" className="button button-secondary" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** The link has landed when this node reports the inviting account's root as its
 *  own. Before pairing it reports the root it minted itself. */
export function linkedToInvite(identity: NodeIdentity | null, rootKey: string): boolean {
  return Boolean(rootKey) && identity?.accountRootPublicKey === rootKey;
}

interface InstallState {
  source: string;
  name: string;
  status: "waiting" | "installing" | "done" | "failed";
  error?: string;
}

const POLL_MS = 3000;

/** The other end of the wizard: what the computer being added runs. */
export function DevicePairResponder({ enrolledDeviceId }: { enrolledDeviceId?: string }) {
  const [inviteText, setInviteText] = useState("");
  const [result, setResult] = useState<PairInitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The invite this node actually answered, kept apart from the textarea so the
  // install below is not restarted by an edit to it.
  const [answered, setAnswered] = useState<PairInvite | null>(null);
  const [installs, setInstalls] = useState<InstallState[]>([]);

  const invite = decodeInvite(inviteText);

  const start = async () => {
    if (!invite) return;
    setBusy(true);
    setError("");
    try {
      // Kept on failure: pair-init is idempotent, so the holder can just retry
      // against this same response instead of restarting the wizard.
      setResult(await pairInit(invite.rootKey, invite.namespaces));
      setAnswered(invite);
    } catch (err: unknown) {
      setError(parseTauriError(err, "Could not answer that invite"));
    } finally {
      setBusy(false);
    }
  };

  // Nothing has vouched for the invite until the holder accepts the code, and its
  // sources are only pasted URLs until then, so the install waits for the link.
  useEffect(() => {
    const apps = answered?.apps ?? [];
    if (!answered || !apps.length) return;
    let cancelled = false;

    setInstalls(
      apps.map((app) => ({
        source: app.source,
        name: decodeMetadata(app.metadata)?.name || truncateText(app.source, 40),
        status: "waiting" as const,
      })),
    );

    const mark = (i: number, patch: Partial<InstallState>) =>
      setInstalls((prev) => prev.map((entry, at) => (at === i ? { ...entry, ...patch } : entry)));

    void (async () => {
      while (!cancelled) {
        const identity = await fetchNodeIdentity().catch(() => null);
        if (linkedToInvite(identity, answered.rootKey)) break;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      for (const [i, app] of apps.entries()) {
        if (cancelled) return;
        mark(i, { status: "installing" });
        try {
          const response = await apiClient.node.installApplication({
            url: app.source,
            metadata: app.metadata ?? [],
          } as never);
          if (cancelled) return;
          const failed = (response as { error?: { message?: string } })?.error;
          mark(i, failed ? { status: "failed", error: failed.message } : { status: "done" });
        } catch (err: unknown) {
          if (!cancelled) mark(i, { status: "failed", error: parseTauriError(err, "Install failed") });
        }
      }
      if (!cancelled) invalidateInstalledApps();
    })();

    return () => {
      cancelled = true;
    };
  }, [answered]);

  return (
    <>
      <p className="field-hint" style={{ marginBottom: "16px" }}>
        Run this on the computer you are adding. Paste the invite from the computer that
        already holds the account, then read the confirmation code back to it.
      </p>
      {enrolledDeviceId && (
        <p className="field-hint account-warning" id="pair-already-enrolled">
          This computer already has an identity of its own. Pairing it into another account
          will be refused for anything it is already part of.
        </p>
      )}
      <div className="settings-field">
        <label htmlFor="pair-invite-input">Invite from the other computer</label>
        <textarea
          id="pair-invite-input"
          className="account-blob-input"
          rows={3}
          value={inviteText}
          onChange={(e) => setInviteText(e.target.value)}
          placeholder={`${INVITE_PREFIX}…`}
        />
      </div>
      {inviteText.trim() && !invite && (
        <p className="field-error" id="pair-invite-invalid">
          That is not an invite. Copy the whole block, including the {INVITE_PREFIX} prefix.
        </p>
      )}
      {error && <p className="field-error" id="pair-init-error">{error}</p>}
      <button
        type="button"
        id="pair-init"
        className="button button-primary"
        onClick={start}
        disabled={!invite || busy}
      >
        <KeyRound size={14} style={{ marginRight: "6px", verticalAlign: "middle" }} />
        {busy ? "Working…" : result ? "Get a new response" : "Get response"}
      </button>

      {result && (
        <div className="account-pair-answer">
          <div className="settings-field">
            <div className="agent-config-header">
              <span className="settings-field-label">Send this back</span>
              <CopyButton id="copy-pair-reply" value={encodeReply(result)} />
            </div>
            <pre className="agent-config account-blob" tabIndex={0} id="pair-reply">
              {encodeReply(result)}
            </pre>
          </div>
          <div className="settings-field">
            <span className="settings-field-label">Read this code aloud to the other computer</span>
            <code className="account-pair-code" id="pair-confirmation-code">
              {result.confirmationCode}
            </code>
            <p className="field-hint">
              Say it out loud or over the phone. Do not send it with the block above.
            </p>
          </div>
          {installs.length > 0 && (
            <div className="settings-field">
              <span className="settings-field-label">Apps arriving with this account</span>
              <ul className="account-install-list" id="pair-app-installs">
                {installs.map((entry) => (
                  <li className="account-install-row" key={entry.source}>
                    <span className="account-install-name">{entry.name}</span>
                    <span className={`account-install-status is-${entry.status}`}>
                      {entry.status === "waiting"
                        ? "waiting for the code"
                        : entry.status === "installing"
                          ? "installing…"
                          : entry.status === "done"
                            ? "installed"
                            : (entry.error ?? "failed")}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="field-hint">
                These install once the other computer accepts the code, not before.
              </p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
