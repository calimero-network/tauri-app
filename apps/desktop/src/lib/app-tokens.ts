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
 * APP_TOKEN_PERMISSIONS. Never `admin`, never `keys`.
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

const STORAGE_KEY = 'calimero_app_token_slots';

/** Treat an access token expiring within this window as already expired. */
const EXPIRY_SKEW_MS = 30_000;

interface AppTokenPair {
  access_token: string;
  refresh_token: string;
}

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
 * Mint a fresh scoped pair with the desktop's session. Retries once after a
 * desktop rotation, because the desktop's own access token may simply be stale.
 */
async function mint(): Promise<AppTokenPair> {
  const post = (bearer: string) =>
    unpatchedFetch()(`${nodeBase()}/admin/client-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        context_id: '',
        context_identity: '',
        permissions: [...APP_TOKEN_PERMISSIONS],
      }),
    });

  const desktop = getAccessToken();
  if (!desktop) throw new Error('Desktop is not authenticated');

  let res = await post(desktop);
  if (res.status === 401) res = await post(await brokerAccessToken());
  if (!res.ok) throw new Error(`Could not mint an app token (HTTP ${res.status})`);

  const pair = pairFrom(await res.json().catch(() => null));
  if (!pair) throw new Error('The node minted no app token');
  return pair;
}

/** Rotate one app's pair. Goes around the fetch patch: that one rotates OURS. */
async function rotate(pair: AppTokenPair): Promise<AppTokenPair | null> {
  const res = await unpatchedFetch()(`${nodeBase()}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pair),
  });
  if (!res.ok) return null;
  return pairFrom(await res.json().catch(() => null));
}

/** One in-flight acquisition per slot, so an app's burst of 401s rotates once. */
const inflight = new Map<string, Promise<string>>();

/**
 * An access token for this app slot: the stored one while fresh, else a
 * rotation of this slot's own pair, else (no pair, or its family is dead) a
 * freshly minted one. Never the desktop's token.
 */
export function appAccessToken(slot: string): Promise<string> {
  const pending = inflight.get(slot);
  if (pending) return pending;

  const run = async (): Promise<string> => {
    const stored = readSlots()[slot];
    if (stored && isFresh(stored)) return stored.access_token;

    let next = stored ? await rotate(stored).catch(() => null) : null;
    if (!next) next = await mint();

    writeSlot(slot, next);
    return next.access_token;
  };

  const p = run().finally(() => inflight.delete(slot));
  inflight.set(slot, p);
  return p;
}
