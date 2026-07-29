import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

vi.mock('../utils/settings', () => ({
  getSettings: () => ({ nodeUrl: 'http://localhost:2528/' }),
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

function installFetch(response: Response): void {
  calls = [];
  // @ts-expect-error - test double, not the full DOM fetch signature
  globalThis.fetch = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(response);
  };
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  originalFetch = globalThis.fetch;
  brokerAccessToken.mockResolvedValue('desktop-access-token');
  invoke.mockResolvedValue('/home/x/.config/calimero/mcp/agent.json');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('connectAiAgent', () => {
  it('mints a mero-mcp client key, then hands it to the Rust writer', async () => {
    installFetch(json({ data: { access_token: 'mcp-at', refresh_token: 'mcp-rt' } }));

    const path = await connectAiAgent();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://localhost:2528/admin/client-key');
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer desktop-access-token',
    );
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      client_name: 'mero-mcp',
      permissions: ['admin'],
    });

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
