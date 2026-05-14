/**
 * Shared JWT payload decoding helpers. Used by the cloud auth flow
 * (Google ID tokens and MDMA session tokens are both JWTs) and by the
 * cloud API client (validates rolling-refresh header values before
 * persisting them). Factored out so neither caller has to re-inline
 * the base64url-decode-then-parse preamble — a bug in one copy is the
 * kind of thing that stays uncaught for a while.
 *
 * No signature verification anywhere — the manager backend is the
 * source of truth. These helpers only read claims.
 */

/** Decode the payload segment of a JWT. Returns `null` on any
 * malformed input so callers can default without a try/catch. */
export function parseJwtPayload(token: string | undefined | null): Record<string, unknown> | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    // atob returns a binary string (one char per byte). The payload is
    // UTF-8, so non-ASCII claims (e.g., a `name` with é/ü/CJK) would
    // misdecode if we JSON.parse(atob(...)) directly — each multi-byte
    // sequence ends up as garbled characters. Round through Uint8Array
    // + TextDecoder so the JSON parser sees real UTF-8.
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const decoded = JSON.parse(new TextDecoder().decode(bytes));
    // Reject anything that isn't a JSON object — JWT payloads are
    // RFC-defined as a JSON object. Arrays pass `typeof === 'object'`
    // but aren't a sensible claim set; null is caught by the truthy
    // guard. Reject both so callers can rely on `Record<string, unknown>`.
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      return null;
    }
    return decoded as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * `true` if the token was issued by MDMA (iss claim = "mdma"). MDMA
 * sessions have 7-day TTL with rolling refresh; raw Google tokens
 * expire after ~1 hour.
 */
export function isMdmaSessionToken(token: string | undefined | null): boolean {
  const payload = parseJwtPayload(token);
  return payload?.iss === 'mdma';
}

/**
 * Check if a JWT (Google ID token or MDMA session) has expired. Both
 * carry an `exp` claim in seconds since the epoch. Missing/invalid
 * `exp` is treated as expired rather than trusted — callers almost
 * always want to route to the re-auth path on ambiguity.
 */
export function isTokenExpired(token: string | undefined | null): boolean {
  const payload = parseJwtPayload(token);
  if (!payload) return true;
  const exp = payload.exp;
  if (typeof exp !== 'number') return true;
  return Date.now() >= exp * 1000;
}
