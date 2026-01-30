import React, { useState, useEffect, useCallback } from 'react';
import { apiClient, setAccessToken, setRefreshToken } from '../client';
import type { Provider } from '../client/types';
import { ProviderSelector } from './ProviderSelector';
import { UsernamePasswordForm } from './UsernamePasswordForm';

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

  /**
   * Load available authentication providers from the auth service
   */
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

  /**
   * Handle provider selection
   */
  const handleProviderSelect = async (provider: Provider) => {
    if (provider.name === 'user_password' || provider.name === 'username_password') {
      setShowProviders(false);
      setShowUsernamePasswordForm(true);
    } else if (provider.name === 'near_wallet') {
      setError('NEAR wallet authentication not yet implemented');
    } else {
      setError(`Provider ${provider.name} is not supported`);
    }
  };

  /**
   * Handle username/password authentication
   */
  const handleUsernamePasswordAuth = async (username: string, password: string) => {
    try {
      setUsernamePasswordLoading(true);
      setError(null);

      const tokenPayload = {
        auth_method: 'user_password',
        public_key: username,
        client_name: 'calimero-desktop',
        timestamp: Date.now(),
        permissions: [],
        provider_data: {
          username: username,
          password: password,
        },
      };

      const tokenResponse = await apiClient.auth.requestToken(tokenPayload);

      if (tokenResponse.error) {
        const errorMessage = tokenResponse.error.message;
        setError(errorMessage);
        onError?.(errorMessage);
        return;
      }

      if (tokenResponse.data?.access_token && tokenResponse.data?.refresh_token) {
        // Store tokens using calimero-client compatible storage
        setAccessToken(tokenResponse.data.access_token);
        setRefreshToken(tokenResponse.data.refresh_token);

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

  /**
   * Handle back navigation
   */
  const handleBack = () => {
    setShowUsernamePasswordForm(false);
    setShowProviders(true);
    setError(null);
  };

  // Render provider selector
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

  // Render username/password form
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

