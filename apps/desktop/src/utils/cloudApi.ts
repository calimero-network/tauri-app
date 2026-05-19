import { getAccessToken } from '../lib/token-storage';
import { getSettings, saveSettings } from './settings';
import { isMdmaSessionToken, isTokenExpired, parseJwtPayload } from './jwt';

// API lives at manager.cloud.calimero.network; cloud.calimero.network is
// the static portal and does not proxy /api/*. Exported so cloudAuth
// can reuse it — we don't want two independent constants drifting.
export const CLOUD_BASE_URL = 'https://manager.cloud.calimero.network';
const MDMA_SESSION_REFRESH_HEADER = 'X-MDMA-Session-Refresh';

export interface CloudNode {
  name: string;
  public_ip: string;
  plan: string;
  status: string;
}

export interface CloudSubscription {
  plan: string;
  status: string;
  current_period_end: string | null;
}

class CloudSessionExpiredError extends Error {
  constructor() {
    super('Cloud session expired');
    this.name = 'CloudSessionExpiredError';
  }
}

async function cloudFetch(
  path: string,
  idToken: string,
  options?: RequestInit,
): Promise<Response> {
  const res = await fetch(`${CLOUD_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (res.status === 401) {
    throw new CloudSessionExpiredError();
  }

  // Rolling refresh: the server re-issued our session silently because
  // this one was past the refresh threshold. Persist the new token
  // directly to settings — next call reads from settings.cloudIdToken
  // and picks it up. We intentionally don't propagate via React state
  // or events: same sid = same logical session, so there's nothing
  // UI-level to re-derive, and routing refresh through render would
  // re-fire every useEffect that depends on the token.
  //
  // Only honoured on a successful response. A refresh header attached
  // to a 4xx/5xx response is suspicious (either a misbehaving server
  // or a header-injecting MITM trying to plant a token on us during a
  // failure path) — the 401 branch above already threw, but the same
  // logic applies to other non-ok statuses. Drop silently.
  if (!res.ok) {
    return res;
  }

  // Validate the header value before persisting it. An MDMA-issued
  // JWT that is not yet expired is the only shape we should ever
  // write to settings.cloudIdToken via this path; anything else
  // (wrong issuer, malformed, already-expired) we silently drop and
  // keep the current token, which the caller will detect as expired
  // via isTokenExpired on the next request.
  const refreshed = res.headers.get(MDMA_SESSION_REFRESH_HEADER);
  if (refreshed && isMdmaSessionToken(refreshed) && !isTokenExpired(refreshed)) {
    const settings = getSettings();
    // Only update if the session we just used is still the active one;
    // avoids clobbering a fresh login that landed between the request
    // leaving and the response arriving.
    if (settings.cloudIdToken === idToken) {
      // saveSettings can throw if localStorage is full or unavailable
      // (Safari private mode, quota exceeded). The rolling refresh is a
      // best-effort silent renewal — if we can't persist the new token
      // the user keeps the old one and re-auths at its exp, which is
      // strictly better than letting the network response surface a
      // storage error to the caller.
      try {
        saveSettings({ ...settings, cloudIdToken: refreshed });
      } catch (err) {
        console.warn('Failed to persist refreshed MDMA session token:', err);
      }
    }
  }

  return res;
}

/**
 * Get the user's assigned cloud node. Also triggers auto-registration
 * on first call (creates free plan account + default context).
 */
export async function getCloudNode(
  idToken: string,
): Promise<CloudNode | null> {
  const res = await cloudFetch('/api/cloud/me/node', idToken);
  if (!res.ok) return null;
  return res.json();
}

export async function getCloudSubscription(
  idToken: string,
): Promise<CloudSubscription | null> {
  const res = await cloudFetch('/api/cloud/me/subscription', idToken);
  if (!res.ok) return null;
  return res.json();
}

export interface CloudGroup {
  group_id: string;
  namespace_id: string | null;
  contexts: string[];
  ha_status: string;
  ha_enabled_at: string | null;
  fleet_replicas: { active: number; assigned: number; limit: number };
}

export async function getCloudGroups(idToken: string): Promise<CloudGroup[]> {
  const res = await cloudFetch('/api/cloud/me/groups', idToken);
  if (!res.ok) return [];
  return res.json();
}

// ── HA (High Availability) via TEE Fleet Nodes ──

export interface FleetMeasurements {
  release_tag: string;
  allowed_mrtd: string[];
  allowed_rtmr0: string[];
  allowed_rtmr1: string[];
  allowed_rtmr2: string[];
  allowed_rtmr3: string[];
}

/**
 * Fetch the fleet's trusted TEE measurements (MRTD, RTMR values)
 * from the cloud. Used to populate set_tee_admission_policy.
 */
export async function getFleetMeasurements(
  idToken: string,
): Promise<FleetMeasurements> {
  const res = await cloudFetch('/api/cloud/fleet/measurements', idToken);
  if (!res.ok) {
    throw new Error('Failed to fetch fleet measurements');
  }
  return res.json();
}

export interface EnableHaResponse {
  status: string;
  context_id: string;
}

/**
 * Enable HA for a context — requests TEE fleet nodes to join this
 * namespace/group. Requires a paid plan.
 */
export async function enableHa(
  idToken: string,
  contextId: string,
  groupId?: string,
): Promise<EnableHaResponse | null> {
  const res = await cloudFetch(
    `/api/cloud/me/contexts/${encodeURIComponent(contextId)}/enable-ha`,
    idToken,
    {
      method: 'POST',
      body: JSON.stringify(groupId ? { group_id: groupId } : {}),
    },
  );
  if (!res.ok) {
    const error = await res.json().catch(() => null);
    if (res.status === 402) {
      throw new Error(error?.detail?.message || 'Plan limit reached — upgrade to enable HA');
    }
    throw new Error(error?.detail || 'Failed to enable HA');
  }
  return res.json();
}

/**
 * Disable HA for a context.
 */
export async function disableHa(
  idToken: string,
  contextId: string,
): Promise<void> {
  const res = await cloudFetch(
    `/api/cloud/me/contexts/${encodeURIComponent(contextId)}/disable-ha`,
    idToken,
    { method: 'POST' },
  );
  if (!res.ok) {
    const error = await res.json().catch(() => null);
    throw new Error(error?.detail || 'Failed to disable HA');
  }
}

export interface NamespaceHaGroup {
  group_id: string;
  context_id: string;
}

export interface EnableHaNamespaceResponse {
  status: string;
  namespace_id: string;
  groups: { group_id: string; context_id: string; status: string }[];
}

/**
 * Enable HA for a namespace in one call.
 *
 * Two mutually-exclusive shapes, picked by the caller:
 *  • Real-context path: `groups` carries the namespace's representative
 *    {group_id, context_id} entries; no `ownershipProof`. The cloud
 *    authorises by matching each context to a UserContext the caller
 *    already claimed (unchanged behaviour).
 *  • Context-less path: `groups` is `[]` and a single namespace-scoped
 *    `ownershipProof` is supplied. There is no context to bill/claim,
 *    so the cloud authorises off the server-verified namespace proof
 *    instead — this is the authoritative namespace-ownership gate.
 *
 * The `ownership_proof` key is only emitted when a proof is passed, so
 * the real-context request body is byte-for-byte unchanged.
 */
export async function enableHaNamespace(
  idToken: string,
  namespaceId: string,
  groups: NamespaceHaGroup[],
  ownershipProof?: OwnershipProof,
): Promise<EnableHaNamespaceResponse> {
  const body = ownershipProof
    ? { groups, ownership_proof: ownershipProof }
    : { groups };
  const res = await cloudFetch(
    `/api/cloud/me/namespaces/${encodeURIComponent(namespaceId)}/enable-ha`,
    idToken,
    { method: 'POST', body: JSON.stringify(body) },
  );
  if (!res.ok) {
    const error = await res.json().catch(() => null);
    if (res.status === 402) {
      throw new Error(error?.detail?.message || 'Plan limit reached — upgrade to enable HA');
    }
    throw new Error(error?.detail || 'Failed to enable HA for namespace');
  }
  return res.json();
}

/**
 * Disable HA for every group previously enabled under this namespace.
 */
export async function disableHaNamespace(
  idToken: string,
  namespaceId: string,
): Promise<void> {
  const res = await cloudFetch(
    `/api/cloud/me/namespaces/${encodeURIComponent(namespaceId)}/disable-ha`,
    idToken,
    { method: 'POST' },
  );
  if (!res.ok) {
    const error = await res.json().catch(() => null);
    throw new Error(error?.detail || 'Failed to disable HA for namespace');
  }
}

// ── Local Node Admin API ──

/**
 * Set the TEE admission policy on a group via the local node's admin API.
 * This must be called after enabling HA so that fleet TEE nodes can be
 * admitted into the group's governance DAG.
 *
 * accept_mock is always false — only real TDX attestations are accepted.
 * allowedMrtd should be populated from the cloud's fleet measurements;
 * an empty list means any MRTD is accepted (not recommended for production).
 */
export async function setTeeAdmissionPolicy(
  nodeUrl: string,
  groupId: string,
  allowedMrtd?: string[],
): Promise<void> {
  const accessToken = getAccessToken();
  if (!accessToken) {
    throw new Error('Not authenticated to local node — sign in first');
  }
  const res = await fetch(
    `${nodeUrl}/admin-api/groups/${encodeURIComponent(groupId)}/settings/tee-admission-policy`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        // The merod admin API deserialises this request with
        // `#[serde(rename_all = "camelCase")]` (see
        // SetTeeAdmissionPolicyApiRequest in
        // calimero-network/core: crates/server/primitives/src/admin/mod.rs).
        // Snake_case keys are silently ignored as unknown fields and every
        // field falls through to its #[serde(default)] — so the server sees
        // allowed_mrtd: [] and accept_mock: false, and validation rejects
        // with a misleading "at least one MRTD must be specified" error.
        allowedMrtd: allowedMrtd ?? [],
        allowedRtmr0: [],
        allowedRtmr1: [],
        allowedRtmr2: [],
        allowedRtmr3: [],
        allowedTcbStatuses: [],
        acceptMock: false,
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to set TEE admission policy: ${text}`);
  }
}

// ── Cloud claim (silent context registration) ──

/**
 * An ownership proof issued by the local merod for a single context.
 * The triplet is opaque to the desktop — it round-trips through the
 * cloud's claim endpoint, which forwards it to a verifier that checks
 * the signature against the registered group signing key.
 *
 * Field names are snake_case because this object is embedded into the
 * cloud /api/cloud/me/contexts/claim request body. Merod's admin API
 * returns the same triplet in camelCase (see requestOwnershipProof
 * below) and we re-key on the way out.
 */
export interface OwnershipProof {
  signer_public_key: string;
  signed_payload: string;
  signature: string;
}

export interface ClaimedContext {
  context_id: string;
  ownership_proof: OwnershipProof;
}

interface IssueOwnershipProofResponseData {
  signerPublicKey: string;
  signedPayload: string;
  signature: string;
}

interface GroupMemberEntry {
  identity: string;
  role: string;
}

interface ListGroupMembersResponse {
  members: GroupMemberEntry[];
  selfIdentity?: string;
}

/**
 * Generate a 32-char hex nonce (16 random bytes). Used as the
 * audience-binding nonce on the local ownership-proof request — the
 * merod handler echoes it back inside `signed_payload` so the cloud
 * verifier can confirm we didn't replay an old proof.
 */
function generateProofNonce(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Proof-binding audiences. These literals are part of the wire contract
 * shared with the cloud verifier (mdma) and merod — they must stay
 * byte-identical across the three repos.
 *
 * Audience separation is a confused-deputy defence: a context-claim
 * proof must never be replayable to enable HA on a namespace, and
 * vice-versa. The cloud verifier rejects a proof whose embedded audience
 * doesn't match the endpoint it was presented to.
 */
const PROOF_AUDIENCE_CLAIM_CONTEXT = 'mdma:claim-context';
const PROOF_AUDIENCE_ENABLE_HA_NAMESPACE = 'mdma:enable-ha-namespace';

/**
 * Look up the caller's role in a group via the merod admin API.
 *
 * Throws on auth failure, a non-2xx response (core's actor bails with
 * an error when the node isn't a member of the group, so "not a
 * member" surfaces here as a thrown error, not `null`), or a 200 whose
 * body doesn't match the expected `{ members, selfIdentity }` shape —
 * a silent `null` on a malformed body would later masquerade as "not
 * the namespace admin", which is exactly the failure mode that masked
 * the earlier `{data}`-envelope bug. Returns `null` only for the
 * degenerate case of a well-formed response with no member entry
 * matching `selfIdentity`.
 *
 * Co-located here rather than in a dedicated admin-api module because
 * this is the only consumer right now — the moment a second caller
 * appears, lift it out.
 */
async function getSelfRoleInGroup(
  nodeUrl: string,
  groupId: string,
): Promise<string | null> {
  const accessToken = getAccessToken();
  if (!accessToken) {
    throw new Error('Not authenticated to local node — sign in first');
  }
  const res = await fetch(
    `${nodeUrl}/admin-api/groups/${encodeURIComponent(groupId)}/members`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to list group members: ${text || res.statusText}`);
  }
  // Core's ApiResponse serializes the payload struct directly — there is
  // no `{ data: ... }` envelope (see ApiResponse::into_response in
  // calimero-network/core crates/server/src/admin/service.rs, with its
  // `//TODO add data to response`). The members payload is
  // `{ members, selfIdentity }`; selfIdentity is camelCase because
  // ListGroupMembersApiResponse has #[serde(rename_all = "camelCase")].
  // A non-JSON body parses to null here (not a throw), so the shapeOk
  // check below produces the descriptive error rather than a raw
  // SyntaxError escaping as an unhandled rejection.
  const body = (await res
    .json()
    .catch(() => null)) as ListGroupMembersResponse | null;
  // Negated inline guard (not a separate `shapeOk` const) so TS narrows
  // `body` to non-null afterwards. Each member entry must be a
  // well-formed { identity, role } — a `null`/partial entry would
  // otherwise blow up the `.find` below with a raw TypeError instead of
  // this descriptive error.
  if (
    !body ||
    !Array.isArray(body.members) ||
    typeof body.selfIdentity !== 'string' ||
    !body.selfIdentity ||
    !body.members.every(
      (m) =>
        m != null &&
        typeof m.identity === 'string' &&
        typeof m.role === 'string',
    )
  ) {
    throw new Error(
      'Unexpected response from local node members endpoint — ' +
        'expected { members: [{ identity, role }], selfIdentity }. ' +
        'The node may be an incompatible version.',
    );
  }
  const me = body.members.find((m) => m.identity === body.selfIdentity);
  return me?.role ?? null;
}

/**
 * Ask the local merod to issue a signed ownership proof for a context
 * scoped to the given group. The proof is bound to {audience, subject,
 * nonce, expiresAtMs} so a leaked proof can't be replayed against a
 * different cloud user or after a short window.
 *
 * Returns the wire-snake-case triplet the cloud claim endpoint expects;
 * the camelCase merod response is re-keyed inline. Note expiresAtMs is
 * a *requested* expiry — the merod handler clamps to now+5min server
 * side, so a generous client value is harmless. We ask for 60s to keep
 * the window small.
 */
export async function requestOwnershipProof(
  nodeUrl: string,
  groupId: string,
  opts: { contextId: string; subject: string },
): Promise<OwnershipProof> {
  const accessToken = getAccessToken();
  if (!accessToken) {
    throw new Error('Not authenticated to local node — sign in first');
  }
  const nonce = generateProofNonce();
  const expiresAtMs = Date.now() + 60_000;
  const res = await fetch(
    `${nodeUrl}/admin-api/groups/${encodeURIComponent(groupId)}/issue-ownership-proof`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        // Same camelCase contract as setTeeAdmissionPolicy: the merod
        // admin types deserialise with #[serde(rename_all = "camelCase")].
        // The audience is part of the proof-binding agreed with the
        // cloud verifier (see PROOF_AUDIENCE_* above).
        audience: PROOF_AUDIENCE_CLAIM_CONTEXT,
        contextId: opts.contextId,
        subject: opts.subject,
        nonce,
        expiresAtMs,
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to issue ownership proof: ${text || res.statusText}`);
  }
  // No `{ data: ... }` envelope — ApiResponse serializes the payload
  // struct directly and IssueOwnershipProofApiResponse has no `data`
  // field. Keys are camelCase (#[serde(rename_all = "camelCase")]).
  const data = (await res.json()) as IssueOwnershipProofResponseData;
  if (
    !data ||
    typeof data.signerPublicKey !== 'string' ||
    typeof data.signedPayload !== 'string' ||
    typeof data.signature !== 'string'
  ) {
    throw new Error('Malformed ownership proof response from local node');
  }
  // Re-key camelCase → snake_case for the cloud request.
  return {
    signer_public_key: data.signerPublicKey,
    signed_payload: data.signedPayload,
    signature: data.signature,
  };
}

/**
 * Ask the local merod to issue a signed ownership proof scoped to a
 * *namespace root* with no context. This is the authoritative signal
 * that the caller is a direct admin of the namespace: merod gates the
 * issuance on `is_direct_group_admin(namespaceId)` and signs with the
 * namespace root's signing key — there is no context to bind, so the
 * payload's context_id is empty.
 *
 * Used by the context-less HA-enable path: a namespace with no context
 * yet has nothing to claim per-context, but the cloud still needs a
 * server-verifiable proof that this user owns the namespace before it
 * will enable HA (the cloud-side namespace-ownership gate / IDOR fix).
 *
 * Distinct audience from requestOwnershipProof so a context-claim proof
 * can never be replayed against the enable-ha endpoint. Same camelCase
 * request / camelCase response contract as requestOwnershipProof; the
 * triplet is re-keyed to snake_case for the cloud body.
 */
export async function requestNamespaceOwnershipProof(
  nodeUrl: string,
  namespaceId: string,
  opts: { subject: string },
): Promise<OwnershipProof> {
  const accessToken = getAccessToken();
  if (!accessToken) {
    throw new Error('Not authenticated to local node — sign in first');
  }
  const nonce = generateProofNonce();
  const expiresAtMs = Date.now() + 60_000;
  const res = await fetch(
    `${nodeUrl}/admin-api/groups/${encodeURIComponent(namespaceId)}/issue-namespace-ownership-proof`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        // camelCase per the merod admin contract (#[serde(rename_all =
        // "camelCase")]). No contextId field — this proof is scoped to
        // the namespace root only; the audience binds it to the cloud's
        // enable-ha-namespace endpoint.
        audience: PROOF_AUDIENCE_ENABLE_HA_NAMESPACE,
        subject: opts.subject,
        nonce,
        expiresAtMs,
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Failed to issue namespace ownership proof: ${text || res.statusText}`,
    );
  }
  // Same response shape as issue-ownership-proof: no `{ data }` envelope,
  // camelCase keys (#[serde(rename_all = "camelCase")]).
  const data = (await res.json()) as IssueOwnershipProofResponseData;
  if (
    !data ||
    typeof data.signerPublicKey !== 'string' ||
    typeof data.signedPayload !== 'string' ||
    typeof data.signature !== 'string'
  ) {
    throw new Error('Malformed ownership proof response from local node');
  }
  // Re-key camelCase → snake_case for the cloud request.
  return {
    signer_public_key: data.signerPublicKey,
    signed_payload: data.signedPayload,
    signature: data.signature,
  };
}

/**
 * Submit a batch of ownership proofs to the cloud so the contexts get
 * recorded against the caller's MDMA user. Single batched call instead
 * of one POST per context — the cloud verifier is the bottleneck and
 * each proof is independent.
 *
 * 403 responses include `{detail: "Ownership proof failed: <reason>"}`;
 * surface the detail string verbatim so the failure reason (signer
 * mismatch, expired nonce, ...) reaches the operator.
 */
export async function claimContexts(
  idToken: string,
  claims: ClaimedContext[],
): Promise<string[]> {
  const res = await cloudFetch('/api/cloud/me/contexts/claim', idToken, {
    method: 'POST',
    body: JSON.stringify({ claims }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => null);
    throw new Error(error?.detail || 'Failed to claim contexts with cloud');
  }
  // Tolerate a 2xx with an empty/non-JSON body (e.g. 204): fall back to
  // {} so the caller's claim-coverage check reports a meaningful
  // "did not register" error instead of a raw JSON SyntaxError.
  const body = (await res.json().catch(() => ({}))) as { claimed?: string[] };
  return Array.isArray(body?.claimed) ? body.claimed : [];
}

/**
 * Enable HA end-to-end for a namespace:
 * 1. Pre-flight: verify caller is namespace Admin and silently register
 *    each group's representative context with the cloud (so the
 *    subsequent enableHaNamespace call doesn't reject with
 *    "Contexts not found or not owned by user").
 * 2. Fetch fleet measurements from cloud once (trusted MRTD values).
 * 3. Set the TEE admission policy on the *namespace root only*. Subgroup
 *    policies are ignored by core (namespace-scoped since rc.29 /
 *    calimero-network/core#2188) — applying them would error. Auto-follow
 *    propagates fleet-node membership into subgroups without a second
 *    admission check.
 * 4. Register the namespace with cloud. MDMA still needs the full group
 *    list for billing + per-group status rows until the server-side
 *    flattening lands, so the caller keeps enumerating groups.
 */
export async function enableHaForNamespace(
  idToken: string,
  nodeUrl: string,
  namespaceId: string,
  groups: NamespaceHaGroup[],
): Promise<EnableHaNamespaceResponse> {
  // A context-less namespace is a first-class HA target. When no group
  // has a real context yet there is nothing to claim per-context, so the
  // per-context proof + claimContexts batch below is skipped; instead we
  // send the cloud ONE namespace-scoped ownership proof and an empty
  // group list. Core admits a ReadOnlyTee fleet member at the root group
  // (group_id == namespaceId) with zero contexts and auto-follows
  // contexts created later. The namespace proof is the authoritative
  // server-verified ownership gate for this path (the cloud cannot
  // authorise off a UserContext row because none exists yet) — without
  // it, any authenticated user could enable HA on any namespace.
  const hasRealContext = groups.some((g) => !!g.context_id);

  // ── Step 1: silent claim ──
  // The cloud verifier is the authoritative trust boundary: it re-checks
  // the proof signature and that the proof's subject == the authenticated
  // bearer's MDMA account. Validating the token shape here is defence-in-
  // depth + fail-fast — refuse to spend local merod round-trips (role
  // check + N proof issuances) on a token the cloud will reject anyway.
  if (!isMdmaSessionToken(idToken)) {
    throw new Error('Not signed in to Calimero Cloud — connect in Settings');
  }
  if (isTokenExpired(idToken)) {
    throw new Error('Cloud session has expired — reconnect in Settings');
  }

  // mdma's verifier compares the proof subject against the authenticated
  // user's *email*, so the subject must be email-shaped. Prefer the
  // `email` claim; accept `sub` only when it is itself an email (some
  // MDMA tokens duplicate it there). A non-email `sub` (opaque user id)
  // would otherwise produce a confusing cloud subject-mismatch later, so
  // fail clearly here instead. We don't decode via decodeIdToken from
  // cloudAuth.ts (would reintroduce the cloudApi → cloudAuth import
  // cycle the codebase avoids — see jwt.ts header).
  const payload = parseJwtPayload(idToken);
  const emailClaim = typeof payload?.email === 'string' ? payload.email : '';
  const subClaim = typeof payload?.sub === 'string' ? payload.sub : '';
  const subject = emailClaim.includes('@')
    ? emailClaim
    : subClaim.includes('@')
      ? subClaim
      : null;
  if (!subject) {
    throw new Error(
      'Cloud session is missing the user identifier (no account email) — reconnect in Settings',
    );
  }

  // Pre-flight role check on the namespace root. Only the admin can
  // hand out ownership proofs that the cloud verifier will accept —
  // bailing early gives a clear error rather than a confusing 403
  // later when the cloud rejects every proof in the batch.
  // Wire format is locked: GroupMemberRole in core serialises as
  // {Admin, Member, ReadOnly, ReadOnlyTee}. We require Admin only.
  const role = await getSelfRoleInGroup(nodeUrl, namespaceId);
  if (role === null) {
    // Well-formed response but our identity isn't among the members —
    // distinct from "you're a Member not an Admin": this usually means
    // the node isn't actually joined to this namespace root.
    throw new Error(
      'Could not determine your role in this namespace — ' +
        'the node does not appear to be a member of the namespace root.',
    );
  }
  if (role !== 'Admin') {
    throw new Error('Only the namespace admin can register contexts with the cloud.');
  }

  // Real-context path (unchanged): per-context proof + claimContexts so
  // the cloud can authorise each context against a claimed UserContext.
  // The context-less path skips this entirely and instead supplies the
  // single namespace proof to enableHaNamespace below; the Admin
  // pre-flight above is a UX fail-fast for both, but the server-verified
  // namespace proof is the authoritative gate for the context-less path.
  if (hasRealContext) {
  // Every proof is scoped to the *namespace root* (`namespaceId`), not
  // each group's own `group_id`, even for contexts that live in
  // subgroups. This is deliberate and consistent across the three
  // coordinated repos:
  //   • The ownership gate is "direct admin of the namespace root"
  //     (the role check above), so the root is the authoritative
  //     scope for the whole namespace.
  //   • core's resolve_group_signing_key walks ancestors, so the
  //     root's signing key signs proofs for subgroup contexts too.
  //   • core's context↔namespace containment check (calimero#2362)
  //     accepts any context within the namespace rooted at this
  //     group_id — a strict per-group equality check would reject
  //     subgroup contexts here.
  // Same rationale as the "set TEE policy on the root only, subgroups
  // inherit" step further below.
  //
  // Issue one proof per group in parallel — they hit the local merod
  // and are independent, so latency stacks linearly otherwise. Note
  // Promise.all is all-or-nothing: a single proof failure aborts the
  // whole HA-enable and the user retries the flow.
  const proofs = await Promise.all(
    groups.map((g) =>
      requestOwnershipProof(nodeUrl, namespaceId, {
        contextId: g.context_id,
        subject,
      }).then<ClaimedContext>((proof) => ({
        context_id: g.context_id,
        ownership_proof: proof,
      })),
    ),
  );

  // Single batched submit. Errors propagate to the caller (Namespaces
  // page surfaces via toast). Verify the cloud actually recorded every
  // context we submitted — a partial `claimed[]` would otherwise let HA
  // proceed for groups whose contexts were never registered, surfacing
  // later as a confusing "context not owned" failure.
  const claimed = await claimContexts(idToken, proofs);
  const claimedSet = new Set(claimed);
  // Compare against *unique* submitted ids — duplicate context_ids in
  // `groups` would otherwise count a single cloud-claimed id as multiple
  // "missing" entries and falsely abort.
  const submitted = [...new Set(proofs.map((p) => p.context_id))];
  const missing = submitted.filter((id) => !claimedSet.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Cloud did not register ${missing.length} of ${submitted.length} ` +
        `context(s): ${missing.join(', ')}. HA was not enabled.`,
    );
  }
  } // end real-context claim block

  // ── Step 2–4: existing flow ──
  const measurements = await getFleetMeasurements(idToken);
  if (!measurements.allowed_mrtd.length) {
    throw new Error('No fleet MRTD measurements available — cannot set admission policy');
  }

  // The namespace root's group_id equals the namespaceId. Set the policy
  // there and only there — subgroups inherit it via resolve-to-root.
  await setTeeAdmissionPolicy(nodeUrl, namespaceId, measurements.allowed_mrtd);

  if (hasRealContext) {
    // Real-context path: contexts already claimed above, no proof.
    return enableHaNamespace(idToken, namespaceId, groups);
  }

  // Context-less path: no contexts to bill/claim, so send an empty group
  // list plus exactly ONE namespace-scoped ownership proof. merod gates
  // proof issuance on direct admin of the namespace root and signs with
  // the root signing key; the cloud re-verifies the proof (signature,
  // subject == authenticated email, audience, group_id == path namespace)
  // before any write — this server-side check is the authoritative
  // namespace-ownership gate. Core admits a ReadOnlyTee fleet member at
  // the root and auto-follows contexts created later.
  const proof = await requestNamespaceOwnershipProof(nodeUrl, namespaceId, {
    subject,
  });
  return enableHaNamespace(idToken, namespaceId, [], proof);
}

export { CloudSessionExpiredError };
