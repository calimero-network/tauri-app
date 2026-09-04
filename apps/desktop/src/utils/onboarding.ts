import { apiClient } from "../lib/mero-client";

export interface OnboardingState {
  authAvailable: boolean;
  providersAvailable: boolean;
  hasConfiguredProviders: boolean;
  error?: string;
}

/**
 * Check onboarding state by examining auth configuration
 * Returns information about whether this is first-time setup
 */
export async function checkOnboardingState(): Promise<OnboardingState> {
  const state: OnboardingState = {
    authAvailable: false,
    providersAvailable: false,
    hasConfiguredProviders: false,
  };

  try {
    // Check if auth service is available with timeout
    const healthResponse = await Promise.race([
      apiClient.auth.getHealth(),
      new Promise<{ error: { message: string; code?: string } }>((resolve) =>
        setTimeout(() => resolve({ error: { message: 'Connection timeout - is the node running?' } }), 5000)
      ),
    ]);
    if (healthResponse.error) {
      console.error('Auth health error:', healthResponse.error);
      state.error = healthResponse.error.message;
      return state;
    }

    // Server returns "alive" (not "healthy") — accept both for compatibility
    state.authAvailable = 'data' in healthResponse && (healthResponse.data?.status === "alive" || healthResponse.data?.status === "healthy");

    // Check providers with timeout
    const providersResponse = await Promise.race([
      apiClient.auth.getProviders(),
      new Promise<{ error: { message: string; code?: string } }>((resolve) =>
        setTimeout(() => resolve({ error: { message: 'Connection timeout - is the node running?' } }), 5000)
      ),
    ]);
    if (providersResponse.error) {
      // If providers endpoint fails, auth might not be fully configured
      console.error('Providers error:', providersResponse.error);
      state.error = providersResponse.error.message;
      // Still mark as available if health check passed
      return state;
    }

    const providers = 'data' in providersResponse ? (providersResponse.data?.providers || []) : [];
    state.providersAvailable = providers.length > 0;

    // Check if any providers are configured (have users/keys)
    const configuredProviders = providers.filter((p) => p.configured === true);
    state.hasConfiguredProviders = configuredProviders.length > 0;
    console.log('Configured providers:', state.hasConfiguredProviders, configuredProviders.length);
    console.log('Provider details:', providers.map((p) => ({ name: p.name, configured: p.configured })));

    return state;
  } catch (error) {
    console.error('Onboarding check error:', error);
    state.error = error instanceof Error ? error.message : "Unknown error";
    return state;
  }
}

/**
 * Get a user-friendly message about the onboarding state
 */
export function getOnboardingMessage(state: OnboardingState): {
  title: string;
  message: string;
  action?: string;
} {
  if (!state.authAvailable) {
    return {
      title: "Authentication Service Unavailable",
      message:
        "The authentication service is not available. Please check your node configuration and ensure the auth service is running.",
      action: "Check Settings",
    };
  }

  return {
    title: "No Authentication Providers",
    message:
      "No authentication providers are available. Please configure at least one authentication provider in your node configuration.",
    action: "Check Settings",
  };
}

