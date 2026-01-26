// Token storage utilities - matches calimero-client API

const ACCESS_TOKEN_KEY = 'calimero_access_token';
const REFRESH_TOKEN_KEY = 'calimero_refresh_token';
const EXPIRES_AT_KEY = 'calimero_token_expires_at';
const APP_ENDPOINT_KEY = 'calimero_app_endpoint';

export function setAccessToken(token: string): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, token);
}

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function clearAccessToken(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
}

export function setRefreshToken(token: string): void {
  localStorage.setItem(REFRESH_TOKEN_KEY, token);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function clearRefreshToken(): void {
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export function setTokenExpiresAt(expiresAt: number): void {
  localStorage.setItem(EXPIRES_AT_KEY, expiresAt.toString());
}

export function getTokenExpiresAt(): number | null {
  const value = localStorage.getItem(EXPIRES_AT_KEY);
  return value ? parseInt(value, 10) : null;
}

export function clearTokenExpiresAt(): void {
  localStorage.removeItem(EXPIRES_AT_KEY);
}

export function getAppEndpointKey(): string | null {
  return localStorage.getItem(APP_ENDPOINT_KEY);
}

export function setAppEndpointKey(endpoint: string): void {
  localStorage.setItem(APP_ENDPOINT_KEY, endpoint);
}

export function clearAppEndpointKey(): void {
  localStorage.removeItem(APP_ENDPOINT_KEY);
}

/**
 * Clear all auth-related tokens
 */
export function clearAllTokens(): void {
  clearAccessToken();
  clearRefreshToken();
  clearTokenExpiresAt();
}
