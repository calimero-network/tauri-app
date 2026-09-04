/**
 * Pair a second device into this node's account, and withdraw one - the calls
 * behind the Account / Devices panel.
 */
import {
  AuthRevokedError,
  HTTPError,
  type AccountApplicationEntry,
  type AccountDeviceEntry,
  type AccountPairCompleteResponseData,
  type AccountPairInitResponseData,
  type NodeIdentity,
} from '@calimero-network/mero-js';
import { getSettings } from '../utils/settings';
import { apiClient } from './mero-client';
import { brokerAccessToken } from './token-broker';

/** Core's own ceiling for a list page; its default of 100 would truncate in silence. */
const LIST_LIMIT = 1000;
/** The node revoked our token family; no retry can succeed. */
const REVOKED_AUTH_ERRORS = ['token_reuse', 'token_revoked'];
const REVOKED_MESSAGE = 'Your node session was revoked. Sign in again, then try again.';

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const ALL_ZERO = /^0{64}$/;
const HEX_128 = /^[0-9a-fA-F]{128}$/;

/** What the pairing device mints, to be read across to the account holder. */
export type PairInitResult = AccountPairInitResponseData;
export type PairCompleteResult = AccountPairCompleteResponseData;
export type AccountDevice = AccountDeviceEntry;
export type AccountApplication = AccountApplicationEntry;

/** Namespaces a relink published the device into, and those it left alone. */
export interface RelinkResult {
  linkedIn: string[];
  skipped: string[];
}

export interface NamespaceSummary {
  namespaceId: string;
  name?: string;
  /** Hex. The application a device's scope is chosen in terms of. */
  targetApplicationId: string;
}

/** The node's admin API, over the app's shared token store and its refresh. */
const admin = () => apiClient.meroJs.admin;

/** A revoked family is terminal, and the SDK's status line does not say so. */
async function terminalOnRevoked<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof AuthRevokedError) throw new Error(REVOKED_MESSAGE);
    throw error;
  }
}

/**
 * Who this node is, or `null` for a node that has taken part in nothing yet -
 * it holds neither a device nor an account root, so the route 404s, and that is
 * a normal state rather than a failure.
 */
export async function nodeIdentity(): Promise<NodeIdentity | null> {
  try {
    return await admin().getNodeIdentity();
  } catch (error) {
    if (error instanceof HTTPError && error.status === 404) return null;
    throw error;
  }
}

/**
 * The one call still made by hand: `listNamespaces()` sends no `limit` and core
 * defaults to 100, which would silently narrow an invite.
 */
export async function listNamespaces(signal?: AbortSignal): Promise<NamespaceSummary[]> {
  const nodeUrl = (getSettings().nodeUrl ?? '').replace(/\/$/, '');
  // Rotates only if ours has expired, and through the broker's single flight.
  const accessToken = await brokerAccessToken();

  const response = await fetch(`${nodeUrl}/admin-api/namespaces?limit=${LIST_LIMIT}`, {
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) {
    const authError = response.headers.get('x-auth-error');
    throw new Error(
      authError && REVOKED_AUTH_ERRORS.includes(authError)
        ? REVOKED_MESSAGE
        : `HTTP ${response.status}`,
    );
  }

  const body = await response.json().catch(() => null);
  const namespaces = body?.data ?? body;
  return Array.isArray(namespaces) ? namespaces : [];
}

export async function listAccountDevices(): Promise<AccountDevice[]> {
  return (await terminalOnRevoked(admin().listAccountDevices())) ?? [];
}

export async function listAccountApplications(): Promise<AccountApplication[]> {
  const applications = (await terminalOnRevoked(admin().listAccountApplications())) ?? [];
  return applications.filter((app) => !ALL_ZERO.test(app.applicationId));
}

export function pairInit(
  accountRootPublicKey: string,
  namespaces: string[],
): Promise<PairInitResult> {
  return terminalOnRevoked(admin().initAccountPairing({ accountRootPublicKey, namespaces }));
}

export function pairComplete(
  payload: Omit<PairInitResult, 'accountId'>,
  applications?: string[],
): Promise<PairCompleteResult> {
  const invalid = validatePairPayload(payload);
  if (invalid) return Promise.reject(new Error(invalid));

  // Undefined drops out of the JSON, which is core's "every application"; an
  // empty array would say the same thing, so neither is written explicitly.
  return terminalOnRevoked(admin().completeAccountPairing({ ...payload, applications }));
}

/** Without `applications` this repairs the scope already stored, which is what
 *  an operator asks for to heal drift; with them it widens that scope. */
export async function relinkDevice(
  deviceId: string,
  applications?: string[],
): Promise<RelinkResult> {
  const result = await terminalOnRevoked(
    admin().relinkAccountDevice(deviceId, { applications }),
  );
  return {
    linkedIn: (result?.linkedIn ?? []).map((entry) => entry.namespaceId),
    skipped: (result?.skipped ?? []).map((entry) => entry.namespaceId),
  };
}

export async function revokeDevice(
  namespaceId: string,
  deviceId: string,
): Promise<{ revokedIn: string[] }> {
  const result = await terminalOnRevoked(
    admin().revokeAccountDevice(namespaceId, { deviceId }),
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
