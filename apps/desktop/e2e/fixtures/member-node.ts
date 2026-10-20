import type { Page } from "@playwright/test";
import { API_ROUTES, MOCK_INSTALLED_APPS, listApplicationsWireBody } from "./mock-data";
import { mockNamespaceGraph } from "./namespace-graph";

export const NS_ID = "ns0000000000000000000000000000000000000000000000000000000000002";
export const SUB_ID = "sg0000000000000000000000000000000000000000000000000000000000003";
export const APP = MOCK_INSTALLED_APPS[0];

type Activate = "ok" | "moved" | "partial";

/**
 * A member's node whose namespace was upgraded by an admin: the namespace names
 * `target`, while each context held here runs the release in `held`. Tests
 * mutate the fields to steer the next answer.
 */
export interface MemberNode {
  target: string;
  /** The release this node's application row names. */
  installed: string;
  /** Where a `moved` answer sends the namespace. */
  movedTo: string;
  /** What the next activate does. */
  activate: Activate;
  held: Record<string, { groupId: string; version: string }>;
  installs: unknown[];
  activations: unknown[];
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

export async function mockMemberNode(page: Page, init: Partial<MemberNode> = {}): Promise<MemberNode> {
  const node: MemberNode = {
    target: "2.0.0",
    installed: "2.0.0",
    movedTo: "3.0.0",
    activate: "ok",
    held: {
      "ctx-1": { groupId: NS_ID, version: "1.0.0" },
      "ctx-2": { groupId: SUB_ID, version: "1.0.0" },
      "ctx-3": { groupId: SUB_ID, version: "2.0.0" },
    },
    installs: [],
    activations: [],
    ...init,
  };

  await mockNamespaceGraph(page, {
    namespaceId: NS_ID,
    name: "Workspace",
    applicationId: APP.id,
    appVersion: node.target,
    role: "Member",
    contexts: [{ contextId: "ctx-1", name: "general" }],
    subgroups: [{ groupId: SUB_ID, name: "Design", role: "Member", contexts: [{ contextId: "ctx-2", name: "chat" }] }],
  });

  await page.route(
    (url) => url.pathname === "/admin-api/namespaces",
    (route) =>
      route.fulfill(
        json({
          data: [
            {
              namespaceId: NS_ID,
              appKey: "bytecode-1",
              targetApplicationId: APP.id,
              createdAt: 0,
              name: "Workspace",
              memberCount: 2,
              contextCount: 1,
              subgroupCount: 1,
              appVersion: node.target,
              appPackage: "only-peers-chat",
            },
          ],
        }),
      ),
  );
  await page.route(
    (url) => url.pathname.includes("/api/v2/bundles"),
    (route) =>
      route.fulfill(json([{ package: "only-peers-chat", appVersion: node.target, yanked: false }])),
  );
  await page.route(API_ROUTES.listApplications, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: listApplicationsWireBody([{ ...APP, version: node.installed }]),
    }),
  );
  await page.route(API_ROUTES.installApplication, (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    node.installs.push(body);
    node.installed = body.version;
    return route.fulfill(json({ data: { applicationId: APP.id } }));
  });
  await page.route(
    (url) => url.pathname === "/admin-api/contexts" || url.pathname.startsWith("/admin-api/contexts/for-application/"),
    (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return route.fulfill(
        json({
          data: {
            contexts: Object.entries(node.held).map(([id, c]) => ({
              id,
              applicationId: APP.id,
              contextStateHash: "",
              groupId: c.groupId,
              applicationVersion: c.version,
            })),
          },
        }),
      );
    },
  );
  await page.route(`**/admin-api/groups/${NS_ID}/upgrade/activate`, (route) => {
    node.activations.push(JSON.parse(route.request().postData() ?? "{}"));
    const mode = node.activate;
    if (mode === "moved") {
      node.target = node.movedTo;
      return route.fulfill(json({ error: "the namespace target changed" }, 409));
    }
    if (mode === "partial") {
      node.activate = "ok";
      return route.fulfill(
        json({
          data: {
            targetApplicationId: APP.id,
            switchedContexts: 0,
            replayedDeltas: 0,
            failedContexts: [{ contextId: "ctx-2", error: "migration failed", retryable: true }],
          },
        }),
      );
    }
    for (const c of Object.values(node.held)) c.version = node.target;
    return route.fulfill(
      json({
        data: { targetApplicationId: APP.id, switchedContexts: 2, replayedDeltas: 0, failedContexts: [] },
      }),
    );
  });
  return node;
}
