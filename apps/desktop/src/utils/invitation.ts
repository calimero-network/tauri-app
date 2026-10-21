/**
 * Reading an invitation someone pasted into Join Namespace / Join Context.
 *
 * Apps share invitations as links —
 * `https://links.calimero.network/<package>/join?invitation=<token>` or the
 * `calimero://` form — where the token is the invitation JSON, raw-DEFLATE
 * compressed and base58 encoded (see mero-chat's `encodeInvitationPayload`).
 * The modals only understood base64 JSON, so pasting the link an app gave you
 * failed with “invalid character” / “not valid JSON”.
 *
 * Accepted, in order: a link carrying `invitation=`, raw JSON, a base58 token
 * (compressed, or plain UTF-8 from older apps), and base64/base64url JSON.
 */

const INVITATION_PARAM = 'invitation';
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** The token out of a pasted link, or the input itself when it is not one. */
export function invitationToken(input: string): string {
  const trimmed = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.includes(`${INVITATION_PARAM}=`)) {
    const query = trimmed.includes('?') ? trimmed.slice(trimmed.indexOf('?') + 1) : trimmed;
    const found = new URLSearchParams(query.split('#')[0]).get(INVITATION_PARAM);
    if (found?.trim()) return found.trim();
  }
  return trimmed;
}

export function base58Decode(s: string): Uint8Array {
  const bytes: number[] = []; // little-endian
  for (const ch of s) {
    let carry = BASE58_ALPHABET.indexOf(ch);
    if (carry < 0) throw new Error(`invalid base58 character "${ch}"`);
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Each leading '1' is a leading zero byte.
  for (let i = 0; i < s.length && s[i] === '1'; i++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text.trim());
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Decode a pasted invitation into the JSON object the node expects. Throws a
 * user-facing error when nothing in it reads as an invitation.
 */
export async function decodeInvitation(input: string): Promise<Record<string, unknown>> {
  const token = invitationToken(input);
  if (!token) throw new Error('Paste an invitation link or payload.');

  const asJson = parseJsonObject(token);
  if (asJson) return asJson;

  if (BASE58_RE.test(token)) {
    try {
      const bytes = base58Decode(token);
      let text: string;
      try {
        text = new TextDecoder().decode(await inflateRaw(bytes));
      } catch {
        text = new TextDecoder().decode(bytes); // uncompressed, older apps
      }
      const parsed = parseJsonObject(text);
      if (parsed) return parsed;
    } catch {
      /* not base58 after all — try base64 */
    }
  }

  if (BASE64_RE.test(token)) {
    try {
      const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const bin = atob(padded);
      const text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
      const parsed = parseJsonObject(text);
      if (parsed) return parsed;
    } catch {
      /* fall through */
    }
  }

  throw new Error('This is not a valid invitation. Paste the invite link or payload you were sent.');
}

/** The namespace an invitation admits to, as hex. */
export function invitationNamespaceId(decoded: Record<string, unknown>): string {
  const outer = decoded.invitation as Record<string, unknown> | undefined;
  const inner = (outer?.invitation ?? outer) as Record<string, unknown> | undefined;
  const raw = inner?.group_id ?? inner?.groupId;
  if (Array.isArray(raw)) {
    return (raw as number[]).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  if (typeof raw === 'string' && raw) return raw;
  throw new Error('This invitation does not name a namespace.');
}

/**
 * The body `POST /admin-api/namespaces/{id}/join` takes: the signed `invitation` and an optional
 * `groupName`, nothing else, because the node rejects unknown fields. Apps wrap the invitation in
 * an envelope of their own (mero-tag sends `contextId`, `namespaceId` and `spaceName` alongside
 * it), so only those two are taken from what was decoded. `groupName` is a display-name hint the
 * node uses until the namespace's own metadata syncs, so an app's space name serves for it.
 */
export function namespaceJoinRequest(decoded: Record<string, unknown>): {
  invitation: Record<string, unknown>;
  groupName?: string;
} {
  const invitation = decoded.invitation;
  if (!invitation || typeof invitation !== 'object' || Array.isArray(invitation)) {
    throw new Error('This invitation carries no signed invitation.');
  }
  const name = [decoded.groupName, decoded.spaceName, decoded.name].find(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  );
  const request: { invitation: Record<string, unknown>; groupName?: string } = {
    invitation: invitation as Record<string, unknown>,
  };
  if (name) request.groupName = name.trim();
  return request;
}
