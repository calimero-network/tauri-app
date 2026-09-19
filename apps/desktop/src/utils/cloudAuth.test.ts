import { describe, it, expect } from 'vitest';

/**
 * The credential the cloud hands back over the `calimero://cloud-callback`
 * deep link is not always a Google ID token.
 *
 * When the browser already has a signed-in cloud session, the cloud sends THAT
 * — an MDMA session JWT — because re-running Google sign-in for someone who is
 * already signed in is a round trip for nothing. Before this was recognised
 * here, the cloud suppressed the hand-off rather than send one, and the desktop
 * sat on "Waiting for sign-in..." forever while the browser showed the
 * dashboard.
 *
 * Two facts drive the sign-in path and are pinned here: a session token must be
 * distinguishable from a Google one (or it gets posted to `/api/auth/google`,
 * which is not a valid exchange), and it carries `email` but NOT `name` or
 * `picture` — which is why the settings write keeps an existing profile instead
 * of overwriting it with the empty strings this yields.
 */

// settings.ts touches localStorage on import; keep it inert.
import { vi } from 'vitest';
vi.mock('./settings', () => ({ getSettings: () => ({}), saveSettings: () => {} }));

import { decodeIdToken, isMdmaSessionToken } from './cloudAuth';

function makeJwt(payload: object): string {
  const b64 = (s: string) => btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64(JSON.stringify({ alg: 'none' }))}.${b64(JSON.stringify(payload))}.sig`;
}

const exp = Math.floor(Date.now() / 1000) + 3600;
const SESSION = makeJwt({ iss: 'mdma', sub: 'user-1', email: 'sandi@calimero.network', exp });
const GOOGLE = makeJwt({
  iss: 'https://accounts.google.com',
  email: 'sandi@calimero.network',
  name: 'Sandi Fatic',
  picture: 'https://example.test/a.png',
  exp,
});

describe('the credential the cloud sends back', () => {
  it('distinguishes an MDMA session token from a Google one', () => {
    expect(isMdmaSessionToken(SESSION)).toBe(true);
    expect(isMdmaSessionToken(GOOGLE)).toBe(false);
  });

  it('reads the email from a session token, which is the claim it does carry', () => {
    expect(decodeIdToken(SESSION)?.email).toBe('sandi@calimero.network');
  });

  it('yields empty name and picture for a session token, the claims it does not carry', () => {
    const info = decodeIdToken(SESSION);
    expect(info?.name).toBe('');
    expect(info?.picture).toBe('');
  });

  it('still reads a full profile from a Google token', () => {
    const info = decodeIdToken(GOOGLE);
    expect(info?.name).toBe('Sandi Fatic');
    expect(info?.picture).toBe('https://example.test/a.png');
  });
});
