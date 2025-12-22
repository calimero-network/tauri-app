import { apiClient } from "@calimero-network/mero-react";

export interface OnboardingState {
  isFirstTime: boolean;
  authAvailable: boolean;
  providersAvailable: boolean;
  providersConfigured: boolean;
  hasConfiguredProviders: boolean;
  error?: string;
}

/**
 * Check onboarding state by examining auth configuration
 * Returns information about whether this is first-time setup
 */
export async function checkOnboardingState(): Promise<OnboardingState> {
  const state: OnboardingState = {
    isFirstTime: false,
    authAvailable: false,
    providersAvailable: false,
    providersConfigured: false,
    hasConfiguredProviders: false,
  };

  try {
    console.log('🔍 Checking auth health...');
    // Check if auth service is available with timeout
    const healthResponse = await Promise.race([
      apiClient.auth.getHealth(),
      new Promise<{ error: { message: string; code?: string } }>((resolve) =>
        setTimeout(() => resolve({ error: { message: 'Connection timeout - is the node running?' } }), 5000)
      ),
    ]);
    console.log('🏥 Auth health response:', healthResponse);
    if (healthResponse.error) {
      console.error('❌ Auth health error:', healthResponse.error);
      state.error = healthResponse.error.message;
      return state;
    }

    state.authAvailable = healthResponse.data?.status === "healthy";
    console.log('✅ Auth available:', state.authAvailable);

    // Check providers with timeout
    console.log('🔍 Checking providers...');
    const providersResponse = await Promise.race([
      apiClient.auth.getProviders(),
      new Promise<{ error: { message: string; code?: string } }>((resolve) =>
        setTimeout(() => resolve({ error: { message: 'Connection timeout - is the node running?' } }), 5000)
      ),
    ]);
    console.log('👥 Providers response:', providersResponse);
    if (providersResponse.error) {
      // If providers endpoint fails, auth might not be fully configured
      console.error('❌ Providers error:', providersResponse.error);
      state.error = providersResponse.error.message;
      // Still mark as available if health check passed
      return state;
    }

    const providers = providersResponse.data?.providers || [];
    state.providersAvailable = providers.length > 0;
    console.log('📋 Providers available:', state.providersAvailable, providers.length);

    // Check if any providers are configured (have users/keys)
    const configuredProviders = providers.filter((p) => p.configured === true);
    state.providersConfigured = configuredProviders.length > 0;
    state.hasConfiguredProviders = configuredProviders.length > 0;
    console.log('✅ Configured providers:', state.hasConfiguredProviders, configuredProviders.length);
    console.log('📝 Provider details:', providers.map(p => ({ name: p.name, configured: p.configured })));

    // Determine if this is first-time setup
    // First time = auth is available, providers are available, but none are configured
    state.isFirstTime =
      state.authAvailable &&
      state.providersAvailable &&
      !state.hasConfiguredProviders;

    console.log('🎯 Is first time?', state.isFirstTime);
    return state;
  } catch (error) {
    console.error('💥 Onboarding check error:', error);
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

  if (!state.providersAvailable) {
    return {
      title: "No Authentication Providers",
      message:
        "No authentication providers are available. Please configure at least one authentication provider in your node configuration.",
      action: "Check Settings",
    };
  }

  if (state.isFirstTime) {
    return {
      title: "Welcome to Calimero Desktop",
      message:
        "This appears to be your first time using the app. You'll need to create an account using one of the available authentication methods.",
      action: "Get Started",
    };
  }

  if (!state.hasConfiguredProviders) {
    return {
      title: "No Accounts Configured",
      message:
        "Authentication providers are available but no accounts have been created yet. Please create your first account.",
      action: "Create Account",
    };
  }

  // Everything is configured
  return {
    title: "Ready to Use",
    message: "Your authentication is properly configured. You can now log in.",
    action: "Continue",
  };
}

