import { describe, it, expect } from 'vitest';

import { base58Decode, decodeInvitation, invitationNamespaceId, invitationToken } from './invitation';

// A real mero-chat namespace invite: invitation JSON, raw-DEFLATE, base58.
const CHAT_TOKEN =
  '3KmTh62qNeCfnnqQq97sQ6fr6BYvtVXjVWTLSrypTeeafcKcHjUkr2KGhTySe1LhUBi9EfWn6mshWuQxnZC3ekniKGPXr5Xnz5UTNyF7P94JodWUe8rUT119epbhDtpEWv2Rd1PNsbbUFnGcmq2MUt26VKZ4JuuxcJHAzpQ9UY8iXbUVL8abNnKPbSFiRL37DfARYgPtkJVW1ADMznSMRry4XYrW8eH58AayrvwPd6wjN8rMZhQCVZuBMJ7BPBX7x3dups8JiuNUU7t7YavpnDKvDkEyd9Pf8ttcSuEyL2FCgufzuthCLSEsvSP3jBLFkGhVNAvYsczfhLQcLvkZzNQzFMB13UF4jkoL6cWCLPQ7T3cyXaHSvNVbD2vrYqE35ZL7fdVveeoGNmbTSP16xi2iQWy8kWbUALtfNaJkmJJE8auGaSrHE7hsvoomKG951A5csNSFnu7C9tSpbHYvuHnfy23qfkAdu2nT5XE4rH3pMLjR7jTNKD4TVHQFRuJ2ffW2Zp1iayH6v3EsAU5WKkcvi1iu5QFfzwcyyCoky6tVswxzWBiYMV3yXKuFYxvMD1UCaZER4pKNMyW88UjCtFCQF1PqPrznDDoeNBWCMYJs3jkbdUDuRghTxPUZyTZWUPpfweRWLyPCpKhwsvZ79D5S6Xvi3K9mXHroYZLMCJysN5ZH1R2bgKa1i1JwuFcPvajpAv5KxGJfqboLRuF1HegR37BpdbqjvxMNyXMvgt6XqvM8AtnJzCXuzCoGPVTU4hderwfocA46XKHV7uSEeP4ZpbcVb4cES6NKiA8hnhNfKf5pyjLEYBvJMNN6nWKTSG7';
const CHAT_NAMESPACE = 'dda0bfa125cdffc453bd5474bdeb45db828f24197c667bf03e88df8d7a86437d';

const PAYLOAD = {
  invitation: {
    invitation: { group_id: [0xab, 0x01], invited_role: 1 },
    inviter_signature: 'sig',
  },
};

function base58Encode(bytes: Uint8Array): string {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = A[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out = '1' + out;
  return out;
}

describe('decodeInvitation', () => {
  it('reads the https link an app shares', async () => {
    const decoded = await decodeInvitation(
      `https://links.calimero.network/com.calimero.chat/join?invitation=${CHAT_TOKEN}`,
    );
    expect(invitationNamespaceId(decoded)).toBe(CHAT_NAMESPACE);
    expect((decoded.invitation as any).inviter_signature).toMatch(/^[0-9a-f]+$/);
  });

  it('reads the calimero:// link and the bare token', async () => {
    const viaScheme = await decodeInvitation(`calimero://com.calimero.chat/join?invitation=${CHAT_TOKEN}`);
    const bare = await decodeInvitation(`  ${CHAT_TOKEN}\n`);
    expect(invitationNamespaceId(viaScheme)).toBe(CHAT_NAMESPACE);
    expect(bare).toEqual(viaScheme);
  });

  it('still reads base64 JSON, uncompressed base58 and raw JSON', async () => {
    const json = JSON.stringify(PAYLOAD);
    expect(await decodeInvitation(btoa(json))).toEqual(PAYLOAD);
    expect(await decodeInvitation(base58Encode(new TextEncoder().encode(json)))).toEqual(PAYLOAD);
    expect(await decodeInvitation(json)).toEqual(PAYLOAD);
  });

  it('says what is wrong with garbage instead of a JSON parse error', async () => {
    await expect(decodeInvitation('https://example.com/nothing')).rejects.toThrow(/not a valid invitation/);
    await expect(decodeInvitation('   ')).rejects.toThrow(/Paste an invitation/);
  });
});

describe('invitationToken', () => {
  it('pulls the token out of a link and leaves a bare token alone', () => {
    expect(invitationToken('https://x/y/join?a=1&invitation=abc#frag')).toBe('abc');
    expect(invitationToken('abc')).toBe('abc');
  });
});

describe('base58Decode', () => {
  it('keeps leading zero bytes', () => {
    expect(Array.from(base58Decode('112'))).toEqual([0, 0, 1]);
  });
});

describe('invitationNamespaceId', () => {
  it('hexes a byte-array group id and passes a string one through', () => {
    expect(invitationNamespaceId(PAYLOAD)).toBe('ab01');
    expect(invitationNamespaceId({ invitation: { invitation: { groupId: 'ff' } } })).toBe('ff');
  });
});
