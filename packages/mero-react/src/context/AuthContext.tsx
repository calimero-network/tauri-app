import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { createClient, type ClientConfig, apiClient } from '../client';
import type { Provider } from '../client/types';

export interface AuthContextValue {
  isAuthenticated: boolean;
  accessToken: string | null;
  refreshToken: string | null;
  loading: boolean;
  error: string | null;
  providers: Provider[];
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  refreshAuthToken: () => Promise<boolean>;
  loadProviders: () => Promise<void>;
  initialize: (config: ClientConfig) => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const TOKEN_STORAGE_KEY = 'calimero-auth-tokens';

interface AuthProviderProps {
  children: React.ReactNode;
  config?: ClientConfig;
}

export function AuthProvider({ children, config }: AuthProviderProps) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);

  // Load tokens from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (stored) {
        const tokens = JSON.parse(stored);
        setAccessToken(tokens.accessToken);
        setRefreshToken(tokens.refreshToken);
        setIsAuthenticated(!!tokens.accessToken);
      }
    } catch (err) {
      console.error('Failed to load tokens from storage:', err);
    }
  }, []);

  // Initialize client
  const initialize = useCallback((newConfig: ClientConfig) => {
    createClient(newConfig);
    setLoading(false);
  }, []);

  // Initialize with provided config
  useEffect(() => {
    if (config) {
      initialize(config);
    }
  }, [config, initialize]);

  // Load providers
  const loadProviders = useCallback(async () => {
    try {
      setError(null);
      const response = await apiClient.auth.getProviders();
      if (response.error) {
        setError(response.error.message);
        return;
      }
      if (response.data) {
        setProviders(response.data.providers);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load providers';
      setError(errorMessage);
      console.error('Failed to load providers:', err);
    }
  }, []);

  // Login with username/password
  const login = useCallback(async (username: string, password: string) => {
    try {
      setLoading(true);
      setError(null);

      const response = await apiClient.auth.requestToken({
        auth_method: 'user_password',
        public_key: username,
        client_name: 'calimero-desktop',
        timestamp: Date.now(),
        permissions: [],
        provider_data: {
          username,
          password,
        },
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      if (response.data?.access_token && response.data?.refresh_token) {
        setAccessToken(response.data.access_token);
        setRefreshToken(response.data.refresh_token);
        setIsAuthenticated(true);

        // Store tokens using calimero-client compatible storage
        const { setAccessToken: setToken, setRefreshToken: setRefresh } = await import('../client/token-storage');
        setToken(response.data.access_token);
        setRefresh(response.data.refresh_token);

        // Also store in our format
        localStorage.setItem(
          TOKEN_STORAGE_KEY,
          JSON.stringify({
            accessToken: response.data.access_token,
            refreshToken: response.data.refresh_token,
          })
        );
      } else {
        throw new Error('Failed to get access token');
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Authentication failed';
      setError(errorMessage);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // Logout function (defined before refreshAuthToken to avoid hoisting issues)
  const logout = useCallback(async () => {
    setAccessToken(null);
    setRefreshToken(null);
    setIsAuthenticated(false);
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    
    // Clear calimero-client compatible tokens
    const { clearAccessToken, clearRefreshToken } = await import('../client/token-storage');
    clearAccessToken();
    clearRefreshToken();
    
    setError(null);
  }, []);

  // Refresh auth token
  const refreshAuthToken = useCallback(async (): Promise<boolean> => {
    if (!refreshToken || !accessToken) {
      return false;
    }

    try {
      const response = await apiClient.auth.refreshToken({
        access_token: accessToken,
        refresh_token: refreshToken,
      });

      if (response.error) {
        return false;
      }

      if (response.data?.access_token && response.data?.refresh_token) {
        setAccessToken(response.data.access_token);
        setRefreshToken(response.data.refresh_token);
        setIsAuthenticated(true);

        // Update stored tokens
        const { setAccessToken: setToken, setRefreshToken: setRefresh } = await import('../client/token-storage');
        setToken(response.data.access_token);
        setRefresh(response.data.refresh_token);

        localStorage.setItem(
          TOKEN_STORAGE_KEY,
          JSON.stringify({
            accessToken: response.data.access_token,
            refreshToken: response.data.refresh_token,
          })
        );

        return true;
      }

      return false;
    } catch (err) {
      console.error('Failed to refresh token:', err);
      await logout();
      return false;
    }
  }, [accessToken, refreshToken, logout]);


  const value: AuthContextValue = {
    isAuthenticated,
    accessToken,
    refreshToken,
    loading,
    error,
    providers,
    login,
    logout,
    refreshAuthToken,
    loadProviders,
    initialize,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

