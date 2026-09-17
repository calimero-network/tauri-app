import { describe, it, expect } from "vitest";
import type { AccountApplication, NamespaceSummary, PairInitResult } from "../lib/device-link";
import {
  applicationLabel,
  certifiedIntoAccount,
  installableApps,
  buildInvite,
  inviteApps,
  decodeInvite,
  decodeReply,
  encodeInvite,
  encodeReply,
  inviteNamespaces,
  scopeTiles,
  tileNamespaceCount,
  canLeaveScopeStep,
} from "./DevicePairing";

const INIT: PairInitResult = {
  accountId: "a".repeat(64),
  deviceId: "b".repeat(64),
  kemPublicKey: "c".repeat(64),
  signPublicKey: "d".repeat(64),
  statement: "e".repeat(128),
  confirmationCode: "7BC0-DAAC",
};

const ROOT_KEY = "f".repeat(64);
const ACCOUNT_NS = "9".repeat(64);

const NAMESPACES: NamespaceSummary[] = [
  { namespaceId: "ns-chat-1", name: "Chat", targetApplicationId: "AppChat" },
  { namespaceId: "ns-chat-2", targetApplicationId: "AppChat" },
  { namespaceId: "ns-drive", name: "Drive", targetApplicationId: "AppDrive" },
];

describe("invite blob", () => {
  it("round trips the root key and every namespace", () => {
    const invite = { rootKey: ROOT_KEY, namespaces: ["ns-1", "ns-2"] };
    expect(decodeInvite(encodeInvite(invite))).toEqual(invite);
  });

  it("tolerates the whitespace a paste brings with it", () => {
    const invite = { rootKey: ROOT_KEY, namespaces: ["ns-1"] };
    expect(decodeInvite(`\n  ${encodeInvite(invite)}  \n`)).toEqual(invite);
  });

  it("round trips an invite that names only the account namespace", () => {
    const invite = { rootKey: ROOT_KEY, namespaces: [], accountNamespace: ACCOUNT_NS };
    expect(decodeInvite(encodeInvite(invite))).toEqual(invite);
  });

  it("rejects an invite naming neither a namespace nor the account one", () => {
    expect(decodeInvite(encodeInvite({ rootKey: ROOT_KEY, namespaces: [] }))).toBeNull();
  });

  it("defaults a missing namespace list to none, so the account namespace carries it", () => {
    const blob = `mero-pair:${btoa(
      JSON.stringify({ rootKey: ROOT_KEY, accountNamespace: ACCOUNT_NS }),
    )}`;
    expect(decodeInvite(blob)).toEqual({
      rootKey: ROOT_KEY,
      namespaces: [],
      accountNamespace: ACCOUNT_NS,
    });
  });

  it("drops namespace entries that are not ids", () => {
    const blob = `mero-pair:${btoa(
      JSON.stringify({ rootKey: ROOT_KEY, namespaces: ["ns-1", 7, "", null] }),
    )}`;
    expect(decodeInvite(blob)).toEqual({ rootKey: ROOT_KEY, namespaces: ["ns-1"] });
  });

  it("rejects anything that is not an invite", () => {
    expect(decodeInvite("")).toBeNull();
    expect(decodeInvite("hello")).toBeNull();
    expect(decodeInvite("mero-pair:not-base64!!")).toBeNull();
    expect(decodeInvite(encodeReply(INIT))).toBeNull();
    expect(decodeInvite(`mero-pair:${btoa(JSON.stringify({ rootKey: "x" }))}`)).toBeNull();
  });
});

describe("buildInvite", () => {
  it("names the account namespace when this node reports one", () => {
    expect(
      buildInvite({ rootKey: ROOT_KEY, namespaces: ["ns-1"], apps: [], accountNamespaceId: ACCOUNT_NS }),
    ).toEqual({ rootKey: ROOT_KEY, namespaces: ["ns-1"], accountNamespace: ACCOUNT_NS });
  });

  it("leaves the key out when the node reports none", () => {
    const invite = buildInvite({
      rootKey: ROOT_KEY,
      namespaces: ["ns-1"],
      apps: [],
      accountNamespaceId: null,
    });

    expect("accountNamespace" in invite).toBe(false);
    expect(invite).toEqual({ rootKey: ROOT_KEY, namespaces: ["ns-1"] });
  });

  it("keeps naming the namespaces, for a node that cannot follow an account one", () => {
    const apps = [{ package: "com.calimero.chat", version: "1.0.0" }];
    expect(
      buildInvite({ rootKey: ROOT_KEY, namespaces: ["ns-1"], apps, accountNamespaceId: ACCOUNT_NS }),
    ).toEqual({
      rootKey: ROOT_KEY,
      namespaces: ["ns-1"],
      accountNamespace: ACCOUNT_NS,
      apps,
    });
  });
});

describe("reply blob", () => {
  it("round trips the four fields pair-complete needs", () => {
    expect(decodeReply(encodeReply(INIT))).toEqual({
      deviceId: INIT.deviceId,
      kemPublicKey: INIT.kemPublicKey,
      signPublicKey: INIT.signPublicKey,
      statement: INIT.statement,
    });
  });

  it("never carries the confirmation code, which must travel by voice", () => {
    const blob = encodeReply(INIT);
    expect(blob).not.toContain(INIT.confirmationCode);
    const body = JSON.parse(atob(blob.slice("mero-pair-reply:".length)));
    expect(Object.keys(body).sort()).toEqual([
      "deviceId",
      "kemPublicKey",
      "signPublicKey",
      "statement",
    ]);
  });

  it("rejects an invite pasted into the response box", () => {
    expect(decodeReply(encodeInvite({ rootKey: ROOT_KEY, namespaces: ["ns-1"] }))).toBeNull();
    expect(decodeReply("mero-pair-reply:")).toBeNull();
  });
});

describe("inviteNamespaces", () => {
  it("names every namespace when the device gets everything", () => {
    expect(inviteNamespaces(NAMESPACES)).toEqual(["ns-chat-1", "ns-chat-2", "ns-drive"]);
  });

  it("names only the namespaces a chosen application targets", () => {
    expect(inviteNamespaces(NAMESPACES, ["AppDrive"])).toEqual(["ns-drive"]);
  });

  it("keeps every namespace of a chosen application, not just the first", () => {
    expect(inviteNamespaces(NAMESPACES, ["AppChat"])).toEqual(["ns-chat-1", "ns-chat-2"]);
  });

  it("names nothing when nothing is chosen, which is not the same as everything", () => {
    expect(inviteNamespaces(NAMESPACES, [])).toEqual([]);
  });

  it("names nothing for an application this node holds no namespace for", () => {
    expect(inviteNamespaces(NAMESPACES, ["AppUnknown"])).toEqual([]);
  });
});

describe("applicationLabel", () => {
  it("labels an application by the namespaces targeting it", () => {
    expect(applicationLabel("AppChat", NAMESPACES)).toBe("Chat");
    expect(applicationLabel("AppDrive", NAMESPACES)).toBe("Drive");
  });

  it("joins the names when several namespaces target one application", () => {
    const named: NamespaceSummary[] = [
      { namespaceId: "ns-1", name: "Work", targetApplicationId: "AppChat" },
      { namespaceId: "ns-2", name: "Home", targetApplicationId: "AppChat" },
    ];
    expect(applicationLabel("AppChat", named)).toBe("Work, Home");
  });

  it("falls back to the id when no namespace targeting it is named", () => {
    const unnamed: NamespaceSummary[] = [
      { namespaceId: "ns-1", targetApplicationId: "AppLongIdentifierHere" },
    ];
    expect(applicationLabel("AppLongIdentifierHere", unnamed)).toBe("AppLongIdent…");
  });
});

describe("applicationLabel with an installed application", () => {
  const ns: NamespaceSummary[] = [
    { namespaceId: "a".repeat(64), name: "Calimero", targetApplicationId: "app-1" },
  ];

  it("prefers the application's own name over the namespace that targets it", () => {
    const installed = [{ id: "app-1", name: "Mero Chat", metadata: [] }];
    expect(applicationLabel("app-1", ns, installed)).toBe("Mero Chat");
  });

  it("reads the name out of encoded metadata when the row carries none", () => {
    const metadata = btoa(JSON.stringify({ name: "Mero Drive" }));
    const installed = [{ id: "app-1", name: undefined, metadata }];
    expect(applicationLabel("app-1", ns, installed)).toBe("Mero Drive");
  });

  it("falls back to the namespace when the application is not installed here", () => {
    expect(applicationLabel("app-1", ns, [])).toBe("Calimero");
    expect(applicationLabel("app-1", ns)).toBe("Calimero");
  });
});

describe("installableApps", () => {
  it("keeps coordinates the registry would resolve", () => {
    expect(installableApps([{ package: "com.calimero.chat", version: "3.1.1" }])).toEqual([
      { package: "com.calimero.chat", version: "3.1.1" },
    ]);
  });

  it("keeps a scoped package name", () => {
    expect(installableApps([{ package: "@calimero/chat", version: "1.0.0" }])).toEqual([
      { package: "@calimero/chat", version: "1.0.0" },
    ]);
  });

  it("drops an app with no coordinates, which no registry could resolve", () => {
    expect(installableApps([{ package: "", version: "1.0" }, { package: "x" }, {}])).toEqual([]);
  });

  it("drops coordinates carrying a path, which a pasted blob must not smuggle in", () => {
    expect(
      installableApps([
        { package: "../../etc/passwd", version: "1.0" },
        { package: "ok", version: "../1.0" },
        { package: "http://evil/x", version: "1.0" },
      ]),
    ).toEqual([]);
  });

  it("is empty for an invite that offers none", () => {
    expect(installableApps(undefined)).toEqual([]);
    expect(installableApps("not a list")).toEqual([]);
  });
});

describe("inviteApps", () => {
  const installed = [
    { id: "app-1", package: "com.calimero.chat", version: "3.1.1" },
    { id: "app-2", package: "com.calimero.kv-store", version: "0.0.11" },
    { id: "app-3" },
  ];

  it("offers only the apps the scope names", () => {
    expect(inviteApps(["app-2"], installed)).toEqual([
      { package: "com.calimero.kv-store", version: "0.0.11" },
    ]);
  });

  it("offers every installed app when the scope names none, as core reads it", () => {
    expect(inviteApps(undefined, installed).map((a) => a.package)).toEqual([
      "com.calimero.chat",
      "com.calimero.kv-store",
    ]);
  });

  it("leaves out an app installed outside a registry, which has no coordinates", () => {
    expect(inviteApps(["app-3"], installed)).toEqual([]);
  });

  it("is empty when nothing is installed", () => {
    expect(inviteApps(["app-1"], [])).toEqual([]);
  });
});

describe("certifiedIntoAccount", () => {
  const device = (extra: Record<string, unknown> = {}) =>
    ({
      deviceId: "d".repeat(64),
      signingKey: "s".repeat(64),
      isSelf: true,
      revoked: false,
      applications: [],
      namespaces: [],
      ...extra,
    }) as never;

  it("is certified once the account's roster names this device", () => {
    expect(certifiedIntoAccount([device()])).toBe(true);
  });

  it("is not certified while the roster has not arrived", () => {
    // The listing is empty until `pair-complete` publishes, which is the whole
    // reason it can serve as the signal that identity cannot.
    expect(certifiedIntoAccount([])).toBe(false);
  });

  it("is not certified by another device's row alone", () => {
    expect(certifiedIntoAccount([device({ isSelf: false })])).toBe(false);
  });

  it("does not count a revoked row as a live link", () => {
    expect(certifiedIntoAccount([device({ revoked: true })])).toBe(false);
  });
});

describe("scopeTiles", () => {
  const accountApps: AccountApplication[] = [
    { applicationId: "AppChat", namespaces: ["ns-chat-1", "ns-chat-2"] },
    { applicationId: "AppDrive", namespaces: ["ns-drive"] },
  ];

  it("names every app the account speaks in, with what it would cover", () => {
    expect(scopeTiles(accountApps, NAMESPACES, [])).toEqual([
      { applicationId: "AppChat", name: "Chat", namespaces: 2 },
      { applicationId: "AppDrive", name: "Drive", namespaces: 1 },
    ]);
  });

  it("carries the installed app's icon onto its tile, as the app card shows it", () => {
    const icon = "data:image/png;base64,QUJD";
    const installed = [
      { id: "AppChat", name: "Mero Chat", metadata: btoa(JSON.stringify({ name: "Mero Chat", icon })) },
    ];
    const chat = scopeTiles(accountApps, NAMESPACES, installed).find((t) => t.applicationId === "AppChat");
    expect(chat?.icon).toBe(icon);
  });

  it("offers an installed app the account has no namespace for yet", () => {
    const installed = [{ id: "AppNotes", name: "Notes", metadata: [] }];
    expect(scopeTiles(accountApps, NAMESPACES, installed)).toEqual([
      { applicationId: "AppChat", name: "Chat", namespaces: 2 },
      { applicationId: "AppDrive", name: "Drive", namespaces: 1 },
      { applicationId: "AppNotes", name: "Notes", namespaces: 0 },
    ]);
  });

  it("lists an app the account uses and this node has installed only once", () => {
    const installed = [{ id: "AppChat", name: "Mero Chat", metadata: [] }];
    const tiles = scopeTiles(accountApps, NAMESPACES, installed);

    expect(tiles.map((t) => t.applicationId).sort()).toEqual(["AppChat", "AppDrive"]);
    expect(tiles.find((t) => t.applicationId === "AppChat")).toEqual({
      applicationId: "AppChat",
      name: "Mero Chat",
      namespaces: 2,
    });
  });

  it("puts the apps with no namespace last, and orders each group by name", () => {
    const installed = [
      { id: "AppZeta", name: "Zeta", metadata: [] },
      { id: "AppAlpha", name: "Alpha", metadata: [] },
    ];
    expect(scopeTiles(accountApps, NAMESPACES, installed).map((t) => t.name)).toEqual([
      "Chat",
      "Drive",
      "Alpha",
      "Zeta",
    ]);
  });

  it("has nothing to offer on an account with no app and no install", () => {
    expect(scopeTiles([], [], [])).toEqual([]);
  });
});

describe("tileNamespaceCount", () => {
  it("counts what picking the app would cover", () => {
    expect(tileNamespaceCount(2)).toBe("2 namespaces");
    expect(tileNamespaceCount(1)).toBe("1 namespace");
  });

  it("says an app with none is still offerable rather than empty", () => {
    expect(tileNamespaceCount(0)).toBe("no namespace yet");
  });
});

describe("canLeaveScopeStep", () => {
  it("lets everything through, which needs no app ticked", () => {
    expect(canLeaveScopeStep(true, [])).toBe(true);
  });

  it("holds the chosen-apps path back until one is ticked", () => {
    expect(canLeaveScopeStep(false, [])).toBe(false);
    expect(canLeaveScopeStep(false, ["AppChat"])).toBe(true);
  });
});
