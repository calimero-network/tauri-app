import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeroJs, createMeroJs, parseJwtExpiry } from './mero-js';

/**
 * Helper function to create a mock JWT token with specified payload
 */
function createMockJwt(payload: Record<string, unknown>): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = btoa(JSON.stringify(header));
  const encodedPayload = btoa(JSON.stringify(payload));
  const signature = 'fake-signature';
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

// Mock the HTTP client and API clients
const mockHttpClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

const mockAuthClient = {
  getHealth: vi.fn(),
  getIdentity: vi.fn(),
  getProviders: vi.fn(),
  generateTokens: vi.fn(),
  refreshToken: vi.fn(),
  validateToken: vi.fn(),
  listRootKeys: vi.fn(),
  getKeyPermissions: vi.fn(),
  createKey: vi.fn(),
  deleteKey: vi.fn(),
  getClientKeys: vi.fn(),
  generateClientKey: vi.fn(),
  deleteClient: vi.fn(),
  revokeToken: vi.fn(),
  getAuthStatus: vi.fn(),
};

const mockAdminClient = {
  healthCheck: vi.fn(),
  isAuthed: vi.fn(),
  createContext: vi.fn(),
  getContexts: vi.fn(),
  getContext: vi.fn(),
  deleteContext: vi.fn(),
  uploadBlob: vi.fn(),
  listBlobs: vi.fn(),
  getBlob: vi.fn(),
  deleteBlob: vi.fn(),
  createAlias: vi.fn(),
  listAliases: vi.fn(),
  getAlias: vi.fn(),
  deleteAlias: vi.fn(),
  getNetworkPeers: vi.fn(),
  getNetworkStats: vi.fn(),
  getNetworkConfig: vi.fn(),
  updateNetworkConfig: vi.fn(),
  getSystemInfo: vi.fn(),
  getSystemLogs: vi.fn(),
  getSystemMetrics: vi.fn(),
  restartSystem: vi.fn(),
  shutdownSystem: vi.fn(),
  installApplication: vi.fn(),
  installDevApplication: vi.fn(),
  uninstallApplication: vi.fn(),
  listApplications: vi.fn(),
  getApplication: vi.fn(),
};

vi.mock('./http-client', () => ({
  createBrowserHttpClient: vi.fn(() => mockHttpClient),
}));

vi.mock('./auth-api', () => ({
  createAuthApiClientFromHttpClient: vi.fn(() => mockAuthClient),
}));

vi.mock('./admin-api', () => ({
  createAdminApiClientFromHttpClient: vi.fn(() => mockAdminClient),
}));

describe('parseJwtExpiry', () => {
  it('should parse exp claim from valid JWT', () => {
    const expTimestamp = 1700000000; // Unix timestamp in seconds
    const token = createMockJwt({ exp: expTimestamp, sub: 'user123' });

    const result = parseJwtExpiry(token);

    // Should convert seconds to milliseconds
    expect(result).toBe(expTimestamp * 1000);
  });

  it('should return null for JWT without exp claim', () => {
    const token = createMockJwt({ sub: 'user123', iat: 1699999000 });

    const result = parseJwtExpiry(token);

    expect(result).toBeNull();
  });

  it('should return null for invalid JWT format (no dots)', () => {
    const result = parseJwtExpiry('invalid-token-without-dots');

    expect(result).toBeNull();
  });

  it('should return null for JWT with wrong number of parts', () => {
    const result = parseJwtExpiry('header.payload');

    expect(result).toBeNull();
  });

  it('should return null for JWT with invalid base64 payload', () => {
    const result = parseJwtExpiry('valid.!!!invalid-base64!!!.signature');

    expect(result).toBeNull();
  });

  it('should return null for JWT with non-JSON payload', () => {
    const header = btoa('{"alg":"HS256"}');
    const payload = btoa('not-json');
    const result = parseJwtExpiry(`${header}.${payload}.signature`);

    expect(result).toBeNull();
  });

  it('should return null when exp is not a number', () => {
    const token = createMockJwt({ exp: 'not-a-number', sub: 'user123' });

    const result = parseJwtExpiry(token);

    expect(result).toBeNull();
  });

  it('should handle base64url encoded tokens (with - and _)', () => {
    // Create a payload that would produce - or _ in base64url
    const expTimestamp = 1700000000;
    const header = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'; // standard header
    // Manually create a payload with base64url characters
    const payload = btoa(JSON.stringify({ exp: expTimestamp }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    const token = `${header}.${payload}.signature`;
    const result = parseJwtExpiry(token);

    expect(result).toBe(expTimestamp * 1000);
  });

  it('should handle empty string token', () => {
    const result = parseJwtExpiry('');

    expect(result).toBeNull();
  });
});

describe('MeroJs SDK', () => {
  let meroJs: MeroJs;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should create MeroJs instance with default config', () => {
      const config = {
        baseUrl: 'http://localhost:3000',
        credentials: {
          username: 'admin',
          password: 'admin123',
        },
      };

      meroJs = new MeroJs(config);

      expect(meroJs).toBeDefined();
      expect(meroJs.auth).toBeDefined();
      expect(meroJs.admin).toBeDefined();
      expect(meroJs.isAuthenticated()).toBe(false);
    });

    it('should create MeroJs instance with custom config', () => {
      const config = {
        baseUrl: 'http://localhost:8080',
        timeoutMs: 15000,
      };

      meroJs = new MeroJs(config);

      expect(meroJs).toBeDefined();
      expect(meroJs.isAuthenticated()).toBe(false);
    });
  });

  describe('createMeroJs factory', () => {
    it('should create MeroJs instance using factory function', () => {
      const config = {
        baseUrl: 'http://localhost:3000',
      };

      meroJs = createMeroJs(config);

      expect(meroJs).toBeDefined();
      expect(meroJs.auth).toBeDefined();
      expect(meroJs.admin).toBeDefined();
    });
  });

  describe('Authentication', () => {
    beforeEach(() => {
      meroJs = new MeroJs({
        baseUrl: 'http://localhost:3000',
        credentials: {
          username: 'admin',
          password: 'admin123',
        },
      });
    });

    it('should authenticate successfully', async () => {
      const mockTokenResponse = {
        data: {
          access_token: 'mock-access-token',
          refresh_token: 'mock-refresh-token',
        },
      };

      mockAuthClient.generateTokens.mockResolvedValue(mockTokenResponse);

      const tokenData = await meroJs.authenticate();

      expect(mockAuthClient.generateTokens).toHaveBeenCalledWith({
        auth_method: 'user_password',
        public_key: 'admin',
        client_name: 'mero-js-sdk',
        permissions: ['admin'],
        timestamp: expect.any(Number),
        provider_data: {
          username: 'admin',
          password: 'admin123',
        },
      });

      expect(tokenData).toEqual({
        access_token: 'mock-access-token',
        refresh_token: 'mock-refresh-token',
        expires_at: expect.any(Number),
      });

      expect(meroJs.isAuthenticated()).toBe(true);
    });

    it('should use JWT exp claim for token expiry when available', async () => {
      const futureExpiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now in seconds
      const mockJwtToken = createMockJwt({
        exp: futureExpiry,
        sub: 'user123',
      });

      const mockTokenResponse = {
        data: {
          access_token: mockJwtToken,
          refresh_token: 'mock-refresh-token',
        },
      };

      mockAuthClient.generateTokens.mockResolvedValue(mockTokenResponse);

      const tokenData = await meroJs.authenticate();

      // The expires_at should match the JWT exp claim (converted to milliseconds)
      expect(tokenData.expires_at).toBe(futureExpiry * 1000);
    });

    it('should fall back to default expiry when JWT has no exp claim', async () => {
      const mockJwtToken = createMockJwt({
        sub: 'user123',
        iat: Math.floor(Date.now() / 1000),
      });

      const mockTokenResponse = {
        data: {
          access_token: mockJwtToken,
          refresh_token: 'mock-refresh-token',
        },
      };

      mockAuthClient.generateTokens.mockResolvedValue(mockTokenResponse);

      const beforeAuth = Date.now();
      const tokenData = await meroJs.authenticate();
      const afterAuth = Date.now();

      // Should fall back to default 24 hours
      const expectedMinExpiry = beforeAuth + 24 * 60 * 60 * 1000;
      const expectedMaxExpiry = afterAuth + 24 * 60 * 60 * 1000;

      expect(tokenData.expires_at).toBeGreaterThanOrEqual(expectedMinExpiry);
      expect(tokenData.expires_at).toBeLessThanOrEqual(expectedMaxExpiry);
    });

    it('should fall back to default expiry when token is not a valid JWT', async () => {
      const mockTokenResponse = {
        data: {
          access_token: 'not-a-valid-jwt-token',
          refresh_token: 'mock-refresh-token',
        },
      };

      mockAuthClient.generateTokens.mockResolvedValue(mockTokenResponse);

      const beforeAuth = Date.now();
      const tokenData = await meroJs.authenticate();
      const afterAuth = Date.now();

      // Should fall back to default 24 hours
      const expectedMinExpiry = beforeAuth + 24 * 60 * 60 * 1000;
      const expectedMaxExpiry = afterAuth + 24 * 60 * 60 * 1000;

      expect(tokenData.expires_at).toBeGreaterThanOrEqual(expectedMinExpiry);
      expect(tokenData.expires_at).toBeLessThanOrEqual(expectedMaxExpiry);
    });

    it('should authenticate with custom credentials', async () => {
      const mockTokenResponse = {
        data: {
          access_token: 'mock-access-token',
          refresh_token: 'mock-refresh-token',
        },
      };

      mockAuthClient.generateTokens.mockResolvedValue(mockTokenResponse);

      const tokenData = await meroJs.authenticate({
        username: 'custom-user',
        password: 'custom-pass',
      });

      expect(mockAuthClient.generateTokens).toHaveBeenCalledWith({
        auth_method: 'user_password',
        public_key: 'custom-user',
        client_name: 'mero-js-sdk',
        permissions: ['admin'],
        timestamp: expect.any(Number),
        provider_data: {
          username: 'custom-user',
          password: 'custom-pass',
        },
      });

      expect(tokenData.access_token).toBe('mock-access-token');
    });

    it('should throw error when authentication fails', async () => {
      mockAuthClient.generateTokens.mockRejectedValue(new Error('Auth failed'));

      await expect(meroJs.authenticate()).rejects.toThrow(
        'Authentication failed: Auth failed',
      );
    });

    it('should throw error when no credentials provided', async () => {
      const meroJsNoCreds = new MeroJs({
        baseUrl: 'http://localhost:3000',
      });

      await expect(meroJsNoCreds.authenticate()).rejects.toThrow(
        'No credentials provided for authentication',
      );
    });
  });

  describe('Token Management', () => {
    beforeEach(() => {
      meroJs = new MeroJs({
        baseUrl: 'http://localhost:3000',
        credentials: {
          username: 'admin',
          password: 'admin123',
        },
      });
    });

    it('should clear token', () => {
      meroJs.clearToken();
      expect(meroJs.isAuthenticated()).toBe(false);
    });

    it('should get token data when not authenticated', () => {
      const tokenData = meroJs.getTokenData();
      expect(tokenData).toBeNull();
    });

    it('should get token data when authenticated', async () => {
      const mockTokenResponse = {
        data: {
          access_token: 'mock-access-token',
          refresh_token: 'mock-refresh-token',
        },
      };

      mockAuthClient.generateTokens.mockResolvedValue(mockTokenResponse);

      await meroJs.authenticate();

      const tokenData = meroJs.getTokenData();
      expect(tokenData).toBeDefined();
      expect(tokenData?.access_token).toBe('mock-access-token');
    });

    it('should refresh token when expired', async () => {
      // First authenticate
      const mockTokenResponse = {
        data: {
          access_token: 'mock-access-token',
          refresh_token: 'mock-refresh-token',
        },
      };

      mockAuthClient.generateTokens.mockResolvedValue(mockTokenResponse);
      await meroJs.authenticate();

      // Mock refresh response
      const mockRefreshResponse = {
        data: {
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
        },
      };

      mockAuthClient.refreshToken.mockResolvedValue(mockRefreshResponse);

      // Manually set token as expired
      const tokenData = meroJs.getTokenData()!;
      tokenData.expires_at = Date.now() - 1000; // Expired 1 second ago

      // This should trigger a refresh
      const validToken = await (meroJs as any).getValidToken();

      expect(mockAuthClient.refreshToken).toHaveBeenCalledWith({
        access_token: 'mock-access-token',
        refresh_token: 'mock-refresh-token',
      });

      expect(validToken.access_token).toBe('new-access-token');
    });

    it('should use JWT exp claim for token expiry after refresh', async () => {
      // First authenticate with a token that will expire
      const initialExpiry = Math.floor(Date.now() / 1000) + 60; // 1 minute from now
      const initialJwt = createMockJwt({ exp: initialExpiry, sub: 'user123' });

      const mockTokenResponse = {
        data: {
          access_token: initialJwt,
          refresh_token: 'mock-refresh-token',
        },
      };

      mockAuthClient.generateTokens.mockResolvedValue(mockTokenResponse);
      await meroJs.authenticate();

      // Mock refresh response with new JWT
      const newExpiry = Math.floor(Date.now() / 1000) + 7200; // 2 hours from now
      const newJwt = createMockJwt({ exp: newExpiry, sub: 'user123' });

      const mockRefreshResponse = {
        data: {
          access_token: newJwt,
          refresh_token: 'new-refresh-token',
        },
      };

      mockAuthClient.refreshToken.mockResolvedValue(mockRefreshResponse);

      // Manually set token as expired to trigger refresh
      const tokenData = meroJs.getTokenData()!;
      tokenData.expires_at = Date.now() - 1000;

      // This should trigger a refresh
      const validToken = await (meroJs as any).getValidToken();

      // The new token should have the expiry from the new JWT
      expect(validToken.expires_at).toBe(newExpiry * 1000);
    });

    it('should clear token when refresh fails', async () => {
      // First authenticate
      const mockTokenResponse = {
        data: {
          access_token: 'mock-access-token',
          refresh_token: 'mock-refresh-token',
        },
      };

      mockAuthClient.generateTokens.mockResolvedValue(mockTokenResponse);
      await meroJs.authenticate();

      // Mock refresh failure
      mockAuthClient.refreshToken.mockRejectedValue(
        new Error('Refresh failed'),
      );

      // Manually set token as expired
      const tokenData = meroJs.getTokenData()!;
      tokenData.expires_at = Date.now() - 1000; // Expired 1 second ago

      // This should trigger a refresh and fail
      await expect((meroJs as any).getValidToken()).rejects.toThrow(
        'Token refresh failed: Refresh failed',
      );
      expect(meroJs.isAuthenticated()).toBe(false);
    });
  });

  describe('API Access', () => {
    beforeEach(() => {
      meroJs = new MeroJs({
        baseUrl: 'http://localhost:3000',
      });
    });

    it('should provide auth API client', () => {
      expect(meroJs.auth).toBeDefined();
      expect(typeof meroJs.auth.generateTokens).toBe('function');
      expect(typeof meroJs.auth.refreshToken).toBe('function');
      expect(typeof meroJs.auth.getHealth).toBe('function');
      expect(typeof meroJs.auth.listRootKeys).toBe('function');
    });

    it('should provide admin API client', () => {
      expect(meroJs.admin).toBeDefined();
      expect(typeof meroJs.admin.healthCheck).toBe('function');
      expect(typeof meroJs.admin.isAuthed).toBe('function');
      expect(typeof meroJs.admin.getContexts).toBe('function');
      expect(typeof meroJs.admin.listBlobs).toBe('function');
    });
  });

  describe('HTTP Client Integration', () => {
    it('should pass auth token to HTTP client', async () => {
      const { createBrowserHttpClient } = await import('./http-client');

      meroJs = new MeroJs({
        baseUrl: 'http://localhost:3000',
        credentials: {
          username: 'admin',
          password: 'admin123',
        },
      });

      // Mock authentication
      const mockTokenResponse = {
        data: {
          access_token: 'mock-access-token',
          refresh_token: 'mock-refresh-token',
        },
      };

      mockAuthClient.generateTokens.mockResolvedValue(mockTokenResponse);
      await meroJs.authenticate();

      // Verify HTTP client was created with getAuthToken function
      expect(createBrowserHttpClient).toHaveBeenCalledWith({
        baseUrl: 'http://localhost:3000',
        getAuthToken: expect.any(Function),
        timeoutMs: 10000,
      });

      // Test that getAuthToken returns the token
      const getAuthToken = (createBrowserHttpClient as any).mock.calls[0][0]
        .getAuthToken;
      const token = await getAuthToken();
      expect(token).toBe('mock-access-token');
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      meroJs = new MeroJs({
        baseUrl: 'http://localhost:3000',
        credentials: {
          username: 'admin',
          password: 'admin123',
        },
      });
    });

    it('should handle authentication errors gracefully', async () => {
      mockAuthClient.generateTokens.mockRejectedValue(
        new Error('Network error'),
      );

      await expect(
        meroJs.authenticate({
          username: 'admin',
          password: 'admin123',
        }),
      ).rejects.toThrow('Authentication failed: Network error');
    });

    it('should handle refresh token errors gracefully', async () => {
      // First authenticate successfully
      const mockTokenResponse = {
        data: {
          access_token: 'mock-access-token',
          refresh_token: 'mock-refresh-token',
        },
      };

      mockAuthClient.generateTokens.mockResolvedValue(mockTokenResponse);
      await meroJs.authenticate();

      // Mock refresh failure
      mockAuthClient.refreshToken.mockRejectedValue(
        new Error('Invalid refresh token'),
      );

      // Manually set token as expired
      const tokenData = meroJs.getTokenData()!;
      tokenData.expires_at = Date.now() - 1000;

      await expect((meroJs as any).getValidToken()).rejects.toThrow(
        'Token refresh failed: Invalid refresh token',
      );
      expect(meroJs.isAuthenticated()).toBe(false);
    });
  });

  describe('Configuration', () => {
    it('should use default timeout when not provided', async () => {
      const { createBrowserHttpClient } = await import('./http-client');

      meroJs = new MeroJs({
        baseUrl: 'http://localhost:3000',
      });

      expect(createBrowserHttpClient).toHaveBeenCalledWith({
        baseUrl: 'http://localhost:3000',
        getAuthToken: expect.any(Function),
        timeoutMs: 10000,
      });
    });

    it('should use custom timeout when provided', async () => {
      const { createBrowserHttpClient } = await import('./http-client');

      meroJs = new MeroJs({
        baseUrl: 'http://localhost:3000',
        timeoutMs: 30000,
      });

      expect(createBrowserHttpClient).toHaveBeenCalledWith({
        baseUrl: 'http://localhost:3000',
        getAuthToken: expect.any(Function),
        timeoutMs: 30000,
      });
    });
  });
});
