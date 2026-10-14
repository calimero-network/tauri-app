/**
 * Per-app token pairs — what an app window actually gets to act with.
 *
 * ⚠️ WHY THIS EXISTS. App windows used to receive the DESKTOP's own access
 * token, and the broker refreshed it for them forever. The desktop logs in with
 * `permissions: []` — a root key — so every marketplace app, whose frontend URL
 * is whatever its publisher put in the registry, held full node admin for as
 * long as its window lived: mint keys, install apps, read every context. The
 * auth frontend's consent screen never ran.
 *
 * Now each app window (a "slot": its window label, or `launcher-<appId>` for a
 * per-app launcher process) gets its OWN client key, minted by the desktop via
 * `POST /admin/client-key` with the grant set mero-react asks for in
 * multi-context mode and nothing else. The desktop still holds the refresh
 * token and stays the sole rotator of each pair (see token-broker.ts), so the
 * single-use rule (core#3083) holds per family exactly as before — and a
 * leaked app token can no longer rotate, revoke or out-rank the desktop's.
 */
import { getSettings } from '../utils/settings';
import { getAccessToken } from './token-storage';
import { brokerAccessToken, unpatchedFetch } from './token-broker';

/**
 * What an app window may do. Mirrors mero-react's
 * `getPermissionsForMode(AppMode.MultiContext)` — the grant set a mero-react app
 * would request through the auth frontend anyway — and admin-dashboard's
 * APP_TOKEN_PERMISSIONS. Never `admin`, never `keys`: only a TRUSTED_APPS entry
 * acts with more.
 */
export const APP_TOKEN_PERMISSIONS: readonly string[] = [
  'context:create',
  'context:list',
  'context:execute',
  'context:subscribe',
  'application:list',
  'namespace',
  'group',
  'blob',
  'context:alias',
];

/**
 * First-party apps that run the node for you, as the admin dashboard does, and
 * so act with full access: package → the frontend origins it is trusted at.
 * Both must match, so a bundle claiming the package from anywhere else gets
 * the plain app set, and app_window.rs serves a window only while it shows the
 * origin it was opened at.
 *
 * Fixed here and never read from a manifest: an app cannot ask its way in.
 * Hyperfeed installs apps and deletes feeds for you.
 */
export const TRUSTED_APPS: Readonly<Record<string, readonly string[]>> = {
  'com.calimero.hyperfeed': ['https://hyperfeed-two.vercel.app'],
};

/** What a trusted app acts with: the admin dashboard's grant. Never `keys`. */
export const TRUSTED_APP_PERMISSIONS: readonly string[] = ['admin'];

/** The grant for an app: full access for a trusted package at its own origin. */
export function grantForApp(pkg: string | undefined, frontendUrl: string | undefined): readonly string[] {
  const origins = pkg ? TRUSTED_APPS[pkg] : undefined;
  if (!origins || !frontendUrl) return APP_TOKEN_PERMISSIONS;
  try {
    return origins.includes(new URL(frontendUrl).origin) ? TRUSTED_APP_PERMISSIONS : APP_TOKEN_PERMISSIONS;
  } catch {
    return APP_TOKEN_PERMISSIONS;
  }
}

/**
 * The application a slot is for: `app-<appId>` (an in-process window, with a
 * `-n…` suffix when cross-node) or `launcher-<appId>`. Application ids are
 * base58, which has no `-`. Null for a window opened without one.
 */
export function appIdOfSlot(slot: string): string | null {
  const m = /^(?:app|launcher)-([1-9A-HJ-NP-Za-km-z]{32,})(?:-|$)/.exec(slot);
  return m ? m[1] : null;
}

/** A slot's grant, read from the app the node has installed under its id. */
async function grantForSlot(slot: string): Promise<readonly string[]> {
  const appId = appIdOfSlot(slot);
  if (!appId) return APP_TOKEN_PERMISSIONS;
  // Imported here: the cache reaches back into appUtils, which imports this file.
  const { listInstalledApps } = await import('../utils/installedAppsCache');
  const { decodeMetadata } = await import('../utils/appUtils');
  const res = await listInstalledApps();
  const app: any = Array.isArray(res.data) ? res.data.find((a: any) => a.id === appId) : undefined;
  if (!app) return APP_TOKEN_PERMISSIONS;
  return grantForApp(app.package, decodeMetadata(app.metadata)?.links?.frontend);
}

const STORAGE_KEY = 'calimero_app_token_slots';

/** Treat an access token expiring within this window as already expired. */
const EXPIRY_SKEW_MS = 30_000;

interface AppTokenPair {
  access_token: string;
  refresh_token: string;
  /** The grant it was minted with (`grantKey`); absent on pairs from before trusted apps. */
  grant?: string;
}

const grantKey = (permissions: readonly string[]) => [...permissions].sort().join(',');

type SlotStore = Record<string, AppTokenPair>;

function readSlots(): SlotStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as SlotStore) : {};
  } catch {
    return {};
  }
}

function writeSlot(slot: string, pair: AppTokenPair | null): void {
  const slots = readSlots();
  if (pair) slots[slot] = pair;
  else delete slots[slot];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(slots));
}

/** Forget every app's pair — on logout, or when the desktop's session changes. */
export function clearAppTokens(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function expiresAtFromJwt(accessToken: string): number {
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1]));
    if (typeof payload.exp === 'number') return payload.exp * 1000;
  } catch {
    // not a JWT / unparseable — fall through
  }
  return Date.now() + 3600_000;
}

function isFresh(pair: AppTokenPair): boolean {
  return expiresAtFromJwt(pair.access_token) - Date.now() > EXPIRY_SKEW_MS;
}

function nodeBase(): string {
  return (getSettings().nodeUrl ?? '').replace(/\/+$/, '');
}

function pairFrom(body: unknown): AppTokenPair | null {
  const data = (body as { data?: unknown } | null)?.data ?? body;
  const d = data as Partial<AppTokenPair> | null;
  return d?.access_token && d?.refresh_token
    ? { access_token: d.access_token, refresh_token: d.refresh_token }
    : null;
}

/**
 * Mint a fresh pair with the desktop's session, granting `permissions`. Retries
 * once after a desktop rotation, because the desktop's own access token may
 * simply be stale.
 */
async function mint(permissions: readonly string[]): Promise<AppTokenPair> {
  const post = (bearer: string) =>
    unpatchedFetch()(`${nodeBase()}/admin/client-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        context_id: '',
        context_identity: '',
        permissions: [...permissions],
      }),
    });

  const desktop = getAccessToken();
  if (!desktop) throw new Error('Desktop is not authenticated');

  let res = await post(desktop);
  if (res.status === 401) res = await post(await brokerAccessToken());
  if (!res.ok) throw new Error(`Could not mint an app token (HTTP ${res.status})`);

  const pair = pairFrom(await res.json().catch(() => null));
  if (!pair) throw new Error('The node minted no app token');
  return { ...pair, grant: grantKey(permissions) };
}

/** Rotate one app's pair. Goes around the fetch patch: that one rotates OURS. */
async function rotate(pair: AppTokenPair): Promise<AppTokenPair | null> {
  const res = await unpatchedFetch()(`${nodeBase()}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: pair.access_token, refresh_token: pair.refresh_token }),
  });
  if (!res.ok) return null;
  const next = pairFrom(await res.json().catch(() => null));
  return next && { ...next, grant: pair.grant };
}

/** One in-flight acquisition per slot, so an app's burst of 401s rotates once. */
const inflight = new Map<string, Promise<string>>();

/**
 * An access token for this app slot: the stored one while fresh, else a
 * rotation of this slot's own pair, else (no pair, or its family is dead) a
 * freshly minted one. Never the desktop's token.
 *
 * A pair minted with another grant than the slot's app gets now (an app made
 * trusted, or a pair from before trusted apps) is not reused: one is minted.
 */
export function appAccessToken(slot: string): Promise<string> {
  const pending = inflight.get(slot);
  if (pending) return pending;

  const run = async (): Promise<string> => {
    const permissions = await grantForSlot(slot).catch(() => APP_TOKEN_PERMISSIONS);
    const grant = grantKey(permissions);
    const kept = readSlots()[slot];
    const stored = kept && (kept.grant ?? grantKey(APP_TOKEN_PERMISSIONS)) === grant ? kept : undefined;
    if (stored && isFresh(stored)) return stored.access_token;

    let next = stored ? await rotate(stored).catch(() => null) : null;
    if (!next) next = await mint(permissions);

    writeSlot(slot, next);
    return next.access_token;
  };

  const p = run().finally(() => inflight.delete(slot));
  inflight.set(slot, p);
  return p;
}
