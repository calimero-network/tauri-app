import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../lib/mero-client';
import { setAccessToken, setRefreshToken, setTokenExpiresAt } from '../lib/token-storage';
import type { Provider } from '../lib/mero-client';
import { ProviderSelector } from './ProviderSelector';
import { UsernamePasswordForm } from './UsernamePasswordForm';
import { getBootstrapSecret } from '../utils/merod';
import { getSettings } from '../utils/settings';

export interface LoginViewProps {
  onSuccess?: () => void;
  onError?: (error: string) => void;
  variant?: 'light' | 'dark';
}

export function LoginView({ onSuccess, onError, variant = 'light' }: LoginViewProps) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showProviders, setShowProviders] = useState(true);
  const [showUsernamePasswordForm, setShowUsernamePasswordForm] = useState(false);
  const [usernamePasswordLoading, setUsernamePasswordLoading] = useState(false);

  const loadProviders = useCallback(async () => {
    try {
      setLoading(true);
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
      console.error('Failed to load providers:', err);
      setError('Failed to load authentication providers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  const handleProviderSelect = async (provider: Provider) => {
    if (provider.name === 'user_password' || provider.name === 'username_password') {
      setShowProviders(false);
      setShowUsernamePasswordForm(true);
    } else {
      setError(`Provider ${provider.name} is not supported`);
    }
  };

  const handleUsernamePasswordAuth = async (username: string, password: string) => {
    try {
      setUsernamePasswordLoading(true);
      setError(null);

      // Since core rc.14 (core#3221) a fresh node only creates its first
      // account when the login presents the node's bootstrap secret ("setup
      // code"), which lives in the config.toml this app manages. Read it
      // transparently so first-run stays a plain username/password login.
      // Once an account exists the node ignores the value, and for remote
      // or pre-rc.14 nodes it resolves to null and is simply omitted —
      // matching the pre-rc.14 request shape exactly.
      let bootstrapSecret: string | null = null;
      const settings = getSettings();
      if (settings.useEmbeddedNode && settings.embeddedNodeName) {
        try {
          bootstrapSecret = await getBootstrapSecret(
            settings.embeddedNodeName,
            settings.embeddedNodeDataDir,
          );
        } catch (err) {
          console.warn('Could not read first-login setup code:', err);
        }
      }

      const tokenResponse = await apiClient.auth.requestToken({
        auth_method: 'user_password',
        public_key: username,
        client_name: 'calimero-desktop',
        timestamp: Date.now(),
        permissions: [],
        provider_data: {
          username,
          password,
          ...(bootstrapSecret ? { bootstrap_secret: bootstrapSecret } : {}),
        },
      });

      if (tokenResponse.error) {
        setError(tokenResponse.error.message);
        onError?.(tokenResponse.error.message);
        return;
      }

      if (tokenResponse.data?.access_token && tokenResponse.data?.refresh_token) {
        setAccessToken(tokenResponse.data.access_token);
        setRefreshToken(tokenResponse.data.refresh_token);
        try {
          const payload = JSON.parse(atob(tokenResponse.data.access_token.split('.')[1]));
          setTokenExpiresAt(payload.exp * 1000);
        } catch {
          setTokenExpiresAt(Date.now() + 3600 * 1000);
        }
        onSuccess?.();
      } else {
        throw new Error('Failed to get access token');
      }
    } catch (err) {
      console.error('Authentication error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Authentication failed';
      setError(errorMessage);
      onError?.(errorMessage);
    } finally {
      setUsernamePasswordLoading(false);
    }
  };

  const handleBack = () => {
    setShowUsernamePasswordForm(false);
    setShowProviders(true);
    setError(null);
  };

  if (showProviders) {
    return (
      <ProviderSelector
        providers={providers}
        onProviderSelect={handleProviderSelect}
        loading={loading}
        error={error}
        containerClassName="login-provider-container"
        cardClassName="login-provider-card"
        variant={variant}
      />
    );
  }

  if (showUsernamePasswordForm) {
    return (
      <UsernamePasswordForm
        onSubmit={handleUsernamePasswordAuth}
        onBack={handleBack}
        loading={usernamePasswordLoading}
        error={error}
        containerClassName="login-form-container"
        cardClassName="login-form-card"
        variant={variant}
      />
    );
  }

  return null;
}
