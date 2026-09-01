import { describe, it, expect } from "vitest";
import type { NamespaceSummary, PairInitResult } from "../lib/device-link";
import {
  applicationLabel,
  applicationNamespaces,
  decodeInvite,
  decodeReply,
  encodeInvite,
  encodeReply,
  inviteNamespaces,
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

  it("rejects an invite naming no namespace, which core would refuse anyway", () => {
    expect(decodeInvite(encodeInvite({ rootKey: ROOT_KEY, namespaces: [] }))).toBeNull();
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

describe("applicationNamespaces", () => {
  const ns: NamespaceSummary[] = [
    { namespaceId: "a".repeat(64), name: "Work", targetApplicationId: "app-1" },
    { namespaceId: "b".repeat(64), name: "Personal", targetApplicationId: "app-1" },
    { namespaceId: "c".repeat(64), name: "Other", targetApplicationId: "app-2" },
  ];

  it("names every namespace the application is spoken in, and no others", () => {
    expect(applicationNamespaces("app-1", ns)).toBe("Work, Personal");
  });

  it("falls back to a short id for a namespace with no name", () => {
    const unnamed: NamespaceSummary[] = [
      { namespaceId: "d".repeat(64), targetApplicationId: "app-1" },
    ];
    expect(applicationNamespaces("app-1", unnamed)).toBe("dddddddd…");
  });

  it("is empty when the application is spoken in none", () => {
    expect(applicationNamespaces("app-9", ns)).toBe("");
  });
});
