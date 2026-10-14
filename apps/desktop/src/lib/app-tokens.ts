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
 * `POST /admin/client-key`, bound to the window's application and holding only
 * the grants apps call. The desktop still holds the refresh
 * token and stays the sole rotator of each pair (see token-broker.ts), so the
 * single-use rule (core#3083) holds per family exactly as before — and a
 * leaked app token can no longer rotate, revoke or out-rank the desktop's.
 */
import { getSettings } from '../utils/settings';
import { getAccessToken } from './token-storage';
import { brokerAccessToken, unpatchedFetch } from './token-broker';

/**
 * What an app window may do, inside its own application: the node scopes every
 * grant to the `application_id` the key is minted with. The blob verbs are
 * admin-dashboard's APP_TOKEN_PERMISSIONS; `blob:list` would enumerate every app's blobs.
 * Never `admin`, never `keys`.
 */
export const APP_TOKEN_PERMISSIONS: readonly string[] = [
  'context:create',
  'context:list',
  'context:execute',
  'context:subscribe',
  'application:list',
  'namespace:list',
  'namespace:create',
  'namespace:manage',
  'group:list',
  'group:create',
  'group:manage',
  'blob:add',
  'blob:get',
  'blob:remove',
  'context:alias',
];

const LAUNCHER_SLOT_PREFIX = 'launcher-';
/** Which application each slot was opened for. Not a credential, so it outlives a logout. */
const SLOT_APPS_KEY = 'calimero_app_token_slot_apps';
/** What the node accepts as an `application_id`; anything else it would not bind. */
const APPLICATION_ID = /^[A-Za-z0-9_-]+$/;

const STORAGE_KEY = 'calimero_app_token_slots';

/** Treat an access token expiring within this window as already expired. */
const EXPIRY_SKEW_MS = 30_000;

interface AppTokenPair {
  access_token: string;
  refresh_token: string;
}

interface SlotEntry extends AppTokenPair {
  application_id: string;
}

type SlotStore = Record<string, SlotEntry>;

function readSlots(): SlotStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as SlotStore) : {};
  } catch {
    return {};
  }
}

function writeSlot(slot: string, pair: SlotEntry | null): void {
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
async function mint(applicationId: string): Promise<AppTokenPair> {
  const post = (bearer: string) =>
    unpatchedFetch()(`${nodeBase()}/admin/client-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        context_id: '',
        context_identity: '',
        application_id: applicationId,
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
    body: JSON.stringify({ access_token: pair.access_token, refresh_token: pair.refresh_token }),
  });
  if (!res.ok) return null;
  return pairFrom(await res.json().catch(() => null));
}

/** One in-flight acquisition per slot and application, so an app's burst of 401s rotates once. */
const inflight = new Map<string, Promise<string>>();

function readSlotApps(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SLOT_APPS_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function rememberSlotApp(slot: string, application: string): void {
  localStorage.setItem(SLOT_APPS_KEY, JSON.stringify({ ...readSlotApps(), [slot]: application }));
}

/** The application a slot's key is bound to: named by the caller, else remembered, else a launcher's own. */
function slotApplication(slot: string, named?: string): string | undefined {
  if (named) return named;
  const remembered = readSlotApps()[slot];
  if (remembered) return remembered;
  if (slot.startsWith(LAUNCHER_SLOT_PREFIX)) return slot.slice(LAUNCHER_SLOT_PREFIX.length) || undefined;
  return undefined;
}

/**
 * An access token for this app slot, bound to its application: the stored one
 * while fresh, else a rotation of this slot's own pair, else (no pair, its
 * family is dead, or it was minted for another application) a freshly minted
 * one. Never the desktop's token, and none for a slot whose application is unknown.
 */
export function appAccessToken(slot: string, applicationId?: string): Promise<string> {
  const application = slotApplication(slot, applicationId);
  if (!application || !APPLICATION_ID.test(application)) {
    return Promise.reject(new Error(`No application is known for ${slot}`));
  }
  const key = `${slot}\n${application}`;
  const pending = inflight.get(key);
  if (pending) return pending;

  const run = async (): Promise<string> => {
    rememberSlotApp(slot, application);
    const found = readSlots()[slot];
    const stored = found?.application_id === application ? found : undefined;
    if (stored && isFresh(stored)) return stored.access_token;

    let next = stored ? await rotate(stored).catch(() => null) : null;
    if (!next) next = await mint(application);

    writeSlot(slot, { ...next, application_id: application });
    return next.access_token;
  };

  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
