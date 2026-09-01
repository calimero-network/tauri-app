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
  /** This node's role at the namespace ROOT. */
  role?: string;
  contexts?: GraphContext[];
  subgroups?: GraphGroup[];
}

export interface RecordedCall {
  method: string;
  /** Path only, e.g. `/admin-api/namespaces/ns-1/leave`. */
  path: string;
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
export interface GraphFailures {
  deleteNamespace?: string;
  leaveNamespace?: string;
  deleteGroup?: string;
  leaveGroup?: string;
  deleteContext?: string;
  leaveContext?: string;
}

/**
 * merod's `MembershipError::NotAdmin` — what `delete_namespace` and
 * `delete_context` refuse a non-admin with.
 */
export const NOT_ADMIN_BODY = `identity ${MOCK_ACCOUNT_ID} is not an admin of group 0xdeadbeef`;

/**
 * What `delete_group` refuses with instead. It does NOT run `require_admin`:
 * it admits the subgroup's owner, an admin of the namespace root, or a member
 * holding `CAN_DELETE_SUBGROUP`, so the refusal is
 * `CapabilitiesError::Unauthorized` wrapped by the handler — different wording
 * entirely (crates/context/src/handlers/delete_group.rs).
 */
export const NOT_PERMITTED_SUBGROUP_BODY =
  "deleting subgroup '0xdeadbeef': requester lacks permission to delete subgroup " +
  '(CAN_DELETE_SUBGROUP) in group 0xdeadbeef (or be its owner)';

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
  const groups = flatten(graph);
  const applicationId = graph.applicationId ?? "installed-app-1";
  const calls: RecordedCall[] = [];

  const json = (body: unknown, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  // merod answers an admin-gated refusal with a bare 500 carrying the eyre
  // message — no typed code — which is what `parseApiError` has to read.
  const failure = (message: string) => json({ error: message }, 500);

  const membersOf = (groupId: string) => {
    const g = groups.get(groupId);
    const members: { identity: string; role: string; name?: string }[] = [
      { identity: OTHER_ACCOUNT_ID, role: "Admin", name: "someone else" },
    ];
    if (g?.role) members.push({ identity: MOCK_ACCOUNT_ID, role: g.role });
    return { members };
  };

  await page.route("**/admin-api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    calls.push({ method, path });

    const seg = path.replace(/^\/admin-api\//, "").split("/");

    // GET /admin-api/identity
    if (path.endsWith("/admin-api/identity") && method === "GET") {
      return route.fulfill(
        json({ data: { accountId: MOCK_ACCOUNT_ID, deviceId: "dev-1", publicKey: "pk-1" } }),
      );
    }

    // ── namespaces ──
    if (seg[0] === "namespaces") {
      // GET /admin-api/namespaces
      if (seg.length === 1 && method === "GET") {
        return route.fulfill(
          json({
            data: [
              {
                namespaceId: graph.namespaceId,
                bytecodeId: "bytecode-1",
                targetApplicationId: applicationId,
                createdAt: 0,
                name: graph.name,
                memberCount: 2,
                contextCount: (graph.contexts ?? []).length,
                subgroupCount: (graph.subgroups ?? []).length,
              },
            ],
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
        return route.fulfill(json(membersOf(groupId)));
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
