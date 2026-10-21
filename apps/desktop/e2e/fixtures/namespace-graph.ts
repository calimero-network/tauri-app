/**
 * A whole synthetic namespace served to the Namespaces page: root contexts,
 * nested subgroups, and — the point of this fixture — a per-group member list
 * that decides whether the page offers Delete or Leave on each row.
 *
 * Every destructive admin-API call is role-gated on merod's side against the
 * group that owns the thing:
 *
 *   DELETE /admin-api/namespaces/:id  → require_admin on the namespace root
 *   DELETE /admin-api/groups/:id      → the subgroup's owner, a root admin, or
 *                                       CAN_DELETE_SUBGROUP
 *   DELETE /admin-api/contexts/:id    → require_admin on the OWNING group
 *
 * so the role is not one namespace-wide fact — it is per group, and this
 * fixture models it that way (a node can be root Admin and a plain Member of a
 * subgroup below it, or the reverse).
 *
 * Handlers are installed as ONE catch-all on `**\/admin-api/**` and dispatched
 * internally, rather than a dozen overlapping `page.route` globs whose
 * precedence depends on registration order. Anything it does not recognise is
 * `route.fallback()`ed to the handlers `mockCoreAPIs` already registered.
 *
 * Every admin-API request is recorded in `calls`, so a spec can assert on the
 * ROUTE the UI chose — "Leave namespace posted to /namespaces/:id/leave", not
 * merely "a toast said Left". The bug this suite exists for was exactly a
 * button whose label was right and whose endpoint was the admin-only one.
 */
import type { Page } from "@playwright/test";

export interface GraphContext {
  contextId: string;
  name: string;
}

export interface GraphGroup {
  groupId: string;
  name: string;
  /** This node's role in THIS group. `undefined` = no member row for us. */
  role?: string;
  contexts?: GraphContext[];
  subgroups?: GraphGroup[];
}

export interface NamespaceGraph {
  namespaceId: string;
  name: string;
  applicationId?: string;
  /** The release the namespace runs, as core reports it on the listing. */
  appVersion?: string;
  /** This node's role at the namespace ROOT. */
  role?: string;
  /** The root's other members, in place of the single admin every graph gets. */
  otherMembers?: { identity: string; role: string; name?: string }[];
  /** More namespaces of the same app, listed after this one. */
  siblings?: NamespaceGraph[];
  /** What `GET /admin-api/identity` says about the account's root key; absent means the node does not say. */
  holdsAccountRoot?: boolean;
  contexts?: GraphContext[];
  subgroups?: GraphGroup[];
}

export interface RecordedCall {
  method: string;
  /** Path only, e.g. `/admin-api/namespaces/ns-1/leave`. */
  path: string;
  /** The parsed JSON body, when the request carried one. */
  body?: unknown;
}

export interface GraphMock {
  /** Every admin-API request the page made, in order. */
  calls: RecordedCall[];
  /** Paths of the calls made with `method`. */
  pathsFor(method: string): string[];
}

/** The account `GET /admin-api/identity` reports. 64 hex, as core sends since rc.27. */
export const MOCK_ACCOUNT_ID = "1".repeat(64);
/** A second account, so member lists have somebody who is not us in them. */
export const OTHER_ACCOUNT_ID = "2".repeat(64);

/**
 * Options for the endpoints under test. Each may fail so a spec can prove the
 * page reports the failure instead of a false "Left".
 */
export interface GraphFailure {
  /** HTTP status merod answers with. */
  status: number;
  /** The `error` field of merod's body — `{"error": message}`. */
  message: string;
}

export interface GraphFailures {
  deleteNamespace?: GraphFailure;
  leaveNamespace?: GraphFailure;
  deleteGroup?: GraphFailure;
  leaveGroup?: GraphFailure;
  deleteContext?: GraphFailure;
  leaveContext?: GraphFailure;
  /** Refuses every member listing. */
  listMembers?: GraphFailure;
  updateMemberRole?: GraphFailure;
  /** Refuses every transfer, as core does a caller who is not the owner. */
  transferOwnership?: GraphFailure;
  /** Refuses the transfer that follows a promotion made through this mock. */
  transferAfterPromotion?: GraphFailure;
}

/**
 * The refusals merod actually sends. Every one of these was OBSERVED against a
 * live `merod:edge` in merobox CI (calimero-network/merobox#393) — the shapes
 * here are not inferred from the handler source, because the source alone gets
 * them wrong: `parse_api_error` reclassifies some and strips the rest.
 */

/**
 * `MembershipError::NotAdmin` from `delete_namespace` / `delete_context`, as
 * core MASTER sends it — a typed 403 keeping its message, via
 * `membership_refusal_status`.
 */
export const NOT_ADMIN_403: GraphFailure = {
  status: 403,
  message: `identity ${MOCK_ACCOUNT_ID} is not an admin of group 0xdeadbeef`,
};

/**
 * What the SAME refusal looks like on 0.11.0-rc.28, the merod this app
 * currently bundles: `membership_refusal_status` does not exist there, so it
 * falls through to the generic arm and the reason is stripped on purpose (an
 * unclassified error's message can carry store paths or key material).
 *
 * This is also what `delete_group` sends on BOTH versions: it refuses with
 * `CapabilitiesError::Unauthorized`, which nothing classifies.
 */
export const REASON_STRIPPED_500: GraphFailure = {
  status: 500,
  message: 'Internal server error',
};

/** A genuine fault, to prove it is NOT dressed up as a permission problem. */
export const GENUINE_FAULT: GraphFailure = {
  status: 500,
  message: 'namespace not found',
};

function flatten(graph: NamespaceGraph): Map<string, GraphGroup> {
  const byId = new Map<string, GraphGroup>();
  byId.set(graph.namespaceId, {
    groupId: graph.namespaceId,
    name: graph.name,
    role: graph.role,
    contexts: graph.contexts ?? [],
    subgroups: graph.subgroups ?? [],
  });
  const walk = (g: GraphGroup) => {
    byId.set(g.groupId, g);
    (g.subgroups ?? []).forEach(walk);
  };
  (graph.subgroups ?? []).forEach(walk);
  return byId;
}

export async function mockNamespaceGraph(
  page: Page,
  graph: NamespaceGraph,
  failures: GraphFailures = {},
): Promise<GraphMock> {
  const roots = [graph, ...(graph.siblings ?? [])];
  const groups = new Map(roots.flatMap((r) => [...flatten(r)]));
  // Accounts a spec promoted to admin through `PUT .../role`.
  const promoted = new Set<string>();
  const applicationId = graph.applicationId ?? "installed-app-1";
  const calls: RecordedCall[] = [];

  const json = (body: unknown, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  // merod's ApiError renders as `{"error": message}` at its status
  // (crates/server/src/admin/service.rs, `impl IntoResponse for ApiError`).
  const failure = (f: GraphFailure) => json({ error: f.message }, f.status);

  const membersOf = (groupId: string) => {
    const g = groups.get(groupId);
    const members: { identity: string; role: string; name?: string }[] = [
      ...(roots.find((r) => r.namespaceId === groupId)?.otherMembers ?? [{ identity: OTHER_ACCOUNT_ID, role: "Admin", name: "someone else" }]),
    ];
    if (g?.role) members.push({ identity: MOCK_ACCOUNT_ID, role: g.role });
    return { members };
  };

  await page.route("**/admin-api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const raw = route.request().postData();
    calls.push({ method, path, ...(raw ? { body: JSON.parse(raw) } : {}) });

    const seg = path.replace(/^\/admin-api\//, "").split("/");

    // GET /admin-api/identity
    if (path.endsWith("/admin-api/identity") && method === "GET") {
      return route.fulfill(
        json({
          data: {
            accountId: MOCK_ACCOUNT_ID,
            deviceId: "dev-1",
            publicKey: "pk-1",
            ...(graph.holdsAccountRoot === undefined
              ? {}
              : { holdsAccountRoot: graph.holdsAccountRoot }),
          },
        }),
      );
    }

    // ── namespaces ──
    if (seg[0] === "namespaces") {
      // GET /admin-api/namespaces
      if (seg.length === 1 && method === "GET") {
        return route.fulfill(
          json({
            data: roots.map((r) => ({
              namespaceId: r.namespaceId,
              bytecodeId: "bytecode-1",
              targetApplicationId: applicationId,
              createdAt: 0,
              name: r.name,
              memberCount: 2,
              contextCount: (r.contexts ?? []).length,
              subgroupCount: (r.subgroups ?? []).length,
              ...(r.appVersion ? { appVersion: r.appVersion } : {}),
            })),
          }),
        );
      }
      // POST /admin-api/namespaces/:id/leave
      if (seg.length === 3 && seg[2] === "leave" && method === "POST") {
        return failures.leaveNamespace
          ? route.fulfill(failure(failures.leaveNamespace))
          : route.fulfill(
              json({ data: { namespaceId: seg[1], memberPublicKey: "pk-1" } }),
            );
      }
      // GET /admin-api/namespaces/:id/groups
      if (seg.length === 3 && seg[2] === "groups" && method === "GET") {
        const g = groups.get(seg[1]);
        return route.fulfill(
          json({
            data: (g?.subgroups ?? []).map((s) => ({ groupId: s.groupId, name: s.name })),
          }),
        );
      }
      // DELETE /admin-api/namespaces/:id
      if (seg.length === 2 && method === "DELETE") {
        return failures.deleteNamespace
          ? route.fulfill(failure(failures.deleteNamespace))
          : route.fulfill(json({ data: { isDeleted: true } }));
      }
    }

    // ── groups ──
    if (seg[0] === "groups") {
      const groupId = seg[1];
      // GET /admin-api/groups/:id/members
      if (seg.length === 3 && seg[2] === "members" && method === "GET") {
        if (failures.listMembers) return route.fulfill(failure(failures.listMembers));
        return route.fulfill(json(membersOf(groupId)));
      }
      // PUT /admin-api/groups/:id/members/:identity/role
      if (seg.length === 5 && seg[2] === "members" && seg[4] === "role" && method === "PUT") {
        if (failures.updateMemberRole) return route.fulfill(failure(failures.updateMemberRole));
        promoted.add(seg[3]);
        return route.fulfill(json({ data: {} }));
      }
      // POST /admin-api/groups/:id/transfer-ownership
      if (seg.length === 3 && seg[2] === "transfer-ownership" && method === "POST") {
        // Core checks ownership first, then that the successor is an admin (409).
        if (failures.transferOwnership) return route.fulfill(failure(failures.transferOwnership));
        const target = JSON.parse(route.request().postData() ?? "{}").newOwner as string;
        const isAdmin =
          promoted.has(target) ||
          membersOf(groupId).members.some((m) => m.identity === target && m.role === "Admin");
        if (!isAdmin) return route.fulfill(json({ error: "the new owner is not an admin" }, 409));
        if (failures.transferAfterPromotion && promoted.has(target)) {
          return route.fulfill(failure(failures.transferAfterPromotion));
        }
        return route.fulfill(json({ data: {} }));
      }
      // GET /admin-api/groups/:id/contexts
      if (seg.length === 3 && seg[2] === "contexts" && method === "GET") {
        return route.fulfill(json({ data: groups.get(groupId)?.contexts ?? [] }));
      }
      // GET /admin-api/groups/:id/subgroups — NOT `data`-wrapped: mero-js reads
      // `response.subgroups` off the raw body for this one route.
      if (seg.length === 3 && seg[2] === "subgroups" && method === "GET") {
        return route.fulfill(
          json({
            subgroups: (groups.get(groupId)?.subgroups ?? []).map((s) => ({
              groupId: s.groupId,
              name: s.name,
            })),
          }),
        );
      }
      // POST /admin-api/groups/:id/leave
      if (seg.length === 3 && seg[2] === "leave" && method === "POST") {
        return failures.leaveGroup
          ? route.fulfill(failure(failures.leaveGroup))
          : route.fulfill(json({ data: { groupId, memberPublicKey: "pk-1" } }));
      }
      // GET /admin-api/groups/:id
      if (seg.length === 2 && method === "GET") {
        const g = groups.get(groupId);
        return route.fulfill(
          json({
            data: {
              groupId,
              memberCount: 2,
              contextCount: (g?.contexts ?? []).length,
              upgradePolicy: "Automatic",
              subgroupVisibility: "Open",
              metadata: { name: g?.name },
            },
          }),
        );
      }
      // DELETE /admin-api/groups/:id
      if (seg.length === 2 && method === "DELETE") {
        return failures.deleteGroup
          ? route.fulfill(failure(failures.deleteGroup))
          : route.fulfill(json({ data: { isDeleted: true } }));
      }
    }

    // ── contexts ──
    if (seg[0] === "contexts" && seg.length >= 2) {
      // POST /admin-api/contexts/:id/leave
      if (seg.length === 3 && seg[2] === "leave" && method === "POST") {
        return failures.leaveContext
          ? route.fulfill(failure(failures.leaveContext))
          : route.fulfill(json({ data: { contextId: seg[1], memberPublicKey: "pk-1" } }));
      }
      // DELETE /admin-api/contexts/:id
      if (seg.length === 2 && method === "DELETE") {
        return failures.deleteContext
          ? route.fulfill(failure(failures.deleteContext))
          : route.fulfill(json({ data: { isDeleted: true } }));
      }
    }

    // Health, applications, context listing — already handled by mockCoreAPIs.
    return route.fallback();
  });

  return {
    calls,
    pathsFor: (method: string) =>
      calls.filter((c) => c.method === method).map((c) => c.path),
  };
}
