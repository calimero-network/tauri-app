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
import { getSettings } from '../utils/settings';
import { brokerAccessToken } from './token-broker';

/** The node revoked our token family; no retry can succeed. */
const REVOKED_AUTH_ERRORS = ['token_reuse', 'token_revoked'];

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
 * Mint a `mero-mcp` client key on the current node and write it where the MCP
 * server will find it. Resolves to the credential file's path.
 *
 * `permissions: ['admin']` is deliberate: the key is separate and independently
 * revocable, but not reduced - core cannot scope execute permissions yet, so a
 * narrower key could not drive the node's apps at all.
 */
export async function connectAiAgent(): Promise<string> {
  const nodeUrl = (getSettings().nodeUrl ?? '').replace(/\/$/, '');
  // Rotates only if ours has expired, and through the broker's single flight.
  const accessToken = await brokerAccessToken();

  const response = await fetch(`${nodeUrl}/admin/client-key`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ client_name: 'mero-mcp', permissions: ['admin'] }),
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

  return invoke<string>('write_mcp_agent_credentials', {
    nodeUrl,
    accessToken: key.access_token,
    refreshToken: key.refresh_token,
  });
}
