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

// A real MeroJs behind the app's singleton, so these tests still assert what
// reaches the wire: the SDK's own routes, bodies and bearer header.
vi.mock('./mero-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mero-client')>();
  const { MeroJs, MemoryTokenStore } = await import('@calimero-network/mero-js');
  const meroJs = new MeroJs({
    baseUrl: 'http://localhost:2528',
    tokenStore: new MemoryTokenStore(),
  });
  meroJs.setTokenData({
    access_token: 'desktop-access-token',
    refresh_token: 'desktop-refresh-token',
    expires_at: Date.now() + 3_600_000,
  });
  // Only the singleton is stood in for; the error-message helpers are the real
  // ones, since the copy they produce is what these tests assert.
  return { ...actual, apiClient: { meroJs } };
});

// Imported fresh for every test: the module keeps the in-flight connect and the
// last-attempt second in module scope, and a test must never inherit either.
type AgentConnect = typeof import('./agent-connect');
let agentConnect: AgentConnect;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: FetchCall[];
let originalFetch: typeof globalThis.fetch;

function installFetch(handler: Response | ((call: FetchCall) => Response | Promise<Response>)): void {
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

beforeEach(async () => {
  vi.clearAllMocks();
  settings = { nodeUrl: 'http://localhost:2528/' };
  originalFetch = globalThis.fetch;
  invoke.mockResolvedValue('/home/x/.config/calimero/mcp/agent.json');

  vi.resetModules();
  agentConnect = await import('./agent-connect');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe('connectAiAgent', () => {
  it('mints a client key, then hands it to the Rust writer', async () => {
    const accessToken = tokenFor('client-1');
    installFetch(json({ data: { access_token: accessToken, refresh_token: 'mcp-rt' } }));

    const result = await agentConnect.connectAiAgent();

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
      accessToken,
      refreshToken: 'mcp-rt',
    });
    expect(result.path).toBe('/home/x/.config/calimero/mcp/agent.json');
  });

  it('reports a first connect as a creation, not a replacement', async () => {
    installFetch(json({ data: { access_token: tokenFor('client-1'), refresh_token: 'mcp-rt' } }));

    const result = await agentConnect.connectAiAgent();

    expect(result.replacedPrevious).toBe(false);
    expect(result.revokeFailed).toBe(false);
    expect(result.clientId).toBe('client-1');
    expect(agentConnect.describeConnectOutcome(result)).toEqual({
      message: 'AI agent credential created',
      revokeWarning: null,
    });
  });

  it('reports a repeat connect as a replacement once the previous key is revoked', async () => {
    settings.mcpAgentClientId = 'client-0';
    installFetch(({ url }) => {
      if (url.endsWith('/admin/client-key')) {
        return json({ data: { access_token: tokenFor('client-1'), refresh_token: 'mcp-rt' } });
      }
      if (url.endsWith('/admin/keys/clients')) {
        return json({ data: [{ client_id: 'client-0', root_key_id: 'root-a', is_valid: true }] });
      }
      return json({ data: null }); // DELETE succeeds
    });

    const result = await agentConnect.connectAiAgent();

    expect(result.replacedPrevious).toBe(true);
    expect(result.revokeFailed).toBe(false);
    expect(agentConnect.describeConnectOutcome(result)).toEqual({
      message: 'AI agent credential replaced - previous key revoked',
      revokeWarning: null,
    });
  });

  it('still reports success but surfaces a warning when the revoke fails', async () => {
    settings.mcpAgentClientId = 'client-0';
    installFetch(({ url }) => {
      if (url.endsWith('/admin/client-key')) {
        return json({ data: { access_token: tokenFor('client-1'), refresh_token: 'mcp-rt' } });
      }
      if (url.endsWith('/admin/keys/clients')) {
        return json({ data: [{ client_id: 'client-0', root_key_id: 'root-a', is_valid: true }] });
      }
      return new Response('{}', { status: 500 }); // DELETE fails
    });

    const result = await agentConnect.connectAiAgent();

    expect(result.path).toBe('/home/x/.config/calimero/mcp/agent.json');
    expect(result.replacedPrevious).toBe(true);
    expect(result.revokeFailed).toBe(true);
    expect(agentConnect.describeConnectOutcome(result)).toEqual({
      message: 'AI agent credential replaced',
      revokeWarning: 'Could not revoke the previous key - it may still be valid on the node',
    });
  });

  it('never surfaces a token, only the copy and the client id, even when the revoke fails', async () => {
    settings.mcpAgentClientId = 'client-0';
    const secretAccessToken = tokenFor('client-1');
    installFetch(({ url }) => {
      if (url.endsWith('/admin/client-key')) {
        return json({ data: { access_token: secretAccessToken, refresh_token: 'super-secret-refresh' } });
      }
      if (url.endsWith('/admin/keys/clients')) {
        return json({ data: [{ client_id: 'client-0', root_key_id: 'root-a', is_valid: true }] });
      }
      return new Response('{}', { status: 500 });
    });

    const result = await agentConnect.connectAiAgent();
    const outcome = agentConnect.describeConnectOutcome(result);
    const prompt = agentConnect.agentSetupPrompt(result.path, 'http://localhost:2528');

    const rendered = JSON.stringify({ result, outcome }) + prompt;
    expect(rendered).not.toContain(secretAccessToken);
    expect(rendered).not.toContain('super-secret-refresh');
  });

  it('reports a revoked family as terminal and writes nothing', async () => {
    installFetch(
      new Response('{}', { status: 401, headers: { 'x-auth-error': 'token_reuse' } }),
    );

    await expect(agentConnect.connectAiAgent()).rejects.toThrow(
      'Your node session was revoked. Sign in again, then reconnect the agent.',
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('surfaces the node error message and writes nothing', async () => {
    installFetch(json({ error: { message: 'permission denied' } }, { status: 403 }));

    // Exact: a substring match passes against the SDK's `HTTP 403 : permission
    // denied`, which is the copy this must not regress to.
    await expect(agentConnect.connectAiAgent()).rejects.toThrow(
      new Error('permission denied'),
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('writes nothing when the node returns no credential', async () => {
    installFetch(json({ data: { access_token: 'mcp-at' } }));

    await expect(agentConnect.connectAiAgent()).rejects.toThrow(/no credential/i);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('remembers the minted key by the sub of its own token', async () => {
    installFetch(json({ data: { access_token: tokenFor('client-1'), refresh_token: 'mcp-rt' } }));

    await agentConnect.connectAiAgent();

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

    await agentConnect.connectAiAgent();

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

    await agentConnect.connectAiAgent();

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

    const result = await agentConnect.connectAiAgent();
    expect(result.path).toBe('/home/x/.config/calimero/mcp/agent.json');
    expect(result.revokeFailed).toBe(true);
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

    await agentConnect.connectAiAgent();

    expect(calls).toHaveLength(2);
  });

  it('treats a previous key missing from the listing as already gone', async () => {
    settings.mcpAgentClientId = 'client-0';
    installFetch(({ url }) => {
      if (url.endsWith('/admin/client-key')) {
        return json({ data: { access_token: tokenFor('client-1'), refresh_token: 'mcp-rt' } });
      }
      return json({ data: [{ client_id: 'client-9', root_key_id: 'root-z', is_valid: true }] });
    });

    const result = await agentConnect.connectAiAgent();

    expect(result.revokeFailed).toBe(false);
    expect(calls).toHaveLength(2); // no DELETE
  });

  it('reports the revoke as failed when the listing body cannot be read', async () => {
    settings.mcpAgentClientId = 'client-0';
    installFetch(({ url }) => {
      if (url.endsWith('/admin/client-key')) {
        return json({ data: { access_token: tokenFor('client-1'), refresh_token: 'mcp-rt' } });
      }
      // A 200 whose body is not the listing: nothing here says the old key is gone.
      return new Response('not json', { status: 200 });
    });

    const result = await agentConnect.connectAiAgent();

    expect(result.replacedPrevious).toBe(true);
    expect(result.revokeFailed).toBe(true);
    expect(calls).toHaveLength(2); // no DELETE attempted either
    expect(agentConnect.describeConnectOutcome(result).revokeWarning).toMatch(/may still be valid/);
  });

  it('revokes the key it just minted when the write fails', async () => {
    invoke.mockRejectedValue(new Error('disk full'));
    installFetch(({ url }) => {
      if (url.endsWith('/admin/client-key')) {
        return json({ data: { access_token: tokenFor('client-1'), refresh_token: 'mcp-rt' } });
      }
      return json({ data: [{ client_id: 'client-1', root_key_id: 'root-b', is_valid: true }] });
    });

    await expect(agentConnect.connectAiAgent()).rejects.toThrow('disk full');

    // Nothing persisted the id, so this is the last chance to revoke it.
    expect(calls.map((c) => c.url)).toEqual([
      'http://localhost:2528/admin/client-key',
      'http://localhost:2528/admin/keys/clients',
      'http://localhost:2528/admin/keys/root-b/clients/client-1',
    ]);
    expect(settings.mcpAgentClientId).toBeUndefined();
  });

  it('remembers the path and the node the credential was minted for', async () => {
    installFetch(json({ data: { access_token: tokenFor('client-1'), refresh_token: 'mcp-rt' } }));

    const result = await agentConnect.connectAiAgent();

    // What the agent tab restores on a later visit, so seeing the setup prompt
    // again does not mean minting another admin key.
    expect(result.nodeUrl).toBe('http://localhost:2528');
    expect(settings.mcpAgentCredentialPath).toBe('/home/x/.config/calimero/mcp/agent.json');
    expect(settings.mcpAgentNodeUrl).toBe('http://localhost:2528');
  });

  it('rejects a minted token with no derivable client id, writing and persisting nothing', async () => {
    // A token with no `sub` claim: the id the delete endpoint needs cannot be
    // recovered, so the key must not be written or tracked as revocable.
    const noSubToken = `header.${btoa(JSON.stringify({}))}.signature`;
    installFetch(json({ data: { access_token: noSubToken, refresh_token: 'mcp-rt' } }));

    await expect(agentConnect.connectAiAgent()).rejects.toThrow(/client id/i);

    expect(invoke).not.toHaveBeenCalled();
    expect(settings.mcpAgentClientId).toBeUndefined();
  });

  it('mints nothing for a node that is not on this machine', async () => {
    settings.nodeUrl = 'https://node.example.com';
    installFetch(json({ data: { access_token: 'mcp-at', refresh_token: 'mcp-rt' } }));

    await expect(agentConnect.connectAiAgent()).rejects.toThrow('https://node.example.com');
    expect(calls).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('accepts every loopback spelling the MCP server accepts', async () => {
    vi.useFakeTimers();
    let clock = new Date('2026-01-01T00:00:00.000Z');
    for (const nodeUrl of ['http://localhost:2528', 'http://127.0.0.1:2528', 'http://[::1]:2528']) {
      settings = { nodeUrl };
      installFetch(() => json({ data: { access_token: tokenFor('client-1'), refresh_token: 'mcp-rt' } }));
      vi.setSystemTime(clock);
      await expect(agentConnect.connectAiAgent()).resolves.toBeTruthy();
      clock = new Date(clock.getTime() + 1100); // clear the same-second guard
    }
  });
});

describe('connectAiAgent same-second guard', () => {
  // A client key's id hashes only the unix second, so two mints in the same second collide.

  it('rejects a second connect started while one is still in flight, without minting again', async () => {
    let resolveMint!: (r: Response) => void;
    installFetch(() => new Promise<Response>((resolve) => { resolveMint = resolve; }));

    const first = agentConnect.connectAiAgent();
    await expect(agentConnect.connectAiAgent()).rejects.toThrow(/already in progress/i);

    resolveMint(json({ data: { access_token: tokenFor('client-1'), refresh_token: 'mcp-rt' } }));
    await first;

    expect(calls).toHaveLength(1);
  });

  it('rejects a connect attempted within the same second as a completed one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    installFetch(() => json({ data: { access_token: tokenFor('client-1'), refresh_token: 'mcp-rt' } }));

    await agentConnect.connectAiAgent();
    expect(calls).toHaveLength(1);

    vi.setSystemTime(new Date('2026-01-01T00:00:00.900Z'));
    await expect(agentConnect.connectAiAgent()).rejects.toThrow(/wait/i);
    expect(calls).toHaveLength(1); // no second mint
  });

  it('proceeds normally once the guard window has elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    // A distinct id per mint, as a node a second later would derive.
    let minted = 0;
    installFetch(({ url }) => {
      if (url.endsWith('/admin/client-key')) {
        minted += 1;
        return json({ data: { access_token: tokenFor(`client-${minted}`), refresh_token: 'mcp-rt' } });
      }
      return json({ data: [{ client_id: 'client-1', root_key_id: 'root-a', is_valid: true }] });
    });

    await agentConnect.connectAiAgent();
    vi.setSystemTime(new Date('2026-01-01T00:00:01.100Z'));
    await agentConnect.connectAiAgent();

    expect(minted).toBe(2);
  });

  it('lets a retry through in the same second when nothing was minted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    let attempt = 0;
    installFetch(() => {
      attempt += 1;
      return attempt === 1
        ? new Response('{}', { status: 503 })
        : json({ data: { access_token: tokenFor('client-1'), refresh_token: 'mcp-rt' } });
    });

    // A node that was down is not "connected less than a second ago".
    await expect(agentConnect.connectAiAgent()).rejects.toThrow(/503/);
    vi.setSystemTime(new Date('2026-01-01T00:00:00.400Z'));
    await expect(agentConnect.connectAiAgent()).resolves.toBeTruthy();
  });

  it('writes the fresh tokens and revokes nothing when the node hands back the previous key id', async () => {
    settings.mcpAgentClientId = 'client-0';
    installFetch(() => json({ data: { access_token: tokenFor('client-0'), refresh_token: 'mcp-rt' } }));

    // The mint replaced client-0 in place, so revoking it would delete the key
    // these very tokens authenticate as.
    const result = await agentConnect.connectAiAgent();

    expect(result.replacedPrevious).toBe(false);
    expect(invoke).toHaveBeenCalledWith(
      'write_mcp_agent_credentials',
      expect.objectContaining({ refreshToken: 'mcp-rt' }),
    );
    expect(calls).toHaveLength(1); // mint only: no listing, no DELETE
    expect(settings.mcpAgentClientId).toBe('client-0');
  });
});

describe('agentSetupPrompt', () => {
  it('is generated from the live credential path and node URL, names the verification tools, and carries no token', () => {
    const prompt = agentConnect.agentSetupPrompt('/home/x/.config/calimero/mcp/agent.json', 'http://localhost:2528');

    expect(prompt).toContain('/home/x/.config/calimero/mcp/agent.json');
    expect(prompt).toContain('http://localhost:2528');
    expect(prompt).toContain('node_status');
    expect(prompt).toContain('list_applications');
    expect(prompt).toContain('list_contexts');
    expect(prompt).toMatch(/no environment variables/i);
    // Setup only verifies; provisioning a context is the user's call, and
    // select_app already says so at the point it matters.
    expect(prompt).not.toMatch(/create a context/i);
  });
});

describe('MCP_CONFIG_SNIPPET', () => {
  it('is harness-generic: an mcpServers entry, no client-specific command', () => {
    expect(JSON.parse(agentConnect.MCP_CONFIG_SNIPPET)).toEqual({
      mcpServers: {
        calimero: { command: 'npx', args: ['-y', '@calimero-network/mero-mcp'] },
      },
    });
  });
});
