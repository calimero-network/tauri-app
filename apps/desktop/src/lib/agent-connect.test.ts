import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

let settings: Record<string, unknown>;
vi.mock('../utils/settings', () => ({
  getSettings: () => settings,
  saveSettings: (next: Record<string, unknown>) => {
    settings = next;
  },
}));

const brokerAccessToken = vi.fn();
vi.mock('./token-broker', () => ({
  brokerAccessToken: () => brokerAccessToken(),
}));

import { connectAiAgent, MCP_CONFIG_SNIPPET } from './agent-connect';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: FetchCall[];
let originalFetch: typeof globalThis.fetch;

function installFetch(handler: Response | ((call: FetchCall) => Response)): void {
  calls = [];
  // @ts-expect-error - test double, not the full DOM fetch signature
  globalThis.fetch = (url: string, init?: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return Promise.resolve(typeof handler === 'function' ? handler(call) : handler);
  };
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** A token the node would mint for `clientId`: only the `sub` claim is read. */
function tokenFor(clientId: string): string {
  return `header.${btoa(JSON.stringify({ sub: clientId }))}.signature`;
}

beforeEach(() => {
  vi.clearAllMocks();
  settings = { nodeUrl: 'http://localhost:2528/' };
  originalFetch = globalThis.fetch;
  brokerAccessToken.mockResolvedValue('desktop-access-token');
  invoke.mockResolvedValue('/home/x/.config/calimero/mcp/agent.json');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('connectAiAgent', () => {
  it('mints a client key, then hands it to the Rust writer', async () => {
    installFetch(json({ data: { access_token: 'mcp-at', refresh_token: 'mcp-rt' } }));

    const path = await connectAiAgent();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://localhost:2528/admin/client-key');
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer desktop-access-token',
    );
    // No `client_name`: core's GenerateClientKeyRequest has no such field and
    // silently drops it, so sending one only implies a name the node never stores.
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ permissions: ['admin'] });

    // The minted key goes to disk - never the desktop's own token.
    expect(invoke).toHaveBeenCalledWith('write_mcp_agent_credentials', {
      nodeUrl: 'http://localhost:2528',
      accessToken: 'mcp-at',
      refreshToken: 'mcp-rt',
    });
    expect(path).toBe('/home/x/.config/calimero/mcp/agent.json');
  });

  it('accepts an unwrapped response body', async () => {
    installFetch(json({ access_token: 'mcp-at', refresh_token: 'mcp-rt' }));

    await connectAiAgent();

    expect(invoke).toHaveBeenCalledWith(
      'write_mcp_agent_credentials',
      expect.objectContaining({ accessToken: 'mcp-at' }),
    );
  });

  it('reports a revoked family as terminal and writes nothing', async () => {
    installFetch(
      new Response('{}', { status: 401, headers: { 'x-auth-error': 'token_reuse' } }),
    );

    await expect(connectAiAgent()).rejects.toThrow(/revoked/i);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('surfaces the node error message and writes nothing', async () => {
    installFetch(json({ error: { message: 'permission denied' } }, { status: 403 }));

    await expect(connectAiAgent()).rejects.toThrow('permission denied');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('writes nothing when the node returns no credential', async () => {
    installFetch(json({ data: { access_token: 'mcp-at' } }));

    await expect(connectAiAgent()).rejects.toThrow(/no credential/i);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('remembers the minted key by the sub of its own token', async () => {
    installFetch(json({ data: { access_token: tokenFor('client-1'), refresh_token: 'mcp-rt' } }));

    await connectAiAgent();

    expect(settings.mcpAgentClientId).toBe('client-1');
  });

  it('revokes the key a previous connect left behind', async () => {
    settings.mcpAgentClientId = 'client-0';
    installFetch(({ url, init }) => {
      if (url.endsWith('/admin/client-key')) {
        return json({ data: { access_token: tokenFor('client-1'), refresh_token: 'mcp-rt' } });
      }
      if (url.endsWith('/admin/keys/clients')) {
        return json({
          data: [
            { client_id: 'client-0', root_key_id: 'root-a', is_valid: true },
            { client_id: 'client-1', root_key_id: 'root-b', is_valid: true },
          ],
        });
      }
      expect(init?.method).toBe('DELETE');
      return json({ data: null });
    });

    await connectAiAgent();

    // The root key is taken from the listing, not from our own token: it can be
    // re-created, and the node rejects a delete naming the wrong one.
    expect(calls.map((c) => c.url)).toEqual([
      'http://localhost:2528/admin/client-key',
      'http://localhost:2528/admin/keys/clients',
      'http://localhost:2528/admin/keys/root-a/clients/client-0',
    ]);
    expect(settings.mcpAgentClientId).toBe('client-1');
  });

  it('writes the credential before revoking anything', async () => {
    settings.mcpAgentClientId = 'client-0';
    const order: string[] = [];
    invoke.mockImplementation(() => {
      order.push('write');
      return Promise.resolve('/home/x/.config/calimero/mcp/agent.json');
    });
    installFetch(({ url }) => {
      if (url.endsWith('/admin/client-key')) {
        return json({ data: { access_token: tokenFor('client-1'), refresh_token: 'mcp-rt' } });
      }
      order.push('revoke');
      return json({ data: [{ client_id: 'client-0', root_key_id: 'root-a', is_valid: true }] });
    });

    await connectAiAgent();

    expect(order[0]).toBe('write');
  });

  it('does not fail the connect when the cleanup does', async () => {
    settings.mcpAgentClientId = 'client-0';
    installFetch(({ url }) => {
      if (url.endsWith('/admin/client-key')) {
        return json({ data: { access_token: tokenFor('client-1'), refresh_token: 'mcp-rt' } });
      }
      throw new Error('node unreachable');
    });

    await expect(connectAiAgent()).resolves.toBe('/home/x/.config/calimero/mcp/agent.json');
    expect(settings.mcpAgentClientId).toBe('client-1');
  });

  it('deletes nothing when the previous key is already revoked', async () => {
    settings.mcpAgentClientId = 'client-0';
    installFetch(({ url }) => {
      if (url.endsWith('/admin/client-key')) {
        return json({ data: { access_token: tokenFor('client-1'), refresh_token: 'mcp-rt' } });
      }
      return json({ data: [{ client_id: 'client-0', root_key_id: 'root-a', is_valid: false }] });
    });

    await connectAiAgent();

    expect(calls).toHaveLength(2);
  });

  it('mints nothing for a node that is not on this machine', async () => {
    settings.nodeUrl = 'https://node.example.com';
    installFetch(json({ data: { access_token: 'mcp-at', refresh_token: 'mcp-rt' } }));

    await expect(connectAiAgent()).rejects.toThrow('https://node.example.com');
    expect(calls).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('accepts every loopback spelling the MCP server accepts', async () => {
    for (const nodeUrl of ['http://localhost:2528', 'http://127.0.0.1:2528', 'http://[::1]:2528']) {
      settings = { nodeUrl };
      installFetch(json({ data: { access_token: 'mcp-at', refresh_token: 'mcp-rt' } }));
      await expect(connectAiAgent()).resolves.toBeTruthy();
    }
  });
});

describe('MCP_CONFIG_SNIPPET', () => {
  it('is harness-generic: an mcpServers entry, no client-specific command', () => {
    expect(JSON.parse(MCP_CONFIG_SNIPPET)).toEqual({
      mcpServers: {
        calimero: { command: 'npx', args: ['-y', '@calimero-network/mero-mcp'] },
      },
    });
  });
});
