import { Client } from "../lib/mero-client";
import { getSettings } from "./settings";

const DEFAULT_NODE_URLS = ["http://localhost:2528", "http://localhost:8080"]; // probed at first launch, before any node exists

export interface OnboardingState {
  nodeUrl: string; // the node this state was probed on
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
  const nodeUrl = getSettings().nodeUrl;
  // A client of its own, so the probe hits the node it records even before the shared client follows settings.
  const client = new Client({ baseUrl: nodeUrl.replace(/\/$/, "") });
  const state: OnboardingState = {
    nodeUrl,
    authAvailable: false,
    providersAvailable: false,
    hasConfiguredProviders: false,
  };

  try {
    // Check if auth service is available with timeout
    const healthResponse = await Promise.race([
      client.auth.getHealth(),
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
      client.auth.getProviders(),
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

/** Whether `state` shows auth failing on `nodeUrl`, the node onboarding now uses. */
export function authFailedOn(state: OnboardingState, nodeUrl: string): boolean {
  if (state.nodeUrl !== nodeUrl || DEFAULT_NODE_URLS.includes(nodeUrl)) return false;
  return !state.authAvailable || !state.providersAvailable;
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

