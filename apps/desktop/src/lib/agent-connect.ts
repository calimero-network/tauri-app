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
import { parseJwtPayload } from '../utils/jwt';
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
  const sub = parseJwtPayload(accessToken)?.sub;
  return typeof sub === 'string' ? sub : null;
}

/**
 * Revoke the key an earlier connect minted. `root_key_id` comes from the list
 * response, not from our own token: the root key can be re-created, and the node
 * rejects a delete whose root key does not match the one the client is filed under.
 *
 * Resolves false when the node could not confirm the old key is gone, so the
 * caller can warn that it may still be valid - the previous version of this
 * function never checked the DELETE response and reported success regardless.
 */
async function revokeClientKey(
  nodeUrl: string,
  accessToken: string,
  clientId: string,
): Promise<boolean> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const response = await fetch(`${nodeUrl}/admin/keys/clients`, { headers });
  if (!response.ok) return false;

  const json = await response.json().catch(() => null);
  const entries: ClientKeyEntry[] | undefined = json?.data ?? json;
  // A body we cannot read is not evidence the key is gone; only a listing that
  // says so is. Reporting "revoked" off an unreadable body would leave an
  // admin-scoped, never-expiring key valid while the UI claims otherwise.
  if (!Array.isArray(entries)) return false;

  const entry = entries.find((e) => e?.client_id === clientId);
  if (!entry || !entry.is_valid) return true; // already gone

  const deleteResponse = await fetch(`${nodeUrl}/admin/keys/${entry.root_key_id}/clients/${clientId}`, {
    method: 'DELETE',
    headers,
  });
  return deleteResponse.ok;
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
 * A copy-paste prompt for any AI harness to wire itself up, as an alternative
 * to hand-editing the MCP config JSON. Built from live values - the credential
 * path this node actually wrote, and the node's own URL - and never the token,
 * which the server reads from disk rather than from its config.
 */
export function agentSetupPrompt(credentialPath: string, nodeUrl: string): string {
  const hints = MCP_CLIENT_LOCATIONS.map(({ client, location }) => `- ${client}: ${location}`).join('\n');
  return `Set yourself up to use the Calimero MCP server for this node (${nodeUrl}).

1. Add an MCP server entry named "calimero" that runs \`npx -y @calimero-network/mero-mcp\`.
   In Claude Code that is one command:
     claude mcp add -s local calimero -- npx -y @calimero-network/mero-mcp
   Otherwise work out where your own harness keeps its MCP config - common locations:
${hints}
2. No environment variables are needed: the server reads its credential straight
   from ${credentialPath}, already written for this node.
3. Once connected, verify the setup yourself and report back what each returns:
   node_status, then list_applications, then list_contexts.`;
}

/** What a connect did, for the page to report - never includes the token itself. */
export interface ConnectAiAgentResult {
  /** Path the credential file was written to. */
  path: string;
  /** The new credential's client id (JWT `sub`) - an identifier, not a secret. */
  clientId: string | null;
  /** False on a first connect; true when this connect replaced an existing credential. */
  replacedPrevious: boolean;
  /** Set when replacedPrevious and the old key could not be confirmed revoked. */
  revokeFailed: boolean;
}

/** The one in-flight connect; a concurrent call is rejected, not queued behind it. */
let inflight: Promise<ConnectAiAgentResult> | null = null;

/**
 * Wall-clock second the node last minted a key in - not the second a call was
 * attempted in. An attempt that never reached a mint must not tell the user they
 * just connected, and the second core hashes the id from is the one the mint
 * returned in, not the one the call started in.
 */
let lastMintSecond: number | null = null;

function unixSecond(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Mint a client key on the current node and write it where the MCP server will
 * find it, replacing the key an earlier connect left behind.
 *
 * Rejects a concurrent call, or one in the same second as the last mint: core#3337
 * derives an admin-scoped client key's id from only the unix second, so a second
 * mint in the same second collides and silently overwrites the credential this
 * call just wrote.
 */
export async function connectAiAgent(): Promise<ConnectAiAgentResult> {
  if (inflight) {
    throw new Error('An agent connect is already in progress');
  }
  if (lastMintSecond === unixSecond()) {
    throw new Error('Connected less than a second ago - wait a moment and try again');
  }

  inflight = mintAndWriteCredential();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * `permissions: ['admin']` is deliberate: the key is separate and independently
 * revocable, but not reduced - core cannot scope execute permissions yet, so a
 * narrower key could not drive the node's apps at all.
 */
async function mintAndWriteCredential(): Promise<ConnectAiAgentResult> {
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
  // Armed only now: a key exists on the node from this second on, and nothing
  // before this point created one.
  lastMintSecond = unixSecond();
  const clientId = clientIdFromToken(key.access_token);

  // Write before revoking: a failed cleanup must never leave the agent with no
  // usable credential.
  let path: string;
  try {
    path = await invoke<string>('write_mcp_agent_credentials', {
      nodeUrl,
      accessToken: key.access_token,
      refreshToken: key.refresh_token,
    });
  } catch (error) {
    // Nothing records this key now, so no later connect could find it to revoke.
    if (clientId) await revokeClientKey(nodeUrl, accessToken, clientId).catch(() => {});
    throw error;
  }
  saveSettings({ ...getSettings(), mcpAgentClientId: clientId ?? undefined });

  // The guard above keys off our clock; core derives the id from its own, so two
  // mints either side of a second boundary can still land on the same id. Same id
  // means this mint overwrote the previous key instead of adding one - and the
  // revoke below would then delete the credential just written.
  if (clientId && clientId === previousClientId) {
    throw new Error(
      'The node reused the previous agent key instead of creating a new one - wait a moment and try again',
    );
  }

  const replacedPrevious = Boolean(previousClientId && previousClientId !== clientId);
  let revokeFailed = false;

  // Client keys never expire, so without this every connect leaves another
  // admin-scoped key valid on the node forever.
  if (replacedPrevious) {
    try {
      revokeFailed = !(await revokeClientKey(nodeUrl, accessToken, previousClientId as string));
    } catch {
      // The new credential is already in place; a failed cleanup must not fail the connect.
      revokeFailed = true;
    }
  }

  return { path, clientId, replacedPrevious, revokeFailed };
}

/**
 * Toast copy for a finished connect. Kept pure and separate from the page so
 * "the token never reaches this" is a thing a test can assert without rendering.
 */
export function describeConnectOutcome(
  result: ConnectAiAgentResult,
): { message: string; revokeWarning: string | null } {
  if (!result.replacedPrevious) {
    return { message: 'AI agent credential created', revokeWarning: null };
  }
  if (result.revokeFailed) {
    return {
      message: 'AI agent credential replaced',
      revokeWarning: 'Could not revoke the previous key - it may still be valid on the node',
    };
  }
  return { message: 'AI agent credential replaced - previous key revoked', revokeWarning: null };
}
