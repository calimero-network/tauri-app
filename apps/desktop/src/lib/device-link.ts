/**
 * Pair a second device into this node's account, and withdraw one - the calls
 * behind the Account / Devices panel.
 */
import { getSettings } from '../utils/settings';
import { brokerAccessToken } from './token-broker';

/** The node revoked our token family; no retry can succeed. */
const REVOKED_AUTH_ERRORS = ['token_reuse', 'token_revoked'];

/** Core's own ceiling for a list page; its default of 100 would truncate in silence. */
const LIST_LIMIT = 1000;

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const HEX_128 = /^[0-9a-fA-F]{128}$/;

/** What the pairing device mints, to be read across to the account holder. */
export interface PairInitResult {
  accountId: string;
  deviceId: string;
  kemPublicKey: string;
  signPublicKey: string;
  statement: string;
  confirmationCode: string;
}

export interface PairCompleteResult {
  accountId: string;
  deviceId: string;
  keyDelivered: boolean;
  confirmationCode: string;
}

export interface AccountDevice {
  /** 64 hex characters, the form `revokeDevice` and `relinkDevice` take. */
  deviceId: string;
  /** base58, unlike the hex `signPublicKey` of a pairing payload. */
  signingKey: string;
  isSelf: boolean;
  revoked: boolean;
  /** base58 application ids. Empty means every application, not none. */
  applications: string[];
  /** Hex ids of the namespaces holding a live binding for this device. */
  namespaces: string[];
}

export interface AccountApplication {
  applicationId: string;
  namespaces: string[];
}

/** Namespaces a relink published the device into, and those it left alone. */
export interface RelinkResult {
  linkedIn: string[];
  skipped: string[];
}

export interface NamespaceSummary {
  namespaceId: string;
  name?: string;
  /** base58. The application a device's scope is chosen in terms of. */
  targetApplicationId: string;
}

/**
 * One authenticated admin-api call. Core wraps some payloads in `{ data }` and
 * serializes others straight, so unwrap only where the wrapper is.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const nodeUrl = (getSettings().nodeUrl ?? '').replace(/\/$/, '');
  // Rotates only if ours has expired, and through the broker's single flight.
  const accessToken = await brokerAccessToken();

  const response = await fetch(`${nodeUrl}/admin-api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const json = await response.json().catch(() => null);

  if (!response.ok) {
    const authError = response.headers.get('x-auth-error');
    if (authError && REVOKED_AUTH_ERRORS.includes(authError)) {
      throw new Error('Your node session was revoked. Sign in again, then try again.');
    }
    const message =
      json?.error?.message ?? json?.error ?? json?.message ?? `HTTP ${response.status}`;
    const error = new Error(String(message)) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  return (json?.data ?? json) as T;
}

export async function listNamespaces(signal?: AbortSignal): Promise<NamespaceSummary[]> {
  const namespaces = await request<NamespaceSummary[]>(`/namespaces?limit=${LIST_LIMIT}`, {
    signal,
  });
  return Array.isArray(namespaces) ? namespaces : [];
}

export async function listAccountDevices(signal?: AbortSignal): Promise<AccountDevice[]> {
  // Top-level `{ devices }`, with no `{ data }` wrapper.
  const body = await request<{ devices?: AccountDevice[] }>('/account/devices', { signal });
  return body?.devices ?? [];
}

export async function listAccountApplications(
  signal?: AbortSignal,
): Promise<AccountApplication[]> {
  const body = await request<{ applications?: AccountApplication[] }>('/account/applications', {
    signal,
  });
  return body?.applications ?? [];
}

export function pairInit(
  accountRootPublicKey: string,
  namespaces: string[],
): Promise<PairInitResult> {
  return request<PairInitResult>('/account/pair-init', {
    method: 'POST',
    body: JSON.stringify({ accountRootPublicKey, namespaces }),
  });
}

export function pairComplete(
  payload: Omit<PairInitResult, 'accountId'>,
  applications?: string[],
): Promise<PairCompleteResult> {
  const invalid = validatePairPayload(payload);
  if (invalid) return Promise.reject(new Error(invalid));

  // Undefined drops out of the JSON, which is core's "every application"; an
  // empty array would say the same thing, so neither is written explicitly.
  return request<PairCompleteResult>('/account/pair-complete', {
    method: 'POST',
    body: JSON.stringify({ ...payload, applications }),
  });
}

/** Without `applications` this repairs the scope already stored, which is what
 *  an operator asks for to heal drift; with them it widens that scope. */
export async function relinkDevice(
  deviceId: string,
  applications?: string[],
): Promise<RelinkResult> {
  const result = await request<{
    linkedIn?: { namespaceId: string }[];
    skipped?: { namespaceId: string }[];
  }>(`/account/devices/${encodeURIComponent(deviceId)}/relink`, {
    method: 'POST',
    body: JSON.stringify({ applications }),
  });
  return {
    linkedIn: (result?.linkedIn ?? []).map((entry) => entry.namespaceId),
    skipped: (result?.skipped ?? []).map((entry) => entry.namespaceId),
  };
}

export async function revokeDevice(
  namespaceId: string,
  deviceId: string,
): Promise<{ revokedIn: string[] }> {
  const result = await request<{ revokedIn?: { namespaceId: string }[] }>(
    `/namespaces/${encodeURIComponent(namespaceId)}/account/revoke`,
    { method: 'POST', body: JSON.stringify({ deviceId }) },
  );
  return { revokedIn: (result?.revokedIn ?? []).map((entry) => entry.namespaceId) };
}

/** The status a refusal carried, or undefined for anything else. Core types its
 *  refusals so a caller can tell a payload it can fix from one it cannot. */
export function refusalStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? (error as { status?: number }).status
    : undefined;
}

/** Grouping and case are the reader's, not the code's: "7bc0daac ccb484a4" is the same code. */
export function normalizeConfirmationCode(raw: string): string {
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return hex.match(/.{1,4}/g)?.join('-') ?? '';
}

/**
 * Core flattens every semantic pairing refusal to an opaque 500, so this width
 * check is the only place a truncated paste gets a message naming what is wrong.
 */
export function validatePairPayload(
  p: Partial<Omit<PairInitResult, 'accountId'>>,
): string | null {
  for (const field of ['deviceId', 'kemPublicKey', 'signPublicKey'] as const) {
    if (!HEX_64.test(p[field] ?? '')) return `${field} must be 64 hex characters`;
  }
  if (!HEX_128.test(p.statement ?? '')) return 'statement must be 128 hex characters';
  if (!normalizeConfirmationCode(p.confirmationCode ?? '')) {
    return 'confirmationCode must not be empty';
  }
  return null;
}
