/**
 * Delete-vs-Leave on the Namespaces page.
 *
 * merod gates every destructive call on `require_admin` against the group that
 * owns the thing, so a non-admin who is shown Delete gets a dead-end button:
 *
 *   DELETE /admin-api/namespaces/:id  → admin of the namespace root
 *   DELETE /admin-api/groups/:id      → admin of that subgroup
 *   DELETE /admin-api/contexts/:id    → admin of the context's OWNING group
 *
 * The self-service counterparts carry no role gate at all, and they are what a
 * member needs:
 *
 *   POST /admin-api/namespaces/:id/leave
 *   POST /admin-api/groups/:id/leave
 *   POST /admin-api/contexts/:id/leave
 *
 * These specs assert on the ROUTE the UI calls, not just on the button label.
 * The bug they exist for was a "Leave" button — shown only to non-admins —
 * wired to `removeGroupMembers`, i.e. `POST /admin-api/groups/:id/members/
 * remove`, which runs `governance_preflight(group_id, require_admin = true)`.
 * The label was right, the toast copy was right, and the call could only ever
 * fail for the one audience that saw it. A label-only assertion passes on that
 * bug; a route assertion does not.
 */
import { test, expect } from "./fixtures/test";
import { setupDeveloperPage, navigateVia } from "./fixtures/helpers";
import {
  mockNamespaceGraph,
  NOT_ADMIN_BODY,
  NOT_PERMITTED_SUBGROUP_BODY,
  type GraphFailures,
  type NamespaceGraph,
} from "./fixtures/namespace-graph";

const NS_ID = "ns0000000000000000000000000000000000000000000000000000000000001";
const SG_ID = "sg0000000000000000000000000000000000000000000000000000000000001";
const ROOT_CTX = "ctxroot00000000000000000000000000000000000000000000000000000001";
const SG_CTX = "ctxsub000000000000000000000000000000000000000000000000000000001";

/**
 * @param rootRole  our role at the namespace root
 * @param subRole   our role in the one subgroup under it
 */
function graph(rootRole: string | undefined, subRole: string | undefined): NamespaceGraph {
  return {
    namespaceId: NS_ID,
    name: "Workspace",
    role: rootRole,
    contexts: [{ contextId: ROOT_CTX, name: "root channel" }],
    subgroups: [
      {
        groupId: SG_ID,
        name: "general",
        role: subRole,
        contexts: [{ contextId: SG_CTX, name: "general channel" }],
        subgroups: [],
      },
    ],
  };
}

async function openNamespace(
  page: import("@playwright/test").Page,
  g: NamespaceGraph,
  failures?: GraphFailures,
) {
  await setupDeveloperPage(page);
  const mock = await mockNamespaceGraph(page, g, failures);
  await navigateVia(page, "Namespaces");
  await page.locator(".ns-card").first().click();
  // The tree is what carries the per-row Delete/Leave decision; wait for it
  // rather than for the header, so no assertion races the member fetches.
  await expect(page.locator(".ns-tree-row.ns-tree-context").first()).toBeVisible();
  return mock;
}

/** The namespace-level actions menu (⋯ next to the title). */
async function openActionsMenu(page: import("@playwright/test").Page) {
  await page.locator(".ns-actions-menu-btn").click();
  await expect(page.locator(".ns-actions-menu")).toBeVisible();
}

// ─── Namespace root ─────────────────────────────────────────────────────────

test.describe("Namespace root – Delete vs Leave", () => {
  test("a plain member is offered Leave, and it posts to the self-service leave route", async ({
    page,
  }) => {
    const mock = await openNamespace(page, graph("Member", "Member"));
    await openActionsMenu(page);

    const menu = page.locator(".ns-actions-menu");
    await expect(menu.getByText("Leave", { exact: true })).toBeVisible();
    await expect(menu.getByText("Delete", { exact: true })).toHaveCount(0);

    await menu.getByText("Leave", { exact: true }).click();
    await expect(page.locator(".ns-modal h2")).toHaveText("Leave Namespace");
    await page.locator(".ns-delete-confirm-btn").click();

    await expect(page.getByText("Left namespace")).toBeVisible();
    expect(mock.pathsFor("POST")).toContain(`/admin-api/namespaces/${NS_ID}/leave`);
    // The regression: `removeGroupMembers` is admin-only, so leaving must NOT
    // go anywhere near it.
    expect(mock.pathsFor("POST")).not.toContain(
      `/admin-api/groups/${NS_ID}/members/remove`,
    );
    expect(mock.pathsFor("DELETE")).not.toContain(`/admin-api/namespaces/${NS_ID}`);
  });

  test("an admin is offered Delete, and it uses the DELETE route", async ({ page }) => {
    const mock = await openNamespace(page, graph("Admin", "Admin"));
    await openActionsMenu(page);

    const menu = page.locator(".ns-actions-menu");
    await expect(menu.getByText("Delete", { exact: true })).toBeVisible();
    await expect(menu.getByText("Leave", { exact: true })).toHaveCount(0);

    await menu.getByText("Delete", { exact: true }).click();
    await expect(page.locator(".ns-modal h2")).toHaveText("Delete Namespace");
    await page.locator(".ns-delete-confirm-btn").click();

    await expect(page.getByText("Namespace deleted")).toBeVisible();
    expect(mock.pathsFor("DELETE")).toContain(`/admin-api/namespaces/${NS_ID}`);
  });

  test("an Observer is a non-admin too — anything but Admin gets Leave", async ({ page }) => {
    await openNamespace(page, graph("Observer", "Observer"));
    await openActionsMenu(page);
    await expect(
      page.locator(".ns-actions-menu").getByText("Leave", { exact: true }),
    ).toBeVisible();
  });

  test("a node with no member row at the root keeps Delete — an unknown role is not a licence to guess", async ({
    page,
  }) => {
    await openNamespace(page, graph(undefined, "Member"));
    await openActionsMenu(page);
    await expect(
      page.locator(".ns-actions-menu").getByText("Delete", { exact: true }),
    ).toBeVisible();
  });
});

// ─── Subgroups ──────────────────────────────────────────────────────────────

test.describe("Subgroup – Delete vs Leave", () => {
  test("a member of the subgroup gets Leave, and it posts to the group leave route", async ({
    page,
  }) => {
    const mock = await openNamespace(page, graph("Member", "Member"));

    const row = page.locator(".ns-tree-row.ns-tree-subgroup");
    await row.getByTitle("Leave subgroup").click();
    await expect(page.locator(".ns-modal h2")).toHaveText("Leave Subgroup");
    await page.locator(".ns-delete-confirm-btn").click();

    await expect(page.getByText("Left subgroup")).toBeVisible();
    expect(mock.pathsFor("POST")).toContain(`/admin-api/groups/${SG_ID}/leave`);
    expect(mock.pathsFor("DELETE")).not.toContain(`/admin-api/groups/${SG_ID}`);
  });

  test("an admin of the subgroup gets Delete", async ({ page }) => {
    const mock = await openNamespace(page, graph("Admin", "Admin"));

    const row = page.locator(".ns-tree-row.ns-tree-subgroup");
    await row.getByTitle("Delete subgroup").click();
    await expect(page.locator(".ns-modal h2")).toHaveText("Delete Subgroup");
    await page.locator(".ns-delete-confirm-btn").click();

    await expect(page.getByText("Group deleted")).toBeVisible();
    expect(mock.pathsFor("DELETE")).toContain(`/admin-api/groups/${SG_ID}`);
  });

  // The decision is per group, not per namespace: subgroup admin-ship is not
  // inherited from the root's member list, so a root Admin can be a plain
  // Member of a subgroup somebody else created under it.
  test("a root admin who is only a member of the subgroup gets Delete at the root and Leave on the subgroup", async ({
    page,
  }) => {
    await openNamespace(page, graph("Admin", "Member"));

    await expect(
      page.locator(".ns-tree-row.ns-tree-subgroup").getByTitle("Leave subgroup"),
    ).toBeVisible();

    await openActionsMenu(page);
    await expect(
      page.locator(".ns-actions-menu").getByText("Delete", { exact: true }),
    ).toBeVisible();
  });

  test("and the reverse: a root member who admins the subgroup gets Leave at the root and Delete on the subgroup", async ({
    page,
  }) => {
    await openNamespace(page, graph("Member", "Admin"));

    await expect(
      page.locator(".ns-tree-row.ns-tree-subgroup").getByTitle("Delete subgroup"),
    ).toBeVisible();

    await openActionsMenu(page);
    await expect(
      page.locator(".ns-actions-menu").getByText("Leave", { exact: true }),
    ).toBeVisible();
  });
});

// ─── Contexts ───────────────────────────────────────────────────────────────

test.describe("Context – Delete vs Leave", () => {
  test("a root context follows the ROOT's role and leaves via the context leave route", async ({
    page,
  }) => {
    const mock = await openNamespace(page, graph("Member", "Member"));

    const row = page.locator(".ns-tree-row.ns-tree-context").first();
    await row.getByTitle("Leave context").click();
    await expect(page.locator(".ns-modal h2")).toHaveText("Leave Context");
    await page.locator(".ns-delete-confirm-btn").click();

    await expect(page.getByText("Left context")).toBeVisible();
    expect(mock.pathsFor("POST")).toContain(`/admin-api/contexts/${ROOT_CTX}/leave`);
    expect(mock.pathsFor("DELETE")).not.toContain(`/admin-api/contexts/${ROOT_CTX}`);
  });

  test("a root admin deletes a root context", async ({ page }) => {
    const mock = await openNamespace(page, graph("Admin", "Admin"));

    const row = page.locator(".ns-tree-row.ns-tree-context").first();
    await row.getByTitle("Delete context").click();
    await page.locator(".ns-delete-confirm-btn").click();

    await expect(page.getByText("Context deleted")).toBeVisible();
    expect(mock.pathsFor("DELETE")).toContain(`/admin-api/contexts/${ROOT_CTX}`);
  });

  // `delete_context` runs `require_admin` against the context's OWNING group,
  // which for a context inside a subgroup is that subgroup — not the root.
  test("a context inside a subgroup follows the SUBGROUP's role, not the root's", async ({
    page,
  }) => {
    const mock = await openNamespace(page, graph("Admin", "Member"));

    // The root context (owned by the root, where we are Admin) offers Delete.
    await expect(
      page.locator(".ns-tree-row.ns-tree-context").first().getByTitle("Delete context"),
    ).toBeVisible();

    // Expand the subgroup to reach the context it owns.
    await page.locator(".ns-tree-row.ns-tree-subgroup .ns-tree-toggle").click();
    const nested = page.locator(".ns-tree-row.ns-tree-context").filter({ hasText: "general channel" });
    await expect(nested).toBeVisible();
    await nested.getByTitle("Leave context").click();
    await page.locator(".ns-delete-confirm-btn").click();

    await expect(page.getByText("Left context")).toBeVisible();
    expect(mock.pathsFor("POST")).toContain(`/admin-api/contexts/${SG_CTX}/leave`);
  });
});

// ─── Failure reporting ──────────────────────────────────────────────────────

test.describe("A refused delete names the way out", () => {
  // The indeterminate window (member list still loading, identity unresolved,
  // role demoted since the fetch) keeps Delete on screen, so this path stays
  // reachable and must not read as a node fault.
  test("merod's NotAdmin refusal is reported as 'you can only leave it'", async ({ page }) => {
    await openNamespace(page, graph("Admin", "Admin"), {
      deleteNamespace: NOT_ADMIN_BODY,
    });
    await openActionsMenu(page);
    await page.locator(".ns-actions-menu").getByText("Delete", { exact: true }).click();
    await page.locator(".ns-delete-confirm-btn").click();

    await expect(
      page.getByText(/not an admin of this namespace — you can only leave it/),
    ).toBeVisible();
  });

  test("an unrelated failure is still reported verbatim, not as a permission problem", async ({
    page,
  }) => {
    await openNamespace(page, graph("Admin", "Admin"), {
      deleteNamespace: "namespace not found",
    });
    await openActionsMenu(page);
    await page.locator(".ns-actions-menu").getByText("Delete", { exact: true }).click();
    await page.locator(".ns-delete-confirm-btn").click();

    await expect(page.getByText(/Failed to delete namespace/)).toBeVisible();
    await expect(page.getByText(/namespace not found/)).toBeVisible();
  });

  // delete_group refuses with CapabilitiesError::Unauthorized, not NotAdmin.
  // A matcher that only knew the NotAdmin wording would surface this one raw.
  test("delete_group's differently-worded refusal is recognised too", async ({ page }) => {
    await openNamespace(page, graph("Admin", "Admin"), {
      deleteGroup: NOT_PERMITTED_SUBGROUP_BODY,
    });
    await page.locator(".ns-tree-row.ns-tree-subgroup").getByTitle("Delete subgroup").click();
    await page.locator(".ns-delete-confirm-btn").click();

    await expect(
      page.getByText(/not an admin of this subgroup — you can only leave it/),
    ).toBeVisible();
  });

  // A member who joined an Open subgroup by inheritance holds no direct
  // membership row, so `leave_group` refuses — but `list_group_members` unions
  // the inherited set in, so the role read offers Leave anyway and cannot know
  // better. The refusal has to be turned into the instruction merod is giving.
  test("an inherited subgroup membership is explained, not dumped raw", async ({ page }) => {
    await openNamespace(page, graph("Member", "Member"), {
      leaveGroup:
        "this node is not a direct member of ContextGroupId(0xabc); leave the parent group where the membership anchor lives instead",
    });
    await page.locator(".ns-tree-row.ns-tree-subgroup").getByTitle("Leave subgroup").click();
    await page.locator(".ns-delete-confirm-btn").click();

    await expect(
      page.getByText(/through your namespace membership.*leave the namespace instead/),
    ).toBeVisible();
  });

  test("a failed leave does not claim success", async ({ page }) => {
    await openNamespace(page, graph("Member", "Member"), {
      leaveNamespace: "gossip publish timed out",
    });
    await openActionsMenu(page);
    await page.locator(".ns-actions-menu").getByText("Leave", { exact: true }).click();
    await page.locator(".ns-delete-confirm-btn").click();

    await expect(page.getByText(/Failed to leave namespace/)).toBeVisible();
    await expect(page.getByText("Left namespace")).toHaveCount(0);
  });
});
