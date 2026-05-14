import { describe, it, expect } from "vitest";
import { parseJwtPayload, isMdmaSessionToken, isTokenExpired } from "./jwt";

function base64url(s: string): string {
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// UTF-8-aware base64url for payloads containing non-ASCII characters.
// `btoa` only accepts Latin-1, so we have to encode to bytes first.
function utf8Base64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function makeJwt(payload: object): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = utf8Base64url(JSON.stringify(payload));
  return `${header}.${body}.signature`;
}

describe("parseJwtPayload", () => {
  it("returns null for null, undefined, empty, or non-string input", () => {
    expect(parseJwtPayload(null)).toBeNull();
    expect(parseJwtPayload(undefined)).toBeNull();
    expect(parseJwtPayload("")).toBeNull();
    expect(parseJwtPayload(123 as unknown as string)).toBeNull();
  });

  it("returns null when the JWT does not have three segments", () => {
    expect(parseJwtPayload("no-dots")).toBeNull();
    expect(parseJwtPayload("a.b")).toBeNull();
    expect(parseJwtPayload("a.b.c.d")).toBeNull();
  });

  it("returns null when the payload segment is not valid base64", () => {
    expect(parseJwtPayload("header.@@@.signature")).toBeNull();
  });

  it("returns null when the decoded JSON is the literal null", () => {
    const nullPayload = `header.${base64url("null")}.sig`;
    expect(parseJwtPayload(nullPayload)).toBeNull();
  });

  it("returns null when the decoded JSON is an array (not a claim set)", () => {
    const arrayPayload = `header.${base64url(JSON.stringify(["a", "b"]))}.sig`;
    expect(parseJwtPayload(arrayPayload)).toBeNull();
  });

  it("decodes non-ASCII claim values via TextDecoder (UTF-8 round-trip)", () => {
    // Realistic Google ID token shape: 'name' often contains accented or
    // non-Latin chars. atob alone misdecodes these as garbled Latin-1.
    const payload = { iss: "mdma", name: "Xabi Losada — éñü 日本語" };
    const jwt = makeJwt(payload);
    expect(parseJwtPayload(jwt)).toEqual(payload);
  });

  it("decodes a standard MDMA session token correctly", () => {
    const jwt = makeJwt({ iss: "mdma", sub: "user-1", exp: 9999999999 });
    expect(parseJwtPayload(jwt)).toEqual({
      iss: "mdma",
      sub: "user-1",
      exp: 9999999999,
    });
  });

  it("handles URL-safe base64 (- and _) in the payload — Google ID token shape", () => {
    const payload = { iss: "https://accounts.google.com", note: "???" };
    const jwt = makeJwt(payload);
    expect(jwt).toMatch(/[-_]/);
    expect(parseJwtPayload(jwt)).toEqual(payload);
  });

  it("handles different unpadded base64 lengths (padding restoration)", () => {
    expect(parseJwtPayload(makeJwt({}))).toEqual({});
    expect(parseJwtPayload(makeJwt({ a: 1 }))).toEqual({ a: 1 });
    expect(parseJwtPayload(makeJwt({ ab: 12 }))).toEqual({ ab: 12 });
  });
});

describe("isMdmaSessionToken", () => {
  it("returns true when iss is 'mdma'", () => {
    expect(isMdmaSessionToken(makeJwt({ iss: "mdma" }))).toBe(true);
  });

  it("returns false for Google ID tokens (iss !== 'mdma')", () => {
    expect(isMdmaSessionToken(makeJwt({ iss: "https://accounts.google.com" }))).toBe(false);
  });

  it("returns false when iss is missing", () => {
    expect(isMdmaSessionToken(makeJwt({ sub: "user" }))).toBe(false);
  });

  it("returns false for null or malformed input", () => {
    expect(isMdmaSessionToken(null)).toBe(false);
    expect(isMdmaSessionToken("garbage")).toBe(false);
    expect(isMdmaSessionToken("")).toBe(false);
  });
});

describe("isTokenExpired", () => {
  it("treats missing exp as expired", () => {
    expect(isTokenExpired(makeJwt({ iss: "mdma" }))).toBe(true);
  });

  it("treats non-numeric exp as expired", () => {
    expect(isTokenExpired(makeJwt({ exp: "never" }))).toBe(true);
  });

  it("returns true when exp is in the past", () => {
    const yesterday = Math.floor(Date.now() / 1000) - 86400;
    expect(isTokenExpired(makeJwt({ exp: yesterday }))).toBe(true);
  });

  it("returns false when exp is in the future", () => {
    const tomorrow = Math.floor(Date.now() / 1000) + 86400;
    expect(isTokenExpired(makeJwt({ exp: tomorrow }))).toBe(false);
  });

  it("treats null or malformed input as expired", () => {
    expect(isTokenExpired(null)).toBe(true);
    expect(isTokenExpired("garbage")).toBe(true);
  });
});
