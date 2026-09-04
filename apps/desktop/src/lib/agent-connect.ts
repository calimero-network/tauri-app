/**
 * Provision a coding agent's MCP server with its own node credential - a separate
 * client key, since sharing ours risks rotating away the desktop's own session (see token-broker.ts).
 */
import { invoke } from '@tauri-apps/api/core';
import { AuthRevokedError, type ClientKey } from '@calimero-network/mero-js';
import { getSettings, saveSettings } from '../utils/settings';
import { parseJwtPayload } from '../utils/jwt';
import { apiClient } from './mero-client';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * The origin to name in a rejection, or null for a loopback node. Must match
 * `nonLoopbackOrigin` in mero-mcp's src/config.ts, or the MCP server silently drops the handoff.
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

/** Client keys are keyed by the `sub` of the tokens they mint. */
function clientIdFromToken(accessToken: string): string | null {
  const sub = parseJwtPayload(accessToken)?.sub;
  return typeof sub === 'string' ? sub : null;
}

/**
 * Revoke the key an earlier connect minted. `root_key_id` comes from the list
 * response, not our own token - the node rejects a delete whose root key doesn't match.
 */
async function revokeClientKey(clientId: string): Promise<boolean> {
  let entry: ClientKey | undefined;
  try {
    entry = (await apiClient.meroJs.auth.listClientKeys()).find(
      (e) => e?.client_id === clientId,
    );
  } catch {
    // An unreadable listing is not evidence the key is gone - reporting "revoked"
    // here would leave an admin-scoped, never-expiring key valid while the UI
    // claims otherwise.
    return false;
  }
  if (!entry || !entry.is_valid) return true; // already gone

  try {
    await apiClient.meroJs.auth.deleteClientKey(entry.root_key_id, clientId);
    return true;
  } catch {
    return false;
  }
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
  { client: 'Cursor', location: '.cursor/mcp.json' },
  { client: 'Windsurf', location: '~/.codeium/windsurf/mcp_config.json' },
  { client: 'Codex CLI', location: '~/.codex/config.toml (same fields, TOML syntax)' },
];

/**
 * A copy-paste setup prompt built from live values (credential path, node URL),
 * never the token - the server reads that from disk, not from its config.
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
  /** The node the credential was minted for, which the setting may since have moved off. */
  nodeUrl: string;
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
 * Second the node last minted a key in, not when the call started - an attempt
 * that never reached a mint must not gate the next one.
 */
let lastMintSecond: number | null = null;

function unixSecond(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Mint a client key on the current node and write it where the MCP server will
 * find it, replacing the key an earlier connect left behind.
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
 * `permissions: ['admin']` is deliberate, not an oversight: core cannot scope
 * execute permissions yet, so anything narrower could not drive the node's apps.
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

  let key;
  try {
    key = (await apiClient.meroJs.auth.generateClientKey({ permissions: ['admin'] })).data;
  } catch (error) {
    if (error instanceof AuthRevokedError) {
      throw new Error('Your node session was revoked. Sign in again, then reconnect the agent.');
    }
    throw error;
  }
  if (!key?.access_token || !key?.refresh_token) {
    throw new Error('Node returned no credential for the agent');
  }
  // Armed only now: a key exists on the node from this second on, and nothing
  // before this point created one.
  lastMintSecond = unixSecond();
  const clientId = clientIdFromToken(key.access_token);
  if (!clientId) {
    // client_id is what the delete endpoint needs; without it this key can never
    // be revoked by this app, so it must not be written or tracked as if it could.
    throw new Error(
      'The node minted an agent key but its token had no derivable client id, so the key cannot be tracked for revocation. A client key may have been left on the node - check GET /admin/keys/clients and remove it manually.',
    );
  }

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
    await revokeClientKey(clientId).catch(() => {});
    throw error;
  }
  // The path and the node go with the id: the agent tab has no other way back to
  // the setup prompt, and the prompt must name the node this credential points at.
  saveSettings({
    ...getSettings(),
    mcpAgentClientId: clientId,
    mcpAgentCredentialPath: path,
    mcpAgentNodeUrl: nodeUrl,
  });

  // False when core's clock reuses the previous id, which keeps the revoke below
  // from deleting the key these freshly written tokens belong to.
  const replacedPrevious = Boolean(previousClientId && previousClientId !== clientId);
  let revokeFailed = false;

  // Client keys never expire, so without this every connect leaves another
  // admin-scoped key valid on the node forever.
  if (replacedPrevious) {
    try {
      revokeFailed = !(await revokeClientKey(previousClientId as string));
    } catch {
      // The new credential is already in place; a failed cleanup must not fail the connect.
      revokeFailed = true;
    }
  }

  return { path, nodeUrl, clientId, replacedPrevious, revokeFailed };
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
