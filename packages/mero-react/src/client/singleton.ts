// Singleton client instance - matches calimero-client pattern
import { createClient, type ClientConfig, type Client } from './client';

let clientInstance: Client | null = null;

export function initializeClient(config: ClientConfig): void {
  clientInstance = createClient(config);
}

export function getClient(): Client {
  if (!clientInstance) {
    throw new Error(
      'Client not initialized. Call initializeClient() first or use createClient() directly.',
    );
  }
  return clientInstance;
}

// Default singleton instance - lazy initialization
export const apiClient = new Proxy({} as Client, {
  get(target, prop) {
    if (!clientInstance) {
      // Try to auto-initialize with default config
      const defaultConfig: ClientConfig = {
        baseUrl: 'http://localhost:2528',
      };
      initializeClient(defaultConfig);
    }
    return (clientInstance as any)[prop];
  },
});

// Export function to get the current client instance (used by createClient)
export function setClientInstance(client: Client): void {
  clientInstance = client;
}

