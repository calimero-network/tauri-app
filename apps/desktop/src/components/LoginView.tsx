import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../lib/mero-client';
import type { Provider } from '../lib/mero-client';
import { ProviderSelector } from './ProviderSelector';
import { UsernamePasswordForm } from './UsernamePasswordForm';

export interface LoginViewProps {
  onSuccess?: () => void;
  onError?: (error: string) => void;
  variant?: 'light' | 'dark';
}

const isUserPasswordProvider = (p: Provider) =>
  p.name === 'user_password' || p.name === 'username_password';

export function LoginView({ onSuccess, onError, variant = 'light' }: LoginViewProps) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Username/password is the primary method, so the form is the default view —
  // the credential fields sit at the top of the popup instead of being buried
  // behind a provider-selection step. We only fall back to the provider list
  // when the node has no username/password provider (or offers extra ones).
  const [showProviders, setShowProviders] = useState(false);
  const [showUsernamePasswordForm, setShowUsernamePasswordForm] = useState(true);
  const [usernamePasswordLoading, setUsernamePasswordLoading] = useState(false);

  const loadProviders = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await apiClient.auth.getProviders();
      if (response.error) {
        setError(response.error.message);
        // Discovery failed — never leave the (default) credential form up, or a
        // node without password auth would show the wrong screen. Show the
        // provider view, which renders the error / empty state.
        setShowUsernamePasswordForm(false);
        setShowProviders(true);
        return;
      }
      if (response.data) {
        const loaded = response.data.providers;
        setProviders(loaded);
        // Show the credential form directly when the node supports it; otherwise
        // fall through to the provider list (which also renders the empty state).
        const hasUserPassword = loaded.some(isUserPasswordProvider);
        setShowUsernamePasswordForm(hasUserPassword);
        setShowProviders(!hasUserPassword);
      }
    } catch (err) {
      console.error('Failed to load providers:', err);
      setError('Failed to load authentication providers');
      // Same as above: fall back to the provider view rather than the form.
      setShowUsernamePasswordForm(false);
      setShowProviders(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  const handleProviderSelect = async (provider: Provider) => {
    if (isUserPasswordProvider(provider)) {
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

      const tokenResponse = await apiClient.auth.requestToken({
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

      if (tokenResponse.error) {
        setError(tokenResponse.error.message);
        onError?.(tokenResponse.error.message);
        return;
      }

      // `requestToken` has already stored the pair, expiry read off the JWT.
      if (tokenResponse.data?.access_token && tokenResponse.data?.refresh_token) {
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

  // Until provider discovery finishes, show the neutral loading state rather
  // than a concrete form — otherwise a node without username/password would
  // briefly flash the credential form and let the user submit before discovery
  // resolved which method(s) the node actually supports.
  if (loading) {
    return (
      <ProviderSelector
        providers={[]}
        onProviderSelect={handleProviderSelect}
        loading={true}
        error={error}
        containerClassName="login-provider-container"
        cardClassName="login-provider-card"
        variant={variant}
      />
    );
  }

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
    // Only offer "Back" when there is somewhere to go — i.e. the node exposes
    // other providers besides username/password. With a single provider the
    // form is the whole login, so a back button would just bounce to a
    // one-item list.
    const hasOtherProviders = providers.some((p) => !isUserPasswordProvider(p));
    return (
      <UsernamePasswordForm
        onSubmit={handleUsernamePasswordAuth}
        onBack={hasOtherProviders ? handleBack : undefined}
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
