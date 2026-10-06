import { useCallback, useEffect, useRef, useState } from "react";

import { useToast } from "../contexts/ToastContext";
import {
  CloudSessionExpiredError,
  RELAY_UNSUPPORTED_WARNING,
  disableHaNamespace,
  enableHaForNamespace,
  ensureTeeAdmissionPolicy,
  getCloudNamespaces,
  type CloudNamespace,
} from "../utils/cloudApi";
import { getCloudIdToken } from "../utils/cloudAuth";
import { getSettings } from "../utils/settings";
import { useCloudSession } from "./useCloudSession";

/** The fleet's view of one namespace, as `GET /api/cloud/me/namespaces` reports it. */
export type FleetReplicas = CloudNamespace["fleet_replicas"];

export interface HaStatus {
  /** HA on/off per namespace id, as the cloud reports it. Missing = not registered. */
  haEnabled: Record<string, boolean>;
  /** Namespaces with an enable/disable in flight. */
  haEnabling: Record<string, boolean>;
  /** Fleet replica counts per namespace id, for namespaces the cloud knows. */
  replicas: Record<string, FleetReplicas>;
  /** True once the cloud listing has answered for the current session. */
  loaded: boolean;
  refresh: () => void;
  toggleHa: (namespaceId: string) => Promise<void>;
  /** Turn HA on for several namespaces, one after another, with one summary toast. */
  enableMany: (namespaceIds: string[]) => Promise<void>;
}

/**
 * High Availability state for every namespace this cloud account owns, and the
 * actions that change it. Shared by the Cloud page and the namespace detail
 * view so both read and write the same thing.
 *
 * `nodeReady` is whether the local node client is up: enabling HA asks the
 * node for an ownership proof and writes the TEE admission policy on it.
 */
export function useHaStatus(nodeReady: boolean): HaStatus {
  const toast = useToast();
  const session = useCloudSession();
  // `haEnabling` is a per-namespace map so toggling one namespace doesn't lock
  // every other toggle.
  const [haEnabling, setHaEnabling] = useState<Record<string, boolean>>({});
  const [haEnabled, setHaEnabled] = useState<Record<string, boolean>>({});
  const [replicas, setReplicas] = useState<Record<string, FleetReplicas>>({});
  const [loaded, setLoaded] = useState(false);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    const token = getCloudIdToken();
    if (session !== "connected" || !token) {
      setHaEnabled({});
      setReplicas({});
      setLoaded(false);
      return;
    }
    let cancelled = false;
    getCloudNamespaces(token)
      .then((namespaces) => {
        if (cancelled) return;
        const byNamespace: Record<string, boolean> = {};
        const fleet: Record<string, FleetReplicas> = {};
        for (const n of namespaces) {
          if (!n.namespace_id) continue;
          if (n.ha_status === "enabled") byNamespace[n.namespace_id] = true;
          else if (byNamespace[n.namespace_id] === undefined) byNamespace[n.namespace_id] = false;
          if (n.fleet_replicas) fleet[n.namespace_id] = n.fleet_replicas;
        }
        setHaEnabled(byNamespace);
        setReplicas(fleet);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [session, version]);

  // ── Reconcile: ensure the TEE admission policy exists for HA-ENABLED
  // namespaces we own. `enableHaForNamespace` authors the policy once, at
  // toggle time — so a namespace enabled on an OLDER build (before that PUT
  // existed) has NO policy, and its fleet TEE node loops forever on merod's
  // "no TeeAdmissionPolicy set for group"; a namespace whose fleet MRTD
  // later rotated has a STALE one. This self-heals both on load: for each
  // enabled namespace where we are the root Admin, `ensureTeeAdmissionPolicy`
  // re-asserts the policy from the current fleet measurements, in relay
  // mode — which also converts the TEEs a pre-relay policy admitted as
  // replicas. It is idempotent (a correct policy is a read-only no-op) and
  // owner-gated (a namespace we merely joined is skipped), so the steady
  // state is cheap and a member node never tries to author a policy it
  // can't sign.
  //
  // A node too old for relay mode is told so once, not on every refresh.
  const relayWarnedRef = useRef(false);
  useEffect(() => {
    const settings = getSettings();
    if (!settings.nodeUrl) return;
    const idToken = getCloudIdToken();
    if (!idToken) return;
    const enabledIds = Object.entries(haEnabled)
      .filter(([, v]) => v === true)
      .map(([id]) => id);
    if (enabledIds.length === 0) return;

    let cancelled = false;
    void (async () => {
      let reasserted = 0;
      let relayUnsupported = false;
      for (const nsId of enabledIds) {
        if (cancelled) return;
        try {
          const outcome = await ensureTeeAdmissionPolicy(idToken, nsId);
          if (outcome === "reasserted") reasserted += 1;
          if (outcome === "relay-unsupported") relayUnsupported = true;
        } catch (e) {
          // Best-effort: one namespace failing (transient merod/cloud error)
          // must not abort the rest. The fleet node keeps retrying admission,
          // so a missed re-assert self-heals on the next load — log, no toast.
          console.warn(
            `ensure-policy: ${nsId} skipped (${(e as Error)?.name ?? "error"})`,
          );
        }
      }
      if (!cancelled && reasserted > 0) {
        toast.success(
          `Re-authored TEE admission policy for ${reasserted} HA namespace(s)`,
        );
      }
      // Once per visit to this page: every HA-status refresh re-runs this, and
      // the node stays too old until the user upgrades it.
      if (!cancelled && relayUnsupported && !relayWarnedRef.current) {
        relayWarnedRef.current = true;
        toast.warning(RELAY_UNSUPPORTED_WARNING, 0);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [haEnabled]);

  const setBusy = (nsId: string, busy: boolean) =>
    setHaEnabling((prev) => {
      const next = { ...prev };
      if (busy) next[nsId] = true;
      else delete next[nsId];
      return next;
    });

  /** Preconditions every HA change shares; the cloud token when they hold. */
  const readyToken = useCallback((): string | null => {
    const token = getCloudIdToken();
    if (!token) { toast.error("Sign in to Calimero Cloud first, in the Cloud tab"); return null; }
    if (!getSettings().nodeUrl) { toast.error("Node URL not configured"); return null; }
    if (!nodeReady) { toast.error("Local node client is not ready yet"); return null; }
    return token;
  }, [nodeReady, toast]);

  // HA is namespace-scoped: always authorise via the namespace ownership-proof
  // path, whether or not the namespace already has contexts. Attaching a real
  // context_id here routes the request onto the cloud's legacy "real-context"
  // branch, which gates on the `UserContext` ledger — a table the
  // namespace-native pivot stopped populating, so it 404s ("Contexts not found
  // or not owned by user") for any context that actually exists. An empty
  // group list keeps the request on the server-verified namespace-ownership
  // gate (UserNamespace); core admits the RelayTee fleet member at the root and
  // auto-follows contexts.
  const enableOne = async (token: string, nsId: string): Promise<boolean> => {
    const { relay } = await enableHaForNamespace(token, nsId, []);
    setHaEnabled((prev) => ({ ...prev, [nsId]: true }));
    return relay === "relay-unsupported";
  };

  const reportError = useCallback((err: unknown) => {
    if (err instanceof CloudSessionExpiredError) {
      toast.error("Cloud session expired — sign in again in the Cloud tab");
    } else {
      toast.error((err as Error)?.message || "Failed to change High Availability");
    }
  }, [toast]);

  const warnRelayUnsupported = () => {
    relayWarnedRef.current = true;
    toast.warning(RELAY_UNSUPPORTED_WARNING, 0);
  };

  const toggleHa = useCallback(async (nsId: string) => {
    const token = readyToken();
    if (!token) return;
    const isEnabled = !!haEnabled[nsId];
    setBusy(nsId, true);
    try {
      if (isEnabled) {
        await disableHaNamespace(token, nsId);
        setHaEnabled((prev) => ({ ...prev, [nsId]: false }));
        // Nothing to remove locally. Each fleet node sees the namespace is no
        // longer assigned to it and leaves on its own (`namespace leave`):
        // that `MemberLeft` cascades through every subgroup on every node and
        // purges the node's keys and data. Publishing `MemberRemoved` here
        // instead would put the node's account on the namespace's removed
        // list, which core never lets an attestation lift — so re-enabling HA
        // would leave that node refused for good ("was removed ... cannot
        // rejoin; an admin must re-add them").
        toast.success("HA disabled — TEE nodes will leave the namespace");
      } else {
        const relayUnsupported = await enableOne(token, nsId);
        toast.success("HA enabled — TEE fleet nodes will join");
        if (relayUnsupported) warnRelayUnsupported();
      }
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(nsId, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [haEnabled, readyToken, reportError, toast]);

  const enableMany = useCallback(async (nsIds: string[]) => {
    const pending = nsIds.filter((id) => !haEnabled[id]);
    if (pending.length === 0) return;
    const token = readyToken();
    if (!token) return;
    pending.forEach((id) => setBusy(id, true));
    let enabled = 0;
    let relayUnsupported = false;
    const failures: string[] = [];
    // One after another: each enable has the node sign an ownership proof and
    // write an admission policy, and running them side by side gains nothing
    // the user would notice while making a failure harder to attribute.
    for (const nsId of pending) {
      try {
        if (await enableOne(token, nsId)) relayUnsupported = true;
        enabled += 1;
      } catch (err) {
        if (err instanceof CloudSessionExpiredError) {
          pending.forEach((id) => setBusy(id, false));
          reportError(err);
          return;
        }
        failures.push((err as Error)?.message || "unknown error");
      } finally {
        setBusy(nsId, false);
      }
    }
    if (enabled > 0) {
      toast.success(
        `HA enabled for ${enabled} namespace${enabled === 1 ? "" : "s"} — TEE fleet nodes will join`,
      );
    }
    if (failures.length > 0) {
      toast.error(
        `Could not enable HA for ${failures.length} namespace${failures.length === 1 ? "" : "s"}: ${failures[0]}`,
      );
    }
    if (relayUnsupported) warnRelayUnsupported();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [haEnabled, readyToken, reportError, toast]);

  return { haEnabled, haEnabling, replicas, loaded, refresh, toggleHa, enableMany };
}
