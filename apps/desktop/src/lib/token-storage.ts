// Token storage utilities - localStorage keys match the old calimero-client API

const ACCESS_TOKEN_KEY = 'calimero_access_token';
const REFRESH_TOKEN_KEY = 'calimero_refresh_token';
const EXPIRES_AT_KEY = 'calimero_token_expires_at';

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

export function clearAllTokens(): void {
  clearAccessToken();
  clearRefreshToken();
  localStorage.removeItem(EXPIRES_AT_KEY);
}
