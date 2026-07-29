/**
 * Provision a coding agent's MCP server with its own node credential.
 *
 * The MCP server (`@calimero-network/mero-mcp`) runs as a subprocess of the
 * agent and talks to the node over HTTP, so with `--auth-mode embedded` it needs
 * a bearer token. We mint it a SEPARATE client key rather than sharing ours:
 * refresh tokens are single-use with rotation and replay revokes the whole
 * family, so two processes on one lineage would eventually log the desktop out
 * of its own session (see lib/token-broker.ts).
 */
import { invoke } from '@tauri-apps/api/core';
import { getSettings, saveSettings } from '../utils/settings';
import { brokerAccessToken } from './token-broker';

/** The node revoked our token family; no retry can succeed. */
const REVOKED_AUTH_ERRORS = ['token_reuse', 'token_revoked'];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * The origin to name in a rejection, or null for a loopback node. MUST match
 * `nonLoopbackOrigin` in mero-mcp's src/config.ts: the MCP server drops a handoff
 * naming any other origin, so minting one here would be silently useless.
 */
function nonLoopbackOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'an unparseable url';
  }
  const scheme = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  if (scheme && LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  return parsed.origin === 'null' ? parsed.protocol : parsed.origin;
}

/** A client key as `GET /admin/keys/clients` reports it. */
interface ClientKeyEntry {
  client_id: string;
  root_key_id: string;
  is_valid: boolean;
}

/** Client keys are keyed by the `sub` of the tokens they mint. */
function clientIdFromToken(accessToken: string): string | null {
  try {
    const sub = JSON.parse(atob(accessToken.split('.')[1])).sub;
    return typeof sub === 'string' ? sub : null;
  } catch {
    return null;
  }
}

/**
 * Revoke the key an earlier connect minted. `root_key_id` comes from the list
 * response, not from our own token: the root key can be re-created, and the node
 * rejects a delete whose root key does not match the one the client is filed under.
 */
async function revokeClientKey(
  nodeUrl: string,
  accessToken: string,
  clientId: string,
): Promise<void> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const response = await fetch(`${nodeUrl}/admin/keys/clients`, { headers });
  if (!response.ok) return;

  const json = await response.json().catch(() => null);
  const entries: ClientKeyEntry[] = json?.data ?? json;
  const entry = Array.isArray(entries) ? entries.find((e) => e?.client_id === clientId) : undefined;
  if (!entry?.is_valid) return;

  await fetch(`${nodeUrl}/admin/keys/${entry.root_key_id}/clients/${clientId}`, {
    method: 'DELETE',
    headers,
  });
}

/**
 * Harness-generic MCP server entry. Every client below takes these same fields;
 * only the file it lives in (and, for Codex, the syntax) differs.
 */
export const MCP_CONFIG_SNIPPET = JSON.stringify(
  { mcpServers: { calimero: { command: 'npx', args: ['-y', '@calimero-network/mero-mcp'] } } },
  null,
  2,
);

/** Where each supported client expects the block above. */
export const MCP_CLIENT_LOCATIONS: { client: string; location: string }[] = [
  { client: 'Claude Code', location: '.mcp.json (project) or ~/.claude.json (global)' },
  { client: 'Claude Desktop', location: 'claude_desktop_config.json' },
  { client: 'Cursor / Windsurf', location: '.cursor/mcp.json' },
  { client: 'Codex CLI', location: '~/.codex/config.toml (same fields, TOML syntax)' },
];

/**
 * Mint a client key on the current node and write it where the MCP server will
 * find it, replacing the key an earlier connect left behind. Resolves to the
 * credential file's path.
 *
 * `permissions: ['admin']` is deliberate: the key is separate and independently
 * revocable, but not reduced - core cannot scope execute permissions yet, so a
 * narrower key could not drive the node's apps at all.
 */
export async function connectAiAgent(): Promise<string> {
  const settings = getSettings();
  const nodeUrl = (settings.nodeUrl ?? '').replace(/\/$/, '');
  const remoteOrigin = nonLoopbackOrigin(nodeUrl);
  if (remoteOrigin) {
    throw new Error(
      `The agent only accepts a credential for a node on this machine, and this node is ${remoteOrigin}. Point the app at a local node, then connect.`,
    );
  }

  const previousClientId = settings.mcpAgentClientId;
  // Rotates only if ours has expired, and through the broker's single flight.
  const accessToken = await brokerAccessToken();

  const response = await fetch(`${nodeUrl}/admin/client-key`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ permissions: ['admin'] }),
  });

  const json = await response.json().catch(() => null);

  if (!response.ok) {
    const authError = response.headers.get('x-auth-error');
    if (authError && REVOKED_AUTH_ERRORS.includes(authError)) {
      throw new Error('Your node session was revoked. Sign in again, then reconnect the agent.');
    }
    const message =
      json?.error?.message ?? json?.error ?? json?.message ?? `HTTP ${response.status}`;
    throw new Error(String(message));
  }

  const key = json?.data ?? json;
  if (!key?.access_token || !key?.refresh_token) {
    throw new Error('Node returned no credential for the agent');
  }
  const clientId = clientIdFromToken(key.access_token);

  // Write before revoking: a failed cleanup must never leave the agent with no
  // usable credential.
  const path = await invoke<string>('write_mcp_agent_credentials', {
    nodeUrl,
    accessToken: key.access_token,
    refreshToken: key.refresh_token,
  });
  saveSettings({ ...getSettings(), mcpAgentClientId: clientId ?? undefined });

  // Client keys never expire, so without this every connect leaves another
  // admin-scoped key valid on the node forever.
  if (previousClientId && previousClientId !== clientId) {
    try {
      await revokeClientKey(nodeUrl, accessToken, previousClientId);
    } catch {
      // The new credential is already in place; a stale key is not worth failing on.
    }
  }

  return path;
}
